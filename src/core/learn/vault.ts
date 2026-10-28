// Session wrap-up and the Vault (M14: FR-LEARN-004, TOOL-LEARN-004/010, DEC-030).
//
//   the app's own records for a period → a summary of decisions, progress,
//   blockers, next steps and assumptions → saved to the Vault inbox only when
//   the person asks → kept or archived by the person
//
// The summary is built from recorded facts, without a model call, and each
// line says what it rests on: a decision the person recorded is "confirmed",
// a fact the person marked as assumed is an "assumption", and a next step the
// app suggests from open work is "inferred". A saved summary is a note, never a
// rule: a line becomes a preference only through a proposal the person approves.

import { ValidationError } from '../errors.ts';
import { allowedTransitions } from '../workflow.ts';
import type { AuditEvent, Workspace } from '../workspace.ts';
import { Preferences, type Preference } from './preferences.ts';

export type NoteKind = 'session' | 'note' | 'lesson';
export type NoteStatus = 'inbox' | 'kept' | 'archived';

export interface SummaryItem {
  text: string;
  /** confirmed = recorded decision or fact; assumption = marked as assumed by the person; inferred = suggested by the app. */
  basis: 'confirmed' | 'assumption' | 'inferred';
  ref: { type: string; id: string } | null;
  at: string | null;
  projectId: string | null;
}

export interface SessionSummary {
  from: string;
  to: string;
  projects: { id: string; name: string }[];
  decisions: SummaryItem[];
  progress: SummaryItem[];
  blockers: SummaryItem[];
  nextSteps: SummaryItem[];
  assumptions: SummaryItem[];
  /** Recorded events in the period. */
  events: number;
}

export interface VaultNote {
  id: string;
  /** Shown as NOTE-<number>. */
  number: number;
  kind: NoteKind;
  title: string;
  body: string;
  summary: SessionSummary | null;
  projectId: string | null;
  status: NoteStatus;
  source: { type: 'wrap_up' | 'person'; summary: string };
  createdAt: string;
  updatedAt: string;
}

const MAX_ITEMS = 40;
const MAX_HOURS = 24 * 31;
/** Events that record a choice the person made. */
const DECISIONS = new Set(['plan.approved', 'update.approved', 'update.dismissed', 'cleanup.approved', 'build.protected_approved', 'release.exception', 'preference.approved', 'preference.removed', 'preference.rejected', 'platform.known_good']);
/** Events that record work moving forward. */
const PROGRESS = new Set(['run.created', 'build.created', 'build.started', 'build.verified', 'build.completed', 'build.abandoned', 'release.created', 'release.prepared', 'release.abandoned', 'self_assessment.completed', 'tools.scanned', 'update.checked', 'update.installed', 'assessment.scoped']);
/** Recorded often; summarised as a count. */
const COUNTED: Record<string, string> = { 'reference.imported': 'design references imported', 'improvement.created': 'improvement items added', 'build.check': 'check runs recorded', 'agent.task.created': 'agent tasks started' };

export class Vault {
  private readonly ws: Workspace;

  constructor(ws: Workspace) {
    this.ws = ws;
  }

  /**
   * Summarises a period. By default it starts where the last saved summary
   * ended, or 24 hours ago, whichever is later.
   */
  wrapUp(input: { from?: unknown; to?: unknown; hours?: unknown } = {}): SessionSummary {
    const now = this.ws.nowIso();
    const to = input.to === undefined ? now : iso(input.to, 'End');
    if (to > now) throw new ValidationError('The period cannot end in the future.');
    let from: string;
    if (input.from !== undefined) from = iso(input.from, 'Start');
    else if (input.hours !== undefined) {
      const h = Number(input.hours);
      if (!Number.isFinite(h) || h <= 0 || h > MAX_HOURS) throw new ValidationError(`Hours must be between 1 and ${MAX_HOURS}.`);
      from = new Date(Date.parse(to) - h * 3_600_000).toISOString();
    } else {
      const day = new Date(Date.parse(to) - 24 * 3_600_000).toISOString();
      const last = this.ws.listVaultNotes({ kind: 'session' })[0]?.summary?.to;
      from = last && last > day && last < to ? last : day;
    }
    if (from >= to) throw new ValidationError('The period must start before it ends.');
    return summarise(this.ws, from, to);
  }

