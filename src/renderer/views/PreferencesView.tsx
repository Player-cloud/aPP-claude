// Preferences and the Vault (M14: FR-LEARN-001/004, DEC-030). Feedback becomes
// a preference only after the person approves the wording, and a likely
// duplicate or conflict needs their decision. The wrap-up is built from the
// records and saved to the Vault inbox only on request; a saved summary is a
// note, never a rule.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Preference, PreferenceDetail, Project, SessionSummary, SummaryItem, VaultNote } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Icon } from '../icons.tsx';
import { Alert, Badge, Empty, formatTime, relativeTime, type Tone } from '../ui.tsx';

export type PreferencesTab = 'preferences' | 'wrapup' | 'vault';

const STATUS_TONE: Record<Preference['status'], Tone> = { proposed: 'warn', active: 'ok', rejected: 'neutral', removed: 'neutral' };
const BASIS_TONE: Record<SummaryItem['basis'], Tone> = { confirmed: 'ok', assumption: 'warn', inferred: 'info' };
const SOURCE_LABEL: Record<Preference['source']['type'], string> = { person: 'Typed as a preference', feedback: 'From feedback', wrap_up: 'From a wrap-up' };

function ScopeChooser({ scope, projectId, projects, onChange, name }: { scope: 'global' | 'project'; projectId: string; projects: Project[]; onChange: (scope: 'global' | 'project', projectId: string) => void; name: string }) {
  return (
    <div className="field">
      <div className="radio-row" role="radiogroup" aria-label="Applies to">
        <label className="radio-pill">
          <input type="radio" name={name} checked={scope === 'global'} onChange={() => onChange('global', '')} />
          All work
        </label>
        <label className="radio-pill">
          <input type="radio" name={name} checked={scope === 'project'} disabled={projects.length === 0} onChange={() => onChange('project', projectId || projects[0]?.id || '')} />
          One project
        </label>
      </div>
      {scope === 'project' && (
        <select className="select" aria-label="Project" value={projectId} onChange={(e) => onChange('project', e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function Propose({ projects, onProposed }: { projects: Project[]; onProposed: (d: PreferenceDetail) => void }) {
  const [text, setText] = useState('');
  const [scope, setScope] = useState<'global' | 'project'>('global');
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onProposed(await call(iap().proposePreference({ text, scope, ...(scope === 'project' ? { projectId } : {}) })));
      setText('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card" onSubmit={submit} aria-labelledby="pref-new-title">
      <h2 className="card-title" id="pref-new-title">
        Propose a preference
      </h2>
      <div className="field">
        <label htmlFor="pref-new">How would you like the work done?</label>
        <textarea id="pref-new" className="textarea" rows={2} value={text} placeholder="For example: use British English in all interface text" onChange={(e) => setText(e.target.value)} />
        <p className="hint">The app proposes the wording. You can change it before you approve it, and nothing is used until you do.</p>
      </div>
      <ScopeChooser
        name="pref-new-scope"
        scope={scope}
        projectId={projectId}
        projects={projects}
        onChange={(s, p) => {
          setScope(s);
          setProjectId(p);
        }}
      />
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={busy || !text.trim() || (scope === 'project' && !projectId)}>
          <Icon name="plus" size={16} /> Propose
        </button>
      </div>
    </form>
  );
}

function Inspector({ id, onChanged, onClose }: { id: string; onChanged: () => Promise<void>; onClose: () => void }) {
  const [detail, setDetail] = useState<PreferenceDetail | null>(null);
  const [text, setText] = useState('');
  const [choices, setChoices] = useState<Record<string, 'keep_both' | 'replace'>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = (d: PreferenceDetail) => {
    setDetail(d);
    setText(d.preference.text);
    setChoices({});
  };
  useEffect(() => {
    call(iap().getPreference(id))
      .then(show)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  const act = async (fn: () => Promise<PreferenceDetail>) => {
    setBusy(true);
    setError(null);
    try {
      show(await fn());
      setReason('');
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!detail) return <section className="card">{error ? <Alert tone="danger">{error}</Alert> : <p className="loading">Loading…</p>}</section>;
  const p = detail.preference;
  const open = p.status === 'proposed' || p.status === 'active';
  const resolutions = detail.matches.filter((m) => choices[m.id]).map((m) => ({ id: m.id, action: choices[m.id]! }));
  const undecided = detail.matches.filter((m) => !choices[m.id]).length;
  const changed = text.trim() !== p.text;

  return (
    <section className="card ref-inspector" aria-labelledby="pref-title">
      <div className="card-head">
        <h2 className="card-title" id="pref-title">
          PREF-{p.number}
        </h2>
        <button type="button" className="icon-btn" aria-label="Close the preference" title="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <p className="imp-badges">
        <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
        <Badge tone="neutral">{p.scope === 'global' ? 'All work' : detail.projectName}</Badge>
        <Badge tone="neutral">{SOURCE_LABEL[p.source.type]}</Badge>
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      {open ? (
        <div className="field">
          <label htmlFor="pref-text">Wording</label>
          <textarea id="pref-text" className="textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
          {p.text !== p.proposedText && <p className="hint">The app proposed: {p.proposedText}</p>}
        </div>
      ) : (
        <p className="pref-text">{p.text}</p>
      )}
      <dl className="kv">
        <div className="kv-row">
          <dt>Source</dt>
          <dd>
            {p.source.summary}
            {p.source.quote && p.source.quote !== p.text && <span className="subtle plat-meta">&ldquo;{p.source.quote}&rdquo;</span>}
          </dd>
        </div>
        {p.approver && (
          <div className="kv-row">
            <dt>Approved</dt>
            <dd>
              {p.approver}, {formatTime(p.approvedAt!)}
            </dd>
          </div>
        )}
        {p.reason && (
          <div className="kv-row">
            <dt>{p.status === 'rejected' ? 'Rejected' : 'Removed'}</dt>
            <dd>{p.reason}</dd>
          </div>
        )}
      </dl>

      {detail.matches.length > 0 && (
        <div className="pref-matches" role="group" aria-label="Possible duplicates and conflicts">
          <Alert tone="warn" title={`${detail.matches.length} active preference${detail.matches.length === 1 ? '' : 's'} may overlap`}>
            The app does not combine preferences by itself. For each one, decide whether both stay or this one replaces it.
          </Alert>
          {detail.matches.map((m) => (
            <div key={m.id} className="pref-match">
              <p>
                <Badge tone={m.kind === 'conflict' ? 'danger' : 'warn'}>{m.kind === 'conflict' ? 'May contradict' : 'May duplicate'}</Badge> <span className="imp-num">PREF-{m.number}</span> {m.text}
              </p>
              <p className="subtle">
                {m.why} {Math.round(m.similarity * 100)}% the same words.
              </p>
              <div className="radio-row" role="radiogroup" aria-label={`Decision for PREF-${m.number}`}>
                <label className="radio-pill">
                  <input type="radio" name={`res-${m.id}`} checked={choices[m.id] === 'keep_both'} onChange={() => setChoices({ ...choices, [m.id]: 'keep_both' })} />
                  Keep both
                </label>
                <label className="radio-pill">
                  <input type="radio" name={`res-${m.id}`} checked={choices[m.id] === 'replace'} onChange={() => setChoices({ ...choices, [m.id]: 'replace' })} />
                  This one replaces PREF-{m.number}
                </label>
              </div>
            </div>
          ))}
        </div>
      )}

      {p.status === 'proposed' && (
        <div className="btn-row">
          {changed && (
            <button type="button" className="btn" disabled={busy || !text.trim()} onClick={() => void act(() => call(iap().editPreference({ id: p.id, text })))}>
              Save wording
            </button>
          )}
          <button type="button" className="btn btn-primary" disabled={busy || changed || undecided > 0} title={changed ? 'Save the wording first' : undefined} onClick={() => void act(() => call(iap().approvePreference({ id: p.id, resolutions })))}>
            <Icon name="check" size={16} /> Approve
          </button>
        </div>
      )}
      {p.status === 'active' && changed && (
        <div className="btn-row">
          <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => void act(() => call(iap().editPreference({ id: p.id, text, resolutions: [] })))}>
            Save the new wording
          </button>
        </div>
      )}
      {open && (
        <div className="field">
          <label htmlFor="pref-reason">{p.status === 'proposed' ? 'Why not (optional)' : 'Why remove it (optional)'}</label>
          <input id="pref-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="btn-row">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void act(() => call(p.status === 'proposed' ? iap().rejectPreference({ id: p.id, reason: reason || undefined }) : iap().removePreference({ id: p.id, reason: reason || undefined })))}
            >
              {p.status === 'proposed' ? 'Reject' : 'Remove'}
            </button>
          </div>
          <p className="hint">Nothing is deleted: a {p.status === 'proposed' ? 'rejected proposal' : 'removed preference'} stays in the history.</p>
        </div>
      )}
      {p.status === 'active' && (
        <p className="hint">Active preferences are given to the build agent as guidance for the work. They never change approvals, checks or gates.</p>
      )}
    </section>
  );
}

function PreferencesTabView({ projects }: { projects: Project[] }) {
  const [list, setList] = useState<Preference[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setList(await call(iap().listPreferences()));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const group = (statuses: Preference['status'][]) => (list ?? []).filter((p) => statuses.includes(p.status));
  const projectName = (id: string | null) => projects.find((p) => p.id === id)?.name ?? 'a project';
  const row = (p: Preference) => (
    <li key={p.id}>
      <button type="button" className="run-tile imp-row" aria-current={selected === p.id ? 'true' : undefined} onClick={() => setSelected(p.id)}>
        <span className="imp-num">PREF-{p.number}</span>
        <span className="run-tile-title">{p.text}</span>
        <span className="imp-badges">
          <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
          <Badge tone="neutral">{p.scope === 'global' ? 'All work' : projectName(p.projectId)}</Badge>
        </span>
      </button>
    </li>
  );
  const proposed = group(['proposed']);
  const active = group(['active']);
  const history = group(['rejected', 'removed']);
  return (
    <div className="content-grid">
      <div>
        {error && <Alert tone="danger">{error}</Alert>}
        {!list && !error && <p className="loading">Loading preferences…</p>}
        {list && (
          <>
            <section className="section" aria-labelledby="pref-proposed-title">
              <h2 className="section-title" id="pref-proposed-title">
                Waiting for you <span className="count-pill">{proposed.length}</span>
              </h2>
              {proposed.length === 0 ? <p className="muted">No proposals.</p> : <ul className="imp-list" aria-label="Proposed preferences">{proposed.map(row)}</ul>}
            </section>
            <section className="section" aria-labelledby="pref-active-title">
              <h2 className="section-title" id="pref-active-title">
                Active <span className="count-pill">{active.length}</span>
              </h2>
              {active.length === 0 ? (
                <div className="card">
                  <Empty title="No active preferences">Propose one below, or give feedback about the work in Improvements. Approved preferences guide the build agent.</Empty>
                </div>
              ) : (
                <ul className="imp-list" aria-label="Active preferences">{active.map(row)}</ul>
              )}
            </section>
            {history.length > 0 && (
              <details className="section">
                <summary className="section-title">History ({history.length})</summary>
                <ul className="imp-list" aria-label="Rejected and removed preferences">{history.map(row)}</ul>
              </details>
            )}
          </>
        )}
        <Propose
          projects={projects}
          onProposed={(d) => {
            void load();
            setSelected(d.preference.id);
          }}
        />
      </div>
      <aside aria-label="Preference details panel">
        {selected ? (
          <Inspector key={selected} id={selected} onChanged={load} onClose={() => setSelected(null)} />
        ) : (
          <section className="card" aria-labelledby="pref-rules-title">
            <h2 className="card-title" id="pref-rules-title">
              How preferences work
            </h2>
            <ul className="upd-list">
              <li>The app proposes wording from your words; you edit and approve it.</li>
              <li>A preference applies to all work or to one project.</li>
              <li>A likely duplicate or contradiction is shown, and you decide whether both stay.</li>
              <li>Active preferences guide the build agent. They never change approvals, checks or release gates.</li>
              <li>Removing one stops it being used. Nothing is deleted.</li>
            </ul>
          </section>
        )}
      </aside>
    </div>
  );
}

const PERIODS: { id: string; label: string; hours?: number }[] = [
  { id: 'last', label: 'Since the last saved wrap-up' },
  { id: '4', label: 'Last 4 hours', hours: 4 },
  { id: '24', label: 'Last 24 hours', hours: 24 },
  { id: '72', label: 'Last 3 days', hours: 72 },
  { id: '168', label: 'Last 7 days', hours: 168 },
];

function SummaryList({ title, items, none, id }: { title: string; items: SummaryItem[]; none: string; id: string }) {
  return (
    <section className="card" aria-labelledby={id}>
      <h2 className="card-title" id={id}>
        {title} <span className="count-pill">{items.length}</span>
      </h2>
      {items.length === 0 ? (
        <p className="muted">{none}</p>
      ) : (
        <ul className="plat-list">
          {items.map((i, n) => (
            <li key={n}>
              <span>{i.text}</span>
              <Badge tone={BASIS_TONE[i.basis]}>{i.basis}</Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function WrapUpTab({ onSaved }: { onSaved: (n: VaultNote) => void }) {
  const [period, setPeriod] = useState('last');
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<VaultNote | null>(null);
  const load = useCallback(async () => {
    const hours = PERIODS.find((p) => p.id === period)?.hours;
    try {
      setSummary(await call(iap().wrapUp(hours ? { hours } : {})));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [period]);
  useEffect(() => {
    setSaved(null);
    void load();
  }, [load]);
  const save = async () => {
    if (!summary) return;
    setBusy(true);
    setError(null);
    try {
      const n = await call(iap().saveWrapUp({ from: summary.from, to: summary.to }));
      setSaved(n);
      onSaved(n);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="ref-toolbar glass">
        <select className="select" aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value)}>
          {PERIODS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {summary && (
          <span className="subtle">
            {formatTime(summary.from)} to {formatTime(summary.to)} · {summary.events} recorded events
          </span>
        )}
        <button type="button" className="btn btn-primary" disabled={busy || !summary || saved !== null} onClick={() => void save()}>
          <Icon name="archive" size={16} /> {saved ? `Saved as NOTE-${saved.number}` : 'Save to the Vault inbox'}
        </button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {!summary && !error && <p className="loading">Summarising…</p>}
      {saved && <Alert title="Saved">NOTE-{saved.number} is in the Vault inbox. It is a note, not a rule: propose a line as a preference from the Vault if you want it used.</Alert>}
      {summary && (
        <div className="card-grid">
          <SummaryList id="wrap-decisions" title="Decisions" items={summary.decisions} none="No decisions were recorded." />
          <SummaryList id="wrap-progress" title="Progress" items={summary.progress} none="Nothing moved forward." />
          <SummaryList id="wrap-blockers" title="Blockers" items={summary.blockers} none="Nothing is blocked." />
          <SummaryList id="wrap-next" title="Next steps" items={summary.nextSteps} none="No open work." />
          <SummaryList id="wrap-assumptions" title="Assumptions" items={summary.assumptions} none="No assumptions are recorded for these projects." />
        </div>
      )}
      <p className="hint">
        Built from the app&rsquo;s own records, without calling a model. <strong>Confirmed</strong> lines are decisions or facts you recorded; <strong>assumption</strong> lines are facts you marked as
        assumed; <strong>inferred</strong> lines are next steps the app suggests from open work.
      </p>
    </>
  );
}

function VaultTab({ onProposed }: { onProposed: () => void }) {
  const [status, setStatus] = useState<'inbox' | 'kept' | 'archived'>('inbox');
  const [notes, setNotes] = useState<VaultNote[] | null>(null);
  const [selected, setSelected] = useState<VaultNote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const load = useCallback(async () => {
    try {
      setNotes(await call(iap().listVaultNotes({ status })));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [status]);
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setInfo(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const lines = selected?.summary ? [...selected.summary.decisions, ...selected.summary.progress, ...selected.summary.blockers, ...selected.summary.nextSteps, ...selected.summary.assumptions] : [];
  return (
    <div className="content-grid">
      <div>
        <div className="ref-toolbar glass">
          <div className="segmented" role="group" aria-label="Show notes">
            {(['inbox', 'kept', 'archived'] as const).map((s) => (
              <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>
                {s === 'inbox' ? 'Inbox' : s === 'kept' ? 'Kept' : 'Archived'}
              </button>
            ))}
          </div>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        {info && <Alert>{info}</Alert>}
        {notes && notes.length === 0 && (
          <div className="card">
            <Empty title={status === 'inbox' ? 'The inbox is empty' : `Nothing ${status}`}>{status === 'inbox' ? 'Save a wrap-up, or add a note below.' : 'Notes you file appear here.'}</Empty>
          </div>
        )}
        {notes && notes.length > 0 && (
          <ul className="imp-list" aria-label="Vault notes">
            {notes.map((n) => (
              <li key={n.id}>
                <button type="button" className="run-tile imp-row" aria-current={selected?.id === n.id ? 'true' : undefined} onClick={() => setSelected(n)}>
                  <span className="imp-num">NOTE-{n.number}</span>
                  <span className="run-tile-title">{n.title}</span>
                  <span className="imp-badges">
                    <Badge tone="neutral">{n.kind === 'session' ? 'Wrap-up' : 'Note'}</Badge>
                    <span className="subtle">{relativeTime(n.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="card"
          aria-labelledby="vault-new-title"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const n = await call(iap().addVaultNote({ title, body }));
              setTitle('');
              setBody('');
              setStatus('inbox');
              setSelected(n);
            });
          }}
        >
          <h2 className="card-title" id="vault-new-title">
            Add a note
          </h2>
          <div className="field">
            <label htmlFor="vault-title">Title</label>
            <input id="vault-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="vault-body">Note</label>
            <textarea id="vault-body" className="textarea" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
          <div className="btn-row">
            <button type="submit" className="btn" disabled={!title.trim() || !body.trim()}>
              <Icon name="plus" size={16} /> Add to the inbox
            </button>
          </div>
        </form>
      </div>
      <aside aria-label="Note details panel">
        {selected ? (
          <section className="card ref-inspector" aria-labelledby="note-title">
            <div className="card-head">
              <h2 className="card-title" id="note-title">
                NOTE-{selected.number} {selected.title}
              </h2>
              <button type="button" className="icon-btn" aria-label="Close the note" title="Close" onClick={() => setSelected(null)}>
                <Icon name="close" size={16} />
              </button>
            </div>
            <p className="subtle">
              {selected.source.summary}, {formatTime(selected.createdAt)} · {selected.status}
            </p>
            <div className="btn-row">
              {selected.status !== 'kept' && (
                <button type="button" className="btn btn-sm" onClick={() => void run(async () => setSelected(await call(iap().fileVaultNote({ id: selected.id, status: 'kept' }))))}>
                  Keep
                </button>
              )}
              {selected.status !== 'archived' && (
                <button type="button" className="btn btn-sm" onClick={() => void run(async () => setSelected(await call(iap().fileVaultNote({ id: selected.id, status: 'archived' }))))}>
                  Archive
                </button>
              )}
            </div>
            {lines.length > 0 ? (
              <>
                <h3 className="ref-subhead">Lines</h3>
                <ul className="plat-list" aria-label="Lines of the summary">
                  {lines.map((l, n) => (
                    <li key={n}>
                      <span>
                        {l.text} <Badge tone={BASIS_TONE[l.basis]}>{l.basis}</Badge>
                      </span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() =>
                          void run(async () => {
                            const d = await call(iap().proposePreferenceFromNote({ noteId: selected.id, line: l.text }));
                            setInfo(`Proposed as PREF-${d.preference.number}. Approve it in Preferences if you want it used.`);
                            onProposed();
                          })
                        }
                      >
                        Propose as preference
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="pre-line">{selected.body}</p>
            )}
          </section>
        ) : (
          <section className="card" aria-labelledby="vault-rules-title">
            <h2 className="card-title" id="vault-rules-title">
              The Vault
            </h2>
            <p className="muted">Saved wrap-ups and your own notes. A note is never a rule: to have something used in the work, propose it as a preference and approve it.</p>
          </section>
        )}
      </aside>
    </div>
  );
}

export function PreferencesView({ projects, tab, onTab }: { projects: Project[]; tab: PreferencesTab; onTab: (t: PreferencesTab) => void }) {
  const [refresh, setRefresh] = useState(0);
  return (
    <>
      <p className="eyebrow">Learning</p>
      <h1 className="page-title">
        Remember how you <span className="accent">like the work done</span>
      </h1>
      <p className="page-lede">
        Preferences you approve guide the build agent, for all work or for one project. Wrap-ups summarise what happened from the app&rsquo;s records and go to the Vault only when you save them.
      </p>
      <div className="segmented page-tabs" role="group" aria-label="Show">
        <button type="button" aria-pressed={tab === 'preferences'} onClick={() => onTab('preferences')}>
          Preferences
        </button>
        <button type="button" aria-pressed={tab === 'wrapup'} onClick={() => onTab('wrapup')}>
          Wrap-up
        </button>
        <button type="button" aria-pressed={tab === 'vault'} onClick={() => onTab('vault')}>
          Vault
        </button>
      </div>
      {tab === 'preferences' && <PreferencesTabView key={refresh} projects={projects} />}
      {tab === 'wrapup' && <WrapUpTab onSaved={() => setRefresh((n) => n + 1)} />}
      {tab === 'vault' && <VaultTab onProposed={() => setRefresh((n) => n + 1)} />}
    </>
  );
}
