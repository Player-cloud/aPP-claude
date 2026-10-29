// The Build screen (M15, DEC-032): say what you want, watch Claude work, then
// review and keep the change. The composer starts a task from one sentence;
// the work view follows its live progress (steps, Claude's plan, questions
// that need the person) and then shows the report (M16, DEC-033): a headline,
// the numbers, the changed files and their diff, the commands that ran, what
// is left before it ships, and Keep or Undo in one tap.
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AgentStatus, Build, BuildDetail, ChangedFile, Diff, LiveEvent, LiveState, Project, RecentBuild } from '../../shared/api.ts';
import { formatDuration, groupFiles, keepNote, makeReport, type ReportCommand, type ReportTone } from '../../shared/report.ts';
import { highlight, langOf } from '../highlight.tsx';
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

/** One file's unified diff, coloured line by line, with syntax colouring. */
function FileDiff({ path, block }: { path: string; block: string }) {
  const lines = block.split('\n');
  const start = lines.findIndex((l) => l.startsWith('@@'));
  const body = start < 0 ? [] : lines.slice(start);
  const lang = langOf(path);
  if (body.length === 0) return <p className="subtle diff-empty">No text changes to show (a binary file, a rename or an empty file).</p>;
  return (
    <pre className="diff-body" aria-label={`Changes to ${path}`}>
      {body.map((l, j) => {
        const kind = l.startsWith('@@') ? 'dl-hunk' : l.startsWith('+') ? 'dl-add' : l.startsWith('-') ? 'dl-del' : 'dl-ctx';
        if (kind === 'dl-hunk') {
          return (
            <span key={j} className={kind}>
              {l}
            </span>
          );
        }
        return (
          <span key={j} className={kind}>
            <span className="dl-mark" aria-hidden="true">
              {l.slice(0, 1) || ' '}
            </span>
            {highlight(l.slice(1), lang)}
            {l.length <= 1 ? ' ' : ''}
          </span>
        );
      })}
    </pre>
  );
}

/** Each file's block of a unified diff, by path. */
function splitPatch(patch: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of patch.split(/^(?=diff --git )/m)) {
    if (!block.startsWith('diff --git')) continue;
    const name = /^diff --git a\/(.+?) b\/(.+)$/m.exec(block);
    if (name) out.set(name[2]!, block);
  }
  return out;
}

const FILE_MARK: Record<ChangedFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };

