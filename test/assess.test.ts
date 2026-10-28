// M8 import and read-only assessment against real git repositories. Nothing
// here runs code from the repository, calls a model or contacts a service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tempHome } from './helpers.ts';
import { Workspace } from '../src/core/workspace.ts';
import { appPaths } from '../src/core/paths.ts';
import { Assessor, parseScope } from '../src/core/assess/assessor.ts';
import { CAPABILITIES } from '../src/core/assess/capabilities.ts';
import { parseTree } from '../src/core/assess/snapshot.ts';
import { AppService } from '../src/main/service.ts';

// Built at run time so this file holds no credential-shaped text.
const FAKE_KEY = ['gh', 'p_', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'].join('');
const CLI = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

function gitIn(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
}

function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A small Express + Postgres app with tests, CI, a committed credential and one uncommitted change. */
function nodeRepo(root: string) {
  write(root, {
    'package.json': JSON.stringify({ name: 'shop', scripts: { test: 'node --test' }, dependencies: { express: '^4.0.0', pg: '^8.0.0', dotenv: '^16.0.0' }, devDependencies: { typescript: '^5.0.0' } }, null, 2),
    'README.md': '# Shop\n\nA small shop API.\n',
    'src/server.js': "import express from 'express';\nimport { Pool } from 'pg';\nconst app = express();\nconst pool = new Pool({ connectionString: process.env.DATABASE_URL });\napp.get('/orders', async (req, res) => res.json((await pool.query('SELECT 1')).rows));\napp.listen(3000);\n",
    'src/config.js': `export const token = '${FAKE_KEY}';\n`,
    'test/server.test.js': "import { test } from 'node:test';\ntest('orders', () => {});\n",
    '.env.example': 'DATABASE_URL=\nSMTP_HOST=\n',
    '.github/workflows/ci.yml': 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n',
    'docs/notes.md': 'We will add Sentry later.\n',
  });
  gitIn(root, 'init', '-q', '-b', 'main');
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'init');
  // Uncommitted: only on disk, so the assessment must not see it.
  write(root, { 'src/mailer.js': "import nodemailer from 'nodemailer';\nnodemailer.createTransport({});\n" });
}

function setup(t: { after: (fn: () => void) => void }) {
  const { home, cleanup } = tempHome();
  const ws = Workspace.open(home);
  t.after(() => {
    ws.close();
    cleanup();
  });
  const repo = join(home, 'shop');
  nodeRepo(repo);
  return { ws, home, repo, assessor: new Assessor(ws) };
}

/** Everything that would show the repository was written to. */
function fingerprint(repo: string) {
  return {
    head: gitIn(repo, 'rev-parse', 'HEAD'),
    refs: gitIn(repo, 'for-each-ref'),
    status: gitIn(repo, '--no-optional-locks', 'status', '--porcelain'),
    index: readFileSync(join(repo, '.git', 'index')).toString('base64'),
    indexMtime: statSync(join(repo, '.git', 'index')).mtimeMs,
    worktrees: existsSync(join(repo, '.git', 'worktrees')),
  };
}

test('M8-AC1: importing records an existing repository and changes nothing in it', async (t) => {
  const { ws, repo, assessor } = setup(t);
  const before = fingerprint(repo);
  await assert.rejects(assessor.importProject({ name: 'Shop', path: 'shop' }), /full path/);
  const plain = join(repo, '..', 'plain');
  mkdirSync(plain);
  await assert.rejects(assessor.importProject({ name: 'Plain', path: plain }), /not a git repository/);

  const p = await assessor.importProject({ name: 'Shop', path: repo, idea: 'Existing shop API' });
  assert.equal(p.origin, 'imported');
  assert.equal(p.repoPath, gitIn(repo, 'rev-parse', '--show-toplevel').trim());
  assert.ok(!p.repoPath!.startsWith(p.workspacePath), 'the repository stays where it is');
  await assert.rejects(assessor.importProject({ name: 'Again', path: repo }), /already the project "Shop"/);
  assert.deepEqual(fingerprint(repo), before);
  assert.equal(ws.listEvents({ projectId: p.id }).find((e) => e.type === 'project.imported')?.payload.repoPath, p.repoPath);
});

