// Self-assessment (M10: FR-ITER-001, DEC-026). The app reads its own records and
// reports where work went wrong, in three separate layers:
//
//   observation    what the records say (counts, linked to the records)
//   inference      the likely cause, with how sure the app is
//   recommendation a backlog item the person may approve
//
// Nothing is changed and no model is called. Only ids, timestamps, short labels and
// error summaries are read: no source code, prompt bodies or credentials. Each
// finding has a stable signature so a repeated problem lands on the same item.

import { redactString } from '../redact.ts';
import type { Workspace } from '../workspace.ts';

export type Confidence = 'low' | 'medium' | 'high';
export type Level = 'low' | 'medium' | 'high';

export interface Occurrence {
  /** The record it came from (a run, task, build, check run, assessment, scan finding or month). */
  id: string;
  at: string;
  label: string;
}

export interface SelfFinding {
  signature: string;
  area: 'runs' | 'agents' | 'builds' | 'checks' | 'assessments' | 'tools' | 'spend';
  observation: { text: string; count: number; occurrences: Occurrence[] };
  inference: { text: string; confidence: Confidence };
  recommendation: { title: string; problem: string; expectedOutcome: string; successCriteria: string; priority: Level; risk: Level };
}

export interface SelfAssessmentReport {
  at: string;
  /** What was read, so an empty result can be told apart from nothing to read. */
  sources: { name: string; count: number }[];
  findings: SelfFinding[];
  /** What the app does not record, so these problems cannot be seen at all. */
  gaps: string[];
}

/** Telemetry the app does not collect (yet). Listed so their absence is visible. */
export const TELEMETRY_GAPS = [
  'App crashes and unexpected errors are not logged, so they cannot be counted.',
  'How long screens take to respond is not measured.',
  'Memory, processor and disk use are not recorded.',
  'Whether a result met the person’s needs is only known from feedback they type.',
  'There are no integrations yet, so integration failures cannot be assessed.',
];

const KEEP = 50;
const SHORT = 160;

const short = (s: string | null | undefined) => {
  const t = redactString((s ?? '').replace(/\s+/g, ' ').trim());
  return t.length > SHORT ? `${t.slice(0, SHORT - 1)}…` : t;
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const priorityFor = (n: number): Level => (n >= 5 ? 'high' : n >= 2 ? 'medium' : 'low');
const newest = (xs: Occurrence[]) => [...xs].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, KEEP);

function group<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  return m;
}

const AGENT_INFERENCE: Record<string, { text: string; confidence: Confidence; fix: string }> = {
  timed_out: { text: 'The work took longer than the task’s time limit. The limit may be too short, or the task too big for one step.', confidence: 'medium', fix: 'Agent tasks finish within their time limit' },
  permission_denied: { text: 'Tasks asked for tools they were not allowed to use. The instructions and the allowed tools may not match the work.', confidence: 'medium', fix: 'Agent tasks only ask for tools they are allowed' },
  failed: { text: 'The failure messages differ; the records alone do not show one cause.', confidence: 'low', fix: 'Agent tasks succeed or fail with a clear reason' },
  blocked: { text: 'Tasks stopped and waited on something they could not resolve themselves.', confidence: 'low', fix: 'Blocked agent tasks are resolved quickly' },
};

const CHECK_INFERENCE: Record<string, { text: string; confidence: Confidence }> = {
  timed_out: { text: 'The check runs longer than the time it is allowed, or it waits for input that never comes.', confidence: 'medium' },
  could_not_run: { text: 'The check command could not start: it may be missing on this computer or spelled differently.', confidence: 'medium' },
};

