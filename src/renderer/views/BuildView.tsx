// The Build screen (M15, DEC-032): say what you want, watch Claude work, then
// review and keep the change. The composer starts a task from one sentence;
// the work view follows its live progress (steps, Claude's plan, questions
// that need the person) and then shows the report (M16, DEC-033): a headline,
// the numbers, the changed files and their diff, the commands that ran, what
// is left before it ships, and Keep or Undo in one tap.
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AgentStatus, Build, BuildDetail, ChangedFile, Diff, LiveEvent, LiveState, PreviewState, Project, RecentBuild, Todo } from '../../shared/api.ts';
import { describeStep, formatDuration, groupFiles, keepNote, makeReport, progressStages, STAGES, statusLine, type ReportCommand, type ReportTone } from '../../shared/report.ts';
import { highlight, langOf } from '../highlight.tsx';
import { call, iap } from '../api.ts';
import { Icon } from '../icons.tsx';
import { CanvasFrame } from './Canvas.tsx';
import { HelperCards } from './Helpers.tsx';
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
  initial = '',
}: {
  projects: Project[];
  projectId?: string;
  agent: AgentStatus | null;
  initial?: string;
  onStarted: (build: Build) => void;
  onProjectCreated?: () => void;
}) {
  const usable = projects.filter((p) => p.kind !== 'maintenance' && p.status === 'active');
  const [goal, setGoal] = useState(initial);
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

  // The box grows with the text, up to a few lines, like a chat message bar.
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  return (
    <form className="task-composer" onSubmit={submit} aria-label="Start a task">
      <label className="visually-hidden" htmlFor={`goal-${projectId ?? 'any'}`}>
        What do you want to build?
      </label>
      <div className="task-composer-bar">
        <textarea
          id={`goal-${projectId ?? 'any'}`}
          className="task-composer-input"
          rows={1}
          placeholder={projectId ? 'What should Claude build or fix here?' : 'What do you want to build or fix?'}
          value={goal}
          onChange={(e) => {
            setGoal(e.target.value);
            grow(e.target);
          }}
          onKeyDown={onKey}
          disabled={busy}
        />
        <button type="submit" className="task-composer-go" aria-label={busy ? 'Starting…' : 'Start'} title="Start (Ctrl Enter)" disabled={busy || goal.trim().length < 3}>
          <Icon name="arrowUp" size={16} />
        </button>
      </div>
      <div className="task-composer-row">
        {!projectId && usable.length > 0 && (
          <label className="task-composer-project">
            <span className="visually-hidden">Project</span>
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
        <kbd className="task-composer-kbd">Ctrl Enter</kbd>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
    </form>
  );
}

const EXAMPLES = ['Add a page that lists members with their roles', 'Fix the crash when the rota is empty', 'Add a CSV export to the holiday report'];

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
  const [state, setState] = useState<Pick<LiveState, 'running' | 'pending' | 'paused' | 'costUsd'> | null>(null);
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
          setState({ running: live.running, pending: live.pending, paused: live.paused, costUsd: live.costUsd });
          if (wasRunning && !live.running) ended.current();
          wasRunning = live.running;
          if (live.running) timer = setTimeout(poll, 600);
        } else {
          setState({ running: false, pending: null, paused: false, costUsd: 0 });
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

const TOOL_ICON: Record<string, string> = {
  Read: 'R',
  read_file: 'R',
  list_files: 'L',
  Glob: 'F',
  Grep: 'S',
  search: 'S',
  Edit: 'E',
  Write: 'W',
  write_file: 'W',
  Bash: '$',
  run_check: '✓',
  Check: '✓',
  Setup: '↓',
};

/** One step in plain words (M17 M): "Read src/members.ts", "Was not allowed to run npm install". */
function StepLine({ step }: { step: { tool: string; target: string; ok: boolean } }) {
  const { verb, object } = describeStep(step);
  return (
    <>
      <span className="tl-icon" aria-hidden="true">
        {step.ok ? (TOOL_ICON[step.tool] ?? '·') : '!'}
      </span>
      <span className="tl-text">
        {verb}{' '}
        {object && (
          <span className="mono tl-target" title={object}>
            {object}
          </span>
        )}
      </span>
    </>
  );
}

/** Where the work is, as named stages (M17 M). */
/** Stages for the strip above the canvas: live while the work runs, from the task's state once it is over. */
function stagesFor(b: Build, events: LiveEvent[], running: boolean): ReturnType<typeof progressStages> | null {
  if (running || events.some((e) => e.kind === 'end')) return progressStages(events);
  if (b.status === 'abandoned' || b.status === 'draft') return null;
  if (b.status === 'review' || b.status === 'completed') return STAGES.map((st) => ({ ...st, state: 'done' as const }));
  return STAGES.map((st, i) => ({ ...st, state: i < 1 ? ('done' as const) : i === 1 ? ('stopped' as const) : ('todo' as const) }));
}

function StageBar({ stages }: { stages: ReturnType<typeof progressStages> }) {
  return (
    <ol className="progress-stages" aria-label="Stages">
      {stages.map((st) => (
        <li key={st.id} data-state={st.state} aria-current={st.state === 'current' ? 'step' : undefined}>
          <span className="progress-dot" aria-hidden="true">
            {st.state === 'done' ? '✓' : st.state === 'stopped' ? '!' : ''}
          </span>
          {st.label}
          {st.state === 'stopped' && <span className="visually-hidden"> (stopped here)</span>}
        </li>
      ))}
    </ol>
  );
}

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
          case 'step':
            return (
              <li key={e.seq} className="tl-step" data-ok={e.ok}>
                <StepLine step={e} />
                {!e.ok && e.note && <span className="tl-note">{e.note}</span>}
              </li>
            );
          case 'pause':
            return (
              <li key={e.seq} className="tl-answer">
                {e.paused ? 'You paused the work. Claude waits before its next step.' : 'You let Claude carry on.'}
              </li>
            );
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
      {build.agent.steps.map((s, i) => (
        <li key={i} className="tl-step" data-ok={s.ok}>
          <StepLine step={s} />
        </li>
      ))}
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

/**
 * The page being built (M16 H): the project's dev server or static page,
 * pictured in the app. While Claude works the picture refreshes by itself.
 */
export function PreviewPane({ buildId, live }: { buildId: string; live: boolean }) {
  const [state, setState] = useState<PreviewState | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setState(null);
    setShot(null);
    setError(null);
    call(iap().previewState(buildId))
      .then(setState)
      .catch((e: Error) => setError(e.message));
  }, [buildId]);

  const capture = useCallback(async () => {
    try {
      setShot(await call(iap().capturePreview({ buildId, width: 1280, height: 800 })));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [buildId]);

  const running = state?.status === 'running';
  useEffect(() => {
    if (!running) return;
    void capture();
    if (!live) return;
    const t = setInterval(() => void capture(), 5_000);
    return () => clearInterval(t);
  }, [running, live, capture]);

  const start = async () => {
    setBusy(true);
    setError(null);
    setState((s) => (s ? { ...s, status: 'starting' } : s));
    try {
      setState(await call(iap().startPreview(buildId)));
    } catch (e) {
      setError((e as Error).message);
      setState(await call(iap().previewState(buildId)));
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    await call(iap().stopPreview(buildId)).catch(() => undefined);
    setShot(null);
    setState(await call(iap().previewState(buildId)));
  };

  if (!state) return error ? <Alert tone="danger">{error}</Alert> : null;
  if (!state.plan) return <p className="subtle">Nothing to preview: the project has no dev or start script and no index.html.</p>;
  const what = state.plan.kind === 'script' ? <code className="mono">{state.plan.command}</code> : 'its index.html';
  return (
    <div className="preview">
      <div className="preview-bar">
        <span className="preview-dot" data-status={state.status} aria-hidden="true" />
        <span className="preview-where">
          {running ? (
            <>
              Running on <span className="mono">{state.url?.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span>
            </>
          ) : state.status === 'starting' ? (
            'Starting the preview…'
          ) : state.status === 'failed' ? (
            "The preview didn't start"
          ) : (
            <>Preview runs {what} in this task's copy</>
          )}
        </span>
        <span className="preview-actions">
          {running ? (
            <>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void capture()}>
                Refresh
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void call(iap().openPreview(buildId)).catch((e: Error) => setError(e.message))}>
                Open in browser
              </button>
              <button type="button" className="btn btn-sm" onClick={() => void stop()}>
                Stop
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-sm" disabled={busy || state.status === 'starting'} onClick={() => void start()}>
              {state.status === 'failed' ? 'Try again' : 'Start preview'}
            </button>
          )}
        </span>
      </div>
      {running && (shot ? <img className="preview-shot" src={shot} alt="The page as it looks now" /> : <div className="preview-shot preview-wait">Taking a picture…</div>)}
      {state.status === 'failed' && state.log && <pre className="preview-log">{state.log.slice(-1_500)}</pre>}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

const STAT_TONE: Record<ReportTone, Tone> = { ok: 'ok', warn: 'warn', danger: 'danger', neutral: 'neutral' };

/** One task: live progress while it runs, then the report. */
/**
 * To-dos kept from "Before it ships" (M17 K): tick one off, ask Claude while
 * the change is in review, or start a new task from it.
 */
export function TodoItems({
  todos,
  label,
  onChanged,
  ask,
  onOpenTask,
  taskTitle,
}: {
  todos: Todo[];
  label: string;
  onChanged: () => void;
  ask?: (text: string) => void;
  onOpenTask?: (buildId: string) => void;
  /** The task each to-do came from, shown on the project page. */
  taskTitle?: (buildId: string) => string | undefined;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <ul className="todo-list tracked" aria-label={label}>
        {todos.map((t) => {
          const from = taskTitle?.(t.buildId);
          return (
            <li key={t.id} data-status={t.status}>
              <input
                type="checkbox"
                id={`todo-${t.id}`}
                checked={t.status === 'done'}
                disabled={busy !== null}
                onChange={(e) => void run(t.id, () => call(iap().setTodoDone({ id: t.id, done: e.currentTarget.checked })))}
              />
              <label className="todo-text" htmlFor={`todo-${t.id}`}>
                {t.text}
                {from && <span className="todo-from">From “{from}”</span>}
              </label>
              {t.status === 'open' &&
                (ask ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => ask(t.text)} aria-label={`Ask Claude to handle: ${t.text}`}>
                    Ask Claude
                  </button>
                ) : t.taskBuildId ? (
                  onOpenTask && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenTask(t.taskBuildId!)} aria-label={`Open the task for: ${t.text}`}>
                      Open task
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy !== null}
                    aria-label={`Start a task for: ${t.text}`}
                    onClick={() => void run(t.id, async () => onOpenTask?.((await call(iap().todoToTask(t.id))).id))}
                  >
                    New task
                  </button>
                ))}
            </li>
          );
        })}
      </ul>
      {error && <Alert tone="danger">{error}</Alert>}
    </>
  );
}

