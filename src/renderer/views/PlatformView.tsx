// Platform maintenance (M13, FR-ITER-003): approved improvements and updates
// become build work in a worktree of the app's own source code, with checks
// that cannot be removed and a separate approval for protected areas. The
// running app is never changed: a change ships only as a new version that the
// person installs, with a database backup and a known-good version to go back to.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { BackupInfo, MaintenanceOverview, RecoveryTest, Release } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Icon } from '../icons.tsx';
import { Alert, Badge, Empty, formatTime, type Tone } from '../ui.tsx';

const BUILD_TONE: Record<string, Tone> = { draft: 'neutral', in_progress: 'warn', review: 'info', completed: 'ok', abandoned: 'neutral' };

function Setup({ version, onDone }: { version: string; onDone: (o: MaintenanceOverview) => void }) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await call(iap().setupMaintenance({ path: path.trim() })));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card" onSubmit={submit} aria-labelledby="plat-setup-title">
      <h2 className="card-title" id="plat-setup-title">
        Set up platform maintenance
      </h2>
      <p>
        Choose the folder with this app&rsquo;s source code (a git clone of the Iterative Platform repository). The app records where it is and that version {version}, the one running now, is
        known-good. Nothing in the folder changes.
      </p>
      <div className="field">
        <label htmlFor="plat-path">Source folder</label>
        <input id="plat-path" className="input mono" value={path} placeholder="C:\Users\you\code\aPP-claude" onChange={(e) => setPath(e.target.value)} />
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={busy || !path.trim()}>
          Set up
        </button>
      </div>
    </form>
  );
}

