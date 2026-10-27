# Requirements Traceability

Status legend: **Verified** (implemented, automated tests pass) · **Implemented, not fully verified** · **Partial** · **Planned** · **Blocked** · **Not required**.
"Verified" here means verified for the stated scope only, with the evidence listed.

| Requirement | Scope covered so far | Status | Code | Tests / evidence |
|---|---|---|---|---|
| FR-APP-001 Installable application | Windows NSIS installer; silent install → launch → health check → uninstall keeps data; OS + data locations documented | **Verified** for Windows x64 per-user install (CI `installer` job, PR #2). Auto-update and code signing not started; clean install on a physical machine not yet reported. | `electron-builder.yml`, `src/main/main.ts` (`--smoke-test`), `docs/OPERATIONS.md` | CI job `installer` (windows-latest) |
| FR-APP-002 Persistent workspace | Projects, runs, events persist across restarts; run states; corrupt/missing state handled | **Verified** for projects + runs + events (specs, evidence, tool inventory, approvals, proposals not yet stored) | `src/core/workspace.ts`, `src/core/workflow.ts` | `test/workspace.test.ts` (AC3, AC7, too-new), `test/cli.test.ts` (separate processes) |
| FR-APP-003 Orchestration | Main agent plans, chooses single / subagents / team by scope, parallelism, file conflicts, risk, context size and budget, records strategy and rationale, gives each delegated task a goal, output contract, tool allow-list and timeout, and reconciles before a request counts as done; single agent preferred | **Implemented**: simulated model (DEC-017) and Claude Opus 5.5 under the monthly budget (DEC-018). The Claude path is tested against a fake client only; real plan quality is unverified. Tools are allow-list checked but not executed | `src/core/agents/` | `test/orchestrator.test.ts`, `test/claude.test.ts`, `test/service.test.ts` M3, `test/cli.test.ts` M3, `e2e/app.e2e.ts` M3 |
| FR-APP-004 Workflow visibility | Runs show state, progress, allowed next actions only, blocker + resolution, failures; activity log screen | **Partial** (no tool activity or agent progress yet; nothing long-running to resume) | `src/core/workflow.ts`, `src/cli/main.ts` | `test/workflow.test.ts`, `test/cli.test.ts` |
| FR-PROJ-001 Create a project | Stable ID, workspace, status, `docs/designs/`, confirmed vs assumption facts, in CLI and desktop UI | **Verified** | `src/core/workspace.ts` | `test/workspace.test.ts` AC1/AC2, `test/cli.test.ts` |
| FR-SEC-002 Secrets protection | Redaction of keys and known token formats before storage | **Partial** (safety net only; credential store planned) | `src/core/redact.ts` | `test/redact.test.ts`, raw-DB scan in `test/workspace.test.ts` AC8 |
| FR-SEC-001 Least-privilege tools | Renderer sandboxed (context isolation, no Node), strict CSP, navigation and new windows blocked, permission requests denied, IPC caller checked | **Partial** (applies to the UI; no tools or integrations exist yet) | `src/main/main.ts`, `src/preload/preload.ts`, `src/renderer/index.html` | `e2e/app.e2e.ts` M2-AC8 |
| FR-SEC-005 Untrusted input | All renderer input validated in the main process; internal errors not leaked | **Partial** (no imported repos or code execution yet) | `src/main/service.ts` | `test/service.test.ts`, `e2e/app.e2e.ts` |
| FR-DESIGN-004 Application visual system | Shared tokens, nav rail / header / work surface / context panel, dark + light + system themes, focus, empty/loading/error states, responsive at 1024/1280/1920 | **Partial** (no Learning Studio yet; contrast not measured with a tool) | `src/renderer/styles/tokens.css`, `app.css` | `e2e/app.e2e.ts` M2-AC6/7/9, screenshots artifact |
| FR-SEC-004 Auditability | Project and run changes, settings changes, schema migrations; append-only via triggers | **Partial** (approvals, tool/config changes, connections, deployments not yet produced) | `src/core/workspace.ts` | `test/workspace.test.ts` AC6 |
| FR-BUILD-002 Test-driven verification | Test suite + CI on Linux and Windows | **Verified** for M1 scope | `.github/workflows/ci.yml` | 24/24 pass locally (Linux, Node 22.22) and in CI on ubuntu-latest and windows-latest (Node 22.18), PR #1 |
| FR-TOOL-001 Tool inventory and installation scope | Plugins (with marketplace, version, scope, enabled state), marketplaces, skills, commands, subagents, hooks and MCP servers across managed, user, project, local and plugin scopes; provenance; supported removal method described (not run); unknowns kept unknown; nothing marked app-managed | **Verified** against a fixture setup (Linux). Not yet run against a real Windows Claude Code install. Dependencies and permissions recorded only where the files state them (plugin → components, skill `allowed-tools`, agent `tools`) | `src/core/inventory.ts` | `test/inventory.test.ts` M4-AC1/2/3/5, `test/cli.test.ts`, `e2e/app.e2e.ts` M4 |
| FR-TOOL-002 Conflict and duplication detection | Duplicate slash names, duplicate subagents, same-name across plugin namespaces (overlap), duplicate MCP names and duplicate MCP servers, duplicate and overlapping hooks, enabled-but-missing plugins, missing plugin files, version mismatches, plugin name clashes across marketplaces, unparseable config; evidence vs inference; severity classes | **Partial**: MCP tool-name collisions and workflow dependencies are not checked (servers are not started; no workflows use tools yet), and release-blocking is never raised yet. Both gaps are shown in the report | `src/core/conflicts.ts` | `test/inventory.test.ts` M4-AC4 |
| All other FRs | — | Planned | — | See `IMPLEMENTATION_ASSESSMENT.md` §6 |

## Milestone M1 acceptance criteria

| AC | Status | Evidence |
|---|---|---|
| M1-AC1 stable ID, workspace, status, designs folder | Verified | `workspace.test.ts`, `cli.test.ts` |
| M1-AC2 confirmed vs assumptions | Verified | `workspace.test.ts`, `cli.test.ts` (`project show`) |
| M1-AC3 survives restart | Verified | `workspace.test.ts` reopen; `cli.test.ts` separate processes |
| M1-AC4 explicit state model, invalid moves rejected | Verified | `workflow.test.ts`, `workspace.test.ts` |
| M1-AC5 blocked runs explain blocker and fix | Verified | `workflow.test.ts`, `cli.test.ts` |
| M1-AC6 audited, append-only | Verified | `workspace.test.ts` |
| M1-AC7 corrupt state recoverable, not overwritten | Verified | `workspace.test.ts`, `cli.test.ts` |
| M1-AC8 secret redaction | Verified for listed formats | `redact.test.ts`, raw DB scan |
| M1-AC9 documented, overridable data location | Verified | `paths.test.ts`, `OPERATIONS.md` |
| M1-AC10 type check + tests pass | Verified (Linux local, CI Linux + Windows) | `npm run check`, PR #1 CI |

## Milestone M2 acceptance criteria

| AC | Criterion | Status | Evidence |
|---|---|---|---|
| M2-AC1 | Installer builds; silent install launches and opens a healthy workspace; uninstall keeps user data | Verified (CI, windows-latest) | `installer` job, PR #2 |
| M2-AC2 | Shell: persistent nav rail (Project Layer, Iterative Layer, Settings), header with breadcrumbs, work surface, context panel | Verified | e2e screenshots |
| M2-AC3 | Create, list and open projects in the UI; data survives app restart | Verified | `app.e2e.ts` test 1 |
| M2-AC4 | Runs offer only allowed next steps; blocking needs reason + resolution (enforced server-side); blocked runs show how to resolve | Verified | `app.e2e.ts` test 1 |
| M2-AC5 | Corrupt database → recovery screen; nothing changes until confirmed; damaged file kept | Verified | `app.e2e.ts` test 3, `service.test.ts` |
| M2-AC6 | Shared design tokens; dark, light, system themes; preference persisted and audited | Verified | `app.e2e.ts` test 2, `workspace.test.ts` |
| M2-AC7 | Keyboard: skip link, tab order, visible focus; reduced motion respected (durations → 0) | Verified for tested paths (no screen-reader test) | `app.e2e.ts` test 5, `tokens.css` |
| M2-AC8 | Renderer isolation and IPC validation | Verified | `app.e2e.ts` test 4, `service.test.ts` |
| M2-AC9 | No horizontal overflow at 1024×768, 1280×800, 1920×1080; context panel hides below 1060 px (icon rail always shown, DEC-015) | Verified | `app.e2e.ts` test 5 |
| M2-AC10 | CI runs type check, unit tests (Linux + Windows), e2e (Linux), installer (Windows) | Verified, all green | PR #2 CI |

## UI refresh: frosted glass (DEC-015)

| Criterion | Status | Evidence |
|---|---|---|
| Glass surfaces in dark and light themes; layouts still fit 1024, 1280, 1920 px | Verified | `app.e2e.ts` tests 1, 2, 5 and their screenshots |
| *Surfaces* setting (Frosted glass / Solid panels) validated, persisted, audited; solid removes the blur | Verified | `workspace.test.ts`, `app.e2e.ts` test 2 |
| Context panel: project explorer (search, select, current marked), Activity filtered by project | Verified (explorer); filter implemented, covered by `listEvents` unit tests | `app.e2e.ts` test 1 |
| Reduced transparency (OS setting) falls back to solid panels | Implemented, not automatically tested | `tokens.css` media query |

## Milestone M4 acceptance criteria (read-only tool inventory)

| AC | Criterion | Status | Evidence |
|---|---|---|---|
| M4-AC1 | Inventory of plugins, marketplaces, skills, commands, subagents, hooks, MCP servers with scope, provenance, version and status; unknowns not guessed | Verified (fixture) | `inventory.test.ts` |
| M4-AC2 | No credentials in scan output, storage or UI (env and header values, URL queries, account data) | Verified (canary values) | `inventory.test.ts`, `cli.test.ts`, `e2e/app.e2e.ts` M4 |
| M4-AC3 | The scan changes nothing on disk outside the app's database | Verified (tree hash before and after) | `inventory.test.ts` |
| M4-AC4 | Conflicts classified with evidence; harmless overlap is not reported as an error; no destructive suggestions | Verified (fixture) | `inventory.test.ts` |
| M4-AC5 | An empty or missing Claude Code setup scans cleanly | Verified | `inventory.test.ts` |
| M4-AC6 | Scans stored redacted, audited, pruned to 20; the renderer cannot choose what is scanned | Verified | `inventory.test.ts`, `service.ts` |
| M4-AC7 | Tools screen: scan, findings, filter by kind, entry details; scan persists across navigation | Verified | `e2e/app.e2e.ts` M4, screenshots |
| M4-AC8 | Works on joshua's real Windows setup | **Not verified yet**: needs a run on that machine | — |

## Milestone M3 acceptance criteria (main agent, simulated model)

| AC | Criterion | Status | Evidence |
|---|---|---|---|
| M3-AC1 | Strategy chosen by rules and recorded with its rationale; single agent preferred when delegation adds nothing | Verified | `orchestrator.test.ts` (single, subagents, team, conflicting writes, high risk, unaffordable team) |
| M3-AC2 | Each delegated task has a goal, output contract, tool allow-list and timeout | Verified | `orchestrator.test.ts`, `workspace.ts` `AgentTaskSpec` |
| M3-AC3 | Sequential tasks run in dependency order; independent tasks run in parallel; a failed task cancels its dependents | Verified | `orchestrator.test.ts` |
| M3-AC4 | Failures, timeouts, denied tools and budget stops are never reported as success; the request succeeds only if every subtask succeeded | Verified | `orchestrator.test.ts` |
| M3-AC5 | No billable call without a budget; a call that would exceed the budget is blocked with a resolution; spend ledger is append-only | Verified (with a billable test double) | `orchestrator.test.ts` |
| M3-AC6 | The model's plan is validated as untrusted input; the renderer cannot grant tools | Verified | `orchestrator.test.ts`, `service.test.ts` |
| M3-AC7 | Agent works only on a started run; tasks and strategy are audited | Verified | `orchestrator.test.ts`, `cli.test.ts` |
| M3-AC8 | UI and CLI label simulated output; budget is set in Settings | Verified | `e2e/app.e2e.ts` M3, screenshot `11-agent-simulated-dark-1280` |
| M3-AC9 | Real Claude calls under the budget (DEC-018): budget + key required, key encrypted and never returned or logged, cost checked before each call including calls in flight, cut-off and declined answers fail but are counted | **Verified against a fake Claude client.** No real call has been made yet: needs joshua's key on his machine | `claude.test.ts`, `e2e/app.e2e.ts` M3 (AI usage settings) |
