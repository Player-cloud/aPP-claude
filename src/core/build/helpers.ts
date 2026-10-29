// Helper agents (M18 part 4, DEC-036). After a task's checks run, a scan of
// the repository goes first, then three helpers look at the change side by
// side: security (the added lines), tests (what the checks' own output says
// ran) and spec drift (the linked requirements and the goal against what
// changed). They read real files, the real diff and real check output; none
// calls a model, so none costs anything, and a finding never shows a secret.
// A helper that throws is recorded as failed and the others still finish.

import { extname } from 'node:path';
import type { CheckResult } from './checks.ts';
import type { ChangedFile } from './git.ts';
import { isTestFile } from './review.ts';

export type HelperId = 'scan' | 'security' | 'tests' | 'drift';
export type HelperSeverity = 'high' | 'medium' | 'low' | 'info';

export interface HelperFinding {
  severity: HelperSeverity;
  title: string;
  detail: string;
  file?: string;
  line?: number;
}

export interface TestCase {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  /** The check whose output listed it. */
  checkId: string;
}

export interface HelperRun {
  id: HelperId;
  label: string;
  status: 'done' | 'failed';
  startedAt: string;
  durationMs: number;
  /** Helpers read files and output only; no model is called. */
  costUsd: number;
  summary: string;
  findings: HelperFinding[];
  /** Tests: every test the checks' output named, at most MAX_TESTS. */
  tests?: TestCase[];
  /** Tests: totals when the output gave counts but not names. */
  totals?: { ok: number; failed: number; skipped: number };
  /** Scan: files in the repository by language. */
  languages?: { name: string; files: number }[];
}

export interface HelperInput {
  /** Every file git tracks in the task's worktree. */
  repoFiles: string[];
  files: ChangedFile[];
  patch: string;
  checks: CheckResult[];
  goal: string;
  requirements: { id: string; title: string; acceptanceCriteria: string[] }[];
}

export const HELPER_LABELS: Record<HelperId, string> = { scan: 'Repository scan', security: 'Security', tests: 'Tests', drift: 'Spec drift' };
export const MAX_TESTS = 400;
const MAX_FINDINGS = 40;

const LANGUAGES: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.cs': 'C#',
  '.php': 'PHP', '.swift': 'Swift', '.c': 'C', '.h': 'C', '.cpp': 'C++', '.hpp': 'C++',
  '.html': 'HTML', '.css': 'CSS', '.scss': 'CSS', '.vue': 'Vue', '.svelte': 'Svelte',
  '.json': 'JSON', '.md': 'Markdown', '.yml': 'YAML', '.yaml': 'YAML', '.sql': 'SQL', '.sh': 'Shell', '.ps1': 'PowerShell',
};

/** Added lines per file, with their line numbers in the new file. */
export function addedWithLines(patch: string): Map<string, { line: number; text: string }[]> {
  const out = new Map<string, { line: number; text: string }[]>();
  let file = '';
  let n = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '');
      if (file !== '/dev/null') out.set(file, []);
    } else if (raw.startsWith('@@')) {
      n = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0);
    } else if (raw.startsWith('+') && file && file !== '/dev/null') {
      out.get(file)!.push({ line: n, text: raw.slice(1) });
      n++;
    } else if (!raw.startsWith('-') && !raw.startsWith('\\') && !raw.startsWith('diff ') && !raw.startsWith('index ') && !raw.startsWith('--- ')) n++;
  }
  return out;
}

export function scanRepo(repoFiles: string[], files: ChangedFile[]): Pick<HelperRun, 'summary' | 'findings' | 'languages'> {
  const counts = new Map<string, number>();
  for (const f of repoFiles) {
    const lang = LANGUAGES[extname(f).toLowerCase()];
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  const languages = [...counts].map(([name, n]) => ({ name, files: n })).sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));
  const tests = repoFiles.filter(isTestFile).length;
  const findings: HelperFinding[] = [];
  if (repoFiles.length && tests === 0) findings.push({ severity: 'low', title: 'No test files', detail: 'The repository has no files that look like tests.' });
  const lead = languages.slice(0, 3).map((l) => l.name).join(', ');
  return {
    summary: `${repoFiles.length} file${repoFiles.length === 1 ? '' : 's'}${lead ? ` (mostly ${lead})` : ''}, ${tests} test file${tests === 1 ? '' : 's'}; this task changed ${files.length}.`,
    findings,
    languages,
  };
}

