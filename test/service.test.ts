// The main-process IPC handlers are the security boundary for the UI, so they
// are tested directly with hostile input (M2-AC8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './helpers.ts';
import { AppService } from '../src/main/service.ts';

test('M2-AC8: handlers validate types and shapes of renderer input', (t) => {
  const { home, cleanup } = tempHome();
  const s = new AppService(home, '0.0.0-test');
  // Close before deleting: Windows cannot remove an open database file.
  t.after(() => {
    s.close();
    cleanup();
  });
  const h = s.handlers;
  for (const bad of [undefined, null, 'x', [], { name: 1 }, { name: 'ok', facts: 'nope' }, { name: 'ok', facts: [{ kind: 'confirmed' }] }]) {
    const r = h.createProject(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(!r.ok && r.error.code === 'VALIDATION');
  }
  assert.deepEqual(h.moveRun({ runId: 'run_x', to: 'shipped' }), { ok: false, error: { code: 'VALIDATION', message: 'Unknown state "shipped".' } });
  assert.equal((h.listEvents({ limit: '5' }) as { ok: boolean }).ok, false);
  assert.equal((h.recover(false) as { ok: boolean }).ok, false);
  assert.equal((h.recover(true) as { ok: boolean }).ok, false, 'recover refuses on a healthy database');
});

test('M2: a full project and run round-trip through the handlers', (t) => {
  const { home, cleanup } = tempHome();
  const s = new AppService(home, '0.0.0-test');
  // Close before deleting: Windows cannot remove an open database file.
  t.after(() => {
    s.close();
    cleanup();
  });
  const created = s.handlers.createProject({ name: 'Via IPC', facts: [{ kind: 'assumption', text: 'Solo user' }] });
  assert.ok(created.ok);
  const run = s.handlers.startRun({ projectId: created.value.id, workflow: 'plan' });
  assert.ok(run.ok);
  assert.deepEqual(run.value.next, ['planned', 'cancelled']);
  const moved = s.handlers.moveRun({ runId: run.value.id, to: 'planned' });
  assert.ok(moved.ok && moved.value.state === 'planned');
});

test('M2-AC5: corrupt state is reported, and recover needs explicit confirmation', (t) => {
  const { home, cleanup } = tempHome();
  writeFileSync(join(home, 'iap.db'), 'garbage '.repeat(400));
  const s = new AppService(home, '0.0.0-test');
  t.after(() => {
    s.close();
    cleanup();
  });
  assert.equal(s.status().state, 'corrupt');
  const blocked = s.handlers.listProjects();
  assert.ok(!blocked.ok && blocked.error.code === 'STATE_CORRUPT');
  assert.equal((s.handlers.recover('yes') as { ok: boolean }).ok, false);
  const recovered = s.handlers.recover(true);
  assert.ok(recovered.ok && recovered.value.movedTo?.includes('.corrupt-'));
  assert.equal(s.status().state, 'ready');
});

test('a closed workspace returns a clean error, not internals', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const s = new AppService(home, '0.0.0-test');
  s.close(); // force an internal failure path: workspace closed underneath the service
  const original = console.error;
  console.error = () => {};
  t.after(() => (console.error = original));
  const r = s.handlers.listProjects();
  assert.equal(r.ok, false);
  assert.ok(!r.ok && !/at |\.ts/.test(r.error.message));
});

test('M3: the agent handlers validate input and only run on a started run', async (t) => {
  const { home, cleanup } = tempHome();
  const s = new AppService(home, '0.0.0-test');
  t.after(() => {
    s.close();
    cleanup();
  });
  const h = s.handlers;
  for (const bad of [undefined, 'x', { runId: 1, goal: 'g' }, { runId: 'run_x' }, { runId: 'run_x', goal: 'x'.repeat(4_001) }]) {
    const r = await h.runAgent(bad);
    assert.equal(r.ok, false, JSON.stringify(bad)?.slice(0, 40));
  }
  const p = h.createProject({ name: 'Agent' });
  assert.ok(p.ok);
  const run = h.startRun({ projectId: p.value.id, workflow: 'build' });
  assert.ok(run.ok);
  const early = await h.runAgent({ runId: run.value.id, goal: 'Build it' });
  assert.ok(!early.ok && /only work on a run that has been started/.test(early.error.message));
  for (const to of ['planned', 'approved', 'running']) h.moveRun({ runId: run.value.id, to });
  const done = await h.runAgent({ runId: run.value.id, goal: 'Build it', allowedTools: ['Bash'] });
  assert.ok(done.ok);
  assert.equal(done.value.status, 'succeeded');
  assert.match(done.value.output ?? '', /Simulated model/);
  assert.deepEqual(done.value.spec.allowedTools, [], 'the renderer cannot grant tools');
  const listed = h.listAgentTasks(run.value.id);
  assert.ok(listed.ok && listed.value.length === 3);
});

