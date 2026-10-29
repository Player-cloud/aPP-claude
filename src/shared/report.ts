// The finished task as a report (M16, DEC-033): one headline, the numbers that
// matter, what changed, the commands that ran, and what is left before the
// change ships. Pure, so the renderer and the tests share it.
import type { Build, ChangedFile, CheckRun } from './api.ts';

export type ReportTone = 'ok' | 'warn' | 'danger' | 'neutral';

export interface ReportCommand {
  command: string;
  ok: boolean;
  /** Null for commands Claude ran, whose time is not recorded. */
  durationMs: number | null;
  from: 'check' | 'claude';
  note: string;
}

export interface Report {
  headline: string;
  tone: ReportTone;
  /** Claude's summary without its "Before it ships" list. */
  summary: string;
  checks: { passed: number; total: number };
  files: ChangedFile[];
  added: number;
  removed: number;
  costUsd: number;
  commands: ReportCommand[];
  /** Claude's own list, then what the automatic review found. */
  todos: string[];
}

const SHIP_HEADING = /^\s*(?:#{1,4}\s*|\*\*)?before (?:it|this) ships\b[^\n]*$/im;
const ITEM = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/;
const NOTHING = /^(?:nothing|none|no(?:thing)? (?:further|more|else))\b/i;

/** Splits Claude's closing "Before it ships" list off its summary. */
export function splitShipList(text: string): { summary: string; todos: string[] } {
  const m = SHIP_HEADING.exec(text);
  if (!m) return { summary: text.trim(), todos: [] };
  const after = text.slice(m.index + m[0].length).split('\n');
  const todos: string[] = [];
  let consumed = 0;
  // Text on the heading line itself ("Before it ships: nothing") counts as an item.
  const inline = m[0].replace(/^[^:]*:\s*/, '').replace(/\*\*/g, '').trim();
  if (inline && inline !== m[0].trim() && !NOTHING.test(inline)) todos.push(inline);
  for (const line of after) {
    const item = ITEM.exec(line);
    if (item) {
      const t = item[1]!.replace(/\*\*/g, '').trim();
      if (t && !NOTHING.test(t)) todos.push(t);
      consumed++;
      continue;
    }
    if (!line.trim() && todos.length === 0) {
      consumed++;
      continue;
    }
    if (line.trim() && todos.length === 0 && NOTHING.test(line.trim())) {
      consumed++;
      continue;
    }
    break;
  }
  const rest = after.slice(consumed).join('\n');
  return { summary: `${text.slice(0, m.index)}${rest}`.trim(), todos };
}

/** The latest result of each check in one phase. */
function latest(runs: CheckRun[], phase: CheckRun['phase']): CheckRun[] {
  const m = new Map<string, CheckRun>();
  for (const r of runs) if (r.phase === phase) m.set(r.checkId, r);
  return [...m.values()];
}

export function makeReport(build: Build, checkRuns: CheckRun[], files: ChangedFile[] | null): Report {
  const changed = files ?? build.changedFiles ?? [];
  const verify = latest(checkRuns, 'verify');
  const checks = verify.length ? verify : latest(checkRuns, 'baseline');
  const passed = checks.filter((c) => c.status === 'passed').length;
  const agent = build.agent;
  const split = splitShipList(agent?.summary ?? '');
  const todos = [...split.todos];
  for (const r of build.risks ?? []) if (!todos.includes(r.detail)) todos.push(r.detail);

  const commands: ReportCommand[] = checks.map((c) => ({
    command: c.command,
    ok: c.status === 'passed',
    durationMs: c.durationMs,
    from: 'check' as const,
    note: c.status === 'passed' ? '' : c.status.replace('_', ' '),
  }));
  for (const s of agent?.steps ?? []) {
    if (s.tool === 'Bash') commands.push({ command: s.target, ok: s.ok, durationMs: null, from: 'claude', note: s.ok ? '' : 'not allowed' });
  }

  let headline: string;
  let tone: ReportTone;
  const failing = checks.length - passed;
  if (build.status === 'completed') {
    headline = 'Kept';
    tone = 'ok';
  } else if (build.status === 'abandoned') {
    headline = 'Undone';
    tone = 'neutral';
  } else if (agent && agent.status !== 'done') {
    headline = agent.status === 'blocked' ? 'Claude stopped: it needs something from you' : 'Claude stopped before finishing';
    tone = 'warn';
  } else if (failing > 0) {
    headline = `Ready, but ${failing} of ${checks.length} ${checks.length === 1 ? 'check is' : 'checks are'} failing`;
    tone = 'danger';
  } else if (changed.length === 0) {
    headline = 'Nothing changed';
    tone = 'neutral';
  } else {
    headline = 'Ready for your review';
    tone = 'ok';
  }

  return {
    headline,
    tone,
    summary: split.summary,
    checks: { passed, total: checks.length },
    files: changed,
    added: changed.reduce((n, f) => n + f.added, 0),
    removed: changed.reduce((n, f) => n + f.removed, 0),
    costUsd: agent?.costUsd ?? 0,
    commands,
    todos,
  };
}

/**
 * The record of why a change with open points was kept, when the person did
 * not write one. Keeping stays one tap; the record still says what was open.
 */
export function keepNote(build: Build, note: string): string | null {
  const own = note.trim();
  if (own.length >= 10 || !build.risks?.length) return own || null;
  const open = build.risks.length;
  return `${own ? `${own} ` : ''}Kept from the review with ${open} open ${open === 1 ? 'point' : 'points'}: ${build.risks.map((r) => r.kind.replace(/_/g, ' ')).join(', ')}.`;
}

export interface FileGroup {
  /** The folder, or '' for the repository root. */
  dir: string;
  files: (ChangedFile & { name: string })[];
}

/** Changed files grouped by folder, folders in order, for a compact tree. */
export function groupFiles(files: ChangedFile[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const f of files) {
    const cut = f.path.lastIndexOf('/');
    const dir = cut < 0 ? '' : f.path.slice(0, cut);
    const g = groups.get(dir) ?? { dir, files: [] };
    g.files.push({ ...f, name: f.path.slice(cut + 1) });
    groups.set(dir, g);
  }
  return [...groups.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m} m ${Math.round((ms % 60_000) / 1_000)} s`;
}