type Rule = { severity: HelperSeverity; title: string; test: RegExp; detail: string; files?: RegExp };
const SECURITY_RULES: Rule[] = [
  { severity: 'high', title: 'Possible secret', test: /sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/, detail: 'This line looks like it holds a key or token. Keep secrets out of the code.' },
  { severity: 'high', title: 'Hard-coded password or key', test: /\b(password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/i, detail: 'A password or key is written into the code. Read it from the environment instead.' },
  { severity: 'high', title: 'Certificate checks turned off', test: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true/, detail: 'Turning off certificate checks lets anyone in the middle read or change the traffic.' },
  { severity: 'high', title: 'Runs text as code', test: /\beval\s*\(|\bnew Function\s*\(/, detail: 'eval and new Function run whatever text they get; if any of it comes from outside, so does the code.' },
  { severity: 'high', title: 'Shell command built from text', test: /\b(exec|execSync)\s*\(\s*(`[^`]*\$\{|['"][^'"]*['"]\s*\+)|shell\s*=\s*True|os\.system\s*\(/, detail: 'A shell command is put together from text; if any of it comes from outside, it can run other commands. Pass arguments as a list instead.' },
  { severity: 'medium', title: 'SQL built from text', test: /\b(SELECT|INSERT|UPDATE|DELETE)\b[^;\n]*(\$\{|['"]\s*\+\s*\w)/i, detail: 'A query is put together from text, which allows SQL injection. Use parameters.' },
  { severity: 'medium', title: 'HTML from text', test: /\.innerHTML\s*=|\.outerHTML\s*=|dangerouslySetInnerHTML|document\.write\s*\(/, detail: 'Writing HTML from text can run scripts if the text comes from a person. Set text instead, or clean it first.' },
  { severity: 'medium', title: 'Guessable random value', test: /Math\.random\(\)[^\n]*(token|secret|password|key|id)|(token|secret|password|key)[^\n]*Math\.random\(\)/i, detail: 'Math.random is predictable. Use crypto.randomUUID or crypto.getRandomValues for anything secret.' },
  { severity: 'low', title: 'Plain http address', test: /http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|www\.w3\.org)[a-z0-9.-]+\.[a-z]{2,}/i, detail: 'Traffic to this address is not encrypted. Use https.' },
];

export function securityReview(files: ChangedFile[], patch: string): Pick<HelperRun, 'summary' | 'findings'> {
  const findings: HelperFinding[] = [];
  for (const f of files) {
    if (/(^|\/)\.env(\.|$)/.test(f.path) && !/\.(example|sample|template)$/.test(f.path) && f.status !== 'deleted')
      findings.push({ severity: 'high', title: 'Environment file in the change', detail: `${f.path} usually holds secrets and should not be committed.`, file: f.path });
  }
  for (const [file, lines] of addedWithLines(patch)) {
    for (const { line, text } of lines) {
      const rule = SECURITY_RULES.find((r) => r.test.test(text));
      if (rule) findings.push({ severity: rule.severity, title: rule.title, detail: rule.detail, file, line });
    }
    if (/(^|\/)package\.json$/.test(file)) {
      let inDeps = false;
      for (const { line, text } of lines) {
        if (/"(dependencies|devDependencies)"\s*:/.test(text)) inDeps = true;
        const dep = /^\s*"(@?[a-z0-9][\w./-]*)"\s*:\s*"[~^]?[\d*x]/.exec(text);
        if (dep && (inDeps || !/"(version|node|npm)"/.test(text))) findings.push({ severity: 'info', title: 'New dependency', detail: `${dep[1]} was added. Check that it is the package you expect and is maintained.`, file, line });
      }
    }
  }
  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const serious = findings.filter((f) => f.severity === 'high' || f.severity === 'medium').length;
  return {
    summary: findings.length === 0 ? 'Nothing risky found in the added lines.' : serious ? `${serious} finding${serious === 1 ? '' : 's'} to look at.` : `${findings.length} note${findings.length === 1 ? '' : 's'}, nothing serious.`,
    findings: findings.slice(0, MAX_FINDINGS),
  };
}

export const SEVERITY_RANK: Record<HelperSeverity, number> = { high: 0, medium: 1, low: 2, info: 3 };

// Test names as the common runners print them.
const TAP = /^\s*(not ok|ok)\s+\d+\s+-?\s*(.+?)(\s+#\s*(SKIP|TODO)\b.*)?$/i;
const MARK = /^\s*([✓✔√]|[✕✖×]|○|↓)\s+(.+?)(\s+\(\d+(\.\d+)?\s*m?s\))?$/;
const PYTEST = /^(\S+::\S+)\s+(PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)\b/;
const GO = /^\s*--- (PASS|FAIL|SKIP): (\S+)/;

export function readTests(checks: CheckResult[]): Pick<HelperRun, 'summary' | 'findings' | 'tests' | 'totals'> {
  const tests: TestCase[] = [];
  const totals = { ok: 0, failed: 0, skipped: 0 };
  for (const c of checks) {
    const before = tests.length;
    for (const line of c.output.split('\n')) {
      let m: RegExpExecArray | null;
      let t: TestCase | null = null;
      if ((m = TAP.exec(line))) {
        // node:test also prints a line for each test file, which holds the tests above it.
        if (isTestFile(m[2]!.trim())) continue;
        t = { name: m[2]!.trim(), status: m[3] ? 'skipped' : m[1]!.toLowerCase() === 'ok' ? 'passed' : 'failed', checkId: c.checkId };
      } else if ((m = MARK.exec(line))) {
        t = { name: m[2]!.trim(), status: /[✓✔√]/.test(m[1]!) ? 'passed' : /[○↓]/.test(m[1]!) ? 'skipped' : 'failed', checkId: c.checkId };
      } else if ((m = PYTEST.exec(line))) {
        t = { name: m[1]!, status: /PASSED|XFAIL/.test(m[2]!) ? 'passed' : m[2] === 'SKIPPED' ? 'skipped' : 'failed', checkId: c.checkId };
      } else if ((m = GO.exec(line))) {
        t = { name: m[2]!, status: m[1] === 'PASS' ? 'passed' : m[1] === 'FAIL' ? 'failed' : 'skipped', checkId: c.checkId };
      }
      if (t && tests.length < MAX_TESTS) tests.push(t);
      if (t) totals[t.status === 'passed' ? 'ok' : t.status]++;
    }
    if (tests.length === before) {
      // No names, but maybe counts: "# pass 12", "Tests: 1 failed, 11 passed", "12 passed, 1 skipped".
      const count = (re: RegExp) => [...c.output.matchAll(re)].reduce((s, m) => s + Number(m[1]), 0);
      totals.ok += count(/^# pass (\d+)/gm) || count(/(\d+) passed/g);
      totals.failed += count(/^# fail (\d+)/gm) || count(/(\d+) failed/g);
      totals.skipped += count(/^# skip(?:ped)? (\d+)/gm) || count(/(\d+) skipped/g);
    }
  }
  const findings: HelperFinding[] = [];
  for (const t of tests.filter((t) => t.status === 'failed').slice(0, MAX_FINDINGS)) findings.push({ severity: 'high', title: 'Test fails', detail: `${t.name} (check "${t.checkId}")` });
  if (totals.failed > 0 && !tests.some((t) => t.status === 'failed')) findings.push({ severity: 'high', title: 'Tests fail', detail: `${totals.failed} test${totals.failed === 1 ? '' : 's'} failed; the output does not name them.` });
  if (totals.skipped > 0) findings.push({ severity: 'low', title: 'Skipped tests', detail: `${totals.skipped} test${totals.skipped === 1 ? ' was' : 's were'} skipped.` });
  const all = totals.ok + totals.failed + totals.skipped;
  if (checks.length === 0) findings.push({ severity: 'info', title: 'No checks', detail: 'No check commands ran, so there are no test results to read.' });
  else if (all === 0) findings.push({ severity: 'info', title: 'No test results', detail: 'The checks ran, but their output names no tests and gives no counts.' });
  return {
    summary: all === 0 ? (checks.length ? 'No test results in the check output.' : 'No checks ran.') : `${totals.ok} passed, ${totals.failed} failed${totals.skipped ? `, ${totals.skipped} skipped` : ''}.`,
    findings,
    tests,
    totals,
  };
}

const STOP = new Set(
  'that this with from have will when then than into onto they them their there what which while where should would could about after before each every page pages user users show shows list lists make made able also only just more most some such very must need needs want wants work works into your yours been being does done'.split(' '),
);
const words = (s: string) => [...new Set((s.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w)))];
/** Matches "member" in "members" and "members" in "member". */
const stem = (w: string) => w.replace(/(ies|es|s|ing|ed)$/, '');

export function specDrift(input: Pick<HelperInput, 'files' | 'patch' | 'goal' | 'requirements'>, tests: TestCase[] = []): Pick<HelperRun, 'summary' | 'findings'> {
  const haystack = [...input.files.map((f) => f.path), ...[...addedWithLines(input.patch).values()].flat().map((l) => l.text), ...tests.map((t) => t.name)].join('\n').toLowerCase();
  const mentioned = (text: string) => {
    const ws = words(text);
    if (ws.length === 0) return true;
    const hit = ws.filter((w) => haystack.includes(stem(w))).length;
    return hit / ws.length >= 0.34;
  };
  const findings: HelperFinding[] = [];
  if (input.files.length === 0) findings.push({ severity: 'medium', title: 'Nothing changed', detail: 'The task asked for a change, but no file changed.' });
  else if (!mentioned(input.goal)) findings.push({ severity: 'medium', title: 'The change may not match the ask', detail: `Little in the changed files or tests mentions what was asked: “${input.goal.slice(0, 140)}”.` });
  let criteria = 0;
  for (const r of input.requirements) {
    for (const c of r.acceptanceCriteria) {
      criteria++;
      if (!mentioned(c)) findings.push({ severity: 'medium', title: `${r.id} may not be covered`, detail: `Nothing in the change or its tests mentions: “${c.slice(0, 160)}”.` });
    }
  }
  const scope = input.requirements.length ? `${criteria} acceptance criteri${criteria === 1 ? 'on' : 'a'} from ${input.requirements.map((r) => r.id).join(', ')}` : 'the ask (no requirements are linked)';
  return {
    summary: findings.length ? `Compared with ${scope}: ${findings.length} gap${findings.length === 1 ? '' : 's'}.` : `Compared with ${scope}: no gaps found.`,
    findings: findings.slice(0, MAX_FINDINGS),
  };
}

/**
 * Runs the scan, then security, tests and spec drift together. `onUpdate`
 * gets every helper's state each time one starts or finishes, so the screen
 * can show them working.
 */
export async function runHelpers(input: HelperInput, onUpdate?: (runs: HelperRun[]) => void, now: () => Date = () => new Date()): Promise<HelperRun[]> {
  const runs = new Map<HelperId, HelperRun>();
  const publish = () => onUpdate?.([...runs.values()]);
  const run = async (id: HelperId, work: () => Omit<Partial<HelperRun>, 'id'> & Pick<HelperRun, 'summary' | 'findings'>): Promise<HelperRun> => {
    const start = now();
    // Yield first so the helpers that run side by side really start together.
    await Promise.resolve();
    let result: HelperRun;
    try {
      result = { id, label: HELPER_LABELS[id], status: 'done', startedAt: start.toISOString(), durationMs: 0, costUsd: 0, ...work() };
    } catch (e) {
      result = { id, label: HELPER_LABELS[id], status: 'failed', startedAt: start.toISOString(), durationMs: 0, costUsd: 0, summary: `Could not finish: ${(e as Error).message}`, findings: [] };
    }
    result.durationMs = Math.max(0, now().getTime() - start.getTime());
    runs.set(id, result);
    publish();
    return result;
  };
  await run('scan', () => scanRepo(input.repoFiles, input.files));
  await Promise.all([
    run('security', () => securityReview(input.files, input.patch)),
    run('tests', () => readTests(input.checks)),
    run('drift', () => specDrift(input, readTests(input.checks).tests)),
  ]);
  return (['scan', 'security', 'tests', 'drift'] as const).map((id) => runs.get(id)!);
}
