// Read-only snapshot of a repository for the assessment (M8: FR-PROJ-002, DEC-023).
//
// Everything is read from git's object store at one commit (`ls-tree`,
// `cat-file`), so the person's files, index and branches are never touched and
// nothing from the repository is executed. Uncommitted changes are counted and
// disclosed, not read.

import { spawn } from 'node:child_process';
import { git, GitError, NO_HOOKS } from '../build/git.ts';

export interface RepoFile {
  path: string;
  size: number;
}

export type Ecosystem = 'npm' | 'python' | 'go' | 'rust' | 'ruby' | 'php' | 'java' | 'dotnet';

export interface Dependency {
  name: string;
  ecosystem: Ecosystem;
  dev: boolean;
  /** The manifest it was declared in. */
  source: string;
}

export interface Skipped {
  reason: string;
  count: number;
  examples: string[];
}

export interface Snapshot {
  root: string;
  commit: string;
  branch: string | null;
  /** Lines of `git status --porcelain`: uncommitted changes, which are not inspected. */
  uncommitted: string[];
  /** Every file at the commit. */
  files: RepoFile[];
  /** Contents of the text files that were read, by path. */
  texts: Map<string, string>;
  bytesRead: number;
  dependencies: Dependency[];
  manifests: string[];
  /** Manifests that could not be parsed. */
  unreadableManifests: string[];
  submodules: string[];
  skipped: Skipped[];
}

export const LIMITS = { files: 6_000, fileBytes: 512_000, totalBytes: 48_000_000 };

/** Folders and files that are vendored, generated or lockfiles: listed, but never read as evidence. */
const VENDORED = /(^|\/)(node_modules|vendor|bower_components|\.next|\.nuxt|coverage|third_party|\.venv|venv|__pycache__)\/|^(dist|build|out|target)\//;
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|Pipfile\.lock|uv\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock|go\.sum|packages\.lock\.json)$/;
const MINIFIED = /\.min\.(js|css)$|\.map$/;
const BINARY = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|exe|dll|so|dylib|bin|o|a|class|wasm|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|wav|ogg|webm|sqlite3?|db|pptx?|docx?|xlsx?|key|onnx|pt|pth|safetensors|h5|pkl|npy)$/i;
const MANIFEST = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|go\.mod|Cargo\.toml|Gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?|[^/]+\.csproj)$/;