export function selfAssess(ws: Workspace, at: string): SelfAssessmentReport {
  const findings: SelfFinding[] = [];
  const projects = ws.listProjects();
  const runs = ws.listRuns();
  const tasks = ws.listAgentTasks();
  const builds = projects.flatMap((p) => ws.listBuilds(p.id));
  const checkRuns = builds.flatMap((b) => ws.listCheckRuns(b.id).map((c) => ({ ...c, where: b.title })));
  const releases = projects.flatMap((p) => ws.listReleases(p.id));
  const releaseChecks = releases.flatMap((r) => ws.listReleaseCheckRuns(r.id).map((c) => ({ ...c, where: `release ${r.version}` })));
  const assessments = projects.flatMap((p) => ws.listAssessments(p.id));
  const scan = ws.latestToolScan();

  // Runs that are blocked now, or that failed.
  for (const state of ['blocked', 'failed'] as const) {
    for (const [workflow, rs] of group(runs.filter((r) => r.state === state), (r) => r.workflow)) {
      const reasons = [...new Set(rs.map((r) => short(r.blockerReason)).filter(Boolean))];
      findings.push({
        signature: `run.${state}.${workflow}`,
        area: 'runs',
        observation: {
          text: cap(`${plural(rs.length, `${workflow} run`)} ${state === 'blocked' ? (rs.length === 1 ? 'is blocked' : 'are blocked') : 'failed'}.`),
          count: rs.length,
          occurrences: newest(rs.map((r) => ({ id: r.id, at: r.updatedAt, label: short(r.title) + (r.blockerReason ? ` — ${short(r.blockerReason)}` : '') }))),
        },
        inference:
          state === 'blocked' && reasons.length === 1 && rs.length > 1
            ? { text: `They share one reason: “${reasons[0]}”.`, confidence: 'high' }
            : state === 'blocked'
              ? { text: 'Each run waits on something the app could not resolve; the reasons are in the runs.', confidence: 'low' }
              : { text: 'The records show the runs failed but not why; look at each run’s history.', confidence: 'low' },
        recommendation: {
          title: `Fewer ${state} ${workflow} runs`,
          problem: cap(`${workflow} runs ${state === 'blocked' ? 'get blocked' : 'fail'} (${rs.length} so far).`),
          expectedOutcome: cap(`${workflow} runs reach the end without ${state === 'blocked' ? 'blocking' : 'failing'}.`),
          successCriteria: `No new ${state} ${workflow} run in the 30 days after release.`,
          priority: priorityFor(rs.length),
          risk: 'low',
        },
      });
    }
  }

  // Agent tasks that did not succeed.
  for (const [status, ts] of group(tasks.filter((t) => t.status in AGENT_INFERENCE), (t) => t.status)) {
    const info = AGENT_INFERENCE[status]!;
    findings.push({
      signature: `agent_task.${status}`,
      area: 'agents',
      observation: {
        text: `${plural(ts.length, 'agent task')} ended as ${status.replace('_', ' ')}.`,
        count: ts.length,
        occurrences: newest(ts.map((t) => ({ id: t.id, at: t.updatedAt, label: short(t.title) + (t.failure ? ` — ${short(t.failure)}` : '') }))),
      },
      inference: { text: info.text, confidence: info.confidence },
      recommendation: {
        title: info.fix,
        problem: `Agent tasks end as ${status.replace('_', ' ')} (${ts.length} so far).`,
        expectedOutcome: `${info.fix}.`,
        successCriteria: `No new ${status.replace('_', ' ')} agent task in the next 20 tasks after release.`,
        priority: priorityFor(ts.length),
        risk: 'medium',
      },
    });
  }

  // Builds that were abandoned.
  const abandoned = builds.filter((b) => b.status === 'abandoned');
  if (abandoned.length) {
    findings.push({
      signature: 'build.abandoned',
      area: 'builds',
      observation: {
        text: `${plural(abandoned.length, 'build')} ${abandoned.length === 1 ? 'was' : 'were'} abandoned before finishing.`,
        count: abandoned.length,
        occurrences: newest(abandoned.map((b) => ({ id: b.id, at: b.updatedAt, label: short(b.title) + (b.note ? ` — ${short(b.note)}` : '') }))),
      },
      inference: { text: 'Work stopped before the checks passed. The reasons the person gave are on each build.', confidence: 'low' },
      recommendation: {
        title: 'Fewer abandoned builds',
        problem: `Builds are abandoned before they finish (${abandoned.length} so far).`,
        expectedOutcome: 'Most builds that start are completed.',
        successCriteria: 'At most one abandoned build in the next 10 builds after release.',
        priority: priorityFor(abandoned.length),
        risk: 'low',
      },
    });
  }

  // Builds finished with risks the person accepted. "Manual check" is always there for UI work by design.
  const accepted = builds.filter((b) => b.status === 'completed').flatMap((b) => (b.risks ?? []).filter((r) => r.kind !== 'manual_check').map((r) => ({ b, r })));
  for (const [kind, xs] of group(accepted, (x) => x.r.kind)) {
    const word = kind.replace(/_/g, ' ');
    findings.push({
      signature: `build.accepted_risk.${kind}`,
      area: 'builds',
      observation: {
        text: `${plural(xs.length, 'completed build')} accepted a “${word}” risk.`,
        count: xs.length,
        occurrences: newest(xs.map(({ b, r }) => ({ id: b.id, at: b.completedAt ?? b.updatedAt, label: `${short(b.title)} — ${short(r.detail)}` }))),
      },
      inference:
        xs.length > 1
          ? { text: `The same kind of risk keeps being accepted, which suggests the review or the checks miss something for “${word}”.`, confidence: 'medium' }
          : { text: 'A single accepted risk; the person’s note explains it.', confidence: 'low' },
      recommendation: {
        title: `Fewer builds finished with a “${word}” risk`,
        problem: `Builds are completed with a “${word}” risk still open (${xs.length} so far).`,
        expectedOutcome: `Builds finish without a “${word}” risk.`,
        successCriteria: `No new completed build with a “${word}” risk in the next 10 builds after release.`,
        priority: priorityFor(xs.length),
        risk: 'medium',
      },
    });
  }

  // Checks that timed out or could not run, by check id.
  const badChecks = [...checkRuns, ...releaseChecks]
    .filter((c) => c.status === 'timed_out' || c.status === 'error')
    .map((c) => ({ c, why: c.status === 'timed_out' ? 'timed_out' : 'could_not_run' }));
  for (const [key, xs] of group(badChecks, (x) => `${x.why}.${x.c.checkId}`)) {
    const why = xs[0]!.why;
    const checkId = xs[0]!.c.checkId;
    const what = why === 'timed_out' ? 'timed out' : 'could not run';
    findings.push({
      signature: `check.${key}`,
      area: 'checks',
      observation: {
        text: `The “${checkId}” check ${what} ${plural(xs.length, 'time')}.`,
        count: xs.length,
        occurrences: newest(xs.map(({ c }) => ({ id: `${'buildId' in c ? c.buildId : c.releaseId}#${c.seq}`, at: c.startedAt, label: `${short(c.where)} — ${short(c.command)}` }))),
      },
      inference: CHECK_INFERENCE[why]!,
      recommendation: {
        title: `The “${checkId}” check runs reliably`,
        problem: `The “${checkId}” check ${what} (${xs.length} so far).`,
        expectedOutcome: `The “${checkId}” check gives a pass or a fail every time it runs.`,
        successCriteria: `The next 10 runs of “${checkId}” all pass or fail; none ${what === 'timed out' ? 'time out' : 'fail to start'}.`,
        priority: priorityFor(xs.length),
        risk: 'low',
      },
    });
  }

  // Assessments that failed.
  const failedAsm = assessments.filter((a) => a.status === 'failed');
  if (failedAsm.length) {
    findings.push({
      signature: 'assessment.failed',
      area: 'assessments',
      observation: {
        text: `${plural(failedAsm.length, 'repository assessment')} failed.`,
        count: failedAsm.length,
        occurrences: newest(failedAsm.map((a) => ({ id: a.id, at: a.completedAt ?? a.createdAt, label: short(a.error) }))),
      },
      inference: { text: 'The assessment stopped with an error; the message usually names the file or command.', confidence: 'medium' },
      recommendation: {
        title: 'Repository assessments complete',
        problem: `Assessments fail before they finish (${failedAsm.length} so far).`,
        expectedOutcome: 'Assessments finish and report what they could not read instead of failing.',
        successCriteria: 'The next 5 assessments all complete.',
        priority: priorityFor(failedAsm.length),
        risk: 'low',
      },
    });
  }

  // Tool conflicts from the latest scan that are confirmed or block a release.
  const conflicts = (scan?.findings ?? []).filter((f) => f.severity === 'confirmed' || f.severity === 'release_blocking');
  for (const [category, fs] of group(conflicts, (f) => f.category)) {
    const blocking = fs.some((f) => f.severity === 'release_blocking');
    findings.push({
      signature: `tools.${category}`,
      area: 'tools',
      observation: {
        text: `The latest tool scan found ${plural(fs.length, `${blocking ? 'release-blocking or ' : ''}confirmed ${category.replace(/_/g, ' ')} problem`)}.`,
        count: fs.length,
        occurrences: newest(fs.map((f) => ({ id: f.id, at: scan!.scannedAt, label: short(f.title) }))),
      },
      inference: { text: short(fs.find((f) => f.inference)?.inference) || 'The scan’s evidence is the whole story.', confidence: 'high' },
      recommendation: {
        title: `Resolve ${category.replace(/_/g, ' ')} problems in the tool setup`,
        problem: fs.map((f) => short(f.title)).slice(0, 3).join('; '),
        expectedOutcome: short(fs[0]!.recommendation),
        successCriteria: `A new tool scan shows no confirmed ${category.replace(/_/g, ' ')} problem.`,
        priority: blocking ? 'high' : priorityFor(fs.length),
        risk: 'medium',
      },
    });
  }

  // Spend close to the monthly budget.
  const budget = ws.monthlyBudgetUsd();
  const spent = ws.spentThisMonth();
  if (budget !== null && budget > 0 && spent >= budget * 0.8) {
    const month = at.slice(0, 7);
    findings.push({
      signature: 'spend.near_budget',
      area: 'spend',
      observation: { text: `$${spent.toFixed(2)} of the $${budget.toFixed(2)} monthly budget is spent (${Math.round((spent / budget) * 100)}%).`, count: 1, occurrences: [{ id: month, at, label: `Spend in ${month}` }] },
      inference: { text: 'At this rate the budget runs out before the month ends, and model calls will then be refused.', confidence: 'medium' },
      recommendation: {
        title: 'Stay within the monthly AI budget',
        problem: `Spend reached ${Math.round((spent / budget) * 100)}% of the monthly budget in ${month}.`,
        expectedOutcome: 'Monthly spend stays under 80% of the budget.',
        successCriteria: 'Two months in a row under 80% of the budget after release.',
        priority: spent >= budget ? 'high' : 'medium',
        risk: 'low',
      },
    });
  }

  return {
    at,
    sources: [
      { name: 'Workflow runs', count: runs.length },
      { name: 'Agent tasks', count: tasks.length },
      { name: 'Builds', count: builds.length },
      { name: 'Check runs', count: checkRuns.length + releaseChecks.length },
      { name: 'Assessments', count: assessments.length },
      { name: 'Tool scan findings', count: scan?.findings.length ?? 0 },
    ],
    findings: findings.sort((a, b) => b.observation.count - a.observation.count || a.signature.localeCompare(b.signature)),
    gaps: TELEMETRY_GAPS,
  };
}
