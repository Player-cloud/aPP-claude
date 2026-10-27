import { useEffect, useState, type FormEvent } from 'react';
import type { RunState, RunWithNext, Workflow } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Alert, Empty, formatTime, StateBadge, stateLabel } from '../ui.tsx';
import { useAsync } from '../useAsync.ts';

const WORKFLOWS: { id: Workflow; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'build', label: 'Build' },
  { id: 'design', label: 'Design & Animation' },
  { id: 'review', label: 'Check & Review' },
  { id: 'ship', label: 'Ship & Deploy' },
  { id: 'assess', label: 'Assessment' },
];

const FORWARD: RunState[] = ['draft', 'planned', 'approved', 'running', 'verification', 'awaiting_approval', 'completed'];

const ACTION_LABEL: Partial<Record<RunState, string>> = {
  planned: 'Mark planned',
  approved: 'Approve plan',
  running: 'Start',
  verification: 'Send to verification',
  awaiting_approval: 'Request approval',
  completed: 'Approve and complete',
  draft: 'Back to draft',
  cancelled: 'Cancel run',
};

function RunCard({ run, onChanged }: { run: RunWithNext; onChanged: () => void }) {
  const [mode, setMode] = useState<null | 'blocked' | 'failed'>(null);
  const [reason, setReason] = useState('');
  const [resolution, setResolution] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const move = async (to: RunState, extra: { reason?: string; resolution?: string } = {}) => {
    setBusy(true);
    setError(null);
    try {
      await call(iap().moveRun({ runId: run.id, to, ...extra }));
      setMode(null);
      setReason('');
      setResolution('');
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitIssue = (event: FormEvent) => {
    event.preventDefault();
    if (mode) void move(mode, { reason, resolution: mode === 'blocked' ? resolution : undefined });
  };

  const progress = run.state === 'blocked' ? FORWARD.indexOf(run.blockedFrom ?? 'draft') : FORWARD.indexOf(run.state);
  const label = (to: RunState) =>
    run.state === 'blocked' && to === run.blockedFrom ? `Resume (${stateLabel(to)})` : ACTION_LABEL[to] ?? stateLabel(to);
  const simple = run.next.filter((s) => s !== 'blocked' && s !== 'failed');

  return (
    <article className="run" aria-label={`${run.title}, ${stateLabel(run.state)}`}>
      <div className="run-head">
        <span className="run-title">{run.title}</span>
        <StateBadge state={run.state} />
        <span className="run-meta subtle">
          {WORKFLOWS.find((w) => w.id === run.workflow)?.label ?? run.workflow} · updated {formatTime(run.updatedAt)}
        </span>
      </div>
      {progress >= 0 && (
        <ol className="stepper" aria-label={`Step ${progress + 1} of ${FORWARD.length}`}>
          {FORWARD.map((s, i) => (
            <li key={s} data-done={i <= progress} title={stateLabel(s)} />
          ))}
        </ol>
      )}
      {run.state === 'blocked' && (
        <div className="run-blocker">
          <Alert tone="danger" title={`Blocked while ${stateLabel(run.blockedFrom ?? '').toLowerCase()}`}>
            <p>{run.blockerReason}</p>
            <p>
              <strong>To resolve:</strong> {run.blockerResolution}
            </p>
          </Alert>
        </div>
      )}
      {error && (
        <div className="run-blocker">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      {run.next.length > 0 && !mode && (
        <div className="run-actions btn-row">
          {simple.map((to) => (
            <button key={to} type="button" className={to === 'cancelled' ? 'btn btn-sm btn-danger' : 'btn btn-sm'} disabled={busy} onClick={() => void move(to)}>
              {label(to)}
            </button>
          ))}
          {run.next.includes('blocked') && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setMode('blocked')}>
              Report blocker
            </button>
          )}
          {run.next.includes('failed') && (
            <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => setMode('failed')}>
              Mark failed
            </button>
          )}
        </div>
      )}
      {mode && (
        <form className="run-actions" onSubmit={submitIssue}>
          <div className="field">
            <label htmlFor={`reason-${run.id}`}>{mode === 'blocked' ? 'What is blocking this run?' : 'Why did this run fail?'}</label>
            <textarea id={`reason-${run.id}`} className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </div>
          {mode === 'blocked' && (
            <div className="field">
              <label htmlFor={`resolution-${run.id}`}>How can it be resolved?</label>
              <textarea id={`resolution-${run.id}`} className="textarea" value={resolution} onChange={(e) => setResolution(e.target.value)} />
            </div>
          )}
          <div className="btn-row">
            <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
              {mode === 'blocked' ? 'Mark blocked' : 'Mark failed'}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setMode(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </article>
  );
}

export function ProjectDetail({ projectId, onLoaded }: { projectId: string; onLoaded: (name: string) => void }) {
  const project = useAsync(() => call(iap().getProject(projectId)), [projectId]);
  const runs = useAsync(() => call(iap().listRuns(projectId)), [projectId]);
  const [workflow, setWorkflow] = useState<Workflow>('plan');
  const [title, setTitle] = useState('');
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    if (project.data) onLoaded(project.data.name);
  }, [project.data, onLoaded]);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    setStartError(null);
    try {
      await call(iap().startRun({ projectId, workflow, title: title || undefined }));
      setTitle('');
      await runs.reload();
    } catch (e) {
      setStartError((e as Error).message);
    }
  };

  if (project.error) return <Alert tone="danger" title="Could not load project">{project.error}</Alert>;
  if (!project.data) return <p className="loading">Loading project…</p>;
  const p = project.data;
  const confirmed = p.facts.filter((f) => f.kind === 'confirmed');
  const assumptions = p.facts.filter((f) => f.kind === 'assumption');

  return (
    <>
      <h1 className="page-title">{p.name}</h1>
      <p className="page-lede">{p.idea ?? 'No idea recorded yet.'}</p>
      <div className="content-grid">
        <div>
          <section className="card" aria-labelledby="runs-title">
            <h2 className="card-title" id="runs-title">
              Workflow runs {runs.data && <span className="count">{runs.data.length}</span>}
            </h2>
            {runs.error && <Alert tone="danger">{runs.error}</Alert>}
            {runs.data && runs.data.length === 0 && <Empty title="No runs yet">Start a workflow run to track a piece of work through its states.</Empty>}
            {runs.data?.map((run) => <RunCard key={run.id} run={run} onChanged={() => void runs.reload()} />)}
          </section>
          <section className="card" aria-labelledby="facts-title">
            <h2 className="card-title" id="facts-title">
              What we know
            </h2>
            <div className="facts">
              <div>
                <h3 className="subtle">Confirmed ({confirmed.length})</h3>
                {confirmed.length ? (
                  <ul aria-label="Confirmed facts">{confirmed.map((f, i) => <li key={i}>{f.text}</li>)}</ul>
                ) : (
                  <p className="muted">Nothing confirmed yet.</p>
                )}
              </div>
              <div>
                <h3 className="subtle">Assumptions ({assumptions.length})</h3>
                {assumptions.length ? (
                  <ul aria-label="Assumptions">{assumptions.map((f, i) => <li key={i}>{f.text}</li>)}</ul>
                ) : (
                  <p className="muted">No open assumptions.</p>
                )}
              </div>
            </div>
          </section>
        </div>
        <aside aria-label="Project context">
          <section className="card" aria-labelledby="start-title">
            <h2 className="card-title" id="start-title">
              Start a run
            </h2>
            <form onSubmit={start}>
              {startError && <Alert tone="danger">{startError}</Alert>}
              <div className="field">
                <label htmlFor="run-workflow">Workflow</label>
                <select id="run-workflow" className="select" value={workflow} onChange={(e) => setWorkflow(e.target.value as Workflow)}>
                  {WORKFLOWS.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="run-title">Title</label>
                <input id="run-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Optional" />
              </div>
              <button type="submit" className="btn btn-primary">
                Start run
              </button>
            </form>
          </section>
          <section className="card" aria-labelledby="ws-title">
            <h2 className="card-title" id="ws-title">
              Workspace
            </h2>
            <dl className="kv">
              <dt>Status</dt>
              <dd>{p.status}</dd>
              <dt>Created</dt>
              <dd>{formatTime(p.createdAt)}</dd>
              <dt>Designs</dt>
              <dd className="mono">{p.docsPath}</dd>
              <dt>ID</dt>
              <dd className="mono">{p.id}</dd>
            </dl>
          </section>
        </aside>
      </div>
    </>
  );
}
