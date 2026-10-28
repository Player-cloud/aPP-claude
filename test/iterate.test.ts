// M10 Iterative Layer: the app assesses its own records in three layers, files
// findings as backlog items without duplicating them, and items move only through
// checked states that the person approves and measures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tempHome } from './helpers.ts';
import { Workspace } from '../src/core/workspace.ts';
import { appPaths } from '../src/core/paths.ts';
import { selfAssess, TELEMETRY_GAPS } from '../src/core/iterate/assess.ts';
import { allowedMoves, Backlog } from '../src/core/iterate/backlog.ts';
import { AppService } from '../src/main/service.ts';

const CLI = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
const SPEC = { goal: 'g', allowedTools: [], timeoutMs: 1000, maxOutputTokens: 100, output: { kind: 'text' as const, mustInclude: [] } };

function setup(t: { after: (fn: () => void) => void }) {
  const { home, cleanup } = tempHome();
  let clock = Date.parse('2026-10-01T10:00:00.000Z');
  const tick = (ms = 60_000) => (clock += ms);
  const ws = Workspace.open(home, { actor: 'joshua', now: () => new Date(clock) });
  t.after(() => {
    ws.close();
    cleanup();
  });
  return { home, ws, tick, backlog: new Backlog(ws) };
}

/** Records that a real app would have written while work went wrong. */
function troubles(ws: Workspace, tick: () => number) {
  const p = ws.createProject({ name: 'Club HR' });
  for (const title of ['Plan payroll', 'Plan rota']) {
    const run = ws.startRun({ projectId: p.id, workflow: 'plan', title });
    tick();
    ws.transitionRun(run.id, { to: 'planned' });
    ws.transitionRun(run.id, { to: 'blocked', reason: 'Waiting on the club secretary', resolution: 'Ask the secretary' });
  }
  for (let i = 0; i < 2; i++) {
    const task = ws.createAgentTask({ runId: null, parentId: null, kind: 'request', title: `Draft ${i}`, spec: SPEC });
    tick();
    ws.updateAgentTask(task.id, { status: 'timed_out', failure: 'No answer within 1s' });
  }
  const b = ws.createBuild({ projectId: p.id, kind: 'feature', title: 'Person records', goal: 'g', requirementIds: [], components: [], checks: [{ id: 'test', command: 'node --test' }], repro: null });
  ws.recordCheckRun(b.id, 'baseline', { checkId: 'test', command: 'node --test', status: 'timed_out', exitCode: null, durationMs: 600000, output: '', startedAt: new Date(tick()).toISOString() });
  ws.updateBuild(b.id, { status: 'abandoned', note: 'Too big for one build' });
  return p;
}

test('M10: self-assessment separates observations, inferences and recommendations, and lists telemetry gaps', (t) => {
  const { ws, tick } = setup(t);
  troubles(ws, tick);
  const report = selfAssess(ws, ws.nowIso());
  const sig = report.findings.map((f) => f.signature).sort();
  assert.deepEqual(sig, ['agent_task.timed_out', 'build.abandoned', 'check.timed_out.test', 'run.blocked.plan']);
  const blocked = report.findings.find((f) => f.signature === 'run.blocked.plan')!;
  assert.equal(blocked.observation.count, 2);
  assert.equal(blocked.observation.occurrences.length, 2);
  assert.match(blocked.inference.text, /Waiting on the club secretary/);
  assert.equal(blocked.inference.confidence, 'high');
  assert.ok(blocked.recommendation.successCriteria.length > 0);
  assert.deepEqual(report.gaps, TELEMETRY_GAPS);
  assert.ok(report.sources.find((s) => s.name === 'Workflow runs')!.count === 2);
  // Nothing was written by assessing alone.
  assert.equal(ws.listImprovements().length, 0);
});

test('M10: an empty app gives no findings but still reports what it read and cannot see', (t) => {
  const { ws } = setup(t);
  const report = selfAssess(ws, ws.nowIso());
  assert.equal(report.findings.length, 0);
  assert.ok(report.gaps.length >= 3);
});

