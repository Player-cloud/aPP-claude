// The Build screen (M15, DEC-032): say what you want, watch Claude work, then
// review and keep the change. The composer starts a task from one sentence;
// the work view follows its live progress (steps, Claude's plan, questions
// that need the person) and then shows the review: checks before and after,
// the diff, what to look at, and keep, ask for changes, or discard.
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AgentStatus, Build, BuildDetail, CheckRun, Diff, LiveEvent, LiveState, Project, RecentBuild } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Alert, Badge, relativeTime, type Tone } from '../ui.tsx';

/** What a task's state means to the person, in their words. */
export function workStatus(b: Build, running: boolean): { label: string; tone: Tone } {
  if (running) return { label: 'Working', tone: 'live' };
  switch (b.status) {
    case 'review':
      return { label: 'Ready to review', tone: 'warn' };
    case 'completed':
      return { label: 'Kept', tone: 'ok' };
    case 'abandoned':
      return { label: 'Discarded', tone: 'neutral' };
    case 'draft':
      return { label: 'Not started', tone: 'neutral' };
    default:
      return { label: 'Stopped', tone: 'neutral' };
  }
}

function budgetLine(agent: AgentStatus | null): { text: string; tone: Tone } {
  if (!agent) return { text: '', tone: 'neutral' };
  if (agent.mode === 'claude') {
    const left = Math.max(0, (agent.budgetUsd ?? 0) - agent.spentUsd);
    return { text: `Claude · $${left.toFixed(2)} of $${agent.budgetUsd} left this month`, tone: 'ok' };
  }
  if (agent.mode === 'needs_key') return { text: 'Add your API key in Settings to use Claude', tone: 'warn' };
  return { text: 'Simulated (free): set a budget and key in Settings to use Claude', tone: 'neutral' };
}

