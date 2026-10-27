# Implementation Assessment

**Date:** 2026-10-27
**Inputs reviewed:** all five documents in [`docs/spec/`](spec/) (copied unchanged from `iterative-platform-docs/`), the three images in `docs/spec/design-references/`, and the `Player-cloud/aPP-claude` repository.
**Status legend (used everywhere in this repo):** Implemented and verified · Implemented, not fully verified · Partially implemented · Planned · Blocked · Not required.

---

## 1. Current repository and architecture

| Item | Finding | Evidence |
|---|---|---|
| Local folder | Contains only the five spec documents and three JPEG design references. No code, no Git repository. | Directory listing of `iterative-platform-docs-download/` |
| GitHub repository | `Player-cloud/aPP-claude` exists but has **no commits**. | `git log` → "does not have any commits yet" |
| Stack, dependencies, tests, CI/CD, env config | None exist. | — |
| Installed integrations | Not inspected. The user's Claude Code environment (plugins, skills, hooks, MCP servers) is on their machine and was not scanned; that is Phase 10 work and needs a read-only inventory first. | — |

**Conclusion:** this is a greenfield build. There is no existing stack to preserve, so Phase 0 decisions are genuinely open rather than already made by the code.

## 2. The five documents and how they relate

| Document | Role | Feeds into |
|---|---|---|
| `PRODUCT_VISION.md` | Why the product exists; the two layers; principles; open product decisions (§8). | Architecture goals, FR priorities |
| `SYSTEM_ARCHITECTURE.md` | Logical components, agent-selection policy, workflow state model (§4), trust boundaries (§7), decisions still required (§10). | FR acceptance criteria, roadmap phases |
| `FUNCTIONAL_REQUIREMENTS.md` | 40+ requirements with stable IDs (`FR-APP-*`, `FR-TOOL-*`, …), MUST/SHOULD/COULD, acceptance criteria. | Traceability matrix, tests |
| `TOOL_REGISTRY.md` | Candidate tools (all *Proposed* or *Needs verification*), registry schema, conflict-resolution workflow, onboarding checklist. | Tool inventory data model, Phase 3/5/6/10 |
| `IMPLEMENTATION_ROADMAP.md` | Phases 0–12 with tasks and exit criteria; early decisions (§17). | Milestone order (this plan follows it) |

The documents are consistent in principle: evidence before claims, least complexity, human approval for high-impact actions, Iterative Layer starts read-only, and nothing in the Tool Registry is assumed installed.

## 3. Reusable existing functionality

Nothing in the repository to reuse. What *is* reusable:

- **The requirements themselves.** They already have stable IDs and acceptance criteria, so they can be the traceability backbone (see [`TRACEABILITY.md`](TRACEABILITY.md)).
- **The workflow state model** in SYSTEM_ARCHITECTURE §4 and the **registry schema** in TOOL_REGISTRY §2 are concrete enough to implement directly.
- **Claude Code itself.** Most named tools (`/egm-*`, `/simplify`, `/security-review`, `code-review`, skills, plugins, hooks, MCP) are Claude Code extensions. The Claude Agent SDK can run with Claude Code's skills, plugins, slash commands and settings, so using it as the agent runtime lets the platform reuse the user's existing tooling instead of re-implementing it.

## 4. Conflicts, contradictions and missing information

