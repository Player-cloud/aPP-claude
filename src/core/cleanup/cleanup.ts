// Safe tool cleanup (M11: FR-TOOL-003/004/005, DEC-027).
//
//   inventory entry (+ finding) → options, least disruptive first → dry run
//   (exact targets, command, dependents, workflows, risks, recovery) →
//   the person approves → precondition check (rescan, unchanged file) →
//   Claude Code's own command, or a move into the app's backup folder →
//   rescan and verify → record done, partial or failed → restore
//
// Only exact, scanned targets are touched. No wildcard or name-only deletion,
// nothing outside the target, no credentials stored. Anything the app cannot
// identify or remove through a supported path gets manual instructions.
// Claude Code's commands are run with fixed arguments and no shell, except a
// Windows .cmd shim, which only ever gets validated arguments.

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ValidationError } from '../errors.ts';
import type { Finding } from '../conflicts.ts';
import type { ScanRoots, ToolEntry } from '../inventory.ts';
import { redact, redactString } from '../redact.ts';
import { runToolScan, type ToolScan } from '../tools.ts';
import type { Workspace } from '../workspace.ts';

export const CLEANUP_ACTIONS = ['keep', 'configure', 'disable', 'replace', 'uninstall'] as const;
export type CleanupAction = (typeof CLEANUP_ACTIONS)[number];
/** record: nothing runs. claude-cli: Claude Code's own command. move-aside: into the app's backup folder. manual: instructions only. */
export type Mechanism = 'record' | 'claude-cli' | 'move-aside' | 'manual';
export type CleanupStatus = 'planned' | 'recorded' | 'manual' | 'done' | 'partial' | 'failed' | 'stale' | 'cancelled' | 'restored';

export interface CleanupOption {
  action: CleanupAction;
  label: string;
  detail: string;
  mechanism: Mechanism;
  available: boolean;
  /** Why it is not offered, when it is not. */
  why: string | null;
}

export interface ClaudeCommand {
  args: string[];
  /** Project and local scopes are relative to the folder Claude Code runs in. */
  cwd: string;
  display: string;
}

export interface DryRun {
  action: CleanupAction;
  mechanism: Mechanism;
  /** Exact files, folders or configuration entries that change. */
  targets: string[];
  command: ClaudeCommand | null;
  move: { from: string; to: string } | null;
  dependents: { id: string; label: string }[];
  workflows: string[];
  effects: string[];
  risks: string[];
  recovery: string[];
  manual: string[];
  /** The file as it was when planned; the run stops if it changed. */
  fingerprint: { path: string; sha256: string | null };
  needsAcceptance: boolean;
  /** Configuration kept before the change (credentials replaced by placeholders). */
  backupPath: string | null;
}

export interface CleanupResult {
  at: string;
  exitCode: number | null;
  output: string;
  verified: boolean;
  verification: string;
  scanId: string | null;
  nextSteps: string[];
}

