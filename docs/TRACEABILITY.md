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
| FR-PROJ-002 Import an existing project | An existing git repository is registered as a project by its location; the read-only assessment covers structure, stack, dependencies, tests, configuration and documentation at the current commit from git's object store, lists what was and was not inspected with evidence, and checks the repository is unchanged afterwards | **Verified** for local git repositories. Write access is only ever asked for by later build work (DEC-020); no external connection exists to ask for | `src/core/assess/` (`assessor.ts`, `snapshot.ts`), `src/renderer/views/AssessmentPanel.tsx`, `ProjectsView.tsx` | `test/assess.test.ts` M8-AC1/AC2, `e2e/app.e2e.ts` M8 |
| FR-PROJ-003 Focused assessment | Codebase-only, one-category and one-capability scopes; the scope is stored before anything is read; the report holds only in-scope findings and discloses what else was read to interpret them; a full assessment can follow | **Verified** | `src/core/assess/assessor.ts` (`parseScope`, `capabilitiesIn`) | `test/assess.test.ts` M8-AC4, screenshot `19-assessment-focused-dark-1280` |
| FR-PROJ-004 Enterprise capability assessment | All 29 capabilities in the four categories get implemented in code, partly present, not verified, missing or not applicable, each with evidence, confidence, impact and next action; names in code or docs never count as a connected service; the report says it is not a certification | **Partial**: *configured externally* needs connector evidence and is never assigned yet (FR-PROJ-005 waits for a provider choice); statuses come from patterns, so they show where to look rather than proof | `src/core/assess/capabilities.ts` | `test/assess.test.ts` M8-AC3, screenshot `18-assessment-full-dark-1280` |
| FR-SEC-002 Secrets protection | Redaction of keys and known token formats before storage | **Partial** (safety net only; credential store planned) | `src/core/redact.ts` | `test/redact.test.ts`, raw-DB scan in `test/workspace.test.ts` AC8 |
| FR-SEC-001 Least-privilege tools | Renderer sandboxed (context isolation, no Node), strict CSP, navigation and new windows blocked, permission requests denied, IPC caller checked | **Partial** (applies to the UI; no tools or integrations exist yet) | `src/main/main.ts`, `src/preload/preload.ts`, `src/renderer/index.html` | `e2e/app.e2e.ts` M2-AC8 |
| FR-SEC-005 Untrusted input | All renderer input validated in the main process; internal errors not leaked; imported repositories are read as data only (no hooks, no code run, no model sees them) | **Partial** (build checks still run code the person approves, without a sandbox) | `src/main/service.ts` | `test/service.test.ts`, `e2e/app.e2e.ts` |
| FR-DESIGN-001 Learning Studio | Images and short videos imported (checked by content), previewed, tagged, searched, grouped and linked to a project; Claude proposes a kind, tags and explanation that the person accepts or corrects; a reference never changes a spec | **Verified** with the simulated model; a real Claude suggestion is tested with a fake billable model only, not yet with joshua's key | `src/core/studio/` (`library.ts`, `media.ts`), `src/main/references.ts`, `src/renderer/views/LearningStudioView.tsx` | `test/studio.test.ts`, `e2e/app.e2e.ts` M9, screenshots `20-learning-studio-library-dark-1280`, `21-learning-studio-reference-dark-1280` |
| FR-DESIGN-002 UI refinement | A "Polish the UI" build audits tokens, components, libraries, breakpoints and themes before any change; the agent is told to keep to them and to check responsive layout, accessibility and states; the review flags new UI libraries, raw colours and accessibility slips, and a manual check makes the person confirm what they looked at | **Verified** with the simulated agent and hand-made changes; real Claude polishing untested; pattern checks see only the diff | `src/core/design/` (`audit.ts`, `review.ts`), `src/core/build/builder.ts`, `src/renderer/views/BuildPanel.tsx` | `test/polish.test.ts`, `e2e/app.e2e.ts` M9 polish, screenshot `22-ui-polish-review-dark-1280` |
| FR-DESIGN-003 Animation quality | With "Animation is part of this work", the agent must state purpose, properties, timing/easing and exit for each animation and respect reduced motion; without it, no motion; the review flags animation without reduced-motion handling and animated layout properties; audit → plan → change → review are separate steps | **Partial**: performance is judged from the properties used, not measured | `src/core/design/review.ts`, `builder.ts` (`polishInstructions`) | `test/polish.test.ts` |
| FR-DESIGN-004 Application visual system | Shared tokens, nav rail / header / work surface / context panel, dark + light + system themes, focus, empty/loading/error states, responsive at 1024/1280/1920 | **Partial** (contrast not measured with a tool) | `src/renderer/styles/tokens.css`, `app.css` | `e2e/app.e2e.ts` M2-AC6/7/9, screenshots artifact |
| FR-SEC-004 Auditability | Project and run changes, settings changes, schema migrations; append-only via triggers | **Partial** (approvals, tool/config changes, connections, deployments not yet produced) | `src/core/workspace.ts` | `test/workspace.test.ts` AC6 |
| FR-BUILD-002 Test-driven verification | Test suite + CI on Linux and Windows | **Verified** for M1 scope | `.github/workflows/ci.yml` | 24/24 pass locally (Linux, Node 22.22) and in CI on ubuntu-latest and windows-latest (Node 22.18), PR #1 |
| FR-TOOL-001 Tool inventory and installation scope | Plugins (with marketplace, version, scope, enabled state), marketplaces, skills, commands, subagents, hooks and MCP servers across managed, user, project, local and plugin scopes; provenance; supported removal method described (not run); unknowns kept unknown; nothing marked app-managed | **Verified** against a fixture setup (Linux), and run read-only against joshua's real Windows Claude Code setup (2026-10-28: 27 entries, nothing changed). That run showed hooks a plugin registers from code (a hooks.json `modules` list) and plugins the Claude desktop app supplies are not readable; both are now reported as not checked instead of silently missing. Dependencies and permissions recorded only where the files state them (plugin → components, skill `allowed-tools`, agent `tools`) | `src/core/inventory.ts` | `test/inventory.test.ts` M4-AC1/2/3/5, `test/cli.test.ts`, `e2e/app.e2e.ts` M4 |
| FR-TOOL-002 Conflict and duplication detection | Duplicate slash names, duplicate subagents, same-name across plugin namespaces (overlap), duplicate MCP names and duplicate MCP servers, duplicate and overlapping hooks, enabled-but-missing plugins, missing plugin files, version mismatches, plugin name clashes across marketplaces, unparseable config; evidence vs inference; severity classes | **Partial**: MCP tool-name collisions and workflow dependencies are not checked (servers are not started; no workflows use tools yet), and release-blocking is never raised yet. Both gaps are shown in the report | `src/core/conflicts.ts` | `test/inventory.test.ts` M4-AC4 |
| FR-TOOL-003 Remediation and dry run | Options in the order keep, configure, disable, replace, uninstall, each with why it is not offered; a dry run with the exact command or move, targets, dependents, affected workflows, effects, risks and recovery; dependents must be accepted before running | **Verified** with a stand-in `claude` | `src/core/cleanup/cleanup.ts`, `src/renderer/views/CleanupPanel.tsx` | `test/cleanup.test.ts`, `e2e/app.e2e.ts` M11 |
| FR-TOOL-004 Scoped, approved uninstallation | Native approval dialog or `--confirm`; Claude Code's own `plugin disable/uninstall` and `mcp remove` with the exact scope; exact-path moves for personal and project skills, commands and subagents; managed, plugin-owned, hook, marketplace and unclear targets get manual steps; no shell, wildcard or name-only deletion | **Verified** with a stand-in `claude`; **not yet run against a real Claude Code** | `src/core/cleanup/cleanup.ts`, `src/main/main.ts` | `test/cleanup.test.ts`, `e2e/app.e2e.ts` M11 |
| FR-TOOL-005 Backup, audit and recovery | MCP definitions kept without secrets, moved files kept in the app's data folder; approval, target, reason, command, result and recovery in the audit log; rescan after every change; failed and partial recorded as such with next steps; restore for moves and plugins | **Verified** for the listed scope. "Testing affected workflows" is the rescan, since no app workflow runs a tool yet | `src/core/cleanup/cleanup.ts`, `src/core/workspace.ts` (migration 12) | `test/cleanup.test.ts` |
| FR-PLAN-001 Concept brief and design specification | Idea + facts → concept brief (goals, users, use cases, scope, non-goals, confirmed facts, assumptions, dependencies, risks, success criteria) → specification with stable requirement IDs, priorities and acceptance criteria; drafts edited and approved by the person; versions kept in `docs/designs/`; revisions need a change note and record a diff; the spec is flagged when the brief changes after it | **Verified** with the simulated drafter (DEC-019). Claude drafts are tested against a fake client only; no real call has been made, so real draft quality is unverified | `src/core/planning.ts`, `src/core/planner.ts`, `src/core/workspace.ts`, `src/renderer/views/PlanningPanel.tsx` | `test/planning.test.ts`, `test/claude.test.ts` M5, `test/service.test.ts` M5, `test/cli.test.ts` M5, `e2e/app.e2e.ts` M5 |
| FR-PLAN-002 EGM integration | EGM is looked for in the latest tool scan and its state shown (not checked, not found, found but unverified); the native workflow is used in every case | **Partial**: no EGM adapter, because EGM's commands are unverified. Nothing claims an EGM step ran | `src/core/planner.ts` (`egmStatus`) | `test/planning.test.ts` FR-PLAN-002 |
| FR-BUILD-001 Specification-driven feature implementation | A feature names requirement IDs from the approved spec (checked), the components it should touch, and its check commands; the agent gets the requirements with their acceptance criteria and is told to inspect code and tests first; the diff, changed files and unresolved risks are reported in the app and in `docs/builds/<id>.md` | **Implemented**: verified with a scripted agent and by hand-made changes, and once with real Claude on joshua's PC (M6-AC7) | `src/core/build/` | `test/build.test.ts`, `test/service.test.ts` M6, `test/cli.test.ts` M6, `e2e/app.e2e.ts` M6 |
| FR-BUILD-002 Test-driven verification | Checks run before and after the change and when the agent asks; results (passed, failed, timed out, could not run, not run) are stored append-only with exit code and output; the review flags regressions, still-failing checks, checks that pass without finding any tests, skipped, narrowed or deleted tests, and changes without tests | **Verified** for the stated scope. Test selection is the person's (they choose the checks); the app does not pick tests by change type yet | `src/core/build/checks.ts`, `review.ts` | `test/build.test.ts` |
| FR-BUILD-003 Bug-fixing workflow | Reproduction steps required; the baseline run shows whether a check reproduces the bug; the agent is told to find the root cause, add a regression test, then fix; a fix without a test change or a bug that no check reproduced is flagged | **Implemented**, verified with a scripted agent. Root-cause evidence is the agent's summary plus the before/after checks | `src/core/build/builder.ts` | `test/build.test.ts` M6-AC1, `e2e/app.e2e.ts` M6 |
| FR-QA-001 Specification drift | Each MUST/SHOULD/COULD requirement in the approved spec is compared with the completed features that name it and their last verification; findings name the requirement, what was observed and the builds as evidence, and are classed as defect, missing requirement, optional improvement, or (by the person only) intentional deviation or spec change | **Partial**: drift is coverage by recorded work, not an analysis of the code itself, and acceptance criteria are not checked one by one | `src/core/release/gates.ts` (`driftGate`), `releaser.ts` (`classify`) | `test/release.test.ts` M7-AC1/AC3, gate rules |
| FR-QA-004 Quality gate | Critical review findings (regressions, weakened or deleted tests), failing or missing release checks, credentials in tracked files, unfinished, unverified or unmerged work, missing spec and significant drift block preparation; an exception needs a reason and a mitigation, is append-only and audited | **Verified** for the gates listed. Security findings come only from the credential scan; no security review tool runs yet | `src/core/release/` | `test/release.test.ts`, `test/service.test.ts` M7, `test/cli.test.ts` M7, `e2e/app.e2e.ts` M7 |
| FR-SHIP-001 Security + Ship | Ship-check over spec and review evidence, release test results on the exact commit, configuration names, credentials, migrations, target, health check, monitoring and rollback; preparing is separate from deploying (nothing is deployed, tagged or pushed) | **Partial**: `code-review` and `security-review` are not run, because no installed command has been verified (the gate says Skipped and names any found in the tool scan). The plan is recorded, not tested | `src/core/release/releaser.ts` | `test/release.test.ts` M7-AC1/AC2/AC4 |
| FR-ITER-001 Application self-assessment | Runs, agent tasks, builds, check runs, assessments, the latest tool scan and spend are read; each finding has an observation with linked records, an inference with confidence and a recommendation; telemetry gaps are listed; findings are deduplicated by signature onto existing items | **Partial**: no error log, timings, resource use or integrations exist to analyse, and they are listed as gaps | `src/core/iterate/assess.ts`, `src/core/iterate/backlog.ts` | `test/iterate.test.ts`, `e2e/app.e2e.ts` M10 |
| FR-ITER-002 Improvement backlog | Items with problem, evidence, expected outcome, success criteria, priority, risk, dependencies, status, approver, result and measured outcome; idea, proposed, approved, in progress, blocked, verified, released and rejected with checked moves; never deleted, duplicates merged | **Verified** | `src/core/iterate/backlog.ts`, `src/core/workspace.ts` (migration 11), `src/renderer/views/IterativeView.tsx` | `test/iterate.test.ts`, `e2e/app.e2e.ts` M10 |
| FR-ITER-003 Safe self-improvement | A platform-maintenance project for the app's own source; approved improvements and app library, runtime or model updates become bounded builds in worktrees with mandatory checks; protected areas need a separate approval; failed evaluations block completion and release with no override or exception; known-good versions, a database backup with a recovery drill and restore; outcomes measured after release, reopening the item when the problem comes back | **Partial**: not yet run on joshua's PC against the real source; the app does not build or install the new version (the person does); measurement uses only what the self-assessment records | `src/core/maintain/maintain.ts`, `src/core/build/builder.ts`, `src/core/release/gates.ts`, `src/core/release/releaser.ts`, `src/core/iterate/backlog.ts`, `src/core/workspace.ts` (migration 14), `src/renderer/views/PlatformView.tsx` | `test/maintain.test.ts`, `e2e/app.e2e.ts` M13, screenshots `29-platform-build-dark-1280`, `30-platform-dark-1280` |
| FR-ITER-004 External ecosystem monitoring | npm registry (newest version, deprecation), npm security advisories, Claude Code and Anthropic SDK release notes, GitHub-hosted plugin marketplaces and, with a stored key, the Anthropic model list; source, detection time, versions, quoted summary, affected workflows and tests, priority, confidence, recommendation, approval, installation and verification are recorded per item; unreachable and stale sources are listed | **Partial**: MCP servers and standalone skills have no trusted version source; evaluation in isolation is documented steps, not an environment the app runs; checks are manual only | `src/core/updates/updates.ts`, `src/core/workspace.ts` (migration 13), `src/renderer/views/UpdatesView.tsx` | `test/updates.test.ts`, `e2e/app.e2e.ts` M12, screenshots `27-updates-found-dark-1280`, `28-updates-verified-dark-1280` |
| FR-LEARN-001 Approved preferences | Feedback becomes a preference only after the proposed wording is approved; entries have scope (all work or one project), source with the original words, and can be edited and removed (kept in the history); likely duplicates and conflicts with active preferences are shown and need the person's decision; active preferences guide the build agent | **Verified** for the stated scope. Duplicate and conflict detection compares words, so a contradiction in different words can be missed | `src/core/learn/preferences.ts`, `src/core/workspace.ts` (migration 15), `src/core/build/builder.ts`, `src/renderer/views/PreferencesView.tsx` | `test/learn.test.ts` M14-AC1 to AC5, `e2e/app.e2e.ts` M14, screenshot `31-preferences-duplicate-dark-1280` |
| FR-LEARN-004 Session wrap-up | Decisions, progress, blockers, next steps and assumptions for a period, from the app's records; confirmed decisions separate from assumptions and inferred next steps; saved to the Vault inbox only when asked; a saved summary is a note and a line becomes a preference only through an approved proposal | **Verified** for the app's own records. Work done outside the app (for example in Claude Code directly) is not in the records, so it is not summarised | `src/core/learn/vault.ts`, `src/renderer/views/PreferencesView.tsx` | `test/learn.test.ts` M14-AC6/AC7, `e2e/app.e2e.ts` M14, screenshot `32-wrap-up-dark-1280` |
| FR-LEARN-002 Learning from source material | Lessons from transcripts (.vtt, .srt, timed .txt), notes and PDFs, each linked to the passages, times or pages it cites; suggestions kept in their own section as the model's recommendations; reading a source changes nothing else, and a suggestion becomes a proposed preference or an improvement idea only when the person chooses | **Verified** with a stand-in for the Claude API and with the simulated model. Not yet run against the real API on joshua's PC (M14-AC18). Videos are not watched: the person imports the transcript | `src/core/learn/sources.ts`, `src/core/learn/lessons.ts`, `src/core/agents/claude.ts` (citations), `src/core/workspace.ts` (migration 16), `src/renderer/views/LearnTabs.tsx` | `test/lessons.test.ts` M14-AC10 to AC13, `e2e/app.e2e.ts` M14 lessons, screenshot `33-lessons-dark-1280` |
| FR-LEARN-003 Reusable skill proposals | Work done three or more times in a similar way becomes a proposal with examples, trigger, steps, permissions, tests and expected benefit; existing skills and commands in the tool scan are checked and each likely duplicate needs the person's decision before approval; an approved proposal is exported as a SKILL.md file and never installed | **Verified** for builds, runs and requests in the app's records. Grouping compares title words, so similar work worded differently can be missed | `src/core/learn/skills.ts`, `src/renderer/views/LearnTabs.tsx` | `test/lessons.test.ts` M14-AC14/AC15, `e2e/app.e2e.ts` M14 lessons, screenshot `34-skill-proposal-dark-1280` |
| Phase 12 optional add-ons (TOOL-DEV-001..006, TOOL-LEARN-001/002/003/008/009/010) | Each of the 12 is reviewed on its own for source, permissions, compatibility, cost and benefit, then included, excluded or deferred; include only when the tool scan finds it and all five are reviewed; the product works with every add-on off | **Verified** that the rules hold and the core works without them. No add-on has been reviewed on joshua's setup yet (M14-AC18) | `src/core/learn/addons.ts`, `src/renderer/views/LearnTabs.tsx` | `test/lessons.test.ts` M14-AC16/AC17, `e2e/app.e2e.ts` M14 lessons, screenshot `35-addons-dark-1280` |
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
| M6-AC7 | A sample feature planned, implemented by Claude, tested, reviewed and reported (roadmap Phase 4 exit) | **Verified once, by hand**: on joshua's Windows PC (2026-10-28) Claude (`claude-opus-5-5`) implemented REQ-043 of his "Club HR" spec in 6 tool calls for $0.19, writing `src/holiday.mjs` and 6 passing node:test tests; the review and report were produced. Not automated (it needs a key and costs money) | Screenshots and the build report shared in the project thread |

