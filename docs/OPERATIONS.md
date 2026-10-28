# Operations

## Requirements
- Installed app: Windows 10/11 x64 (DEC-001). Developing from source needs Node.js **22.18+**.
- Tested viewport sizes: 1024×768, 1280×800, 1920×1080. Below 1060 px wide the navigation collapses to icons.

## Installing the desktop app (Windows)
1. Download `IterativePlatform-Setup-<version>.exe` from the **windows-installer** artifact of the latest CI run on `main` (GitHub → Actions → ci → run → Artifacts).
2. Run it. The installer is **not code-signed yet**, so Windows SmartScreen shows "Windows protected your PC": choose *More info → Run anyway*.
3. It installs per user (no admin rights) to `%LOCALAPPDATA%\Programs\iterative-platform` unless you choose another folder.
4. Uninstall from *Settings → Apps*. Uninstalling **keeps** your data folder.

Health check without opening a window: `"Iterative Platform.exe" --smoke-test` writes a JSON report to stdout (or to the file named by `IAP_SMOKE_OUT`) and exits 0 when the workspace is healthy.

## Running from source
```bash
npm install
npm start            # build and launch the desktop app
npm run check        # type check + unit tests
npm run test:e2e     # end-to-end tests against real Electron (Linux needs xvfb-run)
npm run dist:win     # build the Windows installer (on Windows)
```

## Data locations (FR-APP-001)

| OS | Default data directory |
|---|---|
| Windows | `%APPDATA%\IterativePlatform` |
| macOS | `~/Library/Application Support/IterativePlatform` |
| Linux | `$XDG_DATA_HOME/IterativePlatform` or `~/.local/share/IterativePlatform` |

Set `IAP_HOME` to use another directory. Contents:

- `iap.db` (+ `-wal`, `-shm`) — projects, workflow runs, append-only audit log.
- `projects/<projectId>/` — project workspace; `docs/designs/` holds design documents.
- `references/` — the Learning Studio's copies of design references (`<refId>.<ext>`). Archived references stay here.
- `cleanup/<planId>/` — tool cleanup backups: skills, commands and subagents that were moved aside, and MCP server definitions kept without their secret values (M11). Delete a folder yourself to remove something for good.

No credentials are stored here. Secret-looking values are redacted before anything is written.

## Tool inventory (M4)

The Tools screen and `iap tools scan` read, and never write, these locations:

