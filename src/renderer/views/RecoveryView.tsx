import { useEffect, useState } from 'react';
import type { AppStatus, BackupInfo } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Alert } from '../ui.tsx';

// Shown instead of the app when the database cannot be opened safely
// (M2-AC5). Nothing is changed until the user explicitly confirms.
export function RecoveryView({ status, onRecovered }: { status: AppStatus; onRecovered: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [movedTo, setMovedTo] = useState<string | null>(null);
  const tooNew = status.state === 'too_new';
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [restored, setRestored] = useState(false);

  // Going back to an older version (M13): a backup that version took can be put back in place.
  useEffect(() => {
    if (!tooNew) return;
    call(iap().listBackups())
      .then((list) => setBackups(list.filter((b) => b.restorable)))
      .catch(() => setBackups([]));
  }, [tooNew]);

  const restore = async (file: string) => {
    setError(null);
    try {
      await call(iap().restoreBackup(file));
      setRestored(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const recover = async () => {
    setError(null);
    try {
      const result = await call(iap().recover(true));
      setMovedTo(result.movedTo);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <main className="content" id="main">
      <h1 className="page-title">{tooNew ? 'This workspace needs a newer version' : 'Your workspace could not be opened'}</h1>
      <p className="page-lede">Nothing has been changed or deleted.</p>
      <section className="card" aria-labelledby="recovery-title">
        <h2 className="card-title" id="recovery-title">
          Details
        </h2>
        <Alert tone="warn">{status.message}</Alert>
        {error && <Alert tone="danger">{error}</Alert>}
        {movedTo ? (
          <>
            <Alert title="Recovered">
              The damaged database was kept at <span className="mono">{movedTo}</span>. A new, empty workspace has been created.
            </Alert>
            <button type="button" className="btn btn-primary" onClick={onRecovered}>
              Open the new workspace
            </button>
          </>
        ) : restored ? (
          <>
            <Alert title="Backup restored">The database the newer version wrote was kept next to it, not deleted.</Alert>
            <button type="button" className="btn btn-primary" onClick={onRecovered}>
              Open the workspace
            </button>
          </>
        ) : tooNew ? (
          <>
            <p className="muted">Install the latest version of the app to open this workspace{backups.length ? ', or restore a backup this version can read:' : '.'}</p>
            {backups.length > 0 && (
              <ul className="plat-list" aria-label="Backups this version can restore">
                {backups.map((b) => (
                  <li key={b.file}>
                    <span>
                      <span className="mono">{b.file}</span>
                      <span className="subtle plat-meta">
                        Version {b.version ?? 'unknown'} · data format {b.schemaVersion}
                      </span>
                    </span>
                    <button type="button" className="btn btn-sm" onClick={() => void restore(b.file)}>
                      Restore…
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : !confirming ? (
          <div className="btn-row">
            <button type="button" className="btn btn-primary" onClick={() => setConfirming(true)}>
              Start a fresh workspace…
            </button>
          </div>
        ) : (
          <>
            <p>
              The damaged file will be renamed and kept, not deleted. Your projects will not appear in the new workspace. You can restore a backup of{' '}
              <span className="mono">{status.dbPath}</span> later.
            </p>
            <div className="btn-row">
              <button type="button" className="btn btn-danger" onClick={() => void recover()}>
                Move it aside and start fresh
              </button>
              <button type="button" className="btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
