// M16 (DEC-033): the finished task as a report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, groupFiles, keepNote, makeReport, splitShipList } from '../src/shared/report.ts';
import type { Build, CheckRun } from '../src/shared/api.ts';

const build = (over: Partial<Build> = {}): Build =>
  ({
    id: 'b1',
    status: 'review',
    risks: [],
    changedFiles: [],
    agent: { model: 'claude-x', status: 'done', summary: 'Added the page.', steps: [], filesWritten: [], resolution: null, costUsd: 0.19, at: '' },
    ...over,
  }) as Build;

const run = (checkId: string, phase: CheckRun['phase'], status: CheckRun['status'], seq: number): CheckRun => ({
  seq,
  buildId: 'b1',
  phase,
  checkId,
  command: `npm run ${checkId}`,
  status,
  exitCode: status === 'passed' ? 0 : 1,
  durationMs: 1200,
  output: '',
  startedAt: '',
});

test('splitShipList takes Claude\'s closing list off the summary', () => {
  const r = splitShipList('Added the members page and a test.\n\nBefore it ships:\n- Add SMTP_HOST to .env\n- Try the page with an empty rota\n');
  assert.equal(r.summary, 'Added the members page and a test.');
  assert.deepEqual(r.todos, ['Add SMTP_HOST to .env', 'Try the page with an empty rota']);

  assert.deepEqual(splitShipList('Done.\n\nBefore it ships: nothing'), { summary: 'Done.', todos: [] });
  assert.deepEqual(splitShipList('Done.\n**Before it ships:** run the migration'), { summary: 'Done.', todos: ['run the migration'] });
  assert.deepEqual(splitShipList('## Before it ships\n\n1. Check the colours\n\nThanks.'), { summary: 'Thanks.', todos: ['Check the colours'] });
  // Without the heading, nothing is taken.
  assert.deepEqual(splitShipList('- one\n- two'), { summary: '- one\n- two', todos: [] });
});

test('makeReport counts the latest verify results, files and lines, and lists commands', () => {
  const runs = [run('test', 'baseline', 'failed', 1), run('test', 'verify', 'failed', 2), run('test', 'verify', 'passed', 3), run('lint', 'verify', 'passed', 4)];
  const files = [
    { path: 'src/members.ts', status: 'added' as const, added: 34, removed: 0 },
    { path: 'src/app.ts', status: 'modified' as const, added: 7, removed: 2 },
  ];
  const b = build({ agent: { ...build().agent!, summary: 'Added it.\nBefore it ships:\n- Try it', steps: [{ tool: 'Bash', target: 'npm ci', ok: true, note: '' }, { tool: 'Read', target: 'a.ts', ok: true, note: '' }] } });
  const r = makeReport(b, runs, files);
  assert.equal(r.headline, 'Ready for your review');
  assert.deepEqual(r.checks, { passed: 2, total: 2 });
  assert.equal(r.added, 41);
  assert.equal(r.removed, 2);
  assert.equal(r.costUsd, 0.19);
  assert.deepEqual(
    r.commands.map((c) => [c.command, c.ok, c.from]),
    [
      ['npm run test', true, 'check'],
      ['npm run lint', true, 'check'],
      ['npm ci', true, 'claude'],
    ],
  );
  assert.deepEqual(r.todos, ['Try it']);
  assert.equal(r.summary, 'Added it.');
});

test('makeReport headlines failing checks, stops, no change, kept and undone; risks become to-dos', () => {
  const files = [{ path: 'a.ts', status: 'modified' as const, added: 1, removed: 1 }];
  assert.equal(makeReport(build(), [run('test', 'verify', 'failed', 1)], files).headline, 'Ready, but 1 of 1 check is failing');
  assert.equal(makeReport(build(), [], files).tone, 'ok');
  assert.equal(makeReport(build(), [], []).headline, 'Nothing changed');
  assert.equal(makeReport(build({ agent: { ...build().agent!, status: 'blocked' } }), [], files).tone, 'warn');
  assert.equal(makeReport(build({ status: 'completed' }), [], files).headline, 'Kept');
  assert.equal(makeReport(build({ status: 'abandoned' }), [], null).headline, 'Undone');
  const risky = build({ risks: [{ kind: 'not_run', detail: 'Nothing tested the change.' }] as Build['risks'] });
  assert.deepEqual(makeReport(risky, [], files).todos, ['Nothing tested the change.']);
  // With only baseline runs, those are reported.
  assert.deepEqual(makeReport(build(), [run('test', 'baseline', 'passed', 1)], files).checks, { passed: 1, total: 1 });
});

test('keepNote keeps one-tap keeping while the record still says what was open', () => {
  const risky = build({ risks: [{ kind: 'not_run', detail: '' }, { kind: 'no_test', detail: '' }] as Build['risks'] });
  assert.equal(keepNote(risky, ''), 'Kept from the review with 2 open points: not run, no test.');
  assert.ok((keepNote(risky, 'ok') ?? '').length >= 10);
  assert.equal(keepNote(risky, 'Looked at it myself.'), 'Looked at it myself.');
  assert.equal(keepNote(build(), ''), null);
  assert.equal(keepNote(build(), ' fine '), 'fine');
});

test('groupFiles groups by folder and formatDuration reads naturally', () => {
  const g = groupFiles([
    { path: 'src/b.ts', status: 'added', added: 1, removed: 0 },
    { path: 'README.md', status: 'modified', added: 1, removed: 0 },
    { path: 'src/a.ts', status: 'modified', added: 1, removed: 0 },
  ]);
  assert.deepEqual(
    g.map((x) => [x.dir, x.files.map((f) => f.name)]),
    [
      ['', ['README.md']],
      ['src', ['b.ts', 'a.ts']],
    ],
  );
  assert.equal(formatDuration(840), '840 ms');
  assert.equal(formatDuration(4_100), '4.1 s');
  assert.equal(formatDuration(42_000), '42 s');
  assert.equal(formatDuration(134_000), '2 m 14 s');
});
