// Safe tool cleanup (M11, FR-TOOL-003/004/005). Options come least disruptive
// first; choosing one shows the dry run, and nothing on the computer changes
// until the person approves the exact change in a native dialog. Results say
// what the rescan showed, including failed and partial changes.
import { useEffect, useState } from 'react';
import type { CleanupOption, CleanupPlan, CleanupStatus, Finding, ToolEntry } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Icon } from '../icons.tsx';
import { Alert, Badge, formatTime, type Tone } from '../ui.tsx';

export const CLEANUP_STATUS: Record<CleanupStatus, { label: string; tone: Tone }> = {
  planned: { label: 'Planned', tone: 'info' },
  recorded: { label: 'Kept', tone: 'neutral' },
  manual: { label: 'Do it yourself', tone: 'neutral' },
  done: { label: 'Done', tone: 'ok' },
  partial: { label: 'Partial', tone: 'warn' },
  failed: { label: 'Failed', tone: 'danger' },
  stale: { label: 'Changed since planned', tone: 'warn' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  restored: { label: 'Restored', tone: 'neutral' },
};

const toolName = (e: ToolEntry) => e.invocation ?? e.name;

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <>
      <h4>{title}</h4>
      <ul className="evidence">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </>
  );
}

export function PlanDetails({ plan }: { plan: CleanupPlan }) {
  const d = plan.dryRun;
  return (
    <div className="finding-body cleanup-dry-run">
      {d.command && (
        <>
          <h4>Command</h4>
          <p className="mono cleanup-command">{d.command.display}</p>
          <p className="subtle">
            Run by the app in <span className="mono">{d.command.cwd}</span>, with no shell.
          </p>
        </>
      )}
      {d.move && (
        <>
          <h4>Move</h4>
          <p className="mono cleanup-command">
            {d.move.from}
            <br />→ {d.move.to}
          </p>
        </>
      )}
      <List title="Exact targets" items={d.targets} />
      <List title="Also affected" items={[...d.dependents.map((x) => x.label), ...d.workflows]} />
      <List title="What happens" items={d.effects} />
      <List title="Risks" items={d.risks} />
      <List title="How to undo it" items={d.recovery} />
      <List title="Do it yourself" items={d.manual} />
    </div>
  );
}

