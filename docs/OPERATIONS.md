# Operations

## Requirements
- Node.js **22.18 or newer** (the core runs TypeScript directly via Node's type stripping).
- Target OS for the installable app (proposed, DEC-001): Windows 10/11 x64. The core and CLI are tested on Linux in this repo's CI, plus Windows once the CI workflow runs.

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

## Backup
Close the app, then copy the whole data directory. SQLite WAL files must be copied together with `iap.db`.

## Recovery
- **Corrupt database:** commands exit with code 2 and a message. Nothing is modified. Run `npm run iap -- recover --confirm` to rename the damaged files to `iap.db.corrupt-<timestamp>` and start a fresh database. Restore from backup by copying a backed-up `iap.db` into place. `recover` refuses to act on a healthy database.
- **Database from a newer version:** refused with exit code 2; upgrade the app. The file is not downgraded.

## Exit codes
`0` success · `1` usage/validation error · `2` state unreadable (corrupt/too new) · `3` unexpected error.
