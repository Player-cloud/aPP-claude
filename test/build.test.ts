// M6 build workflows against real git repositories and real check commands.
// The agent is scripted (SimulatedModel), so no test calls a model or spends money.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempHome } from './helpers.ts';
import { Workspace } from '../src/core/workspace.ts';
import { appPaths } from '../src/core/paths.ts';
import { ValidationError } from '../src/core/errors.ts';
import { SimulatedModel, type LoopTurn, type SimulatedStep } from '../src/core/agents/model.ts';
import { Builder } from '../src/core/build/builder.ts';
import { runBuildAgent } from '../src/core/build/agent.ts';
import { checkEnv, normalizeChecks, ranNoTests, runCheck } from '../src/core/build/checks.ts';
import { confine, ToolInputError, writeFile } from '../src/core/build/files.ts';
import { parseChanges } from '../src/core/build/git.ts';
import { reviewChange } from '../src/core/build/review.ts';

const BUGGY = 'export const sum = (a, b) => a - b;\n';
const FIXED = 'export const sum = (a, b) => a + b;\n';
const TEST = "import assert from 'node:assert/strict';\nimport { sum } from '../src/sum.mjs';\nassert.equal(sum(2, 3), 5);\nconsole.log('sum ok');\n";
const UNIT = { id: 'unit', command: 'node test/sum.test.mjs' };

function gitIn(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
}

/** A repository with a bug in src/sum.mjs. With `withTest`, a test that shows the bug is committed too. */
function buggyRepo(dir: string, withTest = true) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'src', 'sum.mjs'), BUGGY);
  writeFileSync(join(dir, 'README.md'), '# Sum\n');
  if (withTest) writeFileSync(join(dir, 'test', 'sum.test.mjs'), TEST);
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function setup(t: { after: (fn: () => void) => void }, model = new SimulatedModel()) {
  const { home, cleanup } = tempHome();
  const ws = Workspace.open(home);
  t.after(() => {
    ws.close();
    cleanup();
  });
  const project = ws.createProject({ name: 'Sum', idea: 'Add numbers' });
  const repo = buggyRepo(join(home, 'repo'));
  return { ws, home, project, repo, builder: new Builder(ws, model, { checkTimeoutMs: 30_000 }) };
}

/** A scripted agent: one step per turn, by the number of assistant turns so far. */
function scripted(steps: SimulatedStep[], billable = false) {
  return new SimulatedModel(
    (r) => {
      if (r.purpose !== 'build') return { text: '{}' };
      const done = (r.loop?.turns ?? []).filter((x: LoopTurn) => x.kind === 'assistant').length;
      return steps[Math.min(done, steps.length - 1)]!;
    },
    { billable },
  );
}

test('M6: file tools stay inside the worktree', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const root = join(home, 'wt');
  mkdirSync(join(root, '.git'), { recursive: true });
  for (const bad of ['../x', '/etc/passwd', 'C:\\Windows\\x', 'a/../../x', '.git/config', 'src/../.git/HEAD', '', 5]) {
    assert.throws(() => confine(root, bad), ToolInputError, String(bad));
  }
  // Temp folders can be links or short names (macOS /var, Windows RUNNER~1), so compare with the real path.
  assert.equal(confine(root, 'new/deep/file.ts'), join(realpathSync(root), 'new', 'deep', 'file.ts'));
  assert.match(writeFile(root, 'new/deep/file.ts', 'x'), /Created new\/deep\/file.ts/);
  try {
    symlinkSync(home, join(root, 'out'), 'dir');
  } catch {
    return t.skip('cannot create symlinks here');
  }
  assert.throws(() => writeFile(root, 'out/escape.txt', 'x'), /outside the repository through a link/);
  assert.equal(existsSync(join(home, 'escape.txt')), false);
});

