// Main agent requests for one run (M3: FR-APP-003). Only a simulated model is
// installed (DEC-017), and the panel says so wherever results appear, so a
// placeholder can never be mistaken for real AI work.
import { useState, type FormEvent } from 'react';
import type { AgentTask, RunWithNext } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Alert, Badge } from '../ui.tsx';
import { useAsync } from '../useAsync.ts';

type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

const STATUS: Record<AgentTask['status'], { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  succeeded: { label: 'Succeeded', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  timed_out: { label: 'Timed out', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'warn' },
  permission_denied: { label: 'Permission denied', tone: 'warn' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const STRATEGY: Record<string, string> = {
  single: 'Single agent',
  subagents: 'Subagents',
  team: 'Agent team',
};

function Request({ root, tasks }: { root: AgentTask; tasks: AgentTask[] }) {
  const status = STATUS[root.status];
  const children = tasks.filter((t) => t.parentId === root.id);
  return (
    <details className="finding agent-request" open={root.status !== 'succeeded'}>
      <summary>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="finding-title">{root.title}</span>
        {root.strategy && <span className="pill">{STRATEGY[root.strategy] ?? root.strategy}</span>}
      </summary>
      <div className="finding-body">
        {root.rationale.length > 0 && (
          <>
            <h4>Why this strategy</h4>
            <ul className="small-list">
              {root.rationale.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </>
        )}
        <h4>Steps</h4>
        <ol className="agent-steps">
          {children.map((c) => (
            <li key={c.id}>
              <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge> <span>{c.title}</span>
              {c.failure && <p>{c.failure}</p>}
            </li>
          ))}
        </ol>
        {root.failure && (
          <>
            <h4>Problem</h4>
            <p>{root.failure}</p>
          </>
        )}
        {root.resolution && (
          <>
            <h4>To resolve</h4>
            <p>{root.resolution}</p>
          </>
        )}
        {root.output && (
          <>
            <h4>Result (simulated)</h4>
            <pre className="agent-output">{root.output}</pre>
          </>
        )}
      </div>
    </details>
  );
}

export function AgentPanel({ run }: { run: RunWithNext }) {
  const tasks = useAsync(() => call(iap().listAgentTasks(run.id)), [run.id]);
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = run.state === 'running';
  const roots = (tasks.data ?? []).filter((t) => t.kind === 'request').reverse();
  if (!running && roots.length === 0) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call(iap().runAgent({ runId: run.id, goal }));
      setGoal('');
      await tasks.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="agent-panel" aria-label={`Main agent for ${run.title}`}>
      <div className="agent-head">
        <h4>Main agent</h4>
        <Badge tone="warn">Simulated</Badge>
      </div>
      <p className="subtle">
        No AI model is connected yet, so the agent uses a stand-in that shows the plan, delegation and checks without doing real work. Nothing is billed.
      </p>
      {running && (
        <form className="agent-form" onSubmit={submit}>
          <textarea
            aria-label="What should the agent do?"
            className="textarea"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            maxLength={4000}
            placeholder="What should the agent do?"
            rows={2}
          />
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !goal.trim()}>
            {busy ? 'Working…' : 'Ask the agent'}
          </button>
        </form>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {tasks.error && <Alert tone="danger">{tasks.error}</Alert>}
      {roots.length > 0 && (
        <div className="findings">
          {roots.map((r) => (
            <Request key={r.id} root={r} tasks={tasks.data ?? []} />
          ))}
        </div>
      )}
    </section>
  );
}
