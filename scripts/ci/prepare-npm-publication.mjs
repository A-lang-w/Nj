import { appendFile } from "node:fs/promises";
import {
  validateVerifiedPackageEnvelope,
  workflowPackageIdentity,
} from "./qualified-package-envelope.mjs";

// This entrypoint and its complete import graph intentionally use only Node built-ins.
// Rehearsal validates SemVer/channel semantics on the same immutable artifact first.
const published = process.env.NPM_ALREADY_PUBLISHED;
if (published !== "true" && published !== "false")
  throw new Error(
    "Rehearsal must report whether the exact version is already published",
  );
const { manifest } = await validateVerifiedPackageEnvelope({
  directory: ".cache/verified-package",
  ...(await workflowPackageIdentity()),
});
if (!process.env.GITHUB_OUTPUT)
  throw new Error("GITHUB_OUTPUT is required for publication intent");
// Fixed path and two whitelisted channels; no opaque version enters workflow outputs.
await appendFile(
  process.env.GITHUB_OUTPUT,
  `tag=${manifest.releaseTag}\npublished=${published}\n`,
);