## Milestone M7 acceptance criteria (quality gate and ship-check)

| AC | Criterion | Status | Evidence |
|---|---|---|---|
| M7-AC1 | Finished, merged and verified work with a plan passes every required gate on the checked commit and is prepared; nothing is deployed, tagged or pushed | Verified | `release.test.ts` M7-AC1, `e2e/app.e2e.ts` M7, screenshot `17-release-prepared-dark-1280` |
| M7-AC2 | Deliberate defects fail their gates: failing tests, missing plan, a credential in a tracked file (reported by place only), no spec, no included work, unmerged work | Verified | `release.test.ts` M7-AC1/AC2, screenshot `16-ship-check-blocked-dark-1280` |
| M7-AC3 | An exception needs a reason and a mitigation, unblocks only its gate, and cannot be changed or deleted; only the person classifies drift as deliberate or a spec change | Verified | `release.test.ts` M7-AC3, `service.test.ts` M7, `cli.test.ts` M7 |
| M7-AC4 | The ship-check runs only after approval, on a known commit, in a worktree that checks cannot use to change the person's repository or hide a credential; preparing refuses once the repository has moved on | Verified | `release.test.ts` M7-AC4, `service.test.ts` M7, `e2e/app.e2e.ts` M7 |
| M7-AC5 | Installed code-review and security-review commands are verified and run as part of the ship-check | **Not done**: no command is verified yet, so the gate is optional and shows Skipped | — |

