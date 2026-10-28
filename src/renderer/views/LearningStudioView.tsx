// Learning Studio (M9, FR-DESIGN-001): a library of design references. Files
// are chosen in a native dialog and copied into the app; previews come from the
// app's own copies through the iap-ref: scheme. A reference informs design work
// and never changes a project's specification.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { AgentStatus, DesignReference, ImportResult, Project, ReferenceCatalog } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Icon } from '../icons.tsx';
import { Alert, Badge, Empty, formatDate } from '../ui.tsx';

export type StudioFilter = 'all' | 'archived' | string;

type GroupBy = 'none' | 'project' | 'kind' | 'tag';

export const KIND_LABEL: Record<string, string> = {
  screenshot: 'Screenshot',
  ui_design: 'UI design',
  animation: 'Animation',
  video: 'Video',
  illustration: 'Illustration',
  photo: 'Photo',
  other: 'Other',
};

const src = (r: DesignReference) => `iap-ref://ref/${r.id}`;

const sizeLabel = (bytes: number) => (bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`);

function Preview({ reference, large = false }: { reference: DesignReference; large?: boolean }) {
  if (reference.mediaType.startsWith('video/')) {
    return large ? (
      <video className="ref-media" src={src(reference)} controls preload="metadata" aria-label={`Video: ${reference.title}`} />
    ) : (
      <span className="ref-video-thumb">
        <video className="ref-media" src={src(reference)} muted preload="metadata" aria-hidden="true" tabIndex={-1} />
        <span className="ref-play" aria-hidden="true">
          <Icon name="play" size={20} />
        </span>
      </span>
    );
  }
  return <img className="ref-media" src={src(reference)} alt={large ? reference.title : ''} loading="lazy" decoding="async" />;
}

function groupsOf(list: DesignReference[], by: GroupBy, projects: Project[]): { key: string; label: string; items: DesignReference[] }[] {
  if (by === 'none') return [{ key: 'all', label: '', items: list }];
  const map = new Map<string, DesignReference[]>();
  for (const r of list) {
    const keys = by === 'project' ? [r.projectId ?? ''] : by === 'kind' ? [r.kind] : r.tags.length ? r.tags : [''];
    for (const k of keys) map.set(k, [...(map.get(k) ?? []), r]);
  }
  const label = (k: string) =>
    by === 'project' ? (k ? projects.find((p) => p.id === k)?.name ?? 'Unknown project' : 'Not linked to a project') : by === 'kind' ? KIND_LABEL[k] ?? k : k ? `#${k}` : 'No tags';
  return [...map.entries()]
    .map(([key, items]) => ({ key, label: label(key), items }))
    .sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : a.label.localeCompare(b.label)));
}