| # | Issue | Where | Recommendation |
|---|---|---|---|
| C1 | Improvement cycle omits **Approve** in the vision (`Observe → … → Propose → Implement`), but FR-ITER-003 and the brief require approval before implementation. | VISION §4.3 vs FR-ITER-003 | Use `Observe → Analyse → Prioritise → Propose → Approve → Implement → Verify → Deploy → Evaluate` everywhere. Update VISION §4.3 once approved. |
| C2 | Tool Conflict manager is **MUST** (FR-TOOL-001…005) and called "essential", yet the roadmap schedules it at **Phase 10**. Phase 3 (EGM verification) and Phase 6 (verifying review tools) already need a working inventory. | FR §11 vs ROADMAP §12 | Pull the **read-only inventory and conflict detection** (FR-TOOL-001/002) forward to directly after Phase 2. Keep destructive removal (FR-TOOL-004) in Phase 10. |
| C3 | Three names for one component: "Tool Conflict and Cleanup Manager", "Tool conflict and lifecycle manager", "Tool Conflict and Safe Uninstallation Manager". | VISION, ARCH §3.11, brief | Adopt one name (proposal: *Tool Conflict and Cleanup Manager*, ID TOOL-LIFE-001). |
| C4 | Two drift tools with overlapping purpose: `rift-check` (TOOL-REVIEW-005) and `/egm-drift-report` (TOOL-PLAN-005). "rift-check" may be a typo of "drift-check". | TOOL_REGISTRY §3–4 | Verify the source of `rift-check`; if it is real, treat the pair as a known overlap for the conflict manager. |
| C5 | Learning Studio is **SHOULD** (FR-DESIGN-001) but FR-DESIGN-004 (**MUST**) requires Learning Studio browsing features. | FR §6 | Treat Learning Studio browsing as MUST once Phase 5 starts; ingestion/classification stays SHOULD. |
| C6 | Memory/feedback overlap: `feedback`, `reflect-mod`, `remember`, `wrap-up`, Preferences/Vault. | TOOL_REGISTRY §6 | Already flagged in the docs; resolve in Phase 12 via the conflict manager. |
| C7 | "Deploy" in the Iterative Layer is undefined for a desktop app. It implies a signed app update and rollback, which depends on the packaging decision. | VISION §4.3, ROADMAP Phase 11 | Define once packaging is chosen: self-improvements ship as a new app version; the previous installer is the known-good rollback. |
| M1 | No target OS, minimum hardware, or supported viewport sizes (FR-APP-001 and FR-DESIGN-004 need them). | — | Proposal: Windows 10/11 x64 first; viewports 1280×800 and 1920×1080, usable to 1024 wide. |
| M2 | No definition of who can approve in a single-user app, or how an approval is authenticated. | FR-SEC-003 | Single user = local OS account. Approvals recorded as audit events with an explicit confirmation step; revisit if multi-user is added. |
| M3 | No budget, rate limits, or cost ceilings. | VISION §8 | Needs a number from you before agent orchestration (Phase 2) runs real model calls. |
| M4 | No telemetry retention or privacy defaults. | ARCH §9–10 | Default: local-only telemetry, no source code or prompt bodies captured, 90-day retention. |
| M5 | EGM sources (`egm.dev`, `github.com/google/elephant-goldfish-model`) could not be reached from this environment (network policy 403), so existence, licence and command names are **unverified**. | TOOL-PLAN-001 | Verify on your machine during Phase 3. FR-PLAN-001 must work without EGM (native fallback). |

## 5. Foundational decisions to resolve

| Decision | Recommended default | Why | Consequential? |
|---|---|---|---|
| D1 App shell / packaging | **Electron**, Windows-first NSIS installer | Core and Agent SDK are Node; Electron runs Node natively, no sidecar. | **Approved 2026-10-27** |
| D2 Core language | **TypeScript on Node 22** | Agent SDK is TypeScript; one language for core, CLI and UI. | Low (core is portable to any Node host) |
| D3 Execution model | **Local**, with each project in its own workspace directory; Git worktrees for isolated changes | Matches "installable" and keeps source code local by default. | Yes (bundled in D1 card) |
| D4 Storage | **SQLite** (one DB file in the app data dir) + plain files for artifacts | Zero server, transactional, easy backup. Uses Node's built-in `node:sqlite`, so no native build. | Medium; hidden behind a store interface |
| D5 Model provider | **Claude via Claude Agent SDK** | Reuses Claude Code plugins/skills/MCP; matches tool registry. | Yes (bundled in D1 card) |
| D6 Secrets | **OS credential store** (Windows Credential Manager via Electron `safeStorage`); DB stores only references | FR-SEC-002 | Medium |
| D7 Auth / users | **Single local user** for v1 | Vision lists multi-user as open; nothing requires it yet. | Yes (bundled in D1 card) |
| D8 First integrations | **GitHub** (Git provider), **Playwright** (browser QA) | GitHub repo already exists; Playwright is the standard local browser driver. | Low |
| D9 Background work | In-process job queue persisted in SQLite; no external scheduler | Least complexity. | Low |
| D10 Updates / recovery | Manual update first; auto-update (electron-updater) only after signing and rollback are tested | FR-APP-001 says specify recovery before auto-update. | Yes, later |
| D11 Budget | **Needed from you** | — | Yes |

## 6. Prioritised implementation plan (follows the roadmap)

