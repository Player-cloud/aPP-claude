import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempHome } from './helpers.ts';
import { Workspace } from '../src/core/workspace.ts';
import { appPaths } from '../src/core/paths.ts';
import { ModelCallError, ValidationError } from '../src/core/errors.ts';
import { SimulatedModel } from '../src/core/agents/model.ts';
import { egmStatus, Planner } from '../src/core/planner.ts';
import { BRIEF_FIELDS, comparePlans, normalizeSpec, type Brief, type Spec } from '../src/core/planning.ts';
import type { ToolScan } from '../src/core/tools.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const { home, cleanup } = tempHome();
  const ws = Workspace.open(home);
  t.after(() => {
    ws.close();
    cleanup();
  });
  const project = ws.createProject({
    name: 'Recipe app',
    idea: 'Share and rate recipes with friends',
    facts: [
      { kind: 'confirmed', text: 'Windows desktop first' },
      { kind: 'assumption', text: 'Users want offline access' },
    ],
  });
  return { ws, home, project, planner: new Planner(ws, new SimulatedModel()) };
}

const filledBrief = (over: Partial<Brief> = {}): Brief => ({
  goals: ['Friends can share recipes'],
  users: ['Home cooks'],
  useCases: ['Post a recipe', 'Rate a recipe'],
  scope: ['Posting and rating'],
  nonGoals: ['Payments'],
  confirmed: ['Windows desktop first'],
  assumptions: ['Users want offline access'],
  dependencies: [],
  risks: ['Spam'],
  successCriteria: ['10 friends post a recipe in the first month'],
  ...over,
});

const filledSpec = (spec: Spec): Spec => ({
  requirements: spec.requirements.map((r) => ({ ...r, title: r.title.replace(/^TODO:\s*/, ''), acceptanceCriteria: [`${r.title} works end to end`] })),
});

test('M5-AC1: a simulated brief keeps the person\'s facts and marks everything else as placeholders', async (t) => {
  const { ws, project, planner } = setup(t);
  const brief = await planner.draftBrief(project.id);
  assert.equal(brief.kind, 'brief');
  assert.equal(brief.version, 1);
  assert.equal(brief.status, 'draft');
  assert.equal(brief.source, 'simulated');
  assert.ok(brief.kind === 'brief');
  assert.deepEqual(brief.content.confirmed, ['Windows desktop first']);
  assert.deepEqual(brief.content.assumptions, ['Users want offline access']);
  assert.match(brief.content.goals[0]!, /^TODO:.*Share and rate recipes/);
  // Placeholders block approval, with the reasons listed.
  assert.throws(() => planner.approve(brief.id), (e: Error) => e instanceof ValidationError && /Goals still has 1 placeholder/.test(e.message));
  // Only one draft at a time.
  await assert.rejects(planner.draftBrief(project.id), /already has a brief draft/);
  assert.ok(existsSync(join(project.docsPath, 'versions', 'brief-v1.md')));
  assert.equal(ws.listEvents({ projectId: project.id }).some((e) => e.type === 'plan.drafted'), true);
});

test('M5-AC2: a model cannot put its own guesses into confirmed facts', async (t) => {
  const { project, ws } = setup(t);
  const model = new SimulatedModel((req) => ({ text: JSON.stringify(filledBrief({ confirmed: ['Windows desktop first', 'Has 1M users'] })) }));
  const brief = await new Planner(ws, model).draftBrief(project.id);
  assert.ok(brief.kind === 'brief');
  assert.deepEqual(brief.content.confirmed, ['Windows desktop first']);
  assert.ok(brief.content.assumptions.includes('Has 1M users'));
});

