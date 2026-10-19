export function assertCoreTraceHistoricalPidAccess(
  traces: ReadonlyMap<number, string>,
  options: {
    readonly node: string;
    readonly supervisorScripts: readonly string[];
    readonly sentinelPid: number;
  },
): {
  readonly processTableReads: readonly string[];
  readonly nativeIdentityReads: readonly string[];
};
