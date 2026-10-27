# Requirements Traceability

Status legend: **Verified** (implemented, automated tests pass) · **Implemented, not fully verified** · **Partial** · **Planned** · **Blocked** · **Not required**.
"Verified" here means verified for the stated scope only, with the evidence listed.

| Requirement | Scope covered so far | Status | Code | Tests / evidence |
|---|---|---|---|---|
| FR-APP-001 Installable application | Data locations documented and overridable | **Partial** (no installer; DEC-001 pending) | `src/core/paths.ts`, `docs/OPERATIONS.md` | `test/paths.test.ts` |
| FR-APP-002 Persistent workspace | Projects, runs, events persist across restarts; run states; corrupt/missing state handled | **Verified** for projects + runs + events (specs, evidence, tool inventory, approvals, proposals not yet stored) | `src/core/workspace.ts`, `src/core/workflow.ts` | `test/workspace.test.ts` (AC3, AC7, too-new), `test/cli.test.ts` (separate processes) |
| FR-APP-003 Orchestration | — | Planned (M3) | — | — |
| FR-APP-004 Workflow visibility | Blocked runs show blocker + resolution; invalid transitions list allowed next steps | **Partial** (no UI, no tool activity yet) | `src/core/workflow.ts`, `src/cli/main.ts` | `test/workflow.test.ts`, `test/cli.test.ts` |
| FR-PROJ-001 Create a project | Stable ID, workspace, status, `docs/designs/`, confirmed vs assumption facts | **Verified** (CLI only) | `src/core/workspace.ts` | `test/workspace.test.ts` AC1/AC2, `test/cli.test.ts` |
| FR-SEC-002 Secrets protection | Redaction of keys and known token formats before storage | **Partial** (safety net only; credential store planned) | `src/core/redact.ts` | `test/redact.test.ts`, raw-DB scan in `test/workspace.test.ts` AC8 |
| FR-SEC-004 Auditability | Project and run changes, schema migrations; append-only via triggers | **Partial** (approvals, tool/config changes, connections, deployments not yet produced) | `src/core/workspace.ts` | `test/workspace.test.ts` AC6 |
| FR-BUILD-002 Test-driven verification | Test suite + CI on Linux and Windows | **Implemented, not fully verified** (CI has not run yet on GitHub) | `.github/workflows/ci.yml` | Local run: 24/24 pass (Linux, Node 22.22) |
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
| M1-AC10 type check + tests pass | Verified locally (Linux); Windows CI pending | `npm run check` |