test('M6: checks report real results, time out, and never see secrets', async (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const ok = await runCheck(home, { id: 'ok', command: 'node -e "console.log(123)"' });
  assert.equal(ok.status, 'passed');
  assert.match(ok.output, /123/);
  const bad = await runCheck(home, { id: 'bad', command: 'node -e "process.exit(3)"' });
  assert.deepEqual([bad.status, bad.exitCode], ['failed', 3]);
  const slow = await runCheck(home, { id: 'slow', command: 'node -e "setTimeout(() => {}, 20000)"' }, { timeoutMs: 500 });
  assert.equal(slow.status, 'timed_out');
  assert.ok(slow.durationMs < 15_000);
  const env = checkEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-x', GITHUB_TOKEN: 't', MY_SECRET: 's', HOME: '/h' });
  assert.deepEqual(Object.keys(env).sort(), ['CI', 'HOME', 'PATH']);
  const leak = await runCheck(home, { id: 'leak', command: 'node -e "console.log(\'key=\' + (process.env.ANTHROPIC_API_KEY || \'none\'))"' });
  assert.match(leak.output, /key=none/);
  assert.throws(() => normalizeChecks([{ id: 'a', command: 'x\ny' }]), ValidationError);
  assert.throws(() => normalizeChecks([{ id: 'a', command: 'x' }, { id: 'a', command: 'y' }]), ValidationError);
});

test('M6: the review flags regressions, weakened or deleted tests, unrelated files and missing tests', () => {
  const pass = (checkId: string) => ({ checkId, command: 'x', status: 'passed' as const, exitCode: 0, durationMs: 1, output: '', startedAt: '' });
  const fail = (checkId: string) => ({ ...pass(checkId), status: 'failed' as const, exitCode: 1 });
  const risks = reviewChange({
    kind: 'feature',
    files: [
      { path: 'src/app.ts', status: 'modified', added: 1, removed: 0 },
      { path: 'test/app.test.ts', status: 'modified', added: 1, removed: 0 },
      { path: 'test/old.test.ts', status: 'deleted', added: 0, removed: 9 },
      { path: 'package.json', status: 'modified', added: 1, removed: 1 },
    ],
    patch: '+++ b/test/app.test.ts\n+test.skip("adds", () => {});\n',
    truncated: false,
    components: ['src', 'test/'],
    baseline: [pass('unit'), fail('lint')],
    final: [fail('unit'), fail('lint')],
  });
  assert.deepEqual(risks.map((r) => r.kind).sort(), ['deleted_test', 'regression', 'still_failing', 'unrelated_file', 'weakened_test']);
  const fix = reviewChange({ kind: 'bugfix', files: [{ path: 'src/a.py', status: 'modified', added: 1, removed: 1 }], patch: '', truncated: false, components: [], baseline: [pass('unit')], final: [pass('unit')] });
  assert.deepEqual(fix.map((r) => r.kind), ['not_reproduced', 'no_test']);
  // Found on a real Windows run: `node --test` in an empty repository passes with no tests at all.
  const empty = { ...pass('tests'), output: 'ℹ tests 0\nℹ suites 0\nℹ pass 0\nℹ fail 0\n' };
  const none = reviewChange({ kind: 'feature', files: [{ path: 'src/a.mjs', status: 'added', added: 3, removed: 0 }, { path: 'test/a.test.mjs', status: 'added', added: 3, removed: 0 }], patch: '', truncated: false, components: [], baseline: [empty], final: [empty] });
  assert.deepEqual(none.map((r) => r.kind), ['no_tests_ran']);
  for (const out of ['# tests 0', 'No tests found, exiting with code 0', 'No test files found, exiting with code 0', '  0 passing (2ms)']) assert.ok(ranNoTests(out), out);
  for (const out of ['ℹ tests 6\nℹ pass 6', '# tests 10', '12 passing (5ms)', '']) assert.ok(!ranNoTests(out), out);
  assert.deepEqual(parseChanges('M\0src/a.ts\0R100\0old.ts\0new.ts\0A\0b.ts\0', '1\t2\tsrc/a.ts\0' + '0\t0\t\0old.ts\0new.ts\0' + '5\t0\tb.ts\0'), [
    { path: 'src/a.ts', status: 'modified', added: 1, removed: 2 },
    { path: 'new.ts', status: 'renamed', added: 0, removed: 0 },
    { path: 'b.ts', status: 'added', added: 5, removed: 0 },
  ]);
});

