// The helper cards on a task's canvas (M18 part 5, DEC-036): what the
// repository scan, code review, security, tests and spec drift helpers found
// when the change was last checked. Every number comes from the task's own
// files, diff and check output; those helpers call no model, so their cards
// say Free. Claude's independent review (M19) shows what it cost.
import type { HelperFinding, HelperRun, HelperSeverity } from '../../shared/api.ts';
import { formatDuration, simplifyTargets } from '../../shared/report.ts';
import { Icon } from '../icons.tsx';

const SEVERITY: Record<HelperSeverity, string> = { high: 'High', medium: 'Medium', low: 'Low', info: 'Note' };
const ICON = { scan: 'search', review: 'tools', security: 'shield', tests: 'check', drift: 'list', claude: 'sparkle' } as const;
const SHOWN = 4;

function chip(h: HelperRun): { tone: 'ok' | 'bad' | 'warn' | 'muted'; text: string } {
  if (h.status === 'failed') return { tone: 'bad', text: "Didn't finish" };
  const high = h.findings.filter((f) => f.severity === 'high').length;
  if (high) return { tone: 'bad', text: `${high} high` };
  const medium = h.findings.filter((f) => f.severity === 'medium').length;
  if (medium) return { tone: 'warn', text: `${medium} to check` };
  return { tone: 'ok', text: 'Done' };
}

function Findings({ findings }: { findings: HelperFinding[] }) {
  if (findings.length === 0) return null;
  const row = (f: HelperFinding, i: number) => (
    <li key={i} className="find">
      <span className="sev" data-sev={f.severity}>
        {SEVERITY[f.severity]}
      </span>
      <div>
        <b>{f.title}</b>
        <span className="find-detail">{f.detail}</span>
        {f.impact && <span className="find-detail">Impact: {f.impact}</span>}
        {f.fix && <span className="find-detail">Fix: {f.fix}</span>}
        {f.file && (
          <small className="mono">
            {f.file}
            {f.line ? `:${f.line}` : ''}
          </small>
        )}
      </div>
    </li>
  );
  return (
    <>
      <ul className="finds">{findings.slice(0, SHOWN).map(row)}</ul>
      {findings.length > SHOWN && (
        <details className="finds-more">
          <summary>{findings.length - SHOWN} more</summary>
          <ul className="finds">{findings.slice(SHOWN).map((f, i) => row(f, i + SHOWN))}</ul>
        </details>
      )}
    </>
  );
}

function ScanBody({ h }: { h: HelperRun }) {
  const langs = h.languages ?? [];
  const total = langs.reduce((s, l) => s + l.files, 0);
  const top = langs.slice(0, 3);
  const other = total - top.reduce((s, l) => s + l.files, 0);
  const parts = [...top.map((l) => ({ name: l.name, files: l.files })), ...(other > 0 ? [{ name: 'Other', files: other }] : [])];
  return (
    <>
      {total > 0 && (
        <>
          <div className="langbar" aria-hidden="true">
            {parts.map((p, i) => (
              <i key={p.name} data-n={i} style={{ width: `${(p.files / total) * 100}%` }} />
            ))}
          </div>
          <p className="legend">
            {parts.map((p, i) => (
              <span key={p.name}>
                <i data-n={i} aria-hidden="true" />
                {p.name} {Math.round((p.files / total) * 100)}%
              </span>
            ))}
          </p>
        </>
      )}
      <p className="helper-summary">{h.summary}</p>
      {h.findings.length > 0 && <Findings findings={h.findings} />}
    </>
  );
}