| Order | Roadmap phase | Milestone | Key requirements | Depends on |
|---|---|---|---|---|
| **M1** | Phase 1 (core half) | **Persistent workspace core + CLI** | FR-APP-002, FR-PROJ-001, FR-APP-004 (state), FR-SEC-002 (redaction), FR-SEC-004 | Nothing open (D2, D4 low-risk) |
| M2 | Phase 1 (shell half) | Electron shell, design tokens, project list/create/detail, installer smoke test | FR-APP-001, FR-DESIGN-004 | D1 (approved) |
| M3 | Phase 2 | Orchestrator: task specs, single-agent + subagent paths, strategy rationale, budget/timeouts | FR-APP-003 | D5, D11 |
| M4 | Phase 10a (pulled forward, see C2) | Read-only tool inventory + conflict detection of the user's Claude Code environment | FR-TOOL-001, FR-TOOL-002 | M1 |
| M5 | Phase 3 | Planning slice: native brief/spec workflow, `docs/designs/`, spec versioning; EGM adapter if verified | FR-PLAN-001/002 | M3, M4 |
| M6 | Phase 4 | Build Feature + Fix a Bug workflows with real test evidence | FR-BUILD-* | M5 |
| M7 | Phase 6 | Quality gate + `ship-check` (release prep only) | FR-QA-001/003/004, FR-SHIP-001 | M6 |
| M8 | Phase 7 | Import + focused/enterprise assessment (read-only) | FR-PROJ-002/003/004 | M1, M4 |
| M9 | Phase 5 | Learning Studio + UI refinement workflow | FR-DESIGN-* | M2 |
| M10+ | Phases 8, 9, 10b, 11, 12 | Iterative Layer (observe/recommend), ecosystem monitor, safe cleanup executor, controlled self-improvement, learning | FR-ITER-*, FR-TOOL-003/004/005, FR-LEARN-* | Above |

Phase 7 (import/assessment) is placed before Phase 5 (design) because it is read-only, high value, and does not need the UI shell to be finished. This is a reordering, not a scope change; the phases and exit criteria are unchanged.

## 7. First end-to-end milestone (M1) and acceptance criteria

**M1 — Persistent workspace core + CLI.** A TypeScript library (`src/core`) and command-line interface (`iap`) that the Electron shell will later call. The CLI is the first usable surface and is how the core is tested end to end.

| ID | Acceptance criterion | Traces to |
|---|---|---|
| M1-AC1 | `iap project create` gives a project a stable ID, a workspace directory, an initial status, and a `docs/designs/` location. | FR-PROJ-001 |
| M1-AC2 | Project details record which facts are confirmed and which are assumptions. | FR-PROJ-001 |
| M1-AC3 | After the process exits and restarts, projects, workflow runs and events can be listed and inspected. | FR-APP-002 |
| M1-AC4 | Workflow runs follow the explicit state model (`draft → planned → approved → running → verification → awaiting_approval → completed`, plus `blocked`, `cancelled`, `failed`); invalid transitions are rejected. | ARCH §4, FR-APP-002 |
| M1-AC5 | A blocked run must state the blocker and how to resolve it; listing shows it. | FR-APP-004 |
| M1-AC6 | Every state change writes an audit event; events cannot be updated or deleted through the database. | FR-SEC-004 |
| M1-AC7 | A corrupt state file produces a recoverable error naming the file and the recovery command; nothing is overwritten silently. Recovery preserves the corrupt file. | FR-APP-002 |
| M1-AC8 | Secret-looking values in event payloads and notes are redacted before storage. | FR-SEC-002 |
| M1-AC9 | Data location is documented and overridable (`IAP_HOME`). | FR-APP-001 (storage location criterion) |
| M1-AC10 | Type check and the automated test suite pass in CI-equivalent runs, with results recorded. | FR-BUILD-002 |

**Out of scope for M1:** UI, agents, model calls, external integrations, installer.

## 8. Security, dependency and integration risks

| Risk | Impact | Mitigation |
|---|---|---|
| `node:sqlite` is marked experimental in Node 22. | API changes on Node upgrades. | Store hidden behind one module; tests pin behaviour; swap to `better-sqlite3` if needed. |
| Agent runtime executes code from imported, untrusted repositories. | Code execution on your machine. | M3 must define the sandbox (worktree + restricted tool permissions + no network by default) before any imported code runs. Nothing in M1 executes project code. |
| Tool Registry names are unverified (EGM, `rift-check`, `qa`, motion skills, mods). | Building adapters for tools that do not exist. | Adapters are written only after the inventory (M4) confirms a tool is installed. |
| Conflict cleanup can damage your global Claude Code setup. | Lost plugins/config across projects. | Removal stays out of scope until Phase 10b; the inventory is read-only and distinguishes app-managed from user-managed tools. |
| Secrets in logs, reports, prompts. | Credential exposure. | Redaction at the storage boundary from M1; OS credential store from M2. |
| Self-improvement modifying the running app. | Broken platform with no rollback. | Iterative Layer stays observe/recommend until Phase 11; changes only via worktrees and a new signed version. |
| Cost growth from agent teams and background work. | Unbounded spend. | Budget (D11) required before M3 runs real model calls; orchestrator enforces it deterministically. |
| Unverifiable sources from this cloud environment (network policy blocks egm.dev and some GitHub repos). | Claims about tools cannot be checked here. | Verification runs on your machine; results are recorded as evidence in the registry. |
