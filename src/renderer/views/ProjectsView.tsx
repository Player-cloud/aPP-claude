import { useState, type FormEvent } from 'react';
import type { Fact } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Icon } from '../icons.tsx';
import { Alert, Badge, Empty, formatTime } from '../ui.tsx';
import { useAsync } from '../useAsync.ts';

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function CreateProjectPanel({ onCreated, onCancel }: { onCreated: (id: string, name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [idea, setIdea] = useState('');
  const [confirmed, setConfirmed] = useState('');
  const [assumptions, setAssumptions] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const facts: Fact[] = [
      ...lines(confirmed).map((text) => ({ kind: 'confirmed' as const, text })),
      ...lines(assumptions).map((text) => ({ kind: 'assumption' as const, text })),
    ];
    try {
      const project = await call(iap().createProject({ name, idea: idea || undefined, facts }));
      onCreated(project.id, project.name);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <section className="card" aria-labelledby="new-project-title">
      <h2 className="card-title" id="new-project-title">
        New project
      </h2>
      <form onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="field">
          <label htmlFor="p-name">Name</label>
          <input id="p-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
        </div>
        <div className="field">
          <label htmlFor="p-idea">Idea</label>
          <textarea id="p-idea" className="textarea" value={idea} onChange={(e) => setIdea(e.target.value)} />
          <span className="hint">What should this project do, and for whom?</span>
        </div>
        <div className="field">
          <label htmlFor="p-confirmed">Confirmed facts</label>
          <textarea id="p-confirmed" className="textarea" value={confirmed} onChange={(e) => setConfirmed(e.target.value)} aria-describedby="p-confirmed-hint" />
          <span className="hint" id="p-confirmed-hint">
            One per line. Things you know are true.
          </span>
        </div>
        <div className="field">
          <label htmlFor="p-assumptions">Assumptions</label>
          <textarea id="p-assumptions" className="textarea" value={assumptions} onChange={(e) => setAssumptions(e.target.value)} aria-describedby="p-assumptions-hint" />
          <span className="hint" id="p-assumptions-hint">
            One per line. Things still to be confirmed.
          </span>
        </div>
        <div className="btn-row">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Creating…' : 'Create project'}
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

export function ProjectsView({ onOpen }: { onOpen: (id: string, name: string) => void }) {
  const { data: projects, error, loading } = useAsync(() => call(iap().listProjects()), []);
  const [creating, setCreating] = useState(false);

  const newButton = (
    <button type="button" className="btn btn-primary" onClick={() => setCreating(true)} disabled={creating}>
      <Icon name="plus" size={16} /> New project
    </button>
  );

  return (
    <>
      <h1 className="page-title">
        Your <span className="accent">projects</span>
      </h1>
      <p className="page-lede">Plan, build, review and ship software projects. Each project has its own workspace and design documents.</p>
      <div className="content-grid">
        <section className="card" aria-labelledby="projects-title">
          <div className="card-head">
            <h2 className="card-title" id="projects-title">
              Projects {projects && <span className="count">{projects.length}</span>}
            </h2>
            {projects && projects.length > 0 && newButton}
          </div>
          {loading && !projects && <p className="loading">Loading projects…</p>}
          {error && <Alert tone="danger" title="Could not load projects">{error}</Alert>}
          {projects && projects.length === 0 && (
            <Empty title="No projects yet" action={!creating && newButton}>
              Create your first project from an idea. You can record what is confirmed and what is still an assumption.
            </Empty>
          )}
          {projects && projects.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Status</th>
                  <th scope="col">Facts</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => {
                  const assumptions = p.facts.filter((f) => f.kind === 'assumption').length;
                  return (
                    <tr key={p.id}>
                      <td>
                        <button type="button" className="row-link" onClick={() => onOpen(p.id, p.name)}>
                          {p.name}
                        </button>
                        {p.idea && <div className="subtle">{p.idea.length > 90 ? `${p.idea.slice(0, 90)}…` : p.idea}</div>}
                      </td>
                      <td>
                        <Badge tone={p.status === 'active' ? 'ok' : 'neutral'}>{p.status === 'active' ? 'Active' : 'Archived'}</Badge>
                      </td>
                      <td className="subtle">
                        {p.facts.length - assumptions} confirmed · {assumptions} assumed
                      </td>
                      <td className="subtle">{formatTime(p.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
        <aside aria-label="Project details panel">
          {creating ? (
            <CreateProjectPanel onCreated={onOpen} onCancel={() => setCreating(false)} />
          ) : (
            <section className="card">
              <h2 className="card-title">How projects work</h2>
              <p className="muted">
                A project moves through <strong>Plan → Build → Design → Review → Ship</strong>. Each piece of work is a workflow run with an explicit
                state, and every change is recorded in the activity log.
              </p>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
