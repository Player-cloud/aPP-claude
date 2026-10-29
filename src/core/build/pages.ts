// Pages (M18 part 6, DEC-036): pictures of a task's pages at desktop and
// phone width, before and after the change. "After" is the task's own
// preview; "before" is the same kind of preview run in a second, detached
// worktree at the task's base commit, so the person's checkout is never
// touched. Routes come from the project's files: the HTML pages of a static
// site, or the file-based routes and route paths of an app. Each picture is a
// real capture; a page that did not exist before has no "before" picture.

import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { request } from 'node:http';
import { join, relative, sep } from 'node:path';
import type { PreviewPlan } from './preview.ts';

export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
} as const;
export type Viewport = keyof typeof VIEWPORTS;
export const MAX_ROUTES = 8;

export interface PageShot {
  /** File name in the task's pages folder, or null when there is no picture. */
  before: string | null;
  after: string | null;
  /** Whether the two pictures differ; null when one is missing. */
  changed: boolean | null;
  /** Why a picture is missing, in plain words. */
  note?: string;
}

export interface PageRoute {
  route: string;
  shots: Record<Viewport, PageShot>;
}

export interface PageSet {
  buildId: string;
  capturedAt: string;
  routes: PageRoute[];
  /** Why there are no "before" pictures at all, if so. */
  beforeNote: string | null;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', 'vendor']);

function walk(dir: string, depth: number, out: string[], limit = 400) {
  if (depth < 0 || out.length >= limit) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, depth - 1, out, limit);
    else out.push(p);
    if (out.length >= limit) return;
  }
}

const posix = (p: string) => p.split(sep).join('/');
const ROUTE_LITERAL = /\bpath\s*[:=]\s*\{?\s*['"`](\/[A-Za-z0-9/_-]*)['"`]/g;

/** The pages worth a picture, "/" first, at most MAX_ROUTES. */
export function findRoutes(plan: PreviewPlan, repoRoot: string): string[] {
  const routes = new Set<string>(['/']);
  const add = (r: string) => {
    if (routes.size >= MAX_ROUTES) return;
    const clean = `/${r.replace(/^\/+|\/+$/g, '')}`.replace(/\/{2,}/g, '/');
    if (!/[[\]:*()]/.test(clean)) routes.add(clean === '/index' ? '/' : clean);
  };
  if (plan.kind === 'static') {
    const files: string[] = [];
    walk(plan.folder, 3, files);
    for (const f of files.filter((f) => f.endsWith('.html'))) {
      const rel = posix(relative(plan.folder, f));
      add(rel.endsWith('index.html') ? rel.slice(0, -'index.html'.length) : rel);
    }
    return [...routes];
  }
  // Next.js style file routes: pages/x.tsx and app/x/page.tsx (in src/ too).
  for (const base of ['pages', 'src/pages', 'app', 'src/app']) {
    const dir = join(repoRoot, base);
    if (!existsSync(dir)) continue;
    const files: string[] = [];
    walk(dir, 4, files);
    for (const f of files) {
      const rel = posix(relative(dir, f));
      if (!/\.(t|j)sx?$|\.mdx?$|\.vue$|\.svelte$/.test(rel)) continue;
      if (base.endsWith('app')) {
        const m = /^(.*?)\/?page\.[a-z]+$/.exec(rel);
        if (m) add(m[1]!.split('/').filter((s) => !/^\(.*\)$/.test(s)).join('/'));
      } else if (!/^(_|api\/)/.test(rel)) add(rel.replace(/\.[a-z]+$/, '').replace(/(^|\/)index$/, ''));
    }
  }
  // Route paths written in the code, as React Router, Vue Router and others do.
  const src: string[] = [];
  walk(join(repoRoot, 'src'), 4, src);
  for (const f of src.filter((f) => /\.(t|j)sx?$|\.vue$/.test(f))) {
    let text: string;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(ROUTE_LITERAL)) add(m[1]!);
  }
  return [...routes];
}

/** A file-name-safe name for a route: "/" is "home", "/members/list" is "members-list". */
export function routeSlug(route: string): string {
  const s = route
    .replace(/\.html$/, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 60);
  return s || 'home';
}

/**
 * The copy of the code before the change has no installed packages, so a dev
 * server could not start there. It borrows the task's own node_modules
 * through a link (a junction on Windows, which needs no special rights).
 * The packages may be a little newer than the old code expects; they are
 * never changed, and the link is removed with `unsharePackages`.
 */
export function sharePackages(from: string, to: string): boolean {
  const source = join(from, 'node_modules');
  const link = join(to, 'node_modules');
  if (!existsSync(source) || existsSync(link)) return false;
  symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir');
  return true;
}

/** Removes only the link, never what it points to, so removing the copy cannot reach the task's packages. */
export function unsharePackages(dir: string): void {
  const link = join(dir, 'node_modules');
  let st;
  try {
    st = lstatSync(link);
  } catch {
    return;
  }
  if (!st.isSymbolicLink()) return;
  try {
    unlinkSync(link);
  } catch {
    rmdirSync(link);
  }
}

/** The HTTP status a local page answers with, or 0 when nothing answers. */
export function pageStatus(url: string): Promise<number> {
  const u = new URL(url);
  return new Promise((ok) => {
    const req = request({ host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port), path: u.pathname + u.search, method: 'GET', timeout: 10_000 }, (res) => {
      res.resume();
      ok(res.statusCode ?? 0);
    });
    req.on('error', () => ok(0));
    req.on('timeout', () => {
      req.destroy();
      ok(0);
    });
    req.end();
  });
}

