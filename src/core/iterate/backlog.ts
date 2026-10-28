// Improvement backlog (M10: FR-ITER-002, DEC-026).
//
//   self-assessment finding or typed feedback → item → idea → proposed →
//   approved (by the person) → in progress → verified (with a result) →
//   released (with a measured outcome)        plus blocked and rejected
//
// Items are never deleted. A finding that comes back adds evidence to the item it
// created; the person can also merge two items, which links them. Approving an
// item changes nothing in the app: it records the person's decision. The backlog
// cannot change approval rules, permissions or security gates.
//
// Platform work (M13): an item built as platform work is verified only when that
// build is finished, released only in a prepared platform release, and measured
// afterwards. A measurement that shows the problem came back reopens it as a
// new proposed item, because passing tests alone is not the intended benefit.

import { randomUUID } from 'node:crypto';
import { ValidationError } from '../errors.ts';
import type { Build, Measurement, Workspace } from '../workspace.ts';
import { selfAssess, TELEMETRY_GAPS, type Level, type Occurrence, type SelfAssessmentReport } from './assess.ts';

export const IMPROVEMENT_STATUSES = ['idea', 'proposed', 'approved', 'in_progress', 'verified', 'released', 'blocked', 'rejected'] as const;
export type ImprovementStatus = (typeof IMPROVEMENT_STATUSES)[number];
export const LEVELS = ['low', 'medium', 'high'] as const;

export interface Evidence {
  at: string;
  source: 'self_assessment' | 'feedback' | 'merge' | 'measurement';
  summary: string;
  /** The self-assessment it came from. */
  assessmentId: string | null;
  occurrences: Occurrence[];
}

export interface Improvement {
  id: string;
  /** Shown as IMP-<number>. */
  number: number;
  title: string;
  problem: string;
  evidence: Evidence[];
  expectedOutcome: string;
  successCriteria: string;
  priority: Level;
  risk: Level;
  /** Other improvements that must be released first. */
  dependencies: string[];
  status: ImprovementStatus;
  blockedFrom: ImprovementStatus | null;
  /** Why it is blocked or rejected, or why it was reopened. */
  reason: string | null;
  source: 'self_assessment' | 'feedback';
  /** For items from a self-assessment: the finding they track. */
  signature: string | null;
  approver: string | null;
  approvedAt: string | null;
  result: string | null;
  measuredOutcome: string | null;
  mergedInto: string | null;
  /** A follow-up (M13): the released item whose measured outcome showed the problem came back. */
  reopens: string | null;
  createdAt: string;
  updatedAt: string;
  releasedAt: string | null;
}

export interface SelfAssessmentRecord {
  id: string;
  at: string;
  actor: string;
  report: SelfAssessmentReport;
  /** What the run did to the backlog. */
  created: string[];
  updated: string[];
}

export interface Recurrence {
  /** Occurrences of the item's finding after approval, as of the latest self-assessment. Null when it cannot be measured. */
  sinceApproval: number | null;
  measuredAt: string | null;
  note: string;
}

export interface MoveInput {
  to: ImprovementStatus;
  reason?: string | null;
  result?: string | null;
  measuredOutcome?: string | null;
}

export interface ImprovementLink {
  id: string;
  number: number;
  title: string;
  status: ImprovementStatus;
}

export interface ImprovementDetail {
  item: Improvement;
  allowed: ImprovementStatus[];
  recurrence: Recurrence;
  dependencies: ImprovementLink[];
  mergedFrom: ImprovementLink[];
  mergedInto: ImprovementLink | null;
  /** Platform work (M13). */
  builds: { id: string; title: string; status: Build['status'] }[];
  /** Prepared platform releases that include a finished build of this item. */
  releases: { id: string; version: string }[];
  measurements: Measurement[];
  reopens: ImprovementLink | null;
  reopenedBy: ImprovementLink | null;
}

/** What platform work exists for an item, for the moves that depend on it. */
export interface PlatformLinks {
  builds: Pick<Build, 'status'>[];
  preparedReleases: number;
}

