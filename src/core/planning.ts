// Planning documents (M5: FR-PLAN-001, ROADMAP Phase 3). A project has a
// concept brief and a specification, each kept as numbered versions. A draft
// can be edited; an approved version never changes. Revising an approved
// document creates the next version, and approving it records what changed
// and why (FR-PLAN-001: changes are recorded, never silently overwritten).
//
// This file holds the pure parts: shapes, validation, requirement IDs,
// comparison and Markdown. Storage is in workspace.ts, the workflow in
// planner.ts.

import { ValidationError } from './errors.ts';
import { redactString } from './redact.ts';

export type PlanKind = 'brief' | 'spec';
export type PlanStatus = 'draft' | 'approved' | 'superseded' | 'discarded';

export const BRIEF_FIELDS = [
  'goals',
  'users',
  'useCases',
  'scope',
  'nonGoals',
  'confirmed',
  'assumptions',
  'dependencies',
  'risks',
  'successCriteria',
] as const;
export type BriefField = (typeof BRIEF_FIELDS)[number];
export type Brief = Record<BriefField, string[]>;

export const BRIEF_LABEL: Record<BriefField, string> = {
  goals: 'Goals',
  users: 'Users',
  useCases: 'Use cases',
  scope: 'In scope',
  nonGoals: 'Non-goals',
  confirmed: 'Confirmed facts',
  assumptions: 'Assumptions',
  dependencies: 'Dependencies',
  risks: 'Risks',
  successCriteria: 'Success criteria',
};

/** Fields that must have at least one entry before a brief can be approved. */
const BRIEF_REQUIRED: BriefField[] = ['goals', 'users', 'scope', 'successCriteria'];

export type Priority = 'MUST' | 'SHOULD' | 'COULD';
export const PRIORITIES: Priority[] = ['MUST', 'SHOULD', 'COULD'];

export interface Requirement {
  /** Stable across versions: REQ-001, REQ-002… An ID is never reused, even after the requirement is removed. */
  id: string;
  title: string;
  description: string;
  priority: Priority;
  acceptanceCriteria: string[];
}

export interface Spec {
  requirements: Requirement[];
}

export interface PlanChange {
  kind: 'added' | 'removed' | 'changed';
  /** A brief field name, or a requirement ID. */
  target: string;
  detail: string;
}

interface PlanDocBase {
  id: string;
  projectId: string;
  version: number;
  status: PlanStatus;
  /** Who wrote this version's starting text: "simulated", a model ID, or "manual". */
  source: string;
  /** Why this version differs from the previous approved one. Required to approve a revision. */
  changeNote: string | null;
  /** What changed against the previous approved version, recorded on approval. */
  changes: PlanChange[] | null;
  /** For a spec: the approved brief it was drafted from. */
  basedOn: string | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
}
export type PlanDoc = (PlanDocBase & { kind: 'brief'; content: Brief }) | (PlanDocBase & { kind: 'spec'; content: Spec });

/** Text the simulated drafter leaves for a person to fill in. Nothing with it can be approved. */
export const TODO = 'TODO:';

const MAX_ITEMS = 100;
const MAX_ITEM = 2_000;
const MAX_REQUIREMENTS = 200;
const REQ_ID = /^REQ-(\d{3,})$/;

function list(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new ValidationError(`${label} must be a list of text items.`);
  const items = (value as string[]).map((v) => v.trim()).filter(Boolean);
  if (items.length > MAX_ITEMS) throw new ValidationError(`${label} can have at most ${MAX_ITEMS} items.`);
  for (const item of items) if (item.length > MAX_ITEM) throw new ValidationError(`An item in ${label} is longer than ${MAX_ITEM} characters.`);
  return items.map(redactString);
}

export function normalizeBrief(value: unknown): Brief {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('The brief must be an object.');
  const v = value as Record<string, unknown>;
  const unknown = Object.keys(v).filter((k) => !(BRIEF_FIELDS as readonly string[]).includes(k));
  if (unknown.length) throw new ValidationError(`Unknown brief fields: ${unknown.join(', ')}.`);
  return Object.fromEntries(BRIEF_FIELDS.map((f) => [f, list(v[f], BRIEF_LABEL[f])])) as Brief;
}

