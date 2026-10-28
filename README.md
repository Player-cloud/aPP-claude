# Iterative Platform

An installable AI development platform with two layers:

- **Project Layer** — plan, build, design, review, ship and assess software projects.
- **Iterative Layer** — observe and safely improve the platform itself.

The specification lives in [`docs/spec/`](docs/spec/). Start with [`docs/IMPLEMENTATION_ASSESSMENT.md`](docs/IMPLEMENTATION_ASSESSMENT.md) for the current plan, [`docs/DECISIONS.md`](docs/DECISIONS.md) for architecture decisions, and [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md) for what is actually implemented and verified.

## Current state: milestones M3 to M14 part 1 (main agent, tool inventory and cleanup, planning, build work, release gate, assessment, Learning Studio, improvements, update monitor, controlled self-improvement, preferences and wrap-up)

Implemented and tested:

- A Windows desktop app (Electron) with project creation, workflow runs with explicit states and blockers, an activity log, dark/light/system themes, a frosted-glass look, and a recovery screen for a damaged database.
- A **read-only inventory of your Claude Code tools** (plugins, skills, commands, subagents, hooks, MCP servers) with conflict detection, on the Tools screen and in `iap tools scan`.
- **Safe tool cleanup**: for a conflict, options from "keep both" to "uninstall", a dry run of the exact change, and only after you approve it, Claude Code's own `claude plugin` / `claude mcp` commands or a reversible move of your own skill or command file. The app scans again and records done, partial or failed, and can restore.
- A **main agent** on running workflow runs that plans, picks a single agent, subagents or a team, and checks every result before a request counts as done. It uses a free **simulated model** until you choose a monthly budget and add an Anthropic API key in Settings → AI usage; then it calls Claude and stops before any call that would go over the budget.
- **Planning** on each project: the agent drafts a concept brief from your idea and facts, then a specification with stable requirement IDs; you edit and approve each one. Approved versions are frozen, revisions need a reason and record what changed, and everything is kept as Markdown in the project's `docs/designs/`. EGM is detected from the tool scan but not used yet.
- **Build work**: fix a bug or build a feature from the approved spec in its own git worktree and branch. Checks you approve run before and after the change, the agent (or you) changes the code, and a review flags regressions, weakened tests, unrelated files and missing tests. Nothing is merged for you; a finished change is committed on its branch for you to merge.
- **Releases**: a ship-check runs your release checks on the repository's current commit (after you approve them), scans tracked files for credentials, and checks the included work against the approved spec. Eight gates show the evidence they were decided on; a failed required gate blocks the release unless you record an exception with a mitigation. *Prepared* means ready to ship: the app does not deploy, tag or push.
- **Import and assessment**: register an existing git repository as a project without changing it, then assess it read-only. The app reads the current commit from git's object store (never the working folder, never running its code), summarises structure, stack, dependencies, tests, configuration and documentation, and gives each of 29 capabilities (Product, Operations, Interfaces, Management) a status with evidence, confidence, impact and a next step. Anything that lives with an outside provider is *not verified*, and a focused assessment of one category or capability records its scope first and stays inside it. No AI calls.
- **Learning Studio**: collect screenshots, designs and short videos you want to learn from. Files are checked by their content and copied into the app (your originals stay where they are). Tag them, add notes, link them to a project, search and group them. The agent can suggest a kind, tags and a description, which you accept or correct; with real calls on, Claude looks at the image for about 1 to 3 cents. A reference never changes a spec.
- **Polish the UI**: a third kind of build work. It first audits the project's design tokens, components, libraries and breakpoints, gives the agent your chosen references as inspiration, and its review flags new UI libraries, raw colours, accessibility slips and motion problems. One check always asks you to look at the screens yourself.
- **Improvements** (the first part of the Iterative Layer): the app reads its own records (blocked or failed runs, failed agent tasks, abandoned builds, accepted risks, checks that time out or cannot run, failed assessments, tool conflicts, spend near the budget) and shows what it observed, the likely cause and a recommendation separately, plus what it does not record. Findings become backlog items, a repeat adds evidence instead of a duplicate, and you move items from idea to released. Approving an item records your decision and changes nothing in the app. No AI calls.
- **Updates**: *Check for updates* asks the npm registry, the security advisories, the Claude Code and Anthropic SDK release notes, your plugins' GitHub marketplaces and (with your key) the Anthropic model list what is new, and shows each change with what depends on it, a priority and a recommendation. Sources that did not answer are listed. You approve, you install, and the next check plus *Verify* confirm it. The app never installs anything.
- **Platform**: approved improvements and app updates become build work in a worktree of the app's own source code. Every such build runs the app's type check, unit and end-to-end tests, changes to permissions, security, release gates, configuration or stored data need your separate approval, and a failed check blocks it with no override. A platform release takes no exceptions and plans the rollback: take a backup (and test it) before installing, record the installed version as known-good, and restore a backup if you go back. After release the app measures whether the problem came back and reopens the item if it did. The running app is never changed; you install the new version.
- **Preferences**: tell the app how you like the work done, from the Preferences screen or as feedback in Improvements. It proposes the wording; you edit and approve it, for all work or one project. A preference that may repeat or contradict an active one waits for your decision, and approved ones guide the build agent without changing any approval or check. **Wrap-up** summarises decisions, progress, blockers, next steps and assumptions from the app's records, and saves it to the **Vault** inbox only when you ask. No AI calls.
- Under both: the M1 core (SQLite persistence, append-only audit log, secret redaction) and the `iap` CLI.

Not yet built: deployment, running code-review and security-review tools, integrations (so external state is never verified), and building or installing new app versions for you. See [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md).

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
npm run iap -- project import --name "Shop" --path /path/to/repo
npm run iap -- assess run <projectId> [--scope category:operations]   # read-only; changes nothing
npm run iap -- ref import ./screens/*.png --project <projectId>   # then: ref list / ref edit / ref suggest / ref accept
npm run iap -- agent run <runId> --goal "..."      # simulated unless a budget is set and ANTHROPIC_API_KEY is set
npm run iap -- release new <projectId> --version 1.0.0 --check unit="npm test" --build <buildId> --target "..." --health "..." --rollback "..."
npm run iap -- release check <releaseId> --confirm   # exit 4 if a gate blocks; never deploys
npm run iap -- plan brief <projectId>            # draft the concept brief; then plan edit / approve / revise / diff
npm run iap -- plan show <projectId>
npm run iap -- build new <projectId> --kind ui_polish --title "Calmer cards" --goal "..." --check unit="npm test" --ref <refId> --motion
npm run iap -- build new <projectId> --kind bugfix --title "..." --goal "..." --repro "..." --check unit="npm test"
npm run iap -- build start <buildId> --confirm      # then: build agent / build verify / build done
npm run iap -- doctor
```

Requires Node.js 22.18+. See [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for data locations, backup and recovery.
