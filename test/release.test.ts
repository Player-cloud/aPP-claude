// M7 quality gate and ship-check against real git repositories and real check
// commands. No test calls a model, deploys, tags or pushes anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempHome } from './helpers.ts';
import { Workspace } from '../src/core/workspace.ts';
import { appPaths } from '../src/core/paths.ts';
import { SimulatedModel } from '../src/core/agents/model.ts';
import { Planner } from '../src/core/planner.ts';
import { Builder } from '../src/core/build/builder.ts';
import { Releaser } from '../src/core/release/releaser.ts';
import { blockingGates, evaluateGates, type GateInput, type IncludedBuild, type ReleasePlan } from '../src/core/release/gates.ts';

const BUGGY = 'export const sum = (a, b) => a - b;\n';
const FIXED = 'export const sum = (a, b) => a + b;\n';
const TEST = "import assert from 'node:assert/strict';\nimport { sum } from '../src/sum.mjs';\nassert.equal(sum(2, 3), 5);\nconsole.log('sum ok');\n";
const UNIT = { id: 'unit', command: 'node test/sum.test.mjs' };
const PLAN: ReleasePlan = {
  target: 'Windows installer attached to a GitHub release',
  healthCheck: 'Install on a clean machine and open a project',
  rollback: 'Re-publish the previous installer and mark this release as withdrawn',
  monitoring: 'Watch the issue tracker for a week',
  migrations: 'none',
  envVars: ['ANTHROPIC_API_KEY'],
};
// Built at run time so this file holds no credential-shaped text.
const FAKE_KEY = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');

function gitIn(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
}

function setup(t: { after: (fn: () => void) => void }) {
  const { home, cleanup } = tempHome();
  const ws = Workspace.open(home);
  t.after(() => {
    ws.close();
    cleanup();
  });
  const project = ws.createProject({ name: 'Sum', idea: 'Add numbers' });
  const repo = join(home, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'src', 'sum.mjs'), BUGGY);
  writeFileSync(join(repo, 'test', 'sum.test.mjs'), TEST);
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'init');
  ws.setProjectRepo(project.id, repo);
  const builder = new Builder(ws, new SimulatedModel(), { checkTimeoutMs: 30_000 });
  return { ws, home, project, repo, builder, releaser: new Releaser(ws, { checkTimeoutMs: 30_000 }) };
}

/** Approves a brief and a spec with REQ-001 (MUST) and REQ-002 (SHOULD). */
async function approveSpec(ws: Workspace, projectId: string) {
  const planner = new Planner(ws, new SimulatedModel());
  const brief = await planner.draftBrief(projectId);
  planner.saveDraft(brief.id, {
    content: { goals: ['Add numbers'], users: ['Me'], useCases: [], scope: ['sum'], nonGoals: [], confirmed: [], assumptions: [], dependencies: [], risks: [], successCriteria: ['sum works'] },
  });
  planner.approve(brief.id);
  const spec = await planner.draftSpec(projectId);
  assert.ok(spec.kind === 'spec');
  const [a, b] = spec.content.requirements;
  planner.saveDraft(spec.id, {
    content: {
      requirements: [
        { ...a!, title: 'Sum two numbers', priority: 'MUST', acceptanceCriteria: ['2 + 3 is 5'] },
        { ...b!, title: 'Show a history', priority: 'SHOULD', acceptanceCriteria: ['The last 10 sums are listed'] },
      ],
    },
  });
  planner.approve(spec.id);
}

/** A feature for REQ-001 that fixes sum, done by hand in its worktree, verified and completed. */
async function fixSum(builder: Builder, projectId: string) {
  const b = builder.create(projectId, { kind: 'feature', title: 'Make sum add', goal: 'sum(2, 3) should be 5', requirementIds: ['REQ-001'], checks: [UNIT] });
  const started = await builder.start(b.id);
  writeFileSync(join(started.build.worktree!, 'src', 'sum.mjs'), FIXED);
  await builder.verify(b.id);
  // No test file changed, so the review flags it; the person explains.
  return (await builder.complete(b.id, 'The existing unit test covers this change.')).build;
}

const gate = (gates: { id: string; status: string }[] | null, id: string) => gates?.find((g) => g.id === id)?.status;