function Inspector({
  reference,
  projects,
  catalog,
  agent,
  onChanged,
  onClose,
}: {
  reference: DesignReference;
  projects: Project[];
  catalog: ReferenceCatalog;
  agent: AgentStatus | null;
  onChanged: (r: DesignReference) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(reference.title);
  const [kind, setKind] = useState<string>(reference.kind);
  const [tags, setTags] = useState(reference.tags.join(', '));
  const [notes, setNotes] = useState(reference.notes ?? '');
  const [explanation, setExplanation] = useState(reference.explanation ?? '');
  const [projectId, setProjectId] = useState(reference.projectId ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const act = async (label: string, run: () => Promise<DesignReference>) => {
    setBusy(label);
    setError(null);
    setSaved(false);
    try {
      const next = await run();
      onChanged(next);
      return next;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const next = await act('save', () =>
      call(
        iap().updateReference({
          id: reference.id,
          title,
          kind,
          tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          notes: notes.trim() || null,
          explanation: explanation.trim() || null,
          projectId: projectId || null,
        }),
      ),
    );
    if (next) setSaved(true);
  };

  const s = reference.suggestion;
  const simulated = agent?.mode !== 'claude';
  const canSuggest = reference.status === 'active' && (simulated || (reference.mediaType.startsWith('image/') && reference.size <= 5_000_000));
  const archived = reference.status === 'archived';

  return (
    <section className="card ref-inspector" aria-labelledby="ref-inspector-title">
      <div className="card-head">
        <h2 className="card-title" id="ref-inspector-title">
          {reference.title}
        </h2>
        <button type="button" className="icon-btn" aria-label="Close the reference" title="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="ref-stage">
        <Preview reference={reference} large />
      </div>
      <p className="subtle">
        {reference.fileName} · {sizeLabel(reference.size)}
        {reference.width ? ` · ${reference.width}×${reference.height}` : ''} · added {formatDate(reference.createdAt)}
      </p>
      {archived && <Alert tone="warn">Archived. It is hidden from the library and cannot be suggested on until it is restored.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="ref-suggestion" aria-labelledby="ref-suggestion-title">
        <h3 className="ref-subhead" id="ref-suggestion-title">
          <Icon name="sparkle" size={16} /> Suggestion
          {s && <Badge tone={s.status === 'proposed' ? 'info' : s.status === 'accepted' ? 'ok' : 'neutral'}>{s.status === 'proposed' ? 'Waiting for you' : s.status === 'accepted' ? 'Accepted' : 'You corrected it'}</Badge>}
        </h3>
        {s ? (
          <>
            <p>
              <strong>{KIND_LABEL[s.kind] ?? s.kind}</strong>
              {s.tags.length > 0 && (
                <span className="run-tile-tags ref-tags">
                  {s.tags.map((t) => (
                    <span key={t} className="tag">
                      #{t}
                    </span>
                  ))}
                </span>
              )}
            </p>
            <p className="muted">{s.explanation}</p>
            <p className="subtle">{s.model === 'simulated' ? 'Simulated: no AI looked at this file.' : `From ${s.model}.`}</p>
          </>
        ) : (
          <p className="muted">
            {simulated
              ? 'Ask for a kind, tags and an explanation. The model is simulated, so the guess comes from the file name only.'
              : 'Claude looks at the image and suggests a kind, tags and an explanation. About 1 to 3 cents, within your monthly budget.'}
          </p>
        )}
        <div className="btn-row">
          <button type="button" className="btn" disabled={!canSuggest || !!busy} onClick={() => void act('suggest', () => call(iap().suggestReference(reference.id)))}>
            {busy === 'suggest' ? 'Asking…' : s ? 'Suggest again' : simulated ? 'Suggest (simulated)' : 'Suggest with Claude'}
          </button>
          {s?.status === 'proposed' && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!!busy}
              onClick={async () => {
                const next = await act('accept', () => call(iap().acceptReferenceSuggestion(reference.id)));
                if (next) {
                  setKind(next.kind);
                  setTags(next.tags.join(', '));
                  setExplanation(next.explanation ?? '');
                }
              }}
            >
              Accept suggestion
            </button>
          )}
        </div>
        {!canSuggest && !archived && !simulated && <p className="subtle">Claude can describe images up to 5 MB. For videos, write what matters in the notes.</p>}
        {s?.status === 'proposed' && <p className="subtle">Nothing is applied until you accept it. To correct it, change the fields below and save.</p>}
      </div>

      <form onSubmit={save} noValidate>
        <div className="field">
          <label htmlFor="ref-title">Title</label>
          <input id="ref-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} disabled={archived} />
        </div>
        <div className="field">
          <label htmlFor="ref-kind">Kind</label>
          <select id="ref-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value)} disabled={archived}>
            {catalog.kinds.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k] ?? k}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ref-tags">Tags</label>
          <input id="ref-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} aria-describedby="ref-tags-hint" disabled={archived} />
          <span className="hint" id="ref-tags-hint">
            Separate with commas, for example: onboarding, dark-mode, empty-state.
          </span>
        </div>
        <div className="field">
          <label htmlFor="ref-project">Project</label>
          <select id="ref-project" className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={archived}>
            <option value="">Not linked</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ref-explanation">What it shows</label>
          <textarea id="ref-explanation" className="textarea" value={explanation} onChange={(e) => setExplanation(e.target.value)} disabled={archived} />
        </div>
        <div className="field">
          <label htmlFor="ref-notes">Your notes</label>
          <textarea id="ref-notes" className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} aria-describedby="ref-notes-hint" disabled={archived} />
          <span className="hint" id="ref-notes-hint">
            What to borrow from it, and what not to.
          </span>
        </div>
        <div className="btn-row">
          {!archived && (
            <button type="submit" className="btn btn-primary" disabled={!!busy}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
          )}
          <button type="button" className="btn" disabled={!!busy} onClick={() => void act('archive', () => call(iap().archiveReference({ id: reference.id, archived: !archived })))}>
            {archived ? 'Restore' : 'Archive'}
          </button>
          {saved && (
            <span className="subtle" role="status">
              Saved.
            </span>
          )}
        </div>
      </form>
      <p className="side-note">References are never deleted. Archiving hides one; the file stays in the app's data folder.</p>
    </section>
  );
}

