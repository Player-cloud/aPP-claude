import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tempHome } from './helpers.ts';
import { moveCorruptStateAside, SCHEMA_VERSION, Workspace } from '../src/core/workspace.ts';
import { NotFoundError, StateCorruptError, StateTooNewError, ValidationError } from '../src/core/errors.ts';
import { appPaths } from '../src/core/paths.ts';

test('M1-AC1/AC2: a project gets a stable id, workspace, status, designs folder and fact split', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const ws = Workspace.open(home, { actor: 'tester' });
  const p = ws.createProject({
    name: '  Recipe app ',
    idea: 'Share recipes',
    facts: [
      { kind: 'confirmed', text: 'Web first' },
      { kind: 'assumption', text: 'Users want offline mode' },
    ],
  });
  assert.match(p.id, /^prj_[0-9a-f-]{36}$/);
  assert.equal(p.name, 'Recipe app');
  assert.equal(p.status, 'active');
  assert.ok(p.docsPath.endsWith(['docs', 'designs'].join(process.platform === 'win32' ? '\\' : '/')));
  assert.ok(existsSync(p.docsPath));
  assert.deepEqual(p.facts.map((f) => f.kind), ['confirmed', 'assumption']);
  ws.close();
});

test('project input is validated', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const ws = Workspace.open(home);
  assert.throws(() => ws.createProject({ name: '   ' }), ValidationError);
  assert.throws(() => ws.createProject({ name: 'x'.repeat(121) }), ValidationError);
  assert.throws(() => ws.createProject({ name: 'ok', facts: [{ kind: 'maybe' as never, text: 'x' }] }), ValidationError);
  assert.throws(() => ws.getProject('prj_missing'), NotFoundError);
  assert.throws(() => ws.startRun({ projectId: 'prj_missing', workflow: 'plan' }), NotFoundError);
  ws.close();
});

test('M1-AC3: projects, runs and events survive close and reopen', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  let ws = Workspace.open(home);
  const p = ws.createProject({ name: 'Persisted' });
  const r = ws.startRun({ projectId: p.id, workflow: 'plan', title: 'Initial plan' });
  ws.transitionRun(r.id, { to: 'planned' });
  ws.transitionRun(r.id, { to: 'blocked', reason: 'EGM not installed', resolution: 'Install EGM or use native planner' });
  ws.close();

  ws = Workspace.open(home);
  assert.deepEqual(ws.listProjects().map((x) => x.id), [p.id]);
  const reopened = ws.getRun(r.id);
  assert.equal(reopened.state, 'blocked');
  assert.equal(reopened.blockedFrom, 'planned');
  assert.equal(reopened.blockerResolution, 'Install EGM or use native planner');
  const types = ws.listEvents({ runId: r.id }).map((e) => e.type);
  assert.deepEqual(types, ['run.created', 'run.transitioned', 'run.transitioned']);
  ws.close();
});

test('M1-AC6: every change is audited and the audit log is append-only', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const ws = Workspace.open(home, { actor: 'tester' });
  const p = ws.createProject({ name: 'Audited' });
  const r = ws.startRun({ projectId: p.id, workflow: 'build' });
  ws.transitionRun(r.id, { to: 'planned' });
  const events = ws.listEvents({ projectId: p.id });
  assert.deepEqual(events.map((e) => e.type), ['project.created', 'run.created', 'run.transitioned']);
  assert.ok(events.every((e) => e.actor === 'tester'));
  assert.deepEqual(events[2]!.payload, { from: 'draft', to: 'planned', reason: null, resolution: null });
  ws.close();

  const raw = new DatabaseSync(appPaths(home).db);
  assert.throws(() => raw.exec("UPDATE events SET type = 'forged'"), /append-only/);
  assert.throws(() => raw.exec('DELETE FROM events'), /append-only/);
  raw.close();
});

test('M1-AC4: an invalid transition leaves state and audit log unchanged', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const ws = Workspace.open(home);
  const p = ws.createProject({ name: 'Strict' });
  const r = ws.startRun({ projectId: p.id, workflow: 'ship' });
  const before = ws.listEvents().length;
  assert.throws(() => ws.transitionRun(r.id, { to: 'completed' }));
  assert.equal(ws.getRun(r.id).state, 'draft');
  assert.equal(ws.listEvents().length, before);
  ws.close();
});

