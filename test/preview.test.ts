// M16 H (DEC-033): live preview of what a task builds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { join } from 'node:path';
import { detectPreview, freePort, Previews, serveStatic } from '../src/core/build/preview.ts';
import { tempHome } from './helpers.ts';

const fetchText = (url: string) =>
  new Promise<{ status: number; body: string }>((ok, fail) => {
    get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body }));
    }).on('error', fail);
  });

test('detectPreview prefers a dev script, then a static index.html, else nothing', (t) => {
  const { home: root, cleanup } = tempHome();
  t.after(cleanup);
  assert.equal(detectPreview(root), null);
  mkdirSync(join(root, 'public'));
  writeFileSync(join(root, 'public', 'index.html'), '<h1>Hi</h1>');
  assert.deepEqual(detectPreview(root), { kind: 'static', command: null, folder: join(root, 'public') });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', start: 'node server.js' } }));
  assert.deepEqual(detectPreview(root), { kind: 'script', command: 'npm start', folder: root });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', start: 'node server.js' } }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), '');
  assert.equal(detectPreview(root)?.command, 'pnpm run dev');
});

test('the static server serves the folder and nothing outside it', async (t) => {
  const { home: root, cleanup } = tempHome();
  t.after(cleanup);
  mkdirSync(join(root, 'site', '.git'), { recursive: true });
  writeFileSync(join(root, 'site', 'index.html'), '<h1>Members</h1>');
  writeFileSync(join(root, 'site', '.git', 'config'), 'secret');
  writeFileSync(join(root, 'outside.txt'), 'secret');
  const port = await freePort();
  const server = await serveStatic(join(root, 'site'), port);
  t.after(() => server.close());
  assert.match((await fetchText(`http://127.0.0.1:${port}/`)).body, /Members/);
  assert.equal((await fetchText(`http://127.0.0.1:${port}/../outside.txt`)).status, 404);
  assert.equal((await fetchText(`http://127.0.0.1:${port}/%2e%2e/outside.txt`)).status, 404);
  assert.equal((await fetchText(`http://127.0.0.1:${port}/.git/config`)).status, 404);
});

test('a dev server starts on a free port without keys, answers, and stops', async (t) => {
  const { home: root, cleanup } = tempHome();
  t.after(cleanup);
  writeFileSync(
    join(root, 'server.js'),
    `require('http').createServer((q, s) => s.end('key=' + (process.env.ANTHROPIC_API_KEY || 'none'))).listen(process.env.PORT, '127.0.0.1', () => console.log('ready on http://localhost:' + process.env.PORT));`,
  );
  const previews = new Previews();
  t.after(() => previews.stopAll());
  process.env.ANTHROPIC_API_KEY = 'sk-test-should-not-leak';
  t.after(() => delete process.env.ANTHROPIC_API_KEY);
  const state = await previews.start('b1', { kind: 'script', command: 'node server.js', folder: root });
  assert.equal(state.status, 'running', state.log);
  assert.match(state.url!, /^http:\/\/localhost:\d+/);
  assert.equal((await fetchText(state.url!)).body, 'key=none');
  assert.equal(previews.url('b1'), state.url);
  // Starting again while it runs returns the same preview.
  assert.equal((await previews.start('b1', { kind: 'script', command: 'node server.js', folder: root })).url, state.url);
  previews.stop('b1');
  assert.equal(previews.get('b1', null).status, 'stopped');
  assert.throws(() => previews.url('b1'), /not running/);
});

test('a dev server that exits or never answers is reported with its output', async (t) => {
  const { home: root, cleanup } = tempHome();
  t.after(cleanup);
  const previews = new Previews();
  t.after(() => previews.stopAll());
  const crashed = await previews.start('b1', { kind: 'script', command: 'node -e "console.error(\'Cannot find module vite\'); process.exit(1)"', folder: root });
  assert.equal(crashed.status, 'failed');
  assert.match(crashed.log, /Cannot find module vite/);
  const silent = await previews.start('b2', { kind: 'script', command: 'node -e "setTimeout(() => {}, 60000)"', folder: root }, { timeoutMs: 1_500 });
  assert.equal(silent.status, 'failed');
  assert.match(silent.log, /Nothing answered/);
});
