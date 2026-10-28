// Skill proposals from repeated work (M14: FR-LEARN-003, TOOL-LEARN-003, DEC-031).
//
//   builds, workflow runs and agent requests in the records → groups of three
//   or more alike → a proposal with the examples, a trigger, the steps, the
//   permissions, tests and the expected benefit → checked against the skills
//   and commands in the latest tool scan → the person edits, approves or
//   rejects it → an approved proposal can be exported as a SKILL.md file
//
// Nothing is installed. Export writes one new file to a folder the person
// picks and refuses Claude Code's own folders, so a proposal can never turn
// itself on; the person copies it there themselves if they want it.

import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { ValidationError } from '../errors.ts';
import type { ToolScan } from '../tools.ts';
import type { Workspace } from '../workspace.ts';
import { jaccard, keywords } from './preferences.ts';

export interface SkillExample {
  kind: 'build' | 'run' | 'request';
  id: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
  at: string;
  /** Model spend recorded for it, when the records have it. */
  costUsd: number | null;
}

export interface SkillDraft {
  /** Lowercase words joined by hyphens, as Claude Code expects. */
  name: string;
  /** When to use it: the trigger. */
  description: string;
  workflow: string[];
  permissions: string[];
  tests: string[];
  benefit: string;
}

export interface SkillDuplicate {
  /** A tool scan entry id, or a proposal id. */
  id: string;
  name: string;
  kind: 'skill' | 'command' | 'proposal';
  where: string;
  similarity: number;
  why: string;
}

export interface SkillDecision {
  id: string;
  /** The person says the proposal does something different, and why. */
  note: string;
}

export type SkillStatus = 'proposed' | 'approved' | 'rejected';