/** Days a detector item must stay quiet after release before it counts as improved. */
export const QUIET_DAYS = 7;

export interface ImprovementsOverview {
  items: Improvement[];
  counts: Record<ImprovementStatus, number>;
  latest: SelfAssessmentRecord | null;
  gaps: string[];
}

export type ImprovementEdit = Partial<Pick<Improvement, 'title' | 'problem' | 'expectedOutcome' | 'successCriteria' | 'priority' | 'risk' | 'dependencies'>>;

const MOVES: Record<ImprovementStatus, readonly ImprovementStatus[]> = {
  idea: ['proposed', 'blocked', 'rejected'],
  proposed: ['approved', 'idea', 'blocked', 'rejected'],
  approved: ['in_progress', 'proposed', 'blocked', 'rejected'],
  in_progress: ['verified', 'approved', 'blocked', 'rejected'],
  verified: ['released', 'in_progress', 'blocked'],
  released: [],
  blocked: [], // back to where it was blocked from, or rejected
  rejected: ['idea'],
};

/** The definition can change until the person approves it. */
const EDITABLE: ReadonlySet<ImprovementStatus> = new Set(['idea', 'proposed']);

const text = (v: unknown, name: string, max = 2000): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new ValidationError(`${name} must be text.`);
  const t = v.trim();
  if (t.length > max) throw new ValidationError(`${name} is too long (at most ${max} characters).`);
  return t || null;
};

/** Which moves are allowed from here, for the screen. */
export function allowedMoves(item: Improvement): ImprovementStatus[] {
  if (item.mergedInto) return [];
  if (item.status === 'blocked') return [item.blockedFrom ?? 'idea', 'rejected'];
  return [...MOVES[item.status]];
}

/** Checks a move and returns the fields it changes. `actor` is the person making it. */
export function planMove(item: Improvement, input: MoveInput, actor: string, at: string, deps: Improvement[], links: PlatformLinks = { builds: [], preparedReleases: 0 }): Partial<Improvement> {
  if (item.mergedInto) throw new ValidationError(`IMP-${item.number} was merged into another item and cannot move.`);
  const to = input.to;
  if (!IMPROVEMENT_STATUSES.includes(to)) throw new ValidationError(`Unknown status: ${String(to)}`);
  const allowed = allowedMoves(item);
  if (!allowed.includes(to)) throw new ValidationError(`IMP-${item.number} cannot move from ${item.status} to ${to}. Allowed: ${allowed.join(', ') || 'none (released is final)'}.`);
  const reason = text(input.reason, 'Reason');
  const patch: Partial<Improvement> = { status: to, reason: null, blockedFrom: null };

  if (item.status === 'blocked' && to !== 'rejected') patch.reason = reason;
  switch (to) {
    case 'proposed':
      if (!item.problem || !item.expectedOutcome || !item.successCriteria)
        throw new ValidationError('Before proposing it, write the problem, the expected outcome and how success will be measured.');
      break;
    case 'approved':
      if (item.status === 'proposed') {
        patch.approver = actor;
        patch.approvedAt = at;
      }
      break;
    case 'in_progress': {
      const open = deps.filter((d) => d.status !== 'released');
      if (open.length) throw new ValidationError(`It depends on ${open.map((d) => `IMP-${d.number}`).join(', ')}, which ${open.length === 1 ? 'is' : 'are'} not released yet.`);
      break;
    }
    case 'verified': {
      if (links.builds.length && !links.builds.some((b) => b.status === 'completed')) throw new ValidationError('Finish its platform work first: the build must pass the mandatory checks and be marked done.');
      const result = text(input.result, 'Result');
      if (!result) throw new ValidationError('Write the result: what was done and how it was checked.');
      patch.result = result;
      break;
    }
    case 'released': {
      const measured = text(input.measuredOutcome, 'Measured outcome');
      if (links.builds.length) {
        // Platform work is measured after release, from evidence (M13).
        if (!links.preparedReleases) throw new ValidationError('Include its finished platform build in a platform release and prepare that release first.');
      } else if (!measured) throw new ValidationError('Write the measured outcome against the success criteria. Passing tests alone is not a measured outcome.');
      patch.measuredOutcome = measured;
      patch.releasedAt = at;
      break;
    }
    case 'blocked':
      if (!reason) throw new ValidationError('Say what it is blocked on.');
      patch.reason = reason;
      patch.blockedFrom = item.status;
      break;
    case 'rejected':
      if (!reason) throw new ValidationError('Say why it is rejected.');
      patch.reason = reason;
      break;
    case 'idea':
      if (item.status === 'rejected') {
        if (!reason) throw new ValidationError('Say why it is reopened.');
        patch.reason = reason;
      }
      break;
  }
  // Going back before approval clears the approval, so a changed item is approved again.
  if (to === 'idea' || to === 'proposed') {
    patch.approver = null;
    patch.approvedAt = null;
  }
  return patch;
}

