# ECC Integration

## Purpose

REA integrates the ECC engineering harness as an optional development and agent-engineering layer.

ECC contributes reusable engineering workflows, agents, skills, review practices, testing guidance, security checks, documentation workflows, debugging workflows, planning patterns, context-management practices, and other development capabilities.

ECC does **not** replace REA architecture, authority rules, evidence semantics, provider contracts, security boundaries, repository governance, or runtime behavior.

The objective of this integration is:

> Make the full ECC capability set locally available to REA/Codex while keeping REA authoritative, loading ECC capabilities only when useful, and preventing third-party automation from silently expanding execution authority.

## Source

ECC repository:

`https://github.com/affaan-m/ECC`

REA vendors ECC as a Git submodule at:

`third_party/ecc`

Pinned version:

- ECC release: `v2.2.3`
- Commit: `c05b2d6614f62f6db0047669aa4eefb223d478f9`

The version must remain explicitly pinned. Do not automatically follow ECC `main`.

The initial integration intentionally uses a tagged release rather than an arbitrary upstream development commit so the REA workspace remains reproducible.

## Integration model

ECC is integrated in three layers.

### Layer 1 — Upstream ECC

The untouched upstream repository lives at:

`third_party/ecc`

This layer owns the original ECC agents, skills, commands, rules, hooks, documentation, tooling, plugin metadata, and security utilities.

REA must not directly rewrite upstream ECC files unless intentionally maintaining a fork.

### Layer 2 — REA bridge

REA-owned adapter material lives outside the submodule, primarily under:

`.agents/skills/`

and, where appropriate:

`docs/`

The bridge is responsible for:

- finding useful ECC capabilities;
- loading only the minimum relevant ECC context;
- stating REA precedence;
- translating ECC workflows into REA-compatible execution;
- preventing accidental activation of incompatible hooks or automation;
- documenting validation and limitations.

### Layer 3 — REA runtime

REA production/runtime behavior remains independent of ECC.

ECC is initially an agent/development capability only.

No REA runtime path may depend on `third_party/ecc` unless that dependency is separately designed, reviewed, tested, documented, and approved.

## Authority precedence

When REA and ECC instructions overlap or conflict, use this order of authority:

1. explicit user instruction that is valid for the current task and repository;
2. REA repository rules and maintainer decisions;
3. REA `AGENTS.md`;
4. REA architecture and tool-design documentation;
5. REA testing, security, evidence, lifecycle, ownership, cleanup, and provider rules;
6. REA task-specific documentation and accepted design decisions;
7. REA-owned ECC bridge instructions;
8. ECC skills, agents, commands, rules, hooks, and workflows.

ECC is advisory and procedural inside REA.

ECC must never override a REA safety, evidence, ownership, lifecycle, provider, cleanup, authority, compatibility, or scope requirement.

If an ECC instruction conflicts with REA, preserve REA behavior and document the conflict when it materially affects the task.

## Core REA invariants

ECC usage must preserve all existing REA invariants, including:

- distinguish observations, derivations, inferences, and unknowns;
- preserve Evidence provenance;
- preserve caller-selected inputs;
- preserve relevant output, URLs, paths, digests, and metadata;
- keep provider-specific behavior out of domain/application layers;
- keep ownership separate from validity, editability, and readiness;
- do not infer ownership from weak identifiers;
- do not claim real-provider behavior from mocks or simulations;
- do not claim tests, reproduction, measurements, or validation that did not run;
- preserve cleanup authority and lifecycle semantics;
- retain resources whose cleanup failed when REA ownership rules require it;
- use fail-closed behavior when material authority, applicability, identity, or safety questions remain unresolved;
- avoid target mutation unless explicitly supported and authorized by REA;
- preserve local-only expectations where applicable;
- preserve target identity and caller choices;
- keep unknown states explicit instead of silently collapsing them to absent/false;
- never treat ECC guidance as authorization to expand REA scope;
- never treat a successful ECC workflow as proof of REA runtime correctness;
- never treat an automated review as a substitute for required human ownership or maintainer approval.

## How ECC should be used

Do not load the full ECC corpus into every agent context.

Use ECC selectively.

For each task:

1. identify the concrete engineering problem;
2. inspect the relevant REA rules and documentation;
3. determine whether ECC materially helps;
4. select only the relevant ECC skill, agent, rule, or workflow;
5. load the minimum necessary ECC context;
6. execute under REA authority;
7. verify using REA-compatible evidence;
8. report what actually ran, what did not run, and remaining limitations;
9. discard irrelevant ECC context when the task changes.

Preferred flow:

