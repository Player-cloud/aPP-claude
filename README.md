# Iterative Platform

An installable AI development platform with two layers:

- **Project Layer** — plan, build, design, review, ship and assess software projects.
- **Iterative Layer** — observe and safely improve the platform itself.

The specification lives in [`docs/spec/`](docs/spec/). Start with [`docs/IMPLEMENTATION_ASSESSMENT.md`](docs/IMPLEMENTATION_ASSESSMENT.md) for the current plan, [`docs/DECISIONS.md`](docs/DECISIONS.md) for architecture decisions, and [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md) for what is actually implemented and verified.

## Current state: milestones M3 to M7 (main agent, tool inventory, planning, build work, release gate)

Implemented and tested:

- A Windows desktop app (Electron) with project creation, workflow runs with explicit states and blockers, an activity log, dark/light/system themes, a frosted-glass look, and a recovery screen for a damaged database.
- A **read-only inventory of your Claude Code tools** (plugins, skills, commands, subagents, hooks, MCP servers) with conflict detection, on the Tools screen and in `iap tools scan`.
- A **main agent** on running workflow runs that plans, picks a single agent, subagents or a team, and checks every result before a request counts as done. It uses a free **simulated model** until you choose a monthly budget and add an Anthropic API key in Settings → AI usage; then it calls Claude and stops before any call that would go over the budget.
- **Planning** on each project: the agent drafts a concept brief from your idea and facts, then a specification with stable requirement IDs; you edit and approve each one. Approved versions are frozen, revisions need a reason and record what changed, and everything is kept as Markdown in the project's `docs/designs/`. EGM is detected from the tool scan but not used yet.
- **Build work**: fix a bug or build a feature from the approved spec in its own git worktree and branch. Checks you approve run before and after the change, the agent (or you) changes the code, and a review flags regressions, weakened tests, unrelated files and missing tests. Nothing is merged for you; a finished change is committed on its branch for you to merge.
- **Releases**: a ship-check runs your release checks on the repository's current commit (after you approve them), scans tracked files for credentials, and checks the included work against the approved spec. Eight gates show the evidence they were decided on; a failed required gate blocks the release unless you record an exception with a mitigation. *Prepared* means ready to ship: the app does not deploy, tag or push.
- Under both: the M1 core (SQLite persistence, append-only audit log, secret redaction) and the `iap` CLI.

Not yet built: deployment, running code-review and security-review tools, integrations, safe cleanup of tools, and the rest of the Iterative Layer. See [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md).

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
npm run iap -- release new <projectId> --version 1.0.0 --check unit="npm test" --build <buildId> --target "..." --health "..." --rollback "..."
npm run iap -- release check <releaseId> --confirm   # exit 4 if a gate blocks; never deploys
npm run iap -- plan brief <projectId>            # draft the concept brief; then plan edit / approve / revise / diff
npm run iap -- plan show <projectId>
npm run iap -- build new <projectId> --kind bugfix --title "..." --goal "..." --repro "..." --check unit="npm test"
npm run iap -- build start <buildId> --confirm      # then: build agent / build verify / build done
npm run iap -- doctor
```

Requires Node.js 22.18+. See [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for data locations, backup and recovery.
