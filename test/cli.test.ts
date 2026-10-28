// End-to-end: each command runs in a separate process, so a project created in
// one process and read in the next proves persistence across restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tempHome } from './helpers.ts';
import { buildClaudeFixture, CANARIES } from './claude-fixture.ts';
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

test('M4: `tools scan` reports conflicts and `tools show` reads the stored scan in a new process', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const roots = buildClaudeFixture(join(home, 'fixture'));
  const env = { CLAUDE_CONFIG_DIR: roots.configDir };
  const scan = iapEnv(env, join(home, 'app'), 'tools', 'scan', '--include', roots.project);
  assert.equal(scan.code, 0, scan.err);
  assert.match(scan.out, /\[confirmed\] Plugin ghost@acme is enabled but not installed/);
  assert.match(scan.out, /\[potential\] 2 tools answer \/deploy/);
  const shown = JSON.parse(iapEnv(env, join(home, 'app'), 'tools', 'show', '--json').out);
  assert.equal(shown.roots.projectDirs[0], roots.project);
  for (const canary of CANARIES) assert.ok(!scan.out.includes(canary));
});

function iapEnv(extra: Record<string, string>, home: string, ...args: string[]) {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], {
    env: { ...process.env, ...extra, IAP_HOME: home },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('M3: iap agent run plans, runs and reconciles with the simulated model', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const project = JSON.parse(iap(home, 'project', 'create', '--name', 'Agent', '--json').out);
  const run = JSON.parse(iap(home, 'run', 'start', project.id, '--workflow', 'build', '--json').out);
  const early = iap(home, 'agent', 'run', run.id, '--goal', 'Write a README');
  assert.equal(early.code, 1);
  assert.match(early.err, /only work on a run that has been started/);
  for (const to of ['planned', 'approved', 'running']) assert.equal(iap(home, 'run', 'move', run.id, to).code, 0);

  const done = iap(home, 'agent', 'run', run.id, '--goal', 'Write a README');
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /request\s+succeeded\s+Write a README\s+\[single\]/);
  assert.match(done.out, /Simulated model: no AI was called/);
  assert.match(done.out, /reconcile\s+succeeded/);

  const listed = JSON.parse(iap(home, 'agent', 'list', run.id, '--json').out);
  assert.deepEqual(listed.map((x: { kind: string }) => x.kind), ['request', 'subtask', 'reconcile']);
  assert.equal(iap(home, 'agent', 'run', '--goal', '').code, 1);
});

test('M5: iap plan drafts, edits, approves and compares in separate processes', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const project = JSON.parse(iap(home, 'project', 'create', '--name', 'Plans', '--idea', 'A recipe box', '--json').out);
  assert.match(iap(home, 'plan', 'show', project.id).out, /Concept brief:\n  not started/);
  assert.equal(iap(home, 'plan', 'spec', project.id).code, 1);

  const draft = JSON.parse(iap(home, 'plan', 'brief', project.id, '--json').out);
  assert.equal(draft.source, 'simulated');
  const refused = iap(home, 'plan', 'approve', draft.id);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /placeholder/);

  const file = join(home, 'brief.json');
  writeFileSync(file, JSON.stringify({ goals: ['Keep recipes'], users: ['Cooks'], scope: ['Local'], successCriteria: ['Survives a restart'] }));
  assert.equal(iap(home, 'plan', 'edit', draft.id, '--file', file).code, 0);
  const approved = iap(home, 'plan', 'approve', draft.id);
  assert.equal(approved.code, 0, approved.err);
  assert.match(approved.out, /brief v1 approved/);

  const next = JSON.parse(iap(home, 'plan', 'revise', draft.id, '--json').out);
  writeFileSync(file, JSON.stringify({ goals: ['Keep and share recipes'], users: ['Cooks'], scope: ['Local'], successCriteria: ['Survives a restart'] }));
  assert.equal(iap(home, 'plan', 'edit', next.id, '--file', file, '--note', 'Sharing is in').code, 0);
  assert.match(iap(home, 'plan', 'approve', next.id).out, /added goals: Keep and share recipes\n\s+removed goals: Keep recipes/);
  assert.match(iap(home, 'plan', 'diff', draft.id, next.id).out, /added\s+goals: Keep and share recipes/);
  const shown = iap(home, 'plan', 'show', project.id).out;
  assert.match(shown, /v2\s+approved/);
  assert.match(shown, /v1\s+superseded/);
  assert.match(shown, /EGM: EGM was not checked/);
  assert.equal(iap(home, 'plan', 'edit', next.id).code, 1, '--file is required');
});

