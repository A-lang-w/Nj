---
name: ecc-bridge
description: Selectively use the vendored ECC engineering harness for REA development tasks without overriding REA authority, loading the whole ECC corpus, or enabling executable ECC automation by default.
---

# ECC bridge for REA

Use ECC as an optional engineering aid for REA work. REA remains authoritative.

Read [ECC integration](../../../docs/ECC_INTEGRATION.md) and the relevant sections of [AGENTS.md](../../../AGENTS.md) before applying ECC guidance.

The upstream ECC checkout is pinned under:

`third_party/ecc`

Do not copy ECC's full instruction tree into REA and do not replace REA's root `AGENTS.md` or `.agents` tree with upstream ECC content.

## When to use ECC

Use this bridge when a REA task can materially benefit from an ECC workflow, skill, agent, review practice, or security aid, including:

- planning;
- test-driven development;
- systematic debugging;
- code review;
- security review;
- architecture review;
- CI/build diagnosis;
- documentation;
- refactoring;
- performance analysis;
- context/session management;
- verification-before-completion.

Do not invoke ECC merely because a similarly named skill exists.

## Selection workflow

For each task:

1. identify the concrete REA problem and the applicable REA rules;
2. decide what kind of ECC capability would help;
3. inspect only the smallest relevant ECC source files under `third_party/ecc`;
4. verify that the capability actually applies to the current harness;
5. apply the useful procedure under REA authority;
6. validate with REA-compatible evidence;
7. report what actually ran and any remaining limitations.

Prefer capability-specific files, for example under:

- `third_party/ecc/skills/`
- `third_party/ecc/.agents/`
- `third_party/ecc/agents/`
- `third_party/ecc/commands/`
- `third_party/ecc/rules/`
- `third_party/ecc/docs/`
- `third_party/ecc/.codex-plugin/`

Do not recursively ingest all of ECC for one task.

## Automatic capability router

Classify the REA task before opening ECC material. Pick **one primary capability** from the table below. Load a secondary capability only when a separate concern materially changes the implementation or the proof required for completion.

| REA task                                        | Primary ECC capability                        | Optional secondary                  | Notes                                                                                                                                 |
| ----------------------------------------------- | --------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Clarify an ambiguous or high-impact change      | `skills/intent-driven-development/SKILL.md`   | —                                   | Turn intent into observable acceptance criteria before implementation.                                                                |
| Understand an unfamiliar area of the repository | `skills/codebase-onboarding/SKILL.md`         | —                                   | Use selective reconnaissance; do not generate or replace project instructions unless the task explicitly requires it.                 |
| Implement a feature or behavior change          | `skills/tdd-workflow/SKILL.md`                | language-specific reviewer agent    | Preserve REA's own test commands and evidence rules; ECC's coverage targets are guidance, not authority over REA.                     |
| Fix a regression or broken behavior             | `skills/orch-fix-defect/SKILL.md`             | `skills/tdd-workflow/SKILL.md`      | Use `orch-fix-defect` as an advisory defect workflow unless ECC orchestration has been separately reviewed and intentionally enabled. |
| Review changed code                             | `agents/code-reviewer.md`                     | language-specific reviewer agent    | Review only the relevant diff plus necessary surrounding context; REA conventions override generic reviewer heuristics.               |
| Review security-sensitive work                  | `skills/security-review/SKILL.md`             | `agents/security-reviewer.md`       | Use for auth, secrets, external inputs, sensitive data, APIs, or other trust-boundary changes.                                        |
| Audit agent / LLM architecture                  | `skills/agent-architecture-audit/SKILL.md`    | —                                   | Use only for agent-stack behavior; it is not the default general architecture reviewer.                                               |
| Maintain long-lived project documentation       | `skills/living-docs-governance/SKILL.md`      | —                                   | Reuse REA's existing canonical docs; do not create a parallel documentation system.                                                   |
| Optimize measurable performance                 | `skills/benchmark-optimization-loop/SKILL.md` | domain-specific performance skill   | Require a baseline, correctness gate, bounded search budget, and repeatable measurement.                                              |
| Diagnose build / type / CI failures             | `agents/build-error-resolver.md`              | `skills/verification-loop/SKILL.md` | Make the smallest fix that restores the failing gate; do not turn build repair into unrelated refactoring.                            |
| Final verification before PR / completion       | `skills/verification-loop/SKILL.md`           | —                                   | Translate its generic phases into REA-approved commands and report only checks that actually ran.                                     |