## Milestone M8 acceptance criteria (import and assessment)

| AC | Criterion | Status | Evidence |
|---|---|---|---|
| M8-AC1 | An existing git repository can be imported from the desktop app and the CLI; non-repositories and relative paths are refused; the repository's index, refs, status and worktrees are unchanged | Verified | `assess.test.ts` M8-AC1, `e2e/app.e2e.ts` M8 |
| M8-AC2 | A full assessment reports structure, stack, dependencies, tests (not run), configuration and documentation of the current commit, lists what was and was not inspected (including uncommitted changes), and confirms the repository is unchanged | Verified | `assess.test.ts` M8-AC2/AC3, screenshot `18-assessment-full-dark-1280` |
| M8-AC3 | Every capability has a status with evidence, confidence, impact and next action; configuration names or doc mentions alone never give *implemented*; provider-backed capabilities say "not verified" outside the code; committed credentials are reported by place only and never stored | Verified | `assess.test.ts` M8-AC2/AC3 |
| M8-AC4 | A focused assessment stores its scope before running, reports only that scope, discloses what else it read, and a full assessment can follow | Verified | `assess.test.ts` M8-AC4, `e2e/app.e2e.ts` M8, screenshot `19-assessment-focused-dark-1280` |
| M8-AC5 | External state (hosting, DNS, email, identity providers) is verified through an authorised connector | **Not done**: no connector yet (FR-PROJ-005 waits for a provider choice), so it is always "not verified" | — |
| M8-AC6 | Tried on a real repository on joshua's Windows PC | **Not done** | — |

