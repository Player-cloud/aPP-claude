// Planning workflow (M5: FR-PLAN-001, FR-PLAN-002). Idea → concept brief →
// specification, each drafted by the model (simulated or Claude), edited by
// the person, and approved. Model output is untrusted: it is validated like
// any other input, the person's confirmed facts are never taken from it, and
// requirement IDs are assigned here, never by the model.

import { guardedCall } from './agents/guard.ts';
import type { ModelAdapter } from './agents/model.ts';
import { ModelCallError, ValidationError } from './errors.ts';
import {
  approvalProblems,
  comparePlans,
  normalizeBrief,
  normalizeSpec,
  requirementIds,
  type Brief,
  type PlanChange,
  type PlanDoc,
  type PlanKind,
  type Spec,
} from './planning.ts';
import type { ToolScan } from './tools.ts';
import type { Workspace } from './workspace.ts';

const TIMEOUT_MS = 300_000;
const MAX_OUTPUT_TOKENS = 12_000;

export interface EgmStatus {
  /** `not_scanned`: no tool scan yet; `not_found`: no EGM in the scan; `found_unverified`: EGM-like tools exist but no adapter has been verified. */
  state: 'not_scanned' | 'not_found' | 'found_unverified';
  message: string;
  evidence: string[];
}

export interface PlanningOverview {
  brief: { approved: PlanDoc | null; draft: PlanDoc | null; versions: PlanDoc[] };
  spec: { approved: PlanDoc | null; draft: PlanDoc | null; versions: PlanDoc[] };
  /** True when the approved spec was drafted from a brief that has since been revised. */
  specOutdated: boolean;
  egm: EgmStatus;
}

export class Planner {
  private readonly ws: Workspace;
  private readonly model: ModelAdapter;

  constructor(ws: Workspace, model: ModelAdapter) {
    this.ws = ws;
    this.model = model;
  }

  overview(projectId: string): PlanningOverview {
    const part = (kind: PlanKind) => ({
      approved: this.ws.approvedPlanDoc(projectId, kind),
      draft: this.ws.openPlanDraft(projectId, kind),
      versions: this.ws.listPlanDocs(projectId, kind),
    });
    const brief = part('brief');
    const spec = part('spec');
    return {
      brief,
      spec,
      specOutdated: Boolean(spec.approved && brief.approved && spec.approved.basedOn !== brief.approved.id),
      egm: egmStatus(this.ws.latestToolScan()),
    };
  }

  /** Drafts a brief from the project's idea and facts. */
  async draftBrief(projectId: string): Promise<PlanDoc> {
    const project = this.ws.getProject(projectId);
    this.ensureNoDraft(projectId, 'brief');
    const confirmed = project.facts.filter((f) => f.kind === 'confirmed').map((f) => f.text);
    const assumptions = project.facts.filter((f) => f.kind === 'assumption').map((f) => f.text);
    const input = { idea: project.idea ?? project.name, confirmed, assumptions };
    const raw = await this.ask('brief', project.name, input);
    const brief = normalizeBrief(raw);
    // Confirmed facts come from the person only. Anything else the model "confirmed" is kept as an assumption.
    const extra = brief.confirmed.filter((c) => !confirmed.includes(c));
    const content: Brief = { ...brief, confirmed, assumptions: [...new Set([...brief.assumptions, ...assumptions, ...extra])] };
    return this.ws.createPlanDoc({ projectId, kind: 'brief', content, source: this.model.id, basedOn: null, changeNote: null });
  }

  /** Drafts a specification from the approved brief. */
  async draftSpec(projectId: string): Promise<PlanDoc> {
    const project = this.ws.getProject(projectId);
    const brief = this.ws.approvedPlanDoc(projectId, 'brief');
    if (!brief) throw new ValidationError('Approve the concept brief before drafting the specification.');
    this.ensureNoDraft(projectId, 'spec');
    const raw = (await this.ask('spec', project.name, brief.content)) as { requirements?: Record<string, unknown>[] };
    // IDs are assigned here; any the model invented are dropped.
    const requirements = Array.isArray(raw?.requirements) ? raw.requirements.map((r) => ({ ...r, id: '' })) : raw?.requirements;
    const content = normalizeSpec({ requirements }, this.knownIds(projectId));
    const previous = this.ws.approvedPlanDoc(projectId, 'spec');
    return this.ws.createPlanDoc({
      projectId,
      kind: 'spec',
      content,
      source: this.model.id,
      basedOn: brief.id,
      changeNote: previous ? `Redrafted from brief version ${brief.version}.` : null,
    });
  }

