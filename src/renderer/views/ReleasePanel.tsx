// Releases for one project (M7: FR-QA-001, FR-QA-004, FR-SHIP-001, DEC-022).
// The ship-check runs the person's release checks on the repository's current
// commit, after they approve the commands in a native dialog. Every gate shows
// the evidence it was decided on. A failed gate can only be passed by a recorded
// exception with a mitigation. Preparing a release never deploys it; a
// prepared release with a deploy command can be deployed after a native
// approval, with its health checked and a rollback ready (M20, DEC-038).
import { useState, type FormEvent } from 'react';
import type { Build, DeploymentDetail, DeploymentStatus, DriftFinding, Gate, Project, Release, ReleaseDetail } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Alert, Badge, formatTime, type Tone } from '../ui.tsx';
import { useAsync } from '../useAsync.ts';
import { parseChecks } from './BuildPanel.tsx';

const STATUS: Record<Release['status'], { label: string; tone: Tone }> = {
  draft: { label: 'Not checked', tone: 'neutral' },
  checked: { label: 'Checked', tone: 'info' },
  prepared: { label: 'Prepared, not deployed', tone: 'ok' },
  abandoned: { label: 'Abandoned', tone: 'neutral' },
};

const GATE: Record<Gate['status'], { label: string; tone: Tone }> = {
  passed: { label: 'Passed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'warn' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};

const DRIFT: Record<DriftFinding['kind'], string> = {
  defect: 'Defect',
  missing_requirement: 'Missing requirement',
  intentional_deviation: 'Intentional deviation',
  spec_change: 'Spec change',
  optional_improvement: 'Optional improvement',
};

const lines = (text: string) => text.split(/[\n,]/).map((l) => l.trim()).filter(Boolean);

function NewRelease({ projectId, builds, platform, onCreated }: { projectId: string; builds: Build[]; platform: boolean; onCreated: () => Promise<void> }) {
  const [version, setVersion] = useState('');
  const [checks, setChecks] = useState('');
  const [included, setIncluded] = useState<string[]>(builds.filter((b) => b.status === 'completed').map((b) => b.id));
  const [target, setTarget] = useState('');
  const [healthCheck, setHealthCheck] = useState('');
  const [rollback, setRollback] = useState('');
  const [monitoring, setMonitoring] = useState('');
  const [migrations, setMigrations] = useState('');
  const [envVars, setEnvVars] = useState('');
  const [environment, setEnvironment] = useState('');
  const [deployCommand, setDeployCommand] = useState('');
  const [health, setHealth] = useState('');
  const [rollbackCommand, setRollbackCommand] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const choosable = builds.filter((b) => b.status !== 'abandoned');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call(
        iap().createRelease({
          projectId,
          version,
          checks: parseChecks(checks),
          buildIds: included,
          plan: {
            target,
            healthCheck,
            rollback,
            monitoring,
            migrations,
            envVars: lines(envVars),
            environment,
            deployCommand,
            ...(/^https?:\/\//i.test(health.trim()) ? { healthUrl: health.trim() } : { healthCommand: health }),
            rollbackCommand,
          },
        }),
      );
      await onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const text = (id: string, label: string, value: string, set: (v: string) => void, placeholder?: string) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="input" value={value} maxLength={2000} placeholder={placeholder} onChange={(e) => set(e.target.value)} />
    </div>
  );

  return (
    <form className="plan-editor build-new" aria-label="New release" onSubmit={submit}>
      {text('r-version', 'Version', version, setVersion, '1.0.0')}
      <fieldset className="plan-req">
        <legend>Work it includes</legend>
        {choosable.length === 0 && <p className="muted">No features or bug fixes yet.</p>}
        {choosable.map((b) => (
          <label key={b.id} className="check-row">
            <input type="checkbox" checked={included.includes(b.id)} onChange={(e) => setIncluded(e.target.checked ? [...included, b.id] : included.filter((x) => x !== b.id))} />
            {b.title} <span className="subtle">({b.status === 'completed' ? 'done' : b.status.replace('_', ' ')})</span>
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor="r-checks">{platform ? 'Extra release checks (optional), one per line as id = command' : 'Release checks, one per line as id = command'}</label>
        <textarea id="r-checks" className="textarea mono" rows={2} value={checks} onChange={(e) => setChecks(e.target.value)} placeholder={platform ? 'lint = npm run lint' : 'unit = npm test'} />
        {platform && <p className="hint">The app's release checks always run: npm ci, npm run typecheck, npm test, npm run test:e2e and npm audit. Leave the plan below empty to use the platform plan: install it yourself, roll back to the known-good version and your database backup.</p>}
      </div>
      {text('r-target', 'Where it goes', target, setTarget, 'Windows installer on GitHub Releases')}
      {text('r-health', 'How you will know it works', healthCheck, setHealthCheck, 'Install it and open a project')}
      {text('r-rollback', 'How to undo it', rollback, setRollback, 'Re-publish the previous installer')}
      {text('r-monitoring', 'Monitoring (optional)', monitoring, setMonitoring)}
      {text('r-migrations', 'Data migrations (optional)', migrations, setMigrations, 'none')}
      {text('r-env', 'Configuration names it needs (optional, names only)', envVars, setEnvVars, 'ANTHROPIC_API_KEY')}
      {!platform && (
        <fieldset className="plan-req">
          <legend>Let the app deploy it (optional)</legend>
          <p className="hint">Leave these empty to deploy it yourself. With a deploy command, the app can run it once the release is prepared and you approve, then checks it works and keeps the rollback ready.</p>
          {text('r-environment', 'Environment', environment, setEnvironment, 'production')}
          {text('r-deploy', 'Deploy command', deployCommand, setDeployCommand, 'npm run deploy')}
          {text('r-healthcmd', 'Health check: an address or a command', health, setHealth, 'https://example.com/health')}
          {text('r-rollbackcmd', 'Rollback command', rollbackCommand, setRollbackCommand, 'npm run deploy:previous')}
        </fieldset>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="btn-row">
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
          Add release
        </button>
      </div>
    </form>
  );
}

function ExceptionForm({ gate, onSubmit }: { gate: Gate; onSubmit: (reason: string, mitigation: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [mitigation, setMitigation] = useState('');
  const id = `ex-${gate.id}`;
  return (
    <details className="release-exception">
      <summary>Release anyway with an exception</summary>
      <div className="field">
        <label htmlFor={`${id}-reason`}>Why this is acceptable</label>
        <input id={`${id}-reason`} className="input" value={reason} maxLength={4000} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-mitigation`}>How you will limit the risk</label>
        <input id={`${id}-mitigation`} className="input" value={mitigation} maxLength={4000} onChange={(e) => setMitigation(e.target.value)} />
      </div>
      <p className="subtle">The exception is kept in the audit log for good.</p>
      <button type="button" className="btn btn-sm" onClick={() => void onSubmit(reason, mitigation)}>
        Record exception
      </button>
    </details>
  );
}

function Classify({ finding, onSubmit }: { finding: DriftFinding; onSubmit: (kind: 'intentional_deviation' | 'spec_change', note: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  if (finding.kind !== 'defect' && finding.kind !== 'missing_requirement') return null;
  return (
    <span className="release-classify">
      <input className="input" aria-label={`Note for ${finding.requirementId}`} placeholder="Why (at least 10 characters)" value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} />
      <button type="button" className="btn btn-sm" onClick={() => void onSubmit('intentional_deviation', note)}>
        Deliberate
      </button>
      <button type="button" className="btn btn-sm" onClick={() => void onSubmit('spec_change', note)}>
        Spec will change
      </button>
    </span>
  );
}

function Gates({ detail, open, platform, act }: { detail: ReleaseDetail; open: boolean; platform: boolean; act: (label: string, fn: () => Promise<unknown>) => Promise<void> }) {
  const r = detail.release;
  if (!r.gates) return <p className="muted">The ship-check has not run since this release was last changed.</p>;
  return (
    <ul className="release-gates" aria-label="Gates">
      {r.gates.map((g) => (
        <li key={g.id} data-gate={g.id}>
          <details open={open && (g.status === 'failed' || g.status === 'blocked') && !g.exception}>
            <summary>
              <Badge tone={GATE[g.status].tone}>{GATE[g.status].label}</Badge>
              <span className="finding-title">{g.title}</span>
              {!g.required && <span className="pill">Optional</span>}
              {g.exception && <span className="pill">Exception recorded</span>}
            </summary>
            <p>{g.summary}</p>
            {g.evidence.length > 0 && (
              <ul className="evidence">
                {g.evidence.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
            {g.findings && g.findings.length > 0 && (
              <ul className="small-list" aria-label="Drift findings">
                {g.findings.map((f) => (
                  <li key={f.requirementId}>
                    <span className="mono">{f.requirementId}</span> <Badge tone={f.kind === 'defect' || f.kind === 'missing_requirement' ? 'danger' : 'neutral'}>{DRIFT[f.kind]}</Badge> {f.observed}
                    {f.note && <span className="subtle"> Note: {f.note}</span>}
                    {open && <Classify finding={f} onSubmit={(kind, note) => act('classify', () => call(iap().classifyDrift({ releaseId: r.id, requirementId: f.requirementId, kind, note })))} />}
                  </li>
                ))}
              </ul>
            )}
            {g.exception && (
              <p className="subtle">
                Exception by {g.exception.actor}, {formatTime(g.exception.at)}: {g.exception.reason} Mitigation: {g.exception.mitigation}
              </p>
            )}
            {open && platform && g.required && (g.status === 'failed' || g.status === 'blocked') && <p className="subtle">A platform release takes no exceptions. Fix the cause and run the ship-check again.</p>}
            {open && !platform && g.required && (g.status === 'failed' || g.status === 'blocked') && !g.exception && (
              <ExceptionForm gate={g} onSubmit={(reason, mitigation) => act('exception', () => call(iap().addGateException({ releaseId: r.id, gateId: g.id, reason, mitigation })))} />
            )}
          </details>
        </li>
      ))}
    </ul>
  );
}

const DEPLOY: Record<DeploymentStatus, { label: string; tone: Tone }> = {
  running: { label: 'Deploying', tone: 'info' },
  failed: { label: 'Deploy failed', tone: 'danger' },
  unhealthy: { label: 'Deployed, not healthy', tone: 'danger' },
  healthy: { label: 'Deployed and healthy', tone: 'ok' },
  rolling_back: { label: 'Rolling back', tone: 'warn' },
  rolled_back: { label: 'Rolled back', tone: 'neutral' },
  rollback_failed: { label: 'Rollback failed', tone: 'danger' },
};

/** Deploying a prepared release (M20). The main process asks in a native dialog; the name typed here must match the plan. */
function Deploy({ release: r, onChanged }: { release: Release; onChanged: () => Promise<void> }) {
  const list = useAsync(() => call(iap().listDeployments(r.id)), [r.id]);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await list.reload();
      await onChanged();
      setBusy(null);
    }
  };
  const deployments: DeploymentDetail[] = list.data ?? [];
  return (
    <section className="deploy" aria-label="Deploy">
      <h4>Deploy to {r.plan.environment}</h4>
      <p className="subtle">
        Runs <span className="mono">{r.plan.deployCommand}</span> on commit <span className="mono">{r.commit?.slice(0, 12)}</span>, then checks <span className="mono">{r.plan.healthUrl || r.plan.healthCommand}</span>. If it goes wrong you can run{' '}
        <span className="mono">{r.plan.rollbackCommand}</span>.
      </p>
      <div className="field">
        <label htmlFor={`dep-env-${r.id}`}>Type “{r.plan.environment}” to deploy</label>
        <input id={`dep-env-${r.id}`} className="input" value={typed} maxLength={60} onChange={(e) => setTyped(e.target.value)} />
      </div>
      <div className="btn-row">
        <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null || typed.trim() !== r.plan.environment} onClick={() => void act('deploy', () => call(iap().deployRelease({ releaseId: r.id, environment: typed })))}>
          {busy === 'deploy' ? 'Deploying…' : `Deploy to ${r.plan.environment}`}
        </button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {deployments.length > 0 && (
        <ul className="build-checks" aria-label="Deployments">
          {deployments.map((d) => (
            <li key={d.deployment.id}>
              <details open={d === deployments[0]}>
                <summary>
                  <Badge tone={DEPLOY[d.deployment.status].tone}>{DEPLOY[d.deployment.status].label}</Badge>
                  <span className="subtle">
                    {d.deployment.version} · approved by {d.deployment.approvedBy}, {formatTime(d.deployment.approvedAt)}
                  </span>
                </summary>
                <ol className="small-list" aria-label="Deployment steps">
                  {d.steps.map((s) => (
                    <li key={s.seq}>
                      <Badge tone={s.status === 'passed' ? 'ok' : 'danger'}>{s.status === 'passed' ? 'Passed' : s.status.replace('_', ' ')}</Badge> {s.kind}: <span className="mono">{s.target}</span>
                      {s.status !== 'passed' && s.output && <pre className="agent-output">{s.output}</pre>}
                    </li>
                  ))}
                </ol>
                <div className="btn-row">
                  {d.next.includes('check_health') && (
                    <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void act('health', () => call(iap().checkDeploymentHealth(d.deployment.id)))}>
                      {busy === 'health' ? 'Checking…' : 'Check health again'}
                    </button>
                  )}
                  {d.next.includes('rollback') && (
                    <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void act('rollback', () => call(iap().rollbackDeployment(d.deployment.id)))}>
                      {busy === 'rollback' ? 'Rolling back…' : 'Roll back'}
                    </button>
                  )}
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReleaseCard({ release, platform, onChanged }: { release: Release; platform: boolean; onChanged: () => Promise<void> }) {
  const detail = useAsync(() => call(iap().getRelease(release.id)), [release.id, release.updatedAt]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const d = detail.data;
  const r = d?.release ?? release;
  const open = r.status === 'draft' || r.status === 'checked';
  // Stays as the person left it, so a release that was just prepared does not fold away.
  const [expanded, setExpanded] = useState(open);
  const latestRuns = d ? d.checkRuns.filter((c) => c.commit === r.commit).slice(-r.checks.length) : [];

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await detail.reload();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <details className="finding build-card release-card" open={expanded} onToggle={(e) => setExpanded(e.currentTarget.open)}>
      <summary>
        <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
        <span className="finding-title">Release {r.version}</span>
        {r.ready !== null && open && <span className="pill">{r.ready ? 'Ready to prepare' : `${d?.blocking.length ?? '?'} blocking`}</span>}
      </summary>
      <div className="finding-body">
        <p className="subtle">
          {r.commit ? (
            <>
              Checked on commit <span className="mono">{r.commit.slice(0, 12)}</span>
              {r.checkedAt && `, ${formatTime(r.checkedAt)}`}
            </>
          ) : (
            'Not checked yet.'
          )}{' '}
          Checks: {r.checks.map((c) => (
            <span key={c.id} className="mono build-cmd">
              {c.id}: {c.command}
            </span>
          ))}
        </p>
        <p className="subtle">
          Goes to {r.plan.target || '(not given)'}. Health check: {r.plan.healthCheck || '(not given)'}. Rollback: {r.plan.rollback || '(not given)'}.
        </p>
        {d && <Gates detail={d} open={open} platform={platform} act={act} />}
        {latestRuns.length > 0 && (
          <>
            <h4>Release checks</h4>
            <ul className="build-checks" aria-label="Release check results">
              {latestRuns.map((c) => (
                <li key={c.seq}>
                  <details>
                    <summary>
                      <Badge tone={c.status === 'passed' ? 'ok' : 'danger'}>{c.status === 'passed' ? 'Passed' : c.status.replace('_', ' ')}</Badge>
                      <span className="mono">{c.checkId}</span>
                      <span className="subtle">
                        exit {c.exitCode ?? '-'} · {Math.max(1, Math.round(c.durationMs / 1000))} s
                      </span>
                    </summary>
                    <pre className="agent-output">{c.output || '(no output)'}</pre>
                  </details>
                </li>
              ))}
            </ul>
          </>
        )}
        {(error || detail.error) && <Alert tone="danger">{error ?? detail.error}</Alert>}
        {open && (
          <div className="btn-row">
            <button type="button" className={`btn btn-sm${r.status === 'draft' ? ' btn-primary' : ''}`} disabled={busy !== null} onClick={() => void act('check', () => call(iap().checkRelease(r.id)))}>
              {busy === 'check' ? 'Running the ship-check…' : r.status === 'draft' ? 'Run the ship-check' : 'Run it again'}
            </button>
            {r.status === 'checked' && (
              <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null || !r.ready} onClick={() => void act('prepare', () => call(iap().prepareRelease(r.id)))}>
                Mark prepared
              </button>
            )}
            <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void act('abandon', () => call(iap().abandonRelease(r.id)))}>
              Abandon
            </button>
          </div>
        )}
        {r.status === 'prepared' && !r.plan.deployCommand && (
          <Alert tone="info" title="Nothing was deployed">
            Every required gate passed or has a recorded exception on commit <span className="mono">{r.commit?.slice(0, 12)}</span>. Deploy it yourself using the plan above; this release has no deploy command for the app to run.
          </Alert>
        )}
        {r.status === 'prepared' && r.plan.deployCommand && <Deploy release={r} onChanged={onChanged} />}
        {r.reportPath && (
          <p className="subtle">
            Report: <span className="mono">{r.reportPath}</span>
          </p>
        )}
      </div>
    </details>
  );
}

export function ReleasePanel({ project, onChanged }: { project: Project; onChanged?: () => void }) {
  const releases = useAsync(() => call(iap().listReleases(project.id)), [project.id]);
  const builds = useAsync(() => call(iap().listBuilds(project.id)), [project.id]);
  const [adding, setAdding] = useState(false);
  const reload = async () => {
    await releases.reload();
    onChanged?.();
  };

  return (
    <section className="card" id="phase-ship" aria-labelledby="release-title">
      <h2 className="card-title" id="release-title">
        Releases {releases.data && releases.data.length > 0 && <span className="count-pill">{releases.data.length}</span>}
      </h2>
      <p className="subtle">A ship-check runs your release checks on the repository's current commit and checks the work against the approved specification. Preparing a release never deploys it.</p>
      {releases.error && <Alert tone="danger">{releases.error}</Alert>}
      {!project.repoPath && <p className="muted">Choose the project's repository under Build work first.</p>}
      {project.repoPath && !adding && (
        <div className="btn-row">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>
            New release
          </button>
        </div>
      )}
      {adding && builds.data && (
        <NewRelease
          projectId={project.id}
          builds={builds.data}
          platform={project.kind === 'maintenance'}
          onCreated={async () => {
            setAdding(false);
            await reload();
          }}
        />
      )}
      {releases.data && releases.data.length > 0 && (
        <div className="findings">
          {releases.data.map((r) => (
            <ReleaseCard key={r.id} release={r} platform={project.kind === 'maintenance'} onChanged={reload} />
          ))}
        </div>
      )}
    </section>
  );
}