/**
 * Takes the pictures. `url` gives the running address for each side (null
 * when that side cannot be shown, with the reason), `capture` returns a PNG,
 * and `save` keeps it under the given name.
 */
export async function capturePages(input: {
  buildId: string;
  routes: string[];
  after: string;
  before: { url: string | null; note: string | null };
  capture: (url: string, size: { width: number; height: number }) => Promise<Buffer>;
  save: (name: string, png: Buffer) => void;
  /** Defaults to asking the page itself; a 404 means the page is not there. */
  status?: (url: string) => Promise<number>;
  now?: () => Date;
}): Promise<PageSet> {
  const status = input.status ?? pageStatus;
  const routes: PageRoute[] = [];
  for (const route of input.routes) {
    const shots = {} as Record<Viewport, PageShot>;
    for (const vp of Object.keys(VIEWPORTS) as Viewport[]) {
      const take = async (side: 'before' | 'after', base: string): Promise<{ name: string | null; png: Buffer | null; note?: string }> => {
        try {
          const url = new URL(route.replace(/^\//, ''), base).toString();
          const code = await status(url);
          if (code === 404 || code === 410) return { name: null, png: null, note: side === 'before' ? 'This page did not exist before the change.' : 'This page is not there (404).' };
          const png = await input.capture(url, VIEWPORTS[vp]);
          const name = `${routeSlug(route)}-${vp}-${side}.png`;
          input.save(name, png);
          return { name, png };
        } catch (e) {
          return { name: null, png: null, note: (e as Error).message };
        }
      };
      const after = await take('after', input.after);
      const before = input.before.url ? await take('before', input.before.url) : { name: null, png: null, note: input.before.note ?? undefined };
      const note = !after.name ? after.note : !before.name && input.before.url ? before.note : undefined;
      shots[vp] = { before: before.name, after: after.name, changed: before.png && after.png ? !before.png.equals(after.png) : null, ...(note ? { note } : {}) };
    }
    routes.push({ route, shots });
  }
  return { buildId: input.buildId, capturedAt: (input.now ?? (() => new Date()))().toISOString(), routes, beforeNote: input.before.url ? null : input.before.note };
}