/**
 * Validates a spec and assigns IDs to new requirements. `knownIds` are the IDs
 * used in any earlier version of this project's spec: an existing requirement
 * keeps its ID, a new one (empty ID) gets the next unused number, and an ID
 * that was never issued is rejected so IDs cannot be invented or reused.
 */
export function normalizeSpec(value: unknown, knownIds: Set<string>): Spec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('The specification must be an object.');
  const raw = (value as { requirements?: unknown }).requirements;
  if (!Array.isArray(raw)) throw new ValidationError('The specification needs a list of requirements.');
  if (raw.length > MAX_REQUIREMENTS) throw new ValidationError(`A specification can have at most ${MAX_REQUIREMENTS} requirements.`);
  let next = nextRequirementNumber(knownIds);
  const seen = new Set<string>();
  const requirements = raw.map((item, i): Requirement => {
    if (!item || typeof item !== 'object') throw new ValidationError(`Requirement ${i + 1} must be an object.`);
    const r = item as Record<string, unknown>;
    const text = (k: string, label: string, max: number) => {
      const s = r[k] === undefined || r[k] === null ? '' : r[k];
      if (typeof s !== 'string') throw new ValidationError(`Requirement ${i + 1}: ${label} must be text.`);
      if (s.trim().length > max) throw new ValidationError(`Requirement ${i + 1}: ${label} is longer than ${max} characters.`);
      return redactString(s.trim());
    };
    let id = text('id', 'ID', 20);
    if (id) {
      if (!knownIds.has(id)) throw new ValidationError(`Requirement ${i + 1} has the ID ${id}, which was never issued. Leave the ID empty for a new requirement.`);
    } else {
      id = formatId(next++);
    }
    if (seen.has(id)) throw new ValidationError(`${id} appears twice.`);
    seen.add(id);
    const priority = (r.priority ?? 'MUST') as Priority;
    if (!PRIORITIES.includes(priority)) throw new ValidationError(`Requirement ${id}: priority must be MUST, SHOULD or COULD.`);
    return {
      id,
      title: text('title', 'title', 200),
      description: text('description', 'description', 5_000),
      priority,
      acceptanceCriteria: list(r.acceptanceCriteria, `${id} acceptance criteria`),
    };
  });
  return { requirements };
}

export function requirementIds(spec: Spec): string[] {
  return spec.requirements.map((r) => r.id);
}

