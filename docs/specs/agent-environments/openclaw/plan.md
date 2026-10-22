# Implementation plan

Use the published OpenClaw 2026.10.5 source and CLI as the integration contract.
Model OpenClaw as its own dialect, with a nested `mcp.servers` owner and explicit
stdio transport. Centralize profile paths in a small resolver. Add JSON5 semantic
parsing and use the existing Babel parser dependency only for concrete source
positions; never evaluate configuration as JavaScript. Replace/insert/remove only
REA's property. Reject duplicate members on the owning path and include-directed
configuration before writing instead of revealing hidden entries or flattening
unresolved configuration. Keep native read-only policy authoritative.

1. Confirm packaged MCP/path/skill semantics and update this contract.
2. Implement the native dialect and shared path resolver; remove the old alias.
3. Exercise filesystem lifecycle, JSON5 preservation and negative controls.
4. Verify real OpenClaw config validation, listing and a stdio probe against REA
   in isolated temporary homes; record version and limits.
5. Run relevant static/docs/CI reproductions, sign and push, reply to review, and
   remove the temporary worktree.

## Validation evidence

The published OpenClaw 2026.10.5 archive was obtained from the npm registry mirror
and its SHA-512 was checked against the official registry metadata:
`9rCuXMweqVKZIK3KBtGcLzesz9G6+FmQ30lvwomRhmcNWDcOtlBoqdLbPditoJMuTP55jPqXpt1AA0L8tSzFHg==`.
The native CLI reports `OpenClaw 2026.10.5 (1b58cb9)`. No client installation or
upgrade was added to product setup; this was an isolated verification dependency.

235 focused regressions passed (12 existing host-specific cases skipped) across OpenClaw/JSON5, client lifecycle, doctor
registration, transactional editing, duplicate ownership and the two historical
CI failures. Main contains the Linux spawn-limit fixture fix. The remaining
portable schema failure used an unescaped slash in a Flutter ABI pattern under
ECMAScript v mode; hexadecimal slash spelling preserves accepted labels. A
pre-existing HTTP owner formatting drift was formatted without behavior change.

The real native lane passed public REA setup preview/setup/doctor/uninstall;
OpenClaw config-file selection, JSON5 validation and native registry readback;
a real stdio MCP probe discovering 213 tools from this selected REA runtime; home/config-only/combined state profiles; personal skill
destinations, preserved comments/foreign settings, backups and idempotence.
Process lineage was positively verified empty before deleting temporary profiles.
Native Windows, older OpenClaw versions and agent/model turns remain unverified.
No controlled token, time, CPU or process-family memory comparison was performed;
no performance gain is claimed.

Pinned contracts: [MCP registry](https://github.com/openclaw/openclaw/blob/v2026.10.5/src/config/mcp-config.ts),
[server schema](https://github.com/openclaw/openclaw/blob/v2026.10.5/src/config/zod-schema.mcp-server.ts),
[profile paths](https://github.com/openclaw/openclaw/blob/v2026.10.5/src/config/paths.ts),
[state](https://github.com/openclaw/openclaw/blob/v2026.10.5/src/config/state-dir.ts),
and [skill/config directory](https://github.com/openclaw/openclaw/blob/v2026.10.5/src/infra/config-dir.ts).

Final static (`npm run check`) and documentation (`npm run docs:check`) checks
passed, including the refreshed JSON5 runtime license notice and inventory.
Full production tarball/update verification was not run in this pass; the
native acceptance used this built checkout.
