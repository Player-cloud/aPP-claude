// Improvements (M10, FR-ITER-001/002): the app assesses its own records and
// keeps an improvement backlog. A self-assessment shows what the records say,
// the likely cause and a recommendation as separate layers. Items move only when
// the person moves them; approving one records the decision and changes nothing
// in the app.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Improvement, ImprovementDetail, ImprovementStatus, ImprovementsOverview, SelfAssessmentRecord } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Icon } from '../icons.tsx';
import { Alert, Badge, Empty, formatDate, type Tone } from '../ui.tsx';
import { ImproveDashboard } from './ImproveDashboard.tsx';

export type ImprovementFilter = 'all' | ImprovementStatus;

export const STATUS_LABEL: Record<ImprovementStatus, string> = {
  idea: 'Idea',
  proposed: 'Proposed',
  approved: 'Approved',
  in_progress: 'In progress',
  verified: 'Verified',
  released: 'Released',
  blocked: 'Blocked',
  rejected: 'Rejected',
};

const STATUS_TONE: Record<ImprovementStatus, Tone> = {
  idea: 'neutral',
  proposed: 'info',
  approved: 'info',
  in_progress: 'warn',
  verified: 'ok',
  released: 'ok',
  blocked: 'danger',
  rejected: 'neutral',
};

const LEVEL_TONE = { low: 'neutral', medium: 'info', high: 'warn' } as const;

/** What a move to each status is called on its button, and the text it needs. */
const MOVE: Record<ImprovementStatus, { label: string; needs?: { field: 'reason' | 'result' | 'measuredOutcome'; label: string; hint: string } }> = {
  idea: { label: 'Back to idea' },
  proposed: { label: 'Propose' },
  approved: { label: 'Approve' },
  in_progress: { label: 'Start work' },
  verified: { label: 'Mark verified', needs: { field: 'result', label: 'Result', hint: 'What was done and how it was checked.' } },
  released: { label: 'Mark released', needs: { field: 'measuredOutcome', label: 'Measured outcome', hint: 'Measured against the success criteria. Passing tests alone is not enough.' } },
  blocked: { label: 'Block', needs: { field: 'reason', label: 'Blocked on', hint: 'What has to happen first.' } },
  rejected: { label: 'Reject', needs: { field: 'reason', label: 'Why it is rejected', hint: 'Kept in the backlog with this reason.' } },
};

