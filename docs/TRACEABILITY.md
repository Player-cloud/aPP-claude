# Requirements Traceability

Status legend: **Verified** (implemented, automated tests pass) · **Implemented, not fully verified** · **Partial** · **Planned** · **Blocked** · **Not required**.
"Verified" here means verified for the stated scope only, with the evidence listed.

| Requirement | Scope covered so far | Status | Code | Tests / evidence |
|---|---|---|---|---|
| FR-APP-001 Installable application | Windows NSIS installer; silent install → launch → health check → uninstall keeps data; OS + data locations documented | **Verified** for Windows x64 per-user install (CI `installer` job, PR #2). Auto-update and code signing not started. On joshua's Windows 11 laptop (2026-10-28) the 0.8.0 installer built (117 MB, unsigned) and the unpacked app passed `--smoke-test`; the installer itself has not been run there yet. | `electron-builder.yml`, `src/main/main.ts` (`--smoke-test`), `docs/OPERATIONS.md` | CI job `installer` (windows-latest) |
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
| FR-TOOL-001 Tool inventory and installation scope | Plugins (with marketplace, version, scope, enabled state), marketplaces, skills, commands, subagents, hooks and MCP servers across managed, user, project, local and plugin scopes; provenance; supported removal method described (not run); unknowns kept unknown; nothing marked app-managed | **Verified** against a fixture setup (Linux), and run read-only against joshua's real Windows Claude Code setup (2026-10-28: 27 entries, nothing changed). That run showed hooks a plugin registers from code (a hooks.json `modules` list) and plugins the Claude desktop app supplies are not readable; both are now reported as not checked instead of silently missing. Dependencies and permissions recorded only where the files state them (plugin → components, skill `allowed-tools`, agent `tools`) | `src/core/inventory.ts` | `test/inventory.test.ts` M4-AC1/2/3/5, `test/cli.test.ts`, `e2e/app.e2e.ts` M4 |
| FR-TOOL-002 Conflict and duplication detection | Duplicate slash names, duplicate subagents, same-name across plugin namespaces (overlap), duplicate MCP names and duplicate MCP servers, duplicate and overlapping hooks, enabled-but-missing plugins, missing plugin files, version mismatches, plugin name clashes across marketplaces, unparseable config; evidence vs inference; severity classes | **Partial**: MCP tool-name collisions and workflow dependencies are not checked (servers are not started; no workflows use tools yet), and release-blocking is never raised yet. Both gaps are shown in the report | `src/core/conflicts.ts` | `test/inventory.test.ts` M4-AC4 |
| FR-PLAN-001 Concept brief and design specification | Idea + facts → concept brief (goals, users, use cases, scope, non-goals, confirmed facts, assumptions, dependencies, risks, success criteria) → specification with stable requirement IDs, priorities and acceptance criteria; drafts edited and approved by the person; versions kept in `docs/designs/`; revisions need a change note and record a diff; the spec is flagged when the brief changes after it | **Verified** with the simulated drafter (DEC-019). Claude drafts are tested against a fake client only; no real call has been made, so real draft quality is unverified | `src/core/planning.ts`, `src/core/planner.ts`, `src/core/workspace.ts`, `src/renderer/views/PlanningPanel.tsx` | `test/planning.test.ts`, `test/claude.test.ts` M5, `test/service.test.ts` M5, `test/cli.test.ts` M5, `e2e/app.e2e.ts` M5 |
| FR-PLAN-002 EGM integration | EGM is looked for in the latest tool scan and its state shown (not checked, not found, found but unverified); the native workflow is used in every case | **Partial**: no EGM adapter, because EGM's commands are unverified. Nothing claims an EGM step ran | `src/core/planner.ts` (`egmStatus`) | `test/planning.test.ts` FR-PLAN-002 |
| FR-BUILD-001 Specification-driven feature implementation | A feature names requirement IDs from the approved spec (checked), the components it should touch, and its check commands; the agent gets the requirements with their acceptance criteria and is told to inspect code and tests first; the diff, changed files and unresolved risks are reported in the app and in `docs/builds/<id>.md` | **Implemented**: verified with a scripted agent and by hand-made changes. Real Claude implementation is untested (no API key yet) | `src/core/build/` | `test/build.test.ts`, `test/service.test.ts` M6, `test/cli.test.ts` M6, `e2e/app.e2e.ts` M6 |
| FR-BUILD-002 Test-driven verification | Checks run before and after the change and when the agent asks; results (passed, failed, timed out, could not run, not run) are stored append-only with exit code and output; the review flags regressions, still-failing checks, skipped, narrowed or deleted tests, and changes without tests | **Verified** for the stated scope. Test selection is the person's (they choose the checks); the app does not pick tests by change type yet | `src/core/build/checks.ts`, `review.ts` | `test/build.test.ts` |
| FR-BUILD-003 Bug-fixing workflow | Reproduction steps required; the baseline run shows whether a check reproduces the bug; the agent is told to find the root cause, add a regression test, then fix; a fix without a test change or a bug that no check reproduced is flagged | **Implemented**, verified with a scripted agent. Root-cause evidence is the agent's summary plus the before/after checks | `src/core/build/builder.ts` | `test/build.test.ts` M6-AC1, `e2e/app.e2e.ts` M6 |
| FR-QA-001 Specification drift | Each MUST/SHOULD/COULD requirement in the approved spec is compared with the completed features that name it and their last verification; findings name the requirement, what was observed and the builds as evidence, and are classed as defect, missing requirement, optional improvement, or (by the person only) intentional deviation or spec change | **Partial**: drift is coverage by recorded work, not an analysis of the code itself, and acceptance criteria are not checked one by one | `src/core/release/gates.ts` (`driftGate`), `releaser.ts` (`classify`) | `test/release.test.ts` M7-AC1/AC3, gate rules |
| FR-QA-004 Quality gate | Critical review findings (regressions, weakened or deleted tests), failing or missing release checks, credentials in tracked files, unfinished, unverified or unmerged work, missing spec and significant drift block preparation; an exception needs a reason and a mitigation, is append-only and audited | **Verified** for the gates listed. Security findings come only from the credential scan; no security review tool runs yet | `src/core/release/` | `test/release.test.ts`, `test/service.test.ts` M7, `test/cli.test.ts` M7, `e2e/app.e2e.ts` M7 |
| FR-SHIP-001 Security + Ship | Ship-check over spec and review evidence, release test results on the exact commit, configuration names, credentials, migrations, target, health check, monitoring and rollback; preparing is separate from deploying (nothing is deployed, tagged or pushed) | **Partial**: `code-review` and `security-review` are not run, because no installed command has been verified (the gate says Skipped and names any found in the tool scan). The plan is recorded, not tested | `src/core/release/releaser.ts` | `test/release.test.ts` M7-AC1/AC2/AC4 |
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

## Milestone M5 acceptance criteria (planning)

| AC | Criterion | Status | Evidence |
|---|---|---|---|
| M5-AC1 | A brief is drafted from the project's idea and facts; a simulated draft is labelled and keeps placeholders that block approval | Verified | `planning.test.ts` M5-AC1, `e2e/app.e2e.ts` M5, screenshot `13-planning-brief-draft-dark-1280` |
| M5-AC2 | Confirmed facts come only from the person; the model's guesses stay assumptions | Verified | `planning.test.ts` M5-AC2, `service.test.ts` M5 |
| M5-AC3 | The spec is drafted from the approved brief, with app-assigned stable requirement IDs and acceptance criteria, and saved under `docs/designs/` | Verified | `planning.test.ts` M5-AC3, `e2e/app.e2e.ts` M5 (reads `brief.md`, `spec.md`, `versions/brief-v1.md`) |
| M5-AC4 | An approved version never changes; a revision needs a change note, records what changed, and versions can be compared | Verified | `planning.test.ts` M5-AC4, `cli.test.ts` M5, screenshot `14-planning-approved-dark-1280` |
| M5-AC5 | Model output is validated and redacted; a failed, blocked or invalid model call saves nothing | Verified | `planning.test.ts` |
| M5-AC6 | EGM availability comes from the tool scan and no EGM step is ever reported as run | Verified for detection; no adapter (FR-PLAN-002 partial) | `planning.test.ts` FR-PLAN-002 |

## Milestone M6 acceptance criteria (build and fix workflows)

| AC | Criterion | Status | Evidence |
|---|---|---|---|
| M6-AC1 | A known failing check is reproduced, fixed with a regression test, and passes, in a worktree that leaves the person's checkout unchanged | Verified with a scripted agent | `build.test.ts` M6-AC1 |
| M6-AC2 | A feature needs an approved spec, known requirement IDs and at least one check; the task and checks are fixed once work starts | Verified | `build.test.ts` M6-AC2 |
| M6-AC3 | Test results are real and distinguish passed, failed, timed out, could not run and not run; results are append-only | Verified | `build.test.ts` (checks, append-only) |
| M6-AC4 | Unrelated files, weakened or deleted tests, regressions and missing tests are reported; remaining risks need an explanation before the work is done | Verified | `build.test.ts` review tests, `e2e/app.e2e.ts` M6, screenshot `15-build-review-dark-1280` |
| M6-AC5 | The agent cannot leave the worktree, run anything but approved checks, or exceed the monthly budget or its per-run cap | Verified | `build.test.ts` (agent limits), `claude.test.ts` M6 |
| M6-AC6 | Check commands run only after approval outside the renderer (native dialog, or `--confirm` in the CLI) | Verified | `service.test.ts` M6, `cli.test.ts` M6, `e2e/app.e2e.ts` M6 |
| M6-AC7 | A sample feature planned, implemented by Claude, tested, reviewed and reported (roadmap Phase 4 exit) | **Not verified**: needs a real API key; the simulated agent does not write code | — |

## Milestone M7 acceptance criteria (quality gate and ship-check)

| AC | Criterion | Status | Evidence |
|---|---|---|---|
| M7-AC1 | Finished, merged and verified work with a plan passes every required gate on the checked commit and is prepared; nothing is deployed, tagged or pushed | Verified | `release.test.ts` M7-AC1, `e2e/app.e2e.ts` M7, screenshot `17-release-prepared-dark-1280` |
| M7-AC2 | Deliberate defects fail their gates: failing tests, missing plan, a credential in a tracked file (reported by place only), no spec, no included work, unmerged work | Verified | `release.test.ts` M7-AC1/AC2, screenshot `16-ship-check-blocked-dark-1280` |
| M7-AC3 | An exception needs a reason and a mitigation, unblocks only its gate, and cannot be changed or deleted; only the person classifies drift as deliberate or a spec change | Verified | `release.test.ts` M7-AC3, `service.test.ts` M7, `cli.test.ts` M7 |
| M7-AC4 | The ship-check runs only after approval, on a known commit, in a worktree that checks cannot use to change the person's repository or hide a credential; preparing refuses once the repository has moved on | Verified | `release.test.ts` M7-AC4, `service.test.ts` M7, `e2e/app.e2e.ts` M7 |
| M7-AC5 | Installed code-review and security-review commands are verified and run as part of the ship-check | **Not done**: no command is verified yet, so the gate is optional and shows Skipped | — |
