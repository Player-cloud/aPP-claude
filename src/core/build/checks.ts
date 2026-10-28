// Verification commands for the build workflows (M6: FR-BUILD-002). A check
// is a command the person approved for one feature or bug fix, such as
// "npm test". Only approved checks ever run: the model can ask to run one by
// its ID but can never supply a command. Checks run in the feature's
// worktree with the person's own rights (there is no OS sandbox), a time
// limit, and an environment without the app's or other known secrets.
// Results are real: a check that did not run is "not_run", never "passed".

import { spawn } from 'node:child_process';
import { redactString } from '../redact.ts';
import { ValidationError } from '../errors.ts';

export interface Check {
  /** Short stable ID, such as "unit". */
  id: string;
  /** The exact command line the person approved. */
  command: string;
}

export type CheckStatus = 'passed' | 'failed' | 'timed_out' | 'error' | 'not_run';

export interface CheckResult {
  checkId: string;
  command: string;
  status: CheckStatus;
  exitCode: number | null;
  durationMs: number;
  /** The end of stdout and stderr together, redacted. */
  output: string;
  startedAt: string;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT = 20_000;
const MAX_CHECKS = 10;
const CHECK_ID = /^[a-z][a-z0-9-]{0,30}$/;

/** Environment variables a check never gets, so a test cannot read the person's keys by accident. */
const SECRET_ENV = /(^ANTHROPIC_|_API_KEY$|_TOKEN$|_SECRET$|PASSWORD|^AWS_|^GH_|^GITHUB_TOKEN$|^NPM_TOKEN$|^IAP_)/i;

export function normalizeChecks(value: unknown): Check[] {
  if (!Array.isArray(value)) throw new ValidationError('Checks must be a list.');
  if (value.length > MAX_CHECKS) throw new ValidationError(`At most ${MAX_CHECKS} checks.`);
  const seen = new Set<string>();
  return value.map((raw) => {
    const c = raw as Record<string, unknown>;
    if (typeof c?.id !== 'string' || !CHECK_ID.test(c.id)) throw new ValidationError('A check ID is lower-case letters, digits and dashes, starting with a letter.');
    if (seen.has(c.id)) throw new ValidationError(`Check "${c.id}" is listed twice.`);
    seen.add(c.id);
    if (typeof c.command !== 'string' || !c.command.trim() || c.command.length > 500 || /[\r\n\0]/.test(c.command)) {
      throw new ValidationError(`Check "${c.id}" needs a one-line command of at most 500 characters.`);
    }
    return { id: c.id, command: c.command.trim() };
  });
}

export function checkEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) if (!SECRET_ENV.test(k)) env[k] = v;
  env.CI = '1';
  return env;
}

/**
 * Runs one approved check in `cwd`. The command line goes to the system shell
 * because the person approved it as typed (for example "npm test", which is a
 * .cmd file on Windows). Never pass text from the model here.
 */
export function runCheck(cwd: string, check: Check, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CheckResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT * 2);
    };
    const done = (status: CheckStatus, exitCode: number | null, extra = '') =>
      resolve({
        checkId: check.id,
        command: check.command,
        status,
        exitCode,
        durationMs: Date.now() - started,
        output: redactString((output + extra).slice(-MAX_OUTPUT)),
        startedAt,
      });
    let child;
    try {
      child = spawn(check.command, { cwd, shell: true, env: checkEnv(), windowsHide: true, detached: process.platform !== 'win32' });
    } catch (e) {
      return done('error', null, `Could not start: ${(e as Error).message}`);
    }
    const kill = () => {
      if (child.pid === undefined) return;
      try {
        // Kill the whole process tree: the shell and whatever it started.
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    opts.signal?.addEventListener('abort', kill, { once: true });
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (e) => {
      clearTimeout(timer);
      done('error', null, `\nCould not start: ${e.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return done('timed_out', code, `\nStopped after ${Math.round(timeoutMs / 1000)} s.`);
      if (opts.signal?.aborted) return done('not_run', code, '\nCancelled.');
      done(code === 0 ? 'passed' : 'failed', code);
    });
  });
}
