import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, type ChildProcess } from "node:child_process";
import {
  isLockStale,
  createLockFile,
  releaseLockFile,
  claimStaleLock,
} from "../../src/lib/instance-lock.js";

describe("isLockStale", () => {
  it("treats a lock recording our own pid as stale", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hal-lock-"));
    try {
      const lockPath = path.join(dir, "hyperagent.lock");
      fs.writeFileSync(lockPath, String(process.pid));
      // A fresh process has not created any lock yet, so a self-pid lock is
      // always a leftover (e.g. SIGKILLed PID-1 container restarting).
      expect(isLockStale(lockPath)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a lock held by a live foreign process as fresh", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hal-lock-"));
    try {
      const lockPath = path.join(dir, "hyperagent.lock");
      // Our parent process is necessarily alive while this test runs.
      fs.writeFileSync(lockPath, String(process.ppid));
      expect(isLockStale(lockPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a lock with a dead pid as stale", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hal-lock-"));
    try {
      const lockPath = path.join(dir, "hyperagent.lock");
      // Far beyond any platform PID_MAX, so ESRCH is guaranteed.
      fs.writeFileSync(lockPath, "2147483647");
      expect(isLockStale(lockPath)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats missing or unparsable locks as fresh (fail-safe)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hal-lock-"));
    try {
      expect(isLockStale(path.join(dir, "absent.lock"))).toBe(false);
      const badPath = path.join(dir, "bad.lock");
      fs.writeFileSync(badPath, "not-a-pid");
      expect(isLockStale(badPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips create and release", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hal-lock-"));
    try {
      const lockPath = path.join(dir, "hyperagent.lock");
      createLockFile(lockPath);
      expect(fs.readFileSync(lockPath, "utf-8")).toBe(String(process.pid));
      expect(() => createLockFile(lockPath)).toThrow();
      releaseLockFile(lockPath);
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("release keeps a lock owned by another process", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hal-lock-"));
    try {
      const lockPath = path.join(dir, "hyperagent.lock");
      // A foreign holder's PID (e.g. an instance that started after our
      // lock file was removed externally): releasing must not steal it.
      fs.writeFileSync(lockPath, String(process.ppid));
      releaseLockFile(lockPath);
      expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("claimStaleLock takes a stale lock and refuses live or missing ones", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hal-lock-"));
    try {
      const stalePath = path.join(dir, "stale.lock");
      fs.writeFileSync(stalePath, "2147483647");
      expect(claimStaleLock(stalePath)).toBe(true);
      expect(fs.readFileSync(stalePath, "utf-8")).toBe(String(process.pid));

      const livePath = path.join(dir, "live.lock");
      fs.writeFileSync(livePath, String(process.ppid));
      expect(claimStaleLock(livePath)).toBe(false);
      expect(fs.readFileSync(livePath, "utf-8")).toBe(String(process.ppid));

      expect(claimStaleLock(path.join(dir, "absent.lock"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets exactly one of two racing processes claim a stale lock", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hal-lock-"));
    const children: ChildProcess[] = [];
    try {
      const lockPath = path.join(dir, "hyperagent.lock");
      fs.writeFileSync(lockPath, "2147483647");
      const moduleUrl = new URL(
        "../../src/lib/instance-lock.ts",
        import.meta.url,
      ).href;
      // Separate node processes: same-process concurrency cannot interleave
      // synchronous syscalls, so the race needs real processes. Type
      // stripping runs the TS source directly (Node 22+).
      // Each child prints its verdict, then sleeps: the winner must stay
      // alive until the peer finishes its claim attempt, otherwise the peer
      // sees a dead PID and legitimately reclaims (both print 'claimed').
      // Neither child is killed until BOTH verdicts are collected.
      const race = () => {
        const child = execFile(process.execPath, [
          "--experimental-strip-types",
          "-e",
          `import(${JSON.stringify(moduleUrl)}).then((m) => { ` +
            `console.log(m.claimStaleLock(${JSON.stringify(lockPath)}) ? 'claimed' : 'refused'); ` +
            `setTimeout(() => {}, 30000); })`,
        ]);
        children.push(child);
        const verdict = new Promise<string>((resolve, reject) => {
          let buf = "";
          let settled = false;
          const fail = (err: Error) => {
            if (!settled) {
              settled = true;
              reject(err);
            }
          };
          child.stdout?.on("data", (chunk: Buffer) => {
            if (settled) return;
            buf += chunk.toString();
            const nl = buf.indexOf("\n");
            if (nl >= 0) {
              const line = buf.slice(0, nl).trim();
              settled = true;
              if (line === "claimed" || line === "refused") resolve(line);
              else
                fail(
                  new Error(
                    `unexpected child verdict: ${JSON.stringify(line)}`,
                  ),
                );
            }
          });
          child.on("error", fail);
          child.on("exit", (code, signal) => {
            fail(
              new Error(
                `child exited before verdict: code=${code} signal=${signal} output=${JSON.stringify(buf)}`,
              ),
            );
          });
        });
        return verdict;
      };
      const [a, b] = await Promise.all([race(), race()]);
      expect([a, b].sort()).toEqual(["claimed", "refused"]);
      // The survivor holds a fresh numeric lock, not the stale marker.
      const recorded = fs.readFileSync(lockPath, "utf-8").trim();
      expect(recorded).not.toBe("2147483647");
      expect(Number.isInteger(Number(recorded))).toBe(true);
      // No reclaim debris left behind.
      expect(
        fs.readdirSync(dir).filter((f) => f.includes(".reclaim.")),
      ).toEqual([]);
    } finally {
      for (const child of children) {
        try {
          child.kill();
        } catch {
          // Already exited; nothing to stop.
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
