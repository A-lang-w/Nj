# OpenClaw native client registration

## Requirements

Register REA using OpenClaw 2026.10.5's native `mcp.servers.rea` stdio
contract. Never report a Claude-style `mcpServers` table as an OpenClaw
registration. Parse JSON5 and edit only the owned entry, preserving unrelated
settings, comments, backups, idempotence and exact uninstall ownership.

Resolve effective home from OPENCLAW_HOME, state from OPENCLAW_STATE_DIR or
`<effective-home>/.openclaw`, and config from OPENCLAW_CONFIG_PATH or
`<state>/openclaw.json`. Trim overrides, expand tilde against the effective home
and resolve relative paths as the client does. Resolve managed skills from
the explicit state directory, otherwise from the active config directory. Use one path owner for setup, doctor,
skill installation and uninstall. Keep inherited location overrides out of tests.

## Acceptance

- Native OpenClaw validates and lists REA from the generated JSON5 profile.
- Native MCP probe reaches REA over stdio without starting an agent/model turn.
- JSON5 comments, unrelated settings and a foreign server survive setup/uninstall.
- Default, combined home/state/config overrides and malformed/ambiguous inputs
  preserve exact scope and fail without destructive writes.
- Shared client lifecycle, registration and schema regressions pass.

## Non-goals

No mcporter registry mutation, gateway/service installation, model turn, migration
of old invalid mcpServers entries, or claim of native MCP support in older clients.
