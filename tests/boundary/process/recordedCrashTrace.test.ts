import { expect, it } from "vitest";
import { assertCoreTraceHistoricalPidAccess } from "../../../scripts/verify/recorded-crash/trace.mjs";

const options = {
  node: "/runtime/node",
  supervisorScripts: ["/rea/rea.mjs", "/rea/trace-client.mjs"],
  sentinelPid: 4003,
};
const stat = (pid: number, flags = "O_RDONLY|O_CLOEXEC") =>
  `openat(AT_FDCWD, "/proc/${pid}/stat", ${flags}) = 20`;
const ps =
  'execve("/usr/bin/ps", ["ps", "-axo", "pid=,ppid=,pgid=,uid=,stat=,command="], 0x1) = 0';
const thread = "clone3({flags=CLONE_VM|CLONE_THREAD}, 88) = 101";
const fixture = (script = "/rea/rea.mjs") =>
  new Map([
    [
      100,
      `execve("/runtime/node", ["/runtime/node", "${script}"], 0x1) = 0\n${thread}\nclone(child_stack=NULL, flags=SIGCHLD) = 102`,
    ],
    [101, `${stat(100)}\n${stat(4003)}`],
    [102, `${ps}\nopenat(AT_FDCWD, "/proc/4003/status", O_RDONLY) = 4`],
  ]);

it.each(options.supervisorScripts)(
  "attributes native identity reads to %s and its libuv threads",
  (script) => {
    expect(
      assertCoreTraceHistoricalPidAccess(fixture(script), options),
    ).toEqual({
      processTableReads: [
        'openat(AT_FDCWD, "/proc/4003/status", O_RDONLY) = 4',
      ],
      nativeIdentityReads: [stat(4003)],
    });
  },
);

it("retains thread attribution across unfinished clone observations", () => {
  const traces = fixture();
  traces.set(
    100,
    traces
      .get(100)!
      .replace(
        thread,
        "clone3({flags=CLONE_VM|CLONE_THREAD}, 88 <unfinished ...>\n--- SIGCHLD {} ---\n<... clone3 resumed>) = 101",
      ),
  );
  expect(
    assertCoreTraceHistoricalPidAccess(traces, options).nativeIdentityReads,
  ).toEqual([stat(4003)]);
});

it.each([
  [
    "Python process",
    200,
    'execve("/venv/python", ["python", "bridge.py"], 0x1) = 0',
  ],
  ["GDB process", 201, 'execve("/usr/bin/gdb", ["gdb"], 0x1) = 0'],
  ["unattributed thread", 202, ""],
])("rejects historical PID reads by a %s", (_name, tid, execution) => {
  const traces = fixture();
  traces.set(Number(tid), `${execution}\n${stat(4003)}`);
  expect(() => assertCoreTraceHistoricalPidAccess(traces, options)).toThrow(
    "Historical PID caused a provider lookup",
  );
});

it.each(["maps", "mem", "environ", "exe"])(
  "rejects supervisor access to sentinel %s",
  (name) => {
    const traces = fixture();
    traces.set(
      101,
      `${traces.get(101)}\nopenat(AT_FDCWD, "/proc/4003/${name}", O_RDONLY|O_CLOEXEC) = 20`,
    );
    expect(() => assertCoreTraceHistoricalPidAccess(traces, options)).toThrow(
      "Historical PID caused a provider lookup",
    );
  },
);

it.each(["O_WRONLY|O_CLOEXEC", "O_RDWR|O_CLOEXEC"])(
  "rejects writable native stat opens with %s",
  (flags) => {
    const traces = fixture();
    traces.set(101, `${traces.get(101)}\n${stat(4003, flags)}`);
    expect(() => assertCoreTraceHistoricalPidAccess(traces, options)).toThrow(
      "Historical PID caused a provider lookup",
    );
  },
);

it("rejects isolated historical PID lookups without a native identity cohort", () => {
  const traces = fixture();
  traces.set(101, stat(4003));
  expect(() => assertCoreTraceHistoricalPidAccess(traces, options)).toThrow(
    "Historical PID caused a provider lookup",
  );
});

it("rejects a native-looking cohort without the supervisor's ownership ps child", () => {
  const traces = fixture();
  traces.set(
    100,
    traces
      .get(100)!
      .replace("clone(child_stack=NULL, flags=SIGCHLD) = 102", ""),
  );
  expect(() => assertCoreTraceHistoricalPidAccess(traces, options)).toThrow(
    "Historical PID caused a provider lookup",
  );
});

it("rejects an unrelated Node program with the same ownership-looking syscalls", () => {
  expect(() =>
    assertCoreTraceHistoricalPidAccess(fixture("/unrelated.mjs"), options),
  ).toThrow("Historical PID caused a provider lookup");
});

it("does not attribute forked provider processes as supervisor threads", () => {
  const traces = fixture();
  traces.set(
    100,
    traces
      .get(100)!
      .replace(thread, "clone(child_stack=NULL, flags=SIGCHLD) = 101"),
  );
  expect(() => assertCoreTraceHistoricalPidAccess(traces, options)).toThrow(
    "Historical PID caused a provider lookup",
  );
});

it("rejects a thread that executed a provider", () => {
  const traces = fixture();
  traces.set(
    101,
    `execve("/usr/bin/gdb", ["gdb"], 0x1) = 0\n${traces.get(101)}`,
  );
  expect(() => assertCoreTraceHistoricalPidAccess(traces, options)).toThrow(
    "Historical PID caused a provider lookup",
  );
});

it("rejects a supervisor process replaced by a provider executable", () => {
  const traces = fixture();
  traces.set(
    100,
    `${traces.get(100)}\nexecve("/usr/bin/gdb", ["gdb"], 0x1) = 0`,
  );
  expect(() => assertCoreTraceHistoricalPidAccess(traces, options)).toThrow(
    "Historical PID caused a provider lookup",
  );
});

it("does not retain a ps exemption after a different executable starts", () => {
  const traces = fixture();
  traces.set(
    102,
    `${traces.get(102)}\nexecve("/usr/bin/gdb", ["gdb"], 0x1) = 0\n${stat(4003)}`,
  );
  expect(() => assertCoreTraceHistoricalPidAccess(traces, options)).toThrow(
    "Historical PID caused a provider lookup",
  );
});
