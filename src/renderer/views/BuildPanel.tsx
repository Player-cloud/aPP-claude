// Build work for one project (M6: FR-BUILD-001/002/003, DEC-020). Each
// feature or bug fix runs in its own git worktree. Check commands only run
// after the person approves them in a native dialog, results are shown as
// recorded (never inferred), and the review lists every risk it found.
import { useState, type FormEvent } from 'react';
import type { Build, BuildDetail, CheckRun, Diff, Project } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Alert, Badge, formatTime } from '../ui.tsx';
import { useAsync } from '../useAsync.ts';

type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

const STATUS: Record<Build['status'], { label: string; tone: Tone }> = {
  draft: { label: 'Not started', tone: 'neutral' },
  in_progress: { label: 'In progress', tone: 'info' },
  review: { label: 'Ready for review', tone: 'warn' },
  completed: { label: 'Done', tone: 'ok' },
  abandoned: { label: 'Abandoned', tone: 'neutral' },
};

const CHECK: Record<CheckRun['status'], { label: string; tone: Tone }> = {
  passed: { label: 'Passed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  timed_out: { label: 'Timed out', tone: 'danger' },
  error: { label: 'Could not run', tone: 'danger' },
  not_run: { label: 'Not run', tone: 'neutral' },
};

const PHASE: Record<CheckRun['phase'], string> = { baseline: 'Before', agent: 'Agent', verify: 'After' };

function RepoSetup({ project, onChanged }: { project: Project; onChanged: () => Promise<void> }) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setPath('');
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="build-repo">
      {project.repoPath ? (
        <p className="subtle">
          Repository: <span className="mono">{project.repoPath}</span>
        </p>
      ) : (
        <p className="subtle">Choose the git repository this project's code lives in. Work happens in separate worktrees, so your own checkout is never changed.</p>
      )}
      <form
        className="agent-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => call(iap().setProjectRepo({ projectId: project.id, path })));
        }}
      >
        <input className="input" aria-label="Repository folder" placeholder="Full path of a git repository" value={path} onChange={(e) => setPath(e.target.value)} />
        <button type="submit" className="btn btn-sm" disabled={busy || !path.trim()}>
          {project.repoPath ? 'Change' : 'Use this folder'}
        </button>
      </form>
      {!project.repoPath && (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(() => call(iap().initProjectRepo(project.id)))}>
          Start a repository in the project folder
        </button>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

export function parseChecks(text: string) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const at = l.indexOf('=');
      if (at < 1) throw new Error(`"${l}" must look like: unit = npm test`);
      return { id: l.slice(0, at).trim(), command: l.slice(at + 1).trim() };
    });
}
const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