export interface SkillProposal {
  id: string;
  /** Shown as SKL-<number>. */
  number: number;
  /** The shared words of the examples; one proposal per signature. */
  signature: string;
  examples: SkillExample[];
  draft: SkillDraft;
  /** The app's first draft, kept to show what the person changed. */
  proposedDraft: SkillDraft;
  duplicates: SkillDuplicate[];
  /** The tool scan the duplicate check used; null when there was none. */
  scanId: string | null;
  scannedAt: string | null;
  decisions: SkillDecision[];
  status: SkillStatus;
  approver: string | null;
  approvedAt: string | null;
  reason: string | null;
  exports: { path: string; at: string; by: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface DetectResult {
  created: SkillProposal[];
  /** Groups already proposed, by proposal number. */
  known: number[];
  /** Pieces of work looked at. */
  looked: number;
}

export const MIN_REPEATS = 3;
const SIMILAR_AT = 0.5;
const DUPLICATE_AT = 0.3;
const MAX_EXAMPLES = 12;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class Skills {
  private readonly ws: Workspace;

  constructor(ws: Workspace) {
    this.ws = ws;
  }

  /** Looks for repeated work and records a proposal for each new group. Nothing is approved or written to disk. */
  detect(): DetectResult {
    const items = this.work();
    const groups = cluster(items);
    const existing = this.ws.listSkillProposals();
    const result: DetectResult = { created: [], known: [], looked: items.length };
    for (const g of groups) {
      const signature = [...g.common].sort().join(' ');
      const same = existing.find((p) => p.signature === signature || jaccard(new Set(p.signature.split(' ')), g.common) >= 0.8);
      if (same) {
        result.known.push(same.number);
        continue;
      }
      const draft = draftFor(g.items, g.common, existing);
      const scan = this.ws.latestToolScan();
      const p = this.ws.createSkillProposal({ signature, examples: g.items.map((i) => i.example).slice(0, MAX_EXAMPLES), draft, duplicates: duplicatesOf(draft, scan, existing), scanId: scan?.id ?? null, scannedAt: scan?.scannedAt ?? null });
      existing.push(p);
      result.created.push(p);
    }
    return result;
  }

  list(filter: { status?: string } = {}): SkillProposal[] {
    if (filter.status !== undefined && !['proposed', 'approved', 'rejected'].includes(filter.status)) throw new ValidationError('Unknown status.');
    return this.ws.listSkillProposals(filter.status as SkillStatus | undefined);
  }

  /** Accepts an id or "SKL-<number>". */
  resolve(ref: string): SkillProposal {
    const m = /^SKL-(\d+)$/i.exec(ref.trim());
    if (!m) return this.ws.getSkillProposal(ref);
    const p = this.ws.listSkillProposals().find((x) => x.number === Number(m[1]));
    if (!p) throw new ValidationError(`There is no ${ref.toUpperCase()}.`);
    return p;
  }

  /** Runs the duplicate check again when a newer tool scan exists. */
  recheck(ref: string): SkillProposal {
    const p = this.resolve(ref);
    const scan = this.ws.latestToolScan();
    if (p.status !== 'proposed' || !scan || scan.id === p.scanId) return p;
    const duplicates = duplicatesOf(p.draft, scan, this.ws.listSkillProposals().filter((x) => x.id !== p.id));
    return this.ws.updateSkillProposal(p.id, { duplicates, scanId: scan.id, scannedAt: scan.scannedAt, decisions: p.decisions.filter((d) => duplicates.some((x) => x.id === d.id)) }, { type: 'skill.rechecked', payload: { number: p.number, duplicates: duplicates.length, scanId: scan.id } });
  }

  /** The person's changes to a proposal. The examples and the first draft never change. */
  edit(ref: string, input: Partial<Record<keyof SkillDraft, unknown>>): SkillProposal {
    const p = this.resolve(ref);
    if (p.status !== 'proposed') throw new ValidationError(`SKL-${p.number} was ${p.status} and can no longer change.`);
    const draft: SkillDraft = { ...p.draft };
    if (input.name !== undefined) draft.name = skillName(input.name);
    if (input.description !== undefined) draft.description = line(input.description, 'When to use it', 600);
    if (input.benefit !== undefined) draft.benefit = line(input.benefit, 'Expected benefit', 600);
    for (const k of ['workflow', 'permissions', 'tests'] as const) if (input[k] !== undefined) draft[k] = lines(input[k], k === 'workflow' ? 'Steps' : k === 'permissions' ? 'Permissions' : 'Tests');
    if (this.ws.listSkillProposals().some((x) => x.id !== p.id && x.status !== 'rejected' && x.draft.name === draft.name)) throw new ValidationError(`Another proposal is already called "${draft.name}".`);
    const changed = (Object.keys(draft) as (keyof SkillDraft)[]).filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(p.draft[k]));
    if (!changed.length) return p;
    const scan = this.ws.latestToolScan();
    const duplicates = duplicatesOf(draft, scan, this.ws.listSkillProposals().filter((x) => x.id !== p.id));
    return this.ws.updateSkillProposal(p.id, { draft, duplicates, scanId: scan?.id ?? p.scanId, scannedAt: scan?.scannedAt ?? p.scannedAt, decisions: p.decisions.filter((d) => duplicates.some((x) => x.id === d.id)) }, { type: 'skill.edited', payload: { number: p.number, changed } });
  }

  /**
   * Approves the proposal. Existing skills must have been checked: a tool scan
   * is required, and each likely duplicate needs the person's note on why this
   * one is different.
   */
  approve(ref: string, decisions: SkillDecision[] = []): SkillProposal {
    let p = this.resolve(ref);
    if (p.status !== 'proposed') throw new ValidationError(`Only a proposal can be approved; SKL-${p.number} is ${p.status}.`);
    if (!this.ws.latestToolScan()) throw new ValidationError('Scan your tools first (Tools → Scan), so existing skills and commands can be checked for duplicates.');
    p = this.recheck(p.id);
    const given = Array.isArray(decisions) ? decisions : [];
    const all = [...p.decisions];
    for (const d of given) {
      if (!d || typeof d.id !== 'string' || !p.duplicates.some((x) => x.id === d.id)) throw new ValidationError('A decision names something that is not a likely duplicate of this proposal.');
      const note = line(d.note, 'Why it is different', 400);
      const at = all.findIndex((x) => x.id === d.id);
      if (at >= 0) all[at] = { id: d.id, note };
      else all.push({ id: d.id, note });
    }
    const open = p.duplicates.filter((x) => !all.some((d) => d.id === x.id));
    if (open.length) throw new ValidationError(`Decide first: ${open.map((x) => `"${x.name}" (${x.where})`).join(', ')} may already do this. Say why this one is different, or reject the proposal.`);
    return this.ws.updateSkillProposal(p.id, { status: 'approved', decisions: all, approver: this.ws.actorName(), approvedAt: this.ws.nowIso() }, { type: 'skill.approved', payload: { number: p.number, name: p.draft.name, edited: JSON.stringify(p.draft) !== JSON.stringify(p.proposedDraft), duplicatesDecided: all.length } });
  }

  reject(ref: string, reason: unknown): SkillProposal {
    const p = this.resolve(ref);
    if (p.status !== 'proposed') throw new ValidationError(`Only a proposal can be rejected; SKL-${p.number} is ${p.status}.`);
    const why = line(reason, 'Reason', 400);
    return this.ws.updateSkillProposal(p.id, { status: 'rejected', reason: why }, { type: 'skill.rejected', payload: { number: p.number, reason: why } });
  }

  /** The SKILL.md text. Shown for any proposal; exported only once approved. */
  render(ref: string): string {
    return renderSkill(this.resolve(ref));
  }

  /**
   * Writes <folder>/<name>/SKILL.md. Never overwrites, and refuses Claude
   * Code's own folders, so exporting cannot install or replace a skill.
   */
  export(ref: string, folder: string, claudeDirs: string[] = defaultClaudeDirs()): { proposal: SkillProposal; path: string } {
    const p = this.resolve(ref);
    if (p.status !== 'approved') throw new ValidationError(`Approve SKL-${p.number} before exporting it.`);
    if (typeof folder !== 'string' || !isAbsolute(folder)) throw new ValidationError('Choose a folder.');
    const dir = resolve(folder);
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      throw new ValidationError('The folder does not exist.');
    }
    if (!st.isDirectory()) throw new ValidationError('Choose a folder, not a file or a link.');
    if (insideClaude(dir, claudeDirs)) throw new ValidationError('The app does not put skills where Claude Code loads them. Export to another folder, such as Documents, and copy it yourself if you want to use it.');
    const target = join(dir, p.draft.name);
    const path = join(target, 'SKILL.md');
    if (existsSync(path)) throw new ValidationError(`${path} already exists. Choose another folder; the app never overwrites a file.`);
    mkdirSync(target, { recursive: true });
    writeFileSync(path, renderSkill(p), { flag: 'wx' });
    const proposal = this.ws.updateSkillProposal(p.id, { exports: [...p.exports, { path, at: this.ws.nowIso(), by: this.ws.actorName() }] }, { type: 'skill.exported', payload: { number: p.number, path } });
    return { proposal, path };
  }

