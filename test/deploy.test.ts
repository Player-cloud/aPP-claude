// M20 controlled deployment (FR-SHIP-002, FR-SEC-003, DEC-038) against a real
// git repository and real commands; the health address is a fake fetcher, so
// nothing goes to the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempHome } from './helpers.ts';
import { Workspace } from '../src/core/workspace.ts';
import { Releaser } from '../src/core/release/releaser.ts';
import { approvalLines, Deployer, type Fetcher } from '../src/core/release/deploy.ts';
import { evaluateGates, type GateInput } from '../src/core/release/gates.ts';
import { addDetachedWorktree } from '../src/core/build/git.ts';
import { AppService } from '../src/main/service.ts';

function gitIn(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
}

// No double quotes inside the script: cmd.exe on Windows does not unescape \", so paths
// are passed as single-quoted JavaScript strings with forward slashes, which Node accepts there.
const node = (js: string) => {
  if (js.includes('"')) throw new Error('Keep double quotes out of a node -e script.');
  return `node -e "${js}"`;
};
const lit = (path: string) => `'${path.replace(/\\/g, '/')}'`;

/** A prepared release of a small repository, with a deploy that writes a file the health check reads. */
async function prepared(ws: Workspace, home: string, plan: Record<string, unknown> = {}, version = '1.2.0') {
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'site', version: '1.2.0' }));
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'init');
  const commit = gitIn(repo, 'rev-parse', 'HEAD').trim();
  const project = ws.createProject({ name: 'Site', idea: 'A site' });
  ws.setProjectRepo(project.id, repo);
  const out = join(home, 'deployed.txt');
  const r = new Releaser(ws).create(project.id, {
    version,
    checks: [{ id: 'ok', command: node('process.exit(0)') }],
    buildIds: [],
    plan: {
      target: 'A folder',
      healthCheck: 'The file says the version',
      rollback: 'Delete the file',
      environment: 'production',
      deployCommand: node(`require('fs').writeFileSync(${lit(out)}, process.env.IAP_RELEASE_VERSION + ' ' + (process.env.SITE_TOKEN || 'none'))`),
      healthCommand: node(`process.exit(require('fs').readFileSync(${lit(out)}, 'utf8').startsWith('${version}') ? 0 : 1)`),
      rollbackCommand: node(`require('fs').rmSync(${lit(out)})`),
      envVars: ['SITE_TOKEN'],
      ...plan,
    },
  });
  const worktree = join(home, 'wt', r.id);
  mkdirSync(join(home, 'wt'), { recursive: true });
  await addDetachedWorktree(repo, worktree, commit);
  // The ship-check and its gates are tested in release.test.ts; here the release is marked prepared directly.
  ws.updateRelease(r.id, { status: 'prepared', commit, worktree, preparedAt: ws.nowIso() });
  return { release: ws.getRelease(r.id), out, repo, commit };
}

function setup(t: { after: (fn: () => void) => void }) {
  const { home, cleanup } = tempHome();
  const ws = Workspace.open(home);
  t.after(() => {
    ws.close();
    cleanup();
  });
  return { ws, home };
}

test('M20-AC1: a plan the app deploys needs an environment, a health check and a rollback command', () => {
  const PLAN = { target: 't', healthCheck: 'h', rollback: 'r', monitoring: '', migrations: '', envVars: [] };
  const input = (plan: Partial<GateInput['plan']>): GateInput => ({ spec: null, specOutdated: false, builds: [], checks: { defined: 1, results: [] }, secrets: [], reviewTools: [], plan: { ...PLAN, ...plan }, classifications: {}, exceptions: [] });
  const gate = (plan: Partial<GateInput['plan']>) => evaluateGates(input(plan)).find((g) => g.id === 'plan')!;
  assert.match(gate({}).summary, /it does not test it/);
  const bare = gate({ deployCommand: 'npm run deploy' });
  assert.equal(bare.status, 'failed');
  assert.match(bare.summary, /the environment it deploys to, a rollback command, a health check command or address/);
  const full = gate({ deployCommand: 'npm run deploy', environment: 'production', healthUrl: 'https://x.test/health', rollbackCommand: 'npm run undo' });
  assert.equal(full.status, 'passed');
  assert.match(full.summary, /can deploy it to production once prepared and you approve/);
  assert.ok(full.evidence.includes('Rollback command: npm run undo'));
});