test('M5-AC3: brief → spec with stable requirement IDs and acceptance criteria, saved under docs/designs', async (t) => {
  const { project, planner } = setup(t);
  await assert.rejects(planner.draftSpec(project.id), /Approve the concept brief/);
  const draft = await planner.draftBrief(project.id);
  planner.saveDraft(draft.id, { content: filledBrief() });
  const brief = planner.approve(draft.id);
  assert.equal(brief.status, 'approved');
  assert.ok(readFileSync(join(project.docsPath, 'brief.md'), 'utf8').includes('Friends can share recipes'));

  const spec = await planner.draftSpec(project.id);
  assert.ok(spec.kind === 'spec');
  assert.equal(spec.basedOn, brief.id);
  assert.deepEqual(spec.content.requirements.map((r) => r.id), ['REQ-001', 'REQ-002', 'REQ-003']);
  assert.throws(() => planner.approve(spec.id), /no acceptance criteria|placeholders/);
  planner.saveDraft(spec.id, { content: filledSpec(spec.content) });
  const approved = planner.approve(spec.id);
  assert.equal(approved.status, 'approved');
  const md = readFileSync(join(project.docsPath, 'spec.md'), 'utf8');
  assert.match(md, /## REQ-001: Friends can share recipes \[MUST\]/);
  assert.match(md, /- \[ \] Friends can share recipes works end to end/);
});

test('M5-AC4: changing an approved spec creates a new version with a change note and a recorded diff', async (t) => {
  const { ws, project, planner } = setup(t);
  const b = await planner.draftBrief(project.id);
  planner.saveDraft(b.id, { content: filledBrief() });
  planner.approve(b.id);
  const s = await planner.draftSpec(project.id);
  assert.ok(s.kind === 'spec');
  planner.saveDraft(s.id, { content: filledSpec(s.content) });
  const v1 = planner.approve(s.id);
  assert.ok(v1.kind === 'spec');

  // The approved version cannot be edited, in the app or directly in the database.
  assert.throws(() => planner.saveDraft(v1.id, { content: v1.content }), /cannot be edited/);
  const db = (ws as unknown as { db: DatabaseSync }).db;
  assert.throws(() => db.prepare("UPDATE plan_docs SET content = '{}' WHERE id = ?").run(v1.id), /only a draft can be edited/);
  assert.throws(() => db.prepare('DELETE FROM plan_docs').run(), /never deleted/);

  const v2 = planner.revise(v1.id);
  assert.equal(v2.version, 2);
  assert.ok(v2.kind === 'spec');
  const reqs = v2.content.requirements;
  const edited = {
    requirements: [
      { ...reqs[0]!, priority: 'SHOULD' as const },
      reqs[1]!,
      // REQ-003 removed; a new one gets the next number, never a reused one.
      { id: '', title: 'Export a recipe', description: '', priority: 'COULD' as const, acceptanceCriteria: ['A recipe exports to PDF'] },
    ],
  };
  planner.saveDraft(v2.id, { content: edited });
  assert.throws(() => planner.approve(v2.id), /change note/);
  planner.saveDraft(v2.id, { content: (ws.getPlanDoc(v2.id) as { content: Spec }).content, changeNote: 'Export added, ratings dropped' });
  const approved = planner.approve(v2.id);
  assert.deepEqual(approved.changes, [
    { kind: 'changed', target: 'REQ-001', detail: 'priority MUST → SHOULD' },
    { kind: 'added', target: 'REQ-004', detail: 'Export a recipe' },
    { kind: 'removed', target: 'REQ-003', detail: 'Rate a recipe' },
  ]);
  assert.equal(ws.getPlanDoc(v1.id).status, 'superseded');
  assert.equal(ws.getPlanDoc(v1.id).kind === 'spec' && (ws.getPlanDoc(v1.id).content as Spec).requirements.length, 3, 'v1 is unchanged');
  assert.ok(existsSync(join(project.docsPath, 'versions', 'spec-v1.md')));
  assert.match(readFileSync(join(project.docsPath, 'spec.md'), 'utf8'), /Change note: Export added, ratings dropped/);
  const ev = ws.listEvents({ projectId: project.id }).find((e) => e.type === 'plan.approved' && (e.payload as { version: number }).version === 2);
  assert.ok(ev);
});

test('M5: requirement IDs cannot be invented, duplicated or reused', () => {
  const known = new Set(['REQ-001', 'REQ-002']);
  const r = (id: string) => ({ id, title: 't', description: '', priority: 'MUST', acceptanceCriteria: ['c'] });
  assert.throws(() => normalizeSpec({ requirements: [r('REQ-777')] }, known), /never issued/);
  assert.throws(() => normalizeSpec({ requirements: [r('REQ-001'), r('REQ-001')] }, known), /appears twice/);
  assert.deepEqual(normalizeSpec({ requirements: [r(''), r('REQ-001')] }, known).requirements.map((x) => x.id), ['REQ-003', 'REQ-001']);
  assert.throws(() => normalizeSpec({ requirements: [{ ...r(''), priority: 'NICE' }] }, known), /priority/);
});

test('M5: drafts are validated and redacted like any other input', async (t) => {
  const { project, planner, home } = setup(t);
  const d = await planner.draftBrief(project.id);
  assert.throws(() => planner.saveDraft(d.id, { content: { goals: 'one' } }), /list of text/);
  assert.throws(() => planner.saveDraft(d.id, { content: { ...filledBrief(), extra: [] } }), /Unknown brief fields/);
  planner.saveDraft(d.id, { content: filledBrief({ dependencies: ['API key sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345'] }) });
  assert.ok(!readFileSync(appPaths(home).db).includes(Buffer.from('abcdefghijklmnopqrstuvwxyz012345')));
  assert.ok(!readFileSync(join(project.docsPath, 'versions', 'brief-v1.md'), 'utf8').includes('abcdefghijklmnop'));
  // Discarding keeps the version for the record but frees the slot for a new draft.
  planner.discard(d.id);
  const again = await planner.draftBrief(project.id);
  assert.equal(again.version, 2);
});

test('M5: a failed or blocked model call saves nothing', async (t) => {
  const { ws, project } = setup(t);
  const broken = new Planner(ws, new SimulatedModel(() => ({ text: 'Here is your brief!' })));
  await assert.rejects(broken.draftBrief(project.id), (e: Error) => e instanceof ModelCallError && /not valid JSON/.test(e.message));
  const billable = new Planner(ws, new SimulatedModel(() => ({ text: '{}', costUsd: 0.1 }), { billable: true }));
  await assert.rejects(billable.draftBrief(project.id), (e: Error) => e instanceof ModelCallError && e.code === 'BUDGET_BLOCKED');
  assert.equal(ws.listPlanDocs(project.id).length, 0);
});

test('M5: the spec is flagged when the brief changes after it was approved', async (t) => {
  const { project, planner } = setup(t);
  const b = await planner.draftBrief(project.id);
  planner.saveDraft(b.id, { content: filledBrief() });
  const b1 = planner.approve(b.id);
  const s = await planner.draftSpec(project.id);
  assert.ok(s.kind === 'spec');
  planner.saveDraft(s.id, { content: filledSpec(s.content) });
  planner.approve(s.id);
  assert.equal(planner.overview(project.id).specOutdated, false);
  const b2 = planner.revise(b1.id);
  planner.saveDraft(b2.id, { content: filledBrief({ goals: ['Friends can share recipes', 'Plan meals'] }), changeNote: 'Meal planning' });
  planner.approve(b2.id);
  const o = planner.overview(project.id);
  assert.equal(o.specOutdated, true);
  assert.deepEqual(planner.compare(b1.id, b2.id), [{ kind: 'added', target: 'goals', detail: 'Plan meals' }]);
});

test('M5 / FR-PLAN-002: EGM is discovered from the tool scan and never reported as having run', () => {
  assert.equal(egmStatus(null).state, 'not_scanned');
  const scan = (names: string[]) => ({ entries: names.map((name) => ({ name, invocation: `/${name}`, kind: 'command', source: 'x', scopeDetail: null })) }) as unknown as ToolScan;
  assert.equal(egmStatus(scan(['review'])).state, 'not_found');
  const found = egmStatus(scan(['egm-draft', 'review']));
  assert.equal(found.state, 'found_unverified');
  assert.deepEqual(found.evidence, ['/egm-draft (command, x)']);
  assert.match(found.message, /no EGM step ran/);
});

test('M5: comparing different kinds is refused', () => {
  const base = { id: 'a', projectId: 'p', version: 1, status: 'draft', source: 's', changeNote: null, changes: null, basedOn: null, createdAt: '', updatedAt: '', approvedAt: null } as const;
  const brief = { ...base, kind: 'brief' as const, content: Object.fromEntries(BRIEF_FIELDS.map((f) => [f, []])) as unknown as Brief };
  const spec = { ...base, kind: 'spec' as const, content: { requirements: [] } };
  assert.throws(() => comparePlans(brief, spec), /same document/);
});