  /** Every piece of work in the records that a person asked for, newest last. */
  private work(): Item[] {
    const names = new Map(this.ws.listProjects().map((p) => [p.id, p.name]));
    const out: Item[] = [];
    const seen = new Set<string>();
    const add = (example: SkillExample) => {
      const words = keywords(example.title.replace(/\b[A-Z]{2,}-\d+\b/g, ' '));
      for (const w of [...words]) if (/^\d+$/.test(w)) words.delete(w);
      const key = `${example.projectId}|${[...words].sort().join(' ')}|${example.at.slice(0, 10)}`;
      if (words.size < 2 || seen.has(key)) return;
      seen.add(key);
      out.push({ example, words, checks: [], components: [], kind: null });
    };
    for (const [projectId, projectName] of names) {
      for (const b of this.ws.listBuilds(projectId)) {
        add({ kind: 'build', id: b.id, title: b.title, projectId, projectName, at: b.createdAt, costUsd: b.agent?.costUsd ?? null });
        const item = out[out.length - 1];
        if (item?.example.id === b.id) {
          item.checks = b.checks.map((c) => c.command);
          item.components = b.components;
          item.kind = b.kind;
        }
      }
    }
    for (const r of this.ws.listRuns()) add({ kind: 'run', id: r.id, title: r.title, projectId: r.projectId, projectName: names.get(r.projectId) ?? null, at: r.createdAt, costUsd: null });
    for (const t of this.ws.listAgentTasks().filter((x) => x.parentId === null)) add({ kind: 'request', id: t.id, title: t.title, projectId: null, projectName: null, at: t.createdAt, costUsd: t.costUsd || null });
    return out.sort((a, b) => a.example.at.localeCompare(b.example.at));
  }

}

