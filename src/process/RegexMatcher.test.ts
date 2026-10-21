import { expect, it } from "vitest";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  regexMatchingLimitation,
  regexWorkerHeapError,
  resolveRegexWorkerHeap,
  type RegexWorkerHeapLimit,
} from "./RegexMatcher.js";

const effective = (mib: number, overridden: boolean): RegexWorkerHeapLimit => ({
  kind: "effective",
  mib,
  overridden,
});

it.each([
  {
    name: "uses the 128 MiB request when no flag is set",
    execArgv: [],
    nodeOptions: undefined,
    heap: effective(128, false),
  },
  {
    name: "lets a smaller execArgv flag override the request",
    execArgv: ["--max-old-space-size=64"],
    nodeOptions: undefined,
    heap: effective(64, true),
  },
  {
    name: "lets a larger execArgv flag override the request",
    execArgv: ["--require", "./preload.js", "--max_old_space_size=256"],
    nodeOptions: undefined,
    heap: effective(256, true),
  },
  {
    name: "reads a positive NODE_OPTIONS flag that is absent from execArgv",
    execArgv: [],
    nodeOptions: "--no-warnings --max-old-space-size=192",
    heap: effective(192, true),
  },
  {
    name: "lets the last execArgv flag win over NODE_OPTIONS",
    execArgv: ["--max-old-space-size=256"],
    nodeOptions: "--max-old-space-size=96",
    heap: effective(256, true),
  },
  {
    name: "treats a final zero flag as leaving the 128 MiB request in effect",
    execArgv: ["--max-old-space-size=0"],
    nodeOptions: "--max-old-space-size=256",
    heap: effective(128, false),
  },
  {
    name: "accepts quoted NODE_OPTIONS and a leading plus or zeros",
    execArgv: ["--max-old-space-size=+0256"],
    nodeOptions: '"--max-old-space-size=144"',
    heap: effective(256, true),
  },
  {
    name: "uses the last positive flag",
    execArgv: ["--max-old-space-size=256", "--max-old-space-size=96"],
    nodeOptions: undefined,
    heap: effective(96, true),
  },
  {
    name: "leaves the effective heap unknown for an unparsed flag",
    execArgv: ["--max-old-space-size=256.5"],
    nodeOptions: undefined,
    heap: { kind: "unknown" } as const,
  },
  {
    name: "keeps a later positive flag after an unparsed one",
    execArgv: ["--max-old-space-size=256.5", "--max-old-space-size=80"],
    nodeOptions: undefined,
    heap: effective(80, true),
  },
  {
    name: "leaves an untokenizable NODE_OPTIONS value unknown until execArgv decides",
    execArgv: [],
    nodeOptions: '"--max-old-space-size=256',
    heap: { kind: "unknown" } as const,
  },
  {
    name: "lets execArgv decide when NODE_OPTIONS cannot be tokenized",
    execArgv: ["--max-old-space-size=80"],
    nodeOptions: '"--max-old-space-size=256',
    heap: effective(80, true),
  },
] as const)(
  "resolveRegexWorkerHeap $name",
  ({ execArgv, nodeOptions, heap }) => {
    expect(resolveRegexWorkerHeap(execArgv, nodeOptions)).toEqual(heap);
  },
);

it("describes the effective heap and keeps the deadline fixed", () => {
  for (const heap of [
    effective(128, false),
    effective(256, true),
    { kind: "unknown" } as const,
  ]) {
    const limitation = regexMatchingLimitation(heap);
    expect(limitation).toContain(
      "This release has no runtime override for the deadline.",
    );
    expect(limitation).not.toContain("either cap");
    expect(limitation).not.toContain("no runtime override for the heap");
    const projected = projectAnalysisError(
      regexWorkerHeapError("search_procedures", new Error("heap"), heap),
    );
    expect(projected.remediation.action).not.toContain("no runtime override");
    expect(projected.remediation.action).toContain("--max-old-space-size");
    if (heap.kind === "unknown") {
      expect(limitation).toContain("was not established");
      expect(projected.message).toContain("was not established");
      expect(projected.details).toMatchObject({
        reported_limits: { requested_worker_heap_mib: 128 },
      });
      expect(projected.details?.reported_limits).toEqual({
        requested_worker_heap_mib: 128,
      });
    } else {
      expect(limitation).toContain(`effective ${String(heap.mib)} MiB`);
      expect(projected.message).toContain(`effective ${String(heap.mib)} MiB`);
      expect(projected.details).toMatchObject({
        reported_limits: {
          worker_heap_mib: heap.mib,
          requested_worker_heap_mib: 128,
        },
      });
    }
  }
});
