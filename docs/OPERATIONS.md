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

## Backup
Close the app, then copy the whole data directory. SQLite WAL files must be copied together with `iap.db`.

## Recovery
- **Corrupt database (desktop app):** the app opens a recovery screen instead of the workspace and changes nothing until you confirm *Move it aside and start fresh*.
- **Corrupt database (CLI):** commands exit with code 2 and a message. Nothing is modified. Run `npm run iap -- recover --confirm` to rename the damaged files to `iap.db.corrupt-<timestamp>` and start a fresh database. Restore from backup by copying a backed-up `iap.db` into place. `recover` refuses to act on a healthy database.
- **Database from a newer version:** refused with exit code 2; upgrade the app. The file is not downgraded.

## Exit codes
`0` success · `1` usage/validation error · `2` state unreadable (corrupt/too new) · `3` unexpected error.