/** The app's first draft for a group: steps, permissions and tests come from what the examples recorded. */
function draftFor(items: Item[], common: Set<string>, existing: SkillProposal[]): SkillDraft {
  const examples = items.map((i) => i.example);
  const first = examples[0]!.title;
  // The name keeps the person's own words, in their order.
  const words = (first.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => [...keywords(w)].some((k) => common.has(k)) && w !== 'claude' && w !== 'anthropic');
  let name = [...new Set(words)].slice(0, 5).join('-') || 'repeated-work';
  for (let n = 2; existing.some((p) => p.draft.name === name); n++) name = `${name.replace(/-\d+$/, '')}-${n}`;
  const phrase = [...new Set(words)].join(' ');
  const quoted = examples.slice(0, 2).map((e) => `"${e.title}"`).join(' or ');
  const checks = top(items.flatMap((i) => i.checks), 4);
  const components = top(items.flatMap((i) => i.components), 3);
  const bugfix = items.filter((i) => i.kind === 'bugfix').length > items.length / 2;
  const workflow = [
    components.length ? `Read the request, then the code and tests in ${components.map((c) => `\`${c}\``).join(', ')}, before changing anything.` : 'Read the request, then the relevant code and tests, before changing anything.',
    bugfix ? 'Reproduce the problem first, then make the smallest fix and add a test that fails without it.' : 'Make the smallest complete change that follows the project’s conventions, and add or update tests for it.',
    ...(checks.length ? [`Run the checks used for this work before: ${checks.map((c) => `\`${c}\``).join(', ')}.`] : ['Run the project’s tests.']),
    'Report what changed, which checks ran and their results, and anything left open. Never claim a check passed without its output.',
  ];
  const permissions = [
    'Read files in the project.',
    'Change files only in the project’s working copy (in the app, a build worktree).',
    checks.length ? `Run only these commands: ${checks.map((c) => `\`${c}\``).join(', ')}.` : 'Run no commands other than the project’s tests.',
    'No network access, installs, or changes outside the project.',
  ];
  const tests = [
    ...checks.map((c) => `\`${c}\` passes after the change.`),
    `Run it on one past example (${quoted.split(' or ')[0]}) and compare the result with what was done then.`,
    'Check that it does not start for unrelated requests.',
  ];
  const spent = examples.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
  const benefit = `${examples.length} similar pieces of work from ${examples[0]!.at.slice(0, 10)} to ${examples[examples.length - 1]!.at.slice(0, 10)}${spent > 0 ? `, with $${spent.toFixed(2)} of recorded model spend` : ''}. A skill gives the same steps each time instead of explaining them again. This is an estimate from the records, not a measurement.`;
  return { name, description: `Use when asked to ${phrase || 'do this kind of work'}, for example ${quoted}.`.slice(0, 600), workflow, permissions, tests, benefit };
}

export function renderSkill(p: Pick<SkillProposal, 'number' | 'draft' | 'examples' | 'status' | 'approver' | 'approvedAt'>): string {
  const d = p.draft;
  const yaml = (s: string) => JSON.stringify(s);
  return [
    '---',
    `name: ${d.name}`,
    `description: ${yaml(d.description)}`,
    '---',
    '',
    `# ${d.name.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())}`,
    '',
    `Proposed by Iterative Platform as SKL-${p.number} from ${p.examples.length} similar pieces of work${p.status === 'approved' && p.approver ? `, approved by ${p.approver} on ${String(p.approvedAt).slice(0, 10)}` : ' (not approved yet)'}. The app does not install it; review it before you copy it into Claude Code.`,
    '',
    '## When to use',
    '',
    d.description,
    '',
    '## Steps',
    '',
    ...d.workflow.map((s, i) => `${i + 1}. ${s}`),
    '',
    '## Permissions',
    '',
    ...d.permissions.map((s) => `- ${s}`),
    '',
    '## Tests',
    '',
    ...d.tests.map((s) => `- ${s}`),
    '',
    '## Expected benefit',
    '',
    d.benefit,
    '',
    '## Examples it was proposed from',
    '',
    ...p.examples.map((e) => `- ${e.title}${e.projectName ? ` (${e.projectName})` : ''}, ${e.at.slice(0, 10)}`),
    '',
  ].join('\n');
}

/** Where Claude Code loads skills and commands from: its config folder, and any ".claude" folder. */
function defaultClaudeDirs(): string[] {
  return [join(homedir(), '.claude')];
}

