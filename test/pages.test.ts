import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { capturePages, findRoutes, MAX_ROUTES, routeSlug } from '../src/core/build/pages.ts';

function repo(t: test.TestContext, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'iap-pages-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test('M18-6: a static site lists its HTML pages, home first', (t) => {
  const root = repo(t, { 'index.html': '', 'members.html': '', 'rota/index.html': '', 'node_modules/x/index.html': '', 'style.css': '' });
  assert.deepEqual(findRoutes({ kind: 'static', command: null, folder: root }, root), ['/', '/members.html', '/rota']);
});

test('M18-6: an app lists file routes and route paths from its code, without parameters, capped', (t) => {
  const root = repo(t, {
    'package.json': '{}',
    'pages/index.tsx': '',
    'pages/about.tsx': '',
    'pages/_app.tsx': '',
    'pages/api/hello.ts': '',
    'src/app/(shop)/cart/page.tsx': '',
    'src/app/blog/[slug]/page.tsx': '',
    'src/routes.tsx': `<Route path="/members" /> <Route path="/members/:id" /> const r = [{ path: '/rota' }];`,
  });
  assert.deepEqual(findRoutes({ kind: 'script', command: 'npm run dev', folder: root }, root), ['/', '/about', '/cart', '/members', '/rota']);
  const many = repo(t, Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`pages/p${String(i).padStart(2, '0')}.tsx`, ''])));
  assert.equal(findRoutes({ kind: 'script', command: 'npm run dev', folder: many }, many).length, MAX_ROUTES);
});

test('M18-6: route names are safe file names', () => {
  assert.equal(routeSlug('/'), 'home');
  assert.equal(routeSlug('/members/list'), 'members-list');
  assert.equal(routeSlug('/members.html'), 'members');
});

test('M18-6: each page is captured at desktop and phone width, before and after, and compared', async () => {
  const saved: string[] = [];
  const png = (s: string) => Buffer.from(s);
  const set = await capturePages({
    buildId: 'b1',
    routes: ['/', '/members'],
    after: 'http://127.0.0.1:5000/',
    before: { url: 'http://127.0.0.1:5001/', note: null },
    // The members page is new; the home page changed on desktop only.
    status: async (url) => (url === 'http://127.0.0.1:5001/members' ? 404 : 200),
    capture: async (url, size) => png(url.includes(':5000/') && size.width === 1280 && !url.endsWith('members') ? 'new home' : url.endsWith('members') ? 'members' : `home ${size.width}`),
    save: (name) => saved.push(name),
    now: () => new Date('2026-10-29T06:00:00Z'),
  });
  assert.equal(set.capturedAt, '2026-10-29T06:00:00.000Z');
  assert.equal(set.beforeNote, null);
  assert.deepEqual(set.routes[0], {
    route: '/',
    shots: {
      desktop: { before: 'home-desktop-before.png', after: 'home-desktop-after.png', changed: true },
      phone: { before: 'home-phone-before.png', after: 'home-phone-after.png', changed: false },
    },
  });
  assert.deepEqual(set.routes[1]!.shots.phone, { before: null, after: 'members-phone-after.png', changed: null, note: 'This page did not exist before the change.' });
  assert.equal(saved.length, 6);
});

test('M18-6: with no earlier version, only "after" pictures are taken and the reason is kept', async () => {
  const set = await capturePages({
    buildId: 'b1',
    routes: ['/'],
    after: 'http://127.0.0.1:5000/',
    before: { url: null, note: 'Before this change there was nothing to preview.' },
    status: async () => 200,
    capture: async () => {
      throw new Error('The preview took too long to load.');
    },
    save: () => undefined,
  });
  assert.equal(set.beforeNote, 'Before this change there was nothing to preview.');
  assert.deepEqual(set.routes[0]!.shots.desktop, { before: null, after: null, changed: null, note: 'The preview took too long to load.' });
});
