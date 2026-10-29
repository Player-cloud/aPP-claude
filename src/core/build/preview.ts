// Live preview of what a task is building (M16 H, DEC-033). The project's own
// dev server runs in the task's worktree, or, for a plain web page, a small
// static server in the app; the desktop app then shows the page beside the
// report. The dev server is a command from the repository's own files, so the
// person approves it in the native dialog first, like a check. It gets the
// same environment as a check (no keys), listens on a free local port, and is
// stopped with the task, the app, or a click.

import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer as createHttpServer, request, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { ValidationError } from '../errors.ts';
import { redactString } from '../redact.ts';
import { checkEnv } from './checks.ts';

export type PreviewKind = 'script' | 'static';

export interface PreviewPlan {
  kind: PreviewKind;
  /** The command for a dev server, or the folder served for a static page. */
  command: string | null;
  folder: string;
}

export interface PreviewState {
  /** What would run, or null when the repository has nothing to preview. */
  plan: PreviewPlan | null;
  status: 'idle' | 'starting' | 'running' | 'stopped' | 'failed';
  url: string | null;
  /** The end of the dev server's output, redacted. */
  log: string;
}

const LOG_MAX = 8_000;
const START_TIMEOUT_MS = 90_000;
const LOCAL_ONLY = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{2,5}(?:\/|$)/;
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\b[^\s'"]*/;

/** What can be previewed in a repository: a dev script first, then a static index.html. */
export function detectPreview(root: string): PreviewPlan | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    const scripts = pkg.scripts ?? {};
    const lock = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : 'npm';
    for (const name of ['dev', 'start', 'preview', 'serve']) {
      if (typeof scripts[name] === 'string' && (scripts[name] as string).trim()) {
        return { kind: 'script', command: name === 'start' && lock === 'npm' ? 'npm start' : `${lock} run ${name}`, folder: root };
      }
    }
  } catch {
    /* no package.json */
  }
  for (const dir of ['', 'public', 'site', 'docs', 'dist']) {
    if (existsSync(join(root, dir, 'index.html'))) return { kind: 'static', command: null, folder: join(root, dir) };
  }
  return null;
}

/** A free TCP port on this machine. */
export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createNetServer();
    s.unref();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

/** True once something answers HTTP on the address. */
function answers(url: string): Promise<boolean> {
  const u = new URL(url);
  return new Promise((ok) => {
    const req = request({ host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port), path: '/', method: 'GET', timeout: 1_500 }, (res) => {
      res.resume();
      ok(true);
    });
    req.on('error', () => ok(false));
    req.on('timeout', () => {
      req.destroy();
      ok(false);
    });
    req.end();
  });
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Serves one folder read-only on 127.0.0.1. Paths cannot leave the folder. */
export function serveStatic(folder: string, port: number): Promise<Server> {
  const root = resolve(folder);
  const server = createHttpServer((req, res) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = resolve(root, normalize(`.${sep}${path}`));
    const rel = relative(root, file);
    if (rel.startsWith('..') || rel.split(sep).includes('.git')) {
      res.writeHead(404).end();
      return;
    }
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      statSync(file);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok, fail) => {
    server.on('error', fail);
    server.listen(port, '127.0.0.1', () => ok(server));
  });
}

interface Running {
  state: PreviewState;
  child: ChildProcess | null;
  server: Server | null;
}

/** The previews that are running, one per task. */
export class Previews {
  private readonly runs = new Map<string, Running>();

  get(buildId: string, plan: PreviewPlan | null): PreviewState {
    const r = this.runs.get(buildId);
    return r ? { ...r.state } : { plan, status: 'idle', url: null, log: '' };
  }

  /** Starts the preview and waits until it answers, fails, or times out. */
  async start(buildId: string, plan: PreviewPlan, opts: { timeoutMs?: number } = {}): Promise<PreviewState> {
    const existing = this.runs.get(buildId);
    if (existing && (existing.state.status === 'running' || existing.state.status === 'starting')) return { ...existing.state };
    const port = await freePort();
    const run: Running = { state: { plan, status: 'starting', url: null, log: '' }, child: null, server: null };
    this.runs.set(buildId, run);
    if (plan.kind === 'static') {
      run.server = await serveStatic(plan.folder, port);
      run.state = { ...run.state, status: 'running', url: `http://127.0.0.1:${port}/` };
      return { ...run.state };
    }
    const env = { ...checkEnv(), PORT: String(port), BROWSER: 'none', HOST: '127.0.0.1', CI: '' };
    let child: ChildProcess;
    try {
      child = spawn(plan.command!, { cwd: plan.folder, shell: true, env, windowsHide: true, detached: process.platform !== 'win32' });
    } catch (e) {
      run.state = { ...run.state, status: 'failed', log: `Could not start: ${(e as Error).message}` };
      return { ...run.state };
    }
    run.child = child;
    let found: string | null = null;
    const keep = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      run.state.log = redactString((run.state.log + text).slice(-LOG_MAX));
      // eslint-disable-next-line no-control-regex
      const m = LOCAL_URL.exec(text.replace(/\x1b\[[0-9;]*m/g, ''));
      if (m && !found) found = m[0].replace('0.0.0.0', '127.0.0.1');
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (e) => {
      run.state = { ...run.state, status: 'failed', log: `${run.state.log}\nCould not start: ${e.message}` };
    });
    child.on('close', (code) => {
      if (run.state.status === 'starting' || run.state.status === 'running') {
        run.state = { ...run.state, status: run.state.status === 'starting' ? 'failed' : 'stopped', log: `${run.state.log}\nThe dev server stopped (exit code ${code ?? '?'}).` };
      }
    });
    const deadline = Date.now() + (opts.timeoutMs ?? START_TIMEOUT_MS);
    while (Date.now() < deadline && run.state.status === 'starting') {
      const candidate = found ?? `http://127.0.0.1:${port}/`;
      if (await answers(candidate)) {
        run.state = { ...run.state, status: 'running', url: candidate };
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (run.state.status === 'starting') {
      this.kill(run);
      run.state = { ...run.state, status: 'failed', log: `${run.state.log}\nNothing answered within ${Math.round((opts.timeoutMs ?? START_TIMEOUT_MS) / 1000)} s.` };
    }
    return { ...run.state };
  }

  stop(buildId: string): boolean {
    const run = this.runs.get(buildId);
    if (!run) return false;
    this.kill(run);
    run.state = { ...run.state, status: 'stopped', url: null };
    return true;
  }

  stopAll(): void {
    for (const id of [...this.runs.keys()]) this.stop(id);
  }

  /** The address of a running preview, for opening in the browser. Only ever a local http address. */
  url(buildId: string): string {
    const url = this.runs.get(buildId)?.state.url;
    if (!url || !LOCAL_ONLY.test(url)) throw new ValidationError('The preview is not running.');
    return url;
  }

  private kill(run: Running): void {
    run.server?.close();
    run.server = null;
    const pid = run.child?.pid;
    run.child = null;
    if (pid === undefined) return;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      else process.kill(-pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}
