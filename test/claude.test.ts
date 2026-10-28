// The Claude adapter is tested against a fake client: no test ever calls the
// real API or spends money.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { tempHome } from './helpers.ts';
import { Workspace } from '../src/core/workspace.ts';
import { appPaths } from '../src/core/paths.ts';
import { CLAUDE_MODEL, ClaudeModel, type ClaudeClient } from '../src/core/agents/claude.ts';
import { SimulatedModel } from '../src/core/agents/model.ts';
import { Orchestrator } from '../src/core/agents/orchestrator.ts';
import { AppService } from '../src/main/service.ts';
import { MemoryKeyStore } from '../src/main/keystore.ts';

type Reply = { text: string; stop?: Anthropic.StopReason; input?: number; output?: number };

function fakeClient(reply: (body: Anthropic.MessageCreateParamsNonStreaming) => Reply) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: ClaudeClient = {
    messages: {
      async create(body) {
        calls.push(body);
        const r = reply(body);
        return {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: r.text, citations: null }],
          stop_reason: r.stop ?? 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: r.input ?? 1_000, output_tokens: r.output ?? 500 },
        } as unknown as Anthropic.Message;
      },
    },
  };
  return { client, calls };
}

const plan = (titles: string[]) =>
  JSON.stringify({ subtasks: titles.map((title) => ({ title, goal: `Do ${title}`, writes: [], dependsOn: [], risk: 'low', estTokens: 1000 })) });

function setup(t: { after: (fn: () => void) => void }) {
  const { home, cleanup } = tempHome();
  const ws = Workspace.open(home);
  t.after(() => {
    ws.close();
    cleanup();
  });
  return { ws, home };
}

test('Claude adapter: plan calls ask for schema-checked JSON, work calls for text, on the default model', async () => {
  const { client, calls } = fakeClient((b) => ({ text: b.output_config?.format ? plan(['A']) : 'done' }));
  const model = new ClaudeModel(client);
  const signal = new AbortController().signal;
  const p = await model.call({ purpose: 'plan', taskTitle: 'T', instructions: 'Goal', maxOutputTokens: 8_000, signal });
  const w = await model.call({ purpose: 'work', taskTitle: 'T', instructions: 'Goal', maxOutputTokens: 8_000, signal });
  assert.equal(calls[0]!.model, CLAUDE_MODEL);
  assert.equal(calls[0]!.output_config?.format?.type, 'json_schema');
  assert.equal(calls[1]!.output_config?.format, undefined);
  assert.equal(calls[0]!.max_tokens, 8_000);
  assert.equal(p.text, plan(['A']));
  assert.equal(w.text, 'done');
  // $4 / $20 per million tokens.
  assert.ok(Math.abs(w.costUsd - (1_000 * 4 + 500 * 20) / 1e6) < 1e-12);
  assert.equal(w.problem, undefined);
});

test('Claude adapter: the estimate is an upper bound for a full-length answer', () => {
  const model = new ClaudeModel(fakeClient(() => ({ text: '' })).client);
  const est = model.estimateCostUsd({ purpose: 'work', taskTitle: 'T', instructions: 'x'.repeat(3_000), maxOutputTokens: 8_000 });
  assert.ok(est >= (1_000 * 4 + 8_000 * 20) / 1e6, `estimate ${est}`);
});

test('Claude adapter: cut-off and declined answers are failures, but still paid for', async (t) => {
  const { ws } = setup(t);
  for (const stop of ['max_tokens', 'refusal'] as const) {
    const { client } = fakeClient((b) => (b.output_config?.format ? { text: plan(['A']) } : { text: 'partial', stop }));
    ws.updateSetting('budget', '20');
    const root = await new Orchestrator(ws, new ClaudeModel(client)).run({ runId: null, title: 'X', goal: 'X' });
    assert.equal(root.status, 'failed');
    assert.match(root.failure ?? '', stop === 'refusal' ? /declined/ : /ran out of room/);
  }
  // Two plan calls and two work calls, each 1,000 in / 500 out.
  assert.ok(Math.abs(ws.spentThisMonth() - 4 * 0.014) < 1e-9);
});

test('Claude adapter: a full request plans, works and records what it cost', async (t) => {
  const { ws } = setup(t);
  ws.updateSetting('budget', '20');
  const { client, calls } = fakeClient((b) => (b.output_config?.format ? { text: plan(['Outline']) } : { text: 'An outline.' }));
  const root = await new Orchestrator(ws, new ClaudeModel(client)).run({ runId: null, title: 'Docs', goal: 'Outline the docs' });
  assert.equal(root.status, 'succeeded');
  assert.equal(root.output, 'An outline.');
  assert.equal(root.model, CLAUDE_MODEL);
  assert.equal(calls.length, 2);
  assert.ok(Math.abs(ws.spentThisMonth() - 2 * 0.014) < 1e-9);
});

