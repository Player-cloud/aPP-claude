// End-to-end: each command runs in a separate process, so a project created in
// one process and read in the next proves persistence across restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tempHome } from './helpers.ts';
import { appPaths } from '../src/core/paths.ts';

const CLI = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

function iap(home: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], {
    env: { ...process.env, IAP_HOME: home },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('M1 end to end: create, restart, run lifecycle with a blocker, audit trail', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);

  const created = iap(home, 'project', 'create', '--name', 'Demo', '--idea', 'A demo', '--confirmed', 'Windows', '--assumption', 'Solo user', '--json');
  assert.equal(created.code, 0, created.err);
  const project = JSON.parse(created.out);

  const listed = iap(home, 'project', 'list', '--json');
  assert.deepEqual(JSON.parse(listed.out).map((p: { id: string }) => p.id), [project.id]);

  const run = JSON.parse(iap(home, 'run', 'start', project.id, '--workflow', 'plan', '--json').out);
  assert.equal(run.state, 'draft');
  assert.equal(iap(home, 'run', 'move', run.id, 'planned').code, 0);

  const blocked = iap(home, 'run', 'move', run.id, 'blocked', '--reason', 'EGM missing', '--resolution', 'Install EGM');
  assert.equal(blocked.code, 0, blocked.err);
  assert.match(blocked.out, /BLOCKED \(from planned\): EGM missing/);
  assert.match(blocked.out, /To resolve: Install EGM/);

  const shown = iap(home, 'project', 'show', project.id);
  assert.match(shown.out, /confirmed \(1\):\n\s+- Windows/);
  assert.match(shown.out, /assumptions \(1\):\n\s+- Solo user/);
  assert.match(shown.out, /To resolve: Install EGM/);

  const bad = iap(home, 'run', 'move', run.id, 'completed');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Allowed: planned, cancelled, failed/);

  const events = JSON.parse(iap(home, 'events', '--project', project.id, '--json').out);
  assert.deepEqual(events.map((e: { type: string }) => e.type), ['project.created', 'run.created', 'run.transitioned', 'run.transitioned']);

  const doctor = iap(home, 'doctor', '--json');
  assert.equal(doctor.code, 0);
  assert.equal(JSON.parse(doctor.out).integrity, 'ok');
});

test('M1-AC7 via CLI: corrupt state exits 2 with recovery instructions; recover needs --confirm', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  assert.equal(iap(home, 'project', 'create', '--name', 'Doomed').code, 0);
  writeFileSync(appPaths(home).db, 'garbage '.repeat(500));
  writeFileSync(appPaths(home).db + '-wal', '');

  const broken = iap(home, 'project', 'list');
  assert.equal(broken.code, 2);
  assert.match(broken.err, /Nothing has been changed\. Run "iap recover --confirm"/);

  assert.equal(iap(home, 'recover').code, 1);
  const recovered = iap(home, 'recover', '--confirm');
  assert.equal(recovered.code, 0);
  assert.match(recovered.out, /iap\.db\.corrupt-/);
  assert.equal(iap(home, 'project', 'list').code, 0);
});

test('recover refuses to move a healthy database', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  assert.equal(iap(home, 'project', 'create', '--name', 'Healthy').code, 0);
  const r = iap(home, 'recover', '--confirm');
  assert.equal(r.code, 1);
  assert.match(r.err, /nothing to recover/);
  assert.equal(JSON.parse(iap(home, 'project', 'list', '--json').out).length, 1);
});

test('usage errors exit 1 with guidance', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  assert.equal(iap(home).code, 1);
  const missing = iap(home, 'project', 'create');
  assert.equal(missing.code, 1);
  assert.match(missing.err, /Project name is required/);
  assert.equal(iap(home, 'run', 'start', 'prj_nope', '--workflow', 'plan').code, 1);
  assert.equal(iap(home, 'project', 'create', '--bogus').code, 1);
});