function nextRequirementNumber(known: Set<string>): number {
  let max = 0;
  for (const id of known) {
    const m = REQ_ID.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

const formatId = (n: number) => `REQ-${String(n).padStart(3, '0')}`;

/** Problems that stop a document from being approved. Empty means it can be approved. */
export function approvalProblems(doc: PlanDoc, opts: { isRevision: boolean }): string[] {
  const problems: string[] = [];
  const hasTodo = (s: string) => s.startsWith(TODO);
  if (doc.kind === 'brief') {
    for (const f of BRIEF_REQUIRED) if (doc.content[f].length === 0) problems.push(`${BRIEF_LABEL[f]} is empty.`);
    for (const f of BRIEF_FIELDS) {
      const todo = doc.content[f].filter(hasTodo).length;
      if (todo) problems.push(`${BRIEF_LABEL[f]} still has ${todo} placeholder${todo === 1 ? '' : 's'} to fill in.`);
    }
  } else {
    if (doc.content.requirements.length === 0) problems.push('The specification has no requirements.');
    for (const r of doc.content.requirements) {
      if (!r.title) problems.push(`${r.id} has no title.`);
      if (r.acceptanceCriteria.length === 0) problems.push(`${r.id} has no acceptance criteria.`);
      if ([r.title, r.description, ...r.acceptanceCriteria].some(hasTodo)) problems.push(`${r.id} still has placeholders to fill in.`);
    }
  }
  if (opts.isRevision && !doc.changeNote?.trim()) problems.push('Say why this version changes the approved one (change note).');
  return problems;
}

/** What changed from `before` to `after`. Both must be the same kind. */
export function comparePlans(before: PlanDoc, after: PlanDoc): PlanChange[] {
  if (before.kind !== after.kind) throw new ValidationError('Only versions of the same document can be compared.');
  const changes: PlanChange[] = [];
  if (before.kind === 'brief' && after.kind === 'brief') {
    for (const f of BRIEF_FIELDS) {
      const a = new Set(before.content[f]);
      const b = new Set(after.content[f]);
      for (const item of after.content[f]) if (!a.has(item)) changes.push({ kind: 'added', target: f, detail: item });
      for (const item of before.content[f]) if (!b.has(item)) changes.push({ kind: 'removed', target: f, detail: item });
    }
    return changes;
  }
  const a = new Map((before.content as Spec).requirements.map((r) => [r.id, r]));
  const b = new Map((after.content as Spec).requirements.map((r) => [r.id, r]));
  for (const [id, r] of b) {
    const old = a.get(id);
    if (!old) {
      changes.push({ kind: 'added', target: id, detail: r.title });
      continue;
    }
    const fields: string[] = [];
    if (old.title !== r.title) fields.push('title');
    if (old.description !== r.description) fields.push('description');
    if (old.priority !== r.priority) fields.push(`priority ${old.priority} → ${r.priority}`);
    if (JSON.stringify(old.acceptanceCriteria) !== JSON.stringify(r.acceptanceCriteria)) fields.push('acceptance criteria');
    if (fields.length) changes.push({ kind: 'changed', target: id, detail: fields.join(', ') });
  }
  for (const [id, r] of a) if (!b.has(id)) changes.push({ kind: 'removed', target: id, detail: r.title });
  return changes;
}

export function renderMarkdown(doc: PlanDoc, projectName: string): string {
  const title = doc.kind === 'brief' ? 'Concept brief' : 'Specification';
  const lines = [
    `# ${title}: ${projectName}`,
    '',
    `- Version: ${doc.version} (${doc.status})`,
    `- Drafted by: ${doc.source === 'simulated' ? 'simulated model (placeholder text, not AI work)' : doc.source}`,
    doc.approvedAt ? `- Approved: ${doc.approvedAt}` : '- Approved: not yet',
  ];
  if (doc.changeNote) lines.push(`- Change note: ${doc.changeNote}`);
  lines.push('');
  if (doc.kind === 'brief') {
    for (const f of BRIEF_FIELDS) {
      lines.push(`## ${BRIEF_LABEL[f]}`, '');
      lines.push(...(doc.content[f].length ? doc.content[f].map((i) => `- ${i}`) : ['_None recorded._']), '');
    }
  } else {
    for (const r of doc.content.requirements) {
      lines.push(`## ${r.id}: ${r.title} [${r.priority}]`, '');
      if (r.description) lines.push(r.description, '');
      lines.push('Acceptance criteria:', '', ...r.acceptanceCriteria.map((c) => `- [ ] ${c}`), '');
    }
  }
  if (doc.changes?.length) {
    lines.push('## Changes from the previous approved version', '');
    for (const c of doc.changes) lines.push(`- ${c.kind} ${c.target}: ${c.detail}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** The simulated drafter's brief: the person's own idea and facts, with placeholders for the rest. */
export function simulatedBrief(input: { idea: string; confirmed: string[]; assumptions: string[] }): Brief {
  const idea = input.idea.trim() || 'the project idea';
  return {
    goals: [`${TODO} state the main goal of "${idea.slice(0, 200)}" in one sentence`],
    users: [`${TODO} who will use it?`],
    useCases: [`${TODO} the main thing a user does with it`],
    scope: [`${TODO} what the first version includes`],
    nonGoals: [],
    confirmed: input.confirmed,
    assumptions: input.assumptions,
    dependencies: [],
    risks: [],
    successCriteria: [`${TODO} how you will know it works`],
  };
}

/** The simulated drafter's spec: one requirement per goal and use case of the brief, with placeholder criteria. */
export function simulatedSpec(brief: Brief): Spec {
  const sources = [...brief.goals, ...brief.useCases];
  return {
    requirements: sources.map((text) => ({
      id: '',
      title: text.slice(0, 200),
      description: '',
      priority: 'MUST' as Priority,
      acceptanceCriteria: [`${TODO} describe how to check this works`],
    })),
  };
}
