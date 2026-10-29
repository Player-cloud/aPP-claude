// Pages (M18 parts 6–7, DEC-036): every page of a task at desktop and phone
// width, before and after its change, with a slider that wipes from one to
// the other. Pictures are real captures of the task's preview and of a copy
// of the code before the change; nothing is drawn as an example.
import { useEffect, useMemo, useState } from 'react';
import type { PageSet, RecentBuild, Viewport } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Alert, relativeTime } from '../ui.tsx';

const VIEWPORT_LABEL: Record<Viewport, string> = { desktop: 'Desktop', phone: 'Phone' };

function useShot(buildId: string | null, name: string | null, stamp: string | undefined): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!buildId || !name) return;
    let live = true;
    call(iap().pageShot({ buildId, name }))
      .then((s) => live && setSrc(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [buildId, name, stamp]);
  return src;
}

function Compare({ buildId, before, after, stamp, route, viewport }: { buildId: string; before: string | null; after: string | null; stamp: string; route: string; viewport: Viewport }) {
  const beforeSrc = useShot(buildId, before, stamp);
  const afterSrc = useShot(buildId, after, stamp);
  const [split, setSplit] = useState(50);
  useEffect(() => setSplit(50), [route, viewport]);
  if (!after) return null;
  return (
    <div className="compare" data-viewport={viewport}>
      <div className="compare-frame" style={{ ['--split' as string]: `${before ? split : 100}%` }}>
        {afterSrc && <img className="compare-after" src={afterSrc} alt={`${route} after the change, ${VIEWPORT_LABEL[viewport].toLowerCase()} width`} />}
        {before && beforeSrc && (
          <>
            <img className="compare-before" src={beforeSrc} alt={`${route} before the change, ${VIEWPORT_LABEL[viewport].toLowerCase()} width`} />
            <span className="compare-line" aria-hidden="true" />
            <span className="compare-tag compare-tag-before" aria-hidden="true">
              Before
            </span>
            <span className="compare-tag compare-tag-after" aria-hidden="true">
              After
            </span>
          </>
        )}
      </div>
      {before && (
        <label className="compare-range">
          <span className="visually-hidden">Before and after</span>
          <input type="range" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} aria-valuetext={`${split}% before`} />
        </label>
      )}
    </div>
  );
}

function Film({ buildId, name, stamp, label, current, onClick }: { buildId: string; name: string | null; stamp: string; label: string; current: boolean; onClick: () => void }) {
  const src = useShot(buildId, name, stamp);
  return (
    <li>
      <button type="button" className="film" aria-current={current ? 'true' : undefined} onClick={onClick}>
        {src ? <img src={src} alt="" /> : <span className="film-empty" aria-hidden="true" />}
        <span className="film-label">{label}</span>
      </button>
    </li>
  );
}

