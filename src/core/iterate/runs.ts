// How the work has been going (M18 part 9, DEC-036): the Improve dashboard's
// numbers, worked out from the app's own records of tasks and their events.
// A run is a task that Claude worked on. It ended clean, the person stepped
// in (asked for changes with a follow-up), or it failed (Claude's run did not
// finish, a check failed, or the person undid it). Weeks are the last seven
// days and the seven before; nothing here is estimated.

import type { AuditEvent, Build } from '../workspace.ts';

export type RunOutcome = 'clean' | 'stepped' | 'failed';

export interface RunMark {
  buildId: string;
  title: string;
  at: string;
  outcome: RunOutcome;
}

export interface Kpi {
  /** This week's value; null when there were no runs. */
  now: number | null;
  /** The week before. */
  before: number | null;
  /** One value per day for the last 14 days, oldest first (null on a day with no runs). */
  days: (number | null)[];
}

export interface RunStats {
  runs: RunMark[];
  success: Kpi;
  medianCost: Kpi;
  steppedIn: Kpi;
  failures: Kpi;
}

export const MAX_RUNS = 60;
const DAY = 86_400_000;
const FAILED_RISKS = new Set(['regression', 'still_failing']);

function outcomeOf(b: Build, followUps: number): RunOutcome {
  if (b.status === 'abandoned' || (b.agent && b.agent.status !== 'done') || b.risks?.some((r) => FAILED_RISKS.has(r.kind))) return 'failed';
  return followUps > 0 ? 'stepped' : 'clean';
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function runStats(builds: Build[], events: AuditEvent[], now: Date = new Date()): RunStats {
  const followUps = new Map<string, number>();
  for (const e of events) if (e.type === 'build.agent' && e.payload.followUp === true && typeof e.payload.buildId === 'string') followUps.set(e.payload.buildId, (followUps.get(e.payload.buildId) ?? 0) + 1);
  const ran = builds
    .filter((b) => b.agent && b.status !== 'draft' && b.status !== 'in_progress')
    .map((b) => ({ b, at: b.agent!.at, outcome: outcomeOf(b, followUps.get(b.id) ?? 0), cost: b.agent!.costUsd, steps: followUps.get(b.id) ?? 0 }))
    .sort((x, y) => x.at.localeCompare(y.at));

  const end = now.getTime();
  const inRange = (from: number, to: number) => ran.filter((r) => Date.parse(r.at) > end - from && Date.parse(r.at) <= end - to);
  const week = inRange(7 * DAY, 0);
  const prior = inRange(14 * DAY, 7 * DAY);
  const days = Array.from({ length: 14 }, (_, i) => inRange((14 - i) * DAY, (13 - i) * DAY));

  const success = (rs: typeof ran) => (rs.length ? Math.round((rs.filter((r) => r.outcome !== 'failed').length / rs.length) * 100) : null);
  const cost = (rs: typeof ran) => median(rs.map((r) => r.cost));
  const stepped = (rs: typeof ran) => (rs.length ? rs.reduce((s, r) => s + r.steps, 0) : null);
  const failed = (rs: typeof ran) => (rs.length ? rs.filter((r) => r.outcome === 'failed').length : null);
  const kpi = (f: (rs: typeof ran) => number | null): Kpi => ({ now: f(week), before: f(prior), days: days.map(f) });

  return {
    runs: ran.slice(-MAX_RUNS).map((r) => ({ buildId: r.b.id, title: r.b.title, at: r.at, outcome: r.outcome })),
    success: kpi(success),
    medianCost: kpi(cost),
    steppedIn: kpi(stepped),
    failures: kpi(failed),
  };
}
