import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

import type { AnalysisOperation } from "../application/AnalysisProvider.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  readGhidraProfileArtifact,
  writeGhidraProfileArtifact,
  ghidraFileFailure,
} from "./GhidraFileArtifacts.js";
import { err, ok, type Result } from "../domain/result.js";

/** Seed file format admitted by this adapter. */
export const GHIDRA_SEED_FORMAT = "rea-ghidra-seeds-v2";
export const MAX_GHIDRA_SEED_BYTES = 32 * 1024 * 1024;
export const MAX_GHIDRA_SEED_ENTRIES = 1_000_000;
const MAX_SEED_NAME_LENGTH = 2000;

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.number().int().nonnegative();

/** Caller-declared seeds committed into the analysis profile before import. */
export const ghidraSeedCommitmentSchema = z.strictObject({
  format: z.literal(GHIDRA_SEED_FORMAT),
  path: z.string().refine(isAbsolute, "Seed path must be absolute"),
  configured_path: z.string().refine(isAbsolute, "Seed path must be absolute"),
  sha256: digest,
  entries: z.strictObject({
    function: count,
    function_body: count,
    code: count,
    label: count,
    computed_target: count.optional(),
  }),
});
export type GhidraSeedCommitment = z.infer<typeof ghidraSeedCommitmentSchema>;

/** What the pre-analysis script applied, as reported by the bridge handshake. */
export const ghidraSeedReportSchema = z.strictObject({
  format: z.literal(GHIDRA_SEED_FORMAT),
  sha256: digest,
  phase: z.enum(["pre_analysis", "post_analysis_reconcile"]).optional(),
  entries: count,
  function_created: count,
  function_existing: count,
  function_failed: count,
  function_body_created: count,
  function_body_existing: count,
  function_body_updated: count,
  function_body_failed: count,
  function_body_conflicts_removed: count.optional(),
  code_decoded: count,
  code_failed: count,
  label_applied: count,
  label_failed: count,
  computed_target_applied: count.optional(),
  computed_target_existing: count.optional(),
  computed_target_failed: count.optional(),
  unmapped: count,
});
export type GhidraSeedReport = z.infer<typeof ghidraSeedReportSchema>;

type SeedKind =
  | "function"
  | "function_body"
  | "code"
  | "label"
  | "computed_target";
interface SeedRange {
  readonly start: bigint;
  readonly end: bigint;
}
interface SeedEntry {
  readonly address: bigint;
  readonly kind: SeedKind;
  readonly name?: string;
  readonly ranges?: readonly SeedRange[];
  readonly target?: bigint;
  readonly transferKind?: "call" | "jump";
}

const seedLineError = (line: number, constraint: string) =>
  new ConfigurationError("Invalid REA environment configuration", {
    settings: [
      {
        setting: "REA_GHIDRA_SEED_FILE",
        constraint: `line ${line}: ${constraint}`,
      },
    ],
  });

/**
 * Parse ordinary `address<TAB>kind[<TAB>name]` seeds and exact function-body
 * seeds of the form `entry<TAB>function_body<TAB>start-end[,start-end...]
 * [<TAB>name]`, or computed targets of the form
 * `source<TAB>computed_target<TAB>target<TAB>(call|jump)`. Range ends are
 * inclusive. Blank lines and `#` comments are ignored. Addresses are
 * hexadecimal offsets in the default address space.
 */
