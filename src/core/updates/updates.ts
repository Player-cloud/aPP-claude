// External change monitor (M12: FR-ITER-004, roadmap Phase 9). It asks a fixed
// list of trusted sources what the newest versions of the app's own libraries,
// Claude Code, the Claude models and the installed plugins are, and records
// what it found. It never installs anything: an update moves from discovered
// (with a recommendation) to approved only when the person says so, to
// installed only when a later check sees the new version in place, and to
// verified only after the app's checks pass against it.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationError } from '../errors.ts';
import type { ToolEntry } from '../inventory.ts';
import { redactString } from '../redact.ts';
import type { ToolScan } from '../tools.ts';
import type { Workspace } from '../workspace.ts';
import { affectedWorkflows } from '../cleanup/cleanup.ts';

export const UPDATE_PRIORITIES = ['security', 'breaking', 'deprecation', 'improvement', 'info'] as const;
export type UpdatePriority = (typeof UPDATE_PRIORITIES)[number];
export const UPDATE_STAGES = ['recommended', 'approved', 'dismissed', 'installed', 'verified', 'failed', 'superseded'] as const;
export type UpdateStage = (typeof UPDATE_STAGES)[number];
export type UpdateKind = 'library' | 'runtime' | 'cli' | 'model' | 'plugin';
export type Confidence = 'high' | 'medium' | 'low';
export type SourceStatus = 'ok' | 'unreachable' | 'error' | 'not_checked';

/** What one source said during one check. Unreachable and unchecked sources are listed, never hidden. */
export interface SourceResult {
  id: string;
  name: string;
  url: string | null;
  status: SourceStatus;
  detail: string;
}

export interface UpdateImpact {
  workflows: string[];
  tests: string[];
}