`task -> REA rules -> ECC capability selection -> implementation -> REA verification -> evidence`

Avoid:

`load everything from ECC -> hope the right behavior emerges`

## ECC capability discovery

ECC contains a large capability surface.

Agents should discover capabilities by task rather than by preloading the entire repository.

Useful source locations may include, depending on the pinned ECC release:

- `third_party/ecc/skills/`
- `third_party/ecc/.agents/`
- `third_party/ecc/agents/`
- `third_party/ecc/commands/`
- `third_party/ecc/rules/`
- `third_party/ecc/docs/`
- `third_party/ecc/.codex-plugin/`
- `third_party/ecc/.claude-plugin/`

Do not assume every ECC harness surface has equivalent functionality.

A capability advertised for Claude, Codex, Cursor, Gemini, or another harness must be checked against the actual harness being used.

## Capability selection examples

Examples of appropriate ECC assistance include:

- implementation planning;
- specification refinement;
- test-driven development;
- systematic debugging;
- build failure diagnosis;
- code review;
- security review;
- threat modeling;
- architecture review;
- refactoring;
- documentation;
- CI diagnosis;
- performance analysis;
- frontend engineering;
- backend engineering;
- data and database workflows;
- API work;
- research;
- reusable skill extraction;
- context management;
- session handoff;
- verification-before-completion workflows.

ECC should not be invoked merely because a matching skill exists.

Use it when it improves correctness, verification, efficiency, clarity, or continuity.

## Context-efficiency rule

REA already prioritizes agent-token and context efficiency.

ECC must therefore be consumed on demand.

Do not:

- preload hundreds of ECC skills;
- paste the full ECC instruction tree into `AGENTS.md`;
- activate unrelated agents for a narrow task;
- duplicate REA rules inside ECC-derived files;
- repeatedly load the same unchanged ECC documentation;
- keep ECC material in context after it is no longer relevant;
- run multiple overlapping ECC workflows without a concrete reason.

Prefer:

`task -> relevant REA rules -> selected ECC capability -> implementation -> verification`

instead of:

`all ECC content -> every task`

When equivalent workflows exist, prefer the smallest capability set that can complete and verify the task.

## REA bridge skill

REA provides a small bridge skill rather than copying the ECC corpus.

Location:

`.agents/skills/ecc-bridge/SKILL.md`

The bridge should:

- identify when ECC can help;
- point to `third_party/ecc`;
- instruct the agent to inspect only relevant ECC capability files;
- state REA authority precedence;
- prevent automatic activation of executable hooks;
- require evidence-compatible verification;
- distinguish advisory ECC content from executable ECC tooling;
- keep context bounded;
- avoid duplicating upstream ECC skill content.

The bridge is a router, not a mirror of ECC.

## Codex integration

ECC includes Codex-oriented packaging and metadata.

REA may make selected ECC capabilities available to Codex through the bridge layer.

However:

- do not overwrite REA's root `AGENTS.md` with ECC's;
- do not replace REA `.agents` content wholesale;
- do not copy ECC configuration trees over REA configuration trees;
- do not assume ECC hooks are natively enforced by Codex;
- do not enable global Codex behavior merely to support one REA workspace unless explicitly desired;
- repository-local integration is preferred for initial validation.

The first integration goal is selective capability access, not global installation.

A separate global ECC installation may be evaluated later after the repository-local integration is proven useful.

## Security

Treat ECC as third-party development tooling.

Before enabling executable hooks, scripts, plugins, MCP integrations, package installers, or automation from ECC:

1. inspect exactly what will execute;
2. identify file-system access;
3. identify process execution;
4. identify network access;
5. identify repository write access;
6. identify credential/environment access;
7. identify persistence or startup behavior;
8. identify telemetry or external transmission;
9. confirm compatibility with REA's local-only expectations;
10. run the relevant security checks;
11. do not silently grant additional authority.

Passing an ECC security check does not replace REA review or validation.

Secrets must never be copied into ECC configuration or logs merely to simplify setup.

Do not persist ambient environment variables merely because a subprocess can inherit them.

## AgentShield

AgentShield may be used as an additional audit layer for agent-facing configuration and tooling.

It may help inspect surfaces such as:

- prompts;
- hooks;
- MCP configuration;
- permissions;
- secrets exposure;
- agent files;
- suspicious automation;
- risky configuration.

AgentShield findings are evidence for review, not an automatic authority decision.

A clean AgentShield result does not prove:

- REA semantic correctness;
- safe target mutation;
- provider correctness;
- cleanup correctness;
- real-provider compatibility;
- absence of all supply-chain risk.