test('M8-AC2/AC3: a full assessment reports the codebase and every capability with evidence, read-only', async (t) => {
  const { ws, repo, assessor } = setup(t);
  const p = await assessor.importProject({ name: 'Shop', path: repo });
  const before = fingerprint(repo);
  const a = await assessor.run(p.id, { kind: 'full' });
  assert.deepEqual(fingerprint(repo), before, 'index, refs, status and worktrees are untouched');
  assert.equal(a.status, 'completed');
  const r = a.report!;
  assert.equal(r.unchanged, true);
  assert.equal(a.commit, gitIn(repo, 'rev-parse', 'HEAD').trim());

  // Codebase: structure, stack, dependencies, tests, configuration, documentation.
  const c = r.codebase!;
  assert.equal(c.structure.files, 8);
  assert.deepEqual(c.stack.map((s) => s.name).sort(), ['Express', 'TypeScript']);
  assert.deepEqual(c.dependencies, [{ ecosystem: 'npm', runtime: 3, dev: 1, manifests: ['package.json'], lockfile: null }]);
  assert.equal(c.tests.files, 1);
  assert.ok(c.configuration.some((x) => x.item === 'Continuous integration'));
  assert.ok(c.documentation.some((x) => x.item === 'README'));
  const titles = r.observations.map((o) => o.title);
  assert.ok(titles.includes('Credential-shaped values are committed'));
  assert.ok(titles.includes('No lockfile for npm dependencies'));
  for (const o of r.observations) assert.ok(o.evidence.length && o.confidence && o.impact && o.nextAction, o.title);

  // What was and was not inspected.
  assert.match(r.notInspected.join('\n'), /1 uncommitted change/);
  assert.match(r.notInspected.join('\n'), /never runs code from the repository/);
  assert.match(r.inspected.join('\n'), /from git's object store/);

  // Every capability gets a status with evidence, confidence, impact and a next action.
  assert.equal(r.capabilities.length, CAPABILITIES.length);
  for (const f of r.capabilities) assert.ok(f.evidence.length && f.confidence && f.impact && f.nextAction && f.reasoning, f.id);
  const by = Object.fromEntries(r.capabilities.map((f) => [f.id, f]));
  assert.equal(by.api!.status, 'implemented_in_code');
  assert.ok(by.api!.evidence.some((e) => e.startsWith('src/server.js:5')));
  assert.equal(by.database!.status, 'implemented_in_code');
  assert.equal(by.database!.externalState, 'not_verified', 'code is not proof the database exists');
  assert.equal(by.secrets!.status, 'partly_present', 'a committed credential outweighs reading from the environment');
  assert.match(by.secrets!.nextAction, /revoke/);
  assert.equal(by.email_outbox!.status, 'not_verified', 'a configuration name alone proves nothing');
  assert.equal(by.issues!.status, 'not_verified', 'a mention in the docs proves nothing');
  assert.equal(by.users!.status, 'missing');
  assert.equal(by.domains!.status, 'not_verified');
  assert.ok(!r.capabilities.some((f) => f.status === 'configured_externally'), 'never claimed without a connector');
  // The uncommitted mailer file was not read.
  assert.ok(!JSON.stringify(r).includes('src/mailer.js'));

  // The report lives in the app's folder; the credential value is never stored or shown.
  assert.ok(a.reportPath!.startsWith(p.workspacePath));
  const md = readFileSync(a.reportPath!, 'utf8');
  assert.match(md, /not a compliance certification/);
  assert.match(md, /src\/config\.js:1 \(value not shown\)/);
  const db = readFileSync(appPaths(ws.paths.home).db).toString('latin1');
  for (const text of [md, JSON.stringify(a), db]) assert.ok(!text.includes(FAKE_KEY));
  assert.ok(!existsSync(join(repo, 'docs', 'assessments')));
});

test('M8-AC4: a focused assessment records its scope first and stays inside it', async (t) => {
  const { ws, repo, assessor } = setup(t);
  const p = await assessor.importProject({ name: 'Shop', path: repo });

  const one = await assessor.run(p.id, { kind: 'capability', target: 'api' });
  assert.deepEqual(one.scope, { kind: 'capability', target: 'api', notApplicable: [] });
  const r = one.report!;
  assert.deepEqual(r.capabilities.map((f) => f.id), ['api']);
  assert.equal(r.codebase, null);
  assert.deepEqual(r.observations, []);
  assert.ok(r.disclosed.length > 0, 'what was read to interpret it is disclosed');
  assert.ok(!/credential/i.test(JSON.stringify(r)), 'no credential scan outside the scope');

  const events = ws.listEvents({ projectId: p.id }).filter((e) => e.payload.assessmentId === one.id);
  assert.deepEqual(events.map((e) => e.type), ['assessment.scoped', 'assessment.completed']);
  assert.ok(events[0]!.seq < events[1]!.seq);

  const cat = await assessor.run(p.id, { kind: 'category', target: 'interfaces', notApplicable: ['voice'] });
  assert.ok(cat.report!.capabilities.every((f) => f.category === 'interfaces'));
  assert.equal(cat.report!.capabilities.length, CAPABILITIES.filter((c) => c.category === 'interfaces').length);
  assert.equal(cat.report!.capabilities.find((f) => f.id === 'voice')!.status, 'not_applicable');

  const code = await assessor.run(p.id, { kind: 'codebase' });
  assert.equal(code.report!.capabilities.length, 0);
  assert.ok(code.report!.codebase);

  // The broader assessment can follow later.
  const full = await assessor.run(p.id, { kind: 'full' });
  assert.equal(full.report!.capabilities.length, CAPABILITIES.length);
  assert.equal(ws.listAssessments(p.id).length, 4);
});

test('M8: scopes are validated, and finished assessments can never change or be deleted', async (t) => {
  const { ws, home, repo, assessor } = setup(t);
  assert.throws(() => parseScope({ kind: 'everything' }), /Choose a full assessment/);
  assert.throws(() => parseScope({ kind: 'category', target: 'sales' }), /Choose a category/);
  assert.throws(() => parseScope({ kind: 'capability', target: 'rm -rf' }), /Choose a capability/);
  assert.throws(() => parseScope({ kind: 'full', notApplicable: ['nope'] }), /Not applicable/);
  assert.deepEqual(parseScope(undefined), { kind: 'full', target: null, notApplicable: [] });

  const fresh = ws.createProject({ name: 'No repo' });
  await assert.rejects(assessor.run(fresh.id, {}), /Choose the git repository/);

  const p = await assessor.importProject({ name: 'Shop', path: repo });
  const a = await assessor.run(p.id, { kind: 'codebase' });
  const raw = new DatabaseSync(appPaths(home).db);
  try {
    assert.throws(() => raw.prepare("UPDATE assessments SET status = 'scoped' WHERE id = ?").run(a.id), /cannot change/);
    assert.throws(() => raw.prepare('DELETE FROM assessments WHERE id = ?').run(a.id), /never deleted/);
  } finally {
    raw.close();
  }

  // A repository that disappears gives a recorded failure, not a silent one.
  renameSync(repo, `${repo}-moved`);
  await assert.rejects(assessor.run(p.id, { kind: 'full' }), /does not exist/);
  const failed = ws.listAssessments(p.id)[0]!;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /does not exist/);
});

