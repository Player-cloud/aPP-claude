// Typed errors so callers (CLI, future Electron shell) can map failures to
// clear messages and exit codes instead of string matching.

export class IapError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ValidationError extends IapError {
  constructor(message: string) {
    super('VALIDATION', message);
  }
}

export class NotFoundError extends IapError {
  constructor(kind: string, id: string) {
    super('NOT_FOUND', `${kind} not found: ${id}`);
  }
}

export class InvalidTransitionError extends IapError {
  constructor(from: string, to: string, allowed: readonly string[]) {
    const options = allowed.length ? allowed.join(', ') : 'none (terminal state)';
    super('INVALID_TRANSITION', `Cannot move a run from "${from}" to "${to}". Allowed: ${options}.`);
  }
}

/** The state database exists but cannot be read safely. Never auto-overwritten. */
export class StateCorruptError extends IapError {
  readonly dbPath: string;
  constructor(dbPath: string, detail: string) {
    super(
      'STATE_CORRUPT',
      `The workspace database at ${dbPath} is unreadable (${detail}). ` +
        'Nothing has been changed. Run "iap recover --confirm" to move it aside and start a fresh database; ' +
        'the damaged file is kept for inspection.',
    );
    this.dbPath = dbPath;
  }
}

/** The database was written by a newer version of the app; refuse rather than downgrade it. */
export class StateTooNewError extends IapError {
  constructor(dbPath: string, found: number, supported: number) {
    super(
      'STATE_TOO_NEW',
      `The workspace database at ${dbPath} uses schema version ${found}, but this version supports up to ${supported}. ` +
        'Upgrade the application; the database has not been modified.',
    );
  }
}

/** A model call did not produce a usable answer (budget stop, timeout, API error, cut-off or declined answer). */
export class ModelCallError extends IapError {
  constructor(status: 'blocked' | 'timed_out' | 'failed', message: string) {
    super(status === 'blocked' ? 'BUDGET_BLOCKED' : status === 'timed_out' ? 'MODEL_TIMEOUT' : 'MODEL_FAILED', message);
  }
}