test('M20-AC2: the plan rejects a health address that is not http(s) and an environment name with odd characters', (t) => {
  const { ws } = setup(t);
  const project = ws.createProject({ name: 'P', idea: 'i' });
  const make = (plan: Record<string, unknown>) => new Releaser(ws).create(project.id, { version: '1.0.0', checks: [{ id: 'ok', command: 'true' }], buildIds: [], plan });
  assert.throws(() => make({ healthUrl: 'file:///etc/passwd' }), /must start with http/);
  assert.throws(() => make({ environment: 'prod; rm -rf /' }), /Name the environment/);
  assert.equal(make({ environment: 'staging', healthUrl: 'https://x.test/ok' }).plan.environment, 'staging');
});

test('M20-AC3: deploying needs a prepared release with a deploy command and the environment typed exactly', async (t) => {
  const { ws, home } = setup(t);
  const { release, out } = await prepared(ws, home);
  const d = new Deployer(ws, { healthDelayMs: 0, env: { SITE_TOKEN: 'tok-123', HOME: '/x' } });
  const req = d.request(release.id);
  assert.deepEqual([req.environment, req.version, req.envVars], ['production', '1.2.0', ['SITE_TOKEN']]);
  assert.match(approvalLines(req).join('\n'), /Environment: production\nVersion: 1\.2\.0 \(commit [0-9a-f]{12}\)/);
  await assert.rejects(d.deploy(release.id, 'prod'), /Type the environment's name exactly \("production"\)/);
  assert.equal(existsSync(out), false, 'nothing ran');
  assert.equal(ws.listDeployments(release.id).length, 0);

  const done = await d.deploy(release.id, 'production');
  assert.equal(done.deployment.status, 'healthy');
  assert.deepEqual(done.steps.map((s) => [s.kind, s.status]), [['verify', 'passed'], ['deploy', 'passed'], ['health', 'passed']]);
  assert.match(done.steps[0]!.output, /package\.json version 1\.2\.0 matches the release/);
  assert.equal(readFileSync(out, 'utf8'), '1.2.0 tok-123', 'the version and the configuration the plan names reach the command');
  assert.deepEqual(done.next, ['check_health', 'rollback']);
  const types = ws.listEvents({ limit: 100 }).map((e) => e.type);
  for (const type of ['deploy.approved', 'deploy.step', 'deploy.status']) assert.ok(types.includes(type), type);

  // Monitoring: the health check runs again; when the site goes away it becomes unhealthy, and the rollback runs.
  writeFileSync(out, 'broken');
  const later = await d.checkHealth(done.deployment.id);
  assert.equal(later.deployment.status, 'unhealthy');
  const back = await d.rollback(done.deployment.id);
  assert.equal(back.deployment.status, 'rolled_back');
  assert.equal(existsSync(out), false);
  await assert.rejects(d.rollback(done.deployment.id), /rolled back; it cannot be rolled back/);
  await assert.rejects(d.checkHealth(done.deployment.id), /nothing to check/);
});

test('M20-AC4: a version mismatch stops before the deploy command, and a failed health address leaves it unhealthy', async (t) => {
  const { ws, home } = setup(t);
  const { release, out } = await prepared(ws, home, {}, '2.0.0');
  const d = new Deployer(ws, { healthDelayMs: 0 });
  const r = await d.deploy(release.id, 'production');
  assert.equal(r.deployment.status, 'failed');
  assert.deepEqual(r.steps.map((s) => [s.kind, s.status]), [['verify', 'failed']]);
  assert.match(r.steps[0]!.output, /package\.json says version 1\.2\.0, but the release is 2\.0\.0/);
  assert.equal(existsSync(out), false, 'the deploy command never ran');

  const { home: home2, cleanup } = tempHome();
  t.after(cleanup);
  const ws2 = Workspace.open(home2);
  t.after(() => ws2.close());
  const seen: string[] = [];
  const fetcher: Fetcher = async (url) => {
    seen.push(url);
    return { status: seen.length < 3 ? 503 : 500 };
  };
  const p2 = await prepared(ws2, home2, { healthCommand: '', healthUrl: 'https://site.test/health' });
  const res = await new Deployer(ws2, { fetcher, healthTries: 3, healthDelayMs: 0 }).deploy(p2.release.id, 'production');
  assert.equal(res.deployment.status, 'unhealthy');
  assert.deepEqual(res.steps.filter((s) => s.kind === 'health').map((s) => [s.target, s.exitCode, s.output]), [
    ['https://site.test/health', 503, 'HTTP 503'],
    ['https://site.test/health', 503, 'HTTP 503'],
    ['https://site.test/health', 500, 'HTTP 500'],
  ]);
});

test('M20-AC5: releases without a deploy command, or not prepared, cannot be deployed; steps are append-only', async (t) => {
  const { ws, home } = setup(t);
  const { release } = await prepared(ws, home, { deployCommand: '' });
  const d = new Deployer(ws);
  assert.throws(() => d.request(release.id), /has no deploy command/);
  const project = ws.createProject({ name: 'Draft', idea: 'i' });
  const draft = new Releaser(ws).create(project.id, { version: '1.0.0', checks: [{ id: 'ok', command: 'true' }], buildIds: [], plan: { environment: 'production', deployCommand: 'x', rollbackCommand: 'y', healthCommand: 'z' } });
  assert.throws(() => d.request(draft.id), /Prepare the release first/);

  const { home: home2, cleanup } = tempHome();
  t.after(cleanup);
  const ws2 = Workspace.open(home2);
  const p = await prepared(ws2, home2);
  const dep = await new Deployer(ws2, { healthDelayMs: 0 }).deploy(p.release.id, 'production');
  ws2.close();
  const db = new DatabaseSync(join(home2, 'iap.db'));
  t.after(() => db.close());
  assert.throws(() => db.prepare('UPDATE deployment_steps SET status = ?').run('passed'), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM deployment_steps').run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM deployments WHERE id = ?').run(dep.deployment.id), /never deleted/);
});

