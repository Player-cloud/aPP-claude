// Lessons, skill proposals and add-on reviews (M14: FR-LEARN-002/003, Phase 12,
// DEC-031). Reading a source only stores what it says, with citations, and the
// model's suggestions apart; a suggestion is used only when the person turns it
// into a proposed preference or an idea. A skill is exported as a file, never
// installed, and an add-on decision changes nothing in Claude Code.
import { useCallback, useEffect, useState } from 'react';
import type { AddonDecision, AddonsOverview, AddonStatus, Criterion, CriterionReview, LearningSource, Lesson, LessonCitation, Project, SkillDetail, SkillProposal } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Icon } from '../icons.tsx';
import { Alert, Badge, Empty, formatTime, relativeTime, type Tone } from '../ui.tsx';

const time = (s: number) => {
  const t = Math.floor(s);
  const pad = (n: number) => String(n).padStart(2, '0');
  return t >= 3600 ? `${Math.floor(t / 3600)}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}` : `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
};

function where(c: LessonCitation): string {
  if (c.kind === 'page') return c.end - c.start > 1 ? `pp. ${c.start}–${c.end - 1}` : `p. ${c.start}`;
  if (c.from !== null) return c.to !== null && Math.floor(c.to) > Math.floor(c.from) ? `${time(c.from)}–${time(c.to)}` : time(c.from);
  return c.end - c.start > 1 ? `passages ${c.start + 1}–${c.end}` : `passage ${c.start + 1}`;
}

const KIND_LABEL: Record<LearningSource['kind'], string> = { transcript: 'Transcript', text: 'Notes', pdf: 'PDF' };

function LessonItem({ lesson }: { lesson: Lesson }) {
  return (
    <li className="lesson">
      <p className="lesson-text">
        <span className="imp-num">{lesson.n}</span> {lesson.text}
      </p>
      {lesson.citations.length ? (
        lesson.citations.map((c, i) => (
          <blockquote key={i} className="lesson-cite">
            <Badge tone="neutral">{where(c)}</Badge> {c.quote.length > 280 ? `${c.quote.slice(0, 279)}…` : c.quote}
          </blockquote>
        ))
      ) : (
        <p className="hint">
          <Badge tone="warn">No passage cited</Badge> This is the model&rsquo;s reading; check it against the source.
        </p>
      )}
    </li>
  );
}

function SourceDetail({ source, onChanged, onClose }: { source: LearningSource; onChanged: (s: LearningSource) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const reading = source.extractions[source.extractions.length - 1];
  const act = async (fn: () => Promise<LearningSource>, done?: (s: LearningSource) => string) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const s = await fn();
      onChanged(s);
      if (done) setInfo(done(s));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const decide = (n: number, action: 'preference' | 'improvement' | 'dismiss') =>
    void act(
      () => call(iap().decideSuggestion({ sourceId: source.id, suggestion: n, action })),
      (s) => {
        const o = s.extractions[s.extractions.length - 1]!.suggestions.find((x) => x.n === n)!.outcome!;
        return o.action === 'preference' ? `Proposed as ${o.label}. Approve it in the Preferences tab if you want it used.` : o.action === 'improvement' ? `Added ${o.label} to Improvements as an idea.` : `Suggestion ${n} set aside.`;
      },
    );
  return (
    <section className="card ref-inspector" aria-labelledby="source-title">
      <div className="card-head">
        <h2 className="card-title" id="source-title">
          SRC-{source.number} {source.title}
        </h2>
        <button type="button" className="icon-btn" aria-label="Close the source" title="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <p className="subtle">
        {KIND_LABEL[source.kind]} · {source.fileName} · {source.kind === 'pdf' ? `${source.pages ?? 'unknown number of'} pages` : `${source.segments.length} passage${source.segments.length === 1 ? '' : 's'}`}
      </p>
      <div className="btn-row">
        <button type="button" className="btn btn-primary" disabled={busy || source.status === 'archived'} onClick={() => void act(() => call(iap().readLessons(source.id)))}>
          <Icon name="sparkle" size={16} /> {busy ? 'Reading…' : reading ? 'Read again' : 'Read for lessons'}
        </button>
        {reading && (
          <button
            type="button"
            className="btn"
            disabled={busy || reading.vaultNoteId !== null}
            onClick={() =>
              void act(
                async () => (await call(iap().saveLessonsToVault(source.id))).source,
                () => 'Saved to the Vault inbox. It is a note, not a rule.',
              )
            }
          >
            <Icon name="archive" size={16} /> {reading.vaultNoteId ? 'In the Vault' : 'Save to the Vault inbox'}
          </button>
        )}
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void act(() => call(iap().archiveSource({ id: source.id, archived: source.status !== 'archived' })))}>
          {source.status === 'archived' ? 'Restore' : 'Archive'}
        </button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {info && <Alert>{info}</Alert>}
      {!reading && <p className="muted">Not read yet. Reading sends the source to the model once and stores what it says; nothing else changes.</p>}
      {reading && (
        <>
          <p className="subtle">
            Reading {reading.number}, {formatTime(reading.at)} · {reading.model === 'simulated' ? 'simulated, no AI read it' : `${reading.model}, $${reading.costUsd.toFixed(2)}`}
            {reading.droppedCitations > 0 && ` · ${reading.droppedCitations} citation${reading.droppedCitations === 1 ? '' : 's'} outside the source dropped`}
          </p>
          <h3 className="ref-subhead">What the source says</h3>
          {reading.lessons.length ? (
            <ol className="lesson-list" aria-label="Lessons">
              {reading.lessons.map((l) => (
                <LessonItem key={l.n} lesson={l} />
              ))}
            </ol>
          ) : (
            <p className="muted">No lessons were found.</p>
          )}
          {reading.note && <p className="hint">{reading.note}</p>}
          <h3 className="ref-subhead">Suggestions</h3>
          <p className="hint">The model&rsquo;s recommendations, not claims from the source. Nothing is used unless you choose to.</p>
          {reading.suggestions.length ? (
            <ul className="plat-list" aria-label="Suggestions">
              {reading.suggestions.map((x) => (
                <li key={x.n}>
                  <span>
                    <Badge tone="info">{x.kind}</Badge> {x.text}
                    {x.buildsOn.length > 0 && <span className="subtle"> (lessons {x.buildsOn.join(', ')})</span>}
                  </span>
                  {x.outcome ? (
                    <Badge tone="neutral">{x.outcome.action === 'dismissed' ? 'Set aside' : x.outcome.label}</Badge>
                  ) : (
                    <span className="btn-row">
                      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => decide(x.n, 'preference')}>
                        Propose as preference
                      </button>
                      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => decide(x.n, 'improvement')}>
                        Add as idea
                      </button>
                      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => decide(x.n, 'dismiss')}>
                        Set aside
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No suggestions.</p>
          )}
        </>
      )}
    </section>
  );
}

export function LessonsTab({ projects }: { projects: Project[] }) {
  const [archived, setArchived] = useState(false);
  const [sources, setSources] = useState<LearningSource[] | null>(null);
  const [selected, setSelected] = useState<LearningSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<{ file: string; reason: string }[]>([]);
  const [projectId, setProjectId] = useState('');
  const load = useCallback(async () => {
    try {
      setSources(await call(iap().listSources({ archived })));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [archived]);
  useEffect(() => {
    void load();
  }, [load]);
  const importFiles = async () => {
    setError(null);
    try {
      const r = await call(iap().importSources(projectId ? { projectId } : {}));
      setSkipped(r.skipped);
      if (r.imported[0]) setSelected(r.imported[0]);
      setArchived(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="content-grid">
      <div>
        <div className="ref-toolbar glass">
          <div className="segmented" role="group" aria-label="Show sources">
            <button type="button" aria-pressed={!archived} onClick={() => setArchived(false)}>
              Sources
            </button>
            <button type="button" aria-pressed={archived} onClick={() => setArchived(true)}>
              Archived
            </button>
          </div>
          {projects.length > 0 && (
            <select className="select" aria-label="Link new sources to" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="btn btn-primary" onClick={() => void importFiles()}>
            <Icon name="plus" size={16} /> Add sources
          </button>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        {skipped.length > 0 && (
          <Alert tone="warn" title="Not added">
            {skipped.map((s) => `${s.file}: ${s.reason}`).join(' ')}
          </Alert>
        )}
        {sources && sources.length === 0 && (
          <div className="card">
            <Empty title={archived ? 'Nothing archived' : 'No sources yet'}>{archived ? 'Archived sources appear here.' : 'Add a transcript (.vtt, .srt or .txt), notes (.md) or a PDF. For a video, add its transcript.'}</Empty>
          </div>
        )}
        {sources && sources.length > 0 && (
          <ul className="imp-list" aria-label="Sources">
            {sources.map((s) => {
              const r = s.extractions[s.extractions.length - 1];
              return (
                <li key={s.id}>
                  <button type="button" className="run-tile imp-row" aria-current={selected?.id === s.id ? 'true' : undefined} onClick={() => setSelected(s)}>
                    <span className="imp-num">SRC-{s.number}</span>
                    <span className="run-tile-title">{s.title}</span>
                    <span className="imp-badges">
                      <Badge tone="neutral">{KIND_LABEL[s.kind]}</Badge>
                      <Badge tone={r ? 'ok' : 'warn'}>{r ? `${r.lessons.length} lesson${r.lessons.length === 1 ? '' : 's'}` : 'Not read'}</Badge>
                      <span className="subtle">{relativeTime(s.createdAt)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <aside aria-label="Source details panel">
        {selected ? (
          <SourceDetail
            key={selected.id}
            source={selected}
            onClose={() => setSelected(null)}
            onChanged={(s) => {
              setSelected(s);
              void load();
            }}
          />
        ) : (
          <section className="card" aria-labelledby="lessons-rules-title">
            <h2 className="card-title" id="lessons-rules-title">
              Lessons
            </h2>
            <p className="muted">
              Each lesson is linked to the passage, time or page it comes from. Suggestions are kept apart as the model&rsquo;s own recommendations, and reading a source changes nothing else: you decide what becomes a preference or an idea.
            </p>
          </section>
        )}
      </aside>
    </div>
  );
}

const SKILL_TONE: Record<SkillProposal['status'], Tone> = { proposed: 'warn', approved: 'ok', rejected: 'neutral' };

function SkillInspector({ id, onChanged, onClose }: { id: string; onChanged: () => Promise<void>; onClose: () => void }) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const show = (d: SkillDetail) => {
    setDetail(d);
    setName(d.proposal.draft.name);
    setDescription(d.proposal.draft.description);
    setSteps(d.proposal.draft.workflow.join('\n'));
  };
  useEffect(() => {
    call(iap().getSkill(id))
      .then(show)
      .catch((e: Error) => setError(e.message));
  }, [id]);
  const act = async (fn: () => Promise<SkillDetail | null>, done?: string) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const d = await fn();
      if (d) show(d);
      if (done) setInfo(done);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!detail) return <section className="card">{error ? <Alert tone="danger">{error}</Alert> : <p className="loading">Loading…</p>}</section>;
  const p = detail.proposal;
  const open = p.status === 'proposed';
  const changed = name !== p.draft.name || description !== p.draft.description || steps !== p.draft.workflow.join('\n');
  const undecided = p.duplicates.filter((d) => !p.decisions.some((x) => x.id === d.id) && !(notes[d.id] ?? '').trim());
  return (
    <section className="card ref-inspector" aria-labelledby="skill-title">
      <div className="card-head">
        <h2 className="card-title" id="skill-title">
          SKL-{p.number} {p.draft.name}
        </h2>
        <button type="button" className="icon-btn" aria-label="Close the proposal" title="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <p className="imp-badges">
        <Badge tone={SKILL_TONE[p.status]}>{p.status}</Badge>
        <Badge tone="neutral">{p.examples.length} examples</Badge>
        <span className="subtle">{p.scannedAt ? `Checked against the tool scan of ${formatTime(p.scannedAt)}` : 'No tool scan yet'}</span>
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      {info && <Alert>{info}</Alert>}
      {p.reason && <p className="muted">Rejected: {p.reason}</p>}
      <h3 className="ref-subhead">Repeated work</h3>
      <ul className="plain-list" aria-label="Examples">
        {p.examples.map((e) => (
          <li key={e.id}>
            {e.title} <span className="subtle">{[e.projectName, e.at.slice(0, 10)].filter(Boolean).join(' · ')}</span>
          </li>
        ))}
      </ul>
      {open ? (
        <>
          <div className="field">
            <label htmlFor="skill-name">Name</label>
            <input id="skill-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="skill-trigger">When to use it</label>
            <textarea id="skill-trigger" className="textarea" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="skill-steps">Steps, one per line</label>
            <textarea id="skill-steps" className="textarea" rows={4} value={steps} onChange={(e) => setSteps(e.target.value)} />
          </div>
          {changed && (
            <div className="btn-row">
              <button type="button" className="btn" disabled={busy} onClick={() => void act(() => call(iap().editSkill({ id: p.id, name, description, workflow: steps.split('\n') })))}>
                Save changes
              </button>
            </div>
          )}
        </>
      ) : null}
      {p.duplicates.length > 0 && (
        <>
          <h3 className="ref-subhead">May already exist</h3>
          <div className="pref-matches">
            {p.duplicates.map((d) => {
              const decided = p.decisions.find((x) => x.id === d.id);
              return (
                <div key={d.id} className="pref-match">
                  <p>
                    <Badge tone="warn">{d.kind}</Badge> <strong>{d.name}</strong> <span className="subtle">({d.where})</span> {d.why}
                  </p>
                  {decided ? (
                    <p className="subtle">Different because: {decided.note}</p>
                  ) : open ? (
                    <input className="input" aria-label={`Why SKL-${p.number} is different from ${d.name}`} placeholder="Why this one is different" value={notes[d.id] ?? ''} onChange={(e) => setNotes({ ...notes, [d.id]: e.target.value })} />
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      )}
      <h3 className="ref-subhead">SKILL.md</h3>
      <pre className="skill-md" aria-label="SKILL.md preview">
        {detail.skillMd}
      </pre>
      {open && (
        <>
          {!p.scannedAt && <p className="hint">Scan your tools first (Tools → Scan) so existing skills and commands can be checked.</p>}
          {changed && <p className="hint">Save your changes before approving.</p>}
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || changed || undecided.length > 0}
              onClick={() =>
                void act(() =>
                  call(
                    iap().approveSkill({
                      id: p.id,
                      decisions: p.duplicates.filter((d) => (notes[d.id] ?? '').trim()).map((d) => ({ id: d.id, note: notes[d.id]! })),
                    }),
                  ),
                )
              }
            >
              <Icon name="check" size={16} /> Approve
            </button>
          </div>
          <div className="field">
            <label htmlFor="skill-reason">Reason for rejecting</label>
            <input id="skill-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="btn-row">
            <button type="button" className="btn" disabled={busy || !reason.trim()} onClick={() => void act(() => call(iap().rejectSkill({ id: p.id, reason })))}>
              Reject
            </button>
          </div>
        </>
      )}
      {p.status === 'approved' && (
        <>
          <p className="hint">Exporting writes a SKILL.md file to a folder you choose. The app never installs it and never writes into Claude Code&rsquo;s folders.</p>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const r = await call(iap().exportSkill(p.id));
                  if (r) setInfo(`Wrote ${r.path}. Copy it into Claude Code yourself if you want to use it.`);
                  return r ? call(iap().getSkill(p.id)) : null;
                })
              }
            >
              <Icon name="send" size={16} /> Export SKILL.md…
            </button>
          </div>
          {p.exports.map((e) => (
            <p key={e.at} className="subtle mono">
              {e.path}
            </p>
          ))}
        </>
      )}
    </section>
  );
}

export function SkillsTab() {
  const [list, setList] = useState<SkillProposal[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setList(await call(iap().listSkills()));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const detect = async () => {
    setError(null);
    try {
      const r = await call(iap().detectSkills());
      setInfo(r.created.length ? `Proposed ${r.created.map((p) => `SKL-${p.number}`).join(', ')} from ${r.looked} pieces of work.` : `Looked at ${r.looked} pieces of work. ${r.known.length ? 'The repeated work is already proposed.' : 'Nothing was done three or more times in a similar way.'}`);
      if (r.created[0]) setSelected(r.created[0].id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="content-grid">
      <div>
        <div className="ref-toolbar glass">
          <span className="subtle">From builds, runs and requests in the app&rsquo;s records</span>
          <button type="button" className="btn btn-primary" onClick={() => void detect()}>
            <Icon name="sparkle" size={16} /> Look for repeated work
          </button>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        {info && <Alert>{info}</Alert>}
        {list && list.length === 0 && (
          <div className="card">
            <Empty title="No skill proposals">When the same kind of work has been done three or more times, the app proposes a skill for it here.</Empty>
          </div>
        )}
        {list && list.length > 0 && (
          <ul className="imp-list" aria-label="Skill proposals">
            {list.map((p) => (
              <li key={p.id}>
                <button type="button" className="run-tile imp-row" aria-current={selected === p.id ? 'true' : undefined} onClick={() => setSelected(p.id)}>
                  <span className="imp-num">SKL-{p.number}</span>
                  <span className="run-tile-title">{p.draft.name}</span>
                  <span className="imp-badges">
                    <Badge tone={SKILL_TONE[p.status]}>{p.status}</Badge>
                    {p.duplicates.length > 0 && <Badge tone="warn">may exist</Badge>}
                    <span className="subtle">{p.examples.length} examples</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <aside aria-label="Skill details panel">
        {selected ? (
          <SkillInspector key={selected} id={selected} onChanged={load} onClose={() => setSelected(null)} />
        ) : (
          <section className="card" aria-labelledby="skills-rules-title">
            <h2 className="card-title" id="skills-rules-title">
              Skills from repeated work
            </h2>
            <p className="muted">
              A proposal lists the examples, when to use it, its steps, permissions, tests and the expected benefit. It is checked against the skills and commands in your tool scan, and an approved one is exported as a file for you to install yourself.
            </p>
          </section>
        )}
      </aside>
    </div>
  );
}

const CRITERIA: { id: Criterion; label: string }[] = [
  { id: 'source', label: 'Source' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'compatibility', label: 'Compatibility' },
  { id: 'cost', label: 'Cost' },
  { id: 'benefit', label: 'Benefit' },
];
const DECISION_TONE: Record<AddonDecision, Tone> = { include: 'ok', exclude: 'neutral', defer: 'warn' };

function AddonReviewForm({ status, onSaved }: { status: AddonStatus; onSaved: (o: AddonsOverview) => void }) {
  const last = status.review;
  const [criteria, setCriteria] = useState<Record<Criterion, CriterionReview>>(() => Object.fromEntries(CRITERIA.map((c) => [c.id, last?.criteria[c.id] ?? { status: 'unknown', note: '' }])) as Record<Criterion, CriterionReview>);
  const [decision, setDecision] = useState<AddonDecision>(last?.decision ?? 'defer');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const allReviewed = CRITERIA.every((c) => criteria[c.id].status !== 'unknown' && criteria[c.id].note.trim());
  const canInclude = status.found.length > 0 && allReviewed;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await call(iap().reviewAddon({ key: status.addon.key, criteria, decision, reason })));
      setReason('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const id = `addon-${status.addon.key}`;
  return (
    <div className="addon-form">
      {CRITERIA.map((c) => (
        <div key={c.id} className="addon-criterion">
          <select className="select" aria-label={`${c.label} for ${status.addon.label}`} value={criteria[c.id].status} onChange={(e) => setCriteria({ ...criteria, [c.id]: { ...criteria[c.id], status: e.target.value as CriterionReview['status'] } })}>
            <option value="unknown">{c.label}: not reviewed</option>
            <option value="ok">{c.label}: fine</option>
            <option value="concern">{c.label}: concern</option>
          </select>
          <input className="input" aria-label={`${c.label} note for ${status.addon.label}`} placeholder="What you found" value={criteria[c.id].note} onChange={(e) => setCriteria({ ...criteria, [c.id]: { ...criteria[c.id], note: e.target.value } })} />
        </div>
      ))}
      <div className="radio-row" role="radiogroup" aria-label={`Decision for ${status.addon.label}`}>
        {(['include', 'exclude', 'defer'] as const).map((d) => (
          <label key={d} className="radio-pill">
            <input type="radio" name={`${id}-decision`} checked={decision === d} disabled={d === 'include' && !canInclude} onChange={() => setDecision(d)} />
            {d === 'include' ? 'Include' : d === 'exclude' ? 'Exclude' : 'Defer'}
          </label>
        ))}
      </div>
      {!canInclude && <p className="hint">{status.found.length ? 'Review all five to include it.' : 'Not in the latest tool scan, so it can only be excluded or deferred.'}</p>}
      <input className="input" aria-label={`Reason for ${status.addon.label}`} placeholder="Why, in a sentence" value={reason} onChange={(e) => setReason(e.target.value)} />
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="btn-row">
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !reason.trim() || (decision === 'include' && !canInclude)} onClick={() => void save()}>
          Record the decision
        </button>
      </div>
    </div>
  );
}

export function AddonsTab() {
  const [overview, setOverview] = useState<AddonsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call(iap().listAddons())
      .then(setOverview)
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!overview) return <p className="loading">Loading…</p>;
  return (
    <>
      <Alert title="The app works without any of these">
        The app never loads, calls, installs or removes an add-on, so turning one off in Claude Code changes nothing here. A decision is a record of your review.
        {overview.scannedAt ? ` Found from the tool scan of ${formatTime(overview.scannedAt)}.` : ' Scan your tools first (Tools → Scan) so the app can see which ones you have.'}
      </Alert>
      <div className="card-grid addon-grid">
        {overview.addons.map((a) => (
          <section key={a.addon.key} className="card" aria-labelledby={`addon-${a.addon.key}-title`}>
            <div className="card-head">
              <h2 className="card-title" id={`addon-${a.addon.key}-title`}>
                {a.addon.label}
              </h2>
              {a.review ? <Badge tone={DECISION_TONE[a.review.decision]}>{a.review.decision}</Badge> : <Badge tone="neutral">not reviewed</Badge>}
            </div>
            <p className="muted">{a.addon.purpose}</p>
            <p className="hint">
              <strong>Look at:</strong> {a.addon.lookAt}
            </p>
            {a.addon.coveredBy && (
              <p className="hint">
                <strong>In the app already:</strong> {a.addon.coveredBy}
              </p>
            )}
            <p className="subtle">
              {a.found.length ? `Found: ${a.found.map((f) => `${f.name} (${f.kind}, ${f.status})`).join(', ')}` : 'Not found in the tool scan'} · {a.addon.toolId}
            </p>
            {a.review && (
              <p className="subtle">
                {a.review.reviewer}, {formatTime(a.review.createdAt)}: {a.review.reason}
              </p>
            )}
            <details>
              <summary>{a.review ? 'Review again' : 'Review'}</summary>
              <AddonReviewForm status={a} onSaved={setOverview} />
            </details>
          </section>
        ))}
      </div>
    </>
  );
}