export interface UpdateItem {
  id: string;
  number: number;
  /** Stable per tool and version (or advisory), so a repeated check updates the same item. */
  signature: string;
  toolKey: string;
  toolName: string;
  kind: UpdateKind;
  priority: UpdatePriority;
  confidence: Confidence;
  stage: UpdateStage;
  title: string;
  installedVersion: string | null;
  observedVersion: string | null;
  /** Lines quoted from release notes or advisories. External text: shown, never followed. */
  summary: string[];
  source: { name: string; url: string | null };
  impacts: UpdateImpact;
  recommendation: string;
  installSteps: string[];
  evaluation: string[];
  firstCheckId: string;
  lastCheckId: string;
  detectedAt: string;
  lastSeenAt: string;
  approval: { at: string; by: string; note: string | null } | null;
  dismissal: { at: string; by: string; reason: string } | null;
  installed: { at: string; version: string | null; evidence: string } | null;
  verification: { at: string; passed: boolean; evidence: string[] } | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateCheck {
  id: string;
  at: string;
  sources: SourceResult[];
  notChecked: string[];
  created: string[];
  updated: string[];
  installed: string[];
}

export interface UpdatesOverview {
  latest: UpdateCheck | null;
  items: UpdateItem[];
  /** Sources that failed in the latest check and have not answered in the last STALE_DAYS days (or ever). */
  stale: { id: string; name: string; lastOk: string | null }[];
  counts: Partial<Record<UpdateStage, number>>;
}

export type Fetcher = (url: string, init?: { method?: 'GET' | 'POST'; body?: string }) => Promise<{ status: number; text: string }>;

export interface ModelInfo {
  id: string;
  createdAt: string | null;
  name: string | null;
}

export interface MonitorInputs {
  fetcher: Fetcher;
  /** Exact versions of the libraries built into the app. */
  bundled: Record<string, string | null>;
  /** `claude --version`, or why it could not be read. */
  claudeVersion: () => Promise<{ version: string | null; error: string | null }>;
  /** Null when no API key is stored; nothing is sent then. */
  listModels: (() => Promise<ModelInfo[]>) | null;
  currentModel: string;
  /** Runs a fresh tool scan, for verification. */
  rescan: () => Omit<ToolScan, 'id' | 'scannedAt'>;
}

export const ALLOWED_HOSTS = ['registry.npmjs.org', 'raw.githubusercontent.com'] as const;
export const STALE_DAYS = 7;
const MAX_BODY = 3 * 1024 * 1024;
const MAX_MARKETPLACES = 10;
const MAX_SUMMARY = 15;
const PRIORITY_RANK: Record<UpdatePriority, number> = { security: 0, breaking: 1, deprecation: 2, improvement: 3, info: 4 };
const OPEN: ReadonlySet<UpdateStage> = new Set(['recommended', 'approved']);

/** Fetches from the allow-listed hosts only, over HTTPS, without following redirects. */
export function httpFetcher(timeoutMs = 15_000): Fetcher {
  return async (url, init = {}) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !(ALLOWED_HOSTS as readonly string[]).includes(u.hostname)) throw new ValidationError(`Not a trusted source: ${u.hostname}`);
    const res = await fetch(u, {
      method: init.method ?? 'GET',
      body: init.body,
      headers: init.body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json, text/plain' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (text.length > MAX_BODY) throw new Error(`The answer from ${u.hostname} was too large.`);
    return { status: res.status, text };
  };
}

/**
 * For tests only (IAP_UPDATE_FIXTURE): answers from a JSON file mapping URL prefixes to
 * { status, text }. The file is read on every call so a test can change the answers.
 * Anything not listed behaves like an unreachable host.
 */
export function fixtureFetcher(file: string): Fetcher {
  return async (url) => {
    const table = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { status?: number; text?: string; json?: unknown }>;
    const key = Object.keys(table)
      .filter((k) => url.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`getaddrinfo ENOTFOUND ${new URL(url).hostname} (test fixture)`);
    const a = table[key]!;
    return { status: a.status ?? 200, text: a.text ?? JSON.stringify(a.json ?? {}) };
  };
}

// ---- Versions -----------------------------------------------------------------

export function parseVersion(v: string | null | undefined): [number, number, number] | null {
  const m = v ? /(\d+)\.(\d+)\.(\d+)/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative, zero or positive; null when either version cannot be read. Pre-release tags are ignored. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** Semver: a new major (or a new minor below 1.0) may break callers. */
export function isMajorBump(from: string, to: string): boolean {
  const x = parseVersion(from);
  const y = parseVersion(to);
  if (!x || !y) return false;
  return y[0] > x[0] || (x[0] === 0 && y[0] === 0 && y[1] > x[1]);
}

declare const __IAP_BUNDLED__: string | undefined;

/** Versions of the libraries in this build: fixed by the bundler, or read from node_modules when run from source. */
export function bundledVersions(root = process.cwd()): Record<string, string | null> {
  if (typeof __IAP_BUNDLED__ === 'string') return JSON.parse(__IAP_BUNDLED__) as Record<string, string | null>;
  const out: Record<string, string | null> = {};
  for (const t of TRACKED) {
    if (!t.bundled || !t.package) continue;
    try {
      out[t.package] = String((JSON.parse(readFileSync(join(root, 'node_modules', t.package, 'package.json'), 'utf8')) as { version: string }).version);
    } catch {
      out[t.package] = null;
    }
  }
  return out;
}

// ---- What the app depends on -------------------------------------------------

interface Tracked {
  key: string;
  name: string;
  kind: UpdateKind;
  package?: string;
  /** Built into the app: it changes only with a new app release. */
  bundled: boolean;
  changelog?: string;
  releases: (version: string) => string;
  impacts: UpdateImpact;
  installSteps: (version: string) => string[];
  evaluation: string[];
}

const MODEL_WORKFLOWS = ['Main agent (when real Claude calls are on)', 'Planning drafts: brief and specification', 'Build Feature agent', 'Learning Studio suggestions'];
const APP_RELEASE = (pkg: string, v: string) => [
  `This library is built into the app, so it changes only in a new app release: set ${pkg} to ${v} in package.json on a separate branch.`,
  'Run npm run check and npm run test:e2e, and let CI build the Windows installer, before releasing.',
  'Install the new release. The next check here confirms the version.',
];
const APP_EVALUATION = ['Evaluate on a separate branch: the tests, the end-to-end suite and the installer build must pass before the change is merged. The running app is never changed in place.'];

export const TRACKED: Tracked[] = [
  {
    key: 'npm:@anthropic-ai/sdk',
    name: 'Anthropic SDK',
    kind: 'library',
    package: '@anthropic-ai/sdk',
    bundled: true,
    changelog: 'https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/CHANGELOG.md',
    releases: (v) => `https://github.com/anthropics/anthropic-sdk-typescript/releases/tag/sdk-v${v}`,
    impacts: { workflows: MODEL_WORKFLOWS, tests: ['test/claude.test.ts', 'test/orchestrator.test.ts', 'test/planning.test.ts', 'test/build.test.ts', 'test/studio.test.ts'] },
    installSteps: (v) => APP_RELEASE('@anthropic-ai/sdk', v),
    evaluation: APP_EVALUATION,
  },
  {
    key: 'npm:electron',
    name: 'Electron',
    kind: 'runtime',
    package: 'electron',
    bundled: true,
    releases: (v) => `https://github.com/electron/electron/releases/tag/v${v}`,
    impacts: { workflows: ['The whole desktop app: windows, dialogs, secure key storage and the installer'], tests: ['e2e/app.e2e.ts', 'CI installer job'] },
    installSteps: (v) => APP_RELEASE('electron', v),
    evaluation: APP_EVALUATION,
  },
  {
    key: 'npm:react',
    name: 'React',
    kind: 'library',
    package: 'react',
    bundled: true,
    releases: (v) => `https://github.com/facebook/react/releases/tag/v${v}`,
    impacts: { workflows: ['Every screen of the app'], tests: ['e2e/app.e2e.ts'] },
    installSteps: (v) => APP_RELEASE('react and react-dom', v),
    evaluation: APP_EVALUATION,
  },
  {
    key: 'npm:react-dom',
    name: 'React DOM',
    kind: 'library',
    package: 'react-dom',
    bundled: true,
    releases: (v) => `https://github.com/facebook/react/releases/tag/v${v}`,
    impacts: { workflows: ['Every screen of the app'], tests: ['e2e/app.e2e.ts'] },
    installSteps: (v) => APP_RELEASE('react and react-dom', v),
    evaluation: APP_EVALUATION,
  },
  {
    key: 'cli:claude-code',
    name: 'Claude Code',
    kind: 'cli',
    package: '@anthropic-ai/claude-code',
    bundled: false,
    changelog: 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md',
    releases: () => 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md',
    impacts: { workflows: ['Tools: the scan reads Claude Code’s settings and plugin files', 'Tool cleanup: runs claude plugin and claude mcp'], tests: ['test/inventory.test.ts', 'test/cleanup.test.ts'] },
    installSteps: (v) => [
      'Update it with Claude Code’s own updater: run claude update in a terminal. If you installed it with npm, run npm install -g @anthropic-ai/claude-code@' + v + ' instead.',
      'The app does not run either command.',
      'Then press Check for updates here; the app reads claude --version to confirm.',
    ],
    evaluation: ['Read the release notes above for changes to plugins, settings files or the claude plugin and claude mcp commands, which the Tools screen relies on.', 'After updating, press Verify: the app checks the version and runs a fresh tool scan.'],
  },
];

const MODELS_KEY = 'model:anthropic';

/** Workflows and tests that depend on the Claude model the app calls. */
export const MODEL_IMPACT: UpdateImpact = { workflows: MODEL_WORKFLOWS, tests: ['test/claude.test.ts'] };

/** Checks this monitor cannot do, reported so their absence is visible. */
export const UPDATES_NOT_CHECKED = [
  'MCP servers: none of them publish a version to a source the app trusts, so they are not checked.',
  'Skills, commands, subagents and hooks outside plugins have no version source.',
  'Release notes are only read for Claude Code and the Anthropic SDK; other entries link to their release pages.',
];

// ---- Release notes -------------------------------------------------------------

/** Bullet lines of the release-note sections newer than `from`, up to and including `to`. */
export function changelogBetween(text: string, from: string, to: string): { lines: string[]; total: number; versions: number } {
  const lines: string[] = [];
  let total = 0;
  let versions = 0;
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const head = /^##\s+\[?v?(\d+\.\d+\.\d+[^\]\s)]*)/.exec(raw);
    if (head) {
      const v = head[1]!;
      inside = (compareVersions(v, from) ?? 0) > 0 && (compareVersions(v, to) ?? 1) <= 0;
      if (inside) versions++;
      continue;
    }
    if (!inside) continue;
    const bullet = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (!bullet) continue;
    total++;
    if (lines.length < MAX_SUMMARY) lines.push(clean(bullet[1]!));
  }
  return { lines, total, versions };
}

function clean(s: string): string {
  // Markdown links become their text; control characters go; external text is length-capped.
  const t = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return redactString(t.length > 220 ? `${t.slice(0, 219)}…` : t);
}

/** What the release notes say, as a priority hint. Wording-based, so medium confidence at most. */
export function notesHint(lines: string[]): { priority: UpdatePriority; word: string } | null {
  const all = lines.join('\n');
  if (/\bsecurity\b|vulnerab|\bCVE-\d/i.test(all)) return { priority: 'security', word: 'security' };
  if (/\bbreaking\b|\bremoved\b|no longer supported/i.test(all)) return { priority: 'breaking', word: 'breaking or removed behaviour' };
  if (/deprecat/i.test(all)) return { priority: 'deprecation', word: 'deprecations' };
  return null;
}

// ---- One check -----------------------------------------------------------------

interface Observation {
  signature: string;
  toolKey: string;
  toolName: string;
  kind: UpdateKind;
  priority: UpdatePriority;
  confidence: Confidence;
  title: string;
  installedVersion: string | null;
  observedVersion: string | null;
  summary: string[];
  source: { name: string; url: string | null };
  impacts: UpdateImpact;
  recommendation: string;
  installSteps: string[];
  evaluation: string[];
}

interface Advisory {
  id: number | string;
  url?: string;
  title?: string;
  severity?: string;
  vulnerable_versions?: string;
}

const npmUrl = (pkg: string, what: string) => `https://registry.npmjs.org/${pkg.replace('/', '%2f')}/${what}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export class UpdateMonitor {
  private readonly ws: Workspace;
  private readonly inputs: MonitorInputs;

  constructor(ws: Workspace, inputs: MonitorInputs) {
    this.ws = ws;
    this.inputs = inputs;
  }

  /** Asks every trusted source once. Records what was found, and which sources did not answer. */
  async check(): Promise<UpdateCheck> {
    const { fetcher } = this.inputs;
    const sources: SourceResult[] = [];
    const found: Observation[] = [];
    /** The installed version this check actually read, per tool. Only these can mark an item installed. */
    const seen = new Map<string, string>();
    const advisoriesOk = new Set<string>();
    const advisoryHits = new Set<string>();

    const getJson = async (url: string, init?: Parameters<Fetcher>[1]): Promise<{ ok: true; value: unknown } | { ok: false; status: SourceStatus; detail: string }> => {
      try {
        const r = await fetcher(url, init);
        if (r.status === 404) return { ok: false, status: 'error', detail: 'Not found at the source (404).' };
        if (r.status < 200 || r.status >= 300) return { ok: false, status: 'error', detail: `The source answered ${r.status}.` };
        try {
          return { ok: true, value: JSON.parse(r.text) };
        } catch {
          return { ok: false, status: 'error', detail: 'The answer was not valid JSON.' };
        }
      } catch (e) {
        return { ok: false, status: 'unreachable', detail: errText(e) };
      }
    };
    const getText = async (url: string): Promise<string | null> => {
      try {
        const r = await fetcher(url);
        return r.status >= 200 && r.status < 300 ? r.text : null;
      } catch {
        return null;
      }
    };

    // 1. Installed versions.
    const installed = new Map<string, string | null>();
    for (const t of TRACKED) {
      if (t.bundled) installed.set(t.key, this.inputs.bundled[t.package!] ?? null);
    }
    const cc = await this.inputs.claudeVersion();
    installed.set('cli:claude-code', cc.version);

    // 2. Newest version and deprecation, per package.
    for (const t of TRACKED) {
      const have = installed.get(t.key) ?? null;
      const sourceId = `npm:${t.package}`;
      if (!have) {
        sources.push({ id: sourceId, name: `npm registry: ${t.package}`, url: null, status: 'not_checked', detail: t.kind === 'cli' ? cc.error ?? 'Claude Code’s version could not be read.' : 'The installed version is unknown.' });
        continue;
      }
      seen.set(t.key, have);
      const latest = await getJson(npmUrl(t.package!, 'latest'));
      if (!latest.ok) {
        sources.push({ id: sourceId, name: `npm registry: ${t.package}`, url: npmUrl(t.package!, 'latest'), status: latest.status, detail: latest.detail });
        continue;
      }
      const newest = typeof (latest.value as { version?: unknown }).version === 'string' ? (latest.value as { version: string }).version : null;
      if (!parseVersion(newest)) {
        sources.push({ id: sourceId, name: `npm registry: ${t.package}`, url: npmUrl(t.package!, 'latest'), status: 'error', detail: 'The answer had no version number.' });
        continue;
      }
      sources.push({ id: sourceId, name: `npm registry: ${t.package}`, url: npmUrl(t.package!, 'latest'), status: 'ok', detail: `Installed ${have}, newest ${newest}.` });

      const mine = await getJson(npmUrl(t.package!, have));
      const deprecated = mine.ok && typeof (mine.value as { deprecated?: unknown }).deprecated === 'string' ? clean((mine.value as { deprecated: string }).deprecated) : null;
      if (deprecated) {
        found.push({
          signature: `${t.key}#deprecated@${have}`,
          toolKey: t.key,
          toolName: t.name,
          kind: t.kind,
          priority: 'deprecation',
          confidence: 'high',
          title: `${t.name} ${have} is deprecated`,
          installedVersion: have,
          observedVersion: newest,
          summary: [`npm says: ${deprecated}`],
          source: { name: 'npm registry', url: npmUrl(t.package!, have) },
          impacts: t.impacts,
          recommendation: `Move off ${have}. The newest version is ${newest}.`,
          installSteps: t.installSteps(newest!),
          evaluation: t.evaluation,
        });
      }

      if ((compareVersions(newest, have) ?? 0) <= 0) continue;
      let summary: string[] = [`${t.name} ${have} → ${newest}. Release notes: ${t.releases(newest!)}`];
      let priority: UpdatePriority = isMajorBump(have, newest!) ? 'breaking' : 'improvement';
      let confidence: Confidence = 'high';
      let why = isMajorBump(have, newest!) ? 'The version number says this release may break existing use.' : 'A newer version is available.';
      if (t.changelog) {
        const text = await getText(t.changelog);
        if (text === null) {
          sources.push({ id: `notes:${t.key}`, name: `${t.name} release notes`, url: t.changelog, status: 'unreachable', detail: 'The release notes could not be read; the summary only has the version numbers.' });
        } else {
          const notes = changelogBetween(text, have, newest!);
          sources.push({ id: `notes:${t.key}`, name: `${t.name} release notes`, url: t.changelog, status: 'ok', detail: `${notes.versions} release${notes.versions === 1 ? '' : 's'} since ${have}.` });
          if (notes.lines.length) summary = [...notes.lines, ...(notes.total > notes.lines.length ? [`…and ${notes.total - notes.lines.length} more lines in the release notes.`] : [])];
          const hint = notesHint(notes.lines);
          if (hint && PRIORITY_RANK[hint.priority] < PRIORITY_RANK[priority]) {
            priority = hint.priority;
            confidence = 'medium';
            why = `The release notes mention ${hint.word}.`;
          }
        }
      }
      found.push({
        signature: `${t.key}@${newest}`,
        toolKey: t.key,
        toolName: t.name,
        kind: t.kind,
        priority,
        confidence,
        title: `${t.name} ${newest} is available`,
        installedVersion: have,
        observedVersion: newest,
        summary,
        source: { name: t.changelog ? `${t.name} release notes` : 'npm registry', url: t.changelog ?? npmUrl(t.package!, 'latest') },
        impacts: t.impacts,
        recommendation: `${why} Read the notes, evaluate it, then approve it if you want it. Nothing is installed automatically.`,
        installSteps: t.installSteps(newest!),
        evaluation: t.evaluation,
      });
    }

    // 3. Security advisories for the installed versions (the registry's audit endpoint).
    const query: Record<string, string[]> = {};
    for (const t of TRACKED) {
      const v = seen.get(t.key);
      if (v) query[t.package!] = [v];
    }
    if (Object.keys(query).length) {
      const url = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
      const r = await getJson(url, { method: 'POST', body: JSON.stringify(query) });
      if (!r.ok) {
        sources.push({ id: 'npm:advisories', name: 'npm security advisories', url, status: r.status, detail: `${r.detail} Security advisories were not checked.` });
      } else {
        const byPkg = (r.value && typeof r.value === 'object' ? r.value : {}) as Record<string, Advisory[]>;
        let n = 0;
        for (const t of TRACKED) {
          const v = seen.get(t.key);
          if (!v) continue;
          advisoriesOk.add(t.key);
          for (const a of Array.isArray(byPkg[t.package!]) ? byPkg[t.package!]! : []) {
            n++;
            const sig = `${t.key}#advisory:${String(a.id).slice(0, 40)}`;
            advisoryHits.add(sig);
            found.push({
              signature: sig,
              toolKey: t.key,
              toolName: t.name,
              kind: t.kind,
              priority: 'security',
              confidence: 'high',
              title: `${t.name} ${v}: ${clean(a.title ?? 'security advisory')}`,
              installedVersion: v,
              observedVersion: null,
              summary: [`Severity: ${clean(a.severity ?? 'unknown')}`, `Affected versions: ${clean(a.vulnerable_versions ?? 'unknown')}`, ...(a.url ? [`Advisory: ${clean(a.url)}`] : [])],
              source: { name: 'npm security advisories', url: a.url ? clean(a.url) : url },
              impacts: t.impacts,
              recommendation: `Update ${t.name} to a version outside "${clean(a.vulnerable_versions ?? 'the affected range')}". Check whether the app actually uses the affected part before treating it as urgent.`,
              installSteps: t.installSteps('a fixed version'),
              evaluation: t.evaluation,
            });
          }
        }
        sources.push({ id: 'npm:advisories', name: 'npm security advisories', url, status: 'ok', detail: n ? `${n} advisor${n === 1 ? 'y affects' : 'ies affect'} the installed versions.` : 'No advisories affect the installed versions.' });
      }
    }

    // 4. Claude models (needs the stored API key; listing models costs nothing).
    if (!this.inputs.listModels) {
      sources.push({ id: 'anthropic:models', name: 'Anthropic model list', url: null, status: 'not_checked', detail: 'No API key is stored, so the model list was not requested.' });
    } else {
      try {
        const models = await this.inputs.listModels();
        const current = this.inputs.currentModel;
        seen.set(MODELS_KEY, current);
        const mine = models.find((m) => m.id === current);
        sources.push({ id: 'anthropic:models', name: 'Anthropic model list', url: 'https://api.anthropic.com/v1/models', status: 'ok', detail: `${models.length} models listed; the app uses ${current}.` });
        if (!mine) {
          found.push({
            signature: `${MODELS_KEY}#missing@${current}`,
            toolKey: MODELS_KEY,
            toolName: 'Claude models',
            kind: 'model',
            priority: 'breaking',
            confidence: 'medium',
            title: `${current} is not in the model list`,
            installedVersion: current,
            observedVersion: null,
            summary: ['The model the app calls was not listed for this API key. It may be retired or not available to the account.'],
            source: { name: 'Anthropic model list', url: 'https://api.anthropic.com/v1/models' },
            impacts: MODEL_IMPACT,
            recommendation: 'Check the model in the Anthropic Console. Choosing another model is a code change that needs evaluation first.',
            installSteps: ['Changing the model is an app change: update CLAUDE_MODEL and its prices on a separate branch, run the evaluation tasks and the tests, then release.'],
            evaluation: ['Run representative tasks with the candidate model and compare completion, spec adherence, quality and cost (FR-ITER-005).'],
          });
        }
        const since = mine?.createdAt ? Date.parse(mine.createdAt) : NaN;
        for (const m of models) {
          if (m.id === current || !m.createdAt || Number.isNaN(since) || !(Date.parse(m.createdAt) > since) || !/^claude-/.test(m.id)) continue;
          found.push({
            signature: `${MODELS_KEY}@${m.id}`,
            toolKey: MODELS_KEY,
            toolName: 'Claude models',
            kind: 'model',
            priority: 'info',
            confidence: 'high',
            title: `Newer model available: ${clean(m.name ?? m.id)}`,
            installedVersion: current,
            observedVersion: clean(m.id),
            summary: [`${clean(m.id)} was released after ${current}.`],
            source: { name: 'Anthropic model list', url: 'https://api.anthropic.com/v1/models' },
            impacts: MODEL_IMPACT,
            recommendation: `Newer is not automatically better. The app keeps using ${current} until the new model is evaluated and the change is approved.`,
            installSteps: ['Switching models is an app change: update CLAUDE_MODEL and its prices on a separate branch, run the evaluation tasks and the tests, then release.'],
            evaluation: ['Run representative tasks with the new model and compare completion, spec adherence, tool use, quality, latency and cost (FR-ITER-005).'],
          });
        }
      } catch (e) {
        sources.push({ id: 'anthropic:models', name: 'Anthropic model list', url: 'https://api.anthropic.com/v1/models', status: 'unreachable', detail: errText(e) });
      }
    }

    // 5. Plugins, compared with what their GitHub-hosted marketplace declares.
    const scan = this.ws.latestToolScan();
    const notChecked = [...UPDATES_NOT_CHECKED];
    if (!scan) {
      sources.push({ id: 'plugins', name: 'Plugin marketplaces', url: null, status: 'not_checked', detail: 'There is no tool scan yet. Scan on the Tools screen first.' });
    } else {
      const plugins = scan.entries.filter((e) => e.kind === 'plugin');
      for (const p of plugins) if (p.version) seen.set(pluginKey(p), p.version);
      const markets = scan.entries.filter((e) => e.kind === 'marketplace');
      let unsupported = 0;
      let unversioned = 0;
      for (const [i, m] of markets.entries()) {
        const repo = githubRepo(m);
        const mine = plugins.filter((p) => p.details.marketplace === m.name);
        if (!repo) {
          unsupported++;
          continue;
        }
        const url = `https://raw.githubusercontent.com/${repo}/HEAD/.claude-plugin/marketplace.json`;
        if (i >= MAX_MARKETPLACES) {
          sources.push({ id: `market:${m.name}`, name: `Marketplace ${m.name}`, url, status: 'not_checked', detail: `Only the first ${MAX_MARKETPLACES} marketplaces are checked.` });
          continue;
        }
        if (!mine.length) continue;
        const r = await getJson(url);
        if (!r.ok) {
          sources.push({ id: `market:${m.name}`, name: `Marketplace ${m.name}`, url, status: r.status, detail: r.detail });
          continue;
        }
        const listed = Array.isArray((r.value as { plugins?: unknown }).plugins) ? ((r.value as { plugins: unknown[] }).plugins as Record<string, unknown>[]) : [];
        let compared = 0;
        for (const p of mine) {
          const short = p.name.includes('@') ? p.name.slice(0, p.name.lastIndexOf('@')) : p.name;
          const offer = listed.find((x) => x && x.name === short);
          const offered = offer && typeof offer.version === 'string' ? offer.version : null;
          if (!p.version || !parseVersion(p.version) || !parseVersion(offered)) {
            unversioned++;
            continue;
          }
          compared++;
          if ((compareVersions(offered, p.version) ?? 0) <= 0) continue;
          const owned = scan.entries.filter((e) => e.owner === p.name).map((e) => e.invocation ?? e.name);
          const scope = p.scope === 'user' || p.scope === 'project' || p.scope === 'local' ? ` --scope ${p.scope}` : '';
          found.push({
            signature: `${pluginKey(p)}@${offered}`,
            toolKey: pluginKey(p),
            toolName: `${p.name} (${p.scope})`,
            kind: 'plugin',
            priority: isMajorBump(p.version, offered!) ? 'breaking' : 'improvement',
            confidence: 'high',
            title: `${p.name} ${offered} is available (${p.scope} install)`,
            installedVersion: p.version,
            observedVersion: offered,
            summary: [`Installed ${p.version}; marketplace ${m.name} offers ${offered}.`, ...(typeof offer!.description === 'string' ? [clean(offer!.description as string)] : [])],
            source: { name: `Marketplace ${m.name}`, url },
            impacts: { workflows: [...affectedWorkflows(p), ...(owned.length ? [`Provides ${owned.slice(0, 8).join(', ')}${owned.length > 8 ? ', …' : ''}`] : [])], tests: [] },
            recommendation: isMajorBump(p.version, offered!) ? 'The version number says this release may change how the plugin behaves. Read its notes before updating.' : 'A newer version is available from its marketplace.',
            installSteps: [`Run claude plugin update ${p.name}${scope} in a terminal (Claude Code’s plugin manager). The app does not run it.`, 'Then scan again on the Tools screen and press Check for updates here.'],
            evaluation: ['After updating, press Verify: the app runs a fresh tool scan and checks the plugin’s version and its conflicts.'],
          });
        }
        sources.push({ id: `market:${m.name}`, name: `Marketplace ${m.name}`, url, status: 'ok', detail: `${compared} of ${mine.length} installed plugin${mine.length === 1 ? '' : 's'} compared.` });
      }
      if (unsupported) notChecked.push(`${unsupported} marketplace${unsupported === 1 ? ' is' : 's are'} not hosted on GitHub, so ${unsupported === 1 ? 'its' : 'their'} plugins were not checked.`);
      if (unversioned) notChecked.push(`${unversioned} plugin${unversioned === 1 ? '' : 's'} could not be compared because the installed copy or the marketplace declares no version. claude plugin update checks those itself.`);
    }

    return this.ws.inTransaction(() => this.save(sources, notChecked, found, seen, advisoriesOk, advisoryHits));
  }

  private save(sources: SourceResult[], notChecked: string[], found: Observation[], seen: Map<string, string>, advisoriesOk: Set<string>, advisoryHits: Set<string>): UpdateCheck {
    const ws = this.ws;
    const checkId = `chk_${randomUUID()}`;
    const at = ws.nowIso();
    const created: string[] = [];
    const updated: string[] = [];
    const installedIds: string[] = [];
    ws.createUpdateCheck({ id: checkId, at, sources, notChecked });

    for (const o of found) {
      const existing = ws.findUpdateBySignature(o.signature);
      if (existing) {
        if (OPEN.has(existing.stage)) {
          ws.touchUpdate(existing.id, checkId, { summary: o.summary, installedVersion: o.installedVersion });
          updated.push(existing.id);
        }
        continue;
      }
      const item = ws.createUpdate({ ...o, checkId });
      created.push(item.id);
      // A newer release replaces an older open one for the same tool.
      if (o.observedVersion && !o.signature.includes('#')) {
        for (const old of ws.listUpdates({ toolKey: o.toolKey })) {
          if (old.id === item.id || !OPEN.has(old.stage) || old.signature.includes('#')) continue;
          if ((compareVersions(old.observedVersion, o.observedVersion) ?? 1) < 0) {
            ws.updateUpdate(old.id, { stage: 'superseded' }, { type: 'update.superseded', payload: { by: item.id } });
          }
        }
      }
    }

    // Installed only on evidence: this check read a version at or past the one recommended,
    // or an advisory no longer applies to the version now installed.
    for (const item of ws.listUpdates({})) {
      if (!OPEN.has(item.stage)) continue;
      const now = seen.get(item.toolKey);
      if (!now) continue;
      let evidence: string | null = null;
      if (item.signature.includes('#advisory:')) {
        if (advisoriesOk.has(item.toolKey) && !advisoryHits.has(item.signature)) evidence = `The advisory no longer applies: ${item.toolName} ${now} is installed.`;
      } else if (item.signature.includes('#deprecated@')) {
        if (now !== item.installedVersion) evidence = `${item.toolName} ${now} is installed instead of the deprecated ${item.installedVersion}.`;
      } else if (item.signature.includes('#missing@')) {
        if (now !== item.installedVersion) evidence = `The app now uses ${now}.`;
      } else if (item.kind === 'model') {
        if (now === item.observedVersion) evidence = `The app now uses ${now}.`;
      } else if ((compareVersions(now, item.observedVersion) ?? -1) >= 0) {
        evidence = `${item.toolName} ${now} is installed.`;
      }
      if (!evidence) continue;
      ws.updateUpdate(item.id, { stage: 'installed', installed: { at, version: now, evidence } }, { type: 'update.installed', payload: { checkId, version: now } });
      installedIds.push(item.id);
    }

    ws.finishUpdateCheck(checkId, { created, updated, installed: installedIds });
    return ws.getUpdateCheck(checkId);
  }

  /** Records that the person wants this update. Nothing is installed: the item shows how to install it. */
  approve(id: string, note: string | null): UpdateItem {
    const item = this.ws.getUpdate(id);
    if (item.stage !== 'recommended') throw new ValidationError(`Only a recommended update can be approved; this one is ${item.stage}.`);
    return this.ws.updateUpdate(id, { stage: 'approved', approval: { at: this.ws.nowIso(), by: this.ws.actorName(), note: note?.trim() ? note.trim().slice(0, 2000) : null } }, { type: 'update.approved', payload: { note: note ?? null } });
  }

  dismiss(id: string, reason: string): UpdateItem {
    const item = this.ws.getUpdate(id);
    if (!OPEN.has(item.stage)) throw new ValidationError(`Only an open update can be dismissed; this one is ${item.stage}.`);
    if (!reason.trim()) throw new ValidationError('Say why this update is not wanted. The reason is kept in the audit log.');
    return this.ws.updateUpdate(id, { stage: 'dismissed', dismissal: { at: this.ws.nowIso(), by: this.ws.actorName(), reason: reason.trim().slice(0, 2000) } }, { type: 'update.dismissed', payload: { reason } });
  }

  reopen(id: string): UpdateItem {
    const item = this.ws.getUpdate(id);
    if (item.stage !== 'dismissed') throw new ValidationError(`Only a dismissed update can be reopened; this one is ${item.stage}.`);
    return this.ws.updateUpdate(id, { stage: 'recommended', dismissal: null }, { type: 'update.reopened', payload: {} });
  }

  /** Runs the app's own checks against an installed update and records the evidence. */
  async verify(id: string): Promise<UpdateItem> {
    const item = this.ws.getUpdate(id);
    if (item.stage !== 'installed' && item.stage !== 'failed') throw new ValidationError(`Only an installed update can be verified; this one is ${item.stage}.`);
    if (item.kind === 'model') throw new ValidationError('A model change is verified by its evaluation tasks, not by this check. Record the result in the improvement it came from.');
    const evidence: string[] = [];
    let passed = true;
    const want = item.observedVersion;
    let have: string | null = null;
    if (item.kind === 'cli') {
      const v = await this.inputs.claudeVersion();
      have = v.version;
      if (!have) evidence.push(`claude --version could not be read: ${v.error ?? 'unknown error'}`);
    } else if (item.kind === 'plugin') {
      have = null;
    } else {
      const t = TRACKED.find((x) => x.key === item.toolKey);
      have = t?.package ? this.inputs.bundled[t.package] ?? null : null;
    }

    let scan: ToolScan | null = null;
    if (item.kind === 'cli' || item.kind === 'plugin') {
      try {
        scan = this.ws.saveToolScan(this.inputs.rescan());
        evidence.push(`A fresh tool scan finished: ${scan.entries.length} entries, ${scan.findings.filter((f) => f.severity !== 'informational').length} findings need a look.`);
      } catch (e) {
        passed = false;
        evidence.push(`The tool scan failed: ${errText(e)}`);
      }
    }
    if (item.kind === 'plugin' && scan) {
      const entry = scan.entries.find((e) => e.kind === 'plugin' && pluginKey(e) === item.toolKey);
      const name = item.toolName;
      have = entry?.version ?? null;
      if (!entry) evidence.push(`${name} is no longer in the tool scan.`);
      const blocking = scan.findings.filter((f) => (f.severity === 'release_blocking' || f.severity === 'confirmed') && entry && f.entryIds.includes(entry.id));
      if (blocking.length) {
        passed = false;
        evidence.push(...blocking.map((f) => `Conflict: ${f.title}`));
      } else if (entry) evidence.push(`No confirmed conflicts involve ${name}.`);
    }
    if (item.kind === 'cli' && scan) {
      const blocking = scan.findings.filter((f) => f.severity === 'release_blocking');
      if (blocking.length) {
        passed = false;
        evidence.push(...blocking.map((f) => `Release-blocking: ${f.title}`));
      }
    }

    if (want) {
      const ok = (compareVersions(have, want) ?? -1) >= 0;
      if (!ok) passed = false;
      evidence.unshift(ok ? `Version ${have} is in place (wanted ${want} or later).` : `Version ${have ?? 'unknown'} is in place, not ${want} or later.`);
    } else {
      evidence.unshift(`Version ${have ?? 'unknown'} is in place.`);
      if (!have) passed = false;
    }
    if (item.kind === 'library' || item.kind === 'runtime') {
      const h = this.ws.health();
      if (h.integrity !== 'ok') passed = false;
      evidence.push(`Workspace database check: ${h.integrity}.`);
      evidence.push('Workflow tests run in CI before an app release; this check cannot rerun them on this computer.');
    }
    return this.ws.updateUpdate(id, { stage: passed ? 'verified' : 'failed', verification: { at: this.ws.nowIso(), passed, evidence } }, { type: passed ? 'update.verified' : 'update.verification_failed', payload: { evidence } });
  }

  overview(): UpdatesOverview {
    const checks = this.ws.listUpdateChecks(50);
    const latest = checks[0] ?? null;
    const items = this.ws.listUpdates({}).sort((a, b) => stageRank(a.stage) - stageRank(b.stage) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.number - a.number);
    const counts: Partial<Record<UpdateStage, number>> = {};
    for (const i of items) counts[i.stage] = (counts[i.stage] ?? 0) + 1;
    const stale: UpdatesOverview['stale'] = [];
    if (latest) {
      const cutoff = Date.parse(latest.at) - STALE_DAYS * 86_400_000;
      for (const s of latest.sources) {
        // A source skipped on purpose (no key, no scan yet) is listed in the check, not called stale.
        if (s.status === 'ok' || s.status === 'not_checked') continue;
        const lastOk = checks.find((c) => c.sources.some((x) => x.id === s.id && x.status === 'ok'))?.at ?? null;
        if (!lastOk || Date.parse(lastOk) < cutoff) stale.push({ id: s.id, name: s.name, lastOk });
      }
      if (Date.parse(latest.at) < Date.now() - STALE_DAYS * 86_400_000) stale.unshift({ id: 'all', name: 'Every source (no check in the last week)', lastOk: latest.at });
    }
    return { latest, items, stale, counts };
  }
}