test('M10: findings become proposed items once; a repeat adds evidence instead of a duplicate', (t) => {
  const { ws, tick, backlog } = setup(t);
  const p = troubles(ws, tick);
  const first = backlog.assess();
  assert.equal(first.created.length, 4);
  const items = ws.listImprovements();
  assert.ok(items.every((i) => i.status === 'proposed' && i.source === 'self_assessment'));
  assert.deepEqual(items.map((i) => i.number).sort(), [1, 2, 3, 4]);

  // Nothing new: no items, no evidence.
  tick();
  const again = backlog.assess();
  assert.equal(again.created.length, 0);
  assert.equal(again.updated.length, 0);

  // The same problem again: evidence is added to the same item.
  tick();
  const run = ws.startRun({ projectId: p.id, workflow: 'plan', title: 'Plan kit' });
  ws.transitionRun(run.id, { to: 'planned' });
  ws.transitionRun(run.id, { to: 'blocked', reason: 'Waiting on the club secretary', resolution: 'Ask the secretary' });
  const third = backlog.assess();
  assert.equal(third.created.length, 0);
  assert.equal(third.updated.length, 1);
  const item = ws.findImprovementBySignature('run.blocked.plan')!;
  assert.equal(item.evidence.length, 2);
  assert.deepEqual(item.evidence[1]!.occurrences.map((o) => o.id), [run.id]);
  assert.equal(ws.listImprovements().length, 4);
  assert.equal(ws.listSelfAssessments().length, 3);
});

test('M10: statuses move only along checked paths; the person approves and measures', (t) => {
  const { ws, backlog, tick } = setup(t);
  const idea = backlog.feedback({ text: 'The build screen should say how long checks usually take.' });
  assert.equal(idea.status, 'idea');
  assert.equal(idea.source, 'feedback');
  assert.match(idea.evidence[0]!.summary, /joshua/);

  assert.throws(() => backlog.move(idea.id, { to: 'approved' }), /cannot move from idea to approved/);
  assert.throws(() => backlog.move(idea.id, { to: 'proposed' }), /expected outcome/);
  backlog.edit(idea.id, { expectedOutcome: 'People know what to expect', successCriteria: 'Asked about it in feedback less often', priority: 'high' });
  backlog.move(idea.id, { to: 'proposed' });
  tick();
  const approved = backlog.move(idea.id, { to: 'approved' });
  assert.equal(approved.approver, 'joshua');
  assert.ok(approved.approvedAt);
  assert.throws(() => backlog.edit(idea.id, { title: 'Changed' }), /fixed once approved/);

  assert.throws(() => backlog.move(idea.id, { to: 'blocked' }), /blocked on/);
  const blocked = backlog.move(idea.id, { to: 'blocked', reason: 'Needs timing data' });
  assert.deepEqual(allowedMoves(blocked), ['approved', 'rejected']);
  backlog.move(idea.id, { to: 'approved', reason: 'Timing data is in the check runs' });
  backlog.move(idea.id, { to: 'in_progress' });
  assert.throws(() => backlog.move(idea.id, { to: 'verified' }), /Write the result/);
  backlog.move(idea.id, { to: 'verified', result: 'Shows the median duration; checked on Club HR' });
  assert.throws(() => backlog.move(idea.id, { to: 'released' }), /Passing tests alone/);
  const released = backlog.move(idea.id, { to: 'released', measuredOutcome: 'No feedback about check timing in two weeks' });
  assert.equal(released.status, 'released');
  assert.ok(released.releasedAt);
  assert.deepEqual(allowedMoves(released), []);

  // Moves are in the audit log with the approver.
  const moves = ws.listEvents({ limit: 100 }).filter((e) => e.type === 'improvement.moved');
  assert.ok(moves.some((e) => e.payload.to === 'approved' && e.payload.approver === 'joshua'));

  // Rejected needs a reason, and reopening one does too.
  const other = backlog.feedback({ text: 'Dark mode toggle in the title bar' });
  assert.throws(() => backlog.move(other.id, { to: 'rejected' }), /why it is rejected/);
  backlog.move(other.id, { to: 'rejected', reason: 'Settings already has it' });
  assert.throws(() => backlog.move(other.id, { to: 'idea' }), /reopened/);
  assert.equal(backlog.move(other.id, { to: 'idea', reason: 'People cannot find it' }).status, 'idea');
});

test('M10: dependencies must be released before work starts, and cannot loop', (t) => {
  const { backlog } = setup(t);
  const ready = (text: string) => {
    const i = backlog.feedback({ text });
    backlog.edit(i.id, { expectedOutcome: 'x', successCriteria: 'y' });
    return i;
  };
  const a = ready('A');
  const b = ready('B');
  backlog.edit(b.id, { dependencies: [a.id] });
  assert.throws(() => backlog.edit(a.id, { dependencies: [b.id] }), /depend on each other/);
  assert.throws(() => backlog.edit(a.id, { dependencies: [a.id] }), /itself/);
  backlog.move(b.id, { to: 'proposed' });
  backlog.move(b.id, { to: 'approved' });
  assert.throws(() => backlog.move(b.id, { to: 'in_progress' }), /IMP-1, which is not released/);
});