export const parseGhidraSeeds = (
  text: string,
): Result<readonly SeedEntry[], ConfigurationError> => {
  const entries: SeedEntry[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "" || line.startsWith("#")) continue;
    const number = index + 1;
    const fields = line.split("\t");
    if (fields.length < 2 || fields.length > 4)
      return err(
        seedLineError(
          number,
          "expected an ordinary, function_body, or computed_target seed",
        ),
      );
    const [address, kind] = fields;
    if (address === undefined || !/^0x[0-9a-fA-F]{1,16}$/u.test(address))
      return err(seedLineError(number, "address must be 0x-prefixed hex"));
    if (
      kind !== "function" &&
      kind !== "function_body" &&
      kind !== "code" &&
      kind !== "label" &&
      kind !== "computed_target"
    )
      return err(
        seedLineError(
          number,
          "kind must be function, function_body, code, label or computed_target",
        ),
      );
    if (
      kind !== "function_body" &&
      kind !== "computed_target" &&
      fields.length > 3
    )
      return err(seedLineError(number, `${kind} seed has too many fields`));
    const rangeText = kind === "function_body" ? fields[2] : undefined;
    const name =
      kind === "computed_target"
        ? undefined
        : kind === "function_body"
          ? fields[3]
          : fields[2];
    let ranges: readonly SeedRange[] | undefined;
    let target: bigint | undefined;
    let transferKind: "call" | "jump" | undefined;
    if (kind === "function_body") {
      if (rangeText === undefined || rangeText === "")
        return err(
          seedLineError(number, "a function_body seed requires body ranges"),
        );
      const parsedRanges: SeedRange[] = [];
      for (const rawRange of rangeText.split(",")) {
        const match = /^(0x[0-9a-fA-F]{1,16})-(0x[0-9a-fA-F]{1,16})$/u.exec(
          rawRange,
        );
        if (match === null)
          return err(
            seedLineError(
              number,
              "function_body ranges must be inclusive 0xstart-0xend pairs",
            ),
          );
        const start = BigInt(match[1] ?? "0");
        const end = BigInt(match[2] ?? "0");
        if (end < start)
          return err(
            seedLineError(number, "function_body range ends before it starts"),
          );
        const previous = parsedRanges.at(-1);
        if (previous !== undefined && start <= previous.end)
          return err(
            seedLineError(
              number,
              "function_body ranges must be sorted and non-overlapping",
            ),
          );
        parsedRanges.push({ start, end });
      }
      const entry = BigInt(address);
      if (
        !parsedRanges.some(({ start, end }) => start <= entry && entry <= end)
      )
        return err(
          seedLineError(number, "function_body ranges must contain the entry"),
        );
      ranges = parsedRanges;
    }
    if (kind === "computed_target") {
      const targetText = fields[2];
      const transfer = fields[3];
      if (
        targetText === undefined ||
        !/^0x[0-9a-fA-F]{1,16}$/u.test(targetText)
      )
        return err(
          seedLineError(
            number,
            "a computed_target seed requires a 0x-prefixed target",
          ),
        );
      if (transfer !== "call" && transfer !== "jump")
        return err(
          seedLineError(number, "a computed_target seed requires call or jump"),
        );
      target = BigInt(targetText);
      transferKind = transfer;
    }
    if (
      name !== undefined &&
      (name.length === 0 ||
        name.length > MAX_SEED_NAME_LENGTH ||
        /[\s\0]/u.test(name))
    )
      return err(
        seedLineError(
          number,
          `name must be 1..${MAX_SEED_NAME_LENGTH} characters without whitespace`,
        ),
      );
    if (kind === "label" && name === undefined)
      return err(seedLineError(number, "a label seed requires a name"));
    if (kind === "code" && name !== undefined)
      return err(
        seedLineError(number, "a code seed takes no name; add a label seed"),
      );
    const value = BigInt(address);
    const key = `${value.toString(16)}:${kind}`;
    if (seen.has(key))
      return err(seedLineError(number, `duplicate ${kind} seed at ${address}`));
    seen.add(key);
    entries.push({
      address: value,
      kind,
      ...(name === undefined ? {} : { name }),
      ...(ranges === undefined ? {} : { ranges }),
      ...(target === undefined ? {} : { target }),
      ...(transferKind === undefined ? {} : { transferKind }),
    });
    if (entries.length > MAX_GHIDRA_SEED_ENTRIES)
      return err(
        seedLineError(
          number,
          `more than ${MAX_GHIDRA_SEED_ENTRIES} seed entries`,
        ),
      );
  }
  return ok(entries);
};

/** Canonical script input: lowercase addresses, fixed field order, LF endings. */
const normalizedSeeds = (entries: readonly SeedEntry[]): string =>
  entries
    .map((entry) =>
      entry.kind === "function_body"
        ? `0x${entry.address.toString(16)}\tfunction_body\t${entry.ranges
            ?.map(
              ({ start, end }) =>
                `0x${start.toString(16)}-0x${end.toString(16)}`,
            )
            .join(",")}${entry.name === undefined ? "" : `\t${entry.name}`}\n`
        : entry.kind === "computed_target"
          ? `0x${entry.address.toString(16)}\tcomputed_target\t0x${entry.target?.toString(16)}\t${entry.transferKind}\n`
          : `0x${entry.address.toString(16)}\t${entry.kind}${entry.name === undefined ? "" : `\t${entry.name}`}\n`,
    )
    .join("");

const sha256 = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Parse seed facts before final close so later cleanup cannot replace invalid input. */
const readSeeds = (
  path: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<readonly SeedEntry[]> =>
  readGhidraProfileArtifact(
    path,
    MAX_GHIDRA_SEED_BYTES,
    resources,
    signal,
    (bytes) => {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw seedLineError(0, "file is not valid UTF-8");
      }
      const parsed = parseGhidraSeeds(text);
      if (!parsed.ok) throw parsed.error;
      return parsed.value;
    },
  );