### Routing rules

1. **REA rules first.** Read the applicable REA instructions and current project state before selecting ECC guidance.
2. **One primary capability by default.** Do not stack multiple overlapping skills merely because they exist.
3. **Secondary only for a distinct concern.** Examples: feature + security, feature + database, or implementation + language-specific review.
4. **Advisory does not mean executable.** Reading a skill or agent file does not authorize its hooks, slash commands, installers, subprocesses, network actions, or MCP integrations.
5. **Translate generic commands.** ECC examples such as `npm test`, build commands, or shell snippets are suggestions until they match REA's documented workflow and current environment.
6. **Do not use bootstrap installers as the default route.** For example, `skills/repo-scan/SKILL.md` is an installer pointer to external tooling, so it must not be auto-selected for ordinary repository understanding.
7. **Stop on conflict.** If an ECC procedure conflicts with REA evidence, authority, cleanup, provider, or environment rules, discard the conflicting ECC step and preserve REA.
8. **Report the route used.** For meaningful tasks, record the selected primary capability, any secondary capability, and the REA verification evidence that closed the task.

### Language-specific reviewers

When a code review benefits from language specialization, prefer an existing reviewer under `third_party/ecc/agents/` such as `typescript-reviewer.md`, `python-reviewer.md`, `go-reviewer.md`, `rust-reviewer.md`, `cpp-reviewer.md`, `java-reviewer.md`, `kotlin-reviewer.md`, or another exact file that exists in the pinned ECC checkout. Never invent an agent name from a language label.

## Authority

If ECC conflicts with REA, preserve REA.

In particular, ECC never grants permission to:

- execute or mutate analysis targets outside REA authority;
- weaken Evidence provenance;
- collapse unknown states into assumptions;
- bypass ownership or cleanup rules;
- claim real-provider behavior from mocks or simulations;
- claim tests or measurements that did not run;
- install or upgrade unrelated software;
- publish, push, merge, or expand project scope without the authority otherwise required by REA and the user.

## Executable ECC surfaces

Treat ECC hooks, scripts, installers, plugins, MCP integrations, memory systems, and automation as executable third-party tooling.

Do not enable them automatically.

Before enabling any such surface, inspect its source and identify:

- filesystem access;
- process execution;
- network access;
- repository writes;
- credential/environment access;
- persistence/startup behavior;
- telemetry or external transmission;
- rollback behavior.

For the initial REA integration, advisory skills and documentation may be used while executable ECC hooks remain disabled unless separately reviewed and intentionally enabled.

## AgentShield

AgentShield may be used as an additional audit aid for agent-facing configuration, prompts, hooks, MCP configuration, permissions, secrets exposure, and agent files.

Its findings supplement REA review; they do not establish REA semantic correctness, provider correctness, safe target mutation, cleanup correctness, or complete supply-chain safety.

## Context efficiency

REA prioritizes agent-token and context efficiency.

Load only what the current task needs. Avoid overlapping workflows and repeated loading of unchanged ECC material.

Preferred flow:

`REA task -> relevant REA rules -> selected ECC capability -> implementation -> REA verification`

## Completion

Do not call a task complete because an ECC workflow finished.

Completion still requires the REA-compatible verification appropriate to the touched surface, accurate reporting of executed checks, and any real-provider or human validation that the task requires.