/** Reads the repository at `commit`. Throws GitError when git itself fails. */
export async function takeSnapshot(root: string, commit: string, branch: string | null): Promise<Snapshot> {
  const uncommitted = (await git(root, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal'])).split('\n').filter(Boolean);
  const tree = parseTree(await git(root, ['ls-tree', '-r', '-z', '--long', '--full-tree', commit]));

  const skipped = new Map<string, Skipped>();
  const skip = (reason: string, path: string) => {
    const s = skipped.get(reason) ?? { reason, count: 0, examples: [] };
    s.count++;
    if (s.examples.length < 3) s.examples.push(path);
    skipped.set(reason, s);
  };

  const files: RepoFile[] = [];
  const submodules: string[] = [];
  const candidates: { path: string; oid: string; size: number }[] = [];
  for (const entry of tree) {
    if (entry.type === 'commit') {
      submodules.push(entry.path);
      continue;
    }
    if (entry.type !== 'blob') continue;
    files.push({ path: entry.path, size: entry.size });
    if (entry.mode === '120000') skip('symbolic links (not followed)', entry.path);
    else if (VENDORED.test(entry.path)) skip('vendored or generated folders', entry.path);
    else if (LOCKFILE.test(entry.path)) skip('lockfiles (presence noted, contents not read)', entry.path);
    else if (MINIFIED.test(entry.path) || BINARY.test(entry.path)) skip('binary, minified or media files', entry.path);
    else if (entry.size > LIMITS.fileBytes) skip(`files larger than ${LIMITS.fileBytes / 1000} KB`, entry.path);
    else candidates.push(entry);
  }

  // Manifests and docs first, so a limit never hides the dependency list.
  candidates.sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
  const chosen: typeof candidates = [];
  let total = 0;
  for (const c of candidates) {
    if (chosen.length >= LIMITS.files || total + c.size > LIMITS.totalBytes) {
      skip('files beyond the reading limit', c.path);
      continue;
    }
    chosen.push(c);
    total += c.size;
  }

  const blobs = await readBlobs(root, chosen.map((c) => c.oid));
  const texts = new Map<string, string>();
  let bytesRead = 0;
  chosen.forEach((c, i) => {
    const buf = blobs[i];
    if (!buf) return skip('files git could not read', c.path);
    if (buf.includes(0)) return skip('binary, minified or media files', c.path);
    texts.set(c.path, buf.toString('utf8'));
    bytesRead += buf.length;
  });

  const { dependencies, manifests, unreadable } = parseManifests(texts);
  return { root, commit, branch, uncommitted, files, texts, bytesRead, dependencies, manifests, unreadableManifests: unreadable, submodules, skipped: [...skipped.values()] };
}

function rank(path: string): number {
  if (MANIFEST.test(path)) return 0;
  if (!path.includes('/')) return 1;
  return 2 + path.split('/').length;
}

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  size: number;
  path: string;
}

/** Parses `git ls-tree -r -z --long`. Exported for tests. */
export function parseTree(out: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of out.split('\0')) {
    const m = /^(\d+) (\w+) ([0-9a-f]+) +(-|\d+)\t(.+)$/s.exec(record);
    if (!m) continue;
    entries.push({ mode: m[1]!, type: m[2]!, oid: m[3]!, size: m[4] === '-' ? 0 : Number(m[4]), path: m[5]! });
  }
  return entries;
}

/** Reads blobs by object id through one `git cat-file --batch` process. Missing objects come back as null. */
function readBlobs(root: string, oids: string[]): Promise<(Buffer | null)[]> {
  if (!oids.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', `core.hooksPath=${NO_HOOKS}`, 'cat-file', '--batch'], { cwd: root, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const chunks: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new GitError('Git is not installed or not on PATH. Install Git for Windows and restart the app.') : e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new GitError(`git cat-file failed: ${stderr.trim().slice(0, 500) || `exit ${code}`}`));
      resolve(parseBatch(Buffer.concat(chunks), oids.length));
    });
    child.stdin.end(oids.join('\n') + '\n');
  });
}

/** Splits `git cat-file --batch` output into one buffer per requested object. */
function parseBatch(out: Buffer, count: number): (Buffer | null)[] {
  const result: (Buffer | null)[] = [];
  let at = 0;
  while (result.length < count && at < out.length) {
    const nl = out.indexOf(10, at);
    if (nl < 0) break;
    const header = out.subarray(at, nl).toString();
    at = nl + 1;
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (!m) {
      result.push(null); // "<oid> missing"
      continue;
    }
    const size = Number(m[2]);
    result.push(m[1] === 'blob' ? out.subarray(at, at + size) : null);
    at += size + 1;
  }
  while (result.length < count) result.push(null);
  return result;
}

// ---- Manifests ----------------------------------------------------------------

