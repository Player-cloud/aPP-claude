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

const GLASS: { id: Settings['glass']; label: string }[] = [
  { id: 'on', label: 'Frosted glass' },
  { id: 'off', label: 'Solid panels' },
];

const BUDGETS: { id: Settings['budget']; label: string }[] = [
  { id: 'none', label: 'No real calls' },
  { id: '20', label: '$20 a month' },
  { id: '50', label: '$50 a month' },
  { id: '100', label: '$100 a month' },
];

export function SettingsView({ status, settings, onSettings }: { status: AppStatus; settings: Settings; onSettings: (s: Settings) => void }) {
  const [error, setError] = useState<string | null>(null);
  // Show the choice immediately; roll back if the main process rejects it.
  const [pending, setPending] = useState<Partial<Settings>>({});
  const health = useAsync(() => call(iap().health()), []);

  const change = async <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setError(null);
    setPending((p) => ({ ...p, [key]: value }));
    try {
      onSettings(await call(iap().updateSetting({ key, value })));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending((p) => {
        const { [key]: _, ...rest } = p;
        return rest as Partial<Settings>;
      });
    }
  };
  const shown = { ...settings, ...pending };

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
                  <input type="radio" name="theme" value={t.id} checked={shown.theme === t.id} onChange={() => void change('theme', t.id)} />
                  {t.label}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="field">
            <legend>Surfaces</legend>
            <div className="radio-row">
              {GLASS.map((g) => (
                <label key={g.id} className="radio-pill">
                  <input type="radio" name="glass" value={g.id} checked={shown.glass === g.id} onChange={() => void change('glass', g.id)} />
                  {g.label}
                </label>
              ))}
            </div>
          </fieldset>
          <p className="subtle">Solid panels can be easier to read and lighter on older graphics hardware. Animations follow your operating system's reduced-motion setting.</p>
        </section>
        <aside>
          <section className="card" aria-labelledby="ai-title">
            <h2 className="card-title" id="ai-title">
              AI usage
            </h2>
            <fieldset className="field">
              <legend>Monthly budget for model calls</legend>
              <div className="radio-row">
                {BUDGETS.map((b) => (
                  <label key={b.id} className="radio-pill">
                    <input type="radio" name="budget" value={b.id} checked={shown.budget === b.id} onChange={() => void change('budget', b.id)} />
                    {b.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="subtle">
              The agent stops before any call that would go over this limit. This version only includes a simulated model, so nothing is billed whatever
              you choose.
            </p>
          </section>
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