export function PagesView({ buildId, onBuild, onOpenTask }: { buildId: string | null; onBuild: (id: string) => void; onOpenTask: (id: string) => void }) {
  const [builds, setBuilds] = useState<RecentBuild[] | null>(null);
  const [set, setSet] = useState<PageSet | null>(null);
  const [route, setRoute] = useState('/');
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call(iap().recentBuilds())
      .then((all) => setBuilds(all.filter((b) => b.worktree && b.status !== 'abandoned')))
      .catch((e: Error) => setError(e.message));
  }, []);
  const current = buildId ?? builds?.[0]?.id ?? null;
  const build = builds?.find((b) => b.id === current) ?? null;

  useEffect(() => {
    setSet(null);
    setError(null);
    if (!current) return;
    let live = true;
    call(iap().pageSet(current))
      .then((s) => {
        if (!live) return;
        setSet(s);
        setRoute(s?.routes[0]?.route ?? '/');
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [current]);

  const take = async () => {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const s = await call(iap().capturePages(current));
      setSet(s);
      setRoute(s.routes[0]?.route ?? '/');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const page = set?.routes.find((r) => r.route === route) ?? set?.routes[0] ?? null;
  const shot = page?.shots[viewport];
  const changed = useMemo(() => set?.routes.filter((r) => r.shots.desktop.changed || r.shots.phone.changed).length ?? 0, [set]);

  return (
    <div className="pages-view">
      <header className="pages-head">
        <div>
          <h1 className="page-title">Pages</h1>
          <p className="page-sub">Each page of a task at desktop and phone width, before and after the change.</p>
        </div>
        <div className="pages-actions">
          {builds && builds.length > 0 && (
            <label className="pages-task">
              <span>Task</span>
              <select value={current ?? ''} onChange={(e) => onBuild(e.target.value)}>
                {builds.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title} · {b.projectName}
                  </option>
                ))}
              </select>
            </label>
          )}
          {build && (
            <button type="button" className="btn btn-sm" onClick={() => onOpenTask(build.id)}>
              Open task
            </button>
          )}
          {current && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void take()} disabled={busy}>
              {busy ? 'Taking pictures…' : set ? 'Take them again' : 'Take pictures'}
            </button>
          )}
        </div>
      </header>
      {error && <Alert tone="danger">{error}</Alert>}
      {busy && (
        <p className="pages-busy" role="status">
          Starting the preview and a copy of the code before the change, then taking a picture of each page at both widths…
        </p>
      )}
      {builds && builds.length === 0 && <p className="empty">No task has a work folder yet. Start a task on Build, then come back to see its pages.</p>}
      {current && !set && !busy && !error && builds && <p className="empty">No pictures yet. Take pictures to see each page of this task before and after its change.</p>}

      {set && page && (
        <div className="pages-body">
          <nav className="pages-routes" aria-label="Pages">
            <p className="pages-count">
              {set.routes.length} {set.routes.length === 1 ? 'page' : 'pages'} · {changed} changed · {relativeTime(set.capturedAt)}
            </p>
            <ul>
              {set.routes.map((r) => {
                const s = r.shots[viewport];
                const tag = s.changed === true ? 'Changed' : s.changed === false ? 'Same' : !s.before && s.after ? 'New' : '—';
                return (
                  <li key={r.route}>
                    <button type="button" className="pages-route" aria-current={r.route === page.route ? 'page' : undefined} onClick={() => setRoute(r.route)}>
                      <span className="mono">{r.route}</span>
                      <span className="pages-tag" data-tag={tag}>
                        {tag}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          <section className="pages-stage" aria-label={`${page.route} at ${VIEWPORT_LABEL[viewport].toLowerCase()} width`}>
            <div className="pages-stage-bar">
              <div className="segmented" role="group" aria-label="Width">
                {(['desktop', 'phone'] as const).map((v) => (
                  <button key={v} type="button" aria-pressed={viewport === v} onClick={() => setViewport(v)}>
                    {VIEWPORT_LABEL[v]}
                  </button>
                ))}
              </div>
              <span className="pages-state">
                {shot?.changed === true ? 'Changed by this task' : shot?.changed === false ? 'Looks the same as before' : (shot?.note ?? set.beforeNote ?? '')}
              </span>
            </div>
            {shot?.after ? (
              <Compare buildId={set.buildId} before={shot.before} after={shot.after} stamp={set.capturedAt} route={page.route} viewport={viewport} />
            ) : (
              <p className="empty">{shot?.note ?? 'No picture of this page.'}</p>
            )}
            {!shot?.before && shot?.after && <p className="pages-note">{shot.note ?? set.beforeNote}</p>}
          </section>
          <ol className="filmstrip" aria-label="All pages">
            {set.routes.map((r) => (
              <Film key={r.route} buildId={set.buildId} name={r.shots[viewport].after} stamp={set.capturedAt} label={r.route} current={r.route === page.route} onClick={() => setRoute(r.route)} />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
