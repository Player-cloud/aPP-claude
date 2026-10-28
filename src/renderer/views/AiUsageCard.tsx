// Settings → AI usage: the monthly budget and the Anthropic API key (DEC-018).
// The key is sent to the main process once and never shown again; this card
// only ever learns whether a key is stored.
import { useState, type FormEvent } from 'react';
import type { Settings } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Alert, Badge } from '../ui.tsx';
import { useAsync } from '../useAsync.ts';

const BUDGETS: { id: Settings['budget']; label: string }[] = [
  { id: 'none', label: 'No real calls' },
  { id: '20', label: '$20 a month' },
  { id: '50', label: '$50 a month' },
  { id: '100', label: '$100 a month' },
];

export function AiUsageCard({ budget, onBudget }: { budget: Settings['budget']; onBudget: (b: Settings['budget']) => void }) {
  // Reload whenever the budget changes, since it decides the mode.
  const status = useAsync(() => call(iap().agentStatus()), [budget]);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await status.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      await call(iap().setApiKey({ key }));
      setKey('');
    });
  };

  const s = status.data;
  return (
    <section className="card" aria-labelledby="ai-title">
      <h2 className="card-title" id="ai-title">
        AI usage
        {s && (s.mode === 'claude' ? <Badge tone="ok">Claude on</Badge> : s.mode === 'needs_key' ? <Badge tone="danger">Needs API key</Badge> : <Badge tone="warn">Simulated</Badge>)}
      </h2>
      <fieldset className="field">
        <legend>Monthly budget for model calls</legend>
        <div className="radio-row">
          {BUDGETS.map((b) => (
            <label key={b.id} className="radio-pill">
              <input type="radio" name="budget" value={b.id} checked={budget === b.id} onChange={() => onBudget(b.id)} />
              {b.label}
            </label>
          ))}
        </div>
      </fieldset>
      {s && s.budgetUsd !== null && (
        <p className="spend">
          <strong>${s.spentUsd.toFixed(2)}</strong> of ${s.budgetUsd} used this month (calendar month, UTC)
        </p>
      )}
      <p className="subtle">
        The agent checks every call against this limit before making it, assuming the longest possible answer, and stops instead of going over. With
        "No real calls" it uses a free stand-in model.
      </p>

      <h3 className="subhead">Anthropic API key</h3>
      {error && <Alert tone="danger">{error}</Alert>}
      {status.error && <Alert tone="danger">{status.error}</Alert>}
      {s && !s.keyStorageAvailable && <Alert tone="warn">This computer offers no secure storage, so a key cannot be saved here.</Alert>}
      {s?.keyStored ? (
        <div className="key-row">
          <span>A key is stored, encrypted by your operating system. It is never shown again.</span>
          <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void act(() => call(iap().clearApiKey()))}>
            Remove key
          </button>
        </div>
      ) : (
        <form className="key-row" onSubmit={save}>
          <input
            type="password"
            className="input"
            aria-label="Anthropic API key"
            placeholder="sk-ant-…"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !key.trim() || s?.keyStorageAvailable === false}>
            Save key
          </button>
        </form>
      )}
      <p className="subtle">
        Create a key at console.anthropic.com → API keys. Real calls need both a budget and a key. Calls use Claude Opus 5.5 at $4 per million input
        tokens and $20 per million output tokens.
      </p>
    </section>
  );
}