test('M6: iap build runs a bug fix from start to done, with approval and evidence', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const project = JSON.parse(iap(home, 'project', 'create', '--name', 'Fixes', '--json').out);
  assert.match(iap(home, 'build', 'repo', project.id, '--init').out, /happens in/);
  const created = iap(home, 'build', 'new', project.id, '--kind', 'bugfix', '--title', 'Crash', '--goal', 'It crashes', '--repro', 'Open it', '--check', 'unit=node -e "process.exit(0)"', '--json');
  assert.equal(created.code, 0, created.err);
  const build = JSON.parse(created.out);
  const unconfirmed = iap(home, 'build', 'start', build.id);
  assert.equal(unconfirmed.code, 1);
  assert.match(unconfirmed.err, /unit: node -e "process.exit\(0\)"\nRe-run with --confirm/);
  const started = iap(home, 'build', 'start', build.id, '--confirm');
  assert.equal(started.code, 0, started.err);
  assert.match(started.out, /baseline unit\s+passed\s+exit 0/);
  assert.match(iap(home, 'build', 'agent', build.id).out, /agent \(simulated\): done, 1 tool calls, files written: none/);
  const verified = iap(home, 'build', 'verify', build.id).out;
  assert.match(verified, /risk no_change/);
  assert.equal(iap(home, 'build', 'done', build.id).code, 1);
  assert.match(iap(home, 'build', 'done', build.id, '--note', 'Not reproducible on this machine.').out, /bugfix completed/);
  assert.match(iap(home, 'build', 'list', project.id).out, /bugfix\s+completed\s+Crash/);
  assert.equal(iap(home, 'build', 'new', project.id, '--kind', 'bugfix', '--title', 't', '--goal', 'g', '--repro', 'r', '--check', 'nocommand').code, 1);
});

test('M7: iap release runs the ship-check with approval, blocks on failed gates and prepares without deploying', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const project = JSON.parse(iap(home, 'project', 'create', '--name', 'Ship', '--json').out);
  assert.equal(iap(home, 'build', 'repo', project.id, '--init').code, 0);
  assert.equal(iap(home, 'release', 'new', project.id, '--version', 'soon', '--check', 'ok=node -v').code, 1);
  const created = iap(home, 'release', 'new', project.id, '--version', '0.1.0', '--check', 'ok=node -e "process.exit(0)"', '--target', 'Local zip', '--json');
  assert.equal(created.code, 0, created.err);
  const release = JSON.parse(created.out);
  const unconfirmed = iap(home, 'release', 'check', release.id);
  assert.equal(unconfirmed.code, 1);
  assert.match(unconfirmed.err, /ok: node -e "process.exit\(0\)"\nRe-run with --confirm/);
  const blocked = iap(home, 'release', 'check', release.id, '--confirm');
  assert.equal(blocked.code, 4, blocked.err);
  assert.match(blocked.out, /FAILED\s+required plan\s+Missing: health check, rollback or mitigation/);
  assert.match(blocked.out, /PASSED\s+required tests\s+All 1 checks passed/);
  assert.match(blocked.out, /SKIPPED\s+optional reviews/);
  assert.equal(iap(home, 'release', 'prepare', release.id).code, 1);
  assert.equal(iap(home, 'release', 'plan', release.id, '--health', 'Unzip and run it', '--rollback', 'Delete the zip').code, 0);
  for (const gate of ['spec', 'drift', 'builds']) {
    assert.equal(iap(home, 'release', 'except', release.id, gate, '--reason', 'Trying the flow', '--mitigation', 'Nobody receives it').code, 1, 'needs a fresh check');
  }
  assert.equal(iap(home, 'release', 'check', release.id, '--confirm').code, 4);
  for (const gate of ['spec', 'drift', 'builds']) {
    const r = iap(home, 'release', 'except', release.id, gate, '--reason', 'Trying the flow', '--mitigation', 'Nobody receives it');
    assert.equal(r.code, 0, r.err);
  }
  const prepared = iap(home, 'release', 'prepare', release.id);
  assert.equal(prepared.code, 0, prepared.err);
  assert.match(prepared.out, /Nothing was deployed, tagged or pushed/);
  assert.match(iap(home, 'release', 'list', project.id).out, /0\.1\.0\s+prepared\s+ready/);
});