test('M5: the planning handlers validate input and walk brief → spec → revision', async (t) => {
  const { home, cleanup } = tempHome();
  const s = new AppService(home, '0.0.0-test');
  t.after(() => {
    s.close();
    cleanup();
  });
  const h = s.handlers;
  for (const bad of [undefined, 1, { docId: 'x' }, { docId: 1, content: {} }, { docId: 'x', content: {}, changeNote: 5 }]) {
    assert.equal(h.savePlanDraft(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(h.comparePlanDocs({ before: 'a' }).ok, false);
  assert.equal((await h.draftBrief(undefined)).ok, false);

  const p = h.createProject({ name: 'Planner', idea: 'A recipe box', facts: [{ kind: 'confirmed', text: 'Runs offline' }] });
  assert.ok(p.ok);
  const early = await h.draftSpec(p.value.id);
  assert.ok(!early.ok && /Approve the concept brief/.test(early.error.message));

  const draft = await h.draftBrief(p.value.id);
  assert.ok(draft.ok && draft.value.source === 'simulated');
  assert.deepEqual(draft.value.kind === 'brief' && draft.value.content.confirmed, ['Runs offline'], 'confirmed facts come from the project');
  const blocked = h.approvePlanDoc(draft.value.id);
  assert.ok(!blocked.ok && /placeholder/.test(blocked.error.message), 'a simulated draft cannot be approved as is');

  const brief = { goals: ['Keep recipes'], users: ['Home cooks'], useCases: ['Add a recipe'], scope: ['Local storage'], successCriteria: ['A recipe survives a restart'] };
  assert.ok(h.savePlanDraft({ docId: draft.value.id, content: brief }).ok);
  const approved = h.approvePlanDoc(draft.value.id);
  assert.ok(approved.ok && approved.value.status === 'approved');

  const spec = await h.draftSpec(p.value.id);
  assert.ok(spec.ok && spec.value.kind === 'spec');
  assert.deepEqual(spec.value.content.requirements.map((r) => r.id), ['REQ-001', 'REQ-002']);

  const revision = h.revisePlanDoc(approved.value.id);
  assert.ok(revision.ok && revision.value.version === 2);
  assert.ok(h.savePlanDraft({ docId: revision.value.id, content: { ...brief, goals: ['Keep and share recipes'] } }).ok);
  const noNote = h.approvePlanDoc(revision.value.id);
  assert.ok(!noNote.ok && /change note/.test(noNote.error.message));
  assert.ok(h.savePlanDraft({ docId: revision.value.id, content: { ...brief, goals: ['Keep and share recipes'] }, changeNote: 'Sharing is in' }).ok);
  assert.ok(h.approvePlanDoc(revision.value.id).ok);
  const diff = h.comparePlanDocs({ before: approved.value.id, after: revision.value.id });
  assert.ok(diff.ok && diff.value.some((c) => c.target === 'goals'));
  const overview = h.getPlanning(p.value.id);
  assert.ok(overview.ok && overview.value.brief.versions.length === 2 && overview.value.spec.draft !== null);
  assert.equal(overview.value.egm.state, 'not_scanned');
  assert.ok(h.discardPlanDraft(spec.value.id).ok);
});

test('M6: build commands run only after the approval outside the renderer', async (t) => {
  const { home, cleanup } = tempHome();
  let approve = false;
  const asked: string[][] = [];
  const s = new AppService(home, '0.0.0-test', {
    confirmChecks: async ({ commands }) => {
      asked.push(commands);
      return approve;
    },
  });
  t.after(() => {
    s.close();
    cleanup();
  });
  const h = s.handlers;
  const p = h.createProject({ name: 'Builds' });
  assert.ok(p.ok);
  for (const bad of [undefined, 'x', { projectId: p.value.id }, { projectId: p.value.id, kind: 'bugfix', title: 't', goal: 'g', repro: 'r', checks: 'npm test' }, { projectId: p.value.id, kind: 'bugfix', title: 't', goal: 'g', repro: 'r', checks: [], components: 'src' }]) {
    assert.equal(h.createBuild(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal((await h.setProjectRepo({ projectId: p.value.id, path: home })).ok, false, 'not a repository');
  const repo = await h.initProjectRepo(p.value.id);
  assert.ok(repo.ok && repo.value.repoPath);
  const b = h.createBuild({ projectId: p.value.id, kind: 'bugfix', title: 'Crash', goal: 'It crashes', repro: 'Open it', checks: [{ id: 'unit', command: 'node -e "process.exit(0)"' }] });
  assert.ok(b.ok);
  const refused = await h.startBuild(b.value.id);
  assert.ok(!refused.ok && /not approved, so nothing ran/.test(refused.error.message));
  assert.deepEqual(asked, [['node -e "process.exit(0)"']]);
  assert.ok(h.getBuild(b.value.id).ok && (h.getBuild(b.value.id) as { ok: true; value: { checkRuns: unknown[] } }).value.checkRuns.length === 0);
  approve = true;
  const started = await h.startBuild(b.value.id);
  assert.ok(started.ok && started.value.checkRuns[0]!.status === 'passed');
  const agent = await h.runBuildAgent(b.value.id);
  assert.ok(agent.ok && agent.value.build.agent?.model === 'simulated');
  const verified = await h.verifyBuild(b.value.id);
  assert.ok(verified.ok && verified.value.build.status === 'review');
  const diff = await h.buildDiff(b.value.id);
  assert.ok(diff.ok && diff.value.files.length === 0);
  assert.equal(h.completeBuild({ buildId: b.value.id }).ok, false, 'risks need a note');
  assert.ok(h.completeBuild({ buildId: b.value.id, note: 'Could not reproduce; closing.' }).ok);
  const listed = h.listBuilds(p.value.id);
  assert.ok(listed.ok && listed.value[0]!.status === 'completed');
});