export class Backlog {
  private readonly ws: Workspace;
  constructor(ws: Workspace) {
    this.ws = ws;
  }

  /** Runs a self-assessment, stores it (frozen), and files or updates one backlog item per finding. */
  assess(): SelfAssessmentRecord {
    const report = selfAssess(this.ws, this.ws.nowIso());
    const id = `sas_${randomUUID()}`;
    const created: string[] = [];
    const updated: string[] = [];
    this.ws.inTransaction(() => {
      for (const f of report.findings) {
        const existing = this.ws.findImprovementBySignature(f.signature);
        if (existing) {
          const seen = new Set(existing.evidence.flatMap((e) => e.occurrences.map((o) => o.id)));
          const fresh = f.observation.occurrences.filter((o) => !seen.has(o.id));
          if (!fresh.length) continue;
          this.ws.addImprovementEvidence(existing.id, { at: report.at, source: 'self_assessment', summary: f.observation.text, assessmentId: id, occurrences: fresh });
          updated.push(existing.id);
        } else {
          const item = this.ws.createImprovement({
            title: f.recommendation.title,
            problem: f.recommendation.problem,
            expectedOutcome: f.recommendation.expectedOutcome,
            successCriteria: f.recommendation.successCriteria,
            priority: f.recommendation.priority,
            risk: f.recommendation.risk,
            status: 'proposed',
            source: 'self_assessment',
            signature: f.signature,
            evidence: [{ at: report.at, source: 'self_assessment', summary: f.observation.text, assessmentId: id, occurrences: f.observation.occurrences }],
          });
          created.push(item.id);
        }
      }
      this.ws.saveSelfAssessment({ id, report, created, updated });
    });
    return this.ws.getSelfAssessment(id);
  }

  /** Typed feedback becomes an idea. */
  feedback(input: { text: unknown; title?: unknown }): Improvement {
    const body = text(input.text, 'Feedback', 4000);
    if (!body) throw new ValidationError('Write the feedback.');
    const title = text(input.title, 'Title', 120) ?? (body.length > 80 ? `${body.slice(0, 79)}…` : body);
    return this.ws.createImprovement({
      title,
      problem: body,
      expectedOutcome: '',
      successCriteria: '',
      priority: 'medium',
      risk: 'low',
      status: 'idea',
      source: 'feedback',
      signature: null,
      evidence: [{ at: this.ws.nowIso(), source: 'feedback', summary: `Typed by ${this.ws.actorName()}`, assessmentId: null, occurrences: [] }],
    });
  }

