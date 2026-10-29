import assert from 'node:assert/strict';
import test from 'node:test';
import type { CheckResult } from '../src/core/build/checks.ts';
import { addedWithLines, readTests, runHelpers, scanRepo, securityReview, specDrift } from '../src/core/build/helpers.ts';

const patch = (file: string, lines: string[], start = 1) => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -0,0 +${start},${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
const check = (checkId: string, output: string, status: CheckResult['status'] = 'passed'): CheckResult => ({ checkId, command: 'npm test', status, exitCode: 0, durationMs: 10, output, startedAt: '2026-10-29T00:00:00Z' });

test('M18-4: added lines keep their line numbers in the new file', () => {
  const p = ['--- a/a.ts', '+++ b/a.ts', '@@ -3,3 +3,4 @@', ' keep', '-old', '+new one', '+new two', ' tail'].join('\n');
  assert.deepEqual(addedWithLines(p).get('a.ts'), [
    { line: 4, text: 'new one' },
    { line: 5, text: 'new two' },
  ]);
});

test('M18-4: the scan counts languages and test files', () => {
  const r = scanRepo(['src/a.ts', 'src/b.tsx', 'src/c.ts', 'index.html', 'test/a.test.ts'], [{ path: 'src/a.ts', status: 'modified', added: 1, removed: 0 }] as never);
  assert.deepEqual(r.languages, [
    { name: 'TypeScript', files: 4 },
    { name: 'HTML', files: 1 },
  ]);
  assert.match(r.summary, /^5 files \(mostly TypeScript, HTML\), 1 test file; this task changed 1\.$/);
  assert.deepEqual(r.findings, []);
});

test('M18-4: security finds risky added lines, never quotes a secret, and ranks by severity', () => {
  const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
  const files = [
    { path: 'src/db.ts', status: 'added', added: 4, removed: 0 },
    { path: '.env', status: 'added', added: 1, removed: 0 },
    { path: 'package.json', status: 'modified', added: 2, removed: 0 },
  ] as never;
  const p = [
    patch('src/db.ts', ['const q = `SELECT * FROM users WHERE id = ${id}`;', 'el.innerHTML = name;', `const k = "${key}";`, 'fetch("http://example.com/api");']),
    patch('package.json', ['  "dependencies": {', '    "left-pad": "^1.3.0"'], 10),
  ].join('\n');
  const r = securityReview(files, p);
  assert.deepEqual(
    r.findings.map((f) => [f.severity, f.title, f.file, f.line]),
    [
      ['high', 'Environment file in the change', '.env', undefined],
      ['high', 'Possible secret', 'src/db.ts', 3],
      ['medium', 'SQL built from text', 'src/db.ts', 1],
      ['medium', 'HTML from text', 'src/db.ts', 2],
      ['low', 'Plain http address', 'src/db.ts', 4],
      ['info', 'New dependency', 'package.json', 11],
    ],
  );
  assert.ok(!JSON.stringify(r).includes(key));
  assert.equal(r.summary, '4 findings to look at.');
  assert.equal(securityReview([], '').summary, 'Nothing risky found in the added lines.');
});

test('M18-4: tests are read by name from TAP, Jest/Vitest, pytest and Go output, and by count otherwise', () => {
  const r = readTests([
    check('unit', ['# Subtest: adds', 'ok 1 - adds', 'not ok 2 - subtracts', 'ok 3 - divides # SKIP not yet', 'ok 4 - test/math.test.ts', '1..4'].join('\n'), 'failed'),
    check('web', ['  ✓ renders the list (12 ms)', '  ✕ sorts by name', '  ○ skipped later'].join('\n')),
    check('py', ['tests/test_a.py::test_one PASSED', 'tests/test_a.py::test_two FAILED'].join('\n')),
    check('go', ['--- PASS: TestRota (0.00s)'].join('\n')),
    check('quiet', '# tests 7\n# pass 6\n# fail 1'),
  ]);
  assert.deepEqual(
    r.tests!.map((t) => `${t.checkId}:${t.status}:${t.name}`),
    ['unit:passed:adds', 'unit:failed:subtracts', 'unit:skipped:divides', 'web:passed:renders the list', 'web:failed:sorts by name', 'web:skipped:skipped later', 'py:passed:tests/test_a.py::test_one', 'py:failed:tests/test_a.py::test_two', 'go:passed:TestRota'],
  );
  assert.deepEqual(r.totals, { ok: 10, failed: 4, skipped: 2 });
  assert.equal(r.summary, '10 passed, 4 failed, 2 skipped.');
  assert.deepEqual(
    r.findings.map((f) => f.title),
    ['Test fails', 'Test fails', 'Test fails', 'Skipped tests'],
  );
  assert.equal(readTests([]).summary, 'No checks ran.');
  assert.equal(readTests([check('x', 'built ok')]).findings[0]!.title, 'No test results');
});

test('M18-4: spec drift compares the ask and acceptance criteria with the change and its tests', () => {
  const files = [{ path: 'src/members.ts', status: 'added', added: 3, removed: 0 }] as never;
  const p = patch('src/members.ts', ['export function listMembers() {', '  return members.sort(byName);', '}']);
  const r = specDrift({
    files,
    patch: p,
    goal: 'Add a page that lists members',
    requirements: [{ id: 'REQ-001', title: 'Members', acceptanceCriteria: ['Members are sorted by name', 'Birthdays are highlighted in December'] }],
  });
  assert.deepEqual(
    r.findings.map((f) => f.title),
    ['REQ-001 may not be covered'],
  );
  assert.match(r.findings[0]!.detail, /Birthdays are highlighted/);
  assert.equal(r.summary, 'Compared with 2 acceptance criteria from REQ-001: 1 gap.');
  const none = specDrift({ files: [], patch: '', goal: 'Add rota export', requirements: [] });
  assert.deepEqual(
    none.findings.map((f) => f.title),
    ['Nothing changed'],
  );
});

test('M18-4 + M19: the scan runs first, then the other four together; one failing helper does not stop the rest', async () => {
  const seen: string[][] = [];
  let t = 0;
  const now = () => new Date(Date.UTC(2026, 9, 29, 0, 0, 0, (t += 5)));
  const runs = await runHelpers(
    { repoFiles: ['a.ts'], files: [], patch: '', checks: [check('unit', 'ok 1 - a')], goal: 'x', requirements: [] },
    (r) => seen.push(r.map((h) => h.id)),
    now,
  );
  assert.deepEqual(
    runs.map((h) => [h.id, h.label, h.status, h.costUsd]),
    [
      ['scan', 'Repository scan', 'done', 0],
      ['review', 'Code review', 'done', 0],
      ['security', 'Security', 'done', 0],
      ['tests', 'Tests', 'done', 0],
      ['drift', 'Spec drift', 'done', 0],
    ],
  );
  assert.deepEqual(seen[0], ['scan']);
  assert.equal(seen.length, 5);
  assert.ok(runs.every((h) => h.durationMs > 0));
  // A check whose output cannot be read makes the tests helper fail, not the run.
  const broken = await runHelpers({ repoFiles: [], files: [], patch: '', checks: [{ checkId: 'x' } as CheckResult], goal: 'x', requirements: [] });
  assert.equal(broken.find((h) => h.id === 'tests')!.status, 'failed');
  assert.equal(broken.find((h) => h.id === 'security')!.status, 'done');
});