function TestsBody({ h }: { h: HelperRun }) {
  const tests = h.tests ?? [];
  const t = h.totals ?? { ok: 0, failed: 0, skipped: 0 };
  // Named tests are drawn one dot each; output with only counts is drawn from the counts.
  const dots: ('passed' | 'failed' | 'skipped')[] = tests.length
    ? tests.map((x) => x.status)
    : [...Array<'failed'>(Math.min(t.failed, 400)).fill('failed'), ...Array<'passed'>(Math.min(t.ok, 400)).fill('passed'), ...Array<'skipped'>(Math.min(t.skipped, 400)).fill('skipped')].slice(0, 400);
  const all = t.ok + t.failed + t.skipped;
  const failed = tests.filter((x) => x.status === 'failed');
  return (
    <>
      {dots.length > 0 && (
        <div className="dots" role="img" aria-label={`${all} tests: ${t.ok} passed, ${t.failed} failed${t.skipped ? `, ${t.skipped} skipped` : ''}`}>
          {dots.map((s, i) => (
            <i key={i} data-s={s} />
          ))}
        </div>
      )}
      {all > dots.length && <p className="helper-note">Showing {dots.length} of {all}.</p>}
      <p className="helper-summary">{h.summary}</p>
      {failed.length > 0 ? (
        <ul className="term-rows">
          {failed.slice(0, SHOWN).map((x, i) => (
            <li key={i}>
              <span className="term-bad" aria-hidden="true">
                ✕
              </span>
              <span className="term-name">{x.name}</span>
              <span className="term-dim">{x.checkId}</span>
            </li>
          ))}
        </ul>
      ) : (
        <Findings findings={h.findings.filter((f) => f.severity === 'medium' || f.severity === 'low')} />
      )}
      {dots.length > 0 && (
        <p className="test-split" aria-hidden="true">
          <span>
            <i data-s="passed" />
            Passed
          </span>
          <span>
            <i data-s="failed" />
            Failed
          </span>
          {t.skipped > 0 && (
            <span>
              <i data-s="skipped" />
              Skipped
            </span>
          )}
        </p>
      )}
    </>
  );
}

/**
 * What the person can do with the reviews: ask Claude for an independent
 * review (it costs money with real calls on), and simplify the change when the
 * review found repeated, long or nested code (the checks then run again).
 */
export function ReviewActions({ helpers, simulated, busy, onReview, onSimplify }: { helpers: HelperRun[]; simulated: boolean; busy: string | null; onReview: () => void; onSimplify: () => void }) {
  const reviewed = helpers.some((h) => h.id === 'claude');
  const targets = simplifyTargets(helpers).length;
  return (
    <section className="kcard" aria-label="Reviews">
      <p className="helper-summary">
        {reviewed ? 'Claude has reviewed this version of the change.' : simulated ? 'A second opinion from Claude needs real calls on in Settings → AI usage; without them the review is simulated.' : 'Ask Claude for an independent review of correctness, security and tests. It costs a few cents from your monthly budget.'}
        {targets > 0 && ` The review found ${targets} place${targets === 1 ? '' : 's'} to simplify.`}
      </p>
      <div className="btn-row">
        <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={onReview}>
          {busy === 'review' ? 'Reviewing…' : reviewed ? 'Review again' : 'Ask Claude to review'}
        </button>
        {targets > 0 && (
          <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={onSimplify}>
            Simplify
          </button>
        )}
      </div>
    </section>
  );
}

export function HelperCards({ helpers }: { helpers: HelperRun[] }) {
  return (
    <>
      {helpers.map((h) => {
        const c = chip(h);
        return (
          <section key={h.id} className="kcard helper" aria-label={h.label} data-helper={h.id}>
            <header className="helper-head">
              <span className="glyph" aria-hidden="true">
                <Icon name={ICON[h.id]} size={14} />
              </span>
              <h3 className="kcard-title">{h.label}</h3>
              <span className="chip" data-tone={c.tone}>
                {c.text}
              </span>
            </header>
            {h.status === 'failed' ? (
              <p className="helper-empty">{h.summary}</p>
            ) : h.id === 'scan' ? (
              <ScanBody h={h} />
            ) : h.id === 'tests' ? (
              <TestsBody h={h} />
            ) : (
              <>
                <p className="helper-summary">{h.summary}</p>
                <Findings findings={h.findings} />
              </>
            )}
            <p className="helper-foot">
              <span className="worker" aria-hidden="true" />
              {formatDuration(h.durationMs)} · {h.costUsd > 0 ? `$${h.costUsd.toFixed(2)}` : 'Free'}
            </p>
          </section>
        );
      })}
    </>
  );
}