function NewBuild({ projectId, specIds, onCreated }: { projectId: string; specIds: string[]; onCreated: () => Promise<void> }) {
  const [kind, setKind] = useState<'feature' | 'bugfix'>('bugfix');
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [repro, setRepro] = useState('');
  const [reqs, setReqs] = useState<string[]>([]);
  const [components, setComponents] = useState('');
  const [checks, setChecks] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call(
        iap().createBuild({
          projectId,
          kind,
          title,
          goal,
          repro: kind === 'bugfix' ? repro : null,
          requirementIds: reqs,
          components: lines(components),
          checks: parseChecks(checks),
        }),
      );
      setTitle('');
      setGoal('');
      setRepro('');
      setReqs([]);
      await onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="plan-editor build-new" aria-label="New build work" onSubmit={submit}>
      <div className="radio-row" role="radiogroup" aria-label="Kind of work">
        {(['bugfix', 'feature'] as const).map((k) => (
          <label key={k} className="radio-pill">
            <input type="radio" name="build-kind" checked={kind === k} onChange={() => setKind(k)} />
            {k === 'bugfix' ? 'Fix a bug' : 'Build a feature'}
          </label>
        ))}
      </div>
      <div className="field">
        <label htmlFor="b-title">Title</label>
        <input id="b-title" className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="b-goal">{kind === 'feature' ? 'What to build' : 'What is wrong'}</label>
        <textarea id="b-goal" className="textarea" rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} />
      </div>
      {kind === 'bugfix' && (
        <div className="field">
          <label htmlFor="b-repro">How to reproduce it</label>
          <textarea id="b-repro" className="textarea" rows={2} value={repro} onChange={(e) => setRepro(e.target.value)} />
        </div>
      )}
      {kind === 'feature' && (
        <fieldset className="plan-req">
          <legend>Requirements it implements</legend>
          {specIds.length === 0 && <p className="muted">Approve a specification first: a feature implements its requirements.</p>}
          {specIds.map((id) => (
            <label key={id} className="check-row">
              <input type="checkbox" checked={reqs.includes(id)} onChange={(e) => setReqs(e.target.checked ? [...reqs, id] : reqs.filter((r) => r !== id))} />
              <span className="mono">{id}</span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="field">
        <label htmlFor="b-components">Files or folders it should change (optional, one per line)</label>
        <textarea id="b-components" className="textarea" rows={2} value={components} onChange={(e) => setComponents(e.target.value)} placeholder="src/" />
      </div>
      <div className="field">
        <label htmlFor="b-checks">Check commands, one per line as id = command</label>
        <textarea id="b-checks" className="textarea mono" rows={2} value={checks} onChange={(e) => setChecks(e.target.value)} placeholder="unit = npm test" />
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="btn-row">
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
          Add
        </button>
      </div>
    </form>
  );
}

function Checks({ runs }: { runs: CheckRun[] }) {
  if (!runs.length) return <p className="muted">No checks have run yet.</p>;
  return (
    <ul className="build-checks" aria-label="Check results">
      {runs.map((r) => (
        <li key={r.seq}>
          <details>
            <summary>
              <span className="build-phase">{PHASE[r.phase]}</span>
              <Badge tone={CHECK[r.status].tone}>{CHECK[r.status].label}</Badge>
              <span className="mono">{r.checkId}</span>
              <span className="subtle">
                exit {r.exitCode ?? '-'} · {Math.max(1, Math.round(r.durationMs / 1000))} s · {formatTime(r.startedAt)}
              </span>
            </summary>
            <p className="mono build-cmd">{r.command}</p>
            <pre className="agent-output">{r.output || '(no output)'}</pre>
          </details>
        </li>
      ))}
    </ul>
  );
}

function BuildCard({ build, onChanged }: { build: Build; onChanged: () => Promise<void> }) {
  const detail = useAsync(() => call(iap().getBuild(build.id)), [build.id, build.updatedAt]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [diff, setDiff] = useState<Diff | null>(null);
  const d: BuildDetail | null = detail.data;
  const b = d?.build ?? build;
  const open = b.status !== 'completed' && b.status !== 'abandoned';

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      setDiff(null);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <details className="finding build-card" open={open}>
      <summary>
        <Badge tone={STATUS[b.status].tone}>{STATUS[b.status].label}</Badge>
        <span className="finding-title">{b.title}</span>
        <span className="pill">{b.kind === 'feature' ? 'Feature' : 'Bug fix'}</span>
      </summary>
      <div className="finding-body">
        <p>{b.goal}</p>
        {b.requirementIds.length > 0 && <p className="subtle">Requirements: {b.requirementIds.join(', ')}</p>}
        {b.repro && (
          <p className="subtle">
            <strong>Reproduce:</strong> {b.repro}
          </p>
        )}
        <p className="subtle">
          Checks: {b.checks.map((c) => (
            <span key={c.id} className="mono build-cmd">
              {c.id}: {c.command}
            </span>
          ))}
        </p>
        {b.branch && (
          <p className="subtle">
            Branch <span className="mono">{b.branch}</span> in <span className="mono">{b.worktree}</span>
          </p>
        )}
        {d && <Checks runs={d.checkRuns} />}
        {b.agent && (
          <>
            <h4>
              Agent {b.agent.model === 'simulated' ? <span className="pill">Simulated</span> : <span className="pill">{b.agent.model}</span>}
            </h4>
            <p className="subtle">
              {b.agent.status === 'done' ? 'Finished' : b.agent.status.replace('_', ' ')}: {b.agent.steps.length} tool calls, files written: {b.agent.filesWritten.join(', ') || 'none'}
              {b.agent.costUsd > 0 && `, $${b.agent.costUsd.toFixed(2)}`}
            </p>
            <pre className="agent-output">{b.agent.summary}</pre>
            {b.agent.resolution && <p className="subtle">{b.agent.resolution}</p>}
          </>
        )}
        {b.changedFiles && (
          <>
            <h4>Changed files</h4>
            {b.changedFiles.length ? (
              <ul className="small-list">
                {b.changedFiles.map((f) => (
                  <li key={f.path}>
                    <span className="mono">{f.path}</span> {f.status} (+{f.added} -{f.removed})
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Nothing changed.</p>
            )}
          </>
        )}
        {b.risks && (
          <>
            <h4>Review</h4>
            {b.risks.length ? (
              <ul className="small-list build-risks" aria-label="Risks">
                {b.risks.map((r, i) => (
                  <li key={i}>
                    <Badge tone={r.kind === 'regression' || r.kind === 'weakened_test' || r.kind === 'deleted_test' ? 'danger' : 'warn'}>{r.kind.replace(/_/g, ' ')}</Badge> {r.detail}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="subtle">No risks found by the automatic review.</p>
            )}
          </>
        )}
        {b.note && <p className="subtle">Note: {b.note}</p>}
        {diff && <pre className="agent-output build-diff">{diff.patch || 'No changes.'}</pre>}
        {(error || detail.error) && <Alert tone="danger">{error ?? detail.error}</Alert>}
        {b.status === 'review' && (
          <div className="field">
            <label htmlFor={`${b.id}-note`}>{b.risks?.length ? 'Why the remaining risks are acceptable (required)' : 'Note (optional)'}</label>
            <input id={`${b.id}-note`} className="input" value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} />
          </div>
        )}
        {open && (
          <div className="btn-row">
            {b.status === 'draft' && (
              <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => void act('start', () => call(iap().startBuild(b.id)))}>
                {busy === 'start' ? 'Running checks…' : 'Start and run checks'}
              </button>
            )}
            {(b.status === 'in_progress' || b.status === 'review') && (
              <>
                <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void act('agent', () => call(iap().runBuildAgent(b.id)))}>
                  {busy === 'agent' ? 'Agent working…' : 'Run the agent'}
                </button>
                <button type="button" className={`btn btn-sm${b.status === 'in_progress' ? ' btn-primary' : ''}`} disabled={busy !== null} onClick={() => void act('verify', () => call(iap().verifyBuild(b.id)))}>
                  {busy === 'verify' ? 'Verifying…' : b.status === 'review' ? 'Verify again' : 'Verify'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy !== null}
                  onClick={() => {
                    setError(null);
                    call(iap().buildDiff(b.id)).then(setDiff, (e: Error) => setError(e.message));
                  }}
                >
                  Show diff
                </button>
              </>
            )}
            {b.status === 'review' && (
              <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => void act('done', () => call(iap().completeBuild({ buildId: b.id, note })))}>
                Mark done
              </button>
            )}
            <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void act('abandon', () => call(iap().abandonBuild({ buildId: b.id, reason: note || null })))}>
              Abandon
            </button>
          </div>
        )}
        {b.reportPath && (
          <p className="subtle">
            Report: <span className="mono">{b.reportPath}</span>
          </p>
        )}
        {b.status === 'completed' && <p className="subtle">The change is on its own branch. Review it and merge it yourself.</p>}
      </div>
    </details>
  );
}

export function BuildPanel({ project, onProjectChanged, onChanged }: { project: Project; onProjectChanged: () => Promise<void>; onChanged?: () => void }) {
  const builds = useAsync(() => call(iap().listBuilds(project.id)), [project.id]);
  const planning = useAsync(() => call(iap().getPlanning(project.id)), [project.id]);
  const [adding, setAdding] = useState(false);
  const spec = planning.data?.spec.approved;
  const specIds = spec?.kind === 'spec' ? spec.content.requirements.map((r) => r.id) : [];
  const reload = async () => {
    await builds.reload();
    onChanged?.();
  };

  return (
    <section className="card" id="phase-build" aria-labelledby="build-title">
      <h2 className="card-title" id="build-title">
        Build work {builds.data && builds.data.length > 0 && <span className="count-pill">{builds.data.length}</span>}
      </h2>
      <RepoSetup project={project} onChanged={onProjectChanged} />
      {builds.error && <Alert tone="danger">{builds.error}</Alert>}
      {project.repoPath && !adding && (
        <div className="btn-row">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>
            New feature or bug fix
          </button>
        </div>
      )}
      {adding && (
        <NewBuild
          projectId={project.id}
          specIds={specIds}
          onCreated={async () => {
            setAdding(false);
            await reload();
          }}
        />
      )}
      {builds.data && builds.data.length > 0 && (
        <div className="findings">
          {builds.data.map((b) => (
            <BuildCard key={b.id} build={b} onChanged={reload} />
          ))}
        </div>
      )}
    </section>
  );
}