## Milestone M9 acceptance criteria (Learning Studio, PR 1)

| AC | Criterion | Status | Evidence |
|---|---|---|---|
| M9-AC1 | References are imported from a native picker (desktop) or full paths (CLI); the type is checked from the content, SVG, renamed files, folders and links are refused, duplicates are skipped, and the originals are left unchanged | Verified | `studio.test.ts` (import, links), `e2e/app.e2e.ts` M9 |
| M9-AC2 | Images and videos are previewed from the app's own copy; only known ids are served, with byte ranges for video | Verified | `studio.test.ts` (service, byte ranges), `e2e/app.e2e.ts` M9 (unknown id not served) |
| M9-AC3 | References can be tagged, noted, searched, grouped by project, kind or tag, and linked to a project | Verified | `studio.test.ts`, `e2e/app.e2e.ts` M9, screenshot `20-learning-studio-library-dark-1280` |
| M9-AC4 | The model's suggestion is applied only when accepted and is marked corrected when the person changes it; real calls send the image under the budget, refuse videos and images over 5 MB, and drop invalid answers | Verified with simulated and fake billable models | `studio.test.ts` (suggestion, budget) , screenshot `21-learning-studio-reference-dark-1280` |
| M9-AC5 | A reference never changes a plan document, and is archived rather than deleted | Verified | `studio.test.ts` (archive, spec unchanged) |
| M9-AC6 | A real Claude suggestion on joshua's PC | **Not done** | — |

