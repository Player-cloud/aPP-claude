import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempHome } from './helpers.ts';
import { Workspace } from '../src/core/workspace.ts';
import { ValidationError } from '../src/core/errors.ts';
import { SIMULATED_NOTE, SimulatedModel, type SimulatedStep } from '../src/core/agents/model.ts';
import { Orchestrator, parsePlan } from '../src/core/agents/orchestrator.ts';
import { chooseStrategy, orderSubtasks, type PlannedSubtask } from '../src/core/agents/strategy.ts';

type Sub = Partial<PlannedSubtask> & { title: string };
const sub = (s: Sub): PlannedSubtask => ({ goal: `Do ${s.title}`, writes: [], dependsOn: [], risk: 'low', estTokens: 2_000, ...s });

/** A simulated model that plans `plan` and answers each subtask per `work` (default: the simulated note). */
function scripted(plan: Sub[], work: Record<string, SimulatedStep> = {}, options: { billable?: boolean; cost?: number } = {}) {
  return new SimulatedModel(
    (req) => {
      if (req.purpose === 'plan') return { text: JSON.stringify({ subtasks: plan.map(sub) }), costUsd: options.cost };
      const title = Object.keys(work).find((t) => req.taskTitle === t);
      return { text: `${SIMULATED_NOTE} ${req.taskTitle}`, costUsd: options.cost, ...(title ? work[title] : {}) };
    },
    { billable: options.billable },
  );
}

function setup(t: { after: (fn: () => void) => void }) {
  const { home, cleanup } = tempHome();
  const ws = Workspace.open(home);
  t.after(() => {
    ws.close();
    cleanup();
  });
  return ws;
}

const children = (ws: Workspace, rootId: string) => ws.listAgentTasks({ parentId: rootId });

test('M3: a simple request runs as a single agent and is labelled simulated', async (t) => {
  const ws = setup(t);
  const root = await new Orchestrator(ws, new SimulatedModel()).run({ runId: null, title: 'Write a README', goal: 'Write a README' });
  assert.equal(root.status, 'succeeded');
  assert.equal(root.strategy, 'single');
  assert.match(root.rationale.join(' '), /One task/);
  assert.match(root.output ?? '', /Simulated model: no AI was called/);
  assert.deepEqual(children(ws, root.id).map((c) => [c.kind, c.status]), [
    ['subtask', 'succeeded'],
    ['reconcile', 'succeeded'],
  ]);
  assert.equal(ws.spentThisMonth(), 0);
});

test('M3: dependent large subtasks run sequentially as subagents in dependency order', async (t) => {
  const ws = setup(t);
  const plan = [
    sub({ title: 'Test', dependsOn: ['Build'], estTokens: 10_000, writes: ['test/'] }),
    sub({ title: 'Design', estTokens: 10_000, writes: ['docs/'] }),
    sub({ title: 'Build', dependsOn: ['Design'], estTokens: 10_000, writes: ['src/'] }),
  ];
  const root = await new Orchestrator(ws, scripted(plan)).run({ runId: null, title: 'Feature', goal: 'Ship a feature' });
  assert.equal(root.strategy, 'subagents');
  assert.equal(root.status, 'succeeded');
  assert.deepEqual(children(ws, root.id).filter((c) => c.kind === 'subtask').map((c) => c.title), ['Design', 'Build', 'Test']);
});