test('M1-AC8: secrets in ideas, facts, blockers and events are redacted before storage', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const key = 'sk-ant-api03-SECRETSECRETSECRET';
  const ws = Workspace.open(home);
  const p = ws.createProject({ name: 'Leaky', idea: `use ${key}`, facts: [{ kind: 'confirmed', text: `key ${key}` }] });
  const r = ws.startRun({ projectId: p.id, workflow: 'plan' });
  ws.transitionRun(r.id, { to: 'planned' });
  ws.transitionRun(r.id, { to: 'blocked', reason: `auth failed for ${key}`, resolution: 'rotate key' });
  ws.close();
  const bytes = readFileSync(appPaths(home).db).toString('latin1');
  const wal = existsSync(appPaths(home).db + '-wal') ? readFileSync(appPaths(home).db + '-wal').toString('latin1') : '';
  assert.ok(!bytes.includes(key) && !wal.includes(key), 'raw key found in database files');
});

test('M1-AC7: a corrupt database raises a recoverable error and is not overwritten', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const { db } = appPaths(home);
  Workspace.open(home).close();
  const garbage = 'this is definitely not a sqlite database '.repeat(200);
  writeFileSync(db, garbage);
  for (const ext of ['-wal', '-shm']) if (existsSync(db + ext)) writeFileSync(db + ext, '');

  assert.throws(() => Workspace.open(home), (e: unknown) => e instanceof StateCorruptError && /iap recover --confirm/.test(e.message));
  assert.equal(readFileSync(db, 'utf8'), garbage, 'corrupt file must be left untouched');

  const moved = moveCorruptStateAside(home, new Date('2026-10-27T12:00:00Z'));
  assert.ok(moved && existsSync(moved));
  assert.equal(readFileSync(moved, 'utf8'), garbage, 'corrupt file is preserved after recovery');
  const fresh = Workspace.open(home);
  assert.deepEqual(fresh.listProjects(), []);
  fresh.close();
});

test('a database from a newer app version is refused, not downgraded', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  Workspace.open(home).close();
  const raw = new DatabaseSync(appPaths(home).db);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  raw.close();
  assert.throws(() => Workspace.open(home), StateTooNewError);
  const check = new DatabaseSync(appPaths(home).db);
  assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION + 1);
  check.close();
});

test('M2-AC6: settings are validated, persisted and audited', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  let ws = Workspace.open(home, { actor: 'tester' });
  assert.deepEqual(ws.getSettings(), { theme: 'dark', glass: 'on', budget: 'none' });
  assert.throws(() => ws.updateSetting('glass', 'maybe'), ValidationError);
  assert.throws(() => ws.updateSetting('theme', 'neon'), ValidationError);
  assert.throws(() => ws.updateSetting('telemetry', 'on'), ValidationError);
  ws.updateSetting('theme', 'light');
  ws.updateSetting('theme', 'light'); // no-op: no duplicate audit event
  ws.close();
  ws = Workspace.open(home);
  assert.equal(ws.getSettings().theme, 'light');
  const changes = ws.listEvents().filter((e) => e.type === 'setting.changed');
  assert.deepEqual(changes.map((e) => e.payload), [{ key: 'theme', from: 'dark', to: 'light' }]);
  ws.close();
});

test('a version 1 database is migrated forward without losing data', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  let ws = Workspace.open(home);
  const p = ws.createProject({ name: 'Old' });
  ws.close();
  const raw = new DatabaseSync(appPaths(home).db);
  raw.exec('DROP TABLE release_exceptions; DROP TABLE release_check_runs; DROP TABLE releases; DROP TABLE settings; DROP TABLE tool_scans; DROP TABLE spend; DROP TABLE agent_tasks; DROP TABLE plan_docs; DROP TABLE check_runs; ALTER TABLE builds DROP COLUMN result_commit; DROP TABLE builds; ALTER TABLE projects DROP COLUMN repo_path; PRAGMA user_version = 1;');
  raw.close();
  ws = Workspace.open(home);
  assert.equal(ws.getProject(p.id).name, 'Old');
  assert.equal(ws.health().schemaVersion, SCHEMA_VERSION);
  ws.updateSetting('theme', 'system');
  ws.close();
});
