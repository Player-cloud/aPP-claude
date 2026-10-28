// Planning for one project (M5: FR-PLAN-001, FR-PLAN-002). Idea → concept
// brief → specification. Each document is drafted by the agent, edited here,
// and approved. An approved version never changes: revising it starts the
// next version, and approving that records what changed and why. Drafts from
// the simulated agent are labelled as such, and EGM is only reported as found
// or not, never as having run.
import { useState } from 'react';
import type { Brief, BriefField, PlanChange, PlanDoc, PlanningOverview, Priority, Requirement } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Alert, Badge, formatTime } from '../ui.tsx';
import { useAsync } from '../useAsync.ts';

type Kind = PlanDoc['kind'];
type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

const KIND_LABEL: Record<Kind, string> = { brief: 'Concept brief', spec: 'Specification' };

const FIELD_LABEL: Record<BriefField, string> = {
  goals: 'Goals',
  users: 'Users',
  useCases: 'Use cases',
  scope: 'In scope',
  nonGoals: 'Non-goals',
  confirmed: 'Confirmed facts',
  assumptions: 'Assumptions',
  dependencies: 'Dependencies',
  risks: 'Risks',
  successCriteria: 'Success criteria',
};
const FIELDS = Object.keys(FIELD_LABEL) as BriefField[];
const PRIORITIES: Priority[] = ['MUST', 'SHOULD', 'COULD'];

const STATUS: Record<PlanDoc['status'], { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'info' },
  approved: { label: 'Approved', tone: 'ok' },
  superseded: { label: 'Superseded', tone: 'neutral' },
  discarded: { label: 'Discarded', tone: 'neutral' },
};

const sourceLabel = (source: string) => (source === 'simulated' ? 'the simulated agent' : source === 'manual' ? 'you' : source);
const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

function Changes({ changes }: { changes: PlanChange[] }) {
  if (!changes.length) return <p className="muted">No differences.</p>;
  return (
    <ul className="small-list plan-changes">
      {changes.map((c, i) => (
        <li key={i}>
          <Badge tone={c.kind === 'added' ? 'ok' : c.kind === 'removed' ? 'danger' : 'info'}>{c.kind}</Badge> <span className="mono">{c.target}</span> {c.detail}
        </li>
      ))}
    </ul>
  );
}