export function LearningStudioView({ projects, filter, onFilter }: { projects: Project[]; filter: StudioFilter; onFilter: (f: StudioFilter) => void }) {
  const [list, setList] = useState<DesignReference[] | null>(null);
  const [catalog, setCatalog] = useState<ReferenceCatalog | null>(null);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [selected, setSelected] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const archived = filter === 'archived';
  const kind = filter !== 'all' && filter !== 'archived' ? filter : undefined;

  const load = useCallback(async () => {
    try {
      const [refs, cat] = await Promise.all([
        call(iap().listReferences({ query: query.trim() || undefined, tag: tag || undefined, kind, archived, projectId: projectFilter === '' ? undefined : projectFilter === 'none' ? null : projectFilter })),
        call(iap().referenceCatalog()),
      ]);
      setList(refs);
      setCatalog(cat);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [query, tag, kind, archived, projectFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    call(iap().agentStatus())
      .then(setAgent)
      .catch(() => setAgent(null));
  }, []);

  const importFiles = async () => {
    setImporting(true);
    setResult(null);
    setError(null);
    try {
      const r = await call(iap().importReferences(projectFilter && projectFilter !== 'none' ? { projectId: projectFilter } : {}));
      setResult(r);
      if (r.imported.length === 1) setSelected(r.imported[0]!.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const current = list?.find((r) => r.id === selected) ?? null;
  const groups = useMemo(() => (list ? groupsOf(list, groupBy, projects) : []), [list, groupBy, projects]);
  const filtered = !!(query.trim() || tag || projectFilter || kind);

  return (
    <>
      <p className="eyebrow">Learning Studio</p>
      <h1 className="page-title">
        Collect what <span className="accent">good</span> looks like
      </h1>
      <p className="page-lede">
        Keep screenshots, designs and short videos you want to learn from. Tag them, link them to a project and note what to borrow. A reference informs design work; it never changes a
        project's specification.
      </p>
      <div className="content-grid">
        <div>
          <div className="ref-toolbar glass">
            <label className="side-search ref-search">
              <Icon name="search" size={16} />
              <input className="side-search-input" type="search" placeholder="Search titles, tags and notes" aria-label="Search references" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            {/* Same choices as the side panel, which is hidden on narrow windows. */}
            <select className="select" aria-label="Kind" value={filter} onChange={(e) => onFilter(e.target.value)}>
              <option value="all">All kinds</option>
              {Object.entries(KIND_LABEL).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
              <option value="archived">Archived</option>
            </select>
            <select className="select" aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">All tags</option>
              {catalog?.tags.map((t) => (
                <option key={t.tag} value={t.tag}>
                  #{t.tag} ({t.count})
                </option>
              ))}
            </select>
            <select className="select" aria-label="Project" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
              <option value="">All projects</option>
              <option value="none">Not linked</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <div className="segmented" role="group" aria-label="Group by">
              {(['none', 'project', 'kind', 'tag'] as const).map((g) => (
                <button key={g} type="button" aria-pressed={groupBy === g} onClick={() => setGroupBy(g)}>
                  {g === 'none' ? 'No groups' : g === 'project' ? 'Project' : g === 'kind' ? 'Kind' : 'Tag'}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn-primary" onClick={() => void importFiles()} disabled={importing}>
              <Icon name="plus" size={16} /> {importing ? 'Adding…' : 'Add files'}
            </button>
          </div>

          {error && <Alert tone="danger">{error}</Alert>}
          {result && (result.imported.length > 0 || result.skipped.length > 0) && (
            <Alert tone={result.skipped.length ? 'warn' : 'info'} title={`Added ${result.imported.length} ${result.imported.length === 1 ? 'file' : 'files'}${result.skipped.length ? `, skipped ${result.skipped.length}` : ''}`}>
              {result.skipped.length > 0 && (
                <ul className="ref-skipped">
                  {result.skipped.map((s, i) => (
                    <li key={i}>
                      <strong>{s.file}</strong>: {s.reason}
                    </li>
                  ))}
                </ul>
              )}
              {result.imported.length > 0 && <span>The originals were copied, not moved. They are left where they were.</span>}
            </Alert>
          )}

          {!list && !error && <p className="loading">Loading references…</p>}
          {list && list.length === 0 && (
            <div className="card">
              <Empty
                title={filtered ? 'Nothing matches' : archived ? 'No archived references' : 'No references yet'}
                action={!filtered && !archived && (
                  <button type="button" className="btn btn-primary" onClick={() => void importFiles()} disabled={importing}>
                    <Icon name="plus" size={16} /> Add files
                  </button>
                )}
              >
                {filtered
                  ? 'Try another search, tag or project.'
                  : archived
                    ? 'References you archive appear here, so you can restore them.'
                    : 'Add PNG, JPEG, GIF or WebP images, or MP4, MOV or WebM videos. The app keeps its own copy; your files are not moved or changed.'}
              </Empty>
            </div>
          )}
          {groups.map(
            (g) =>
              g.items.length > 0 && (
                <section key={g.key} className="section" aria-label={g.label || 'References'}>
                  {g.label && (
                    <h2 className="section-title">
                      {g.label} <span className="count-pill">{g.items.length}</span>
                    </h2>
                  )}
                  <ul className="ref-grid" aria-label={g.label ? `References: ${g.label}` : 'References'}>
                    {g.items.map((r) => (
                      <li key={r.id}>
                        <button type="button" className="ref-card" aria-current={selected === r.id ? 'true' : undefined} onClick={() => setSelected(r.id)}>
                          <span className="ref-thumb">
                            <Preview reference={r} />
                          </span>
                          <span className="ref-card-body">
                            <span className="ref-card-title">{r.title}</span>
                            <span className="ref-card-meta">
                              <Badge tone="neutral">{KIND_LABEL[r.kind] ?? r.kind}</Badge>
                              {r.suggestion?.status === 'proposed' && <Badge tone="info">Suggestion</Badge>}
                            </span>
                            {r.tags.length > 0 && (
                              <span className="run-tile-tags">
                                {r.tags.slice(0, 4).map((t) => (
                                  <span key={t} className="tag">
                                    #{t}
                                  </span>
                                ))}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ),
          )}
        </div>
        <aside aria-label="Reference details panel">
          {current && catalog ? (
            <Inspector
              key={current.id}
              reference={current}
              projects={projects}
              catalog={catalog}
              agent={agent}
              onChanged={() => void load()}
              onClose={() => setSelected(null)}
            />
          ) : (
            <section className="card">
              <h2 className="card-title">How references work</h2>
              <ol className="stages">
                {['Add files', 'Ask for a suggestion', 'Accept or correct it', 'Link to a project'].map((s, i) => (
                  <li key={s}>
                    <span className="stage-num">{i + 1}</span>
                    {s}
                  </li>
                ))}
              </ol>
              <p className="muted">
                Files are checked by their content, not their name. SVG is not accepted because it can contain scripts. Images up to 25 MB and videos up to 150 MB.
              </p>
              <p className="muted">{agent?.mode === 'claude' ? 'Suggestions use Claude and count toward your monthly budget.' : 'Suggestions are simulated until real AI calls are on in Settings.'}</p>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
