// The launcher (Ctrl K, M17 L, DEC-034). Finds destinations, projects, tasks,
// the files they changed, open to-dos and lessons, and runs a few safe
// actions: start a task from what was typed, open a task's preview, and stop
// the running task. Nothing here keeps, undoes or deletes work.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Project, RecentBuild, SearchHit } from '../shared/api.ts';
import { call, iap } from './api.ts';
import { SECTION_LABEL, type Section } from './App.tsx';
import { Icon } from './icons.tsx';

type Item = { id: string; label: string; hint: string; icon: Parameters<typeof Icon>[0]['name']; run: () => void | Promise<unknown> };

const DESTINATIONS: { id: Section; icon: Item['icon'] }[] = [
  { id: 'home', icon: 'home' },
  { id: 'projects', icon: 'projects' },
  { id: 'activity', icon: 'activity' },
  { id: 'studio', icon: 'studio' },
  { id: 'preferences', icon: 'bookmark' },
  { id: 'tools', icon: 'tools' },
  { id: 'updates', icon: 'radar' },
  { id: 'iterative', icon: 'iterate' },
  { id: 'platform', icon: 'shield' },
  { id: 'settings', icon: 'settings' },
];

const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function CommandPalette({
  open,
  projects,
  project,
  openBuild,
  onClose,
  onGo,
  onOpen,
  onCreate,
  onOpenBuild,
  onLessons,
}: {
  open: boolean;
  projects: Project[];
  /** The project on screen, where a typed task starts. */
  project: { id: string; name: string } | null;
  /** The task on screen, whose preview the launcher opens. */
  openBuild: string | null;
  onClose: () => void;
  onGo: (s: Section) => void;
  onOpen: (id: string, name: string) => void;
  onCreate: () => void;
  onOpenBuild: (id: string) => void;
  onLessons: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<RecentBuild[]>([]);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery('');
      setActive(0);
      setHits([]);
      setError(null);
      setBusy(false);
      call(iap().recentBuilds())
        .then(setRecent)
        .catch(() => setRecent([]));
      d.showModal(); // focus moves into the dialog and returns to the opener on close
    } else if (!open && d.open) d.close();
  }, [open]);

  // Running work changes while the launcher is open, so its list stays fresh.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => {
      call(iap().recentBuilds())
        .then(setRecent)
        .catch(() => undefined);
    }, 2_000);
    return () => clearInterval(t);
  }, [open]);

  const q = query.trim();
  useEffect(() => {
    if (!open || !q) {
      setHits([]);
      return;
    }
    let live = true;
    call(iap().searchWork(q))
      .then((h) => live && setHits(h))
      .catch(() => live && setHits([]));
    return () => {
      live = false;
    };
  }, [open, q]);

  const items = useMemo(() => {
    const lower = q.toLowerCase();
    const named = (label: string) => !lower || label.toLowerCase().includes(lower);
    const running = recent.filter((b) => b.running);
    // A typed task starts in the project on screen, or the one worked on last.
    const target = project ?? (recent[0] ? { id: recent[0].projectId, name: recent[0].projectName } : projects[0] ? { id: projects[0].id, name: projects[0].name } : null);
    const previewable = (openBuild ? recent.find((b) => b.id === openBuild) : undefined) ?? recent.find((b) => b.worktree && (b.status === 'review' || b.status === 'in_progress'));

    const actions: Item[] = [];
    // Last, so Enter on a typed name opens what it names instead of starting a task.
    const start: Item[] = [];
    if (q.length >= 3 && target)
      start.push({
        id: 'start',
        label: `Start a task: “${short(q)}”`,
        hint: `New task in ${target.name}`,
        icon: 'send',
        run: async () => onOpenBuild((await call(iap().quickBuild({ projectId: target.id, goal: q }))).id),
      });
    for (const b of running)
      if (named(`Stop ${b.title}`) || named('stop'))
        actions.push({
          id: `stop-${b.id}`,
          label: `Stop “${short(b.title, 48)}”`,
          hint: 'Stop the running task',
          icon: 'close',
          run: async () => {
            await call(iap().stopBuild(b.id));
            onOpenBuild(b.id);
          },
        });
    if (previewable?.worktree && previewable.status !== 'abandoned' && (named(`Preview ${previewable.title}`) || named('open preview')))
      actions.push({
        id: `preview-${previewable.id}`,
        label: `Open the preview of “${short(previewable.title, 40)}”`,
        hint: 'Preview',
        icon: 'play',
        run: async () => {
          const st = await call(iap().startPreview(previewable.id));
          if (st.status !== 'running') throw new Error(st.log.trim().split('\n').at(-1) || "The preview didn't start.");
          await call(iap().openPreview(previewable.id));
        },
      });
    if (named('New project')) actions.push({ id: 'new', label: 'New project', hint: 'Action', icon: 'plus', run: onCreate });

    const places: Item[] = [
      ...DESTINATIONS.filter((d) => named(SECTION_LABEL[d.id])).map((d) => ({ id: d.id, label: SECTION_LABEL[d.id], hint: 'Go to', icon: d.icon, run: () => onGo(d.id) })),
      ...projects.filter((p) => named(p.name)).map((p) => ({ id: p.id, label: p.name, hint: 'Project', icon: 'projects' as const, run: () => onOpen(p.id, p.name) })),
    ];

    const found: Item[] = q
      ? hits.map((h): Item => {
          switch (h.kind) {
            case 'task':
              return { id: `task-${h.buildId}`, label: h.title, hint: `Task · ${h.projectName}`, icon: 'board', run: () => onOpenBuild(h.buildId) };
            case 'file':
              return { id: `file-${h.buildId}-${h.path}`, label: h.path, hint: `File · ${short(h.taskTitle, 32)}`, icon: 'list', run: () => onOpenBuild(h.buildId) };
            case 'todo':
              return { id: `todo-${h.todoId}`, label: short(h.text, 80), hint: `To-do · ${short(h.taskTitle, 32)}`, icon: 'check', run: () => onOpenBuild(h.buildId) };
            case 'lesson':
              return { id: `lesson-${h.sourceId}-${h.text}`, label: short(h.text, 80), hint: `Lesson · SRC-${h.number}`, icon: 'sparkle', run: onLessons };
          }
        })
      : recent.slice(0, 5).map((b) => ({ id: `task-${b.id}`, label: b.title, hint: `Recent task · ${b.projectName}`, icon: 'board' as const, run: () => onOpenBuild(b.id) }));

    return [...actions, ...found, ...places, ...start];
  }, [q, hits, recent, project, openBuild, projects, onCreate, onGo, onOpen, onOpenBuild, onLessons]);

  const choose = async (item: Item | undefined) => {
    if (!item || busy) return;
    setError(null);
    setBusy(true);
    try {
      await item.run();
      onClose();
    } catch (e) {
      // Stay open so the person sees what went wrong.
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void choose(items[Math.min(active, items.length - 1)]);
    }
  };
  const current = items[Math.min(active, items.length - 1)];
  const domId = (item: Item) => `palette-${item.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;

  return (
    <dialog ref={dialog} className="palette" aria-label="Search and go" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <div className="palette-box">
        <label className="palette-search">
          <Icon name="search" size={18} />
          <input
            className="palette-input"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={current ? domId(current) : undefined}
            aria-label="Search tasks, files and to-dos, or type a task to start"
            placeholder="Search tasks, files, to-dos… or type a task to start"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            autoFocus
          />
          <kbd>Esc</kbd>
        </label>
        {error && (
          <p className="palette-error" role="alert">
            {error}
          </p>
        )}
        <ul className="palette-list" id="palette-list" role="listbox" aria-label="Results" aria-busy={busy}>
          {items.map((item) => (
            <li
              key={item.id}
              id={domId(item)}
              role="option"
              aria-selected={item === current}
              className="palette-item"
              onMouseMove={() => setActive(items.indexOf(item))}
              onClick={() => void choose(item)}
            >
              <Icon name={item.icon} size={18} />
              <span className="palette-label">{item.label}</span>
              <span className="palette-hint">{item.hint}</span>
            </li>
          ))}
          {items.length === 0 && <li className="palette-empty">Nothing matches “{q}”.</li>}
        </ul>
        <p className="palette-foot" aria-hidden="true">
          <kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>Enter</kbd> to run · <kbd>Esc</kbd> to close
        </p>
      </div>
    </dialog>
  );
}
