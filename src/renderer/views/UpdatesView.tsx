// Updates (M12, FR-ITER-004): the app asks a fixed list of trusted sources what
// is new for the libraries it is built on, Claude Code, the Claude models and
// the installed plugins. Discovery, your approval, installation (done by you,
// outside the app) and the app's verification are separate steps. Nothing is
// installed from here.
import { useCallback, useEffect, useState } from 'react';
import type { SourceStatus, UpdateItem, UpdatePriority, UpdatesOverview, UpdateStage } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Icon } from '../icons.tsx';
import { Alert, Badge, Empty, formatTime, type Tone } from '../ui.tsx';

export type UpdateFilter = 'all' | UpdateStage;

export const STAGE_LABEL: Record<UpdateStage, string> = {
  recommended: 'Needs your decision',
  approved: 'Approved',
  installed: 'Installed',
  verified: 'Verified',
  failed: 'Verification failed',
  dismissed: 'Dismissed',
  superseded: 'Superseded',
};

const STAGE_TONE: Record<UpdateStage, Tone> = {
  recommended: 'info',
  approved: 'info',
  installed: 'warn',
  verified: 'ok',
  failed: 'danger',
  dismissed: 'neutral',
  superseded: 'neutral',
};

const PRIORITY: Record<UpdatePriority, { label: string; tone: Tone }> = {
  security: { label: 'Security', tone: 'danger' },
  breaking: { label: 'May break', tone: 'warn' },
  deprecation: { label: 'Deprecation', tone: 'warn' },
  improvement: { label: 'Improvement', tone: 'info' },
  info: { label: 'For information', tone: 'neutral' },
};

const SOURCE: Record<SourceStatus, { label: string; tone: Tone }> = {
  ok: { label: 'Answered', tone: 'ok' },
  unreachable: { label: 'Unreachable', tone: 'danger' },
  error: { label: 'Error', tone: 'warn' },
  not_checked: { label: 'Not checked', tone: 'neutral' },
};

const KIND_LABEL: Record<UpdateItem['kind'], string> = { library: 'App library', runtime: 'App runtime', cli: 'Claude Code', model: 'Claude model', plugin: 'Plugin' };

/** Updates to what the app is built from; they ship as a new app version (M13). */
const BUILT_IN = new Set<UpdateItem['kind']>(['library', 'runtime', 'model']);

function List({ title, items, className }: { title: string; items: string[]; className?: string }) {
  if (!items.length) return null;
  return (
    <>
      <h3 className="ref-subhead">{title}</h3>
      <ul className={className ?? 'upd-list'}>
        {items.map((x, n) => (
          <li key={n}>{x}</li>
        ))}
      </ul>
    </>
  );
}