function Backups({ backups, onChanged }: { backups: BackupInfo[]; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<RecoveryTest | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="card" id="plat-recovery" aria-labelledby="plat-backups-title">
      <h2 className="card-title" id="plat-backups-title">
        Backups and recovery {backups.length > 0 && <span className="count-pill">{backups.length}</span>}
      </h2>
      <p className="subtle">Take a backup before you install a new version. A newer version may move the data format forward, and an older version cannot read it; the backup is how you go back.</p>
      <div className="btn-row">
        <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void act('backup', async () => void (await call(iap().backupDatabase())))}>
          <Icon name="archive" size={16} /> {busy === 'backup' ? 'Backing up…' : 'Take a backup'}
        </button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {drill && (
        <Alert tone={drill.passed ? 'info' : 'danger'} title={drill.passed ? 'Recovery test passed' : 'Recovery test failed'}>
          {drill.detail}
        </Alert>
      )}
      {restored && <Alert title="Restored">{restored}</Alert>}
      {backups.length === 0 ? (
        <p className="muted">No backups yet.</p>
      ) : (
        <ul className="plat-list" aria-label="Backups">
          {backups.map((b) => (
            <li key={b.file}>
              <span>
                <span className="mono">{b.file}</span>
                <span className="subtle plat-meta">
                  {b.version ? `Version ${b.version}` : 'Unknown version'} · data format {b.schemaVersion ?? '?'} · {Math.max(1, Math.round(b.sizeBytes / 1024))} KB
                </span>
                {b.problem && <span className="subtle plat-meta">{b.problem}</span>}
              </span>
              <span className="btn-row">
                <Badge tone={b.restorable ? 'ok' : 'danger'}>{b.restorable ? 'Restorable' : 'Not restorable'}</Badge>
                <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void act(`test:${b.file}`, async () => setDrill(await call(iap().testRecovery(b.file))))}>
                  {busy === `test:${b.file}` ? 'Testing…' : 'Test recovery'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy !== null || !b.restorable}
                  onClick={() =>
                    void act(`restore:${b.file}`, async () => {
                      const r = await call(iap().restoreBackup(b.file));
                      setRestored(`The backup is in place.${r.movedAside ? ` The database it replaced was kept at ${r.movedAside}.` : ''}`);
                    })
                  }
                >
                  Restore…
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">Test recovery opens a copy in a throwaway folder, exactly as a restore would. Restore asks you in a dialog first and keeps the database it replaces.</p>
    </section>
  );
}

function KnownGood({ overview, onChanged }: { overview: MaintenanceOverview; onChanged: () => Promise<void> }) {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [chosen, setChosen] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectId = overview.project!.id;
  useEffect(() => {
    call(iap().listReleases(projectId))
      .then(setReleases)
      .catch((e: Error) => setError(e.message));
  }, [projectId, overview.knownGood.length]);
  const marked = new Set(overview.knownGood.map((k) => k.releaseId));
  const prepared = (releases ?? []).filter((r) => r.status === 'prepared' && !marked.has(r.id));
  const mark = async () => {
    setBusy(true);
    setError(null);
    try {
      await call(iap().markKnownGood({ releaseId: chosen, note }));
      setNote('');
      setChosen('');
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="plat-kg-title">
      <h2 className="card-title" id="plat-kg-title">
        Known-good versions
      </h2>
      <ol className="plat-list" aria-label="Known-good versions">
        {overview.knownGood.map((k) => (
          <li key={k.id}>
            <span>
              <strong>{k.version}</strong>
              {k.commit && <span className="mono subtle"> {k.commit.slice(0, 12)}</span>}
              <span className="subtle plat-meta">
                {formatTime(k.at)} by {k.actor}: {k.note}
              </span>
              {k.backupPath && <span className="subtle plat-meta">Backup: {k.backupPath}</span>}
            </span>
          </li>
        ))}
      </ol>
      {prepared.length > 0 && (
        <div className="field">
          <label htmlFor="plat-kg-release">After you install a prepared release and its health check passes</label>
          <select id="plat-kg-release" className="select" value={chosen} onChange={(e) => setChosen(e.target.value)}>
            <option value="">Choose the release</option>
            {prepared.map((r) => (
              <option key={r.id} value={r.id}>
                {r.version}
              </option>
            ))}
          </select>
          <label htmlFor="plat-kg-note">What you checked</label>
          <input id="plat-kg-note" className="input" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          <p className="hint">Only the version that is running now ({overview.runningVersion}) can be marked known-good, so the record shows it was installed, not just built.</p>
          <div className="btn-row">
            <button type="button" className="btn" disabled={busy || !chosen || note.trim().length < 10} onClick={() => void mark()}>
              Mark known-good
            </button>
          </div>
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </section>
  );
}

export function PlatformView({ onOpenProject }: { onOpenProject: (id: string, name: string) => void }) {
  const [overview, setOverview] = useState<MaintenanceOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kinds, setKinds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOverview(await call(iap().getMaintenance()));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const start = async (type: 'improvement' | 'update', id: string) => {
    setBusy(id);
    setError(null);
    try {
      const b = await call(iap().startPlatformWork({ [type === 'update' ? 'updateId' : 'improvementId']: id, kind: kinds[id] }));
      setStarted(b.title);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const o = overview;
  return (
    <>
      <p className="eyebrow">Iterative Layer</p>
      <h1 className="page-title">
        Change the app <span className="accent">without risking it</span>
      </h1>
      <p className="page-lede">
        Approved improvements and updates are built in a separate worktree of the app&rsquo;s source code and go through the normal checks and release gates. The running app is never changed; a
        change ships only as a new version that you install.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      {!o && !error && <p className="loading">Loading…</p>}
      {o && !o.project && <Setup version={o.runningVersion} onDone={setOverview} />}
      {o?.project && (
        <div className="content-grid">
          <div>
            <section className="card" id="plat-work" aria-labelledby="plat-work-title">
              <div className="card-head">
                <h2 className="card-title" id="plat-work-title">
                  Platform work
                </h2>
                <button type="button" className="btn btn-sm" onClick={() => onOpenProject(o.project!.id, o.project!.name)}>
                  Open the project
                </button>
              </div>
              <p className="subtle">
                Source: <span className="mono">{o.project.repoPath}</span> · running {o.runningVersion}
              </p>
              {started && (
                <Alert title="Build created">
                  &ldquo;{started}&rdquo; is a draft in the platform-maintenance project. Open the project to start it; you approve the check commands in a dialog.
                </Alert>
              )}
              <h3 className="ref-subhead">Approved items</h3>
              {o.candidates.length === 0 ? (
                <Empty title="Nothing approved yet">Approve an improvement, or an app library, runtime or model update, and it appears here.</Empty>
              ) : (
                <ul className="plat-list" aria-label="Approved items">
                  {o.candidates.map((c) => (
                    <li key={c.id}>
                      <span>
                        <span className="imp-num">{c.ref}</span> {c.title}
                        {c.blocked && <span className="subtle plat-meta">{c.blocked}</span>}
                      </span>
                      {!c.blocked && (
                        <span className="btn-row">
                          <select className="select" aria-label={`Kind of work for ${c.ref}`} value={kinds[c.id] ?? (c.type === 'update' ? 'bugfix' : 'feature')} onChange={(e) => setKinds({ ...kinds, [c.id]: e.target.value })}>
                            <option value="feature">Feature</option>
                            <option value="bugfix">Fix</option>
                            <option value="ui_polish">UI polish</option>
                          </select>
                          <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => void start(c.type, c.id)}>
                            Build as platform work
                          </button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="ref-subhead">Builds</h3>
              {o.builds.length === 0 ? (
                <p className="muted">No platform work yet.</p>
              ) : (
                <ul className="plat-list" aria-label="Platform builds">
                  {o.builds.map((b) => (
                    <li key={b.id}>
                      <span>{b.title}</span>
                      <Badge tone={BUILD_TONE[b.status] ?? 'neutral'}>{b.status.replace('_', ' ')}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <KnownGood overview={o} onChanged={load} />
            <Backups backups={o.backups} onChanged={load} />
          </div>
          <aside aria-label="Platform rules">
            <section className="card" id="plat-rules" aria-labelledby="plat-rules-title">
              <h2 className="card-title" id="plat-rules-title">
                Rules for platform work
              </h2>
              <h3 className="ref-subhead">Checks every build runs</h3>
              <ul className="upd-list">
                {o.mandatoryChecks.map((c) => (
                  <li key={c.id}>
                    <span className="mono">{c.command}</span>
                  </li>
                ))}
              </ul>
              <p className="subtle">A release also runs {o.releaseChecks.filter((c) => !o.mandatoryChecks.some((m) => m.id === c.id)).map((c) => c.command).join(', ')}. A failing check blocks the work and the release; there are no exceptions.</p>
              <h3 className="ref-subhead">Protected areas (need your separate approval)</h3>
              <ul className="upd-list">
                {o.protectedAreas.map((a) => (
                  <li key={a.id}>
                    <strong>{a.title}</strong>
                    <span className="mono subtle plat-meta upd-url">{a.paths.join(', ')}</span>
                  </li>
                ))}
              </ul>
              <h3 className="ref-subhead">After release</h3>
              <p className="muted">Passing checks do not prove the improvement worked. After you use the new version, measure each released item in Improvements. If the problem came back, it is reopened as a new item.</p>
            </section>
          </aside>
        </div>
      )}
    </>
  );
}