test('M6-AC1 (bug fix): reproduce → regression test → fix → checks, in a worktree that leaves the checkout alone', async (t) => {
  const model = scripted([
    { calls: [{ id: 'c1', name: 'read_file', input: { path: 'src/sum.mjs' } }] },
    { calls: [{ id: 'c2', name: 'write_file', input: { path: 'test/sum.test.mjs', content: TEST.replace("console.log('sum ok');", "assert.equal(sum(-1, 1), 0);\nconsole.log('sum ok');") } }] },
    { calls: [{ id: 'c3', name: 'write_file', input: { path: 'src/sum.mjs', content: FIXED } }] },
    { calls: [{ id: 'c4', name: 'run_check', input: { check_id: 'unit' } }] },
    { text: 'Root cause: sum subtracted. Added a regression case and fixed the operator. unit passed.' },
  ]);
  const { ws, builder, project, repo } = setup(t, model);
  await builder.setRepo(project.id, repo);
  const build = builder.create(project.id, { kind: 'bugfix', title: 'sum subtracts', goal: 'sum(2, 3) returns -1', repro: 'Run node test/sum.test.mjs', components: ['src', 'test'], checks: [UNIT] });

  const started = await builder.start(build.id);
  assert.equal(started.build.status, 'in_progress');
  assert.match(started.build.branch!, /^iap\/fix-/);
  assert.deepEqual(started.checkRuns.map((r) => [r.phase, r.status]), [['baseline', 'failed']], 'the bug is reproduced by a failing check');
  assert.throws(() => builder.edit(build.id, { kind: 'bugfix', title: 'x', goal: 'y', repro: 'z', checks: [{ id: 'unit', command: 'echo ok' }] }), /fixed once work has started/);

  const ran = await builder.runAgent(build.id);
  assert.equal(ran.build.agent?.status, 'done');
  assert.deepEqual(ran.build.agent?.filesWritten.sort(), ['src/sum.mjs', 'test/sum.test.mjs']);
  assert.deepEqual(ran.checkRuns.at(-1) && [ran.checkRuns.at(-1)!.phase, ran.checkRuns.at(-1)!.status], ['agent', 'passed']);

  const verified = await builder.verify(build.id);
  assert.equal(verified.build.status, 'review');
  assert.deepEqual(verified.build.risks, []);
  assert.deepEqual(verified.build.changedFiles?.map((f) => f.path).sort(), ['src/sum.mjs', 'test/sum.test.mjs']);
  // The helper agents (M18 part 4) looked at the change and are kept with the task.
  assert.deepEqual(verified.build.helpers?.map((h) => [h.id, h.status, h.costUsd]), [
    ['scan', 'done', 0],
    ['security', 'done', 0],
    ['tests', 'done', 0],
    ['drift', 'done', 0],
  ]);
  assert.match(verified.build.helpers![0]!.summary, /test file; this task changed 2\.$/);
  assert.equal(verified.build.helpers![1]!.summary, 'Nothing risky found in the added lines.');
  // Stored as numbers: redaction must not take a key like "passed" for a password.
  assert.deepEqual(verified.build.helpers![2]!.totals, { ok: 0, failed: 0, skipped: 0 });
  const done = await builder.complete(build.id, null);
  assert.equal(done.build.status, 'completed');
  // The change is committed on the build's branch, so the person can merge it; their checkout's branch is untouched.
  assert.equal(gitIn(repo, 'rev-parse', done.build.branch!).trim(), done.build.resultCommit);
  assert.equal(gitIn(repo, 'rev-parse', `${done.build.resultCommit}^`).trim(), verified.build.baseCommit);
  assert.equal(gitIn(repo, 'show', `${done.build.resultCommit}:src/sum.mjs`), FIXED);

  // The person's checkout is untouched: same commit, same buggy file, nothing modified.
  assert.equal(readFileSync(join(repo, 'src', 'sum.mjs'), 'utf8'), BUGGY);
  assert.equal(gitIn(repo, 'status', '--porcelain').trim(), '');
  assert.equal(gitIn(repo, 'rev-parse', 'HEAD').trim(), verified.build.baseCommit);
  assert.equal(readFileSync(join(verified.build.worktree!, 'src', 'sum.mjs'), 'utf8'), FIXED);

  const report = readFileSync(done.build.reportPath!, 'utf8');
  assert.match(report, /\| baseline \| unit \| `node test\/sum.test.mjs` \| FAILED \| 1 \|/);
  assert.match(report, /\| verify \| unit \| `node test\/sum.test.mjs` \| passed \| 0 \|/);
  assert.match(report, /git merge iap\/fix-/);
  const events = ws.listEvents({ projectId: project.id }).map((e) => e.type);
  for (const type of ['build.created', 'build.started', 'build.check', 'build.agent', 'build.verified', 'build.completed']) assert.ok(events.includes(type), type);
});