test('M8: Python, Go and vendored files are read from manifests, and limits are disclosed', async (t) => {
  const { home, cleanup } = tempHome();
  const ws = Workspace.open(home);
  t.after(() => {
    ws.close();
    cleanup();
  });
  const repo = join(home, 'py');
  write(repo, {
    'pyproject.toml': '[project]\nname = "svc"\nclassifiers = ["Framework :: Django"]\ndependencies = [\n  "fastapi>=0.1",\n  "SQLAlchemy==2.0",\n]\n[project.optional-dependencies]\ndev = ["pytest"]\n',
    'requirements-dev.txt': '# tools\nruff==0.5\n',
    'tools/go.mod': 'module example.com/t\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.0\n)\n',
    'app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/health")\ndef health():\n    return {}\n',
    'tests/test_main.py': 'def test_health():\n    pass\n',
    'node_modules/left-pad/index.js': 'webhook webhook\n',
    'logo.png': '\x00PNG',
  });
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'init');
  const assessor = new Assessor(ws);
  const p = await assessor.importProject({ name: 'Py', path: repo });
  const r = (await assessor.run(p.id, { kind: 'full' })).report!;
  const deps = r.codebase!.dependencies;
  const py = deps.find((d) => d.ecosystem === 'python')!;
  assert.deepEqual({ runtime: py.runtime, dev: py.dev }, { runtime: 3, dev: 1 }, 'fastapi, sqlalchemy, pytest; ruff is dev; classifiers are not dependencies');
  assert.ok(deps.some((d) => d.ecosystem === 'go' && d.runtime === 1));
  assert.ok(r.codebase!.stack.some((s) => s.name === 'FastAPI'));
  assert.equal(r.codebase!.tests.files, 1);
  assert.equal(r.capabilities.find((f) => f.id === 'api')!.status, 'implemented_in_code');
  assert.notEqual(r.capabilities.find((f) => f.id === 'webhooks')!.status, 'implemented_in_code', 'vendored code is not evidence');
  assert.match(r.notInspected.join('\n'), /vendored or generated folders, for example node_modules\/left-pad\/index\.js/);
  assert.match(r.notInspected.join('\n'), /binary, minified or media files/);
});