test('M10: merging links a duplicate, keeps it, and later findings land on the kept item', (t) => {
  const { ws, tick, backlog } = setup(t);
  const p = troubles(ws, tick);
  backlog.assess();
  const typed = backlog.feedback({ text: 'Plans keep getting stuck waiting for the secretary' });
  const detector = ws.findImprovementBySignature('run.blocked.plan')!;
  const kept = backlog.merge(detector.id, typed.id);
  assert.equal(kept.id, typed.id);
  assert.equal(kept.evidence.at(-1)!.source, 'merge');
  assert.equal(kept.evidence.at(-1)!.occurrences.length, 2);
  assert.equal(ws.getImprovement(detector.id).mergedInto, typed.id);
  assert.ok(!ws.listImprovements().some((i) => i.id === detector.id));
  assert.ok(ws.listImprovements({ includeMerged: true }).some((i) => i.id === detector.id));
  assert.throws(() => backlog.move(detector.id, { to: 'approved' }), /merged/);

  tick();
  const run = ws.startRun({ projectId: p.id, workflow: 'plan', title: 'Plan kit' });
  ws.transitionRun(run.id, { to: 'planned' });
  ws.transitionRun(run.id, { to: 'blocked', reason: 'Waiting on the club secretary', resolution: 'Ask the secretary' });
  const rec = backlog.assess();
  assert.deepEqual(rec.updated, [typed.id]);
  assert.equal(rec.created.length, 0);
});

test('M10: recurrence is counted from approval for detector items', (t) => {
  const { ws, tick, backlog } = setup(t);
  const p = troubles(ws, tick);
  backlog.assess();
  const item = ws.findImprovementBySignature('run.blocked.plan')!;
  assert.match(backlog.recurrence(item).note, /from approval/);
  tick();
  const approved = backlog.move(item.id, { to: 'approved' });
  assert.equal(backlog.recurrence(approved).sinceApproval, null);
  tick();
  backlog.assess();
  assert.equal(backlog.recurrence(approved).sinceApproval, 0);
  tick();
  const run = ws.startRun({ projectId: p.id, workflow: 'plan', title: 'Plan kit' });
  ws.transitionRun(run.id, { to: 'planned' });
  ws.transitionRun(run.id, { to: 'blocked', reason: 'Again', resolution: 'Ask' });
  tick();
  backlog.assess();
  const r = backlog.recurrence(ws.getImprovement(item.id));
  assert.equal(r.sinceApproval, 1);
  assert.match(r.note, /came back/);
  assert.equal(backlog.recurrence(backlog.feedback({ text: 'x' })).sinceApproval, null);
});

test('M10: items and self-assessments are never deleted, and a self-assessment never changes', (t) => {
  const { home, cleanup } = tempHome();
  let clock = Date.parse('2026-10-01T10:00:00.000Z');
  const ws = Workspace.open(home, { now: () => new Date(clock) });
  const raw = new DatabaseSync(appPaths(home).db);
  t.after(() => {
    raw.close();
    ws.close();
    cleanup();
  });
  troubles(ws, () => (clock += 60_000));
  new Backlog(ws).assess();
  assert.throws(() => raw.exec('DELETE FROM improvements'), /never deleted/);
  assert.throws(() => raw.exec('DELETE FROM self_assessments'), /never deleted/);
  assert.throws(() => raw.exec("UPDATE self_assessments SET report = '{}'"), /cannot change/);
  assert.equal(ws.listImprovements().length, 4);
});

test('M10: feedback and moves are validated at the service and available in the CLI', (t) => {
  const { home, cleanup } = tempHome();
  const service = new AppService(home, '0.0.0-test');
  t.after(() => {
    service.close();
    cleanup();
  });
  const h = service.handlers;
  assert.equal(h.addFeedback({ text: '' }).ok, false);
  const fb = h.addFeedback({ text: 'Show the budget on the home screen' });
  assert.ok(fb.ok);
  const moved = h.moveImprovement({ id: fb.ok ? fb.value.id : '', to: 'nonsense' });
  assert.equal(moved.ok, false);
  const assessed = h.runSelfAssessment();
  assert.ok(assessed.ok);
  const overview = h.improvementsOverview();
  assert.ok(overview.ok && overview.value.items.length === 1 && overview.value.latest !== null);
  service.close();

  const cli = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { env: { ...process.env, IAP_HOME: home }, encoding: 'utf8' });
  const list = cli('iter', 'list');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /IMP-1 .*idea.*Show the budget/);
  const assess = cli('iter', 'assess');
  assert.equal(assess.status, 0, assess.stderr);
  assert.match(assess.stdout, /Not recorded/);
  const show = cli('iter', 'show', 'IMP-1');
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /Show the budget/);
  const bad = cli('iter', 'move', 'IMP-1', 'approved');
  assert.notEqual(bad.status, 0);
});
