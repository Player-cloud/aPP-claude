// The outcomes board (M17 K, DEC-034): every task of a project as a card with
// its result, so finished work stays in view instead of in a list of names.
// Selecting a card shows the actions for that task only; the rest of the board
// stays quiet. Cards are grouped by what they need, with the work waiting for
// the person first.
import { useEffect, useState, type KeyboardEvent } from 'react';
import type { Build, Todo } from '../../shared/api.ts';
import { keepNote } from '../../shared/report.ts';
import { call, iap } from '../api.ts';
import { Alert, Badge, relativeTime } from '../ui.tsx';
import { workStatus } from './BuildView.tsx';

const GROUPS: { id: string; label: string; has: (b: Build) => boolean; folded?: boolean }[] = [
  { id: 'waiting', label: 'Waiting for you', has: (b) => b.status === 'review' },
  { id: 'working', label: 'In progress', has: (b) => b.status === 'in_progress' || b.status === 'draft' },
  { id: 'kept', label: 'Kept', has: (b) => b.status === 'completed' },
  { id: 'undone', label: 'Undone', has: (b) => b.status === 'abandoned', folded: true },
];

function Picture({ build }: { build: Build }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    call(iap().buildPicture(build.id))
      .then((s) => live && setSrc(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [build.id, build.updatedAt]);
  return src ? (
    <img className="outcome-picture" src={src} alt={`The page from “${build.title}”`} />
  ) : (
    <div className="outcome-picture outcome-nopicture" aria-hidden="true">
      {build.changedFiles?.length ? `${build.changedFiles.length} ${build.changedFiles.length === 1 ? 'file' : 'files'}` : 'No preview'}
    </div>
  );
}

function Card({
  build,
  open,
  selected,
  onSelect,
  onOpen,
  onChanged,
}: {
  build: Build;
  open: number;
  selected: boolean;
  onSelect: (id: string | null) => void;
  onOpen: (id: string, ask?: boolean) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s = workStatus(build, false);
  const files = build.changedFiles ?? [];
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
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
  const preview = async () => {
    const st = await call(iap().startPreview(build.id));
    if (st.status !== 'running') throw new Error(st.log.trim().split('\n').at(-1) || "The preview didn't start.");
    await call(iap().openPreview(build.id));
  };
  const review = build.status === 'review';
  return (
    <li className="outcome" data-selected={selected}>
      <button type="button" className="outcome-main" aria-pressed={selected} onClick={() => onSelect(selected ? null : build.id)} onDoubleClick={() => onOpen(build.id)}>
        <Picture build={build} />
        <span className="outcome-title">{build.title}</span>
        <span className="outcome-meta">
          {files.length} {files.length === 1 ? 'file' : 'files'} · <span className="diff-add">+{added}</span> <span className={removed ? 'diff-del' : ''}>−{removed}</span>
          {build.agent && build.agent.costUsd > 0 ? ` · $${build.agent.costUsd.toFixed(2)}` : ''} · {relativeTime(build.updatedAt)}
        </span>
        <span className="outcome-foot">
          <Badge tone={s.tone}>{s.label}</Badge>
          {open > 0 && (
            <span className="outcome-todos">
              {open} left to do
            </span>
          )}
        </span>
      </button>
      {selected && (
        <div className="outcome-actions" role="toolbar" aria-label={`Actions for ${build.title}`}>
          <button type="button" className="btn btn-sm" onClick={() => onOpen(build.id)}>
            Open report
          </button>
          {review && (
            <button type="button" className="btn btn-sm" onClick={() => onOpen(build.id, true)}>
              Ask Claude
            </button>
          )}
          {build.worktree && build.status !== 'abandoned' && (
            <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void act('preview', preview)}>
              {busy === 'preview' ? 'Starting…' : 'Preview'}
            </button>
          )}
          {review && (
            <>
              <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void act('undo', () => call(iap().abandonBuild({ buildId: build.id, reason: 'Undone from the board.' })))}>
                Undo
              </button>
              <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => void act('keep', () => call(iap().completeBuild({ buildId: build.id, note: keepNote(build, '') })))}>
                Keep
              </button>
            </>
          )}
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </li>
  );
}

export function OutcomeBoard({ builds, todos, onOpen, onChanged }: { builds: Build[]; todos: Todo[]; onOpen: (id: string, ask?: boolean) => void; onChanged: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && selected) {
      e.stopPropagation();
      setSelected(null);
    }
  };
  if (builds.length === 0) return null;
  const openCount = (id: string) => todos.filter((t) => t.buildId === id && t.status === 'open').length;
  return (
    <div className="outcome-board" onKeyDown={onKeyDown}>
      {GROUPS.map((g) => {
        const items = builds.filter(g.has);
        if (!items.length) return null;
        const list = (
          <ul className="outcome-grid" aria-label={g.label}>
            {items.map((b) => (
              <Card key={b.id} build={b} open={openCount(b.id)} selected={selected === b.id} onSelect={setSelected} onOpen={onOpen} onChanged={onChanged} />
            ))}
          </ul>
        );
        return g.folded ? (
          <details key={g.id} className="outcome-group">
            <summary className="outcome-group-title">
              {g.label} <span className="count-pill">{items.length}</span>
            </summary>
            {list}
          </details>
        ) : (
          <section key={g.id} className="outcome-group" aria-labelledby={`outcomes-${g.id}`}>
            <h2 className="outcome-group-title" id={`outcomes-${g.id}`}>
              {g.label} <span className="count-pill">{items.length}</span>
            </h2>
            {list}
          </section>
        );
      })}
    </div>
  );
}