function insideClaude(dir: string, claudeDirs: string[]): boolean {
  const parts = dir.split(/[\\/]+/);
  if (parts.some((p) => p.toLowerCase() === '.claude')) return true;
  return claudeDirs.some((c) => {
    const root = resolve(c);
    return dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}

interface Item {
  example: SkillExample;
  words: Set<string>;
  checks: string[];
  components: string[];
  kind: string | null;
}

/** Groups work that shares most of its words. A group needs MIN_REPEATS examples and two shared words. */
function cluster(items: Item[]): { items: Item[]; common: Set<string> }[] {
  const groups: { seed: Item; items: Item[] }[] = [];
  for (const item of items) {
    const g = groups.find((x) => jaccard(x.seed.words, item.words) >= SIMILAR_AT);
    if (g) g.items.push(item);
    else groups.push({ seed: item, items: [item] });
  }
  const out: { items: Item[]; common: Set<string> }[] = [];
  for (const g of groups) {
    if (g.items.length < MIN_REPEATS) continue;
    const counts = new Map<string, number>();
    for (const i of g.items) for (const w of i.words) counts.set(w, (counts.get(w) ?? 0) + 1);
    const common = new Set([...counts].filter(([, n]) => n >= Math.ceil(g.items.length * 0.6)).map(([w]) => w));
    if (common.size >= 2) out.push({ items: g.items, common });
  }
  return out;
}

/** Skills and commands in the scan, and other proposals, that look like they do the same thing. */
export function duplicatesOf(draft: SkillDraft, scan: ToolScan | null, proposals: SkillProposal[]): SkillDuplicate[] {
  const mine = keywords(`${draft.name.replace(/-/g, ' ')} ${draft.description}`);
  const nameWords = keywords(draft.name.replace(/-/g, ' '));
  const out: SkillDuplicate[] = [];
  const compare = (id: string, name: string, kind: SkillDuplicate['kind'], where: string, text: string) => {
    const theirs = keywords(text);
    const theirName = keywords(name.replace(/[-_:]/g, ' '));
    const sameName = name.toLowerCase().split(':').pop() === draft.name;
    const similarity = Math.max(jaccard(mine, theirs), jaccard(nameWords, theirName));
    if (!sameName && similarity < DUPLICATE_AT) return;
    const shared = [...mine].filter((w) => theirs.has(w)).slice(0, 5);
    out.push({ id, name, kind, where, similarity: sameName ? 1 : Math.round(similarity * 100) / 100, why: sameName ? 'Same name.' : `Shares the words ${shared.join(', ')}.` });
  };
  for (const e of scan?.entries ?? []) {
    if (e.kind !== 'skill' && e.kind !== 'command') continue;
    compare(e.id, e.name, e.kind, `${e.kind}, ${e.scope}${e.owner ? `, ${e.owner}` : ''}`, `${e.name.replace(/[-_:]/g, ' ')} ${e.description ?? ''}`);
  }
  for (const p of proposals) {
    if (p.status === 'rejected') continue;
    compare(p.id, p.draft.name, 'proposal', `SKL-${p.number}, ${p.status}`, `${p.draft.name.replace(/-/g, ' ')} ${p.draft.description}`);
  }
  return out.sort((a, b) => b.similarity - a.similarity).slice(0, 8);
}

function top(values: string[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n).map(([v]) => v);
}

function skillName(v: unknown): string {
  if (typeof v !== 'string') throw new ValidationError('Name must be text.');
  const n = v.trim().toLowerCase();
  if (!NAME.test(n) || n.length > 64) throw new ValidationError('Use lowercase letters, digits and hyphens for the name, at most 64 characters.');
  if (/claude|anthropic/.test(n)) throw new ValidationError('A skill name cannot contain "claude" or "anthropic".');
  return n;
}

function line(v: unknown, label: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new ValidationError(`${label} is required.`);
  const t = v.replace(/\s+/g, ' ').trim();
  if (t.length > max) throw new ValidationError(`${label} is longer than ${max} characters.`);
  return t;
}

function lines(v: unknown, label: string): string[] {
  const list = typeof v === 'string' ? v.split('\n') : v;
  if (!Array.isArray(list)) throw new ValidationError(`${label} must be a list.`);
  const out = list.map((x) => (typeof x === 'string' ? x.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim() : '')).filter(Boolean);
  if (!out.length) throw new ValidationError(`${label} needs at least one line.`);
  if (out.length > 20 || out.some((x) => x.length > 400)) throw new ValidationError(`${label}: at most 20 lines of 400 characters.`);
  return out;
}