test('M7-AC1: a release with finished, merged, verified work and a plan passes every required gate and is prepared without deploying', async (t) => {
  const { ws, project, repo, builder, releaser } = setup(t);
  await approveSpec(ws, project.id);
  const build = await fixSum(builder, project.id);
  assert.match(build.resultCommit ?? '', /^[0-9a-f]{40}$/);

  const r = releaser.create(project.id, { version: '1.0.0', plan: PLAN, checks: [UNIT], buildIds: [build.id] });
  assert.equal(r.status, 'draft');

  // Not merged yet: the release commit still has the bug, so the checks fail and the build is not in it.
  let d = await releaser.check(r.id);
  assert.equal(gate(d.release.gates, 'builds'), 'failed');
  assert.equal(gate(d.release.gates, 'tests'), 'failed');
  assert.deepEqual(d.blocking.sort(), ['builds', 'tests']);
  await assert.rejects(releaser.prepare(r.id), /block the release/);

  gitIn(repo, 'merge', '-q', '--no-edit', build.branch!);
  d = await releaser.check(r.id);
  for (const id of ['spec', 'drift', 'builds', 'risks', 'tests', 'secrets', 'plan']) assert.equal(gate(d.release.gates, id), 'passed', id);
  assert.equal(gate(d.release.gates, 'reviews'), 'skipped');
  // The SHOULD requirement nobody built is recorded but does not block.
  const drift = d.release.gates!.find((g) => g.id === 'drift')!;
  assert.deepEqual(drift.findings?.map((f) => [f.requirementId, f.kind]), [['REQ-002', 'optional_improvement']]);
  assert.equal(d.release.ready, true);
  assert.equal(d.release.commit, gitIn(repo, 'rev-parse', 'HEAD').trim());
  assert.deepEqual(d.checkRuns.map((c) => c.status), ['failed', 'passed']);

  const prepared = await releaser.prepare(r.id);
  assert.equal(prepared.release.status, 'prepared');
  const report = readFileSync(prepared.release.reportPath!, 'utf8');
  assert.match(report, /Nothing was deployed/);
  assert.match(report, /\| Release checks on the release commit \| yes \| passed \|/);
  const ev = ws.listEvents({ projectId: project.id }).find((e) => e.type === 'release.prepared');
  assert.equal((ev?.payload as { deployed: boolean }).deployed, false);
  // Preparation never tags, pushes or changes the person's checkout.
  assert.equal(gitIn(repo, 'tag').trim(), '');
  assert.equal(gitIn(repo, 'status', '--porcelain').trim(), '');
  assert.throws(() => releaser.edit(r.id, { plan: PLAN }), /prepared/);
});

