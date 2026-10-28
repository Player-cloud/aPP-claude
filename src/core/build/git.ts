// Git access for the build workflows (M6, DEC-005). Every feature or bug fix
// works in its own worktree on its own branch, so the person's checkout is
// never touched. Git is run directly (no shell) and only with the fixed
// arguments below; nothing here pushes, merges, resets or deletes a branch.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { IapError, ValidationError } from '../errors.ts';

export class GitError extends IapError {
  constructor(message: string) {
    super('GIT', message);
  }
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  added: number;
  removed: number;
}

export interface Diff {
  files: ChangedFile[];
  /** Unified diff, capped at MAX_PATCH characters. */
  patch: string;
  truncated: boolean;
}

const MAX_PATCH = 200_000;
const TIMEOUT_MS = 60_000;

/** A hooks folder that never exists, so the repository's own hooks (untrusted code) never run. */
const NO_HOOKS = process.platform === 'win32' ? 'NUL' : '/dev/null';

/** Runs git with fixed arguments. Hooks and pagers are off. */
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'core.pager=cat', '-c', 'color.ui=false', ...args],
      { cwd, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reject(new GitError('Git is not installed or not on PATH. Install Git for Windows and restart the app.'));
        reject(new GitError(`git ${args[0]} failed: ${(stderr || error.message).trim().slice(0, 1_000)}`));
      },
    );
  });
}

/** The repository's top folder and current commit. Refuses folders that are not a git repository with at least one commit. */
export async function inspectRepo(path: string): Promise<{ root: string; head: string; branch: string | null; clean: boolean }> {
  if (!existsSync(path)) throw new ValidationError(`The folder ${path} does not exist.`);
  let root: string;
  try {
    root = (await git(path, ['rev-parse', '--show-toplevel'])).trim();
  } catch (e) {
    if (e instanceof GitError && /not installed/.test(e.message)) throw e;
    throw new ValidationError(`${path} is not a git repository. Run "git init" and make a first commit there, or choose another folder.`);
  }
  let head: string;
  try {
    head = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  } catch {
    throw new ValidationError(`${root} has no commits yet. Make a first commit, then try again.`);
  }
  const branch = (await git(root, ['branch', '--show-current'])).trim() || null;
  const clean = (await git(root, ['status', '--porcelain'])).trim() === '';
  return { root, head, branch, clean };
}

/** Creates `branch` at `base` and checks it out in a new worktree at `path`. */
export async function addWorktree(repo: string, path: string, branch: string, base: string): Promise<void> {
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(branch) || branch.includes('..')) throw new ValidationError(`"${branch}" is not a safe branch name.`);
  if (!/^[0-9a-f]{40,64}$/.test(base)) throw new ValidationError('The base must be a full commit hash.');
  await git(repo, ['worktree', 'add', '-b', branch, path, base]);
}

/** Everything that differs between `base` and the worktree, including new untracked files. */
export async function diffWorktree(worktree: string, base: string): Promise<Diff> {
  // Intent-to-add makes new files show up in the diff without staging their content.
  const untracked = (await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  if (untracked.length) await git(worktree, ['add', '--intent-to-add', '--', ...untracked]);
  const numstat = await git(worktree, ['diff', '--numstat', '-z', '-M', base]);
  const names = await git(worktree, ['diff', '--name-status', '-z', '-M', base]);
  const files = parseChanges(names, numstat);
  const full = await git(worktree, ['diff', '-M', base]);
  return { files, patch: full.slice(0, MAX_PATCH), truncated: full.length > MAX_PATCH };
}

/** Parses `--name-status -z` and `--numstat -z` output into one list. Exported for tests. */
export function parseChanges(nameStatus: string, numstat: string): ChangedFile[] {
  const counts = new Map<string, { added: number; removed: number }>();
  const n = numstat.split('\0');
  for (let i = 0; i < n.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(n[i]!);
    if (!m) continue;
    let path = m[3]!;
    // A rename is "added\tremoved\t" followed by the old and new paths as separate fields.
    if (path === '') {
      path = n[i + 2] ?? '';
      i += 2;
    }
    counts.set(path, { added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]) });
  }
  const files: ChangedFile[] = [];
  const s = nameStatus.split('\0');
  for (let i = 0; i < s.length; i++) {
    const code = s[i]!;
    if (!code) continue;
    if (code.startsWith('R')) {
      const path = s[i + 2]!;
      files.push({ path, status: 'renamed', ...(counts.get(path) ?? { added: 0, removed: 0 }) });
      i += 2;
      continue;
    }
    const path = s[++i]!;
    const status = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
    files.push({ path, status, ...(counts.get(path) ?? { added: 0, removed: 0 }) });
  }
  return files;
}

/** A worktree at `commit` with no branch, for checking a release candidate (M7). */
export async function addDetachedWorktree(repo: string, path: string, commit: string): Promise<void> {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new ValidationError('The commit must be a full commit hash.');
  await git(repo, ['worktree', 'add', '--detach', path, commit]);
}

/** Moves an app-owned detached worktree to `commit`, discarding what earlier checks left behind (ignored files such as node_modules are kept). */
export async function resetDetachedWorktree(worktree: string, commit: string): Promise<void> {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new ValidationError('The commit must be a full commit hash.');
  await git(worktree, ['checkout', '--quiet', '--force', '--detach', commit]);
  await git(worktree, ['clean', '-q', '-f', '-d']);
}

/** True when `commit` (or branch) is part of the history of `head`. */
export async function isAncestor(repo: string, commit: string, head: string): Promise<boolean> {
  try {
    await git(repo, ['merge-base', '--is-ancestor', commit, head]);
    return true;
  } catch (e) {
    if (e instanceof GitError && /not installed/.test(e.message)) throw e;
    return false;
  }
}

/** Files tracked at the worktree's commit. */
export async function trackedFiles(worktree: string): Promise<string[]> {
  return (await git(worktree, ['ls-files', '-z'])).split('\0').filter(Boolean);
}

/**
 * Commits everything in an app-owned worktree to its branch and returns the commit.
 * Returns the current commit when there is nothing to commit. Hooks never run.
 */
export async function commitWorktree(worktree: string, message: string): Promise<string> {
  await git(worktree, ['add', '-A']);
  const staged = (await git(worktree, ['diff', '--cached', '--name-only'])).trim();
  if (staged) {
    let identity: string[] = [];
    try {
      await git(worktree, ['config', 'user.email']);
    } catch {
      identity = ['-c', 'user.name=Iterative Platform', '-c', 'user.email=iap@localhost'];
    }
    await git(worktree, [...identity, 'commit', '--quiet', '--no-verify', '--no-gpg-sign', '-m', message]);
  }
  return (await git(worktree, ['rev-parse', 'HEAD'])).trim();
}