## Milestone M9 acceptance criteria (UI polish, PR 2)

| AC | Criterion | Status | Evidence |
|---|---|---|---|
| M9-AC7 | A "Polish the UI" build audits the design system when it starts (reading tracked files only), gives the agent the audit, the chosen references (as inspiration) and the design rules, reviews the change for design risks, and commits on its own branch without touching the checkout or any plan document | Verified | `polish.test.ts` M9-AC7, `e2e/app.e2e.ts` M9 polish |
| M9-AC8 | The review flags new UI or animation libraries, raw colours where tokens exist, missing alt text, clickable divs, positive tabindex, removed focus outlines, animation without reduced motion and animated layout properties; a clean change only gets the manual check | Verified | `polish.test.ts` (review), screenshot `22-ui-polish-review-dark-1280` |
| M9-AC9 | Existing builds and check results survive the table rebuild | Verified | `polish.test.ts` (version 9 database) |
| M9-AC10 | Real Claude polishing on joshua's PC, and visual comparison with reference images | **Not done** | — |

## Milestone M10 acceptance criteria (self-assessment and improvement backlog)

| AC | Criterion | Status | Evidence |
|---|---|---|---|
| M10-AC1 | A self-assessment reads the app's own records and shows each finding as an observation (with linked records), an inference (with confidence) and a recommendation, and lists the telemetry the app does not record | Verified | `iterate.test.ts` (three layers, empty app), `e2e/app.e2e.ts` M10, screenshot `23-improvements-self-assessment-dark-1280` |
| M10-AC2 | A finding becomes one proposed item; repeating it adds only new evidence to that item, also after a merge | Verified | `iterate.test.ts` (dedupe, merge) |
| M10-AC3 | Items move only along allowed paths; proposing needs an outcome and criteria, approving records the approver, blocking and rejecting need a reason, verifying needs a result, releasing needs a measured outcome, and work cannot start before dependencies are released | Verified | `iterate.test.ts` (statuses, dependencies), `e2e/app.e2e.ts` M10, screenshot `24-improvements-released-dark-1280` |
| M10-AC4 | Items and self-assessments are never deleted, and a self-assessment never changes | Verified | `iterate.test.ts` (triggers) |
| M10-AC5 | For detector items, recurrences after approval are counted from the latest self-assessment | Verified | `iterate.test.ts` (recurrence), `e2e/app.e2e.ts` M10 |
| M10-AC6 | Typed feedback becomes an idea; the same actions are in the CLI (`iap iter`) and validated at the service | Verified | `iterate.test.ts` (service and CLI) |
| M10-AC7 | Used on joshua's own records on his PC | **Not done** | — |