export function WorkView({
  buildId,
  onBack,
  onChanged,
  onOpenTask,
  onPages,
  focusAsk = false,
}: {
  buildId: string;
  onBack: () => void;
  onChanged?: () => void;
  onOpenTask?: (buildId: string) => void;
  /** Opens the Pages screen for this task (M18). */
  onPages?: (buildId: string) => void;
  /** Opened to ask Claude for changes: the ask bar gets focus once the report is shown (M17 K). */
  focusAsk?: boolean;
}) {
  const [detail, setDetail] = useState<BuildDetail | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [followUp, setFollowUp] = useState('');
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const followRef = useRef<HTMLInputElement>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const load = useCallback(async () => {
    try {
      const d = await call(iap().getBuild(buildId));
      setDetail(d);
      setDiff(d.build.worktree && d.build.status !== 'draft' && d.build.status !== 'abandoned' ? await call(iap().buildDiff(buildId)) : null);
      setTodos((await call(iap().listTodos({ buildId }))).filter((t) => t.status === 'open' || t.status === 'done'));
      setAgent(await call(iap().agentStatus()).catch(() => null));
      changed.current?.();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [buildId]);

  const live = useLive(buildId, () => void load());
  useEffect(() => {
    setDetail(null);
    setDiff(null);
    setTodos(null);
    setNote('');
    setNoteOpen(false);
    void load();
  }, [buildId, load]);

  const running = live.state?.running ?? false;
  const b = detail?.build;
  const paused = live.state?.paused ?? false;
  const status = b ? (running && paused ? { label: 'Paused', tone: 'warn' as const } : workStatus(b, running)) : null;
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

  const askReady = Boolean(report && b?.status === 'review');
  useEffect(() => {
    if (focusAsk && askReady) followRef.current?.focus();
  }, [focusAsk, askReady]);

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
  const now = running ? statusLine(live.events, live.state?.pending ?? null, paused) : null;

  const stages = b ? stagesFor(b, live.events, running) : null;
  const cost = live.state && live.state.costUsd > 0 ? live.state.costUsd : (b?.agent?.costUsd ?? 0);
  const simulated = b?.agent?.model === 'simulated' || (!b?.agent && agent?.mode !== 'claude');
  const pending = live.state?.pending ?? null;

  // The thread column: what was asked, who is doing it and what it costs, and what waits for the person.
  const thread = b && (
    <div className="canvas-col" data-col="thread">
      <h2 className="col-head">Thread</h2>
      <section className="kcard ask-card" aria-label="Your ask">
        <p className="who">
          <span className="who-face" aria-hidden="true">
            Y
          </span>
          You · {relativeTime(b.createdAt)}
        </p>
        <p className="ask-text">{b.goal}</p>
        {b.worktree && (
          <p className="ask-meta">
            <span className="mono">{b.branch ?? 'own branch'}</span> · a separate copy of your code
          </p>
        )}
      </section>
      <section className="kcard claude-card" aria-label="Claude">
        <span className="chip chip-agent">
          <span className="chip-dot" aria-hidden="true" />
          {simulated ? 'Simulated agent' : 'Claude'}
        </span>
        <h3 className="claude-card-title">{running ? (paused ? 'Paused' : 'Working on it') : b.agent ? `${steps} ${steps === 1 ? 'step' : 'steps'} taken` : 'Not started'}</h3>
        <p className="claude-card-text">{b.agent?.model && b.agent.model !== 'simulated' ? b.agent.model : simulated ? 'No AI is called; the steps show the workflow.' : (agent?.model ?? '')}</p>
        <dl className="kv-mini">
          <dt>This task</dt>
          <dd>{simulated ? 'Free' : `$${cost.toFixed(2)}`}</dd>
          {b.helpers?.length ? (
            <>
              <dt>Helpers</dt>
              <dd>{b.helpers.length} · Free</dd>
            </>
          ) : null}
          {agent?.budgetUsd ? (
            <>
              <dt>This month</dt>
              <dd>
                ${agent.spentUsd.toFixed(2)} of ${agent.budgetUsd.toFixed(2)}
              </dd>
            </>
          ) : null}
        </dl>
        {agent?.budgetUsd ? (
          <div className="meter" role="img" aria-label={`${Math.round((agent.spentUsd / agent.budgetUsd) * 100)}% of this month's budget spent`}>
            <i style={{ width: `${Math.min(100, (agent.spentUsd / agent.budgetUsd) * 100)}%` }} />
          </div>
        ) : null}
      </section>
      {pending && (
        <section className="kcard note-card" aria-label="Waiting for you">
          <p className="who note-who">Waiting for you</p>
          <h3 className="note-title">Claude asks to run a command</h3>
          <p className="mono note-code">{pending.detail ?? pending.tool}</p>
          <p className="subtle">Answer in the steps beside this.</p>
        </section>
      )}
      {!pending && b.status === 'review' && report && (
        <section className="kcard note-card" aria-label="Waiting for you">
          <p className="who note-who">Waiting for you</p>
          <h3 className="note-title">Keep or undo this change</h3>
          <p className="subtle">Keep saves it on its own branch; Undo throws it away. You can also ask Claude for changes below.</p>
        </section>
      )}
      {report?.trouble && (
        <section className="kcard trouble" aria-labelledby={`trouble-${buildId}`}>
          <h3 className="report-title" id={`trouble-${buildId}`}>
            What went wrong
          </h3>
          <p>{report.trouble.what}</p>
          <h3 className="report-title">What you can do</h3>
          <p>{report.trouble.next}</p>
          {report.trouble.ask && (
            <div className="btn-row">
              <button type="button" className="btn btn-sm" onClick={() => ask(report.trouble!.ask!)}>
                Ask Claude to fix it
              </button>
            </div>
          )}
        </section>
      )}
      {b.status === 'completed' && (
        <section className="kcard report-done">
          <h3 className="report-title">Kept</h3>
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
        </section>
      )}
    </div>
  );

  // The steps column: how the work went, step by step, and the commands that ran.
  const stepsCol = b && (
    <div className="canvas-col" data-col="steps">
      {report && b.helpers?.length ? (
        <>
          <h2 className="col-head">
            Helpers <span className="col-count">{b.helpers.length}</span>
          </h2>
          <HelperCards helpers={b.helpers} />
        </>
      ) : (
        <h2 className="col-head">
          Steps <span className="col-count">{steps}</span>
        </h2>
      )}
      {report ? (
        <section className="kcard">
          <details className="report-steps">
            <summary>
              How Claude did it · {steps} {steps === 1 ? 'step' : 'steps'}
            </summary>
            {timeline}
          </details>
        </section>
      ) : (
        <section className="kcard work-main" aria-label="Progress">
          {timeline}
        </section>
      )}
      {report && (
        <section className="kcard" aria-labelledby={`cmds-${buildId}`}>
          <h3 className="kcard-title" id={`cmds-${buildId}`}>
            Commands
          </h3>
          <Terminal commands={report.commands} />
        </section>
      )}
      {report && (
        <details className="kcard report-steps">
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
            {b.note && (
              <>
                <dt>Note</dt>
                <dd>{b.note}</dd>
              </>
            )}
          </dl>
        </details>
      )}
    </div>
  );

  // The evidence column: the page itself.
  const evidence = b && b.worktree && b.status !== 'abandoned' && (
    <div className="canvas-col" data-col="evidence">
      <h2 className="col-head">Evidence</h2>
      <section className="kcard report-section" aria-labelledby={`preview-${buildId}`}>
        <h3 className="kcard-title" id={`preview-${buildId}`}>
          Preview
        </h3>
        <PreviewPane buildId={buildId} live={running} />
      </section>
      {onPages && !running && (
        <section className="kcard" aria-labelledby={`pages-${buildId}`}>
          <h3 className="kcard-title" id={`pages-${buildId}`}>
            Pages
          </h3>
          <p className="helper-summary">Every page at desktop and phone width, before and after this change.</p>
          <button type="button" className="btn btn-sm" onClick={() => onPages(buildId)}>
            See the pages
          </button>
        </section>
      )}
    </div>
  );

  // The result column: the answer first, then what changed and what is left.
  const result = b && (
    <div className="canvas-col" data-col="result">
      {report ? (
        <>
          <header className="report-head">
            <span className="chip chip-agent">
              <span className="chip-dot" aria-hidden="true" />
              Result
            </span>
            <h2 className="report-headline" data-tone={report.tone}>
              {report.headline}
            </h2>
            {report.summary && <p className="report-summary">{report.summary}</p>}
          </header>
          <dl className="stat-row" aria-label="At a glance">
            <div data-tone={report.checks.total === 0 ? 'neutral' : STAT_TONE[report.checks.passed === report.checks.total ? 'ok' : 'danger']}>
              <dt>Checks passed</dt>
              <dd>{report.checks.total > 0 ? `${report.checks.passed}/${report.checks.total}` : b.checks.length ? "Didn't run" : 'None set up'}</dd>
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
              <dd>{b.agent?.model === 'simulated' ? 'Free' : `$${report.costUsd.toFixed(2)}`}</dd>
            </div>
          </dl>
          <section className="kcard" aria-labelledby={`ships-${buildId}`}>
            <h3 className="kcard-title" id={`ships-${buildId}`}>
              Before it ships
            </h3>
            {todos && todos.length > 0 ? (
              <TodoItems todos={todos} label="Before it ships" onChanged={() => void load()} ask={b.status === 'review' ? ask : undefined} onOpenTask={onOpenTask} />
            ) : report.todos.length ? (
              <ul className="todo-list" aria-label="Before it ships">
                {report.todos.map((t, i) => (
                  <li key={i}>
                    <span className="todo-dot" aria-hidden="true" />
                    <span className="todo-text">{t}</span>
                    {b.status === 'review' && (
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
          <section className="kcard" aria-labelledby={`changes-${buildId}`}>
            <h3 className="kcard-title" id={`changes-${buildId}`}>
              What changed
            </h3>
            {diff ? <Changes diff={diff} /> : <p className="muted">{b.status === 'abandoned' ? 'This change was undone.' : 'There is no change to show.'}</p>}
          </section>
        </>
      ) : (
        <header className="report-head">
          <span className="chip chip-agent">
            <span className="chip-dot" aria-hidden="true" />
            So far
          </span>
          <h2 className="report-headline" data-tone="neutral">
            {running ? (paused ? 'Paused before the next step' : 'Claude is working') : b.status === 'draft' ? 'Not started yet' : 'Stopped'}
          </h2>
          {now && <p className="report-summary">{now.text}</p>}
        </header>
      )}
    </div>
  );

  const canvas = (
    <CanvasFrame live={running && !paused} evidence={!!evidence} toolbarStart={stages && <StageBar stages={stages} />}>
      {thread}
      {stepsCol}
      {evidence}
      {result}
    </CanvasFrame>
  );

  return (
    <article className="work-view" aria-label={b?.title ?? 'Task'}>
      <div className="work-head">
        <button type="button" className="btn btn-sm" onClick={onBack}>
          ← All work
        </button>
        <div className="work-head-text">
          <h1 className="page-title work-title">{b?.title ?? 'Loading…'}</h1>
          {now && (
            <p className="status-line" role="status" data-waiting={now.waiting}>
              <span className="status-line-dot" aria-hidden="true" />
              {now.text}
            </p>
          )}
        </div>
        <div className="work-head-actions">
          {status && <Badge tone={status.tone}>{status.label}</Badge>}
          {live.state && live.state.costUsd > 0 && <span className="pill">${live.state.costUsd.toFixed(2)}</span>}
          {running && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void act(paused ? 'resume' : 'pause', () => call(paused ? iap().resumeBuild(buildId) : iap().pauseBuild(buildId)).then(() => live.restart()))}
              disabled={busy !== null}
              title={paused ? undefined : 'Claude finishes what it is doing, then waits before its next step.'}
            >
              {paused ? 'Continue' : 'Pause'}
            </button>
          )}
          {running && (
            <button type="button" className="btn btn-sm" onClick={() => void act('stop', () => call(iap().stopBuild(buildId)))} disabled={busy !== null}>
              Stop
            </button>
          )}
        </div>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}


      {!report ? (
        canvas
      ) : (
        <section className="report" aria-label="Report">
          {canvas}
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
        </section>
      )}
    </article>
  );
}

/** The Build home: composer and the person's work across projects. */
export function BuildHome({
  projects,
  agent,
  onProjectsChanged,
  openBuild,
  onOpenBuild,
  onPages,
}: {
  projects: Project[] | null;
  agent: AgentStatus | null;
  onProjectsChanged: () => void;
  openBuild: string | null;
  onOpenBuild: (id: string | null) => void;
  onPages?: (id: string) => void;
}) {
  const [builds, setBuilds] = useState<RecentBuild[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraftState] = useState({ n: 0, text: '' });
  const setDraft = (text: string) => setDraftState((d) => ({ n: d.n + 1, text }));
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

  if (openBuild) return <WorkView buildId={openBuild} onBack={() => onOpenBuild(null)} onOpenTask={onOpenBuild} onPages={onPages} />;
  const empty = builds !== null && builds.length === 0;
  return (
    <div className="build-home">
      {empty ? (
        // Not a labelled region: the message bar's box already carries this name.
        <div className="build-hello">
          <h1 className="build-hello-title">What do you want to build?</h1>
          <p className="muted">Say it in one sentence. Claude works in a separate copy of your code, and you see every step.</p>
          <div className="chips" aria-label="Examples">
            {EXAMPLES.map((x) => (
              <button key={x} type="button" className="chip" onClick={() => setDraft(x)}>
                {x}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <section aria-labelledby="work-title">
          <h2 className="card-title" id="work-title">
            Your work
          </h2>
          {error && <Alert tone="danger">{error}</Alert>}
          {builds && <WorkList builds={builds} onOpen={onOpenBuild} />}
        </section>
      )}
      <div className="composer-dock">
        <Composer key={draft.n} initial={draft.text} projects={projects ?? []} agent={agent} onStarted={(b) => onOpenBuild(b.id)} onProjectCreated={onProjectsChanged} />
      </div>
    </div>
  );
}
