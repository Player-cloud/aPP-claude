// The Improve dashboard (M18 part 9, DEC-036): where the backlog stands in
// the improvement loop, four numbers for this week against last week with a
// line for each of the last 14 days, and a strip of the last runs. Every value
// comes from the app's records of tasks and the backlog; a week with no runs
// says so instead of showing a number.
import { useEffect, useState } from 'react';
import type { ImprovementStatus, Kpi, RunOutcome, RunStats } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { relativeTime } from '../ui.tsx';

const LOOP: { label: string; statuses: ImprovementStatus[] }[] = [
  { label: 'Ideas', statuses: ['idea'] },
  { label: 'Proposed', statuses: ['proposed'] },
  { label: 'Approved', statuses: ['approved'] },
  { label: 'In progress', statuses: ['in_progress'] },
  { label: 'Verified', statuses: ['verified'] },
  { label: 'Released', statuses: ['released'] },
];

const OUTCOME_LABEL: Record<RunOutcome, string> = { clean: 'Clean', stepped: 'You stepped in', failed: 'Failed' };

/** Only days with runs are plotted; a day with none is a gap, not a zero (v0.21.2). */
function Spark({ days, tone }: { days: (number | null)[]; tone: 'good' | 'bad' | 'neutral' }) {
  const max = Math.max(1e-9, ...days.map((d) => d ?? 0));
  const pts = days.flatMap((v, i) => (v === null ? [] : [{ x: 3 + (i / (days.length - 1)) * 94, y: 26 - (v / max) * 22 }]));
  if (pts.length === 0) return <span className="spark spark-empty" aria-hidden="true" />;
  const line = pts.map((p) => `${p.x},${p.y}`).join(' ');
  return (
    <span className="spark" data-tone={tone} aria-hidden="true">
      {pts.length > 1 && (
        <svg viewBox="0 0 100 30" preserveAspectRatio="none">
          <polyline points={`${pts[0]!.x},30 ${line} ${pts.at(-1)!.x},30`} className="spark-fill" />
          <polyline points={line} className="spark-line" />
        </svg>
      )}
      {pts.map((p) => (
        <i key={p.x} className="spark-dot" style={{ left: `${p.x}%`, top: `${(p.y / 30) * 100}%` }} />
      ))}
    </span>
  );
}

function KpiCard({ label, kpi, format, better, unit }: { label: string; kpi: Kpi; format: (n: number) => string; better: 'up' | 'down'; unit: string }) {
  const delta = kpi.now !== null && kpi.before !== null ? kpi.now - kpi.before : null;
  const good = delta === null || delta === 0 ? null : (delta > 0) === (better === 'up');
  return (
    <section className="kcard kpi" aria-label={label}>
      <h3 className="kpi-label">{label}</h3>
      <p className="kpi-value">{kpi.now === null ? '—' : format(kpi.now)}</p>
      <p className="kpi-delta" data-good={good === null ? undefined : String(good)}>
        {kpi.now === null
          ? 'No runs this week'
          : delta === null
            ? 'No runs the week before'
            : delta === 0
              ? 'Same as last week'
              : `${delta > 0 ? '↑' : '↓'} ${format(Math.abs(delta))}${unit} on last week`}
      </p>
      <Spark days={kpi.days} tone={good === false ? 'bad' : 'good'} />
    </section>
  );
}

export function ImproveDashboard({ counts }: { counts: Record<ImprovementStatus, number> | null }) {
  const [stats, setStats] = useState<RunStats | null>(null);
  useEffect(() => {
    call(iap().runStats())
      .then(setStats)
      .catch(() => setStats(null));
  }, []);
  return (
    <div className="improve">
      {counts && (
        <ol className="loop" aria-label="Improvement loop">
          {LOOP.map((s) => {
            const n = s.statuses.reduce((sum, st) => sum + (counts[st] ?? 0), 0);
            return (
              <li key={s.label} data-has={n > 0}>
                <span className="loop-n">{n}</span>
                {s.label}
              </li>
            );
          })}
        </ol>
      )}
      {stats && (
        <>
          <div className="kpis">
            <KpiCard label="Runs that worked" kpi={stats.success} format={(n) => `${n}%`} unit=" pts" better="up" />
            <KpiCard label="Median cost per run" kpi={stats.medianCost} format={(n) => `$${n.toFixed(2)}`} unit="" better="down" />
            <KpiCard label="Times you stepped in" kpi={stats.steppedIn} format={(n) => String(n)} unit="" better="down" />
            <KpiCard label="Failed runs" kpi={stats.failures} format={(n) => String(n)} unit="" better="down" />
          </div>
          <section className="kcard run-strip" aria-labelledby="runs-title">
            <div className="run-strip-head">
              <h3 className="kcard-title" id="runs-title">
                Last {stats.runs.length} {stats.runs.length === 1 ? 'run' : 'runs'}
              </h3>
              <p className="run-legend" aria-hidden="true">
                {(['clean', 'stepped', 'failed'] as const).map((o) => (
                  <span key={o}>
                    <i data-outcome={o} />
                    {OUTCOME_LABEL[o]}
                  </span>
                ))}
              </p>
            </div>
            {stats.runs.length === 0 ? (
              <p className="helper-summary">No runs yet. Each task Claude works on shows here as clean, stepped in or failed.</p>
            ) : (
              <>
                <ol className="runs" aria-label="Runs, oldest first">
                  {stats.runs.map((r) => (
                    <li key={r.buildId} data-outcome={r.outcome} title={`${r.title} · ${OUTCOME_LABEL[r.outcome]} · ${relativeTime(r.at)}`}>
                      <span className="visually-hidden">
                        {r.title}: {OUTCOME_LABEL[r.outcome]}
                      </span>
                    </li>
                  ))}
                </ol>
                <p className="run-dates" aria-hidden="true">
                  <span>{relativeTime(stats.runs[0]!.at)}</span>
                  <span>{relativeTime(stats.runs.at(-1)!.at)}</span>
                </p>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
