import assert from "node:assert/strict";
import { readdir, readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";
import { runOwnedCommand } from "../../../dist/process/OwnedCommand.js";

/** Check attempted syscalls, including failed attempts, on a recorded PID that collides with an owned live sentinel. */
export async function verifyCoreInspectionTrace({
  root,
  environment,
  entrypoint,
  core,
  sentinel,
  runId,
}) {
  const gdb = await realpath(environment.REA_PWNDBG_GDB);
  const python = await realpath(environment.REA_PWNTOOLS_PYTHON);
  const plugin = resolve(environment.REA_PWNDBG_GDBINIT, "..");
  const helperPaths = (name) =>
    new Set([
      join(environment.REA_PWNDBG_VENV_PATH, "bin", name),
      ...(environment.PATH ?? "")
        .split(":")
        .filter(isAbsolute)
        .map((directory) => join(directory, name)),
    ]);
  const psPaths = helperPaths("ps");
  const iconvPaths = helperPaths("iconv");
  const gitPaths = helperPaths("git");
  const observations = [];
  for (const mode of ["cli", "mcp"]) {
    sentinel.assertAlive();
    const prefix = join(root, `inspection-${mode}.trace`);
    const invocation =
      mode === "cli"
        ? [
            entrypoint,
            "inspect-recorded-crash",
            core,
            "--debugger-context",
            "--json",
          ]
        : [
            fileURLToPath(new URL("./trace-client.mjs", import.meta.url)),
            entrypoint,
            core,
          ];
    await runOwnedCommand(
      {
        command: environment.REA_VERIFY_STRACE_COMMAND,
        arguments: [
          "-ff",
          "-qq",
          "-s",
          "8192",
          "-e",
          "trace=%process,%network,%file,ptrace,process_vm_readv,process_vm_writev",
          "-o",
          prefix,
          process.execPath,
          ...invocation,
        ],
        cwd: root,
        hostEnvironment: environment,
        expectedCommand: null,
        runId,
      },
      { timeoutMs: 90_000, diagnosticBytes: 1024 * 1024 },
    );
    const traces = new Map();
    for (const file of await readdir(root)) {
      if (!file.startsWith(`inspection-${mode}.trace.`)) continue;
      const tid = Number(file.slice(file.lastIndexOf(".") + 1));
      assert.ok(
        Number.isSafeInteger(tid) && tid > 0,
        `Invalid trace identity: ${file}`,
      );
      traces.set(tid, await readFile(join(root, file), "utf8"));
    }
    const { processTableReads, nativeIdentityReads } =
      assertCoreTraceHistoricalPidAccess(traces, {
        node: process.execPath,
        supervisorScripts: [
          entrypoint,
          fileURLToPath(new URL("./trace-client.mjs", import.meta.url)),
        ],
        sentinelPid: sentinel.pid,
      });
    const executions = [];
    let gdbObserved = false;
    for (const [tid, text] of traces) {
      const file = `inspection-${mode}.trace.${tid}`;
      // Keep the source executable present: GDB 16 otherwise silently hides a
      // core-only violation when its automatic executable lookup finds nothing.
      const recordedExecutable = JSON.stringify(join(root, "fixture-program"));
      assert.ok(
        !text.split("\n").some((line) => line.includes(recordedExecutable)),
        `Inspection attempted access to the recorded executable: ${file}`,
      );
      assert.ok(
        !/\bptrace\(/u.test(text),
        `Inspection attempted ptrace: ${file}`,
      );
      assert.ok(
        !/\bprocess_vm_(?:readv|writev)\(/u.test(text),
        `Inspection attempted process memory access: ${file}`,
      );
      assert.ok(
        !/\b(?:socket|connect|sendto|sendmsg)\([^\n]*(?:AF_INET|AF_INET6)/u.test(
          text,
        ),
        `Inspection attempted an Internet socket: ${file}`,
      );
      for (const line of text.split("\n")) {
        if (!/execve(?:at)?\(/u.test(line)) continue;
        const match = /^execve\("([^"]+)"/u.exec(line);
        assert.notEqual(match, null, `Unresolved executable identity: ${line}`);
        assert.ok(
          / = (?:0|-1 [A-Z]+)/u.test(line),
          `Incomplete execution observation: ${line}`,
        );
        const executable = await realpath(match[1]).catch(() => match[1]);
        const ownership =
          psPaths.has(match[1]) &&
          line.includes(
            '["ps", "-axo", "pid=,ppid=,pgid=,uid=,stat=,command="]',
          );
        const iconv =
          iconvPaths.has(match[1]) && line.includes('["iconv", "-l"]');
        const version =
          gitPaths.has(match[1]) &&
          line.includes(
            "[" +
              [
                "git",
                "--git-dir",
                join(plugin, ".git"),
                "rev-parse",
                "--short",
                "HEAD",
              ]
                .map((argument) => JSON.stringify(argument))
                .join(", ") +
              "]",
          );
        assert.ok(
          [process.execPath, python, gdb].includes(executable) ||
            ownership ||
            iconv ||
            version,
          `Unexpected attempted host execution: ${line}`,
        );
        if (executable === gdb) gdbObserved = true;
        executions.push(executable);
      }
    }
    assert.ok(gdbObserved, "Trace must include the actual core-only GDB stage");
    assert.ok(executions.includes(python));
    sentinel.assertAlive();
    observations.push({
      mode,
      executions,
      historical_pid: sentinel.pid,
      sentinel: "still-alive",
      ownership_process_table_reads: processTableReads,
      ownership_native_identity_reads: nativeIdentityReads,
    });
  }
  return observations;
}

const successfulExecutions = (text) =>
  text
    .split("\n")
    .filter(
      (line) => /^(?:execve|execveat)\(/u.test(line) && line.endsWith(" = 0"),
    );

const ownershipPsTrace = (text) =>
  successfulExecutions(text).length === 1 &&
  successfulExecutions(text).some(
    (line) =>
      /^execve\("\/(?:usr\/)?bin\/ps",/u.test(line) &&
      line.includes('["ps", "-axo", "pid=,ppid=,pgid=,uid=,stat=,command="]') &&
      line.endsWith(" = 0"),
  );

/** Attribute native identity sampling to known REA supervisors, never providers. */
export function assertCoreTraceHistoricalPidAccess(
  traces,
  { node, supervisorScripts, sentinelPid },
) {
  const clones = new Map();
  const threads = new Map();
  const supervisors = [];
  const ps = new Set();
  for (const [tid, text] of traces) {
    const children = new Set();
    const childThreads = new Set();
    let pendingThread;
    for (const line of text.split("\n")) {
      if (/^clone(?:3)?\(/u.test(line)) {
        pendingThread = line.includes("CLONE_THREAD");
      } else if (!/^<\.\.\. clone(?:3)? resumed>/u.test(line)) continue;
      const returned = / = (\d+)$/u.exec(line);
      if (returned !== null) {
        const child = Number(returned[1]);
        children.add(child);
        if (pendingThread === true) childThreads.add(child);
        pendingThread = undefined;
      } else if (!line.includes("<unfinished ...>")) pendingThread = undefined;
    }
    clones.set(tid, children);
    threads.set(tid, childThreads);
    if (ownershipPsTrace(text)) ps.add(tid);
    const executions = successfulExecutions(text);
    if (
      executions.length === 1 &&
      executions.some((line) =>
        supervisorScripts.some((script) =>
          line.startsWith(
            `execve(${JSON.stringify(node)}, [${JSON.stringify(node)}, ${JSON.stringify(script)}`,
          ),
        ),
      )
    )
      supervisors.push(tid);
  }
  const nativeThreads = new Set();
  const statRead =
    /^openat\(AT_FDCWD, "\/proc\/(\d+)\/stat", O_RDONLY\|O_CLOEXEC\) = (?:\d+|-1 [A-Z]+)/u;
  for (const supervisor of supervisors) {
    const cohort = new Set([supervisor]);
    for (const tid of cohort)
      for (const child of threads.get(tid) ?? []) cohort.add(child);
    // A child that execs another program is not a supervisor identity reader.
    if (
      [...cohort].some(
        (tid) =>
          tid !== supervisor &&
          /^(?:execve|execveat)\([^\n]+ = 0$/mu.test(traces.get(tid) ?? ""),
      )
    )
      continue;
    const spawnedPs = [...cohort].some((tid) =>
      [...(clones.get(tid) ?? [])].some((child) => ps.has(child)),
    );
    const sampled = new Set(
      [...cohort].flatMap((tid) =>
        (traces.get(tid) ?? "").split("\n").flatMap((line) => {
          const match = statRead.exec(line);
          return match === null ? [] : [Number(match[1])];
        }),
      ),
    );
    // The native sampler enriches the process table, including the supervisor.
    // An isolated historical-PID lookup does not establish an identity cohort.
    if (spawnedPs && sampled.has(supervisor) && sampled.has(sentinelPid))
      for (const tid of cohort) nativeThreads.add(tid);
  }
  const processTableReads = [];
  const nativeIdentityReads = [];
  for (const [tid, text] of traces) {
    for (const line of text.split("\n")) {
      if (!line.includes(`/proc/${sentinelPid}/`)) continue;
      if (ps.has(tid)) {
        assert.ok(
          new RegExp(
            `/proc/${sentinelPid}/(?:stat|status|cmdline|wchan|environ)"`,
            "u",
          ).test(line),
          `Unexpected ownership observation of the sentinel: ${line}`,
        );
        processTableReads.push(line);
      } else {
        assert.ok(
          nativeThreads.has(tid) &&
            statRead.exec(line)?.[1] === String(sentinelPid),
          `Historical PID caused a provider lookup in trace.${tid}: ${line}`,
        );
        nativeIdentityReads.push(line);
      }
    }
  }
  return { processTableReads, nativeIdentityReads };
}
