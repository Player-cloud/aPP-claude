import { useEffect, useState, type FormEvent } from 'react';
import type { AgentStatus, Build, PlanningOverview, Project, Release, RunState, RunWithNext, Workflow } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Icon } from '../icons.tsx';
import { AgentPanel } from './AgentPanel.tsx';
import { PlanningPanel } from './PlanningPanel.tsx';
import { BuildPanel } from './BuildPanel.tsx';
import { ReleasePanel } from './ReleasePanel.tsx';
import { AssessmentPanel } from './AssessmentPanel.tsx';
import { Composer, TodoItems, WorkList, WorkView } from './BuildView.tsx';
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
function phasesFor(planning: PlanningOverview | null, builds: Build[] | null, runs: RunWithNext[] | null, releases: Release[] | null): Phase[] {
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
  // Deploying is not built yet, so Ship is never "done": a prepared release is shown as not deployed.
  const latest = releases?.[0];
  const ship: Phase = {
    id: 'ship',
    label: 'Ship & Deploy',
    target: 'phase-ship',
    state: latest && (latest.status === 'draft' || latest.status === 'checked') ? 'active' : 'idle',
    detail: !releases
      ? 'Loading'
      : !latest
        ? runSummary(of('ship'))
        : latest.status === 'prepared'
          ? `${latest.version} prepared · not deployed`
          : latest.status === 'checked'
            ? `${latest.version} ${latest.ready ? 'ready to prepare' : 'blocked by gates'}`
            : `${latest.version} ${latest.status === 'draft' ? 'not checked' : 'abandoned'}`,
  };
  return [plan, build, later('design', 'Design & Animation'), later('review', 'Check & Review'), ship];
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
function nextStep(project: Project, planning: PlanningOverview | null, runs: RunWithNext[] | null, assessed: boolean | null, builds: Build[] | null): { title: string; detail: string; target: string } | null {
  if (!planning || !runs || assessed === null || !builds) return null;
  if (project.kind === 'maintenance') return { title: 'Build an approved platform item', detail: 'Platform work starts from an approved improvement or update. It runs in a worktree of the app\u2019s source; the running app is not changed.', target: 'phase-build' };
  if (project.origin === 'imported' && !assessed) return { title: 'Assess the repository', detail: 'See what the imported code already has, read-only, before planning changes.', target: 'phase-assess' };
  const waiting = runs.filter((r) => needsPerson(r.state));
  if (waiting.length > 0)
    return {
      title: `${waiting.length} ${waiting.length === 1 ? 'run needs' : 'runs need'} your decision`,
      detail: waiting.map((r) => `${r.title} (${stateLabel(r.state).toLowerCase()})`).join(', '),
      target: 'runs-title',
    };
  const toReview = builds.filter((b) => b.status === 'review');
  if (toReview.length) return { title: `${toReview.length} ${toReview.length === 1 ? 'task is' : 'tasks are'} ready to review`, detail: toReview.map((b) => b.title).join(', '), target: 'project-work' };
  if (planning.specOutdated) return { title: 'Update the specification', detail: 'The brief changed after the spec was approved.', target: 'phase-plan' };
  if (builds.length === 0) return { title: 'Describe your first task', detail: 'Type what you want built in the box above. Planning a brief and specification first is optional.', target: 'project-work' };
  return { title: 'Describe the next task', detail: 'Or plan the project first: the brief and specification are optional.', target: 'project-work' };
}

export function ProjectDetail({ projectId, onLoaded, agent }: { projectId: string; onLoaded: (name: string) => void; agent?: AgentStatus | null }) {
  const [openBuild, setOpenBuild] = useState<string | null>(null);
  // Folded away unless opened, or a run is waiting for the person.
  const [trackerOpen, setTrackerOpen] = useState(false);
  const project = useAsync(() => call(iap().getProject(projectId)), [projectId]);
  const runs = useAsync(() => call(iap().listRuns(projectId)), [projectId]);
  const planning = useAsync(() => call(iap().getPlanning(projectId)), [projectId]);
  const builds = useAsync(() => call(iap().listBuilds(projectId)), [projectId]);
  const todos = useAsync(() => call(iap().listTodos({ projectId, status: 'open' })), [projectId]);
  const releases = useAsync(() => call(iap().listReleases(projectId)), [projectId]);
  const assessments = useAsync(() => call(iap().listAssessments(projectId)), [projectId]);
  const references = useAsync(() => call(iap().listReferences({ projectId })), [projectId]);
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
  const next = nextStep(p, planning.data, runs.data, assessments.data ? assessments.data.some((a) => a.status === 'completed') : null, builds.data);
  const assessmentPanel = <AssessmentPanel project={p} onChanged={() => void assessments.reload()} />;

  if (openBuild)
    return (
      <WorkView
        buildId={openBuild}
        onBack={() => setOpenBuild(null)}
        onChanged={() => {
          void builds.reload();
          void todos.reload();
        }}
        onOpenTask={setOpenBuild}
      />
    );

  return (
    <>
      <h1 className="page-title">
        {p.name} {p.kind === 'maintenance' && <span className="pill">Platform maintenance</span>}
      </h1>
      <p className="page-lede">{p.idea ?? 'No idea recorded yet.'}</p>
      {p.kind !== 'maintenance' && (
        <section id="project-work" className="project-work" aria-label="Tasks">
          <Composer projects={[p]} projectId={p.id} agent={agent ?? null} onStarted={(b) => setOpenBuild(b.id)} />
          {builds.data && builds.data.length > 0 && <WorkList builds={builds.data.map((b) => ({ ...b, projectName: p.name, running: false }))} onOpen={setOpenBuild} showProject={false} />}
          {todos.data && todos.data.length > 0 && (
            <section className="card project-todos" aria-labelledby="todos-title">
              <h2 className="card-title" id="todos-title">
                Left to do <span className="count-pill">{todos.data.length}</span>
              </h2>
              <TodoItems
                todos={todos.data}
                label="Left to do"
                onChanged={() => void todos.reload()}
                onOpenTask={(id) => {
                  void builds.reload();
                  setOpenBuild(id);
                }}
                taskTitle={(id) => builds.data?.find((b) => b.id === id)?.title}
              />
            </section>
          )}
        </section>
      )}
      <PhaseStepper phases={phasesFor(planning.data, builds.data, runs.data, releases.data)} />
      <div className="content-grid">
        <div>
          {p.kind === 'maintenance' && (
            <Alert tone="info" title="This project is the app itself">
              Work here starts from an approved improvement or update and runs in a worktree of <span className="mono">{p.repoPath}</span>. It ships only as a new version that you install. Backups, known-good versions and the
              protected areas are on the Platform page.
            </Alert>
          )}
          {p.origin === 'imported' && p.kind !== 'maintenance' && assessmentPanel}
          {p.kind !== 'maintenance' && <PlanningPanel projectId={p.id} onChanged={() => void planning.reload()} />}
          <BuildPanel project={p} onProjectChanged={async () => void (await project.reload())} onChanged={() => void builds.reload()} />
          <ReleasePanel project={p} onChanged={() => void releases.reload()} />
          {p.origin !== 'imported' && assessmentPanel}
          <details className="card run-tracker" open={trackerOpen || Boolean(runs.data?.some((r) => needsPerson(r.state)))} onToggle={(e) => setTrackerOpen(e.currentTarget.open)}>
            <summary>
              <h2 className="card-title" id="runs-title">
                Run tracker (optional) {runs.data && <span className="count-pill">{runs.data.length}</span>}
              </h2>
            </summary>
            <p className="subtle">A manual checklist for your own stages of work. Claude's work happens in the tasks above; moving a run does not start or change any task.</p>
            {runs.error && <Alert tone="danger">{runs.error}</Alert>}
            {runs.data && runs.data.length === 0 && <Empty title="No runs yet">Start a workflow run to track a piece of work through its states.</Empty>}
            {runs.data && runs.data.length > 0 && (
              <div className="run-grid">
                {runs.data.map((run) => (
                  <RunCard key={run.id} run={run} onChanged={() => void runs.reload()} />
                ))}
              </div>
            )}
          <section className="run-start" aria-labelledby="start-title">
              <h3 className="subtle" id="start-title">
                Start a run
              </h3>
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
          </details>
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
          {references.data && references.data.length > 0 && (
            <section className="card" aria-labelledby="refs-title">
              <h2 className="card-title" id="refs-title">
                Design references <span className="count-pill">{references.data.length}</span>
              </h2>
              <ul className="ref-strip" aria-label="Linked design references">
                {references.data.slice(0, 6).map((r) => (
                  <li key={r.id} title={r.title}>
                    {r.mediaType.startsWith('image/') ? <img src={`iap-ref://ref/${r.id}`} alt={r.title} loading="lazy" /> : <span className="ref-strip-video">{r.title}</span>}
                  </li>
                ))}
              </ul>
              <p className="subtle">Linked in the Learning Studio. References inform design work; they never change this project's specification.</p>
            </section>
          )}
          <section className="card card-glass" aria-labelledby="ws-title">
            <h2 className="card-title" id="ws-title">
              Workspace
            </h2>
            <dl className="kv">
              <dt>Status</dt>
              <dd>{p.status}</dd>
              <dt>{p.origin === 'imported' ? 'Imported' : 'Created'}</dt>
              <dd>{formatTime(p.createdAt)}</dd>
              {p.repoPath && (
                <>
                  <dt>Repository</dt>
                  <dd className="mono">{p.repoPath}</dd>
                </>
              )}
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
