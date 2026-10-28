// Read-only assessment of a project's repository (M8: FR-PROJ-002/003/004, DEC-023).
// The scope is chosen and recorded before anything is read. Every status shows
// its evidence, confidence and impact, and what lives outside the code is
// "not verified" until a connector can check it.
import { useState, type FormEvent } from 'react';
import type { Assessment, AssessmentCatalog, AssessmentScope, CapabilityFinding, CapabilityStatus, Level, Observation, Project, ScopeKind } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Alert, Badge, formatTime, type Tone } from '../ui.tsx';
import { useAsync } from '../useAsync.ts';

const STATUS: Record<CapabilityStatus, { label: string; tone: Tone }> = {
  implemented_in_code: { label: 'Implemented in code', tone: 'ok' },
  configured_externally: { label: 'Configured externally', tone: 'ok' },
  partly_present: { label: 'Partly present', tone: 'warn' },
  missing: { label: 'Missing', tone: 'danger' },
  not_verified: { label: 'Not verified', tone: 'neutral' },
  not_applicable: { label: 'Not applicable', tone: 'neutral' },
};

const RUN: Record<Assessment['status'], { label: string; tone: Tone }> = {
  scoped: { label: 'Running', tone: 'live' },
  completed: { label: 'Completed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
};

const level = (l: Level) => l.charAt(0).toUpperCase() + l.slice(1);

function scopeText(scope: AssessmentScope, catalog: AssessmentCatalog | null): string {
  if (scope.kind === 'full') return 'Full assessment';
  if (scope.kind === 'codebase') return 'Codebase only';
  if (scope.kind === 'category') return `Category: ${catalog?.categories.find((c) => c.id === scope.target)?.title ?? scope.target}`;
  return `Capability: ${catalog?.capabilities.find((c) => c.id === scope.target)?.title ?? scope.target}`;
}

function ScopeForm({ catalog, busy, onRun }: { catalog: AssessmentCatalog; busy: boolean; onRun: (scope: AssessmentScope) => void }) {
  const [kind, setKind] = useState<ScopeKind>('full');
  const [category, setCategory] = useState(catalog.categories[0]?.id ?? '');
  const [capability, setCapability] = useState(catalog.capabilities[0]?.id ?? '');
  const [notApplicable, setNotApplicable] = useState<string[]>([]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onRun({ kind, target: kind === 'category' ? category : kind === 'capability' ? capability : null, notApplicable: kind === 'codebase' ? [] : notApplicable });
  };

  return (
    <form className="plan-editor build-new" aria-label="Assessment scope" onSubmit={submit}>
      <div className="field">
        <label htmlFor="a-kind">What to assess</label>
        <select id="a-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as ScopeKind)}>
          <option value="full">Everything: the codebase and all {catalog.capabilities.length} capabilities</option>
          <option value="codebase">The codebase only: structure, stack, dependencies, tests, configuration, docs</option>
          <option value="category">One category of capabilities</option>
          <option value="capability">One capability</option>
        </select>
      </div>
      {kind === 'category' && (
        <div className="field">
          <label htmlFor="a-category">Category</label>
          <select id="a-category" className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            {catalog.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </div>
      )}
      {kind === 'capability' && (
        <div className="field">
          <label htmlFor="a-capability">Capability</label>
          <select id="a-capability" className="select" value={capability} onChange={(e) => setCapability(e.target.value)}>
            {catalog.categories.map((cat) => (
              <optgroup key={cat.id} label={cat.title}>
                {catalog.capabilities
                  .filter((c) => c.category === cat.id)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>
      )}
      {kind !== 'codebase' && (
        <details className="release-exception">
          <summary>Mark capabilities this project does not need ({notApplicable.length})</summary>
          <fieldset className="plan-req assess-na">
            <legend className="visually-hidden">Not applicable</legend>
            {catalog.capabilities.map((c) => (
              <label key={c.id} className="check-row">
                <input type="checkbox" checked={notApplicable.includes(c.id)} onChange={(e) => setNotApplicable(e.target.checked ? [...notApplicable, c.id] : notApplicable.filter((x) => x !== c.id))} />
                {c.title}
              </label>
            ))}
          </fieldset>
        </details>
      )}
      <div className="btn-row">
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
          {busy ? 'Assessing…' : 'Assess (read-only)'}
        </button>
      </div>
    </form>
  );
}

function Evidence({ items }: { items: string[] }) {
  return (
    <ul className="assess-evidence" aria-label="Evidence">
      {items.map((e, i) => (
        <li key={i} className="mono">
          {e}
        </li>
      ))}
    </ul>
  );
}

function ObservationItem({ o }: { o: Observation }) {
  return (
    <li>
      <details>
        <summary>
          <Badge tone={o.impact === 'high' ? 'danger' : o.impact === 'medium' ? 'warn' : 'neutral'}>{level(o.impact)} impact</Badge>
          <span>{o.title}</span>
          <span className="subtle">confidence {o.confidence}</span>
        </summary>
        <p>Next: {o.nextAction}</p>
        <Evidence items={o.evidence} />
      </details>
    </li>
  );
}

function CapabilityItem({ f }: { f: CapabilityFinding }) {
  return (
    <li>
      <details>
        <summary>
          {/* Coral is for risk (DEC-021): only a missing capability that matters a lot is shown as one. */}
          <Badge tone={f.status === 'missing' && f.impact !== 'high' ? 'neutral' : STATUS[f.status].tone}>{STATUS[f.status].label}</Badge>
          <span>{f.title}</span>
          <span className="subtle">
            confidence {f.confidence} · impact {f.impact}
            {f.externalState === 'not_verified' && ' · outside the code: not verified'}
          </span>
        </summary>
        <p>{f.reasoning}</p>
        <p>Next: {f.nextAction}</p>
        <Evidence items={f.evidence} />
      </details>
    </li>
  );
}

function AssessmentCard({ assessment: a, catalog, open, onBroader, busy }: { assessment: Assessment; catalog: AssessmentCatalog | null; open: boolean; onBroader: () => void; busy: boolean }) {
  const [expanded, setExpanded] = useState(open);
  const r = a.report;
  return (
    <details className="finding build-card assess-card" open={expanded} onToggle={(e) => setExpanded(e.currentTarget.open)}>
      <summary>
        <Badge tone={RUN[a.status].tone}>{RUN[a.status].label}</Badge>
        <span className="finding-title">{scopeText(a.scope, catalog)}</span>
        {a.commit && <span className="pill mono">{a.commit.slice(0, 12)}</span>}
        <span className="subtle">{formatTime(a.createdAt)}</span>
      </summary>
      <div className="finding-body">
        {a.error && <Alert tone="danger" title="The assessment did not finish">{a.error}</Alert>}
        {r && (
          <>
            <p className="subtle">{r.scopeLabel}. This is an assessment from patterns in the repository, not a compliance certification.</p>
            <Alert tone={r.unchanged ? 'info' : 'warn'} title={r.unchanged ? 'Repository unchanged' : 'The repository changed during the assessment'}>
              {r.unchangedEvidence}
            </Alert>
            {r.capabilities.length > 0 && (
              <p className="assess-counts" aria-label="Capability summary">
                {(Object.keys(STATUS) as CapabilityStatus[])
                  .filter((s) => r.counts[s])
                  .map((s) => (
                    <Badge key={s} tone={s === 'missing' ? 'neutral' : STATUS[s].tone}>
                      {STATUS[s].label}: {r.counts[s]}
                    </Badge>
                  ))}
              </p>
            )}
            {r.codebase && (
              <>
                <h4>Codebase</h4>
                <dl className="kv">
                  <dt>Files</dt>
                  <dd>
                    {r.codebase.structure.files} · {r.codebase.structure.languages.slice(0, 5).map((l) => `${l.language} ${l.files}`).join(', ') || 'no known languages'}
                  </dd>
                  <dt>Stack</dt>
                  <dd>{r.codebase.stack.map((s) => s.name).join(', ') || 'No known framework declared'}</dd>
                  <dt>Dependencies</dt>
                  <dd>{r.codebase.dependencies.map((d) => `${d.ecosystem}: ${d.runtime} runtime, ${d.dev} dev, lockfile ${d.lockfile ? 'yes' : 'no'}`).join('; ') || 'None declared'}</dd>
                  <dt>Tests</dt>
                  <dd>
                    {r.codebase.tests.files} {r.codebase.tests.files === 1 ? 'file' : 'files'}{r.codebase.tests.frameworks.length ? ` (${r.codebase.tests.frameworks.join(', ')})` : ''}, not run
                  </dd>
                  <dt>Configuration</dt>
                  <dd>{r.codebase.configuration.map((c) => c.item).join(', ') || 'Nothing recognised'}</dd>
                  <dt>Docs</dt>
                  <dd>{r.codebase.documentation.map((d) => d.item).join(', ') || 'Nothing recognised'}</dd>
                </dl>
                {r.observations.length > 0 && (
                  <ul className="release-gates" aria-label="Codebase findings">
                    {r.observations.map((o, i) => (
                      <ObservationItem key={i} o={o} />
                    ))}
                  </ul>
                )}
              </>
            )}
            {(catalog?.categories ?? []).map((cat) => {
              const items = r.capabilities.filter((f) => f.category === cat.id);
              if (!items.length) return null;
              return (
                <div key={cat.id}>
                  <h4>{cat.title}</h4>
                  <ul className="release-gates" aria-label={`${cat.title} capabilities`}>
                    {items.map((f) => (
                      <CapabilityItem key={f.id} f={f} />
                    ))}
                  </ul>
                </div>
              );
            })}
            <details className="release-exception">
              <summary>What was and was not inspected</summary>
              <h4>Inspected</h4>
              <ul>{r.inspected.map((x, i) => <li key={i}>{x}</li>)}</ul>
              <h4>Not inspected</h4>
              <ul>{r.notInspected.map((x, i) => <li key={i}>{x}</li>)}</ul>
              {r.disclosed.length > 0 && (
                <>
                  <h4>Read outside the scope to interpret it</h4>
                  <ul>{r.disclosed.map((x, i) => <li key={i}>{x}</li>)}</ul>
                </>
              )}
            </details>
          </>
        )}
        {a.scope.kind !== 'full' && a.status !== 'scoped' && (
          <div className="btn-row">
            <button type="button" className="btn btn-sm" disabled={busy} onClick={onBroader}>
              Run a full assessment
            </button>
          </div>
        )}
        {a.reportPath && (
          <p className="subtle">
            Report: <span className="mono">{a.reportPath}</span>
          </p>
        )}
      </div>
    </details>
  );
}

export function AssessmentPanel({ project, onChanged }: { project: Project; onChanged?: () => void }) {
  const catalog = useAsync(() => call(iap().assessmentCatalog()), []);
  const list = useAsync(() => call(iap().listAssessments(project.id)), [project.id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (scope: AssessmentScope) => {
    setBusy(true);
    setError(null);
    try {
      await call(iap().runAssessment({ projectId: project.id, scope }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      await list.reload();
      onChanged?.();
    }
  };

  return (
    <section className="card" id="phase-assess" aria-labelledby="assess-title">
      <h2 className="card-title" id="assess-title">
        Assessment {list.data && list.data.length > 0 && <span className="count-pill">{list.data.length}</span>}
      </h2>
      <p className="subtle">
        Reads the repository's current commit from git and reports what is there, with evidence. It never changes the repository, runs its code or contacts outside services, and it makes no AI calls.
      </p>
      {!project.repoPath && <p className="muted">Choose the project's repository under Build work first.</p>}
      {project.repoPath && catalog.data && <ScopeForm catalog={catalog.data} busy={busy} onRun={(s) => void run(s)} />}
      {(error || list.error || catalog.error) && <Alert tone="danger">{error ?? list.error ?? catalog.error}</Alert>}
      {list.data && list.data.length > 0 && (
        <div className="findings">
          {list.data.map((a, i) => (
            <AssessmentCard key={a.id} assessment={a} catalog={catalog.data} open={i === 0} busy={busy} onBroader={() => void run({ kind: 'full', target: null, notApplicable: a.scope.notApplicable })} />
          ))}
        </div>
      )}
    </section>
  );
}