test('M20-AC6: the desktop app asks in a native dialog before deploying and before rolling back', async (t) => {
  const { home, cleanup } = tempHome();
  let approve = false;
  const asked: { title: string; lines: string[] }[] = [];
  const s = new AppService(home, '0.0.0-test', {
    confirmAction: async ({ title, lines }) => {
      asked.push({ title, lines });
      return approve;
    },
    healthFetcher: async () => ({ status: 200 }),
  });
  t.after(() => {
    s.close();
    cleanup();
  });
  // The release is made through the app's own workspace.
  const internal = (s as unknown as { workspace(): Workspace }).workspace();
  const { release, out } = await prepared(internal, home, { healthCommand: '', healthUrl: 'https://site.test/ok' });
  const h = s.handlers;
  const wrong = await h.deployRelease({ releaseId: release.id, environment: 'staging' });
  assert.ok(!wrong.ok && /exactly \("production"\)/.test(wrong.error.message));
  assert.equal(asked.length, 0, 'a wrong name never reaches the dialog');
  const refused = await h.deployRelease({ releaseId: release.id, environment: 'production' });
  assert.ok(!refused.ok && /not approved, so nothing ran/.test(refused.error.message));
  assert.equal(asked[0]!.title, 'Deploy 1.2.0 to production?');
  assert.ok(asked[0]!.lines.some((l) => l.startsWith('Deploy: node -e')));
  assert.equal(existsSync(out), false);
  approve = true;
  const done = await h.deployRelease({ releaseId: release.id, environment: 'production' });
  assert.ok(done.ok && done.value.deployment.status === 'healthy', JSON.stringify(done));
  const listed = h.listDeployments(release.id);
  assert.ok(listed.ok && listed.value.length === 1);
  approve = false;
  const noRollback = await h.rollbackDeployment(done.value.deployment.id);
  assert.ok(!noRollback.ok && /rollback was not approved/.test(noRollback.error.message));
  approve = true;
  const rolled = await h.rollbackDeployment(done.value.deployment.id);
  assert.ok(rolled.ok && rolled.value.deployment.status === 'rolled_back');
});
