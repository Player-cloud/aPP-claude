// The agent's file tools for the build workflows (M6, DEC-020). Every path
// comes from the model and is untrusted: it must be relative, stay inside the
// feature's worktree after symlinks are resolved, and never touch .git. The
// tools read and write plain files only; nothing here runs code.

import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redactString } from '../redact.ts';

export class ToolInputError extends Error {}

const MAX_READ = 100_000;
const MAX_WRITE = 500_000;
const MAX_LIST = 500;
const MAX_MATCHES = 200;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', 'target', '.next']);

/** Resolves a model-supplied path inside `root`, refusing anything that could escape it. */
export function confine(root: string, path: unknown): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 500 || path.includes('\0')) throw new ToolInputError('path must be a non-empty relative path.');
  const cleaned = path.replace(/\\/g, '/');
  if (isAbsolute(path) || /^[A-Za-z]:/.test(cleaned) || cleaned.startsWith('/')) throw new ToolInputError(`"${path}" is absolute. Use a path relative to the repository root.`);
  const realRoot = realpathSync(root);
  const target = resolve(realRoot, cleaned);
  const rel = relative(realRoot, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ToolInputError(`"${path}" is outside the repository.`);
  if (rel.split(sep).some((part) => part.toLowerCase() === '.git')) throw new ToolInputError('The .git folder is off limits.');
  // Follow the deepest existing ancestor through symlinks: it must still be inside the root.
  let existing = target;
  while (!exists(existing)) existing = dirname(existing);
  const real = realpathSync(existing);
  const realRel = relative(realRoot, real);
  if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw new ToolInputError(`"${path}" leads outside the repository through a link.`);
  return target;
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

const toRel = (root: string, p: string) => relative(realpathSync(root), p).split(sep).join('/') || '.';

export function listFiles(root: string, path: unknown = '.'): string {
  const dir = confine(root, path === undefined || path === '' ? '.' : path);
  if (!exists(dir) || !statSync(dir).isDirectory()) throw new ToolInputError(`"${String(path)}" is not a folder.`);
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_LIST) return;
      if (entry.isSymbolicLink()) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        out.push(`${toRel(root, full)}/`);
        if (depth < 3) walk(full, depth + 1);
      } else if (entry.isFile()) out.push(toRel(root, full));
    }
  };
  walk(dir, 0);
  return out.length ? out.join('\n') + (out.length >= MAX_LIST ? `\n… (first ${MAX_LIST} entries)` : '') : '(empty)';
}

export function readFile(root: string, path: unknown): string {
  const file = confine(root, path);
  if (!exists(file) || !statSync(file).isFile()) throw new ToolInputError(`"${String(path)}" is not a file.`);
  const buf = readFileSync(file);
  if (buf.subarray(0, 8_000).includes(0)) throw new ToolInputError(`"${String(path)}" is a binary file.`);
  const text = buf.toString('utf8');
  return redactString(text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n… (cut at ${MAX_READ} characters of ${text.length})` : text);
}

export function writeFile(root: string, path: unknown, content: unknown): string {
  if (typeof content !== 'string') throw new ToolInputError('content must be text.');
  if (content.length > MAX_WRITE) throw new ToolInputError(`content is longer than ${MAX_WRITE} characters.`);
  const file = confine(root, path);
  if (exists(file) && !statSync(file).isFile()) throw new ToolInputError(`"${String(path)}" is a folder.`);
  const existed = exists(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return `${existed ? 'Updated' : 'Created'} ${toRel(root, file)} (${content.length} characters).`;
}

export function searchFiles(root: string, pattern: unknown, path: unknown = '.'): string {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 200) throw new ToolInputError('pattern must be 1 to 200 characters.');
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    throw new ToolInputError('pattern is not a valid regular expression.');
  }
  const start = confine(root, path === undefined || path === '' ? '.' : path);
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (hits.length >= MAX_MATCHES || entry.isSymbolicLink()) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile() || statSync(full).size > 1_000_000) continue;
      const buf = readFileSync(full);
      if (buf.subarray(0, 8_000).includes(0)) continue;
      buf
        .toString('utf8')
        .split('\n')
        .forEach((line, i) => {
          // Long lines are cut before matching, which limits how slow a bad pattern can be.
          if (hits.length < MAX_MATCHES && re.test(line.slice(0, 2_000))) hits.push(`${toRel(root, full)}:${i + 1}: ${line.slice(0, 300)}`);
        });
    }
  };
  if (statSync(start).isDirectory()) walk(start);
  return hits.length ? redactString(hits.join('\n')) : 'No matches.';
}