  saveDraft(docId: string, input: { content: unknown; changeNote?: string | null }): PlanDoc {
    const doc = this.ws.getPlanDoc(docId);
    const content = doc.kind === 'brief' ? normalizeBrief(input.content) : normalizeSpec(input.content, this.knownIds(doc.projectId, doc));
    const changeNote = input.changeNote === undefined ? undefined : input.changeNote?.trim().slice(0, 2_000) || null;
    return this.ws.updatePlanDraft(docId, { content, changeNote });
  }

  approve(docId: string): PlanDoc {
    const doc = this.ws.getPlanDoc(docId);
    const previous = this.ws.approvedPlanDoc(doc.projectId, doc.kind);
    const problems = approvalProblems(doc, { isRevision: Boolean(previous) });
    let basedOn = doc.basedOn;
    if (doc.kind === 'spec') {
      const brief = this.ws.approvedPlanDoc(doc.projectId, 'brief');
      if (!brief) problems.push('The concept brief is not approved.');
      basedOn = brief?.id ?? null;
    }
    if (problems.length) throw new ValidationError(`Version ${doc.version} cannot be approved yet:\n- ${problems.join('\n- ')}`);
    return this.ws.approvePlanDoc(docId, previous ? comparePlans(previous, doc) : null, basedOn);
  }

  /** Starts the next version of an approved document. The approved version itself never changes. */
  revise(docId: string): PlanDoc {
    const doc = this.ws.getPlanDoc(docId);
    if (doc.status !== 'approved') throw new ValidationError('Only the approved version can be revised.');
    this.ensureNoDraft(doc.projectId, doc.kind);
    return this.ws.createPlanDoc({ projectId: doc.projectId, kind: doc.kind, content: doc.content, source: 'manual', basedOn: doc.basedOn, changeNote: null });
  }

  discard(docId: string): PlanDoc {
    return this.ws.discardPlanDraft(docId);
  }

  compare(beforeId: string, afterId: string): PlanChange[] {
    const before = this.ws.getPlanDoc(beforeId);
    const after = this.ws.getPlanDoc(afterId);
    if (before.projectId !== after.projectId) throw new ValidationError('Both versions must belong to the same project.');
    return comparePlans(before, after);
  }

  private ensureNoDraft(projectId: string, kind: PlanKind): void {
    if (this.ws.openPlanDraft(projectId, kind)) throw new ValidationError(`This project already has a ${kind === 'brief' ? 'brief' : 'specification'} draft. Edit or discard it first.`);
  }

  /** Every requirement ID ever issued in this project, so IDs are kept stable and never reused. */
  private knownIds(projectId: string, include?: PlanDoc): Set<string> {
    const docs = this.ws.listPlanDocs(projectId, 'spec');
    if (include) docs.push(include);
    return new Set(docs.flatMap((d) => requirementIds(d.content as Spec)));
  }

  private async ask(purpose: 'brief' | 'spec', title: string, input: unknown): Promise<unknown> {
    const outcome = await guardedCall(
      this.ws,
      this.model,
      { purpose, taskTitle: title, instructions: JSON.stringify(input), maxOutputTokens: MAX_OUTPUT_TOKENS },
      { taskId: null, timeoutMs: TIMEOUT_MS },
    );
    if (!outcome.ok) throw new ModelCallError(outcome.status, `${outcome.failure} ${outcome.resolution}`);
    try {
      return JSON.parse(outcome.response.text);
    } catch {
      throw new ModelCallError('failed', 'The draft was not valid JSON, so nothing was saved. Try again.');
    }
  }
}

/** FR-PLAN-002: EGM is discovered from the tool inventory, never assumed. Finding it does not mean it ran. */
export function egmStatus(scan: ToolScan | null): EgmStatus {
  if (!scan) {
    return { state: 'not_scanned', message: 'EGM was not checked: run a tool scan first. Planning uses the built-in workflow.', evidence: [] };
  }
  const hits = scan.entries.filter((e) => /\begm\b|elephant[-_ ]?goldfish/i.test(`${e.name} ${e.invocation ?? ''} ${e.scopeDetail ?? ''}`));
  if (!hits.length) {
    return { state: 'not_found', message: 'EGM is not installed, so no EGM brainstorm, review or drift report ran. Planning uses the built-in workflow.', evidence: [] };
  }
  return {
    state: 'found_unverified',
    message: 'EGM-like tools were found, but this app has not verified or connected them yet, so no EGM step ran. Planning uses the built-in workflow.',
    evidence: hits.map((e) => `${e.invocation ?? e.name} (${e.kind}, ${e.source})`),
  };
}