function DocView({ doc }: { doc: PlanDoc }) {
  if (doc.kind === 'brief') {
    return (
      <dl className="plan-view">
        {FIELDS.map((f) => (
          <div key={f}>
            <dt>{FIELD_LABEL[f]}</dt>
            <dd>{doc.content[f].length ? <ul>{doc.content[f].map((item, i) => <li key={i}>{item}</li>)}</ul> : <span className="muted">None</span>}</dd>
          </div>
        ))}
      </dl>
    );
  }
  if (!doc.content.requirements.length) return <p className="muted">No requirements.</p>;
  return (
    <ol className="plan-reqs">
      {doc.content.requirements.map((r) => (
        <li key={r.id}>
          <p>
            <span className="mono">{r.id}</span> <span className="pill">{r.priority}</span> <strong>{r.title}</strong>
          </p>
          {r.description && <p className="subtle">{r.description}</p>}
          <ul>{r.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </li>
      ))}
    </ol>
  );
}

interface ReqForm {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  criteria: string;
}

function DraftEditor({ doc, isRevision, onChanged }: { doc: PlanDoc; isRevision: boolean; onChanged: () => Promise<void> }) {
  const [brief, setBrief] = useState<Record<BriefField, string>>(() =>
    Object.fromEntries(FIELDS.map((f) => [f, doc.kind === 'brief' ? doc.content[f].join('\n') : ''])) as Record<BriefField, string>,
  );
  const [reqs, setReqs] = useState<ReqForm[]>(() =>
    doc.kind === 'spec' ? doc.content.requirements.map((r) => ({ ...r, criteria: r.acceptanceCriteria.join('\n') })) : [],
  );
  const [note, setNote] = useState(doc.changeNote ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const content = () =>
    doc.kind === 'brief'
      ? (Object.fromEntries(FIELDS.map((f) => [f, lines(brief[f])])) as Brief)
      : {
          requirements: reqs.map(
            (r): Requirement => ({ id: r.id, title: r.title, description: r.description, priority: r.priority, acceptanceCriteria: lines(r.criteria) }),
          ),
        };

  const act = async (what: 'save' | 'approve' | 'discard') => {
    setBusy(what);
    setError(null);
    setSaved(false);
    try {
      if (what !== 'discard') await call(iap().savePlanDraft({ docId: doc.id, content: content(), changeNote: note }));
      if (what === 'approve') await call(iap().approvePlanDoc(doc.id));
      if (what === 'discard') await call(iap().discardPlanDraft(doc.id));
      if (what === 'save') setSaved(true);
      else await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const setReq = (i: number, patch: Partial<ReqForm>) => setReqs((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const label = KIND_LABEL[doc.kind].toLowerCase();

  return (
    <form className="plan-editor" aria-label={`Edit ${label} version ${doc.version}`} onSubmit={(e) => (e.preventDefault(), void act('save'))}>
      <p className="subtle">One item per line. Replace every line starting with “TODO:” before approving.</p>
      {doc.kind === 'brief' &&
        FIELDS.map((f) => (
          <div className="field" key={f}>
            <label htmlFor={`${doc.id}-${f}`}>{FIELD_LABEL[f]}</label>
            <textarea
              id={`${doc.id}-${f}`}
              className="textarea"
              rows={Math.min(6, Math.max(2, brief[f].split('\n').length))}
              value={brief[f]}
              onChange={(e) => setBrief({ ...brief, [f]: e.target.value })}
            />
          </div>
        ))}
      {doc.kind === 'spec' && (
        <>
          {reqs.map((r, i) => (
            <fieldset className="plan-req" key={i}>
              <legend>{r.id || 'New requirement'}</legend>
              <div className="plan-req-row">
                <div className="field">
                  <label htmlFor={`${doc.id}-t${i}`}>Title</label>
                  <input id={`${doc.id}-t${i}`} className="input" value={r.title} onChange={(e) => setReq(i, { title: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor={`${doc.id}-p${i}`}>Priority</label>
                  <select id={`${doc.id}-p${i}`} className="select" value={r.priority} onChange={(e) => setReq(i, { priority: e.target.value as Priority })}>
                    {PRIORITIES.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="field">
                <label htmlFor={`${doc.id}-d${i}`}>Description</label>
                <textarea id={`${doc.id}-d${i}`} className="textarea" rows={2} value={r.description} onChange={(e) => setReq(i, { description: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor={`${doc.id}-c${i}`}>Acceptance criteria</label>
                <textarea id={`${doc.id}-c${i}`} className="textarea" rows={2} value={r.criteria} onChange={(e) => setReq(i, { criteria: e.target.value })} />
              </div>
              <button type="button" className="btn btn-sm" onClick={() => setReqs(reqs.filter((_, j) => j !== i))}>
                Remove {r.id || 'requirement'}
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setReqs([...reqs, { id: '', title: '', description: '', priority: 'SHOULD', criteria: '' }])}
          >
            Add requirement
          </button>
        </>
      )}
      <div className="field">
        <label htmlFor={`${doc.id}-note`}>{isRevision ? 'What changed and why (required to approve)' : 'Note (optional)'}</label>
        <input id={`${doc.id}-note`} className="input" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
      </div>
      {error && (
        <Alert tone="danger">
          <span className="pre-line">{error}</span>
        </Alert>
      )}
      {saved && <p className="subtle">Saved.</p>}
      <div className="btn-row">
        <button type="submit" className="btn btn-sm" disabled={busy !== null}>
          {busy === 'save' ? 'Saving…' : 'Save draft'}
        </button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => void act('approve')}>
          {busy === 'approve' ? 'Approving…' : `Approve version ${doc.version}`}
        </button>
        <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void act('discard')}>
          Discard draft
        </button>
      </div>
    </form>
  );
}

function History({ versions }: { versions: PlanDoc[] }) {
  const [shown, setShown] = useState<{ id: string; changes: PlanChange[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const compare = async (before: PlanDoc, after: PlanDoc) => {
    setError(null);
    try {
      setShown({ id: after.id, changes: await call(iap().comparePlanDocs({ before: before.id, after: after.id })) });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <details className="plan-history">
      <summary>History ({versions.length})</summary>
      {error && <Alert tone="danger">{error}</Alert>}
      <ul>
        {versions.map((v, i) => {
          const previous = versions[i + 1];
          return (
            <li key={v.id}>
              <div className="plan-history-row">
                <span>Version {v.version}</span>
                <Badge tone={STATUS[v.status].tone}>{STATUS[v.status].label}</Badge>
                <span className="subtle">
                  {formatTime(v.approvedAt ?? v.updatedAt)} · drafted by {sourceLabel(v.source)}
                </span>
                {previous && (
                  <button type="button" className="btn btn-sm" onClick={() => void compare(previous, v)}>
                    Compare with version {previous.version}
                  </button>
                )}
              </div>
              {v.changeNote && <p className="subtle">“{v.changeNote}”</p>}
              {shown?.id === v.id && <Changes changes={shown.changes} />}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function PlanCard({
  kind,
  part,
  projectId,
  blocked,
  onChanged,
}: {
  kind: Kind;
  part: PlanningOverview['brief'];
  projectId: string;
  blocked: string | null;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { approved, draft, versions } = part;
  const current = draft ?? approved;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="plan-card" aria-labelledby={`plan-${kind}`}>
      <div className="agent-head">
        <h3 id={`plan-${kind}`}>{KIND_LABEL[kind]}</h3>
        {current ? (
          <Badge tone={STATUS[current.status].tone}>
            {STATUS[current.status].label} · version {current.version}
          </Badge>
        ) : (
          <Badge tone="neutral">Not started</Badge>
        )}
        {current?.source === 'simulated' && <span className="pill">Simulated draft</span>}
      </div>
      {current?.source === 'simulated' && draft && (
        <p className="subtle">Written by the simulated agent from your idea and facts, not by Claude. Fill in each “TODO:” yourself.</p>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {draft && <DraftEditor key={`${draft.id}-${draft.updatedAt}`} doc={draft} isRevision={Boolean(approved)} onChanged={onChanged} />}
      {!draft && approved && (
        <>
          <DocView doc={approved} />
          {approved.changes && approved.changes.length > 0 && (
            <>
              <h4>Changed in this version</h4>
              <Changes changes={approved.changes} />
            </>
          )}
        </>
      )}
      {!draft && (
        <div className="btn-row">
          {!approved && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || blocked !== null}
              onClick={() => void run(() => call(kind === 'brief' ? iap().draftBrief(projectId) : iap().draftSpec(projectId)))}
            >
              {busy ? 'Drafting…' : `Draft the ${KIND_LABEL[kind].toLowerCase()}`}
            </button>
          )}
          {approved && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(() => call(iap().revisePlanDoc(approved.id)))}>
              Revise
            </button>
          )}
          {approved && kind === 'spec' && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(() => call(iap().draftSpec(projectId)))}>
              {busy ? 'Drafting…' : 'Redraft from the brief'}
            </button>
          )}
        </div>
      )}
      {!draft && !approved && blocked && <p className="muted">{blocked}</p>}
      {versions.length > 0 && <History versions={versions} />}
    </section>
  );
}

export function PlanningPanel({ projectId }: { projectId: string }) {
  const overview = useAsync(() => call(iap().getPlanning(projectId)), [projectId]);
  const o = overview.data;
  const reload = async () => void (await overview.reload());
  return (
    <section className="card" aria-labelledby="planning-title">
      <h2 className="card-title" id="planning-title">
        Planning
      </h2>
      {overview.error && <Alert tone="danger">{overview.error}</Alert>}
      {o && (
        <>
          <p className="subtle egm-note">{o.egm.message}</p>
          {o.specOutdated && (
            <Alert tone="warn" title="The specification is out of date">
              The concept brief was revised after this specification was approved. Revise or redraft the specification.
            </Alert>
          )}
          <div className="plan-cards">
            <PlanCard kind="brief" part={o.brief} projectId={projectId} blocked={null} onChanged={reload} />
            <PlanCard
              kind="spec"
              part={o.spec}
              projectId={projectId}
              blocked={o.brief.approved ? null : 'Approve the concept brief first.'}
              onChanged={reload}
            />
          </div>
        </>
      )}
    </section>
  );
}