test('M3: independent large subtasks run in parallel as a team', async (t) => {
  const ws = setup(t);
  const plan = ['A', 'B', 'C'].map((title) => sub({ title, estTokens: 12_000, writes: [`${title}.ts`] }));
  let active = 0;
  let peak = 0;
  const model = new SimulatedModel((req) => (req.purpose === 'plan' ? { text: JSON.stringify({ subtasks: plan }) } : { text: `${SIMULATED_NOTE} ${req.taskTitle}`, delayMs: 20 }));
  const call = model.call.bind(model);
  model.call = async (req) => {
    active++;
    peak = Math.max(peak, active);
    try {
      return await call(req);
    } finally {
      active--;
    }
  };
  const root = await new Orchestrator(ws, model).run({ runId: null, title: 'Three modules', goal: 'Build three modules' });
  assert.equal(root.strategy, 'team');
  assert.equal(root.status, 'succeeded');
  assert.ok(peak > 1, `expected concurrent calls, peak was ${peak}`);
  assert.match(root.output ?? '', /## A[\s\S]*## B[\s\S]*## C/);
});

test('M3: subtasks that change the same files are not delegated', async (t) => {
  const ws = setup(t);
  const plan = [sub({ title: 'One', writes: ['app.ts'], estTokens: 20_000 }), sub({ title: 'Two', writes: ['app.ts'], estTokens: 20_000 })];
  const root = await new Orchestrator(ws, scripted(plan)).run({ runId: null, title: 'Refactor', goal: 'Refactor app.ts' });
  assert.equal(root.strategy, 'single');
  assert.match(root.rationale.join(' '), /both change app\.ts/);
  assert.equal(children(ws, root.id).filter((c) => c.kind === 'subtask').length, 1);
});

test('M3: a failed subagent fails the request and cancels its dependents, never reporting success', async (t) => {
  const ws = setup(t);
  const plan = [
    sub({ title: 'Design', estTokens: 10_000 }),
    sub({ title: 'Build', dependsOn: ['Design'], estTokens: 10_000 }),
    sub({ title: 'Docs', estTokens: 10_000 }),
  ];
  const root = await new Orchestrator(ws, scripted(plan, { Design: { fail: 'agent crashed' } })).run({ runId: null, title: 'Feature', goal: 'Ship' });
  assert.equal(root.status, 'failed');
  assert.equal(root.output, null);
  const byTitle = Object.fromEntries(children(ws, root.id).map((c) => [c.title, c]));
  assert.equal(byTitle.Design!.status, 'failed');
  assert.match(byTitle.Design!.failure ?? '', /agent crashed/);
  assert.equal(byTitle.Build!.status, 'cancelled');
  assert.equal(byTitle.Docs!.status, 'succeeded', 'independent work still runs');
  assert.equal(byTitle['Reconcile results']!.status, 'failed');
  assert.match(root.failure ?? '', /2 of 3 subtasks did not succeed|"Design" failed/);
});

test('M3: a subtask that times out is reported as timed out', async (t) => {
  const ws = setup(t);
  const root = await new Orchestrator(ws, scripted([sub({ title: 'Slow' })], { Slow: { delayMs: 5_000 } })).run({
    runId: null,
    title: 'Slow',
    goal: 'Be slow',
    timeoutMs: 50,
  });
  assert.equal(root.status, 'failed');
  const slow = children(ws, root.id).find((c) => c.kind === 'subtask')!;
  assert.equal(slow.status, 'timed_out');
  assert.match(root.failure ?? '', /timed out/);
});

test('M3: a tool request outside the allowed list is denied and blocks the request', async (t) => {
  const ws = setup(t);
  const work = { Clean: { toolRequests: [{ tool: 'Bash', input: 'rm -rf /' }] } };
  const root = await new Orchestrator(ws, scripted([sub({ title: 'Clean' })], work)).run({ runId: null, title: 'Clean', goal: 'Clean up', allowedTools: ['Read'] });
  assert.equal(root.status, 'blocked');
  assert.match(root.resolution ?? '', /Allow the tool/);
  const task = children(ws, root.id).find((c) => c.kind === 'subtask')!;
  assert.equal(task.status, 'permission_denied');
  assert.match(task.failure ?? '', /"Bash"/);
  assert.doesNotMatch(JSON.stringify(ws.listAgentTasks()), /rm -rf/, 'the denied input is not stored');
});

test('M3: an allowed tool request is recorded and the task succeeds', async (t) => {
  const ws = setup(t);
  const work = { Read: { toolRequests: [{ tool: 'Read', input: 'README.md' }] } };
  const root = await new Orchestrator(ws, scripted([sub({ title: 'Read' })], work)).run({ runId: null, title: 'Read', goal: 'Read', allowedTools: ['Read'] });
  assert.equal(root.status, 'succeeded');
});

test('M3: with no budget set, a billable model is never called', async (t) => {
  const ws = setup(t);
  let calls = 0;
  const model = scripted([sub({ title: 'X' })], {}, { billable: true, cost: 0.5 });
  const call = model.call.bind(model);
  model.call = (req) => {
    calls++;
    return call(req);
  };
  const root = await new Orchestrator(ws, model).run({ runId: null, title: 'X', goal: 'X' });
  assert.equal(root.status, 'blocked');
  assert.match(root.failure ?? '', /no monthly budget/);
  assert.match(root.resolution ?? '', /Settings/);
  assert.equal(calls, 0);
  assert.equal(ws.spentThisMonth(), 0);
});

test('M3: a call that would exceed the monthly budget is blocked and spend is recorded', async (t) => {
  const ws = setup(t);
  ws.updateSetting('budget', '20');
  ws.recordSpend({ taskId: null, model: 'test', inputTokens: 0, outputTokens: 0, costUsd: 19.6 });
  const root = await new Orchestrator(ws, scripted([sub({ title: 'X' })], {}, { billable: true, cost: 0.3 })).run({ runId: null, title: 'X', goal: 'X' });
  // The plan call fits ($0.30 of $0.40 left); the work call does not.
  assert.equal(root.status, 'blocked');
  assert.match(root.failure ?? '', /would exceed the monthly budget/);
  assert.ok(Math.abs(ws.spentThisMonth() - 19.9) < 1e-9);
  assert.ok(Math.abs(root.costUsd - 0.3) < 1e-9);
});

test('M3: the spend ledger is append-only', (t) => {
  const ws = setup(t);
  ws.recordSpend({ taskId: null, model: 'test', inputTokens: 1, outputTokens: 1, costUsd: 1 });
  const db = (ws as unknown as { db: { exec: (sql: string) => void } }).db;
  assert.throws(() => db.exec('UPDATE spend SET cost_usd = 0'), /append-only/);
  assert.throws(() => db.exec('DELETE FROM spend'), /append-only/);
  assert.throws(() => ws.recordSpend({ taskId: null, model: 'test', inputTokens: 0, outputTokens: 0, costUsd: -1 }), ValidationError);
});

test('M3: an invalid plan from the model fails the request', async (t) => {
  const ws = setup(t);
  const model = new SimulatedModel(() => ({ text: 'Sure! Here is my plan: do everything.' }));
  const root = await new Orchestrator(ws, model).run({ runId: null, title: 'X', goal: 'X' });
  assert.equal(root.status, 'failed');
  assert.match(root.failure ?? '', /did not match its contract: not valid JSON/);
});

test('M3: an empty result fails verification', async (t) => {
  const ws = setup(t);
  const root = await new Orchestrator(ws, scripted([sub({ title: 'X' })], { X: { text: '' } })).run({ runId: null, title: 'X', goal: 'X' });
  assert.equal(root.status, 'failed');
  assert.match(children(ws, root.id)[0]!.failure ?? '', /did not pass verification: the result is empty/);
});

test('M3: the agent only works on a run that has been started', async (t) => {
  const ws = setup(t);
  const p = ws.createProject({ name: 'P' });
  const r = ws.startRun({ projectId: p.id, workflow: 'build' });
  const orch = new Orchestrator(ws, new SimulatedModel());
  await assert.rejects(orch.run({ runId: r.id, title: 'X', goal: 'X' }), ValidationError);
  for (const to of ['planned', 'approved', 'running'] as const) ws.transitionRun(r.id, { to });
  const root = await orch.run({ runId: r.id, title: 'X', goal: 'X' });
  assert.equal(root.status, 'succeeded');
  assert.equal(ws.listAgentTasks({ runId: r.id }).length, 3);
  const types = ws.listEvents({ runId: r.id }).map((e) => e.type);
  assert.ok(types.includes('agent.strategy.chosen'));
  assert.ok(types.includes('agent.task.status'));
});

test('M3: secrets in a goal are redacted before storage', async (t) => {
  const ws = setup(t);
  const root = await new Orchestrator(ws, new SimulatedModel()).run({ runId: null, title: 'X', goal: 'Use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' });
  assert.doesNotMatch(JSON.stringify(ws.getAgentTask(root.id)), /abcdefghijklmnop/);
  assert.equal(ws.getAgentTask(root.id).spec.maxOutputTokens, 4_000);
});

test('M3: plans are validated field by field', () => {
  assert.deepEqual(parsePlan('{"subtasks":[]}'), { error: 'no subtasks' });
  assert.match((parsePlan('{"subtasks":[{"title":"A"}]}') as { error: string }).error, /title and a goal/);
  assert.match((parsePlan('{"subtasks":[{"title":"A","goal":"g","risk":"extreme"}]}') as { error: string }).error, /unknown risk/);
  assert.match((parsePlan('{"subtasks":[{"title":"A","goal":"g"},{"title":"A","goal":"h"}]}') as { error: string }).error, /unique/);
  const ok = parsePlan('```json\n{"subtasks":[{"title":"A","goal":"g"}]}\n```');
  assert.ok('subtasks' in ok && ok.subtasks[0]!.risk === 'medium');
});

test('M3: dependency ordering rejects unknown and circular dependencies', () => {
  assert.match((orderSubtasks([sub({ title: 'A', dependsOn: ['Z'] })]) as { error: string }).error, /unknown subtask "Z"/);
  assert.match((orderSubtasks([sub({ title: 'A', dependsOn: ['B'] }), sub({ title: 'B', dependsOn: ['A'] })]) as { error: string }).error, /circular/);
});

test('M3: strategy rules stay sequential for high risk or when a team is unaffordable', () => {
  const big = ['A', 'B', 'C'].map((title) => sub({ title, estTokens: 10_000, writes: [title] }));
  assert.equal(chooseStrategy(big, { remainingUsd: null, estimatedUsd: 0 }).strategy, 'team');
  assert.equal(chooseStrategy(big.map((s, i) => (i === 0 ? { ...s, risk: 'high' } : s)), { remainingUsd: null, estimatedUsd: 0 }).strategy, 'subagents');
  const poor = chooseStrategy(big, { remainingUsd: 1, estimatedUsd: 1 });
  assert.equal(poor.strategy, 'subagents');
  assert.match(poor.rationale.join(' '), /remaining budget/);
  assert.equal(chooseStrategy(big.map((s) => ({ ...s, estTokens: 100 })), { remainingUsd: null, estimatedUsd: 0 }).strategy, 'single');
});