test('M6: check results are append-only evidence', async (t) => {
  const { ws, builder, project, repo, home } = setup(t);
  await builder.setRepo(project.id, repo);
  const build = builder.create(project.id, { kind: 'bugfix', title: 't', goal: 'g', repro: 'r', checks: [UNIT] });
  await builder.start(build.id);
  assert.equal(ws.listCheckRuns(build.id).length, 1);
  const raw = new DatabaseSync(appPaths(home).db);
  assert.throws(() => raw.exec("UPDATE check_runs SET status = 'passed'"), /append-only/);
  assert.throws(() => raw.exec('DELETE FROM check_runs'), /append-only/);
  raw.close();
});

test('M6: the simulated agent changes nothing, and remaining risks need an explanation', async (t) => {
  const { builder, project, repo } = setup(t);
  await builder.setRepo(project.id, repo);
  const build = builder.create(project.id, { kind: 'bugfix', title: 't', goal: 'g', repro: 'r', checks: [UNIT] });
  await builder.start(build.id);
  const ran = await builder.runAgent(build.id);
  assert.equal(ran.build.agent?.model, 'simulated');
  assert.deepEqual(ran.build.agent?.steps.map((s) => s.tool), ['list_files']);
  assert.match(ran.build.agent!.summary, /Simulated model/);
  const verified = await builder.verify(build.id);
  assert.deepEqual(verified.build.risks?.map((r) => r.kind), ['no_change', 'still_failing']);
  await assert.rejects(builder.complete(build.id, ''), /Explain why/);
  assert.equal((await builder.complete(build.id, 'Will fix by hand in the next build.')).build.status, 'completed');
  assert.match(readFileSync(verified.build.reportPath!, 'utf8'), /Simulated agent \(no AI was called\)/);
});

test('M6: the agent cannot escape the worktree, run unapproved commands, or pass its budget', async (t) => {
  const { ws, repo } = setup(t);
  const model = scripted([
    {
      calls: [
        { id: 'a', name: 'write_file', input: { path: '../outside.txt', content: 'x' } },
        { id: 'b', name: 'run_check', input: { check_id: 'rm -rf /' } },
        { id: 'c', name: 'bash', input: { command: 'ls' } },
      ],
    },
    { text: 'gave up' },
  ]);
  const out = await runBuildAgent(ws, model, { title: 't', instructions: 'i', worktree: repo, checks: [UNIT] });
  assert.equal(out.status, 'done');
  assert.deepEqual(out.steps.map((s) => s.ok), [false, false, false]);
  assert.match(out.steps[1]!.note, /No approved check/);
  assert.equal(existsSync(join(repo, '..', 'outside.txt')), false);

  // Billable: blocked without a budget, and stopped by the per-run cap.
  const paid = scripted([{ calls: [{ id: 'x', name: 'list_files', input: { path: '.' } }], costUsd: 1 }], true);
  assert.equal((await runBuildAgent(ws, paid, { title: 't', instructions: 'i', worktree: repo, checks: [] })).status, 'blocked');
  ws.updateSetting('budget', '20');
  const capped = await runBuildAgent(ws, paid, { title: 't', instructions: 'i', worktree: repo, checks: [], maxCostUsd: 2.5 });
  assert.equal(capped.status, 'blocked');
  assert.equal(capped.costUsd, 2);
  assert.match(capped.summary, /past its \$2.50 limit/);
});