test('M8: parseTree reads ls-tree output, including names with spaces and submodules', () => {
  const out = ['100644 blob ' + 'a'.repeat(40) + '     12\tsrc/a file.ts', '160000 commit ' + 'b'.repeat(40) + '       -\tvendor/lib', '120000 blob ' + 'c'.repeat(40) + '      5\tlink'].join('\0');
  assert.deepEqual(
    parseTree(out).map((e) => [e.type, e.path, e.size, e.mode]),
    [
      ['blob', 'src/a file.ts', 12, '100644'],
      ['commit', 'vendor/lib', 0, '160000'],
      ['blob', 'link', 5, '120000'],
    ],
  );
});

test('M8: the IPC handlers and the CLI import and assess', async (t) => {
  const { home, cleanup } = tempHome();
  const s = new AppService(home, '0.0.0-test');
  t.after(() => {
    s.close();
    cleanup();
  });
  const repo = join(home, 'shop');
  nodeRepo(repo);
  const h = s.handlers;
  assert.equal((await h.importProject({ name: 'Shop', path: 42 })).ok, false);
  const imported = await h.importProject({ name: 'Shop', path: repo });
  assert.ok(imported.ok, JSON.stringify(imported));
  const catalog = h.assessmentCatalog();
  assert.ok(catalog.ok && catalog.value.capabilities.length === CAPABILITIES.length && catalog.value.categories.length === 4);
  const bad = await h.runAssessment({ projectId: imported.value.id, scope: { kind: 'capability', target: 'everything' } });
  assert.ok(!bad.ok && bad.error.code === 'VALIDATION');
  const ran = await h.runAssessment({ projectId: imported.value.id, scope: { kind: 'category', target: 'product' } });
  assert.ok(ran.ok && ran.value.status === 'completed');
  const listed = h.listAssessments(imported.value.id);
  assert.ok(listed.ok && listed.value.length === 1);
  s.close();

  const cli = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { env: { ...process.env, IAP_HOME: home }, encoding: 'utf8' });
  const other = join(home, 'other');
  nodeRepo(other);
  const imp = cli('project', 'import', '--name', 'Other', '--path', other, '--json');
  assert.equal(imp.status, 0, imp.stderr);
  const id = JSON.parse(imp.stdout).id as string;
  const run = cli('assess', 'run', id, '--scope', 'capability:secrets');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Partly present\s+Secrets/);
  assert.match(run.stdout, /Repository unchanged: yes/);
  assert.ok(!run.stdout.includes(FAKE_KEY));
  assert.notEqual(cli('assess', 'run', id, '--scope', 'galaxy').status, 0);
  assert.match(cli('assess', 'capabilities').stdout, /data_residency\s+Data Residency/);
});
