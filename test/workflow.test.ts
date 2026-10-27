import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedTransitions, planTransition, TERMINAL_STATES, type RunState } from '../src/core/workflow.ts';
import { InvalidTransitionError, ValidationError } from '../src/core/errors.ts';

const at = (state: RunState): { state: RunState; blockedFrom: RunState | null } => ({ state, blockedFrom: null });

test('M1-AC4: the documented forward path is accepted', () => {
  const path = ['planned', 'approved', 'running', 'verification', 'awaiting_approval', 'completed'] as const;
  let current = at('draft');
  for (const to of path) current = { ...current, ...planTransition(current, { to }) };
  assert.equal(current.state, 'completed');
});

test('M1-AC4: skipping states is rejected', () => {
  assert.throws(() => planTransition(at('draft'), { to: 'running' }), InvalidTransitionError);
  assert.throws(() => planTransition(at('running'), { to: 'completed' }), InvalidTransitionError);
  assert.throws(() => planTransition(at('verification'), { to: 'completed' }), InvalidTransitionError);
});

test('M1-AC4: terminal states allow no transitions', () => {
  for (const state of TERMINAL_STATES) {
    assert.deepEqual(allowedTransitions(state), []);
    assert.throws(() => planTransition(at(state), { to: 'running' }), InvalidTransitionError);
  }
});

test('M1-AC4: rework paths return to earlier states', () => {
  assert.equal(planTransition(at('verification'), { to: 'running' }).state, 'running');
  assert.equal(planTransition(at('awaiting_approval'), { to: 'running' }).state, 'running');
  assert.equal(planTransition(at('planned'), { to: 'draft' }).state, 'draft');
});

test('M1-AC5: blocking requires a reason and a resolution', () => {
  assert.throws(() => planTransition(at('running'), { to: 'blocked' }), ValidationError);
  assert.throws(() => planTransition(at('running'), { to: 'blocked', reason: 'EGM missing' }), ValidationError);
  const blocked = planTransition(at('running'), { to: 'blocked', reason: 'EGM missing', resolution: 'Install EGM' });
  assert.deepEqual(blocked, {
    state: 'blocked',
    blockedFrom: 'running',
    blockerReason: 'EGM missing',
    blockerResolution: 'Install EGM',
  });
});

test('M1-AC5: a blocked run resumes only to the state it was blocked from', () => {
  const blocked = { state: 'blocked' as const, blockedFrom: 'running' as const };
  assert.deepEqual(allowedTransitions('blocked', 'running'), ['running', 'cancelled', 'failed']);
  assert.equal(planTransition(blocked, { to: 'running' }).blockedFrom, null);
  assert.throws(() => planTransition(blocked, { to: 'verification' }), InvalidTransitionError);
});

test('a failed run must say why', () => {
  assert.throws(() => planTransition(at('running'), { to: 'failed' }), ValidationError);
  assert.equal(planTransition(at('running'), { to: 'failed', reason: 'tests failed' }).state, 'failed');
});