  edit(id: string, raw: Record<string, unknown>): Improvement {
    const item = this.ws.getImprovement(id);
    if (item.mergedInto) throw new ValidationError(`IMP-${item.number} was merged into another item and cannot change.`);
    if (!EDITABLE.has(item.status)) throw new ValidationError('The item is fixed once approved. Move it back to proposed to change it.');
    const edit: ImprovementEdit = {};
    for (const [k, name, max] of [
      ['title', 'Title', 120],
      ['problem', 'Problem', 4000],
      ['expectedOutcome', 'Expected outcome', 2000],
      ['successCriteria', 'Success criteria', 2000],
    ] as const) {
      if (k in raw) {
        const v = text(raw[k], name, max);
        if (k === 'title' && !v) throw new ValidationError('An item needs a title.');
        edit[k] = v ?? '';
      }
    }
    for (const k of ['priority', 'risk'] as const) {
      if (k in raw) {
        if (!LEVELS.includes(raw[k] as Level)) throw new ValidationError(`${k === 'priority' ? 'Priority' : 'Risk'} is low, medium or high.`);
        edit[k] = raw[k] as Level;
      }
    }
    if ('dependencies' in raw) {
      if (!Array.isArray(raw.dependencies) || raw.dependencies.some((d) => typeof d !== 'string')) throw new ValidationError('Dependencies are a list of item ids.');
      const deps = [...new Set(raw.dependencies as string[])];
      for (const d of deps) {
        if (d === id) throw new ValidationError('An item cannot depend on itself.');
        this.ws.getImprovement(d);
        if (this.dependsOn(d, id)) throw new ValidationError('That would make the items depend on each other.');
      }
      edit.dependencies = deps;
    }
    if (!Object.keys(edit).length) return item;
    return this.ws.updateImprovement(id, edit, { type: 'improvement.edited', payload: { fields: Object.keys(edit) } });
  }

  move(id: string, input: MoveInput): Improvement {
    const item = this.ws.getImprovement(id);
    const patch = planMove(item, input, this.ws.actorName(), this.ws.nowIso(), item.dependencies.map((d) => this.ws.getImprovement(d)), this.links(item.id));
    return this.ws.updateImprovement(id, patch, {
      type: 'improvement.moved',
      payload: { from: item.status, to: input.to, ...(patch.reason ? { reason: patch.reason } : {}), ...(patch.approver ? { approver: patch.approver } : {}) },
    });
  }

  /** Links a duplicate to the item that stays. The duplicate keeps its history and stops moving. */
  merge(duplicateId: string, intoId: string): Improvement {
    if (duplicateId === intoId) throw new ValidationError('An item cannot be merged into itself.');
    const dup = this.ws.getImprovement(duplicateId);
    const into = this.ws.getImprovement(intoId);
    if (dup.mergedInto) throw new ValidationError(`IMP-${dup.number} is already merged.`);
    if (into.mergedInto) throw new ValidationError(`IMP-${into.number} is merged into another item; merge into that one.`);
    if (dup.status === 'released') throw new ValidationError('A released item cannot be merged.');
    this.ws.inTransaction(() => {
      this.ws.addImprovementEvidence(into.id, {
        at: this.ws.nowIso(),
        source: 'merge',
        summary: `Merged from IMP-${dup.number}: ${dup.title}`,
        assessmentId: null,
        occurrences: dup.evidence.flatMap((e) => e.occurrences),
      });
      this.ws.updateImprovement(dup.id, { mergedInto: into.id }, { type: 'improvement.merged', payload: { into: into.id } });
    });
    return this.ws.getImprovement(into.id);
  }

  overview(filter: { status?: string } = {}): ImprovementsOverview {
    if (filter.status !== undefined && !IMPROVEMENT_STATUSES.includes(filter.status as ImprovementStatus)) throw new ValidationError(`Unknown status: ${filter.status}`);
    const all = this.ws.listImprovements();
    const counts = Object.fromEntries(IMPROVEMENT_STATUSES.map((s) => [s, all.filter((i) => i.status === s).length])) as Record<ImprovementStatus, number>;
    return { items: filter.status ? all.filter((i) => i.status === filter.status) : all, counts, latest: this.ws.latestSelfAssessment(), gaps: TELEMETRY_GAPS };
  }

  /** Accepts an id or "IMP-<number>". */
  resolve(ref: string): Improvement {
    const m = /^IMP-(\d+)$/i.exec(ref.trim());
    if (!m) return this.ws.getImprovement(ref);
    const found = this.ws.listImprovements({ includeMerged: true }).find((i) => i.number === Number(m[1]));
    if (!found) throw new ValidationError(`No improvement ${ref.toUpperCase()}.`);
    return found;
  }