Any executable ECC surface still requires REA-compatible review.

## Hooks and automation

ECC hooks and automation are not automatically authoritative inside REA.

A hook may be enabled only when:

- its behavior is understood;
- its source is reviewed;
- it does not alter REA semantics;
- it does not mutate targets outside REA authority;
- it does not install or upgrade unrelated software;
- it does not silently transmit REA evidence or local files;
- it does not leak credentials;
- it is reproducible;
- it is reversible;
- its failure mode is understood;
- disabling it does not corrupt the workspace.

For the initial integration:

> ECC executable hooks remain disabled unless individually reviewed and intentionally enabled.

Documentation, skills, and advisory workflows may be consumed without enabling their executable hooks.

## MCP and external integrations

ECC may contain guidance or configuration related to MCP servers or other external integrations.

Do not automatically enable them.

Before enabling an ECC-associated MCP or external service:

- determine whether REA already provides the needed capability;
- verify data leaving the machine;
- verify authentication handling;
- verify target/evidence exposure;
- verify write authority;
- verify process/network lifetime;
- confirm that use is compatible with the task and REA rules.

Prefer existing REA-native capabilities when they already satisfy the need.

## Memory and continuous learning

ECC may provide memory, instinct, session-summary, or continuous-learning workflows.

These must not silently become authoritative project state.

Persistent project facts belong in REA-owned documentation, source, tests, issues, or accepted project records.

Agent memory may assist continuity, but it must not override repository evidence.

For any material claim about the current project:

`repository/documented evidence > remembered agent context`

Do not persist secrets, target-sensitive data, or credentials into ECC memory facilities.

## Skills and agents

REA integrations should reference ECC capabilities from:

`third_party/ecc`

rather than copying the complete upstream corpus into REA.

REA-specific adapter skills may be created under:

`.agents/skills/`

These adapters should:

- describe when an ECC capability is useful;
- point to the relevant ECC source;
- declare REA precedence;
- avoid duplicating upstream ECC content;
- remain small enough to load efficiently;
- document any REA-specific restrictions;
- avoid hard-coding assumptions about ECC files that are not checked during upgrades.

## Third-party integrity

ECC is itself third-party code.

The submodule pin establishes reproducibility but is not a complete security audit.

When updating ECC:

- verify the intended upstream repository;
- inspect the release/tag;
- review release notes;
- review security-sensitive diffs;
- review package-install changes;
- review hooks;
- review MCP integrations;
- review credential/environment handling;
- review new persistence or telemetry;
- review new agent authority assumptions.

Do not update solely because a newer commit exists.

## Updating ECC

ECC updates are deliberate changes.

Do not automatically update the submodule.

To evaluate a new release:

1. inspect upstream release notes;
2. fetch tags;
3. identify the proposed release commit;
4. review security-sensitive changes;
5. review plugin, hook, MCP, memory, installer, and agent behavior changes;
6. update the submodule in a dedicated branch;
7. update the pinned version documented here;
8. run relevant REA checks;
9. review the resulting diff;
10. validate the bridge against any ECC directory/layout changes;
11. merge only after the normal REA review process.

Example:

```bash
git -C third_party/ecc fetch --tags
git -C third_party/ecc checkout <approved-version>
git add third_party/ecc
```

Then verify:

```bash
git submodule status third_party/ecc
git diff --cached --submodule
```

Update this document whenever the pinned ECC version changes.

## Fresh clone / workspace restoration

Because ECC is a submodule, a fresh clone of the REA integration branch must initialize submodules.

Preferred:

```bash
git clone --recurse-submodules <rea-repository-url>
```

For an existing clone:

```bash
git submodule update --init --recursive
```

To restore the exact pinned ECC commit:

```bash
git submodule update --init --recursive third_party/ecc
git submodule status third_party/ecc
```

Do not run `git pull` inside `third_party/ecc` as a routine setup step because that can move the submodule away from the commit pinned by REA.

## Local development environments

Keep these concepts separate.

### Upstream ECC

Untouched third-party project:

`third_party/ecc`

### REA integration layer

REA-owned adapters, documentation, and configuration that decide how ECC is used.

### Development environment

Local tools used by a contributor or agent, such as Codex, Node.js, Git, Ghidra, or other analysis providers.

### Test environment

Controlled environment used to validate changes.

### Real provider environment

Actual supported provider/runtime used to establish real behavior.

### REA production behavior

REA runtime behavior delivered to users.

Success in an ECC demo, mock, isolated harness, or development environment is not automatic proof of REA production behavior.

## Validation strategy

The integration itself should be validated in stages.

### Gate A — Submodule integrity

