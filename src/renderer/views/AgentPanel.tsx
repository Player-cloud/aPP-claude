// Main agent requests for one run (M3: FR-APP-003). The panel says whether
// the agent is simulated or calling Claude (DEC-017, DEC-018), and labels each
// result by the model that produced it, so a placeholder can never be mistaken
// for real AI work.
import { useState, type FormEvent } from 'react';
import type { AgentStatus, AgentTask, RunWithNext } from '../../shared/api.ts';
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
  const total = root.costUsd + children.reduce((sum, c) => sum + c.costUsd, 0);
  return (
    <details className="finding agent-request" open={root.status !== 'succeeded'}>
      <summary>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="finding-title">{root.title}</span>
        {root.model === 'simulated' && <span className="pill">Simulated</span>}
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
        {total > 0 && (
          <>
            <h4>Cost</h4>
            <p>
              ${total.toFixed(3)} (planning ${root.costUsd.toFixed(3)})
            </p>
          </>
        )}
        {root.output && (
          <>
            <h4>{root.model === 'simulated' ? 'Result (simulated)' : 'Result'}</h4>
            <pre className="agent-output">{root.output}</pre>
          </>
        )}
      </div>
    </details>
  );
}

function ModeBadge({ status }: { status: AgentStatus }) {
  if (status.mode === 'claude') return <Badge tone="ok">Claude</Badge>;
  if (status.mode === 'needs_key') return <Badge tone="danger">Needs API key</Badge>;
  return <Badge tone="warn">Simulated</Badge>;
}

function modeText(status: AgentStatus): string {
  if (status.mode === 'claude') {
    return `Uses Claude (${status.model}). $${status.spentUsd.toFixed(2)} of your $${status.budgetUsd} monthly budget used. The agent stops before any call that would go over it.`;
  }
  if (status.mode === 'needs_key') return 'A monthly budget is set, but no API key is stored. Add it in Settings → AI usage.';
  return 'Real calls are off, so the agent uses a stand-in that shows the plan, delegation and checks without doing real work. Nothing is billed.';
}

export function AgentPanel({ run }: { run: RunWithNext }) {
  const tasks = useAsync(() => call(iap().listAgentTasks(run.id)), [run.id]);
  const agent = useAsync(() => call(iap().agentStatus()), [run.id]);
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
      await Promise.all([tasks.reload(), agent.reload()]);
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
        {agent.data && <ModeBadge status={agent.data} />}
      </div>
      {agent.data && <p className="subtle">{modeText(agent.data)}</p>}
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