/** "What do you want to build?" For one project, or with a project picker. */
export function Composer({
  projects,
  projectId,
  agent,
  onStarted,
  onProjectCreated,
}: {
  projects: Project[];
  projectId?: string;
  agent: AgentStatus | null;
  onStarted: (build: Build) => void;
  onProjectCreated?: () => void;
}) {
  const usable = projects.filter((p) => p.kind !== 'maintenance' && p.status === 'active');
  const [goal, setGoal] = useState('');
  const [chosen, setChosen] = useState(projectId ?? usable[0]?.id ?? '');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = projectId ?? chosen;
  const budget = budgetLine(agent);

  useEffect(() => {
    if (!projectId && !usable.some((p) => p.id === chosen) && usable[0]) setChosen(usable[0].id);
  }, [projectId, usable, chosen]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || goal.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      let id = target;
      if (!id) {
        if (!newName.trim()) throw new Error('Name the project this is for.');
        const created = await call(iap().createProject({ name: newName.trim(), facts: [] }));
        id = created.id;
        onProjectCreated?.();
      }
      const build = await call(iap().quickBuild({ projectId: id, goal: goal.trim() }));
      setGoal('');
      onStarted(build);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form className="task-composer" onSubmit={submit} aria-label="Start a task">
      <label className="task-composer-title" htmlFor={`goal-${projectId ?? 'any'}`}>
        What do you want to build?
      </label>
      <textarea
        id={`goal-${projectId ?? 'any'}`}
        className="textarea task-composer-input"
        rows={3}
        placeholder="For example: add a page that lists sessional workers with their holiday hours, or fix the crash when the rota is empty"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={onKey}
        disabled={busy}
      />
      <div className="task-composer-row">
        {!projectId && usable.length > 0 && (
          <label className="task-composer-project">
            <span>Project</span>
            <select className="select" value={chosen} onChange={(e) => setChosen(e.target.value)} aria-label="Project">
              {usable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {!projectId && usable.length === 0 && (
          <label className="task-composer-project">
            <span>New project</span>
            <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name it" aria-label="New project name" />
          </label>
        )}
        {budget.text && (
          <span className="task-composer-budget" data-tone={budget.tone}>
            {budget.text}
          </span>
        )}
        <span className="task-composer-spacer" />
        <kbd className="task-composer-kbd">Ctrl Enter</kbd>
        <button type="submit" className="btn btn-primary" disabled={busy || goal.trim().length < 3}>
          {busy ? 'Starting…' : 'Start'}
        </button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
    </form>
  );
}

/** Tasks as rows: what, where, when, state. */
export function WorkList({ builds, onOpen, showProject = true }: { builds: RecentBuild[]; onOpen: (id: string) => void; showProject?: boolean }) {
  if (builds.length === 0) return <p className="muted">Nothing yet. Your tasks appear here, with their progress and results.</p>;
  return (
    <ul className="work-list" aria-label="Your work">
      {builds.map((b) => {
        const s = workStatus(b, b.running);
        return (
          <li key={b.id}>
            <button type="button" className="work-row" onClick={() => onOpen(b.id)}>
              <span className="work-row-title">{b.title}</span>
              <span className="work-row-meta">
                {showProject ? `${b.projectName} · ` : ''}
                {relativeTime(b.updatedAt)}
                {b.agent && b.agent.costUsd > 0 ? ` · $${b.agent.costUsd.toFixed(2)}` : ''}
              </span>
              <Badge tone={s.tone}>{s.label}</Badge>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Follows live progress: polls while the work runs, and says when it stops. */
function useLive(buildId: string, onEnded: () => void) {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [state, setState] = useState<Pick<LiveState, 'running' | 'pending' | 'costUsd'> | null>(null);
  const since = useRef(0);
  const ended = useRef(onEnded);
  ended.current = onEnded;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    since.current = 0;
    setEvents([]);
    setState(null);
  }, [buildId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wasRunning = false;
    const poll = async () => {
      try {
        const live = await call(iap().buildLive({ buildId, since: since.current }));
        if (cancelled) return;
        if (live) {
          if (live.events.length) {
            since.current = live.events.at(-1)!.seq;
            setEvents((prev) => [...prev, ...live.events]);
          }
          setState({ running: live.running, pending: live.pending, costUsd: live.costUsd });
          if (wasRunning && !live.running) ended.current();
          wasRunning = live.running;
          if (live.running) timer = setTimeout(poll, 600);
        } else {
          setState({ running: false, pending: null, costUsd: 0 });
        }
      } catch {
        if (!cancelled) timer = setTimeout(poll, 2_000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [buildId, tick]);

  return { events, state, restart: () => setTick((t) => t + 1) };
}

const TOOL: Record<string, { icon: string; done: string }> = {
  Read: { icon: 'R', done: 'read' },
  read_file: { icon: 'R', done: 'read' },
  list_files: { icon: 'L', done: 'listed' },
  Glob: { icon: 'F', done: 'found files' },
  Grep: { icon: 'S', done: 'searched' },
  search: { icon: 'S', done: 'searched' },
  Edit: { icon: 'E', done: 'edited' },
  Write: { icon: 'W', done: 'written' },
  write_file: { icon: 'W', done: 'written' },
  Bash: { icon: '$', done: 'ran' },
  run_check: { icon: '✓', done: 'ran check' },
  Check: { icon: '✓', done: 'passed' },
  Setup: { icon: '↓', done: 'installed' },
};

function Timeline({ events, pending, buildId, onAnswered }: { events: LiveEvent[]; pending: LiveState['pending']; buildId: string; onAnswered: () => void }) {
  const [error, setError] = useState<string | null>(null);
  // Only the latest plan is shown, where it was last updated.
  const lastPlan = events.reduce((n, e, i) => (e.kind === 'plan' ? i : n), -1);
  const answer = async (approvalId: string, allow: boolean) => {
    setError(null);
    try {
      await call(iap().answerBuildQuestion({ buildId, approvalId, allow }));
      onAnswered();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <ol className="timeline" aria-label="What Claude is doing" aria-live="polite">
      {events.map((e, i) => {
        switch (e.kind) {
          case 'phase':
            return (
              <li key={e.seq} className="tl-phase">
                {e.text}
              </li>
            );
          case 'say':
            return (
              <li key={e.seq} className="tl-say">
                {e.text}
              </li>
            );
          case 'plan':
            if (i !== lastPlan) return null;
            return (
              <li key={e.seq} className="tl-plan">
                <span className="tl-label">Claude's plan</span>
                <ul aria-label="Claude's plan">
                  {e.items.map((it, j) => (
                    <li key={j} data-status={it.status}>
                      <span aria-hidden="true">{it.status === 'completed' ? '✓' : it.status === 'in_progress' ? '●' : '○'}</span> {it.text}
                    </li>
                  ))}
                </ul>
              </li>
            );
          case 'step': {
            const t = TOOL[e.tool] ?? { icon: '·', done: e.tool };
            return (
              <li key={e.seq} className="tl-step" data-ok={e.ok}>
                <span className="tl-icon" aria-hidden="true">
                  {e.ok ? t.icon : '!'}
                </span>
                <span className="mono tl-target" title={e.target}>
                  {e.target || e.tool}
                </span>
                <span className="tl-result">{e.ok ? t.done : e.tool === 'Check' ? e.note || 'failed' : 'refused'}</span>
                {!e.ok && e.note && e.tool !== 'Check' && <span className="tl-note">{e.note}</span>}
              </li>
            );
          }
          case 'ask': {
            const open = pending?.approvalId === e.approvalId;
            return (
              <li key={e.seq} className="tl-ask" data-open={open}>
                <strong>Claude wants to run a command</strong>
                <code className="mono">{e.detail}</code>
                {open ? (
                  <>
                    <span className="subtle">It isn't one of your approved checks. If you say no, Claude carries on without it.</span>
                    <div className="btn-row">
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => void answer(e.approvalId, true)}>
                        Allow once
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => void answer(e.approvalId, false)}>
                        Don't allow
                      </button>
                    </div>
                    {error && <Alert tone="danger">{error}</Alert>}
                  </>
                ) : null}
              </li>
            );
          }
          case 'answer':
            return (
              <li key={e.seq} className="tl-answer">
                {e.allowed ? 'You allowed it.' : 'Not allowed, so it did not run.'}
              </li>
            );
          case 'end':
            return (
              <li key={e.seq} className="tl-end" data-status={e.status}>
                {e.text}
              </li>
            );
        }
      })}
    </ol>
  );
}

/** Steps recorded on the build, for work that ran before the app was last started. */
function RecordedSteps({ build }: { build: Build }) {
  if (!build.agent) return <p className="muted">No agent run recorded yet.</p>;
  return (
    <ol className="timeline" aria-label="What Claude did">
      <li className="tl-phase">Claude worked on this {build.agent.model === 'simulated' ? '(simulated)' : ''}</li>
      {build.agent.steps.map((s, i) => {
        const t = TOOL[s.tool] ?? { icon: '·', done: s.tool };
        return (
          <li key={i} className="tl-step" data-ok={s.ok}>
            <span className="tl-icon" aria-hidden="true">
              {s.ok ? t.icon : '!'}
            </span>
            <span className="mono tl-target">{s.target || s.tool}</span>
            <span className="tl-result">{s.ok ? t.done : 'refused'}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** A unified diff, coloured line by line, one block per file. */
export function DiffView({ diff }: { diff: Diff }) {
  const files = diff.patch.split(/^(?=diff --git )/m).filter((f) => f.startsWith('diff --git'));
  if (files.length === 0) return <p className="muted">No changes.</p>;
  return (
    <div className="diffs">
      {files.map((block, i) => {
        const lines = block.split('\n');
        const name = /^diff --git a\/(.+?) b\//.exec(lines[0] ?? '')?.[1] ?? `file ${i + 1}`;
        const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
        const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
        const body = lines.slice(lines.findIndex((l) => l.startsWith('@@')));
        return (
          <details key={name + i} className="diff-file" open={i < 3}>
            <summary>
              <span className="mono">{name}</span>
              <span className="diff-count">
                <span className="diff-add">+{added}</span> <span className="diff-del">−{removed}</span>
              </span>
            </summary>
            <pre className="diff-body">
              {body.map((l, j) => (
                <span key={j} className={l.startsWith('@@') ? 'dl-hunk' : l.startsWith('+') ? 'dl-add' : l.startsWith('-') ? 'dl-del' : 'dl-ctx'}>
                  {l || ' '}
                </span>
              ))}
            </pre>
          </details>
        );
      })}
      {diff.truncated && <p className="subtle">The diff was cut short; open the work folder to see all of it.</p>}
    </div>
  );
}

const CHECK_TONE: Record<CheckRun['status'], Tone> = { passed: 'ok', failed: 'danger', timed_out: 'danger', error: 'danger', not_run: 'neutral' };

function CheckTable({ runs }: { runs: CheckRun[] }) {
  const latest = (phase: CheckRun['phase']) => {
    const m = new Map<string, CheckRun>();
    for (const r of runs) if (r.phase === phase) m.set(r.checkId, r);
    return m;
  };
  const before = latest('baseline');
  const after = latest('verify');
  const ids = [...new Set([...before.keys(), ...after.keys()])];
  if (ids.length === 0) return <p className="muted">No checks ran.</p>;
  return (
    <table className="check-table">
      <thead>
        <tr>
          <th scope="col">Check</th>
          <th scope="col">Before</th>
          <th scope="col">After</th>
        </tr>
      </thead>
      <tbody>
        {ids.map((id) => {
          const b = before.get(id);
          const a = after.get(id);
          return (
            <tr key={id}>
              <td className="mono" title={(a ?? b)?.command}>
                {(a ?? b)?.command ?? id}
              </td>
              <td>{b ? <Badge tone={CHECK_TONE[b.status]}>{b.status.replace('_', ' ')}</Badge> : '–'}</td>
              <td>{a ? <Badge tone={CHECK_TONE[a.status]}>{a.status.replace('_', ' ')}</Badge> : '–'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const KEEP_REASONS = ["I looked at it, it's fine", 'OK for now', "I'll fix it in a follow-up"];
const KEEP_NOTE: Record<string, string> = {
  [KEEP_REASONS[0]!]: 'Reviewed the change myself; it is fine.',
  [KEEP_REASONS[1]!]: 'Accepted as it is for now.',
  [KEEP_REASONS[2]!]: 'Will be fixed in a follow-up task.',
};

/** One task: live progress while it runs, then the review. */
export function WorkView({ buildId, onBack, onChanged }: { buildId: string; onBack: () => void; onChanged?: () => void }) {
  const [detail, setDetail] = useState<BuildDetail | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [followUp, setFollowUp] = useState('');
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const load = useCallback(async () => {
    try {
      const d = await call(iap().getBuild(buildId));
      setDetail(d);
      setDiff(d.build.worktree && d.build.status !== 'draft' && d.build.status !== 'abandoned' ? await call(iap().buildDiff(buildId)) : null);
      changed.current?.();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [buildId]);

  const live = useLive(buildId, () => void load());
  useEffect(() => {
    setDetail(null);
    setDiff(null);
    setReason(null);
    setNote('');
    void load();
  }, [buildId, load]);

  const running = live.state?.running ?? false;
  const b = detail?.build;
  const status = b ? workStatus(b, running) : null;
  const risks = b?.risks ?? [];

  const act = async (label: string, fn: () => Promise<unknown>, restart = false) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      if (restart) live.restart();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const keep = () => {
    const parts = [reason ? KEEP_NOTE[reason] : null, note.trim() || null].filter(Boolean);
    return act('keep', () => call(iap().completeBuild({ buildId, note: parts.join(' ') || null })));
  };

  return (
    <article className="work-view" aria-label={b?.title ?? 'Task'}>
      <div className="work-head">
        <button type="button" className="btn btn-sm" onClick={onBack}>
          ← All work
        </button>
        <div className="work-head-text">
          <h1 className="page-title work-title">{b?.title ?? 'Loading…'}</h1>
          {b && <p className="subtle">{b.goal !== b.title ? b.goal : ''}</p>}
        </div>
        <div className="work-head-actions">
          {status && <Badge tone={status.tone}>{status.label}</Badge>}
          {live.state && live.state.costUsd > 0 && <span className="pill">${live.state.costUsd.toFixed(2)}</span>}
          {running && (
            <button type="button" className="btn btn-sm" onClick={() => void act('stop', () => call(iap().stopBuild(buildId)))} disabled={busy !== null}>
              Stop
            </button>
          )}
        </div>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="work-grid">
        <section className="work-main" aria-label="Progress">
          {live.events.length > 0 ? (
            <Timeline events={live.events} pending={live.state?.pending ?? null} buildId={buildId} onAnswered={() => undefined} />
          ) : (
            b && <RecordedSteps build={b} />
          )}
          {b && !running && b.agent && (
            <div className="work-summary">
              <span className="tl-label">Claude's summary</span>
              <p>{b.agent.summary}</p>
              {b.agent.resolution && <p className="subtle">{b.agent.resolution}</p>}
            </div>
          )}
          {diff && !running && (
            <section aria-label="Changes">
              <h2 className="card-title">What changed</h2>
              <DiffView diff={diff} />
            </section>
          )}
        </section>

        <aside className="work-side" aria-label="Review">
          {b && detail && (
            <div className="work-box">
              <h2 className="work-box-title">Checks</h2>
              <CheckTable runs={detail.checkRuns} />
            </div>
          )}
          {b && b.status === 'review' && !running && (
            <>
              <div className="work-box">
                <h2 className="work-box-title">Worth a look</h2>
                {risks.length ? (
                  <ul className="small-list" aria-label="Risks">
                    {risks.map((r, i) => (
                      <li key={i}>{r.detail}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="subtle">The automatic review found nothing to flag.</p>
                )}
              </div>
              <div className="work-box">
                <h2 className="work-box-title">Keep this change?</h2>
                {risks.length > 0 && (
                  <div className="chips" role="radiogroup" aria-label="Why it is OK to keep">
                    {KEEP_REASONS.map((r) => (
                      <button key={r} type="button" role="radio" aria-checked={reason === r} className="chip" onClick={() => setReason(r)}>
                        {r}
                      </button>
                    ))}
                  </div>
                )}
                <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Note" />
                <div className="btn-row">
                  <button type="button" className="btn btn-primary" disabled={busy !== null || (risks.length > 0 && !reason && note.trim().length < 10)} onClick={() => void keep()}>
                    Keep the change
                  </button>
                  <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => void act('discard', () => call(iap().abandonBuild({ buildId, reason: 'Discarded from the review.' })))}>
                    Discard
                  </button>
                </div>
                {risks.length > 0 && !reason && <p className="subtle">Pick one so the record says why it was kept.</p>}
              </div>
              <form
                className="work-box"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act('follow', () => call(iap().followUpBuild({ buildId, text: followUp })).then(() => setFollowUp('')), true);
                }}
              >
                <h2 className="work-box-title">Ask for changes</h2>
                <textarea className="textarea" rows={2} value={followUp} onChange={(e) => setFollowUp(e.target.value)} placeholder="For example: also email the manager when someone is flagged" aria-label="What to change" />
                <div className="btn-row">
                  <button type="submit" className="btn" disabled={busy !== null || followUp.trim().length < 3}>
                    Send to Claude
                  </button>
                </div>
              </form>
            </>
          )}
          {b && b.status === 'completed' && (
            <div className="work-box">
              <h2 className="work-box-title">Kept</h2>
              <p>
                Saved on branch <span className="mono">{b.branch}</span>
                {b.resultCommit ? (
                  <>
                    {' '}
                    as commit <span className="mono">{b.resultCommit.slice(0, 7)}</span>
                  </>
                ) : null}
                . Merge it into your main branch when you are ready; nothing was merged or pushed for you.
              </p>
            </div>
          )}
          {b && (
            <details className="work-box work-details">
              <summary>Details</summary>
              <dl className="kv-list">
                <dt>Kind</dt>
                <dd>{b.kind === 'bugfix' ? 'Bug fix' : b.kind === 'ui_polish' ? 'UI polish' : 'Feature'}</dd>
                {b.branch && (
                  <>
                    <dt>Branch</dt>
                    <dd className="mono">{b.branch}</dd>
                  </>
                )}
                {b.worktree && (
                  <>
                    <dt>Work folder</dt>
                    <dd className="mono">{b.worktree}</dd>
                  </>
                )}
                {b.agent && (
                  <>
                    <dt>Model</dt>
                    <dd>{b.agent.model}</dd>
                  </>
                )}
              </dl>
            </details>
          )}
        </aside>
      </div>
    </article>
  );
}

/** The Build home: composer and the person's work across projects. */
export function BuildHome({ projects, agent, onProjectsChanged, openBuild, onOpenBuild }: { projects: Project[] | null; agent: AgentStatus | null; onProjectsChanged: () => void; openBuild: string | null; onOpenBuild: (id: string | null) => void }) {
  const [builds, setBuilds] = useState<RecentBuild[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    call(iap().recentBuilds())
      .then((b) => {
        setBuilds(b);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!openBuild) reload();
  }, [openBuild, reload]);
  // Keep the list's states fresh while something is running.
  useEffect(() => {
    if (openBuild || !builds?.some((b) => b.running)) return;
    const t = setInterval(reload, 2_000);
    return () => clearInterval(t);
  }, [openBuild, builds, reload]);

  if (openBuild) return <WorkView buildId={openBuild} onBack={() => onOpenBuild(null)} />;
  return (
    <div className="build-home">
      <Composer projects={projects ?? []} agent={agent} onStarted={(b) => onOpenBuild(b.id)} onProjectCreated={onProjectsChanged} />
      <section aria-labelledby="work-title">
        <h2 className="card-title" id="work-title">
          Your work
        </h2>
        {error && <Alert tone="danger">{error}</Alert>}
        {builds && <WorkList builds={builds} onOpen={onOpenBuild} />}
      </section>
    </div>
  );
}