function Inspector({ item, onChanged, onClose }: { item: UpdateItem; onChanged: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [dismissing, setDismissing] = useState(false);
  const [built, setBuilt] = useState<string | null>(null);
  const i = item;

  const act = async (run: () => Promise<UpdateItem>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      setDismissing(false);
      setNote('');
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const open = i.stage === 'recommended' || i.stage === 'approved';
  return (
    <section className="card ref-inspector" aria-labelledby="upd-title">
      <div className="card-head">
        <h2 className="card-title" id="upd-title">
          UPD-{i.number} {i.title}
        </h2>
        <button type="button" className="icon-btn" aria-label="Close the update" title="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <p className="imp-badges">
        <Badge tone={STAGE_TONE[i.stage]}>{STAGE_LABEL[i.stage]}</Badge>
        <Badge tone={PRIORITY[i.priority].tone}>{PRIORITY[i.priority].label}</Badge>
        <Badge tone="neutral">{i.confidence} confidence</Badge>
        <Badge tone="neutral">{KIND_LABEL[i.kind]}</Badge>
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      <dl className="imp-facts">
        <dt>Installed now</dt>
        <dd>{i.installedVersion ?? 'Unknown'}</dd>
        {i.observedVersion && (
          <>
            <dt>Found</dt>
            <dd>{i.observedVersion}</dd>
          </>
        )}
        <dt>Source</dt>
        <dd>
          {i.source.name}
          {i.source.url && <div className="mono subtle upd-url">{i.source.url}</div>}
        </dd>
        <dt>Detected</dt>
        <dd>
          {formatTime(i.detectedAt)}, last seen {formatTime(i.lastSeenAt)}
        </dd>
      </dl>
      <List title="What changed (quoted from the source)" items={i.summary} />
      <List title="What depends on it" items={[...i.impacts.workflows, ...i.impacts.tests.map((t) => `Test: ${t}`)]} />
      <h3 className="ref-subhead">Recommendation</h3>
      <p>{i.recommendation}</p>
      <List title="Evaluate it first" items={i.evaluation} />
      <List title="How to install it (the app does not run these)" items={i.installSteps} />

      {i.approval && (
        <p className="subtle">
          Approved by {i.approval.by}, {formatTime(i.approval.at)}
          {i.approval.note ? `: ${i.approval.note}` : ''}
        </p>
      )}
      {i.dismissal && (
        <Alert tone="info">
          Dismissed by {i.dismissal.by}: {i.dismissal.reason}
        </Alert>
      )}
      {i.installed && (
        <Alert tone="info" title={`Installed, seen by the check on ${formatTime(i.installed.at)}`}>
          {i.installed.evidence}
        </Alert>
      )}
      {i.verification && (
        <div aria-label="Verification">
          <Alert tone={i.verification.passed ? 'info' : 'danger'} title={i.verification.passed ? 'Verified' : 'Verification failed'}>
            Checked {formatTime(i.verification.at)}.
          </Alert>
          <ul className="upd-list">
            {i.verification.evidence.map((e, n) => (
              <li key={n}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="imp-moves">
        {i.stage === 'recommended' && (
          <div className="field">
            <label htmlFor="upd-note">Note (optional, kept with your approval)</label>
            <input id="upd-note" className="input" value={dismissing ? '' : note} disabled={dismissing} onChange={(e) => setNote(e.target.value)} />
          </div>
        )}
        <div className="btn-row">
          {i.stage === 'recommended' && (
            <button type="button" className="btn btn-primary" disabled={busy || dismissing} onClick={() => void act(() => call(iap().approveUpdate({ id: i.id, note })))}>
              Approve
            </button>
          )}
          {open && !dismissing && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setDismissing(true);
                setNote('');
              }}
            >
              Dismiss…
            </button>
          )}
          {i.stage === 'dismissed' && (
            <button type="button" className="btn" disabled={busy} onClick={() => void act(() => call(iap().reopenUpdate(i.id)))}>
              Reopen
            </button>
          )}
          {(i.stage === 'installed' || i.stage === 'failed') && i.kind !== 'model' && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act(() => call(iap().verifyUpdate(i.id)))}>
              {busy ? 'Verifying…' : i.stage === 'failed' ? 'Verify again' : 'Verify'}
            </button>
          )}
        </div>
        {i.stage === 'recommended' && <p className="subtle">Approving records your decision. It installs nothing; install it yourself with the steps above.</p>}
        {i.stage === 'approved' && !BUILT_IN.has(i.kind) && <p className="subtle">Install it with the steps above. The next check sees the new version and marks it installed.</p>}
        {i.stage === 'approved' && BUILT_IN.has(i.kind) && (
          <div aria-label="Platform work">
            <p className="subtle">This is part of the app itself, so it changes through a new app version. Build it as platform work: a worktree of the app&rsquo;s source with the mandatory checks. The next check after you install that version marks it installed.</p>
            {built ? (
              <Alert title="Build created">{built}</Alert>
            ) : (
              <div className="btn-row">
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setError(null);
                    call(iap().startPlatformWork({ updateId: i.id }))
                      .then((b) => setBuilt(`"${b.title}" is a draft in the platform-maintenance project.`))
                      .catch((e: Error) => setError(e.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  Build as platform work
                </button>
              </div>
            )}
          </div>
        )}
        {dismissing && (
          <div className="field">
            <label htmlFor="upd-reason">Why you do not want it</label>
            <textarea id="upd-reason" className="textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            <p className="hint">Kept in the audit log. You can reopen it later.</p>
            <div className="btn-row">
              <button type="button" className="btn btn-primary" disabled={busy || !note.trim()} onClick={() => void act(() => call(iap().dismissUpdate({ id: i.id, reason: note })))}>
                Dismiss
              </button>
              <button type="button" className="btn" onClick={() => setDismissing(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export function UpdatesView({ filter, onFilter }: { filter: UpdateFilter; onFilter: (f: UpdateFilter) => void }) {
  const [overview, setOverview] = useState<UpdatesOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOverview(await call(iap().getUpdates()));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      await call(iap().checkUpdates());
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const items = overview?.items ?? [];
  const shown = filter === 'all' ? items.filter((i) => i.stage !== 'superseded') : items.filter((i) => i.stage === filter);
  const latest = overview?.latest ?? null;
  const current = items.find((i) => i.id === selected) ?? null;

  return (
    <>
      <p className="eyebrow">Iterative Layer</p>
      <h1 className="page-title">
        Watch for <span className="accent">updates</span>
      </h1>
      <p className="page-lede">
        The app asks trusted sources what is new for Claude Code, the Claude models, your plugins and the libraries the app is built on, and links each change to what depends on it. It
        never installs anything: you decide, you install, and the app verifies.
      </p>
      <div className="content-grid">
        <div>
          <div className="ref-toolbar glass">
            <select className="select" aria-label="Stage" value={filter} onChange={(e) => onFilter(e.target.value as UpdateFilter)}>
              <option value="all">All open and recent</option>
              {(Object.keys(STAGE_LABEL) as UpdateStage[]).map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABEL[s]} ({overview?.counts[s] ?? 0})
                </option>
              ))}
            </select>
            <span className="subtle">{latest ? `Last checked ${formatTime(latest.at)}` : 'Not checked yet'}</span>
            <button type="button" className="btn btn-primary" onClick={() => void check()} disabled={checking}>
              <Icon name="radar" size={16} /> {checking ? 'Checking…' : 'Check for updates'}
            </button>
          </div>
          {error && <Alert tone="danger">{error}</Alert>}
          {!overview && !error && <p className="loading">Loading updates…</p>}
          {overview && overview.stale.length > 0 && (
            <Alert tone="warn" title="Some sources have not answered recently">
              {overview.stale.map((s) => `${s.name} (${s.lastOk ? `last answered ${formatTime(s.lastOk)}` : 'never answered'})`).join('; ')}. Updates from them may be missing.
            </Alert>
          )}

          {latest && (
            <section className="card" aria-labelledby="sources-title">
              <h2 className="card-title" id="sources-title">
                Sources in the last check
              </h2>
              <div className="table-wrap">
                <table className="table upd-sources" aria-label="Sources">
                  <thead>
                    <tr>
                      <th scope="col">Source</th>
                      <th scope="col">Result</th>
                      <th scope="col">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {latest.sources.map((s) => (
                      <tr key={s.id}>
                        <td>{s.name}</td>
                        <td>
                          <Badge tone={SOURCE[s.status].tone}>{SOURCE[s.status].label}</Badge>
                        </td>
                        <td className="subtle">{s.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3 className="subhead">Not checked</h3>
              <ul className="muted small-list">
                {latest.notChecked.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="section" aria-labelledby="updates-title">
            <h2 className="section-title" id="updates-title">
              Updates <span className="count-pill">{shown.length}</span>
            </h2>
            {overview && shown.length === 0 && (
              <div className="card">
                <Empty title={latest ? 'Nothing here' : 'No check yet'}>
                  {latest ? 'Choose another stage to see more.' : 'Press Check for updates. Only package names and installed versions are sent; nothing is installed.'}
                </Empty>
              </div>
            )}
            {shown.length > 0 && (
              <ul className="imp-list" aria-label="Updates">
                {shown.map((i) => (
                  <li key={i.id}>
                    <button type="button" className="run-tile imp-row" aria-current={selected === i.id ? 'true' : undefined} onClick={() => setSelected(i.id)}>
                      <span className="imp-num">UPD-{i.number}</span>
                      <span className="run-tile-title">{i.title}</span>
                      <span className="imp-badges">
                        <Badge tone={STAGE_TONE[i.stage]}>{STAGE_LABEL[i.stage]}</Badge>
                        <Badge tone={PRIORITY[i.priority].tone}>{PRIORITY[i.priority].label}</Badge>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <aside aria-label="Update details panel">
          {current ? (
            <Inspector key={`${current.id}:${current.updatedAt}`} item={current} onChanged={load} onClose={() => setSelected(null)} />
          ) : (
            <section className="card">
              <h2 className="card-title">How updates work</h2>
              <ol className="stages">
                {['Found, with a recommendation', 'Approved by you', 'Installed by you, outside the app', 'Seen by the next check', 'Verified by the app’s checks'].map((s, n) => (
                  <li key={s}>
                    <span className="stage-num">{n + 1}</span>
                    {s}
                  </li>
                ))}
              </ol>
              <p className="muted">A check sends package names and installed versions to the npm registry and reads public files on GitHub. The model list is asked for only when your API key is stored; listing models costs nothing.</p>
              <p className="muted">A newer model is never adopted because it is newer. It needs evaluation and an app change first.</p>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
