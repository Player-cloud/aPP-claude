# Iterative Platform

An installable AI development platform with two layers:

- **Project Layer** — plan, build, design, review, ship and assess software projects.
- **Iterative Layer** — observe and safely improve the platform itself.

The specification lives in [`docs/spec/`](docs/spec/). Start with [`docs/IMPLEMENTATION_ASSESSMENT.md`](docs/IMPLEMENTATION_ASSESSMENT.md) for the current plan, [`docs/DECISIONS.md`](docs/DECISIONS.md) for architecture decisions, and [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md) for what is actually implemented and verified.

## Current state: milestones M3 and M4 (main agent, tool inventory)

Implemented and tested:

- A Windows desktop app (Electron) with project creation, workflow runs with explicit states and blockers, an activity log, dark/light/system themes, a frosted-glass look, and a recovery screen for a damaged database.
- A **read-only inventory of your Claude Code tools** (plugins, skills, commands, subagents, hooks, MCP servers) with conflict detection, on the Tools screen and in `iap tools scan`.
- A **main agent** on running workflow runs that plans, picks a single agent, subagents or a team, and checks every result before a request counts as done. It uses a free **simulated model** until you choose a monthly budget and add an Anthropic API key in Settings → AI usage; then it calls Claude and stops before any call that would go over the budget.
- Under both: the M1 core (SQLite persistence, append-only audit log, secret redaction) and the `iap` CLI.

Not yet built: tool execution by agents, integrations, safe cleanup of tools, and the rest of the Iterative Layer. See [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md).

```bash
npm install
npm start          # launch the desktop app
```

The CLI works against the same data:

```bash
npm install
npm run check                                   # type check + tests
npm run iap -- project create --name "My app" --idea "..." --confirmed "Windows first" --assumption "Single user"
npm run iap -- project list
npm run iap -- run start <projectId> --workflow plan
npm run iap -- run move <runId> planned
npm run iap -- run move <runId> blocked --reason "EGM not installed" --resolution "Install EGM or use the native planner"
npm run iap -- events --project <projectId>
npm run iap -- tools scan [--include <projectDir>]   # read-only; changes nothing
npm run iap -- agent run <runId> --goal "..."      # simulated unless a budget is set and ANTHROPIC_API_KEY is set
npm run iap -- doctor
```

Requires Node.js 22.18+. See [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for data locations, backup and recovery.