test('M6-AC2 (feature): needs an approved spec, known requirement IDs and at least one check', async (t) => {
  const { ws, builder, project, repo } = setup(t);
  const base = { kind: 'feature' as const, title: 'Add multiply', goal: 'Add a multiply function', checks: [UNIT] };
  assert.throws(() => builder.create(project.id, { ...base, requirementIds: [] }), /Approve a specification first/);
  const brief = ws.createPlanDoc({ projectId: project.id, kind: 'brief', content: { goals: ['g'], users: ['u'], useCases: [], scope: ['s'], nonGoals: [], confirmed: [], assumptions: [], dependencies: [], risks: [], successCriteria: ['c'] }, source: 'manual', basedOn: null, changeNote: null });
  ws.approvePlanDoc(brief.id, null, null);
  const spec = ws.createPlanDoc({ projectId: project.id, kind: 'spec', content: { requirements: [{ id: 'REQ-001', title: 'Multiply', description: '', priority: 'MUST', acceptanceCriteria: ['2*3=6'] }] }, source: 'manual', basedOn: brief.id, changeNote: null });
  ws.approvePlanDoc(spec.id, null, brief.id);
  assert.throws(() => builder.create(project.id, { ...base, requirementIds: ['REQ-002'] }), /REQ-002 is not in the approved specification/);
  assert.throws(() => builder.create(project.id, { ...base, requirementIds: ['REQ-001'], checks: [] }), /at least one check/);
  assert.throws(() => builder.create(project.id, { ...base, requirementIds: ['REQ-001'], components: ['../x'] }), /inside the repository/);
  const build = builder.create(project.id, { ...base, requirementIds: ['REQ-001'], components: ['./src/'] });
  assert.deepEqual(build.components, ['src/']);
  // Several folders on one line, as people write them, are separate components.
  const both = builder.create(project.id, { ...base, requirementIds: ['REQ-001'], components: ['src/ and test/', 'lib, docs/'] });
  assert.deepEqual(both.components, ['src/', 'test/', 'lib', 'docs/']);
  builder.abandon(both.id, null);
  await assert.rejects(builder.start(build.id), /Choose the git repository/);
  await builder.setRepo(project.id, repo);
  await builder.start(build.id);
  // A hand-made change outside the components, without a test, is reported.
  writeFileSync(join(ws.getBuild(build.id).worktree!, 'notes.txt'), 'scratch\n');
  const verified = await builder.verify(build.id);
  assert.deepEqual(verified.build.risks?.map((r) => r.kind), ['still_failing', 'unrelated_file', 'no_test']);
  assert.match(readFileSync(verified.build.reportPath!, 'utf8'), /added `notes.txt` \(\+1 -0\)/);
});

test('M6: a repository is required, and the app can start one in its own project folder', async (t) => {
  const { builder, project, home } = setup(t);
  await assert.rejects(builder.setRepo(project.id, 'relative/path'), /full path/);
  await assert.rejects(builder.setRepo(project.id, home), /not a git repository|has no commits/);
  const p = await builder.initProjectRepo(project.id);
  assert.equal(p.repoPath, project.workspacePath);
  assert.ok(existsSync(join(project.workspacePath, '.git')));
  assert.equal((await builder.initProjectRepo(project.id)).repoPath, project.workspacePath, 'running it again changes nothing');
});

test('M6: repository hooks never run', async (t) => {
  const { builder, project, repo } = setup(t);
  const marker = join(repo, '..', 'hook-ran');
  writeFileSync(join(repo, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch "${marker.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
  await builder.setRepo(project.id, repo);
  const build = builder.create(project.id, { kind: 'bugfix', title: 't', goal: 'g', repro: 'r', checks: [UNIT] });
  await builder.start(build.id);
  assert.equal(existsSync(marker), false);
});
