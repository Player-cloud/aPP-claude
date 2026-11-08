// Independent review by Claude (M19, FR-QA-003, DEC-037). One model call reads
// the finished change and answers with findings, each with its severity,
// evidence, impact and fix. It runs only when the person asks, because it
// costs money; the free rule-based helpers always run. Findings the helpers
// already reported at the same place are dropped, so the two reviewers add
// distinct perspectives instead of the same finding twice.

import { guardedCall } from '../agents/guard.ts';
import type { ModelAdapter } from '../agents/model.ts';
import { redactString } from '../redact.ts';
import type { Workspace } from '../workspace.ts';
import type { ChangedFile } from './git.ts';
import { SEVERITY_RANK, type HelperFinding, type HelperRun, type HelperSeverity, type ReviewArea } from './helpers.ts';

export const MAX_REVIEW_PATCH = 80_000;
const MAX_OUTPUT_TOKENS = 6_000;
const TIMEOUT_MS = 300_000;
const MAX_FINDINGS = 30;
const AREAS = new Set<ReviewArea>(['correctness', 'security', 'regression', 'tests', 'maintainability', 'complexity']);
const SEVERITY: Record<string, HelperSeverity> = { critical: 'high', high: 'high', medium: 'medium', low: 'low' };

export interface ReviewInput {
  title: string;
  goal: string;
  files: ChangedFile[];
  patch: string;
  /** What the rule-based helpers found already. */
  known: HelperFinding[];
}

export function reviewInstructions(input: ReviewInput): string {
  const patch = input.patch.length > MAX_REVIEW_PATCH ? `${input.patch.slice(0, MAX_REVIEW_PATCH)}\n[The diff is cut off here: ${input.patch.length - MAX_REVIEW_PATCH} more characters were not sent.]` : input.patch;
  const known = input.known.filter((f) => f.severity !== 'info').slice(0, 40);
  return [
    `Goal of the change: ${input.goal}`,
    '',
    'Changed files:',
    ...input.files.map((f) => `- ${f.path} (${f.status})`),
    '',
    'Already reported by the helpers (do not repeat):',
    ...(known.length ? known.map((f) => `- ${f.title}${f.file ? ` at ${f.file}${f.line ? `:${f.line}` : ''}` : ''}`) : ['- nothing']),
    '',
    'Diff:',
    redactString(patch),
  ].join('\n');
}

/** Reads the model's answer. Anything malformed is dropped rather than guessed at. */
export function parseReview(text: string, known: HelperFinding[]): { summary: string; findings: HelperFinding[]; critical: number } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Claude’s review was not in the expected format.');
  }
  const o = (data ?? {}) as { summary?: unknown; findings?: unknown };
  const str = (v: unknown, max: number) => (typeof v === 'string' ? redactString(v.trim()).slice(0, max) : '');
  const same = (a: HelperFinding, file: string, line: number) => a.file === file && (line === 0 || !a.line || Math.abs(a.line - line) <= 2);
  const findings: HelperFinding[] = [];
  let critical = 0;
  for (const raw of Array.isArray(o.findings) ? o.findings : []) {
    const f = (raw ?? {}) as Record<string, unknown>;
    const severity = SEVERITY[String(f.severity)];
    const title = str(f.title, 120);
    if (!severity || !title) continue;
    const file = str(f.file, 300).replace(/\\/g, '/').replace(/^\.?\//, '');
    const line = Number.isInteger(f.line) && (f.line as number) > 0 ? (f.line as number) : 0;
    if (file && known.some((k) => same(k, file, line))) continue;
    const area = AREAS.has(f.area as ReviewArea) ? (f.area as ReviewArea) : 'correctness';
    if (f.severity === 'critical') critical++;
    findings.push({
      severity,
      area,
      title: f.severity === 'critical' ? `Critical: ${title}` : title,
      detail: str(f.evidence, 600) || title,
      impact: str(f.impact, 400) || undefined,
      fix: str(f.fix, 400) || undefined,
      ...(file ? { file } : {}),
      ...(line ? { line } : {}),
    });
  }
  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return { summary: str(o.summary, 600), findings: findings.slice(0, MAX_FINDINGS), critical };
}

/** Asks the model for its review under the monthly budget. Throws with the reason when it cannot run. */
export async function independentReview(ws: Workspace, model: ModelAdapter, input: ReviewInput, now: () => Date = () => new Date()): Promise<HelperRun> {
  const start = now();
  const outcome = await guardedCall(ws, model, { purpose: 'review', taskTitle: input.title, instructions: reviewInstructions(input), maxOutputTokens: MAX_OUTPUT_TOKENS }, { taskId: null, timeoutMs: TIMEOUT_MS });
  if (!outcome.ok) throw new Error(`${outcome.failure} ${outcome.resolution}`);
  const { summary, findings } = parseReview(outcome.response.text, input.known);
  const serious = findings.filter((f) => f.severity === 'high' || f.severity === 'medium').length;
  return {
    id: 'claude',
    label: 'Claude review',
    status: 'done',
    startedAt: start.toISOString(),
    durationMs: Math.max(0, now().getTime() - start.getTime()),
    costUsd: outcome.response.costUsd,
    summary: [summary, findings.length === 0 ? 'No further findings.' : serious ? `${serious} finding${serious === 1 ? '' : 's'} to look at.` : `${findings.length} note${findings.length === 1 ? '' : 's'}, nothing serious.`].filter(Boolean).join(' '),
    findings,
  };
}