const STAGE_ORDER: UpdateStage[] = ['recommended', 'approved', 'installed', 'failed', 'verified', 'dismissed', 'superseded'];
const stageRank = (s: UpdateStage) => STAGE_ORDER.indexOf(s);

/** One key per plugin installation: the same plugin can be installed in several scopes at different versions. */
const pluginKey = (p: ToolEntry) => `plugin:${p.name}|${p.scope}${p.scopeDetail && p.scope !== 'user' ? `|${p.scopeDetail}` : ''}`;

/** owner/repo for a GitHub-hosted marketplace, or null. Only plain names are accepted. */
export function githubRepo(m: ToolEntry): string | null {
  const type = m.details.type ?? '';
  const loc = m.details.location ?? '';
  const plain = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
  if (type === 'github' && plain.test(loc)) return loc;
  const url = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/.exec(loc);
  return url && plain.test(url[1]!) ? url[1]! : null;
}

/** Reads `claude --version` through the cleanup runner (validated arguments, no shell unless a .cmd shim). */
export function claudeVersionReader(run: (args: string[], cwd: string) => Promise<{ exitCode: number | null; output: string; error: string | null }>, cwd: string) {
  return async (): Promise<{ version: string | null; error: string | null }> => {
    const r = await run(['--version'], cwd);
    if (r.error) return { version: null, error: r.error };
    const v = /(\d+\.\d+\.\d+[^\s]*)/.exec(r.output)?.[1] ?? null;
    return v && r.exitCode === 0 ? { version: v, error: null } : { version: null, error: `claude --version did not print a version (exit ${r.exitCode}).` };
  };
}
