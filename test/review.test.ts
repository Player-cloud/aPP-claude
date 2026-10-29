// M19 independent review (FR-QA-003, FR-SHIP-001, DEC-037): the code-review
// helper's rules, Claude's review through a scripted model (no money is
// spent), and the simplification pass that only runs when it is relevant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './helpers.ts';
import { Workspace } from '../src/core/workspace.ts';
import { SimulatedModel } from '../src/core/agents/model.ts';
import { Builder } from '../src/core/build/builder.ts';
import { codeReview, type HelperRun } from '../src/core/build/helpers.ts';
import { parseReview, reviewInstructions } from '../src/core/build/independent.ts';
import { simplifyRequest, simplifyTargets } from '../src/shared/report.ts';

const patch = (file: string, lines: string[], start = 1) => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -0,0 +${start},${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
const file = (path: string, status = 'added') => ({ path, status, added: 1, removed: 0 }) as never;

test('M19-AC1: the code review finds swallowed errors, switched-off checkers, leftovers, repeats and missing tests, each with impact and fix', () => {
  const repeated = ['const a = load(x);', 'const b = parse(a);', 'const c = check(b);', 'if (!c) return null;', 'save(c, opts);', 'notify(user, c);'];
  const p = [
    patch('src/a.ts', ['try {', '  run();', '} catch (e) {}', '// @ts-ignore', 'const v = data as any;', 'console.log(v);', 'debugger;', '// TODO: handle paging', ...repeated, 'next();', ...repeated]),
    patch('scripts/build.mjs', ['console.log("built");']),
  ].join('\n');
  const r = codeReview([file('src/a.ts'), file('scripts/build.mjs')], p);
  const titles = r.findings.map((f) => [f.severity, f.area, f.title, f.file, f.line ?? null]);
  assert.deepEqual(titles, [
    ['medium', 'correctness', 'Error swallowed', 'src/a.ts', 3],
    ['medium', 'correctness', 'Checker switched off', 'src/a.ts', 4],
    ['medium', 'correctness', 'Debugger left in', 'src/a.ts', 7],
    ['medium', 'maintainability', 'Repeated code', 'src/a.ts', 16],
    ['medium', 'tests', 'No test for the change', undefined, null],
    ['low', 'maintainability', 'Debug output left in', 'src/a.ts', 6],
    ['low', 'maintainability', 'Unfinished work', 'src/a.ts', 8],
    ['low', 'maintainability', 'Type check bypassed', 'src/a.ts', 5],
  ]);
  assert.ok(r.findings.every((f) => f.impact && f.fix && f.detail), 'every finding has evidence, impact and fix (FR-QA-003)');
  assert.ok(!r.findings.some((f) => f.file === 'scripts/build.mjs'), 'printing in a script is the point');
  assert.equal(r.summary, '5 findings to look at.');
  // Tests are not reviewed as code, and a change with a test has no missing-test finding.
  const tested = codeReview([file('src/b.ts'), file('test/b.test.ts')], [patch('src/b.ts', ['export const b = 1;']), patch('test/b.test.ts', ['console.log("x"); // TODO'])].join('\n'));
  assert.deepEqual(tested.findings, []);
  assert.equal(tested.summary, 'Nothing to change in the added code.');
});

test('M19-AC1: large and deeply nested changes are complexity findings; more than five hits of one rule are summarised', () => {
  const lines = Array.from({ length: 320 }, (_, i) => `export const v${i} = ${i}; // TODO ${i}`);
  lines.push(`${' '.repeat(26)}deep();`);
  const r = codeReview([file('src/big.ts')], patch('src/big.ts', lines));
  const complexity = r.findings.filter((f) => f.area === 'complexity').map((f) => f.title);
  assert.deepEqual(complexity.sort(), ['Deeply nested code', 'Large change in one file']);
  const todos = r.findings.filter((f) => f.title === 'Unfinished work');
  assert.equal(todos.length, 6);
  assert.match(todos.find((f) => f.severity === 'info')!.detail, /^315 more lines like this\.$/);
});

test('M19-AC2: Claude’s answer is checked: malformed items dropped, critical kept and marked, helper duplicates removed, secrets redacted', () => {
  const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';
  const known = [{ severity: 'medium' as const, title: 'Error swallowed', detail: 'x', file: 'src/a.ts', line: 10 }];
  const text = JSON.stringify({
    summary: 'Mostly fine.',
    findings: [
      { severity: 'critical', area: 'correctness', file: 'src/a.ts', line: 40, title: 'Deletes every row', evidence: `DELETE without WHERE; key ${key}`, impact: 'All data is lost.', fix: 'Add the WHERE clause.' },
      { severity: 'medium', area: 'correctness', file: './src/a.ts', line: 11, title: 'Same as the helper', evidence: 'e', impact: 'i', fix: 'f' },
      { severity: 'low', area: 'nonsense', file: '', line: -3, title: 'Name could be clearer', evidence: '', impact: '', fix: '' },
      { severity: 'urgent', title: 'Unknown severity' },
      { severity: 'high', title: '' },
    ],
  });
  const r = parseReview(text, known);
  assert.equal(r.critical, 1);
  assert.deepEqual(r.findings.map((f) => [f.severity, f.area, f.title, f.file ?? null, f.line ?? null]), [
    ['high', 'correctness', 'Critical: Deletes every row', 'src/a.ts', 40],
    ['low', 'correctness', 'Name could be clearer', null, null],
  ]);
  assert.ok(!JSON.stringify(r).includes(key));
  assert.throws(() => parseReview('not json', []), /expected format/);
  // The instructions carry the helpers' findings so Claude does not repeat them, and never a secret from the diff.
  const ins = reviewInstructions({ title: 't', goal: 'g', files: [file('src/a.ts')], patch: patch('src/a.ts', [`const k = "${key}";`]), known });
  assert.match(ins, /Already reported by the helpers \(do not repeat\):\n- Error swallowed at src\/a\.ts:10/);
  assert.ok(!ins.includes(key));
});

test('M19-AC3: simplifying is offered only for repeated, long or nested code, and asks for the same behaviour with every test kept', () => {
  const run = (findings: HelperRun['findings'], id: HelperRun['id'] = 'review'): HelperRun => ({ id, label: id, status: 'done', startedAt: '', durationMs: 0, costUsd: 0, summary: '', findings });
  assert.deepEqual(simplifyTargets([run([{ severity: 'low', area: 'maintainability', title: 'Debug output left in', detail: '' }]), run([{ severity: 'high', area: 'security', title: 'x', detail: '' }], 'security')]), []);
  const targets = simplifyTargets([run([{ severity: 'medium', area: 'maintainability', title: 'Repeated code', detail: 'Same lines twice.', fix: 'Move them into one function.', file: 'src/a.ts', line: 16 }]), run([{ severity: 'low', area: 'complexity', title: 'Deeply nested code', detail: 'd' }], 'claude')]);
  assert.equal(targets.length, 2);
  const text = simplifyRequest(targets);
  assert.match(text, /- Repeated code \(src\/a\.ts:16\): Same lines twice\. Move them into one function\./);
  assert.match(text, /Do not remove, skip or weaken any test\. The checks run again afterwards/);
});

function gitIn(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
}

test('M19-AC2: Claude’s review runs under the budget on the verified change; a critical finding becomes a risk and a to-do, and a new verification drops it', async (t) => {
  const { home, cleanup } = tempHome();
  const ws = Workspace.open(home);
  t.after(() => {
    ws.close();
    cleanup();
  });
  const repo = join(home, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.mjs'), 'export const a = 1;\n');
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'init');
  const project = ws.createProject({ name: 'A', idea: 'A' });
  const seen: string[] = [];
  const answer = { summary: 'One real problem.', findings: [{ severity: 'critical', area: 'correctness', file: 'src/a.mjs', line: 1, title: 'Wrong value', evidence: 'a is 2 but the spec says 1', impact: 'Totals are off.', fix: 'Set it back to 1.' }] };
  const model = new SimulatedModel(
    (r) => {
      if (r.purpose !== 'review') return { text: '{}' };
      seen.push(r.instructions);
      return { text: JSON.stringify(answer), costUsd: 0.04 };
    },
    { billable: true },
  );
  const builder = new Builder(ws, model, { checkTimeoutMs: 30_000 });
  await builder.setRepo(project.id, repo);
  const b = builder.create(project.id, { kind: 'bugfix', title: 'Change a', goal: 'Change a', repro: 'Read src/a.mjs', checks: [{ id: 'ok', command: 'node -e "process.exit(0)"' }] });
  await builder.start(b.id);
  await assert.rejects(builder.review(b.id), /Verify the change before asking for a review/);
  writeFileSync(join(ws.getBuild(b.id).worktree!, 'src', 'a.mjs'), 'export const a = 2;\n');
  await builder.verify(b.id);
  await assert.rejects(builder.review(b.id), /The review did not run: Real model calls are off: no monthly budget is set/);

  ws.updateSetting('budget', '20');
  const d = await builder.review(b.id);
  assert.match(seen[0]!, /\+export const a = 2;/);
  const claude = d.build.helpers!.find((h) => h.id === 'claude')!;
  assert.deepEqual([claude.label, claude.costUsd, claude.findings[0]!.title, claude.findings[0]!.impact], ['Claude review', 0.04, 'Critical: Wrong value', 'Totals are off.']);
  assert.ok(d.build.risks!.some((r) => r.kind === 'review' && /Critical: Wrong value in src\/a\.mjs:1/.test(r.detail)));
  assert.ok(ws.listTodos({ buildId: b.id }).some((t) => /Critical: Wrong value/.test(t.text)));
  assert.equal(ws.spentThisMonth(), 0.04);
  assert.ok(ws.listEvents({ limit: 50 }).some((e) => e.type === 'build.reviewed'));
  // Reviewing again replaces Claude's earlier review instead of adding a second one.
  const again = await builder.review(b.id);
  assert.equal(again.build.helpers!.filter((h) => h.id === 'claude').length, 1);
  // A new verification reviews the new diff, so the old Claude findings no longer apply.
  const reverified = await builder.verify(b.id);
  assert.equal(reverified.build.helpers!.some((h) => h.id === 'claude'), false);
  assert.equal(reverified.build.risks!.some((r) => r.kind === 'review'), false);
});