  /** Saves the summary of a period to the Vault inbox. It is worked out again here, so the note matches the records. */
  saveWrapUp(input: { from: unknown; to: unknown; title?: unknown }): VaultNote {
    const summary = this.wrapUp({ from: input.from, to: input.to });
    const title = input.title === undefined || input.title === '' ? `Session ${summary.from.slice(0, 16).replace('T', ' ')} to ${summary.to.slice(0, 16).replace('T', ' ')}` : text(input.title, 'Title', 200);
    return this.ws.createVaultNote({ kind: 'session', title, body: renderSummary(summary), summary, projectId: summary.projects.length === 1 ? summary.projects[0]!.id : null, source: { type: 'wrap_up', summary: `Wrap-up saved by ${this.ws.actorName()}` } });
  }

  addNote(input: { title: unknown; body: unknown; projectId?: unknown }): VaultNote {
    const projectId = input.projectId ? this.ws.getProject(String(input.projectId)).id : null;
    return this.ws.createVaultNote({ kind: 'note', title: text(input.title, 'Title', 200), body: text(input.body, 'Note', 20_000), summary: null, projectId, source: { type: 'person', summary: `Written by ${this.ws.actorName()}` } });
  }

  list(filter: { status?: string; kind?: string } = {}): VaultNote[] {
    if (filter.status !== undefined && !['inbox', 'kept', 'archived'].includes(filter.status)) throw new ValidationError('Unknown status.');
    if (filter.kind !== undefined && !['session', 'note', 'lesson'].includes(filter.kind)) throw new ValidationError('Unknown kind.');
    return this.ws.listVaultNotes(filter);
  }

  resolve(ref: string): VaultNote {
    const m = /^NOTE-(\d+)$/i.exec(ref.trim());
    if (m) {
      const n = this.ws.listVaultNotes({}).find((x) => x.number === Number(m[1]));
      if (!n) throw new ValidationError(`There is no ${ref.toUpperCase()}.`);
      return n;
    }
    return this.ws.getVaultNote(ref);
  }

  /** Moves a note out of the inbox (kept), into the archive, or back to kept. */
  file(id: string, status: unknown): VaultNote {
    const n = this.resolve(id);
    if (status !== 'kept' && status !== 'archived') throw new ValidationError('A note can be kept or archived.');
    if (n.status === status) return n;
    return this.ws.updateVaultNote(n.id, { status }, { type: status === 'kept' ? 'vault.kept' : 'vault.archived', payload: { number: n.number } });
  }

  /** The person's own notes can be edited; a saved summary stays as the records showed it. */
  edit(id: string, input: { title?: unknown; body?: unknown }): VaultNote {
    const n = this.resolve(id);
    if (n.kind !== 'note') throw new ValidationError('A saved summary is a record of what happened and cannot be edited. Add a note instead.');
    if (n.status === 'archived') throw new ValidationError('Restore the note first.');
    const patch: { title?: string; body?: string } = {};
    if (input.title !== undefined) patch.title = text(input.title, 'Title', 200);
    if (input.body !== undefined) patch.body = text(input.body, 'Note', 20_000);
    return this.ws.updateVaultNote(n.id, patch, { type: 'vault.edited', payload: { number: n.number, changed: Object.keys(patch) } });
  }

  /**
   * Proposes one line of a saved summary as a preference. The line must be in
   * the note, so the proposal keeps where it came from; it still needs approval.
   */
  proposePreference(noteId: string, line: unknown, scope?: unknown, projectId?: unknown): Preference {
    const n = this.resolve(noteId);
    const wanted = text(line, 'Line', 2_000);
    const lines = n.summary ? [...n.summary.decisions, ...n.summary.progress, ...n.summary.blockers, ...n.summary.nextSteps, ...n.summary.assumptions].map((i) => i.text) : n.body.split('\n').map((l) => l.replace(/^[-*]\s*/, '').trim());
    if (!lines.includes(wanted)) throw new ValidationError(`That line is not in NOTE-${n.number}.`);
    return new Preferences(this.ws).propose({ text: wanted, scope, projectId, source: { type: 'wrap_up', summary: `From NOTE-${n.number} "${n.title}"`, ref: n.id, quote: wanted } });
  }
}