  detail(id: string): ImprovementDetail {
    const item = this.ws.getImprovement(id);
    const link = (i: Improvement): ImprovementLink => ({ id: i.id, number: i.number, title: i.title, status: i.status });
    return {
      item,
      allowed: allowedMoves(item),
      recurrence: this.recurrence(item),
      dependencies: item.dependencies.map((d) => link(this.ws.getImprovement(d))),
      mergedFrom: this.ws.listImprovements({ includeMerged: true }).filter((i) => i.mergedInto === item.id).map(link),
      mergedInto: item.mergedInto ? link(this.ws.getImprovement(item.mergedInto)) : null,
      builds: this.ws.listBuildsForSource(item.id).map((b) => ({ id: b.id, title: b.title, status: b.status })),
      releases: this.preparedReleases(item.id),
      measurements: this.ws.listMeasurements(item.id),
      reopens: item.reopens ? link(this.ws.getImprovement(item.reopens)) : null,
      reopenedBy: ((r) => (r ? link(r) : null))(this.ws.reopenedBy(item.id)),
    };
  }

  /**
   * Measures a released item from the self-assessment record (M13). The
   * problem coming back means it did not work: a follow-up item is proposed.
   * No recurrence for QUIET_DAYS after release means it worked. Anything else
   * is too early to say.
   */
  measure(id: string): Measurement {
    const item = this.ws.getImprovement(id);
    if (item.status !== 'released' || !item.releasedAt) throw new ValidationError(`IMP-${item.number} is not released yet. Measure it after release.`);
    if (!this.signatures(item).size) throw new ValidationError('This item has no detector to count. Record the outcome yourself against its success criteria.');
    const latest = this.ws.latestSelfAssessment();
    if (!latest || latest.at <= item.releasedAt) {
      return this.ws.recordMeasurement({ improvementId: id, method: 'recurrence', verdict: 'too_early', recurrences: null, assessmentId: latest?.id ?? null, detail: 'No self-assessment has run since the release. Run one after using the new version for a while.', followupId: null });
    }
    const sigs = this.signatures(item);
    const after = latest.report.findings.filter((f) => sigs.has(f.signature)).flatMap((f) => f.observation.occurrences).filter((o) => o.at > item.releasedAt!);
    if (after.length) {
      return this.reopen(item, `The problem came back ${after.length} time${after.length === 1 ? '' : 's'} after the release (self-assessment ${latest.at.slice(0, 10)}).`, 'recurrence', after.length, latest.id, after);
    }
    const quietDays = (Date.parse(latest.at) - Date.parse(item.releasedAt)) / 86_400_000;
    if (quietDays < QUIET_DAYS) {
      return this.ws.recordMeasurement({ improvementId: id, method: 'recurrence', verdict: 'too_early', recurrences: 0, assessmentId: latest.id, detail: `Not seen since the release, but only ${Math.floor(quietDays)} of ${QUIET_DAYS} days have passed. Measure again later.`, followupId: null });
    }
    return this.ws.recordMeasurement({ improvementId: id, method: 'recurrence', verdict: 'improved', recurrences: 0, assessmentId: latest.id, detail: `Not seen in the ${Math.floor(quietDays)} days since the release (self-assessment ${latest.at.slice(0, 10)}). Success criteria: ${item.successCriteria}`, followupId: null });
  }

  /** The person's own judgement against the success criteria, for items no detector can count. */
  recordOutcome(id: string, verdict: unknown, detail: unknown): Measurement {
    const item = this.ws.getImprovement(id);
    if (item.status !== 'released' || !item.releasedAt) throw new ValidationError(`IMP-${item.number} is not released yet. Record the outcome after release.`);
    if (verdict !== 'improved' && verdict !== 'not_improved') throw new ValidationError('The outcome is "improved" or "not_improved".');
    const body = text(detail, 'What you observed');
    if (!body || body.length < 10) throw new ValidationError('Write what you observed against the success criteria (at least 10 characters). Passing tests alone is not an outcome.');
    if (verdict === 'not_improved') return this.reopen(item, body, 'person', null, null, []);
    return this.ws.recordMeasurement({ improvementId: id, method: 'person', verdict: 'improved', recurrences: null, assessmentId: null, detail: body, followupId: null });
  }