test('M7-AC2: deliberate defects each fail their gate: failing tests, missing plan, a credential, no spec', async (t) => {
  const { ws, project, repo, releaser } = setup(t);
  writeFileSync(join(repo, 'config.js'), `export const token = '${FAKE_KEY}';\n`);
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'oops');

  const r = releaser.create(project.id, { version: '0.1.0', plan: { target: 'Somewhere' }, checks: [UNIT], buildIds: [] });
  const d = await releaser.check(r.id);
  const g = Object.fromEntries(d.release.gates!.map((x) => [x.id, x]));
  assert.equal(g.spec!.status, 'failed');
  assert.equal(g.drift!.status, 'blocked');
  assert.equal(g.builds!.status, 'failed');
  assert.equal(g.tests!.status, 'failed');
  assert.match(g.tests!.evidence[0]!, /unit: failed \(exit 1\)/);
  assert.equal(g.plan!.status, 'failed');
  assert.match(g.plan!.summary, /health check, rollback/);
  assert.equal(g.secrets!.status, 'failed');
  assert.deepEqual(g.secrets!.evidence, ['config.js:1']);
  assert.equal(d.release.ready, false);
  await assert.rejects(releaser.prepare(r.id), /block the release/);

  // The credential is reported by place only: it is not in the report or the database.
  assert.ok(!readFileSync(d.release.reportPath!, 'utf8').includes(FAKE_KEY));
  const db = appPaths(join(repo, '..')).db;
  for (const file of [db, `${db}-wal`]) {
    try {
      assert.ok(!readFileSync(file).includes(Buffer.from(FAKE_KEY)), file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
});

test('M7-AC3: an exception needs a reason and a mitigation, is kept for good, and unblocks only its gate', async (t) => {
  const { ws, project, releaser, home } = setup(t);
  await approveSpec(ws, project.id);
  const r = releaser.create(project.id, { version: '0.2.0', plan: PLAN, checks: [{ id: 'ok', command: 'node -e "process.exit(0)"' }], buildIds: [] });
  let d = await releaser.check(r.id);
  // Nothing built: REQ-001 is a missing MUST requirement and there is no included work.
  assert.deepEqual(d.blocking.sort(), ['builds', 'drift']);

  assert.throws(() => releaser.addException(r.id, 'builds', 'short', 'also short'), /at least 10 characters/);
  assert.throws(() => releaser.addException(r.id, 'tests', 'These tests are fine really', 'Will watch closely afterwards'), /Only a failed or blocked gate/);
  d = releaser.addException(r.id, 'builds', 'This is a docs-only release candidate', 'Rebuild the installer and smoke test it by hand');
  assert.deepEqual(d.blocking, ['drift']);
  assert.equal(d.release.gates!.find((g) => g.id === 'builds')!.exception?.mitigation, 'Rebuild the installer and smoke test it by hand');

  // FR-QA-001: only the person can say a finding is deliberate.
  assert.throws(() => releaser.classify(r.id, 'REQ-001', 'defect', 'It is fine for now'), /intentional_deviation/);
  assert.throws(() => releaser.classify(r.id, 'REQ-404', 'spec_change', 'It is fine for now'), /no drift finding/);
  d = releaser.classify(r.id, 'REQ-001', 'spec_change', 'Moving sum to the next release');
  assert.deepEqual(d.blocking, []);
  assert.equal(d.release.ready, true);
  const prepared = await releaser.prepare(r.id);
  assert.match(readFileSync(prepared.release.reportPath!, 'utf8'), /Reason: This is a docs-only release candidate Mitigation: Rebuild/);

  const raw = new DatabaseSync(appPaths(home).db);
  assert.throws(() => raw.exec("UPDATE release_exceptions SET reason = 'x'"), /append-only/);
  assert.throws(() => raw.exec('DELETE FROM release_exceptions'), /append-only/);
  assert.throws(() => raw.exec('DELETE FROM release_check_runs'), /append-only/);
  raw.close();
});

test('M7-AC4: the release is prepared only on the commit that was checked, and checks cannot change the person\'s repository', async (t) => {
  const { ws, project, repo, releaser } = setup(t);
  await approveSpec(ws, project.id);
  writeFileSync(join(repo, 'src', 'sum.mjs'), FIXED);
  gitIn(repo, 'commit', '-q', '-am', 'fix');
  // A check that rewrites a tracked file and adds a credential-shaped file. Neither may reach the scan or the repository.
  const sneaky = { id: 'sneaky', command: `node -e "require('fs').writeFileSync('src/sum.mjs','x');require('fs').writeFileSync('k.txt','${FAKE_KEY}')"` };
  const r = releaser.create(project.id, { version: '0.3.0', plan: PLAN, checks: [UNIT, sneaky], buildIds: [] });
  const d = await releaser.check(r.id);
  assert.equal(gate(d.release.gates, 'secrets'), 'passed');
  assert.equal(readFileSync(join(repo, 'src', 'sum.mjs'), 'utf8'), FIXED);
  // Git for Windows may check files out with CRLF (core.autocrlf), so compare the content, not the line endings.
  assert.equal(readFileSync(join(d.release.worktree!, 'src', 'sum.mjs'), 'utf8').replace(/\r\n/g, '\n'), FIXED);

  releaser.addException(r.id, 'builds', 'Hotfix made directly on main', 'Covered by the unit check on this commit');
  assert.deepEqual(releaser.classify(r.id, 'REQ-001', 'intentional_deviation', 'Fixed on main, not through a build').blocking, []);
  writeFileSync(join(repo, 'README.md'), 'later\n');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'later');
  await assert.rejects(releaser.prepare(r.id), /moved on since the ship-check/);
  // On the new commit, the earlier exception no longer applies.
  const again = await releaser.check(r.id);
  assert.ok(again.blocking.includes('builds'));
  assert.equal(again.exceptions.length, 1);
  // Editing the plan sends it back to draft: old gates no longer apply.
  const edited = releaser.edit(r.id, { plan: { ...PLAN, monitoring: 'Daily' } });
  assert.equal(edited.status, 'draft');
  assert.equal(edited.gates, null);
  await assert.rejects(releaser.prepare(r.id), /Run the ship-check/);
});

test('M7: release input is validated', (t) => {
  const { project, releaser, builder } = setup(t);
  assert.throws(() => releaser.create(project.id, { version: 'soon', plan: PLAN, checks: [UNIT], buildIds: [] }), /version like/);
  assert.throws(() => releaser.create(project.id, { version: '1.0.0', plan: PLAN, checks: [], buildIds: [] }), /at least one release check/);
  assert.throws(() => releaser.create(project.id, { version: '1.0.0', plan: { ...PLAN, envVars: ['KEY=value'] }, checks: [UNIT], buildIds: [] }), /names only/);
  assert.throws(() => releaser.create(project.id, { version: '1.0.0', plan: PLAN, checks: [UNIT], buildIds: ['bld_nope'] }), /Unknown build/);
  const b = builder.create(project.id, { kind: 'bugfix', title: 'X', goal: 'Something is wrong', repro: 'Run the unit test', checks: [UNIT] });
  builder.abandon(b.id, null);
  assert.throws(() => releaser.create(project.id, { version: '1.0.0', plan: PLAN, checks: [UNIT], buildIds: [b.id] }), /abandoned/);
});

test('M7: gate rules over recorded evidence', () => {
  const build = (over: Partial<IncludedBuild> = {}): IncludedBuild => ({
    id: 'bld_1',
    title: 'Thing',
    kind: 'feature',
    status: 'completed',
    requirementIds: ['REQ-001'],
    verify: [{ checkId: 'unit', command: 'npm test', status: 'passed', exitCode: 0, durationMs: 1, output: '', startedAt: '' }],
    risks: [],
    note: null,
    merged: true,
    branch: 'iap/feature-1',
    ...over,
  });
  const input = (over: Partial<GateInput> = {}): GateInput => ({
    spec: { requirements: [{ id: 'REQ-001', title: 'Thing', description: '', priority: 'MUST', acceptanceCriteria: ['x'] }] },
    specOutdated: false,
    builds: [build()],
    checks: { defined: 1, results: [build().verify[0]!] },
    secrets: [],
    reviewTools: [],
    plan: PLAN,
    classifications: {},
    exceptions: [],
    ...over,
  });
  const st = (i: GateInput, id: string) => evaluateGates(i).find((g) => g.id === id)!;
  assert.deepEqual(blockingGates(evaluateGates(input())), []);
  assert.equal(st(input({ builds: [build({ status: 'in_progress' })] }), 'builds').status, 'blocked');
  assert.equal(st(input({ builds: [build({ merged: false })] }), 'builds').status, 'failed');
  const r = st(input({ builds: [build({ risks: [{ kind: 'weakened_test', detail: 'test.skip added' }] })] }), 'risks');
  assert.deepEqual([r.status, r.severity], ['failed', 'critical']);
  assert.equal(st(input({ builds: [build({ risks: [{ kind: 'no_test', detail: 'no test changed' }], note: 'Covered by e2e' })] }), 'risks').status, 'passed');
  const defect = st(input({ builds: [build({ verify: [{ ...build().verify[0]!, status: 'failed' }] })] }), 'drift');
  assert.deepEqual(defect.findings?.map((f) => f.kind), ['defect']);
  assert.equal(st(input({ checks: { defined: 0, results: [] } }), 'tests').status, 'failed');
  assert.equal(st(input({ checks: { defined: 1, results: [] } }), 'tests').status, 'blocked');
  assert.equal(st(input({ secrets: null }), 'secrets').status, 'blocked');
  const empty = { ...build().verify[0]!, output: 'ℹ tests 0\nℹ pass 0' };
  assert.match(st(input({ checks: { defined: 1, results: [empty] } }), 'tests').summary, /passed but found no tests/);
  assert.equal(st(input({ specOutdated: true }), 'spec').status, 'failed');
  assert.match(st(input({ reviewTools: ['/security-review'] }), 'reviews').summary, /has not verified them/);
  // An exception for a gate that passed is ignored; only failed or blocked gates carry one.
  const ex = { gateId: 'tests', commit: 'abc', reason: 'r'.repeat(10), mitigation: 'm'.repeat(10), actor: 'me', at: '' };
  assert.equal(st(input({ exceptions: [ex] }), 'tests').exception, undefined);
  assert.ok(st(input({ checks: { defined: 0, results: [] }, exceptions: [ex] }), 'tests').exception);
});