/** What changed: the files as a tree with line counts, and the selected file's diff. */
export function Changes({ diff }: { diff: Diff }) {
  const blocks = splitPatch(diff.patch);
  const groups = groupFiles(diff.files);
  const [open, setOpen] = useState<string | null>(diff.files[0]?.path ?? null);
  useEffect(() => {
    if (!open || !diff.files.some((f) => f.path === open)) setOpen(diff.files[0]?.path ?? null);
  }, [diff, open]);
  if (diff.files.length === 0) return <p className="muted">No files changed.</p>;
  return (
    <div className="changes">
      <ul className="file-tree" aria-label="Changed files">
        {groups.map((g) => (
          <li key={g.dir || '.'}>
            {g.dir && <span className="file-dir mono">{g.dir}/</span>}
            <ul>
              {g.files.map((f) => (
                <li key={f.path}>
                  <button type="button" className="file-row" aria-pressed={open === f.path} onClick={() => setOpen(f.path)} title={f.path}>
                    <span className="file-mark" data-status={f.status} aria-label={f.status}>
                      {FILE_MARK[f.status]}
                    </span>
                    <span className="mono file-name">{f.name}</span>
                    <span className="diff-count">
                      {f.added > 0 && <span className="diff-add">+{f.added}</span>} {f.removed > 0 && <span className="diff-del">−{f.removed}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {open && (
        <div className="file-diff">
          <div className="file-diff-head mono">{open}</div>
          <FileDiff path={open} block={blocks.get(open) ?? ''} />
        </div>
      )}
      {diff.truncated && <p className="subtle">The diff was cut short; open the work folder to see all of it.</p>}
    </div>
  );
}

/** The commands that ran, as a terminal: checks with their times, then Claude's own. */
function Terminal({ commands }: { commands: ReportCommand[] }) {
  if (commands.length === 0) return <p className="muted">No commands ran. Nothing tested this change.</p>;
  return (
    <ol className="terminal" aria-label="Commands that ran">
      {commands.map((c, i) => (
        <li key={i} data-ok={c.ok}>
          <span className="term-mark" aria-label={c.ok ? 'passed' : 'failed'}>
            {c.ok ? '✓' : '✗'}
          </span>
          <span className="term-cmd" title={c.command}>
            {c.command}
          </span>
          <span className="term-meta">{c.durationMs !== null ? formatDuration(c.durationMs) : c.note || 'by Claude'}</span>
          {c.from === 'check' && c.note && <span className="term-note">{c.note}</span>}
        </li>
      ))}
    </ol>
  );
}

const STAT_TONE: Record<ReportTone, Tone> = { ok: 'ok', warn: 'warn', danger: 'danger', neutral: 'neutral' };

/** One task: live progress while it runs, then the report. */
export function WorkView({ buildId, onBack, onChanged }: { buildId: string; onBack: () => void; onChanged?: () => void }) {
  const [detail, setDetail] = useState<BuildDetail | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [followUp, setFollowUp] = useState('');
  const followRef = useRef<HTMLInputElement>(null);
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
    setNote('');
    setNoteOpen(false);
    void load();
  }, [buildId, load]);

  const running = live.state?.running ?? false;
  const b = detail?.build;
  const status = b ? workStatus(b, running) : null;
  const reportable = b && (b.agent !== null || b.status === 'review' || b.status === 'completed' || b.status === 'abandoned');
  const report = b && detail && !running && reportable ? makeReport(b, detail.checkRuns, diff?.files ?? null) : null;

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

  const ask = (text: string) => {
    setFollowUp(text);
    followRef.current?.focus();
  };

  const timeline =
    live.events.length > 0 ? (
      <Timeline events={live.events} pending={live.state?.pending ?? null} buildId={buildId} onAnswered={() => undefined} />
    ) : (
      b && <RecordedSteps build={b} />
    );
  const steps = b?.agent?.steps.length ?? live.events.filter((e) => e.kind === 'step').length;

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

      {!report ? (
        <section className="work-main" aria-label="Progress">
          {timeline}
        </section>
      ) : (
        <section className="report" aria-label="Report">
          <header className="report-head">
            <h2 className="report-headline" data-tone={report.tone}>
              {report.headline}
            </h2>
            {report.summary && <p className="report-summary">{report.summary}</p>}
          </header>

          <dl className="stat-row" aria-label="At a glance">
            <div data-tone={report.checks.total === 0 ? 'neutral' : STAT_TONE[report.checks.passed === report.checks.total ? 'ok' : 'danger']}>
              <dt>Checks passed</dt>
              <dd>{report.checks.total === 0 ? 'None ran' : `${report.checks.passed}/${report.checks.total}`}</dd>
            </div>
            <div>
              <dt>Files changed</dt>
              <dd>{report.files.length}</dd>
            </div>
            <div>
              <dt>Lines</dt>
              <dd>
                <span className="diff-add">+{report.added}</span> <span className={report.removed ? 'diff-del' : 'subtle'}>−{report.removed}</span>
              </dd>
            </div>
            <div>
              <dt>Cost</dt>
              <dd>{b!.agent?.model === 'simulated' ? 'Free' : `$${report.costUsd.toFixed(2)}`}</dd>
            </div>
          </dl>

          <div className="report-grid">
            <section className="report-section" aria-labelledby={`changes-${buildId}`}>
              <h3 className="report-title" id={`changes-${buildId}`}>
                What changed
              </h3>
              {diff ? <Changes diff={diff} /> : <p className="muted">{b!.status === 'abandoned' ? 'This change was undone.' : 'There is no change to show.'}</p>}
            </section>
            <div className="report-aside">
              <section className="report-section" aria-labelledby={`cmds-${buildId}`}>
                <h3 className="report-title" id={`cmds-${buildId}`}>
                  Commands
                </h3>
                <Terminal commands={report.commands} />
              </section>
              <section className="report-section" aria-labelledby={`ships-${buildId}`}>
                <h3 className="report-title" id={`ships-${buildId}`}>
                  Before it ships
                </h3>
                {report.todos.length ? (
                  <ul className="todo-list" aria-label="Before it ships">
                    {report.todos.map((t, i) => (
                      <li key={i}>
                        <span className="todo-dot" aria-hidden="true" />
                        <span className="todo-text">{t}</span>
                        {b!.status === 'review' && (
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => ask(t)} aria-label={`Ask Claude to handle: ${t}`}>
                            Ask Claude
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="subtle">Nothing left to do.</p>
                )}
              </section>
            </div>
          </div>

          <details className="report-steps">
            <summary>
              How Claude did it · {steps} {steps === 1 ? 'step' : 'steps'}
            </summary>
            {timeline}
          </details>

          {b!.status === 'review' && (
            <div className="report-actions" role="group" aria-label="Keep or undo">
              <form
                className="follow-bar"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act('follow', () => call(iap().followUpBuild({ buildId, text: followUp })).then(() => setFollowUp('')), true);
                }}
              >
                <input ref={followRef} className="input" value={followUp} onChange={(e) => setFollowUp(e.target.value)} placeholder="Ask for changes…" aria-label="What to change" />
                {followUp.trim().length >= 3 && (
                  <button type="submit" className="btn" disabled={busy !== null}>
                    Send to Claude
                  </button>
                )}
              </form>
              <span className="action-sep" aria-hidden="true" />
              <button type="button" className="btn btn-ghost btn-sm" aria-expanded={noteOpen} onClick={() => setNoteOpen((o) => !o)}>
                Note
              </button>
              <button type="button" className="btn" disabled={busy !== null} title="Throw this change away. The work folder stays on disk." onClick={() => void act('discard', () => call(iap().abandonBuild({ buildId, reason: note.trim() || 'Undone from the review.' })))}>
                Undo
              </button>
              <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void act('keep', () => call(iap().completeBuild({ buildId, note: keepNote(b!, note) })))}>
                Keep
              </button>
              {noteOpen && <input className="input keep-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="A note for the record, saved when you keep or undo" aria-label="Note" autoFocus />}
            </div>
          )}
          {b!.status === 'completed' && (
            <div className="report-done">
              <h3 className="report-title">Kept</h3>
              <p>
                Saved on branch <span className="mono">{b!.branch}</span>
                {b!.resultCommit ? (
                  <>
                    {' '}
                    as commit <span className="mono">{b!.resultCommit.slice(0, 7)}</span>
                  </>
                ) : null}
                . Merge it into your main branch when you are ready; nothing was merged or pushed for you.
              </p>
            </div>
          )}
          <details className="report-steps">
            <summary>Details</summary>
            <dl className="kv-list">
              <dt>Kind</dt>
              <dd>{b!.kind === 'bugfix' ? 'Bug fix' : b!.kind === 'ui_polish' ? 'UI polish' : 'Feature'}</dd>
              {b!.branch && (
                <>
                  <dt>Branch</dt>
                  <dd className="mono">{b!.branch}</dd>
                </>
              )}
              {b!.worktree && (
                <>
                  <dt>Work folder</dt>
                  <dd className="mono">{b!.worktree}</dd>
                </>
              )}
              {b!.agent && (
                <>
                  <dt>Model</dt>
                  <dd>{b!.agent.model}</dd>
                </>
              )}
              {b!.note && (
                <>
                  <dt>Note</dt>
                  <dd>{b!.note}</dd>
                </>
              )}
            </dl>
          </details>
        </section>
      )}
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