export interface CleanupPlan {
  id: string;
  scanId: string;
  findingId: string | null;
  entry: ToolEntry;
  action: CleanupAction;
  mechanism: Mechanism;
  dryRun: DryRun;
  status: CleanupStatus;
  approval: { by: string; at: string; acceptedDependencies: boolean; reason: string | null } | null;
  result: CleanupResult | null;
  restore: CleanupResult | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommandResult {
  exitCode: number | null;
  output: string;
  /** Set when the command could not start (for example Claude Code is not installed). */
  error: string | null;
}

export type ClaudeRunner = (args: string[], cwd: string) => Promise<CommandResult>;

/** Plugin ids, MCP server names and scopes that may be passed to Claude Code. Anything else gets manual instructions. */
const SAFE_ARG = /^[A-Za-z0-9][A-Za-z0-9@._:+-]{0,200}$/;
const CLI_SCOPES = new Set(['user', 'project', 'local']);
const TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 8_000;
const MAX_MOVE_FILES = 500;
const MAX_MOVE_BYTES = 20 * 1024 * 1024;

// ---- Running Claude Code ------------------------------------------------------

/** Finds `claude` on PATH, as the shell would. Null when it is not installed. */
export function findClaude(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir, `claude${ext}`);
      try {
        if (statSync(file).isFile()) return file;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** Runs Claude Code. `prefix` replaces the executable (tests pass [node, fake-claude.mjs]). */
export function claudeRunner(prefix?: string[]): ClaudeRunner {
  return (args, cwd) =>
    new Promise((done) => {
      if (args.some((a) => a !== '--scope' && !SAFE_ARG.test(a))) return done({ exitCode: null, output: '', error: 'Refused: an argument was not a plain name.' });
      let file: string;
      let argv: string[];
      let shell = false;
      if (prefix?.length) {
        [file, ...argv] = [...prefix, ...args] as [string, ...string[]];
      } else {
        const found = findClaude();
        if (!found) return done({ exitCode: null, output: '', error: 'Claude Code (the claude command) was not found on PATH.' });
        file = found;
        argv = args;
        // A .cmd shim needs cmd.exe; every argument was checked above, so quoting cannot be escaped.
        if (/\.(cmd|bat)$/i.test(found)) {
          shell = true;
          file = `"${found}"`;
          argv = args.map((a) => `"${a}"`);
        }
      }
      execFile(file, argv, { cwd, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell }, (error, stdout, stderr) => {
        const output = redactString(`${stdout}${stderr ? `\n${stderr}` : ''}`.trim()).slice(-MAX_OUTPUT);
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return done({ exitCode: null, output, error: 'Claude Code (the claude command) could not be started.' });
        if (error && error.killed) return done({ exitCode: null, output, error: `Claude Code did not finish within ${TIMEOUT_MS / 1000} seconds.` });
        done({ exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output, error: null });
      });
    });
}

// ---- Options and dry run ----------------------------------------------------------

const KIND_WORD: Record<ToolEntry['kind'], string> = {
  plugin: 'plugin',
  marketplace: 'marketplace',
  skill: 'skill',
  command: 'command',
  agent: 'subagent',
  hook: 'hook',
  mcp_server: 'MCP server',
};

const label = (e: ToolEntry) => `${KIND_WORD[e.kind]} ${e.invocation ?? e.name}${e.owner ? ` (plugin ${e.owner})` : ''}`;

/** Where Claude Code runs for a scope: the user's home, or the project folder for project and local scope. */
function cliCwd(e: ToolEntry): string | null {
  if (e.scope === 'user') return homedir();
  if ((e.scope === 'project' || e.scope === 'local') && e.scopeDetail && isAbsolute(e.scopeDetail)) return e.scopeDetail;
  return null;
}

/** The exact path a move-aside would take, only inside the folders Claude Code reads these from. */
function moveTarget(e: ToolEntry, roots: ScanRoots): string | null {
  if (e.owner || !(e.kind === 'skill' || e.kind === 'command' || e.kind === 'agent')) return null;
  const sub = e.kind === 'skill' ? 'skills' : e.kind === 'command' ? 'commands' : 'agents';
  const base = e.scope === 'user' ? join(roots.configDir, sub) : (e.scope === 'project' || e.scope === 'local') && e.scopeDetail ? join(e.scopeDetail, '.claude', sub) : null;
  if (!base) return null;
  const target = e.kind === 'skill' ? dirname(e.source) : e.source;
  const rel = relative(resolve(base), resolve(target));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  if (e.kind === 'skill' && basename(e.source) !== 'SKILL.md') return null;
  return target;
}

function disableMechanism(e: ToolEntry, roots: ScanRoots): { mechanism: Mechanism; why: string | null } {
  if (e.appManaged) return { mechanism: 'manual', why: 'Managed by this app.' };
  if (e.scope === 'managed' || e.provenance === 'organisation') return { mechanism: 'manual', why: 'Set by your organisation. Only your administrator can change it.' };
  if (e.kind === 'plugin') {
    if (!CLI_SCOPES.has(e.scope) || !cliCwd(e)) return { mechanism: 'manual', why: 'The installation scope is not known, so the app will not guess.' };
    if (!SAFE_ARG.test(e.name)) return { mechanism: 'manual', why: 'The plugin id is not a plain name, so the app will not pass it to a command.' };
    if (e.status === 'disabled') return { mechanism: 'manual', why: 'It is already disabled.' };
    return { mechanism: 'claude-cli', why: null };
  }
  if (e.owner) return { mechanism: 'manual', why: `Part of plugin ${e.owner}. Disable the plugin instead.` };
  if (e.kind === 'skill' || e.kind === 'command' || e.kind === 'agent') {
    return moveTarget(e, roots) ? { mechanism: 'move-aside', why: null } : { mechanism: 'manual', why: 'It is not in a folder the app recognises, so the app will not move it.' };
  }
  if (e.kind === 'mcp_server') return { mechanism: 'manual', why: 'Claude Code has no command to disable one MCP server. Remove it, or turn it off in a session with /mcp.' };
  return { mechanism: 'manual', why: 'There is no supported way to switch it off from outside Claude Code.' };
}

function uninstallMechanism(e: ToolEntry, roots: ScanRoots): { mechanism: Mechanism; why: string | null } {
  if (e.appManaged) return { mechanism: 'manual', why: 'Managed by this app.' };
  if (e.scope === 'managed' || e.provenance === 'organisation') return { mechanism: 'manual', why: 'Set by your organisation. Only your administrator can change it.' };
  if (e.owner) return { mechanism: 'manual', why: `Part of plugin ${e.owner}. Uninstall the plugin instead.` };
  if (e.kind === 'plugin' || e.kind === 'mcp_server') {
    if (!CLI_SCOPES.has(e.scope) || !cliCwd(e)) return { mechanism: 'manual', why: 'The installation scope is not known, so the app will not guess.' };
    if (!SAFE_ARG.test(e.name)) return { mechanism: 'manual', why: 'The name is not a plain name, so the app will not pass it to a command.' };
    return { mechanism: 'claude-cli', why: null };
  }
  if (e.kind === 'skill' || e.kind === 'command' || e.kind === 'agent') {
    return { mechanism: 'manual', why: moveTarget(e, roots) ? 'Use Disable: it moves the file into the app’s backup folder, which is the same result and can be undone.' : 'It is not in a folder the app recognises.' };
  }
  if (e.kind === 'marketplace') return { mechanism: 'manual', why: 'Removing a marketplace also uninstalls every plugin from it, which is too broad for one conflict.' };
  return { mechanism: 'manual', why: 'Hooks are entries inside a settings file; the app does not edit those files.' };
}

/** The ways to resolve a conflict, least disruptive first (FR-TOOL-003). */
export function remediationOptions(entry: ToolEntry, scan: ToolScan, roots: ScanRoots, finding: Finding | null): CleanupOption[] {
  const others = finding ? finding.entryIds.filter((id) => id !== entry.id).map((id) => scan.entries.find((e) => e.id === id)).filter((e): e is ToolEntry => !!e) : [];
  const dis = disableMechanism(entry, roots);
  const un = uninstallMechanism(entry, roots);
  const disLabel = dis.mechanism === 'move-aside' ? 'Move it aside (can be undone)' : 'Disable it (can be undone)';
  return [
    { action: 'keep', label: 'Keep both', detail: 'Record that this overlap is intended. Nothing changes.', mechanism: 'record', available: true, why: null },
    {
      action: 'configure',
      label: 'Change the configuration',
      detail: finding?.recommendation ?? entry.removal.instructions,
      mechanism: 'manual',
      available: true,
      why: null,
    },
    {
      action: 'disable',
      label: disLabel,
      detail:
        dis.mechanism === 'move-aside'
          ? 'Moves the exact file into the app’s backup folder, so Claude Code stops loading it. Restore puts it back.'
          : 'Runs Claude Code’s own disable command for this scope. It stays installed.',
      mechanism: dis.mechanism,
      available: dis.why === null,
      why: dis.why,
    },
    {
      action: 'replace',
      label: others.length ? `Use ${others[0]!.invocation ?? others[0]!.name} instead` : 'Replace it',
      detail: others.length ? `Keeps ${label(others[0]!)} and switches this one off the same way as Disable.` : 'Needs another tool that does the same job; none is part of this finding.',
      mechanism: dis.mechanism,
      available: dis.why === null && others.length > 0,
      why: dis.why ?? (others.length ? null : 'No other tool in this finding.'),
    },
    {
      action: 'uninstall',
      label: 'Uninstall it',
      detail: entry.kind === 'mcp_server' ? 'Runs claude mcp remove for this scope.' : 'Runs Claude Code’s own uninstall command for this scope.',
      mechanism: un.mechanism,
      available: un.why === null,
      why: un.why,
    },
  ];
}

const sha256File = (path: string): string | null => {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
};

/** App workflows that use a tool. Only planning looks at the tool scan today (for EGM). */
export function affectedWorkflows(entry: ToolEntry): string[] {
  return /\begm\b|engineering[-_ ]?guidance/i.test(`${entry.name} ${entry.owner ?? ''}`) ? ['Planning looks for EGM in the tool scan; it falls back to its own workflow without it.'] : [];
}

export function dryRun(entry: ToolEntry, action: CleanupAction, scan: ToolScan, roots: ScanRoots, finding: Finding | null, backupDir: string): DryRun {
  const option = remediationOptions(entry, scan, roots, finding).find((o) => o.action === action)!;
  const base = {
    action,
    mechanism: option.available ? option.mechanism : 'manual',
    targets: [] as string[],
    command: null as ClaudeCommand | null,
    move: null as DryRun['move'],
    dependents: [] as DryRun['dependents'],
    workflows: affectedWorkflows(entry),
    effects: [] as string[],
    risks: [] as string[],
    recovery: [] as string[],
    manual: [] as string[],
    fingerprint: { path: entry.source, sha256: sha256File(entry.source) },
    backupPath: null as string | null,
  };
  const finish = (d: typeof base): DryRun => ({ ...d, needsAcceptance: d.mechanism !== 'record' && d.mechanism !== 'manual' && (d.dependents.length > 0 || d.workflows.length > 0) });

  if (action === 'keep') {
    base.effects.push('Nothing changes. The decision is recorded in the audit log.');
    return finish(base);
  }
  if (!option.available || option.mechanism === 'manual') {
    base.mechanism = 'manual';
    if (option.why && action !== 'configure') base.manual.push(option.why);
    base.manual.push(action === 'configure' ? option.detail : entry.removal.instructions);
    base.effects.push('The app changes nothing. Follow the steps yourself, then scan again.');
    return finish(base);
  }

  const cwd = cliCwd(entry);
  const scope = entry.scope;
  if (entry.kind === 'plugin') {
    const verb = action === 'uninstall' ? 'uninstall' : 'disable';
    const args = ['plugin', verb, entry.name, '--scope', scope];
    base.command = { args, cwd: cwd!, display: `claude ${args.join(' ')}` };
    base.targets.push(`Plugin ${entry.name} at ${scope} scope${entry.scopeDetail ? ` (${entry.scopeDetail})` : ''}`);
    base.targets.push(verb === 'disable' ? `"enabledPlugins" in ${settingsFile(entry, roots)}` : `Its install record in ${entry.source}`);
    base.dependents = scan.entries.filter((e) => e.owner === entry.name).map((e) => ({ id: e.id, label: label(e) }));
    base.effects.push(
      verb === 'disable'
        ? `Claude Code stops loading the plugin and its ${base.dependents.length} skills, commands, agents, hooks and MCP servers. It stays installed.`
        : `The plugin and its ${base.dependents.length} skills, commands, agents, hooks and MCP servers are removed from ${scope} scope.`,
    );
    base.risks.push('Claude Code refuses if another enabled plugin depends on this one; the app records that as failed.');
    if (verb === 'uninstall') base.risks.push('If this is the last scope it is installed at, Claude Code also deletes the plugin’s saved options, secrets and data folder. Those cannot be restored by the app.');
    base.risks.push('A Claude Code session that is already open keeps the old plugins until /reload-plugins or a restart.');
    base.recovery.push(verb === 'disable' ? `claude plugin enable ${entry.name} --scope ${scope} (Restore runs this for you)` : `claude plugin install ${entry.name} --scope ${scope} (Restore runs this for you, if the marketplace still has it)`);
  } else if (entry.kind === 'mcp_server') {
    const args = ['mcp', 'remove', entry.name, '--scope', scope];
    base.command = { args, cwd: cwd!, display: `claude ${args.join(' ')}` };
    base.targets.push(`MCP server "${entry.name}" in ${entry.source}${entry.scopeDetail ? ` (${entry.scopeDetail})` : ''}`);
    base.backupPath = join(backupDir, 'mcp-server.json');
    base.effects.push('Claude Code stops connecting to this server.');
    base.risks.push('For a remote server, Claude Code also deletes the sign-in (OAuth tokens) it stored for it; you sign in again after restoring.');
    base.risks.push('If the same name is defined at another scope, that definition is used instead.');
    base.recovery.push(`Re-add it with claude mcp add-json ${entry.name} '<json>' --scope ${scope}, using the copy kept at ${base.backupPath}. Secret values were not kept: re-enter them.`);
  } else {
    const from = moveTarget(entry, roots)!;
    const to = join(backupDir, basename(from));
    base.move = { from, to };
    base.targets.push(from);
    base.effects.push(`Claude Code stops loading ${entry.invocation ?? entry.name}. The ${entry.kind === 'skill' ? 'folder' : 'file'} is kept in the app’s backup folder.`);
    base.risks.push(`Anything that calls ${entry.invocation ?? entry.name} will no longer find it.`);
    base.recovery.push(`Restore moves it back to ${from}.`);
  }
  return finish(base);
}

function settingsFile(e: ToolEntry, roots: ScanRoots): string {
  if (e.scope === 'user') return join(roots.configDir, 'settings.json');
  return join(e.scopeDetail ?? '', '.claude', e.scope === 'local' ? 'settings.local.json' : 'settings.json');
}

/** True/false from the scope's own settings file, null when it does not say. Read-only. */
function enabledInScope(e: ToolEntry, roots: ScanRoots): boolean | null {
  try {
    const value = (JSON.parse(readFileSync(settingsFile(e, roots), 'utf8')) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins?.[e.name];
    return typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

/** Keeps the server's definition with every env and header value replaced, so it can be re-added. */
function mcpBackup(entry: ToolEntry, roots: ScanRoots): Record<string, unknown> | null {
  try {
    const json = JSON.parse(readFileSync(entry.source, 'utf8')) as Record<string, unknown>;
    const servers = (entry.scope === 'local' && entry.source === roots.userConfigFile
      ? ((json.projects as Record<string, Record<string, unknown>> | undefined)?.[entry.scopeDetail ?? '']?.mcpServers ?? {})
      : (json.mcpServers ?? {})) as Record<string, Record<string, unknown>>;
    const def = servers[entry.name];
    if (!def || typeof def !== 'object') return null;
    const hide = (o: unknown) => (o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).map((k) => [k, '<re-enter>'])) : o);
    // A URL's query string can carry a token, so only the address is kept.
    const url = typeof def.url === 'string' ? def.url.replace(/[?#].*$/, (q) => (q ? '?<re-enter the query string>' : '')) : undefined;
    const args = Array.isArray(def.args) ? def.args.map((a) => (typeof a === 'string' ? redactString(a) : a)) : undefined;
    return redact({ ...def, ...(url ? { url } : {}), ...(args ? { args } : {}), ...(def.env ? { env: hide(def.env) } : {}), ...(def.headers ? { headers: hide(def.headers) } : {}) }) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Refuses links and oversized trees, so a move only ever takes ordinary files. */
function checkTree(path: string): string | null {
  let files = 0;
  let bytes = 0;
  const walk = (p: string): string | null => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return `${p} is a link; the app does not move links.`;
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) {
        const problem = walk(join(p, name));
        if (problem) return problem;
      }
      return null;
    }
    if (!st.isFile()) return `${p} is not an ordinary file.`;
    files++;
    bytes += st.size;
    if (files > MAX_MOVE_FILES || bytes > MAX_MOVE_BYTES) return `It holds more than ${MAX_MOVE_FILES} files or ${MAX_MOVE_BYTES / 1024 / 1024} MB, which is not what a skill or command usually is.`;
    return null;
  };
  return walk(path);
}

function moveExact(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  if (existsSync(to)) throw new Error(`${to} already exists.`);
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    // Different drive: copy, check, then remove exactly the original path.
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    if (checkTree(to) !== null) throw new Error('The copy could not be checked.');
    rmSync(from, { recursive: true, force: false });
  }
}

// ---- Plans --------------------------------------------------------------------

export class Cleanup {
  private readonly ws: Workspace;
  private readonly roots: ScanRoots;
  private readonly run: ClaudeRunner;
  constructor(ws: Workspace, roots: ScanRoots, runner: ClaudeRunner) {
    this.ws = ws;
    this.roots = roots;
    this.run = runner;
  }

  private context(entryId: string, findingId: string | null): { scan: ToolScan; entry: ToolEntry; finding: Finding | null } {
    const scan = this.ws.latestToolScan();
    if (!scan) throw new ValidationError('Scan your tools first.');
    const entry = scan.entries.find((e) => e.id === entryId);
    if (!entry) throw new ValidationError('That tool is not in the latest scan. Scan again.');
    const finding = findingId ? scan.findings.find((f) => f.id === findingId) ?? null : null;
    if (findingId && (!finding || !finding.entryIds.includes(entryId))) throw new ValidationError('That finding is not in the latest scan for this tool. Scan again.');
    return { scan, entry, finding };
  }

  options(entryId: string, findingId: string | null): CleanupOption[] {
    const { scan, entry, finding } = this.context(entryId, findingId);
    return remediationOptions(entry, scan, this.roots, finding);
  }

  /** The dry run. Nothing on the computer changes. */
  plan(entryId: string, action: string, findingId: string | null): CleanupPlan {
    if (!CLEANUP_ACTIONS.includes(action as CleanupAction)) throw new ValidationError(`Unknown action: ${action}`);
    const { scan, entry, finding } = this.context(entryId, findingId);
    const id = `cln_${randomUUID()}`;
    const d = dryRun(entry, action as CleanupAction, scan, this.roots, finding, join(this.ws.paths.cleanup, id));
    return this.ws.createCleanupPlan({ id, scanId: scan.id, findingId, entry, action: action as CleanupAction, mechanism: d.mechanism, dryRun: d, status: d.mechanism === 'manual' ? 'manual' : 'planned' });
  }

  cancel(id: string): CleanupPlan {
    const p = this.ws.getCleanupPlan(id);
    if (p.status !== 'planned') throw new ValidationError('Only a plan that has not run can be cancelled.');
    return this.ws.updateCleanupPlan(id, { status: 'cancelled' }, { type: 'cleanup.cancelled', payload: {} });
  }

  /** Carries out an approved plan. The caller has asked the person (native dialog or --confirm). */
  async execute(id: string, input: { acceptDependencies?: boolean; reason?: string | null }): Promise<CleanupPlan> {
    const p = this.ws.getCleanupPlan(id);
    if (p.status !== 'planned') throw new ValidationError(`This plan is ${p.status}; plan again to make another change.`);
    const d = p.dryRun;
    if (d.needsAcceptance && !input.acceptDependencies) throw new ValidationError('Other tools or workflows depend on this. Accept that they are affected, or choose another option.');
    const reason = input.reason ? redactString(input.reason.trim()).slice(0, 500) || null : null;
    const approval = { by: this.ws.actorName(), at: this.ws.nowIso(), acceptedDependencies: !!input.acceptDependencies, reason };
    const audit = { entryId: p.entry.id, target: d.targets, action: p.action, command: d.command?.display ?? (d.move ? `move ${d.move.from} → ${d.move.to}` : null), reason, approvedBy: approval.by };

    if (d.mechanism === 'record') {
      return this.ws.updateCleanupPlan(id, { status: 'recorded', approval }, { type: 'cleanup.recorded', payload: audit });
    }

    // The target must be exactly what was planned.
    const before = this.ws.saveToolScan(runToolScan(this.roots));
    const still = before.entries.find((e) => e.id === p.entry.id);
    const now = sha256File(d.fingerprint.path);
    if (!still || now !== d.fingerprint.sha256) {
      return this.ws.updateCleanupPlan(
        id,
        { status: 'stale', approval, result: this.result(null, '', false, 'The tool changed or disappeared since the plan was made. Nothing was done.', before.id, ['Scan again and plan again.']) },
        { type: 'cleanup.stale', payload: audit },
      );
    }

    this.ws.updateCleanupPlan(id, { approval }, { type: 'cleanup.approved', payload: audit });
    let exit: number | null = null;
    let output = '';
    let error: string | null = null;
    if (d.command) {
      if (d.backupPath) {
        const kept = mcpBackup(p.entry, this.roots);
        mkdirSync(dirname(d.backupPath), { recursive: true });
        writeFileSync(d.backupPath, JSON.stringify(kept ?? { note: 'The definition could not be read back; see the scan entry.' }, null, 2));
      }
      const r = await this.run(d.command.args, d.command.cwd);
      exit = r.exitCode;
      output = r.output;
      error = r.error;
    } else if (d.move) {
      const problem = checkTree(d.move.from);
      if (problem) error = `${problem} Nothing was moved.`;
      else {
        try {
          moveExact(d.move.from, d.move.to);
          exit = 0;
        } catch (err) {
          error = `The move failed: ${(err as Error).message}`;
        }
      }
    }
    return this.finish(id, { exit, output, error }, 'cleanup', audit);
  }

  /** Undoes a done or partial plan where the app can: moves a file back, re-enables or reinstalls a plugin. */
  async restore(id: string): Promise<CleanupPlan> {
    const p = this.ws.getCleanupPlan(id);
    if (p.status !== 'done' && p.status !== 'partial') throw new ValidationError('Only a change that was made can be restored.');
    const d = p.dryRun;
    const audit = { entryId: p.entry.id, action: `restore ${p.action}`, approvedBy: this.ws.actorName() };
    let exit: number | null = null;
    let output = '';
    let error: string | null = null;
    if (d.move) {
      if (existsSync(d.move.from)) error = `${d.move.from} exists again, so the backup was not moved over it.`;
      else if (!existsSync(d.move.to)) error = `The backup at ${d.move.to} is missing.`;
      else {
        try {
          moveExact(d.move.to, d.move.from);
          exit = 0;
        } catch (err) {
          error = `The move failed: ${(err as Error).message}`;
        }
      }
    } else if (d.command && p.entry.kind === 'plugin') {
      const args = ['plugin', p.action === 'uninstall' ? 'install' : 'enable', p.entry.name, '--scope', p.entry.scope];
      const r = await this.run(args, d.command.cwd);
      exit = r.exitCode;
      output = r.output;
      error = r.error;
    } else {
      throw new ValidationError(`The app cannot restore this automatically. ${d.recovery.join(' ')}`);
    }
    return this.finish(id, { exit, output, error }, 'restore', audit);
  }

  private result(exitCode: number | null, output: string, verified: boolean, verification: string, scanId: string | null, nextSteps: string[]): CleanupResult {
    return { at: this.ws.nowIso(), exitCode, output, verified, verification, scanId, nextSteps };
  }

  /** Scans again and checks the change really happened. Exit code and scan must agree for "done". */
  private finish(id: string, r: { exit: number | null; output: string; error: string | null }, phase: 'cleanup' | 'restore', audit: Record<string, unknown>): CleanupPlan {
    const p = this.ws.getCleanupPlan(id);
    const after = this.ws.saveToolScan(runToolScan(this.roots));
    const e = p.entry;
    const same = (x: ToolEntry) => x.kind === e.kind && x.name === e.name && x.scope === e.scope && x.scopeDetail === e.scopeDetail;
    const present = after.entries.some(same);
    const undo = phase === 'restore';
    let verified: boolean;
    let verification: string;
    if (p.dryRun.move) {
      const moved = !existsSync(p.dryRun.move.from) && existsSync(p.dryRun.move.to);
      verified = undo ? !moved && present : moved && !present;
      verification = verified ? (undo ? 'It is back in place and in the scan.' : 'The file is in the backup folder and no longer in the scan.') : 'The files are not where they should be.';
    } else if (e.kind === 'plugin' && (p.action === 'disable' || p.action === 'replace')) {
      const enabled = enabledInScope(e, this.roots);
      verified = undo ? enabled === true : enabled === false;
      verification = verified
        ? `The ${e.scope} settings now ${undo ? 'enable' : 'disable'} ${e.name}.`
        : `The ${e.scope} settings do not show ${e.name} as ${undo ? 'enabled' : 'disabled'} (${enabled === null ? 'not mentioned' : enabled ? 'enabled' : 'disabled'}).`;
    } else {
      verified = undo ? present : !present;
      verification = verified ? (undo ? 'It is in the scan again.' : 'It is no longer in the scan.') : undo ? 'It is not in the scan.' : 'It is still in the scan.';
    }
    const ok = r.error === null && r.exit === 0;
    const status: CleanupStatus = ok && verified ? (undo ? 'restored' : 'done') : !ok && !verified ? (undo ? p.status : 'failed') : 'partial';
    const nextSteps = ok && verified ? (undo ? [] : p.dryRun.recovery) : [...(r.error ? [r.error] : []), ...p.dryRun.recovery, 'Scan again to see the current state.'];
    const result = this.result(r.exit, r.output, verified, ok ? verification : `${r.error ?? `Claude Code exited with ${r.exit}.`} ${verification}`, after.id, nextSteps);
    return this.ws.updateCleanupPlan(id, undo ? { status, restore: result } : { status, result }, {
      type: `cleanup.${undo ? 'restore.' : ''}${undo && status !== 'restored' ? 'failed' : status}`,
      payload: { ...audit, exitCode: r.exit, verified, verification: result.verification, recovery: p.dryRun.recovery },
    });
  }
}