/** The summary as Markdown, for the note body and for copying elsewhere. */
export function renderSummary(s: SessionSummary): string {
  const section = (title: string, items: SummaryItem[], none: string) => [`## ${title}`, '', ...(items.length ? items.map((i) => `- ${i.text}${i.basis === 'confirmed' ? '' : ` _(${i.basis})_`}`) : [`- ${none}`]), ''];
  return [
    `# Session summary`,
    '',
    `${s.from.slice(0, 16).replace('T', ' ')} to ${s.to.slice(0, 16).replace('T', ' ')} UTC · ${s.events} recorded events${s.projects.length ? ` · ${s.projects.map((p) => p.name).join(', ')}` : ''}`,
    '',
    ...section('Decisions (confirmed)', s.decisions, 'No decisions were recorded.'),
    ...section('Progress', s.progress, 'Nothing moved forward.'),
    ...section('Blockers', s.blockers, 'Nothing is blocked.'),
    ...section('Next steps (suggested by the app)', s.nextSteps, 'No open work.'),
    ...section('Assumptions (not confirmed)', s.assumptions, 'No assumptions are recorded for these projects.'),
  ].join('\n');
}

function summarise(ws: Workspace, from: string, to: string): SessionSummary {
  const events = ws.listEventsBetween(from, to);
  const projects = new Map<string, string>();
  const projectName = (id: string | null) => {
    if (!id) return null;
    if (!projects.has(id)) projects.set(id, safe(() => ws.getProject(id).name) ?? 'a project');
    return projects.get(id)!;
  };
  for (const e of events) projectName(e.projectId);

  const decisions: SummaryItem[] = [];
  const progress: SummaryItem[] = [];
  const counts = new Map<string, number>();
  for (const e of events) {
    if (COUNTED[e.type]) {
      counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
      continue;
    }
    const item = describe(ws, e, projectName(e.projectId));
    if (!item) continue;
    if (isDecision(e)) decisions.push({ ...item, basis: 'confirmed' });
    else if (PROGRESS.has(e.type) || e.type === 'run.transitioned' || e.type === 'improvement.moved') progress.push({ ...item, basis: 'confirmed' });
  }
  for (const [type, n] of counts) progress.push({ text: `${n} ${COUNTED[type]}`, basis: 'confirmed', ref: null, at: null, projectId: null });

  const blockers: SummaryItem[] = [];
  const nextSteps: SummaryItem[] = [];
  for (const p of ws.listProjects()) {
    for (const run of ws.listRuns(p.id)) {
      if (run.state === 'blocked') {
        blockers.push({ text: `"${run.title}" in ${p.name} is blocked: ${sentence(run.blockerReason ?? 'no reason recorded')}${run.blockerResolution ? ` To resolve: ${sentence(run.blockerResolution)}` : ''}`, basis: 'confirmed', ref: { type: 'run', id: run.id }, at: run.updatedAt, projectId: p.id });
      } else if (!['completed', 'cancelled', 'failed'].includes(run.state)) {
        nextSteps.push({ text: `Move "${run.title}" in ${p.name} on from ${run.state.replace(/_/g, ' ')} (next: ${allowedTransitions(run.state, run.blockedFrom).join(', ').replace(/_/g, ' ')})`, basis: 'inferred', ref: { type: 'run', id: run.id }, at: run.updatedAt, projectId: p.id });
      }
    }
    for (const b of ws.listBuilds(p.id)) {
      if (b.status === 'review') nextSteps.push({ text: `Review and complete "${b.title}" in ${p.name}`, basis: 'inferred', ref: { type: 'build', id: b.id }, at: b.updatedAt, projectId: p.id });
      else if (b.status === 'in_progress') nextSteps.push({ text: `Continue "${b.title}" in ${p.name}`, basis: 'inferred', ref: { type: 'build', id: b.id }, at: b.updatedAt, projectId: p.id });
    }
  }
  for (const t of ws.listAgentTasks()) {
    if (t.updatedAt < from || t.updatedAt > to || !['failed', 'timed_out', 'blocked', 'permission_denied'].includes(t.status)) continue;
    blockers.push({ text: `Agent task "${t.title}" ${t.status.replace(/_/g, ' ')}: ${sentence(t.failure ?? 'no reason recorded')}${t.resolution ? ` To resolve: ${sentence(t.resolution)}` : ''}`, basis: 'confirmed', ref: { type: 'agent_task', id: t.id }, at: t.updatedAt, projectId: null });
  }
  for (const i of ws.listImprovements()) {
    if (i.status === 'blocked') blockers.push({ text: `IMP-${i.number} "${i.title}" is blocked: ${i.reason ?? 'no reason recorded'}`, basis: 'confirmed', ref: { type: 'improvement', id: i.id }, at: i.updatedAt, projectId: null });
    if (i.status === 'approved') nextSteps.push({ text: `Start work on IMP-${i.number} "${i.title}"`, basis: 'inferred', ref: { type: 'improvement', id: i.id }, at: i.updatedAt, projectId: null });
  }
  for (const u of ws.listUpdates({})) {
    if (u.stage === 'approved') nextSteps.push({ text: `Install "${u.title}" yourself, then check for updates again`, basis: 'inferred', ref: { type: 'update', id: u.id }, at: u.updatedAt, projectId: null });
  }
  for (const p of ws.listPreferences({ status: 'proposed' })) {
    nextSteps.push({ text: `Approve, edit or reject the proposed preference PREF-${p.number}`, basis: 'inferred', ref: { type: 'preference', id: p.id }, at: p.updatedAt, projectId: p.projectId });
  }
  const inbox = ws.listVaultNotes({ status: 'inbox' }).length;
  if (inbox) nextSteps.push({ text: `Sort ${inbox} note${inbox === 1 ? '' : 's'} in the Vault inbox`, basis: 'inferred', ref: null, at: null, projectId: null });

  const assumptions: SummaryItem[] = [];
  for (const [id, name] of projects) {
    const project = safe(() => ws.getProject(id));
    for (const f of project?.facts ?? []) if (f.kind === 'assumption') assumptions.push({ text: `${name}: ${f.text}`, basis: 'assumption', ref: { type: 'project', id }, at: null, projectId: id });
  }

  return {
    from,
    to,
    projects: [...projects].map(([id, name]) => ({ id, name })),
    decisions: decisions.slice(-MAX_ITEMS),
    progress: progress.slice(-MAX_ITEMS),
    blockers: blockers.slice(0, MAX_ITEMS),
    nextSteps: nextSteps.slice(0, MAX_ITEMS),
    assumptions: assumptions.slice(0, MAX_ITEMS),
    events: events.length,
  };
}

