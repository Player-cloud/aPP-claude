# Iterative Platform

An installable AI development platform with two layers:

- **Project Layer** — plan, build, design, review, ship and assess software projects.
- **Iterative Layer** — observe and safely improve the platform itself.

The specification lives in [`docs/spec/`](docs/spec/). Start with [`docs/IMPLEMENTATION_ASSESSMENT.md`](docs/IMPLEMENTATION_ASSESSMENT.md) for the current plan, [`docs/DECISIONS.md`](docs/DECISIONS.md) for architecture decisions, and [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md) for what is actually implemented and verified.

## Current state: milestone M1 (workspace core + CLI)

Implemented: projects, an explicit workflow-run state machine, an append-only audit log, SQLite persistence with corruption recovery, secret redaction, and the `iap` CLI. Not yet built: the desktop UI, agents, integrations, installer.

```bash
npm install
npm run check                                   # type check + tests
npm run iap -- project create --name "My app" --idea "..." --confirmed "Windows first" --assumption "Single user"
npm run iap -- project list
npm run iap -- run start <projectId> --workflow plan
npm run iap -- run move <runId> planned
npm run iap -- run move <runId> blocked --reason "EGM not installed" --resolution "Install EGM or use the native planner"
npm run iap -- events --project <projectId>
npm run iap -- doctor
```

Requires Node.js 22.18+. See [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for data locations, backup and recovery.
