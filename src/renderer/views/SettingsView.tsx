import { useState } from 'react';
import type { AppStatus, Settings } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Alert } from '../ui.tsx';
import { useAsync } from '../useAsync.ts';

const THEMES: { id: Settings['theme']; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'Match system' },
];

export function SettingsView({ status, settings, onSettings }: { status: AppStatus; settings: Settings; onSettings: (s: Settings) => void }) {
  const [error, setError] = useState<string | null>(null);
  // Show the choice immediately; roll back if the main process rejects it.
  const [pending, setPending] = useState<string | null>(null);
  const health = useAsync(() => call(iap().health()), []);

  const setTheme = async (theme: string) => {
    setError(null);
    setPending(theme);
    try {
      onSettings(await call(iap().updateSetting({ key: 'theme', value: theme })));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <h1 className="page-title">Settings</h1>
      <p className="page-lede">Preferences are stored with your workspace, and every change is written to the activity log.</p>
      <div className="content-grid">
        <section className="card" aria-labelledby="appearance-title">
          <h2 className="card-title" id="appearance-title">
            Appearance
          </h2>
          {error && <Alert tone="danger">{error}</Alert>}
          <fieldset className="field">
            <legend>Theme</legend>
            <div className="radio-row">
              {THEMES.map((t) => (
                <label key={t.id} className="radio-pill">
                  <input type="radio" name="theme" value={t.id} checked={(pending ?? settings.theme) === t.id} onChange={() => void setTheme(t.id)} />
                  {t.label}
                </label>
              ))}
            </div>
          </fieldset>
          <p className="subtle">Animations follow your operating system's reduced-motion setting.</p>
        </section>
        <aside>
          <section className="card" aria-labelledby="data-title">
            <h2 className="card-title" id="data-title">
              Data
            </h2>
            <dl className="kv">
              <dt>Folder</dt>
              <dd className="mono">{status.dataDir}</dd>
              <dt>Database</dt>
              <dd className="mono">{status.dbPath}</dd>
              {health.data && (
                <>
                  <dt>Integrity</dt>
                  <dd>{health.data.integrity === 'ok' ? 'OK' : health.data.integrity}</dd>
                  <dt>Contents</dt>
                  <dd>
                    {health.data.projects} projects · {health.data.runs} runs · {health.data.events} events
                  </dd>
                </>
              )}
            </dl>
            {health.error && <Alert tone="danger">{health.error}</Alert>}
          </section>
        </aside>
      </div>
    </>
  );
}