const isDecision = (e: AuditEvent) =>
  DECISIONS.has(e.type) ||
  (e.type === 'improvement.moved' && ['approved', 'rejected'].includes(String(e.payload.to))) ||
  (e.type === 'run.transitioned' && ['approved', 'cancelled'].includes(String(e.payload.to))) ||
  e.type === 'setting.changed';

/** One line for an event, naming the record it is about. Null for events the summary leaves out. */
function describe(ws: Workspace, e: AuditEvent, project: string | null): Omit<SummaryItem, 'basis'> | null {
  const p = e.payload;
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : null);
  const inProject = project ? ` in ${project}` : '';
  const base = { at: e.at, projectId: e.projectId };
  const build = () => safe(() => ws.getBuild(s('buildId')!).title) ?? 'a build';
  const update = () => safe(() => ws.getUpdate(s('updateId')!).title) ?? 'an update';
  const run = () => (e.runId ? (safe(() => ws.getRun(e.runId!).title) ?? 'a run') : 'a run');
  const release = () => safe(() => ws.getRelease(s('releaseId')!).version) ?? '?';
  switch (e.type) {
    case 'plan.approved':
      return { ...base, text: `Approved the ${s('kind') === 'spec' ? 'specification' : 'concept brief'} v${String(p.version)}${inProject}`, ref: { type: 'plan', id: s('docId') ?? '' } };
    case 'update.approved':
      return { ...base, text: `Approved the update "${update()}"`, ref: { type: 'update', id: s('updateId')! } };
    case 'update.dismissed':
      return { ...base, text: `Dismissed the update "${update()}"`, ref: { type: 'update', id: s('updateId')! } };
    case 'update.installed':
      return { ...base, text: `Saw "${update()}" installed`, ref: { type: 'update', id: s('updateId')! } };
    case 'cleanup.approved':
      return { ...base, text: 'Approved a tool cleanup', ref: { type: 'cleanup', id: s('planId')! } };
    case 'build.protected_approved':
      return { ...base, text: `Approved protected changes in "${build()}"${s('reason') ? `: ${s('reason')}` : ''}`, ref: { type: 'build', id: s('buildId')! } };
    case 'release.exception':
      return { ...base, text: `Accepted an exception to the ${s('gateId')} gate for release ${release()}${inProject}: ${s('reason') ?? ''}`.trim(), ref: { type: 'release', id: s('releaseId')! } };
    case 'preference.approved':
    case 'preference.removed':
    case 'preference.rejected': {
      const pref = safe(() => ws.getPreference(s('preferenceId')!));
      const verb = e.type === 'preference.approved' ? 'Approved' : e.type === 'preference.removed' ? 'Removed' : 'Rejected';
      return { ...base, text: `${verb} the preference PREF-${String(p.number)}${pref ? ` "${pref.text}"` : ''}`, ref: { type: 'preference', id: s('preferenceId')! } };
    }
    case 'platform.known_good':
      return { ...base, text: `Marked version ${s('version') ?? '?'} as known-good`, ref: null };
    case 'setting.changed':
      return { ...base, text: `Changed the setting ${s('key') ?? '?'}${s('to') !== null ? ` to ${s('to')}` : ''}`, ref: null };
    case 'improvement.moved': {
      const imp = safe(() => ws.getImprovement(s('improvementId')!));
      return { ...base, text: `Moved IMP-${String(p.number)}${imp ? ` "${imp.title}"` : ''} from ${String(p.from).replace(/_/g, ' ')} to ${String(p.to).replace(/_/g, ' ')}`, ref: { type: 'improvement', id: s('improvementId')! } };
    }
    case 'run.transitioned':
      return { ...base, text: `Moved "${run()}"${inProject} from ${String(p.from).replace(/_/g, ' ')} to ${String(p.to).replace(/_/g, ' ')}${s('reason') ? ` (${s('reason')})` : ''}`, ref: e.runId ? { type: 'run', id: e.runId } : null };
    case 'run.created':
      return { ...base, text: `Started the run "${run()}"${inProject}`, ref: e.runId ? { type: 'run', id: e.runId } : null };
    case 'build.created':
    case 'build.started':
    case 'build.verified':
    case 'build.completed':
    case 'build.abandoned': {
      const verb = { 'build.created': 'Planned', 'build.started': 'Started', 'build.verified': 'Checked', 'build.completed': 'Completed', 'build.abandoned': 'Abandoned' }[e.type];
      return { ...base, text: `${verb} "${build()}"${inProject}`, ref: { type: 'build', id: s('buildId')! } };
    }
    case 'release.created':
    case 'release.prepared':
    case 'release.abandoned': {
      const verb = { 'release.created': 'Started', 'release.prepared': 'Prepared (not deployed)', 'release.abandoned': 'Abandoned' }[e.type];
      return { ...base, text: `${verb} release ${release()}${inProject}`, ref: { type: 'release', id: s('releaseId')! } };
    }
    case 'self_assessment.completed':
      return { ...base, text: 'Ran the app self-assessment', ref: null };
    case 'tools.scanned':
      return { ...base, text: 'Scanned the Claude Code tools', ref: null };
    case 'update.checked':
      return { ...base, text: 'Checked for tool updates', ref: null };
    case 'assessment.scoped':
      return { ...base, text: `Started an assessment${inProject}`, ref: null };
    default:
      return null;
  }
}

const sentence = (t: string) => (/[.!?]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function iso(v: unknown, label: string): string {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new ValidationError(`${label} must be a date and time.`);
  return new Date(v).toISOString();
}

function text(v: unknown, label: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new ValidationError(`${label} is required.`);
  const t = v.trim();
  if (t.length > max) throw new ValidationError(`${label} is longer than ${max} characters.`);
  return t;
}