function StatusBadge({ status }: { status: ImprovementStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

function SelfAssessment({ record }: { record: SelfAssessmentRecord }) {
  const r = record.report;
  return (
    <section className="card" aria-labelledby="self-title">
      <div className="card-head">
        <h2 className="card-title" id="self-title">
          Latest self-assessment
        </h2>
        <span className="subtle">{formatDate(record.at)}</span>
      </div>
      <p className="subtle">Read: {r.sources.map((s) => `${s.name.toLowerCase()} ${s.count}`).join(' · ')}</p>
      {r.findings.length === 0 ? (
        <p className="muted">Nothing went wrong in the records read.</p>
      ) : (
        <div className="imp-layers" role="table" aria-label="Findings">
          <div className="imp-layer-head" role="row">
            <span role="columnheader">What the records say</span>
            <span role="columnheader">Likely cause</span>
            <span role="columnheader">Recommendation</span>
          </div>
          {r.findings.map((f) => (
            <div key={f.signature} className="imp-layer-row" role="row">
              <span role="cell">
                {f.observation.text}
                <span className="subtle imp-cell-meta">{f.observation.occurrences.length} linked records</span>
              </span>
              <span role="cell">
                {f.inference.text}
                <span className="imp-cell-meta">
                  <Badge tone={f.inference.confidence === 'high' ? 'ok' : f.inference.confidence === 'medium' ? 'info' : 'neutral'}>{f.inference.confidence} confidence</Badge>
                </span>
              </span>
              <span role="cell">
                <strong>{f.recommendation.title}</strong>
                <span className="subtle imp-cell-meta">{f.recommendation.successCriteria}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="subtle">
        {record.created.length} new {record.created.length === 1 ? 'item' : 'items'}, {record.updated.length} with new evidence.
      </p>
      <h3 className="ref-subhead">Not recorded, so not assessed</h3>
      <ul className="muted imp-gaps">
        {r.gaps.map((g) => (
          <li key={g}>{g}</li>
        ))}
      </ul>
    </section>
  );
}

function Inspector({ id, items, onChanged, onClose }: { id: string; items: Improvement[]; onChanged: () => void; onClose: () => void }) {
  const [detail, setDetail] = useState<ImprovementDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState<ImprovementStatus | null>(null);
  const [moveText, setMoveText] = useState('');
  const [mergeInto, setMergeInto] = useState('');
  const [form, setForm] = useState({ title: '', problem: '', expectedOutcome: '', successCriteria: '', priority: 'medium', risk: 'low' });
  const [saved, setSaved] = useState(false);
  const [outcome, setOutcome] = useState({ verdict: 'improved' as 'improved' | 'not_improved', detail: '' });
  const [platformNote, setPlatformNote] = useState<string | null>(null);

  const show = (d: ImprovementDetail) => {
    setDetail(d);
    const i = d.item;
    setForm({ title: i.title, problem: i.problem, expectedOutcome: i.expectedOutcome, successCriteria: i.successCriteria, priority: i.priority, risk: i.risk });
  };

  useEffect(() => {
    call(iap().getImprovement(id))
      .then(show)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  const act = async (run: () => Promise<ImprovementDetail>) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      show(await run());
      onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!detail) return <section className="card">{error ? <Alert tone="danger">{error}</Alert> : <p className="loading">Loading…</p>}</section>;
  const i = detail.item;
  const editable = !i.mergedInto && (i.status === 'idea' || i.status === 'proposed');

  const platform = detail.builds.length > 0;
  const move = async (to: ImprovementStatus) => {
    const needs = to === 'released' && platform ? undefined : MOVE[to].needs ?? (i.status === 'rejected' || i.status === 'blocked' ? { field: 'reason' as const } : undefined);
    if (needs && moving !== to) {
      setMoving(to);
      setMoveText('');
      return;
    }
    const ok = await act(() => call(iap().moveImprovement({ id: i.id, to, ...(needs && moveText.trim() ? { [needs.field]: moveText.trim() } : {}) })));
    if (ok) setMoving(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (await act(() => call(iap().editImprovement({ id: i.id, ...form })))) setSaved(true);
  };

  const buildPlatform = async () => {
    setBusy(true);
    setError(null);
    try {
      const b = await call(iap().startPlatformWork({ improvementId: i.id }));
      setPlatformNote(`"${b.title}" is a draft in the platform-maintenance project. Open it from Platform or Projects to start it.`);
      show(await call(iap().getImprovement(i.id)));
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const moveNeeds = moving ? MOVE[moving].needs ?? { field: 'reason' as const, label: i.status === 'blocked' ? 'How it was unblocked' : 'Why it is reopened', hint: 'Recorded with the move.' } : null;
  const others = items.filter((o) => o.id !== i.id && !o.mergedInto);

  return (
    <section className="card ref-inspector" aria-labelledby="imp-title">
      <div className="card-head">
        <h2 className="card-title" id="imp-title">
          IMP-{i.number} {i.title}
        </h2>
        <button type="button" className="icon-btn" aria-label="Close the item" title="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <p className="imp-badges">
        <StatusBadge status={i.status} />
        <Badge tone={LEVEL_TONE[i.priority]}>{i.priority} priority</Badge>
        <Badge tone="neutral">{i.risk} risk</Badge>
        <Badge tone="neutral">{i.source === 'feedback' ? 'Feedback' : 'Self-assessment'}</Badge>
      </p>
      {i.reason && (
        <Alert tone={i.status === 'blocked' ? 'warn' : 'info'}>
          {i.status === 'blocked' ? 'Blocked on: ' : i.status === 'rejected' ? 'Rejected: ' : 'Note: '}
          {i.reason}
        </Alert>
      )}
      {detail.mergedInto && <Alert tone="info">Merged into IMP-{detail.mergedInto.number}. It is kept here with its history and no longer moves.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}

      {editable ? (
        <form onSubmit={save} aria-label="Edit the item">
          <div className="field">
            <label htmlFor="imp-f-title">Title</label>
            <input id="imp-f-title" className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="imp-f-problem">Problem</label>
            <textarea id="imp-f-problem" className="textarea" rows={3} value={form.problem} onChange={(e) => setForm({ ...form, problem: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="imp-f-expected">Expected outcome</label>
            <textarea id="imp-f-expected" className="textarea" rows={2} value={form.expectedOutcome} onChange={(e) => setForm({ ...form, expectedOutcome: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="imp-f-criteria">Success criteria</label>
            <textarea id="imp-f-criteria" className="textarea" rows={2} value={form.successCriteria} onChange={(e) => setForm({ ...form, successCriteria: e.target.value })} />
            <p className="hint">How you will measure it after release.</p>
          </div>
          <div className="imp-two">
            <div className="field">
              <label htmlFor="imp-f-priority">Priority</label>
              <select id="imp-f-priority" className="select" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                {['low', 'medium', 'high'].map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="imp-f-risk">Risk of the change</label>
              <select id="imp-f-risk" className="select" value={form.risk} onChange={(e) => setForm({ ...form, risk: e.target.value })}>
                {['low', 'medium', 'high'].map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="btn-row">
            <button type="submit" className="btn" disabled={busy}>
              Save
            </button>
            {saved && <span className="subtle">Saved.</span>}
          </div>
        </form>
      ) : (
        <dl className="imp-facts">
          <dt>Problem</dt>
          <dd>{i.problem}</dd>
          <dt>Expected outcome</dt>
          <dd>{i.expectedOutcome || '—'}</dd>
          <dt>Success criteria</dt>
          <dd>{i.successCriteria || '—'}</dd>
          {i.approver && (
            <>
              <dt>Approved</dt>
              <dd>
                by {i.approver} on {formatDate(i.approvedAt!)}
              </dd>
            </>
          )}
          {i.result && (
            <>
              <dt>Result</dt>
              <dd>{i.result}</dd>
            </>
          )}
          {i.measuredOutcome && (
            <>
              <dt>Measured outcome</dt>
              <dd>{i.measuredOutcome}</dd>
            </>
          )}
        </dl>
      )}

      {detail.dependencies.length > 0 && (
        <p className="subtle">
          Depends on {detail.dependencies.map((d) => `IMP-${d.number} (${STATUS_LABEL[d.status].toLowerCase()})`).join(', ')}
        </p>
      )}
      <p className="subtle" data-testid="recurrence">
        Recurrence: {detail.recurrence.sinceApproval === null ? detail.recurrence.note : `${detail.recurrence.sinceApproval} since approval. ${detail.recurrence.note}`}
      </p>

      {detail.allowed.length > 0 && (
        <div className="imp-moves" aria-label="Move the item">
          <h3 className="ref-subhead">Move</h3>
          <div className="btn-row">
            {detail.allowed.map((to) => (
              <button key={to} type="button" className={to === 'approved' && i.status === 'proposed' ? 'btn btn-primary' : 'btn'} disabled={busy} aria-pressed={moving === to} onClick={() => void move(to)}>
                {i.status === 'blocked' && to !== 'rejected' ? 'Unblock' : MOVE[to].label}
              </button>
            ))}
          </div>
          {i.status === 'proposed' && <p className="subtle">Approving records your decision. It does not change the app.</p>}
          {moving && moveNeeds && (
            <div className="field">
              <label htmlFor="imp-move-text">{moveNeeds.label}</label>
              <textarea id="imp-move-text" className="textarea" rows={2} value={moveText} onChange={(e) => setMoveText(e.target.value)} />
              <p className="hint">{moveNeeds.hint}</p>
              <div className="btn-row">
                <button type="button" className="btn btn-primary" disabled={busy || !moveText.trim()} onClick={() => void move(moving)}>
                  {i.status === 'blocked' && moving !== 'rejected' ? 'Unblock' : MOVE[moving].label}
                </button>
                <button type="button" className="btn" onClick={() => setMoving(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {(detail.builds.length > 0 || i.status === 'approved' || platformNote) && (
        <div aria-label="Platform work">
          <h3 className="ref-subhead">Platform work</h3>
          {platformNote && <Alert title="Build created">{platformNote}</Alert>}
          {detail.builds.map((b) => (
            <p key={b.id} className="subtle">
              {b.title}: {b.status.replace('_', ' ')}
            </p>
          ))}
          {detail.releases.map((r) => (
            <p key={r.id} className="subtle">
              In prepared release {r.version}
            </p>
          ))}
          {(i.status === 'approved' || (i.status === 'in_progress' && platform)) && detail.builds.every((b) => b.status === 'abandoned') && (
            <div className="btn-row">
              <button type="button" className="btn" disabled={busy} onClick={() => void buildPlatform()}>
                Build as platform work
              </button>
            </div>
          )}
          {i.status === 'approved' && <p className="hint">Builds it in a worktree of the app&rsquo;s source with the mandatory checks. The running app is not changed.</p>}
        </div>
      )}
      {detail.reopens && <p className="subtle">Reopens IMP-{detail.reopens.number}, which was released but did not have the intended effect.</p>}
      {detail.reopenedBy && <Alert tone="warn">Reopened as IMP-{detail.reopenedBy.number} ({STATUS_LABEL[detail.reopenedBy.status].toLowerCase()}): the measured outcome showed the problem was not solved.</Alert>}
      {i.status === 'released' && (
        <div aria-label="Measured outcome">
          <h3 className="ref-subhead">Did it work?</h3>
          {detail.measurements.length === 0 && <p className="muted">Not measured yet. Passing checks do not show the improvement happened.</p>}
          <ul className="upd-list">
            {detail.measurements.map((m) => (
              <li key={m.id}>
                <Badge tone={m.verdict === 'improved' ? 'ok' : m.verdict === 'not_improved' ? 'danger' : 'neutral'}>{m.verdict === 'improved' ? 'Improved' : m.verdict === 'not_improved' ? 'Not improved' : 'Too early'}</Badge> {m.detail}{' '}
                <span className="subtle">
                  ({formatDate(m.at)}, {m.method === 'person' ? `by ${m.actor}` : 'from the self-assessment'})
                </span>
              </li>
            ))}
          </ul>
          {(i.signature || i.reopens) && (
            <div className="btn-row">
              <button type="button" className="btn" disabled={busy} onClick={() => void act(() => call(iap().measureImprovement(i.id)))}>
                Measure from the records
              </button>
            </div>
          )}
          {!i.signature && !i.reopens && (
            <div className="field">
              <label htmlFor="imp-outcome">What you observed against the success criteria</label>
              <textarea id="imp-outcome" className="textarea" rows={2} value={outcome.detail} onChange={(e) => setOutcome({ ...outcome, detail: e.target.value })} />
              <div className="btn-row">
                <select className="select" aria-label="Outcome" value={outcome.verdict} onChange={(e) => setOutcome({ ...outcome, verdict: e.target.value as 'improved' | 'not_improved' })}>
                  <option value="improved">Improved</option>
                  <option value="not_improved">Not improved (reopen)</option>
                </select>
                <button type="button" className="btn" disabled={busy || outcome.detail.trim().length < 10} onClick={() => void act(() => call(iap().recordImprovementOutcome({ id: i.id, ...outcome })))}>
                  Record outcome
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <h3 className="ref-subhead">Evidence</h3>
      <ol className="imp-evidence">
        {i.evidence.map((e, n) => (
          <li key={n}>
            <span className="subtle">{formatDate(e.at)}</span> {e.summary}
            {e.occurrences.length > 0 && (
              <ul>
                {e.occurrences.slice(0, 4).map((o) => (
                  <li key={o.id} className="subtle">
                    {o.label}
                  </li>
                ))}
                {e.occurrences.length > 4 && <li className="subtle">and {e.occurrences.length - 4} more</li>}
              </ul>
            )}
          </li>
        ))}
      </ol>
      {detail.mergedFrom.length > 0 && <p className="subtle">Merged from {detail.mergedFrom.map((m) => `IMP-${m.number}`).join(', ')}.</p>}

      {!i.mergedInto && i.status !== 'released' && others.length > 0 && (
        <div className="field">
          <label htmlFor="imp-merge">Duplicate of</label>
          <div className="btn-row">
            <select id="imp-merge" className="select" value={mergeInto} onChange={(e) => setMergeInto(e.target.value)}>
              <option value="">Choose the item to keep</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  IMP-{o.number} {o.title}
                </option>
              ))}
            </select>
            <button type="button" className="btn" disabled={busy || !mergeInto} onClick={() => void act(() => call(iap().mergeImprovement({ id: i.id, into: mergeInto })))}>
              Merge
            </button>
          </div>
          <p className="hint">The evidence moves to the item you keep. Nothing is deleted.</p>
        </div>
      )}
    </section>
  );
}

export function IterativeView({ filter, onFilter, onOpenPreferences }: { filter: ImprovementFilter; onFilter: (f: ImprovementFilter) => void; onOpenPreferences: () => void }) {
  const [overview, setOverview] = useState<ImprovementsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [assessing, setAssessing] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [about, setAbout] = useState<'app' | 'work'>('app');
  const [proposed, setProposed] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setOverview(await call(iap().improvementsOverview()));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const assess = async () => {
    setAssessing(true);
    setError(null);
    try {
      await call(iap().runSelfAssessment());
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAssessing(false);
    }
  };

  const addIdea = async (event: FormEvent) => {
    event.preventDefault();
    setAdding(true);
    setError(null);
    try {
      setProposed(null);
      if (about === 'work') {
        // One feedback box, two stores (DEC-030): how the person wants work done is a preference, not an app improvement.
        const d = await call(iap().proposePreference({ text: feedback, fromFeedback: true }));
        setFeedback('');
        setProposed(d.preference.number);
        return;
      }
      const item = await call(iap().addFeedback({ text: feedback }));
      setFeedback('');
      await load();
      setSelected(item.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const items = overview?.items ?? [];
  const shown = filter === 'all' ? items : items.filter((i) => i.status === filter);

  return (
    <>
      <p className="eyebrow">Iterative Layer</p>
      <h1 className="page-title">
        Improve the app from its <span className="accent">own records</span>
      </h1>
      <p className="page-lede">
        The app reads what went wrong in its runs, agent tasks, builds, checks, assessments and tool scans, and proposes improvements. You decide what is approved. Approving an item records
        your decision; it does not change the app.
      </p>
      <ImproveDashboard counts={overview?.counts ?? null} />
      <div className="content-grid">
        <div>
          <div className="ref-toolbar glass">
            <select className="select" aria-label="Status" value={filter} onChange={(e) => onFilter(e.target.value as ImprovementFilter)}>
              <option value="all">All statuses</option>
              {(Object.keys(STATUS_LABEL) as ImprovementStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]} ({overview?.counts[s] ?? 0})
                </option>
              ))}
            </select>
            {overview && !overview.latest && <span className="subtle">Not assessed yet</span>}
            <button type="button" className="btn btn-primary" onClick={() => void assess()} disabled={assessing}>
              <Icon name="radar" size={16} /> {assessing ? 'Assessing…' : 'Run self-assessment'}
            </button>
          </div>
          {error && <Alert tone="danger">{error}</Alert>}
          {!overview && !error && <p className="loading">Loading improvements…</p>}
          {overview?.latest && <SelfAssessment record={overview.latest} />}

          <section className="section" aria-labelledby="backlog-title">
            <h2 className="section-title" id="backlog-title">
              Backlog <span className="count-pill">{shown.length}</span>
            </h2>
            {overview && shown.length === 0 && (
              <div className="card">
                <Empty title={filter === 'all' ? 'The backlog is empty' : `Nothing ${STATUS_LABEL[filter as ImprovementStatus].toLowerCase()}`}>
                  {filter === 'all' ? 'Run a self-assessment, or add an idea below.' : 'Choose another status to see more.'}
                </Empty>
              </div>
            )}
            {shown.length > 0 && (
              <ul className="imp-list" aria-label="Improvements">
                {shown.map((i) => (
                  <li key={i.id}>
                    <button type="button" className="run-tile imp-row" aria-current={selected === i.id ? 'true' : undefined} onClick={() => setSelected(i.id)}>
                      <span className="imp-num">IMP-{i.number}</span>
                      <span className="run-tile-title">{i.title}</span>
                      <span className="imp-badges">
                        <StatusBadge status={i.status} />
                        <Badge tone={LEVEL_TONE[i.priority]}>{i.priority}</Badge>
                        {i.evidence.length > 1 && <Badge tone="neutral">{i.evidence.length} times</Badge>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <form className="card" onSubmit={addIdea} aria-labelledby="feedback-title">
            <h2 className="card-title" id="feedback-title">
              Give feedback
            </h2>
            <div className="radio-row" role="radiogroup" aria-label="The feedback is about">
              <label className="radio-pill">
                <input type="radio" name="feedback-about" checked={about === 'app'} onChange={() => setAbout('app')} />
                The app
              </label>
              <label className="radio-pill">
                <input type="radio" name="feedback-about" checked={about === 'work'} onChange={() => setAbout('work')} />
                How I want work done
              </label>
            </div>
            <div className="field">
              <label htmlFor="imp-feedback">{about === 'app' ? 'What should work better?' : 'What would you like done differently?'}</label>
              <textarea id="imp-feedback" className="textarea" rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
              <p className="hint">
                {about === 'app'
                  ? 'It becomes an idea in the backlog. Add the expected outcome and success criteria before proposing it.'
                  : 'It becomes a proposed preference with your words as its source. Nothing is used until you approve the wording.'}
              </p>
            </div>
            {proposed !== null && (
              <Alert title={`Proposed as PREF-${proposed}`}>
                Approve or change the wording in Preferences.{' '}
                <button type="button" className="link-btn" onClick={onOpenPreferences}>
                  Open Preferences
                </button>
              </Alert>
            )}
            <div className="btn-row">
              <button type="submit" className="btn" disabled={adding || !feedback.trim()}>
                <Icon name="plus" size={16} /> {about === 'app' ? 'Add idea' : 'Propose preference'}
              </button>
            </div>
          </form>
        </div>
        <aside aria-label="Improvement details panel">
          {selected ? (
            <Inspector
              key={`${selected}:${overview?.latest?.id ?? ''}`}
              id={selected}
              items={items}
              onChanged={() => {
                void load();
              }}
              onClose={() => setSelected(null)}
            />
          ) : (
            <section className="card">
              <h2 className="card-title">How the backlog works</h2>
              <ol className="stages">
                {['Idea or finding', 'Proposed', 'Approved by you', 'In progress', 'Verified with a result', 'Released with a measured outcome'].map((s, n) => (
                  <li key={s}>
                    <span className="stage-num">{n + 1}</span>
                    {s}
                  </li>
                ))}
              </ol>
              <p className="muted">A problem that comes back adds evidence to the same item. Items are never deleted; duplicates are merged and kept.</p>
              <p className="muted">For items found by the self-assessment, the app counts how often the problem came back after approval.</p>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