function ResultView({ plan }: { plan: CleanupPlan }) {
  const r = plan.restore ?? plan.result;
  if (!r) return null;
  const tone = plan.status === 'done' || plan.status === 'restored' ? 'info' : plan.status === 'partial' || plan.status === 'stale' ? 'warn' : 'danger';
  return (
    <Alert tone={tone} title={`${CLEANUP_STATUS[plan.status].label}: ${r.verification}`}>
      {r.output && <pre className="cleanup-output">{r.output}</pre>}
      {r.nextSteps.length > 0 && (
        <ul className="evidence">
          {r.nextSteps.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </Alert>
  );
}

/** One tool, optionally in the context of a finding. */
export function CleanupPanel({ entry, finding, onDone, onClose }: { entry: ToolEntry; finding: Finding | null; onDone: () => void; onClose: () => void }) {
  const [options, setOptions] = useState<CleanupOption[] | null>(null);
  const [plan, setPlan] = useState<CleanupPlan | null>(null);
  const [accept, setAccept] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call(iap().cleanupOptions({ entryId: entry.id, ...(finding ? { findingId: finding.id } : {}) }))
      .then(setOptions)
      .catch((e: Error) => setError(e.message));
  }, [entry.id, finding]);

  const act = async (run: () => Promise<CleanupPlan>, refresh = false) => {
    setBusy(true);
    setError(null);
    try {
      setPlan(await run());
      if (refresh) onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const choose = (action: string) => act(() => call(iap().planCleanup({ entryId: entry.id, action, ...(finding ? { findingId: finding.id } : {}) })));
  const finished = plan && plan.status !== 'planned';

  return (
    <section className="card cleanup-panel" aria-labelledby="cleanup-title">
      <div className="card-head">
        <h2 className="card-title" id="cleanup-title">
          Resolve {toolName(entry)}
        </h2>
        <button type="button" className="icon-btn" aria-label="Close the cleanup" title="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <p className="subtle">
        {entry.kind.replace('_', ' ')} · {entry.scope}
        {entry.owner ? ` · plugin ${entry.owner}` : ''} · <span className="mono">{entry.source}</span>
      </p>
      {error && <Alert tone="danger">{error}</Alert>}

      {!plan && options && (
        <ol className="cleanup-options" aria-label="Ways to resolve it">
          {options.map((o) => (
            <li key={o.action}>
              <button type="button" className="run-tile cleanup-option" disabled={!o.available || busy} onClick={() => void choose(o.action)}>
                <span className="run-tile-title">{o.label}</span>
                <span className="subtle">{o.available ? o.detail : o.why}</span>
              </button>
            </li>
          ))}
        </ol>
      )}

      {plan && (
        <>
          <p className="cleanup-plan-head">
            <Badge tone={CLEANUP_STATUS[plan.status].tone}>{CLEANUP_STATUS[plan.status].label}</Badge>
            <strong>{options?.find((o) => o.action === plan.action)?.label ?? plan.action}</strong>
            {plan.status === 'planned' && plan.mechanism !== 'record' && <span className="subtle">Dry run: nothing has changed.</span>}
          </p>
          <PlanDetails plan={plan} />
          <ResultView plan={plan} />
          {plan.status === 'planned' && (
            <div className="cleanup-approve">
              {plan.dryRun.needsAcceptance && (
                <label className="check-row">
                  <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} /> I accept that the tools and workflows listed above are affected
                </label>
              )}
              <div className="field">
                <label htmlFor="cleanup-reason">Reason (kept in the audit log)</label>
                <input id="cleanup-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || (plan.dryRun.needsAcceptance && !accept)}
                  onClick={() => void act(() => call(iap().runCleanup({ planId: plan.id, acceptDependencies: accept, ...(reason.trim() ? { reason: reason.trim() } : {}) })), true)}
                >
                  {busy ? 'Working…' : plan.mechanism === 'record' ? 'Record this decision' : 'Make this change…'}
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => void act(() => call(iap().cancelCleanup(plan.id)))}>
                  Cancel the plan
                </button>
              </div>
              {plan.mechanism !== 'record' && <p className="subtle">You approve the exact change in a Windows dialog. The app then scans again and records whether it worked.</p>}
            </div>
          )}
          {finished && (
            <div className="btn-row">
              {(plan.status === 'done' || plan.status === 'partial') && (plan.dryRun.move || plan.entry.kind === 'plugin') && (
                <button type="button" className="btn" disabled={busy} onClick={() => void act(() => call(iap().restoreCleanup(plan.id)), true)}>
                  Restore…
                </button>
              )}
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setPlan(null);
                  setAccept(false);
                  setReason('');
                }}
              >
                Choose another option
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function CleanupHistory({ refreshKey, onChanged }: { refreshKey: string; onChanged: () => void }) {
  const [plans, setPlans] = useState<CleanupPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () =>
    call(iap().listCleanups())
      .then(setPlans)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, [refreshKey]);
  if (!plans || plans.length === 0) return error ? <Alert tone="danger">{error}</Alert> : null;
  return (
    <section className="card" aria-labelledby="cleanup-history-title">
      <h2 className="card-title" id="cleanup-history-title">
        Cleanup history <span className="count-pill">{plans.length}</span>
      </h2>
      {error && <Alert tone="danger">{error}</Alert>}
      <ul className="cleanup-history" aria-label="Cleanup plans">
        {plans.map((p) => (
          <li key={p.id}>
            <details className="finding">
              <summary>
                <Badge tone={CLEANUP_STATUS[p.status].tone}>{CLEANUP_STATUS[p.status].label}</Badge>
                <span className="finding-title">
                  {p.action} {toolName(p.entry)}
                </span>
                <span className="subtle">{formatTime(p.updatedAt)}</span>
              </summary>
              <PlanDetails plan={p} />
              {p.approval && (
                <p className="subtle">
                  Approved by {p.approval.by}
                  {p.approval.reason ? `: ${p.approval.reason}` : ''}
                </p>
              )}
              <ResultView plan={p} />
              {(p.status === 'done' || p.status === 'partial') && (p.dryRun.move || p.entry.kind === 'plugin') && (
                <button
                  type="button"
                  className="btn"
                  disabled={!!busy}
                  onClick={async () => {
                    setBusy(p.id);
                    setError(null);
                    try {
                      await call(iap().restoreCleanup(p.id));
                      await load();
                      onChanged();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Restore…
                </button>
              )}
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