## Milestone M11 acceptance criteria (safe tool cleanup)

| AC | Criterion | Status | Evidence |
|---|---|---|---|
| M11-AC1 | Options run from least to most disruptive, and options that are unsafe or unsupported say why they are not offered | Verified | `cleanup.test.ts` (options), `e2e/app.e2e.ts` M11 |
| M11-AC2 | A dry run lists the exact command or move, targets, dependents, workflows, effects, risks and recovery, and changes nothing | Verified | `cleanup.test.ts` (dry run), screenshot `25-tools-cleanup-dry-run-dark-1280` |
| M11-AC3 | Nothing runs without approval (native dialog, `--confirm`), and dependents must be accepted first | Verified | `cleanup.test.ts` (service, CLI), `e2e/app.e2e.ts` M11 (refused dialog) |
| M11-AC4 | Plugins and MCP servers change only through Claude Code's own commands with the exact scope; personal skills, commands and subagents move by exact path into the backup folder; nothing else is touched | Verified with a stand-in | `cleanup.test.ts` (disable, uninstall, MCP, move) |
| M11-AC5 | A result is *done* only when the command succeeded and the rescan shows the change; otherwise *partial* or *failed* with next steps; a tool that changed after planning is not touched | Verified | `cleanup.test.ts` (failed, partial, stale) |
| M11-AC6 | Restores where the app can, plans are never deleted or rewritten, and every step is audited | Verified | `cleanup.test.ts`, screenshot `26-tools-cleanup-history-dark-1280` |
| M11-AC7 | Run against real Claude Code on joshua's PC | **Not done** | — |

## Milestone M12 acceptance criteria (watch for tool updates, Phase 9)

| AC | Criterion | Status | Evidence |
|---|---|---|---|
| M12-AC1 | A known version change is detected and linked to the workflows and tests that depend on the tool | Verified | `updates.test.ts` (check), `e2e/app.e2e.ts` M12, screenshot `27-updates-found-dark-1280` |
| M12-AC2 | Discovery, recommendation, approval, installation and verification are separate stages; installation is recorded only when a later check reads the new version | Verified | `updates.test.ts` (lifecycle), `e2e/app.e2e.ts` M12, screenshot `28-updates-verified-dark-1280` |
| M12-AC3 | Nothing is installed or updated and no permission changes: approving records a decision; install steps are shown, never run; only fixed HTTPS hosts are contacted and only package names and versions are sent | Verified | `updates.test.ts` (fetcher, service, CLI), `e2e/app.e2e.ts` M12 (version file unchanged after approval) |
| M12-AC4 | Unreachable, failed and skipped sources are listed with the reason, stale sources are flagged, and what is never checked is stated | Verified | `updates.test.ts` (unreachable, stale), `e2e/app.e2e.ts` M12 |
| M12-AC5 | Security advisories, deprecations, breaking (semver or release-note wording) and newer models are prioritised, with confidence; a newer model is never adopted automatically | Verified | `updates.test.ts` |
| M12-AC6 | A repeated check updates the same item; a newer release supersedes the older one; items and checks are never deleted | Verified | `updates.test.ts` (dedupe, triggers) |
| M12-AC7 | Run against the real sources and joshua's Claude Code on his PC | **Not done** | — |

## Milestone M13 acceptance criteria (controlled self-improvement, Phase 11)