test('Budget: subtasks stop at the cap, and a team is not chosen when it would not fit', async (t) => {
  const { ws } = setup(t);
  ws.updateSetting('budget', '20');
  ws.recordSpend({ taskId: null, model: 'test', inputTokens: 0, outputTokens: 0, costUsd: 18.5 });
  // $1.50 left: the plan ($0.40) and two $0.50 subtasks fit; the third does not.
  const subtasks = ['A', 'B', 'C'].map((title) => ({ title, goal: title, writes: [title], dependsOn: [], risk: 'low', estTokens: 20_000 }));
  const model = new SimulatedModel(
    (req) => (req.purpose === 'plan' ? { text: JSON.stringify({ subtasks }), costUsd: 0.4 } : { text: 'ok', costUsd: 0.5, delayMs: 30 }),
    { billable: true },
  );
  const root = await new Orchestrator(ws, model).run({ runId: null, title: 'Three', goal: 'Three' });
  assert.equal(root.strategy, 'subagents', 'a team is not affordable');
  // Sequential subagents: A and B fit after the plan (0.4 + 0.5 + 0.5 = 1.4), C does not.
  const statuses = ws.listAgentTasks({ parentId: root.id }).filter((c) => c.kind === 'subtask').map((c) => c.status);
  assert.deepEqual(statuses, ['succeeded', 'succeeded', 'blocked']);
  assert.ok(ws.spentThisMonth() <= 20);
});

test('Budget: calls in flight at the same time reserve their estimate, so together they cannot pass the cap', async (t) => {
  const { ws } = setup(t);
  ws.updateSetting('budget', '20');
  ws.recordSpend({ taskId: null, model: 'test', inputTokens: 0, outputTokens: 0, costUsd: 19.3 });
  const model = new SimulatedModel((req) => ({ text: req.purpose === 'plan' ? JSON.stringify({ subtasks: [{ title: 'A', goal: 'A' }] }) : 'ok', costUsd: 0.5, delayMs: 30 }), { billable: true });
  const orch = new Orchestrator(ws, model);
  const roots = await Promise.all([orch.run({ runId: null, title: 'one', goal: 'one' }), orch.run({ runId: null, title: 'two', goal: 'two' })]);
  // $0.70 left: only one $0.50 plan call can be in flight; the other is blocked rather than overspending.
  assert.deepEqual(roots.map((r) => r.status).sort(), ['blocked', 'blocked']);
  assert.ok(ws.spentThisMonth() <= 20 + 1e-9, `spent ${ws.spentThisMonth()}`);
});

test('Service: the API key is validated, stored only in the key store, and never returned or logged', async (t) => {
  const { home, cleanup } = tempHome();
  const keys = new MemoryKeyStore();
  const { client, calls } = fakeClient((b) => (b.output_config?.format ? { text: plan(['A']) } : { text: 'real answer' }));
  let usedKey = '';
  const s = new AppService(home, '0.0.0-test', {
    keyStore: keys,
    claudeClient: (key) => {
      usedKey = key;
      return client;
    },
  });
  t.after(() => {
    s.close();
    cleanup();
  });
  const h = s.handlers;
  const mode = () => {
    const r = h.agentStatus();
    return r.ok ? r.value.mode : null;
  };
  const key = 'sk-ant-api03-' + 'k'.repeat(40);
  assert.equal(mode(), 'simulated');

  for (const bad of [undefined, { key: 42 }, { key: 'hello' }, { key: 'sk-ant-short' }]) assert.equal(h.setApiKey(bad).ok, false);
  const stored = h.setApiKey({ key: `  ${key}\n` });
  assert.ok(stored.ok);
  assert.equal(keys.get(), key);
  assert.doesNotMatch(JSON.stringify(stored), /kkkk/);

  // A key alone changes nothing: without a budget the agent stays simulated.
  const p = h.createProject({ name: 'P' });
  assert.ok(p.ok);
  const r = h.startRun({ projectId: p.value.id, workflow: 'build' });
  assert.ok(r.ok);
  for (const to of ['planned', 'approved', 'running']) h.moveRun({ runId: r.value.id, to });
  const simulated = await h.runAgent({ runId: r.value.id, goal: 'Go' });
  assert.ok(simulated.ok && simulated.value.model === 'simulated');
  assert.equal(calls.length, 0);

  h.updateSetting({ key: 'budget', value: '20' });
  assert.equal(mode(), 'claude');
  const real = await h.runAgent({ runId: r.value.id, goal: 'Go' });
  assert.ok(real.ok && real.value.status === 'succeeded' && real.value.output === 'real answer');
  assert.equal(usedKey, key);
  const status = h.agentStatus();
  assert.ok(status.ok && status.value.spentUsd > 0);

  h.clearApiKey();
  assert.equal(mode(), 'needs_key');
  const refused = await h.runAgent({ runId: r.value.id, goal: 'Go' });
  assert.ok(!refused.ok && /no API key is stored/.test(refused.error.message));

  const events = h.listEvents({ limit: 500 });
  assert.ok(events.ok && events.value.some((e) => e.type === 'credential.stored'));
  s.close();
  assert.ok(!readFileSync(appPaths(home).db).includes(Buffer.from('kkkkkkkkkk')), 'the key is not in the database');
});