  /** Records "not improved" and proposes a follow-up that tracks the same finding. One follow-up per item. */
  private reopen(item: Improvement, detail: string, method: Measurement['method'], recurrences: number | null, assessmentId: string | null, occurrences: Occurrence[]): Measurement {
    return this.ws.inTransaction(() => {
      let follow = this.ws.reopenedBy(item.id);
      if (!follow) {
        follow = this.ws.createImprovement({
          title: `Reopened: ${item.title}`.slice(0, 120),
          problem: `IMP-${item.number} was released but did not have the intended effect. ${detail}\n\nOriginal problem: ${item.problem}`.slice(0, 4000),
          expectedOutcome: item.expectedOutcome,
          successCriteria: item.successCriteria,
          priority: item.priority,
          risk: item.risk,
          status: 'proposed',
          source: item.source,
          signature: null,
          reopens: item.id,
          evidence: [{ at: this.ws.nowIso(), source: 'measurement', summary: detail, assessmentId, occurrences }],
        });
      }
      return this.ws.recordMeasurement({ improvementId: item.id, method, verdict: 'not_improved', recurrences, assessmentId, detail, followupId: follow.id });
    });
  }

  private links(id: string): PlatformLinks {
    return { builds: this.ws.listBuildsForSource(id), preparedReleases: this.preparedReleases(id).length };
  }

  private preparedReleases(id: string): { id: string; version: string }[] {
    const project = this.ws.maintenanceProject();
    if (!project) return [];
    const done = new Set(this.ws.listBuildsForSource(id).filter((b) => b.status === 'completed').map((b) => b.id));
    if (!done.size) return [];
    return this.ws.listReleases(project.id).filter((r) => r.status === 'prepared' && r.buildIds.some((b) => done.has(b))).map((r) => ({ id: r.id, version: r.version }));
  }

  /** The findings an item tracks: its own, its merged duplicates', and for a follow-up, the item it reopens. */
  private signatures(item: Improvement, seen = new Set<string>()): Set<string> {
    const out = new Set<string>();
    if (seen.has(item.id)) return out;
    seen.add(item.id);
    if (item.signature) out.add(item.signature);
    for (const m of this.ws.listImprovements({ includeMerged: true }).filter((i) => i.mergedInto === item.id)) for (const s of this.signatures(m, seen)) out.add(s);
    if (item.reopens) for (const s of this.signatures(this.ws.getImprovement(item.reopens), seen)) out.add(s);
    return out;
  }

  /** How often the item's finding came back after it was approved (detector items only). */
  recurrence(item: Improvement): Recurrence {
    const signatures = this.signatures(item);
    if (!signatures.size) return { sinceApproval: null, measuredAt: null, note: 'Typed feedback has no detector to count; write the measured outcome yourself.' };
    if (!item.approvedAt) return { sinceApproval: null, measuredAt: null, note: 'Counted from approval.' };
    const latest = this.ws.latestSelfAssessment();
    if (!latest || latest.at <= item.approvedAt) return { sinceApproval: null, measuredAt: null, note: 'Run a self-assessment after approval to count recurrences.' };
    const after = latest.report.findings.filter((f) => signatures.has(f.signature)).flatMap((f) => f.observation.occurrences).filter((o) => o.at > item.approvedAt!);
    return { sinceApproval: after.length, measuredAt: latest.at, note: after.length ? 'The problem came back after approval.' : 'Not seen since approval.' };
  }

  private dependsOn(from: string, target: string, seen = new Set<string>()): boolean {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return this.ws.getImprovement(from).dependencies.some((d) => this.dependsOn(d, target, seen));
  }
}