| What | Where |
|---|---|
| Claude Code configuration folder | `$CLAUDE_CONFIG_DIR`, or `~/.claude` (`settings.json`, `skills/`, `commands/`, `agents/`, `plugins/installed_plugins.json`, `plugins/known_marketplaces.json`, and each installed plugin's folder) |
| Global config file | `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`. Only `mcpServers` and the per-project `mcpServers` and MCP approvals are read; account data is ignored |
| Projects | Folders recorded in the global config file that still exist (up to 100), plus any `--include` folders: `.claude/settings*.json`, `.claude/skills`, `.claude/commands`, `.claude/agents`, `.mcp.json` |
| Organisation policy | Windows `C:\Program Files\ClaudeCode` and `C:\ProgramData\ClaudeCode`; macOS `/Library/Application Support/ClaudeCode`; Linux `/etc/claude-code` (`managed-settings.json`, `managed-mcp.json`) |

MCP server environment variables and headers are reduced to their names, URLs lose query strings and credentials, and hook commands are redacted. The last 20 scans are kept in `iap.db`, and each scan is recorded in the audit log.

## Tool cleanup (M11, DEC-027)

| What | Where / how |
|---|---|
| Starting | Tools → a finding's *Resolve* buttons, or *Resolve or remove…* on any tool. CLI: `iap tools options <toolId>`, then `iap tools plan <toolId> --action <keep\|configure\|disable\|replace\|uninstall>` |
| Dry run | Shows the exact command or move, targets, what depends on it, risks and how to undo it. Nothing changes |
| Running | Desktop: approve in the Windows dialog. CLI: `iap tools run <planId> --confirm` (add `--accept` when something depends on it). The app uses `claude` from your PATH; plugins: `claude plugin disable\|uninstall <id> --scope <scope>`; MCP servers: `claude mcp remove <name> --scope <scope>`; your own skills, commands and subagents are moved into `<data dir>/cleanup/` |
| Not automated | Hooks (entries inside settings files), marketplaces, organisation-managed tools, a plugin's own components and anything unclear: the app shows the steps instead |
| Results | The app scans again. *Done* only when Claude Code succeeded and the scan shows it; otherwise *partial* or *failed* with Claude Code's output and next steps. A Claude Code session that is already open needs `/reload-plugins` or a restart |
| Undo | `iap tools restore <planId> --confirm` or *Restore…*: moves files back, re-enables or reinstalls plugins. A removed MCP server is re-added by you from the kept copy (re-enter its secrets) |

## Update monitor (M12, DEC-028)

| What | Where / how |
|---|---|
| Checking | *Updates* → *Check for updates*, or `iap updates check`. Manual only; nothing runs in the background |
| What is sent | HTTPS requests to `registry.npmjs.org` (package names, and the installed versions for the advisory check) and `raw.githubusercontent.com` (release notes and plugin marketplace files, public). The Anthropic model list is requested only when an API key is stored (in the app: Settings → AI usage; CLI: `ANTHROPIC_API_KEY`); it costs nothing |
| Installed versions | App libraries: fixed when the app is built. Claude Code: `claude --version` from your PATH. Plugins: the latest tool scan (scan first) |
| Decisions | `iap updates approve <UPD-n> [--note]`, `dismiss <UPD-n> --reason`, `reopen`. Approving installs nothing |
| Installing | Done by you: `claude update` for Claude Code, `claude plugin update <id> --scope <scope>` for a plugin, and a new app release for the app's own libraries. The next check marks the item installed |
| Verifying | *Verify* or `iap updates verify <UPD-n>`: re-reads the version and, for Claude Code and plugins, runs a fresh tool scan. Exit code 4 when verification fails |
| Records | Checks and items stay in `iap.db` for good; every step is in the audit log |

## Planning documents (M5, DEC-019)

Each project's `docs/designs/` folder holds its planning documents as Markdown, written by the app:

| File | Content |
|---|---|
| `versions/brief-v<N>.md`, `versions/spec-v<N>.md` | Every version, including drafts, discarded and superseded ones |
| `brief.md`, `spec.md` | The approved version |

The database is the source of truth: editing these files does not change the app's copy, and the next save rewrites them. Approved versions cannot be changed or deleted (database triggers); revise them instead.

## Build work (M6, DEC-020)

| What | Where / how |
|---|---|
| Repository | Each project points at one git repository with at least one commit (*Build work* card, or `iap build repo`). *Start a repository in the project folder* runs `git init` in the app's own project folder only |
| Worktrees | `<data directory>/worktrees/<buildId>`, each on a branch `iap/feature-…` or `iap/fix-…` created from the repository's current commit. Git also records each worktree in the repository's `.git/worktrees`. Repository hooks are not run |
| Check commands | Typed by you, approved in a dialog (desktop) or with `--confirm` (CLI), then run through the system shell in the worktree **with your permissions**. They are not sandboxed. Variables that look like secrets (`ANTHROPIC_*`, `*_TOKEN`, `*_API_KEY`, `*_SECRET`, `AWS_*`, `GH_*`, …) are removed from their environment; each run has a 10-minute limit |
| Reports | `<project folder>/docs/builds/<buildId>.md`: checks before and after, agent summary, changed files and unresolved risks |
| Finished work | *Mark done* commits the change on the build's branch inside the worktree (hooks off; your git identity, or "Iterative Platform" if none is set). Your checkout is not touched |
| UI polish (M9, DEC-025) | Branch `iap/polish-…`. At start the app reads the worktree's tracked CSS, component and package files (up to 4,000 files, 256 KB each; nothing runs) and stores the audit on the build and in its report. The review adds design risks and always a *manual check*, so *Mark done* needs a note saying what you checked |
| Merging and clean-up | Never done by the app. Merge the branch yourself; remove a finished worktree with `git worktree remove <path>` and its branch with `git branch -d <branch>` |

## Releases (M7, DEC-022)

| What | Where / how |
|---|---|
| Ship-check | Runs the release's check commands on the repository's current commit in `<data directory>/worktrees/<releaseId>` (detached, no branch), after approval in a dialog or with `--confirm`, with the same environment scrubbing and time limit as build checks. The worktree is reset afterwards and tracked files are scanned for credentials; only `path:line` is reported |
| Gates | Approved spec, spec drift, included work (finished, verified, merged into the checked commit), review findings, release checks, credentials, review tools (optional, always Skipped for now), release plan |
| Exceptions | Recorded with your name, a reason, a mitigation and the checked commit; they cannot be changed or deleted, and they apply only to that commit (a ship-check on a newer commit needs a new decision) |
| Reports | `<project folder>/docs/releases/<releaseId>.md` |
| Preparing | Needs every required gate passed or excepted and the repository still at the checked commit. Nothing is deployed, tagged or pushed: deploy yourself using the plan |

## Import and assessment (M8, DEC-023)

| What | Where / how |
|---|---|
| Import | Records the repository's location (`git rev-parse --show-toplevel`) as a project with origin `imported`. Nothing in the repository is copied, moved or changed; a repository can belong to one active project |
| What is read | The current commit only, through `git ls-tree` and `git cat-file` (git's object store). Uncommitted changes are counted, not read. Vendored and generated folders, lockfiles, binaries and files over 512 KB are listed but not read; at most 6,000 files and 48 MB are read, and the rest is reported as not inspected |
| What is never done | No code, test, build or script from the repository runs; no hook runs; `git status` is run without optional locks so the index is not rewritten; no outside service is contacted; no model is called |
| Unchanged check | HEAD, every branch and tag, and `git status` are compared before and after; the report says whether they matched |
| Scope | Full, codebase only, one category or one capability, plus capabilities you mark not applicable. The scope is stored (`assessment.scoped` event) before anything is read |
| Reports | `<project folder>/docs/assessments/<assessmentId>.md`, never inside the repository. Finished assessments cannot change or be deleted |

## Learning Studio (M9, DEC-024)

| What | Where / how |
|---|---|
| Adding files | Desktop: *Add files* opens a file picker. CLI: `iap ref import <file>...`. PNG, JPEG, GIF, WebP, MP4, MOV and WebM, checked by their content; SVG is refused because it can contain scripts. Images up to 25 MB, videos up to 150 MB, 50 files at a time |
| Storage | A copy in `<data dir>/references/`. The original file is not moved or changed. The same file twice is skipped |
| Suggestions | Simulated: a guess from the file name, labelled as such. With real calls on: Claude looks at the image (5 MB or less, not videos), about 1 to 3 cents, inside the monthly budget. Nothing is applied until you accept it |
| Removing | References are archived (`iap ref archive`), never deleted, and can be restored |
| Specs | Nothing in the Learning Studio changes a project's plan documents |

## Improvements (M10, DEC-026)

| What | Where / how |
|---|---|
| Self-assessment | Desktop: Improvements → *Run self-assessment*. CLI: `iap iter assess`. Reads the app's own records only; nothing is changed and no AI is called. Each run is stored and cannot change |
| Backlog | `iap iter list [--status <s>]`, `iap iter show IMP-<n>`. A finding that comes back adds evidence to its item instead of a new item |
| Feedback | Desktop: *Add an idea*. CLI: `iap iter feedback <text>` |
| Moving items | `iap iter move IMP-<n> <status>`. Proposing needs an expected outcome and success criteria (`iap iter edit`); blocking and rejecting need `--reason`; verified needs `--result`; released needs `--outcome` (a measured outcome, not just passing tests). Approval records your OS user name and fixes the item's definition |
| Duplicates | `iap iter merge IMP-<dup> --into IMP-<kept>`. Nothing is deleted |
| What approval does | Nothing in the app changes. Building an improvement is separate Project Layer work |

## Real model calls (M3, DEC-018)

The main agent, the planning drafts and the build agent all use this. A build agent run is also capped at $3 and 40 turns. Real Claude calls need **both** a monthly budget and an Anthropic API key, set in *Settings → AI usage*. Without either, the agent uses the free simulated model.

| What | Where / how |
|---|---|
| API key | `<data directory>/secrets/anthropic-api-key.bin`, encrypted with Electron `safeStorage` (Windows DPAPI: readable only by the same Windows user on the same machine). Never stored in the database, logs or audit events, and never sent back to the UI. *Remove key* deletes the file |
| CLI | Reads the key from `ANTHROPIC_API_KEY`; real calls only when the app's budget setting is not "No real calls" |
| Spend | Append-only `spend` table in the database, per calendar month (UTC). Each call is checked before it is made against the budget minus the month's spend minus calls in flight, assuming the longest possible answer. A call abandoned at its timeout is counted at its estimate |
| Model and price | `claude-opus-5-5`, $4 per million input tokens, $20 per million output tokens (checked 2026-10-27; update `src/core/agents/claude.ts` if Anthropic's prices change) |

The app's budget is a safety stop inside this app only. Also set a spend limit in the Anthropic Console, which covers every use of the key.

## Platform maintenance (M13, DEC-029)
- **Set up once:** Platform → *Set up* with the folder of the app's source code (a git clone of this repository), or `npm run iap -- platform setup <folder>`. The running version is recorded as known-good. Nothing in the folder changes.
- **Build an approved item:** *Build as platform work* on an approved improvement (Improvements) or an approved app library, runtime or model update (Updates), or `iap platform start IMP-n|UPD-n`. Start it in the platform-maintenance project; the mandatory checks (`npm ci`, `npm run typecheck`, `npm test`, `npm run test:e2e`) run in a worktree under `<data>/worktrees/`. `npm ci` installs the exact dependencies in the lockfile, including Electron's download step; you approve it with the other commands.
- **Protected changes** (approval and permission rules, security policies, release gates, production configuration, stored data) are reported by verification and need *Approve protected changes…* (or `iap platform approve <buildId> --reason <why> --confirm`) before the build can be marked done.
- **Ship it yourself:** merge the build's branch in the source repository, create a release in the platform-maintenance project and run its ship-check (it adds `npm audit`; it needs the network and takes no exceptions), prepare it, then build the installer (`npm run dist:win`) and install it.
- **Before installing:** Platform → *Take a backup* (or `iap platform backup`), then *Test recovery* (or `iap platform test-recovery <file>`). Backups are `<data>/backups/iap-v<version>-<time>.db`.
- **After installing:** check the app opens and your projects load, then mark the release known-good on the Platform page (`iap platform known-good <releaseId> --note <what you checked>`). It only works from the version that is running.
- **Measure:** after using the new version for a week, run a self-assessment and *Measure from the records* on each released item (`iap iter measure IMP-n`, exit code 4 when not improved), or record your own judgement (`iap iter outcome IMP-n --verdict improved|not_improved --note <text>`). *Not improved* proposes a follow-up item.

## Rolling back a platform update
1. Uninstall the new version and reinstall the known-good version's installer (listed under Known-good versions).
2. If the older version shows "This workspace needs a newer version", choose *Restore…* next to a backup it can read; or close the app and run `npm run iap -- recover --from <backup file> --confirm`. The current database is renamed `iap.db.replaced-<time>` and kept.
3. Open the app and check your projects load.

## Backup
Close the app, then copy the whole data directory. SQLite WAL files must be copied together with `iap.db`. Platform → *Take a backup* makes a consistent copy of the database while the app runs (M13).

## Recovery
- **Corrupt database (desktop app):** the app opens a recovery screen instead of the workspace and changes nothing until you confirm *Move it aside and start fresh*.
- **Corrupt database (CLI):** commands exit with code 2 and a message. Nothing is modified. Run `npm run iap -- recover --confirm` to rename the damaged files to `iap.db.corrupt-<timestamp>` and start a fresh database. Restore from backup by copying a backed-up `iap.db` into place. `recover` refuses to act on a healthy database.
- **Database from a newer version:** refused with exit code 2; upgrade the app. The file is not downgraded.

## Exit codes
`0` success · `1` usage/validation error · `2` state unreadable (corrupt/too new) · `3` unexpected error · `4` a gate blocks the release (`release check`), verification failed (`updates verify`), a recovery test failed (`platform test-recovery`) or the item did not improve (`iter measure`).