| AC | Criterion | Status | Evidence |
|---|---|---|---|
| M13-AC1 | An approved improvement or app library, runtime or model update becomes a bounded build in the platform-maintenance project, with its goal from the approved item; nothing else can start work there | Verified | `maintain.test.ts` (setup, bounded work, updates), `e2e/app.e2e.ts` M13 |
| M13-AC2 | The running app is never edited: work happens in a worktree of the source, the source checkout is unchanged, and a change ships only as a version the person installs | Verified | `maintain.test.ts` (source status unchanged), `e2e/app.e2e.ts` M13 |
| M13-AC3 | Mandatory regression and workflow checks always run and cannot be removed; a failing, missing or empty one blocks completion with no override; a platform release adds the security audit and takes no gate exceptions | Verified | `maintain.test.ts` (blocked completion, release), screenshot `29-platform-build-dark-1280` |
| M13-AC4 | Changes to permissions, security policies, release gates, production configuration or stored data need the person's separate approval, shown with the exact files in a native dialog, and the release gate checks it | Verified | `maintain.test.ts` (protected approval, gates), `e2e/app.e2e.ts` M13 |
| M13-AC5 | A known-good version is recorded (only from the running version), and a database backup is taken, read back, drilled on a copy and restorable, moving the current database aside | Verified | `maintain.test.ts` (backups, service restore), `e2e/app.e2e.ts` M13, screenshot `30-platform-dark-1280` |
| M13-AC6 | After release the app records whether the improvement happened, from recurrence or the person's judgement, and reopens it as a new item when it did not | Verified | `maintain.test.ts` (measurement, outcome) |
| M13-AC7 | Run the whole cycle on joshua's PC against the real app source, including installing the new version and restoring a backup | **Not done** | — |

## Milestone M14 acceptance criteria (learning and developer aids, Phase 12)

| AC | Criterion | Status | Evidence |
|---|---|---|---|
| M14-AC1 | Feedback becomes a preference only after its proposed wording is approved; the original words are kept as its source | Verified | `learn.test.ts` M14-AC1, `e2e/app.e2e.ts` M14 |
| M14-AC2 | Likely duplicates and conflicts with active preferences are shown, and approval waits for the person to keep both or replace; nothing is combined silently | Verified | `learn.test.ts` M14-AC2, screenshot `31-preferences-duplicate-dark-1280` |
| M14-AC3 | Preferences are scoped to all work or one project, and a project's preferences never meet another project's | Verified | `learn.test.ts` M14-AC3 |
| M14-AC4 | Active preferences can be edited (checked again) and removed; nothing is deleted and the source cannot change | Verified | `learn.test.ts` M14-AC4 |
| M14-AC5 | Active preferences guide the build agent and say they never override its rules, checks or approvals | Verified | `learn.test.ts` M14-AC5 |
| M14-AC6 | The wrap-up separates confirmed decisions from assumptions and inferred next steps, and is stored only when saved | Verified | `learn.test.ts` M14-AC6, `e2e/app.e2e.ts` M14, screenshot `32-wrap-up-dark-1280` |
| M14-AC7 | The Vault keeps notes; a saved summary cannot be rewritten, and a note is never a rule | Verified | `learn.test.ts` M14-AC7 |
| M14-AC8 | One store per kind of learning: feedback is routed to the backlog or to a proposed preference, and the tool scan reports overlapping memory tools (C6) | Verified | `learn.test.ts` M14-AC8, `e2e/app.e2e.ts` M14 |
| M14-AC9 | Use preferences and a wrap-up on joshua's PC with real work | **Not done** | — |
| M14-AC10 | Lessons cite the passages, times or pages they come from; citations outside the source are dropped, and a lesson without one is marked as the model's reading | Verified | `lessons.test.ts` M14-AC10/AC11, screenshot `33-lessons-dark-1280` |
| M14-AC11 | Suggestions are kept apart from what the source says and labelled as the model's recommendations | Verified | `lessons.test.ts` M14-AC10/AC11, `e2e/app.e2e.ts` M14 lessons |
| M14-AC12 | Reading a source changes nothing else; a suggestion becomes a proposed preference or an improvement idea only when the person chooses, and real calls need a budget | Verified | `lessons.test.ts` M14-AC12, `e2e/app.e2e.ts` M14 lessons |
| M14-AC13 | Sources come from a native picker and are checked by their bytes; videos and disguised files are refused; the copy and its passages cannot change | Verified | `lessons.test.ts` M14-AC13, `e2e/app.e2e.ts` M14 lessons |
| M14-AC14 | Repeated work becomes a skill proposal with examples, trigger, steps, permissions, tests and expected benefit | Verified | `lessons.test.ts` M14-AC14, screenshot `34-skill-proposal-dark-1280` |
| M14-AC15 | Existing skills and commands are checked before approval and each likely duplicate needs a decision; export writes a SKILL.md only, never into Claude Code's folders and never over a file | Verified | `lessons.test.ts` M14-AC15, `e2e/app.e2e.ts` M14 lessons |
| M14-AC16 | Each optional add-on is reviewed for source, permissions, compatibility, cost and benefit; include only when the scan finds it and all five are reviewed; a review is a fixed record | Verified | `lessons.test.ts` M14-AC16, screenshot `35-addons-dark-1280` |
| M14-AC17 | The core product works the same with every add-on missing or turned off | Verified | `lessons.test.ts` M14-AC17 |
| M14-AC18 | Read a real transcript or PDF with Claude, propose a skill from real repeated work and review the add-ons on joshua's PC | **Not done** | — |