Verify:

- `third_party/ecc` exists;
- it is a Git submodule;
- it points to the documented commit;
- the documented tag resolves to that commit;
- a clean clone can restore it.

### Gate B — No REA regression

Run REA checks relevant to documentation/agent configuration changes.

At minimum, use the checks required by the touched surfaces.

Do not claim a full gate passed unless it actually ran.

### Gate C — Bridge discovery

Verify that an agent can:

1. start from a concrete REA engineering task;
2. identify a useful ECC capability;
3. locate the corresponding ECC source;
4. load only that capability;
5. preserve REA precedence.

### Gate D — Safety

Verify that the initial integration does not automatically:

- execute ECC hooks;
- add external MCP servers;
- install unrelated software;
- transmit REA evidence;
- rewrite REA root instructions;
- modify REA runtime behavior.

### Gate E — Practical workflow

Use ECC on at least one real REA development task and verify that:

- it improves the workflow;
- the task remains governed by REA rules;
- validation evidence remains accurate;
- context does not become unnecessarily bloated.

## Initial integration acceptance criteria

The first ECC integration is accepted when all of the following are true:

- the full upstream ECC repository is available locally;
- ECC is pinned to `v2.2.3`;
- the pinned commit is `c05b2d6614f62f6db0047669aa4eefb223d478f9`;
- a fresh clone can reproduce the same ECC checkout;
- REA has a small ECC bridge skill;
- agents can selectively discover ECC capabilities;
- REA instructions remain authoritative;
- no ECC executable hook is silently enabled;
- no external ECC MCP integration is silently enabled;
- ECC does not become a REA runtime dependency;
- relevant REA checks pass;
- actual validation evidence is recorded;
- the integration can be removed cleanly if rejected.

## Rollback

The integration must remain removable.

A rollback should require only removal of REA-owned bridge/documentation changes and the ECC submodule entry.

Conceptually:

```bash
git submodule deinit -f third_party/ecc
git rm -f third_party/ecc
```

Then remove any REA-owned ECC bridge files and verify `.gitmodules`.

Do not run rollback commands casually on an active working tree. Review local changes first.

## Updating the bridge

When ECC changes, verify whether these assumptions still hold:

- expected skills directories exist;
- Codex packaging remains compatible;
- bridge references still resolve;
- security tooling locations still exist;
- no new always-on behavior is introduced;
- no ECC update changes the meaning of existing workflows used by REA.

If upstream layout changes, update the bridge rather than creating duplicated copies of ECC content.

## Non-goals of the initial integration

The initial integration does **not** aim to:

- fork ECC;
- merge ECC source code into REA source directories;
- make ECC a production dependency;
- enable every ECC hook;
- enable every ECC MCP integration;
- globally install ECC for every project;
- replace REA tests with ECC tests;
- replace REA documentation with ECC documentation;
- delegate REA authority decisions to ECC;
- load all ECC skills in every context.

These may be evaluated separately later if a concrete need appears.

## Future optional enhancements

After the basic integration is proven, possible follow-up work may include:

- richer ECC capability indexing;
- a REA-specific ECC capability catalog;
- selective Codex-native ECC installation;
- controlled AgentShield checks in development;
- documented task-to-skill routing;
- CI checks that validate the ECC pin and bridge references;
- an update procedure for evaluating future ECC releases;
- metrics for context/token impact;
- comparison of workflows with and without selected ECC capabilities.

Each enhancement should have its own acceptance criteria and must preserve REA authority.

## Operational checklist

Before using ECC on a REA task:

- [ ] Read relevant REA instructions.
- [ ] Identify the concrete task.
- [ ] Decide whether ECC adds value.
- [ ] Select the minimum relevant ECC capability.
- [ ] Check whether the capability is advisory or executable.
- [ ] Do not enable hooks/MCP automatically.
- [ ] Preserve REA evidence and authority rules.
- [ ] Run appropriate verification.
- [ ] Report what actually ran.
- [ ] Record meaningful limitations.

Before updating ECC:

- [ ] Review upstream release/tag.
- [ ] Review security-sensitive changes.
- [ ] Update in a dedicated branch.
- [ ] Verify submodule pin.
- [ ] Update this document.
- [ ] Validate bridge references.
- [ ] Run relevant REA checks.
- [ ] Review the final diff.

## Capability routing policy

The REA bridge routes a task to the smallest ECC capability that materially helps. Routing is advisory: selecting a skill or agent file does not enable ECC hooks, installers, slash commands, orchestration, plugins, subprocesses, network access, or MCP integrations.

