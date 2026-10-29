import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_RUNS, runStats } from '../src/core/iterate/runs.ts';
import type { AuditEvent, Build } from '../src/core/workspace.ts';

const NOW = new Date('2026-10-29T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const build = (id: string, d: number, extra: Partial<Build> & { agentStatus?: string; cost?: number } = {}): Build =>
  ({
    id,
    title: `Task ${id}`,
    status: 'completed',
    risks: [],
    updatedAt: daysAgo(d),
    agent: { status: extra.agentStatus ?? 'done', costUsd: extra.cost ?? 0.1, at: daysAgo(d) },
    ...extra,
  }) as unknown as Build;
const followUp = (buildId: string): AuditEvent => ({ seq: 1, at: '', actor: 'app', type: 'build.agent', projectId: null, runId: null, payload: { buildId, followUp: true } });

test('M18-9: runs end clean, with the person stepping in, or failed; drafts and running work are left out', () => {
  const s = runStats(
    [
      build('a', 1),
      build('b', 2, { cost: 0.3 }),
      build('c', 3, { agentStatus: 'failed' }),
      build('d', 4, { status: 'abandoned' }),
      build('e', 5, { risks: [{ kind: 'regression', detail: '' }] }),
      build('f', 0.5, { status: 'in_progress' }),
      build('g', 0.5, { status: 'draft', agent: null }),
    ],
    [followUp('b'), followUp('b')],
    NOW,
  );
  assert.deepEqual(
    s.runs.map((r) => [r.buildId, r.outcome]),
    [
      ['e', 'failed'],
      ['d', 'failed'],
      ['c', 'failed'],
      ['b', 'stepped'],
      ['a', 'clean'],
    ],
  );
  assert.equal(s.success.now, 40);
  assert.equal(s.failures.now, 3);
  assert.equal(s.steppedIn.now, 2);
  assert.equal(s.medianCost.now, 0.1);
});

test('M18-9: this week is compared with the week before, day by day for two weeks, and nothing is made up for an empty week', () => {
  const s = runStats([build('a', 1, { cost: 0.2 }), build('b', 1.5, { cost: 0.4 }), build('c', 9, { agentStatus: 'failed', cost: 1 })], [], NOW);
  assert.deepEqual([s.success.now, s.success.before], [100, 0]);
  assert.deepEqual([s.medianCost.now, s.medianCost.before], [0.30000000000000004, 1]);
  assert.equal(s.success.days.length, 14);
  assert.equal(s.success.days[12], 100, 'both runs between one and two days ago');
  assert.equal(s.success.days[13], null);
  assert.equal(s.success.days[4], 0, 'the failed run nine days ago');
  assert.equal(s.success.days[0], null, 'no runs that day');
  const empty = runStats([], [], NOW);
  assert.deepEqual([empty.success.now, empty.medianCost.now, empty.steppedIn.now, empty.failures.before], [null, null, null, null]);
  const many = runStats(Array.from({ length: 80 }, (_, i) => build(`x${i}`, i / 10)), [], NOW);
  assert.equal(many.runs.length, MAX_RUNS);
});