/** Resolve the configured seed file into an immutable profile commitment. */
export const resolveGhidraAnalysisSeeds = async (
  configured: string | undefined,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<Result<GhidraSeedCommitment | undefined, AnalysisError>> =>
  resources
    .run(async () => {
      if (configured === undefined) return ok(undefined);
      let entries: readonly SeedEntry[];
      let path: string;
      try {
        path = await realpath(configured);
        entries = await readSeeds(path, resources, signal);
      } catch (cause: unknown) {
        return err(
          ghidraFileFailure(cause, "resolve_analysis_profile", {
            setting: "REA_GHIDRA_SEED_FILE",
            path: configured,
          }),
        );
      }
      const normalized = normalizedSeeds(entries);
      const tally = {
        function: 0,
        function_body: 0,
        code: 0,
        label: 0,
        computed_target: 0,
      };
      for (const entry of entries) tally[entry.kind] += 1;
      return ok<GhidraSeedCommitment>({
        format: GHIDRA_SEED_FORMAT,
        path,
        configured_path: configured,
        sha256: sha256(normalized),
        entries: tally,
      });
    })
    .catch((cause: unknown) =>
      err(
        ghidraFileFailure(cause, "resolve_analysis_profile", {
          setting: "REA_GHIDRA_SEED_FILE",
        }),
      ),
    );

/** Re-read the committed seeds and write the canonical copy the script applies. */
export const snapshotGhidraAnalysisSeeds = async (
  commitment: GhidraSeedCommitment,
  runtimeRoot: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<string> =>
  resources
    .run(async () => {
      ghidraSeedCommitmentSchema.parse(commitment);
      if ((await realpath(commitment.configured_path)) !== commitment.path)
        throw new Error(
          "Ghidra seed file resolved path differs from explicit configuration",
        );
      const entries = await readSeeds(commitment.path, resources, signal);
      const normalized = normalizedSeeds(entries);
      if (sha256(normalized) !== commitment.sha256)
        throw new Error(
          `Ghidra seed file changed after the analysis profile was committed: ${commitment.path}`,
        );
      const directory = join(runtimeRoot, "seeds");
      await mkdir(directory, { mode: 0o700 });
      const path = join(directory, "seeds.tsv");
      await writeGhidraProfileArtifact(path, normalized, resources, signal);
      return path;
    })
    .catch((cause: unknown) => {
      throw ghidraFileFailure(cause, "open_binary", {
        setting: "REA_GHIDRA_SEED_FILE",
        path: commitment.path,
      });
    });

const totalEntries = (commitment: GhidraSeedCommitment): number =>
  commitment.entries.function +
  commitment.entries.function_body +
  commitment.entries.code +
  commitment.entries.label +
  (commitment.entries.computed_target ?? 0);

/** Fail closed when the session did not apply exactly the committed seeds. */
export const ghidraSeedFailure = (
  commitment: GhidraSeedCommitment | undefined,
  report: GhidraSeedReport | undefined,
  operation: AnalysisOperation,
): ProviderAdapterError | undefined => {
  if (commitment === undefined && report === undefined) return undefined;
  const reason =
    commitment === undefined
      ? "The Ghidra session reported analysis seeds that the profile did not commit."
      : report === undefined
        ? "The Ghidra session did not report the committed analysis seeds."
        : report.sha256 !== commitment.sha256 ||
            report.entries !== totalEntries(commitment)
          ? "The Ghidra session applied analysis seeds that differ from the committed profile."
          : undefined;
  return reason === undefined
    ? undefined
    : new ProviderAdapterError("ghidra", operation, {
        diagnostics: { reason },
      });
};

/** Session limitations that keep seeded facts distinct from Ghidra discoveries. */
export const ghidraSeedLimitations = (
  commitment: GhidraSeedCommitment | undefined,
  report?: GhidraSeedReport,
): readonly string[] =>
  commitment === undefined
    ? []
    : [
        `Ghidra analysis was seeded before auto-analysis and exact bodies were reconciled after analysis from ${commitment.path} (sha256 ${commitment.sha256}: ${commitment.entries.function} function, ${commitment.entries.function_body} exact function-body, ${commitment.entries.code} code, ${commitment.entries.label} label, ${commitment.entries.computed_target ?? 0} computed-target entries). Seeded functions, bodies, code, names and transfer targets are caller assertions, not Ghidra discoveries.`,
        ...(report === undefined
          ? []
          : [
              `Seed outcome${report.phase === undefined ? "" : ` (${report.phase})`}: ${report.function_created} functions created, ${report.function_existing} already present, ${report.function_failed} failed; exact bodies: ${report.function_body_created} created, ${report.function_body_existing} already exact, ${report.function_body_updated} updated, ${report.function_body_failed} failed, ${report.function_body_conflicts_removed ?? 0} conflicting inferred functions removed; ${report.code_decoded} code seeds decoded, ${report.code_failed} failed; ${report.label_applied} labels applied, ${report.label_failed} failed; computed targets: ${report.computed_target_applied ?? 0} applied, ${report.computed_target_existing ?? 0} already present, ${report.computed_target_failed ?? 0} failed; ${report.unmapped} seeds outside initialized memory.`,
            ]),
      ];