function parseManifests(texts: Map<string, string>): { dependencies: Dependency[]; manifests: string[]; unreadable: string[] } {
  const dependencies: Dependency[] = [];
  const manifests: string[] = [];
  const unreadable: string[] = [];
  const add = (source: string, ecosystem: Ecosystem, dev: boolean, names: Iterable<string>) => {
    for (const raw of names) {
      const name = ecosystem === 'python' ? raw.toLowerCase().replace(/_/g, '-') : raw;
      if (name && !dependencies.some((d) => d.name === name && d.source === source)) dependencies.push({ name, ecosystem, dev, source });
    }
  };
  for (const [path, text] of texts) {
    if (!MANIFEST.test(path)) continue;
    manifests.push(path);
    const file = path.split('/').pop()!;
    try {
      if (file === 'package.json') {
        const pkg = JSON.parse(text) as Record<string, unknown>;
        add(path, 'npm', false, keys(pkg.dependencies));
        add(path, 'npm', false, keys(pkg.optionalDependencies));
        add(path, 'npm', true, keys(pkg.devDependencies));
        add(path, 'npm', true, keys(pkg.peerDependencies));
      } else if (file === 'composer.json') {
        const pkg = JSON.parse(text) as Record<string, unknown>;
        add(path, 'php', false, keys(pkg.require).filter((n) => n.includes('/')));
        add(path, 'php', true, keys(pkg['require-dev']).filter((n) => n.includes('/')));
      } else if (file.startsWith('requirements')) {
        add(path, 'python', /dev|test/i.test(file), lineNames(text, /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/));
      } else if (file === 'pyproject.toml' || file === 'Pipfile') {
        add(path, 'python', false, pythonToml(text));
      } else if (file === 'go.mod') {
        add(path, 'go', false, lineNames(text, /^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v\d/));
      } else if (file === 'Cargo.toml') {
        add(path, 'rust', false, tomlSectionKeys(text, /^\[(dependencies|dev-dependencies|build-dependencies)\]$/));
      } else if (file === 'Gemfile') {
        add(path, 'ruby', false, lineNames(text, /^\s*gem\s+['"]([^'"]+)['"]/));
      } else if (file === 'pom.xml') {
        add(path, 'java', false, [...text.matchAll(/<dependency>[\s\S]*?<artifactId>([^<]+)<\/artifactId>/g)].map((m) => m[1]!.trim()));
      } else if (file.startsWith('build.gradle')) {
        add(path, 'java', false, [...text.matchAll(/(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\s*\(?\s*['"][^:'"]+:([^:'"]+)/g)].map((m) => m[1]!));
      } else if (file.endsWith('.csproj')) {
        add(path, 'dotnet', false, [...text.matchAll(/<PackageReference\s+Include="([^"]+)"/g)].map((m) => m[1]!));
      }
    } catch {
      unreadable.push(path);
    }
  }
  return { dependencies, manifests, unreadable };
}

function keys(v: unknown): string[] {
  return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [];
}

function lineNames(text: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#|\/\/|-)/.test(line)) continue;
    const m = pattern.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

function tomlSectionKeys(text: string, section: RegExp): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('[')) {
      inside = section.test(t);
      continue;
    }
    const m = inside ? /^([A-Za-z0-9_.-]+)\s*=/.exec(t) : null;
    if (m) out.push(m[1]!);
  }
  return out;
}

/** PEP 621 `dependencies = [...]` arrays, Poetry dependency tables and Pipfile packages. */
function pythonToml(text: string): string[] {
  const names: string[] = [];
  // Arrays named "dependencies", and every array under the optional-dependency / dependency-group tables.
  let section = '';
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t.startsWith('[') && !t.includes('=')) {
      section = t;
      continue;
    }
    const grouped = section === '[project.optional-dependencies]' || section === '[dependency-groups]';
    if (!(grouped ? /^[A-Za-z0-9_-]+\s*=\s*\[/ : /^dependencies\s*=\s*\[/).test(t)) continue;
    let body = t.slice(t.indexOf('[') + 1);
    while (!body.includes(']') && i + 1 < lines.length) body += '\n' + lines[++i]!;
    for (const s of body.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)/g)) names.push(s[1]!);
  }
  names.push(...tomlSectionKeys(text, /^\[(tool\.poetry\.(dev-)?dependencies|tool\.poetry\.group\.[^\]]+\.dependencies|packages|dev-packages)\]$/).filter((n) => n.toLowerCase() !== 'python'));
  return names;
}