## Milestone M15 acceptance criteria (live building on Claude Code's engine, simpler app)

| AC | Criterion | Status | Evidence |
|---|---|---|---|
| M15-AC1 | Real build work runs on Claude Code's engine in the build's worktree; files outside it and `.git` are refused, approved checks run without asking, other commands wait for the person, other tools are refused | Verified (with a fake engine) | `engine.test.ts` "files stay inside the worktree…", "with real calls on…" |
| M15-AC2 | The engine gets none of the person's keys, Claude Code settings, plugins or MCP servers, and keeps no sessions | Verified | `engine.test.ts` "the engine gets none…", "steps stream…" (options) |
| M15-AC3 | Each run is capped by the per-run limit and what is left of the monthly budget; its cost is recorded on the ledger | Verified (with a fake engine) | `engine.test.ts` "with real calls on…" |
| M15-AC4 | Steps, Claude's text and plan, questions and stages appear live while the work runs; stopping answers any question with no | Verified | `engine.test.ts` "steps stream…", "a question waits…"; `e2e/app.e2e.ts` M15 |
| M15-AC5 | One sentence becomes a task: repository, checks and dependency install found, commands approved in the native dialog, then setup, baseline, agent and review run by themselves | Verified | `engine.test.ts` "one sentence becomes a task…", "checks and dependency setup…"; `e2e/app.e2e.ts` M15, screenshot `36-build-review-dark-1280` |
| M15-AC6 | The review shows checks before and after, the coloured diff and what to look at; keep takes a one-tap reason when there are risks; ask for changes runs Claude again in the same work | Verified | `e2e/app.e2e.ts` M15, `engine.test.ts` follow-up |
| M15-AC7 | The rail has four places (Build, Projects, Library, Settings) and every earlier screen is still reachable | Verified | `e2e/app.e2e.ts` M15 and all earlier e2e tests, screenshot `39-settings-tabs-dark-1280` |
| M15-AC8 | The installed Windows app loads the engine and runs its binary | Verified in CI | `ci.yml` installer smoke test (`engine.ok`, `claude --version`); packaged Linux build checked locally |
| M15-AC9 | Build a real feature on joshua's PC with Claude Code's engine, answering at least one command question | **Not done** | — |


## Milestone M16 acceptance criteria (Zephium-level look, results and live preview)

| AC | Criterion | Status | Evidence |
|---|---|---|---|
| M16-AC1 | A finished task is a report: headline, checks passed, files changed, lines, cost; the timeline folds away under it | Verified | `report.test.ts`; `e2e/app.e2e.ts` M15, screenshot `36-build-review-dark-1280` |
| M16-AC2 | Changed files show as a tree with +/- counts, and the chosen file's diff has syntax colouring | Verified | `e2e/app.e2e.ts` M15 (tree, `.hl-k`, `.hl-c`) |
| M16-AC3 | The commands that ran show as a terminal with pass or fail and check times | Verified | `report.test.ts` "makeReport counts…" |
| M16-AC4 | "Before it ships" lists Claude's own closing list and the review's risks, each with Ask Claude | Verified | `report.test.ts` "splitShipList…", "makeReport headlines…"; `e2e/app.e2e.ts` M15 |
| M16-AC5 | Keep and Undo are one tap; a change with open risks kept without a note still records what was open | Verified | `report.test.ts` "keepNote…"; `e2e/app.e2e.ts` M15 |
| M16-AC6 | Both themes sit on a sky (day for Light, night for Dark), the work area is one frosted panel, there are no glows, and Light is the default | Verified | `workspace.test.ts` defaults; `e2e/app.e2e.ts` M2-AC6, screenshots `04-settings-light-1280`, `04-settings-night-1280`, `36-build-review-dark-1280` |
| M16-AC7 | Build has no side panel; the composer is a message bar at the bottom; with no work it greets with examples that fill the bar | Verified | `e2e/app.e2e.ts` M2-AC3 (Build), M15, screenshots `09-home-dark-1280`, `37-build-home-dark-1280` |
| M16-AC8 | While Claude works, one status line says the plan item in progress, progress and steps, and shows when it waits for the person | Verified | `report.test.ts` "statusLine…" |
| M16-AC9 | A task previews its dev server or static page: a script needs approval, gets no keys, runs on a free local port and is reported if it fails; a static page is served read-only inside its folder | Verified | `preview.test.ts` (4 tests) |
| M16-AC10 | The preview is shown as a picture taken in a sandboxed hidden window, refreshes while Claude works, opens in the browser, and stops with the task or the app | Verified | `e2e/app.e2e.ts` M15 (static preview, PNG picture), screenshot `40-build-preview-dark-1280` |
| M16-AC11 | Run a real task on joshua's PC and check the report, the sky look and the live preview of Club HR | Verified | 2026-10-29, v0.19.0 on joshua's PC: a real Claude task on Club HR ($0.15) added index.html and tests/index.test.mjs (+138); the report showed files, commands and Before it ships; Start preview served index.html on 127.0.0.1 and the picture of the page showed in the report |
