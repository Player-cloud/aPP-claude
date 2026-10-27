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
  t.after(cleanup);
  const s = new AppService(home, '0.0.0-test');
  t.after(() => s.close());
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
  t.after(cleanup);
  const s = new AppService(home, '0.0.0-test');
  t.after(() => s.close());
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
  t.after(cleanup);
  writeFileSync(join(home, 'iap.db'), 'garbage '.repeat(400));
  const s = new AppService(home, '0.0.0-test');
  t.after(() => s.close());
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
