import { useEffect, useState, type FormEvent } from 'react';
import type { Build, PlanningOverview, Project, RunState, RunWithNext, Workflow } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Icon } from '../icons.tsx';
import { AgentPanel } from './AgentPanel.tsx';
import { PlanningPanel } from './PlanningPanel.tsx';
import { BuildPanel } from './BuildPanel.tsx';
import { Alert, Empty, formatDate, formatTime, needsPerson, StateBadge, stateLabel } from '../ui.tsx';
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
        <div>
          <h3 className="run-title">{run.title}</h3>
          <p className="run-sub">{WORKFLOWS.find((w) => w.id === run.workflow)?.label ?? run.workflow} workflow</p>
        </div>
        <StateBadge state={run.state} />
      </div>
      {progress >= 0 && (
        <div className="progress-row">
          <div className="progress-label">
            <span>
              <Icon name="list" size={14} /> Progress
            </span>
            <span>
              {progress + 1}/{FORWARD.length}
            </span>
          </div>
          <div
            className="progress"
            data-tone={run.state === 'blocked' || run.state === 'failed' ? 'danger' : run.state === 'completed' ? 'ok' : 'accent'}
            role="progressbar"
            aria-label={`Step ${progress + 1} of ${FORWARD.length}: ${stateLabel(FORWARD[progress]!)}`}
            aria-valuemin={1}
            aria-valuemax={FORWARD.length}
            aria-valuenow={progress + 1}
          >
            <span style={{ width: `${((progress + 1) / FORWARD.length) * 100}%` }} />
          </div>
        </div>
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
      <AgentPanel run={run} />
      <div className="run-foot">
        <span className="pill" title={`Updated ${formatTime(run.updatedAt)}`}>
          <Icon name="calendar" size={14} /> {formatDate(run.updatedAt)}
        </span>
        {run.next.length > 0 && !mode && (
          <div className="btn-row">
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
      </div>
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

type PhaseState = 'done' | 'current' | 'active' | 'idle';

interface Phase {
  id: string;
  label: string;
  state: PhaseState;
  detail: string;
  target: string;
}

const runSummary = (list: RunWithNext[]) => {
  if (list.length === 0) return 'Not started';
  const open = list.filter((r) => !['completed', 'failed', 'cancelled'].includes(r.state));
  if (open.length > 0) return `${open.length} open · ${stateLabel(open[0]!.state)}`;
  return `${list.filter((r) => r.state === 'completed').length} of ${list.length} completed`;
};

/** The lifecycle as recorded: a phase is only marked done when its own records say so. */
function phasesFor(planning: PlanningOverview | null, builds: Build[] | null, runs: RunWithNext[] | null): Phase[] {
  const of = (w: Workflow) => runs?.filter((r) => r.workflow === w) ?? [];
  const specApproved = !!planning?.spec.approved;
  const plan: Phase = {
    id: 'plan',
    label: 'Plan',
    target: 'phase-plan',
    state: specApproved ? 'done' : 'current',
    detail: !planning
      ? 'Loading'
      : specApproved
        ? `Spec v${planning.spec.approved!.version} approved`
        : planning.brief.approved
          ? 'Brief approved · spec next'
          : planning.brief.draft
            ? 'Brief in draft'
            : runSummary(of('plan')),
  };
  const openBuilds = builds?.filter((b) => b.status === 'draft' || b.status === 'in_progress' || b.status === 'review') ?? [];
  const doneBuilds = builds?.filter((b) => b.status === 'completed') ?? [];
  const build: Phase = {
    id: 'build',
    label: 'Build',
    target: 'phase-build',
    state: specApproved ? 'current' : openBuilds.length > 0 ? 'active' : 'idle',
    detail: !builds ? 'Loading' : builds.length === 0 ? 'Not started' : `${openBuilds.length} open · ${doneBuilds.length} done`,
  };
  const later = (id: Workflow, label: string): Phase => {
    const list = of(id);
    const open = list.some((r) => !['completed', 'failed', 'cancelled'].includes(r.state));
    return { id, label, target: 'runs-title', state: open ? 'active' : 'idle', detail: runSummary(list) };
  };
  return [plan, build, later('design', 'Design & Animation'), later('review', 'Check & Review'), later('ship', 'Ship & Deploy')];
}

function PhaseStepper({ phases }: { phases: Phase[] }) {
  return (
    <nav className="phases" aria-label="Project phases">
      <ol>
        {phases.map((p, i) => (
          <li key={p.id}>
            <button
              type="button"
              className="phase"
              data-state={p.state}
              aria-current={p.state === 'current' ? 'step' : undefined}
              onClick={() => document.getElementById(p.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              <span className="phase-mark" aria-hidden="true">
                {p.state === 'done' ? <Icon name="check" size={14} /> : i + 1}
              </span>
              <span className="phase-text">
                <span className="phase-label">{p.label}</span>
                <span className="phase-detail">
                  {p.state === 'done' && <span className="visually-hidden">Done: </span>}
                  {p.detail}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** One safe next action, worked out from the project's records. */
function nextStep(project: Project, planning: PlanningOverview | null, runs: RunWithNext[] | null): { title: string; detail: string; target: string } | null {
  if (!planning || !runs) return null;
  const waiting = runs.filter((r) => needsPerson(r.state));
  if (waiting.length > 0)
    return {
      title: `${waiting.length} ${waiting.length === 1 ? 'run needs' : 'runs need'} your decision`,
      detail: waiting.map((r) => `${r.title} (${stateLabel(r.state).toLowerCase()})`).join(', '),
      target: 'runs-title',
    };
  if (!planning.brief.approved) return { title: 'Approve the concept brief', detail: 'Draft it, fill the placeholders and approve it.', target: 'phase-plan' };
  if (!planning.spec.approved) return { title: 'Approve the specification', detail: 'The brief is approved. Draft the specification next.', target: 'phase-plan' };
  if (planning.specOutdated) return { title: 'Update the specification', detail: 'The brief changed after the spec was approved.', target: 'phase-plan' };
  if (!project.repoPath) return { title: 'Choose a repository', detail: 'Build work needs the git repository this project lives in.', target: 'phase-build' };
  return { title: 'Start a feature or bug fix', detail: 'Planning is approved and a repository is set.', target: 'phase-build' };
}

export function ProjectDetail({ projectId, onLoaded }: { projectId: string; onLoaded: (name: string) => void }) {
  const project = useAsync(() => call(iap().getProject(projectId)), [projectId]);
  const runs = useAsync(() => call(iap().listRuns(projectId)), [projectId]);
  const planning = useAsync(() => call(iap().getPlanning(projectId)), [projectId]);
  const builds = useAsync(() => call(iap().listBuilds(projectId)), [projectId]);
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
  const next = nextStep(p, planning.data, runs.data);

  return (
    <>
      <h1 className="page-title">{p.name}</h1>
      <p className="page-lede">{p.idea ?? 'No idea recorded yet.'}</p>
      <PhaseStepper phases={phasesFor(planning.data, builds.data, runs.data)} />
      <div className="content-grid">
        <div>
          <PlanningPanel projectId={p.id} onChanged={() => void planning.reload()} />
          <BuildPanel project={p} onProjectChanged={async () => void (await project.reload())} onChanged={() => void builds.reload()} />
          <section className="card" aria-labelledby="runs-title">
            <h2 className="card-title" id="runs-title">
              Workflow runs {runs.data && <span className="count-pill">{runs.data.length}</span>}
            </h2>
            {runs.error && <Alert tone="danger">{runs.error}</Alert>}
            {runs.data && runs.data.length === 0 && <Empty title="No runs yet">Start a workflow run to track a piece of work through its states.</Empty>}
            {runs.data && runs.data.length > 0 && (
              <div className="run-grid">
                {runs.data.map((run) => (
                  <RunCard key={run.id} run={run} onChanged={() => void runs.reload()} />
                ))}
              </div>
            )}
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
        <aside className="context-col inspector" aria-label="Project context">
          {next && (
            <section className="card card-glass next-step" aria-labelledby="next-title">
              <p className="eyebrow">Next step</p>
              <h2 className="card-title" id="next-title">
                {next.title}
              </h2>
              <p className="muted">{next.detail}</p>
              <button type="button" className="btn btn-sm" onClick={() => document.getElementById(next.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                Go there
              </button>
            </section>
          )}
          <section className="card card-glass" aria-labelledby="start-title">
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
          <section className="card card-glass" aria-labelledby="ws-title">
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