| Task class                             | Default ECC route                                      | Secondary only when needed                       |
| -------------------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| Ambiguous/high-impact change           | `skills/intent-driven-development/SKILL.md`            | —                                                |
| Unfamiliar repository area             | `skills/codebase-onboarding/SKILL.md`                  | —                                                |
| Feature / behavior implementation      | `skills/tdd-workflow/SKILL.md`                         | exact language-specific reviewer under `agents/` |
| Regression / broken behavior           | `skills/orch-fix-defect/SKILL.md` as advisory workflow | `skills/tdd-workflow/SKILL.md`                   |
| Code review                            | `agents/code-reviewer.md`                              | exact language-specific reviewer under `agents/` |
| Security-sensitive change              | `skills/security-review/SKILL.md`                      | `agents/security-reviewer.md`                    |
| Agent / LLM architecture audit         | `skills/agent-architecture-audit/SKILL.md`             | —                                                |
| Documentation governance               | `skills/living-docs-governance/SKILL.md`               | —                                                |
| Performance optimization               | `skills/benchmark-optimization-loop/SKILL.md`          | relevant domain-specific performance skill       |
| Build / type / CI failure              | `agents/build-error-resolver.md`                       | `skills/verification-loop/SKILL.md`              |
| Final pre-PR / completion verification | `skills/verification-loop/SKILL.md`                    | —                                                |

Routing rules:

- read applicable REA instructions and current project state first;
- choose one primary ECC capability by default;
- add a secondary only for a distinct concern that changes implementation or verification;
- translate generic ECC commands into REA-approved commands before execution;
- do not auto-select installer/bootstrap skills such as `repo-scan` for ordinary repository understanding;
- if ECC guidance conflicts with REA authority, evidence, provider, cleanup, or environment rules, REA wins;
- report which ECC capability was used and which REA evidence closed the task.

Examples:

- a new TypeScript behavior change routes first to `tdd-workflow`; `typescript-reviewer.md` is added only when language-specific review is useful;
- an authentication change routes to the implementation workflow plus `security-review`, because the trust boundary changes the required proof;
- a failing build routes to `build-error-resolver`, not to an architecture or refactoring workflow;
- a request to understand an unfamiliar subsystem routes to `codebase-onboarding`; `repo-scan` is not selected automatically because its ECC entry is a bootstrap installer for external tooling;
- completion before a PR routes to `verification-loop`, but only REA-compatible checks that actually run may be reported as evidence.

## Initial validation record

The initial repository-local integration was validated on the `feat/ecc-integration` branch with ECC pinned to `v2.2.3` / `c05b2d6614f62f6db0047669aa4eefb223d478f9`.

Observed evidence:

- `git diff --cached --check` completed without findings before the integration commit;
- `npm ci` restored the locked REA dependencies and reported zero known vulnerabilities for that install;
- the matching `rea-agents@6.7.0` Windows native artifact was restored from the published tarball and `scripts/verify-windows-native-artifact.mjs` returned `ok: true`;
- `npm run docs:check` completed with exit code `0`, including six successful documentation tasks and five passing README-consistency tests;
- the ECC bridge discovered `third_party/ecc/skills/security-review/SKILL.md` from a concrete review task without recursively loading the ECC corpus;
- that security-review capability was used only as advisory review guidance under REA authority;
- the integration diff changes only `.gitmodules`, the ECC submodule pointer, `docs/ECC_INTEGRATION.md`, and `.agents/skills/ecc-bridge/SKILL.md`; no REA runtime source, root package script, hook configuration, or MCP configuration is changed by the integration commit;
- no ECC executable hook, installer, plugin, or MCP integration was enabled during this validation.

Scope limits:

- this validation establishes the repository-local development integration, not a global ECC installation;
- ECC dependency trees were not installed or executed as part of the bridge validation;
- AgentShield and other executable ECC tooling remain optional and unvalidated until separately reviewed;
- no real analysis target or provider behavior was changed or claimed by this integration.

## Final success test

The final integration test is not merely that the submodule exists.

The integration succeeds when, in the real REA development workspace, an agent can take a genuine engineering task, discover and use an appropriate ECC capability on demand, complete or improve the task under REA rules, produce accurate verification evidence, and finish without silently enabling unrelated ECC automation or changing REA runtime authority.

If that real workflow cannot be demonstrated, the ECC integration is not yet complete.

## Final rule

ECC improves **how work is performed**.

REA defines **what behavior is acceptable**.

When uncertain:

1. preserve REA behavior;
2. preserve evidence and uncertainty;
3. avoid expanding authority;
4. treat ECC guidance as optional;
5. require explicit review before enabling executable third-party automation.
