import { useState, type FormEvent } from 'react';
import type { Fact, Project } from '../../shared/api.ts';
import { call, iap } from '../api.ts';
import { Icon } from '../icons.tsx';
import { Alert, Empty, formatDate } from '../ui.tsx';

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function CreateProjectPanel({ initialIdea, onCreated, onCancel }: { initialIdea: string; onCreated: (id: string, name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [idea, setIdea] = useState(initialIdea);
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

/** Registers an existing git repository (M8). Nothing in it is changed. */
function ImportProjectPanel({ onCreated, onCancel }: { onCreated: (id: string, name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [idea, setIdea] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const project = await call(iap().importProject({ name, path, idea: idea || undefined }));
      onCreated(project.id, project.name);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <section className="card" aria-labelledby="import-project-title">
      <h2 className="card-title" id="import-project-title">
        Import a repository
      </h2>
      <p className="subtle">The app records where the repository is. It does not change, move or copy anything in it.</p>
      <form onSubmit={submit} noValidate>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="field">
          <label htmlFor="i-name">Name</label>
          <input id="i-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
        </div>
        <div className="field">
          <label htmlFor="i-path">Repository folder</label>
          <input id="i-path" className="input mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Users\you\code\my-app" required />
          <span className="hint">The full path of a git repository with at least one commit.</span>
        </div>
        <div className="field">
          <label htmlFor="i-idea">What it is for (optional)</label>
          <textarea id="i-idea" className="textarea" value={idea} onChange={(e) => setIdea(e.target.value)} />
        </div>
        <div className="btn-row">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Importing…' : 'Import'}
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

const STAGES = ['Plan', 'Build', 'Design', 'Review', 'Ship'];

function ProjectCard({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const assumptions = project.facts.filter((f) => f.kind === 'assumption').length;
  return (
    <li>
      <button type="button" className="project-card" onClick={onOpen}>
        <span className="project-card-top">
          <span className="icon-tile">
            <Icon name="projects" />
          </span>
          <span className="project-card-arrow">
            <Icon name="arrow" size={20} />
          </span>
        </span>
        <span className="project-card-name">
          {project.name}
          {project.origin === 'imported' && <span className="pill">Imported</span>}
        </span>
        <span className="project-card-idea">{project.idea ?? 'No idea recorded yet.'}</span>
        <span className="project-card-foot">
          <span className="pill">
            <Icon name="calendar" size={14} /> {formatDate(project.createdAt)}
          </span>
          <span className="subtle">
            {project.facts.length - assumptions} confirmed · {assumptions} assumed
          </span>
        </span>
      </button>
    </li>
  );
}

export function ProjectsView({
  projects,
  error,
  creating,
  onCreate,
  onCancelCreate,
  onCreated,
  onOpen,
}: {
  projects: Project[] | null;
  error: string | null;
  creating: { idea: string } | null;
  onCreate: (idea?: string) => void;
  onCancelCreate: () => void;
  onCreated: (id: string, name: string) => void;
  onOpen: (id: string, name: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [importing, setImporting] = useState(false);

  const newButton = (
    <span className="btn-row">
      <button type="button" className="btn btn-primary" onClick={() => {
          setImporting(false);
          onCreate();
        }} disabled={!!creating}>
        <Icon name="plus" size={16} /> New project
      </button>
      <button type="button" className="btn" onClick={() => {
          onCancelCreate();
          setImporting(true);
        }} disabled={importing}>
        Import a repository
      </button>
    </span>
  );

  const startFromIdea = (event: FormEvent) => {
    event.preventDefault();
    setImporting(false);
    onCreate(draft.trim());
    setDraft('');
  };

  return (
    <>
      <p className="eyebrow">Welcome back</p>
      <h1 className="page-title">
        Bring your next <span className="accent">idea</span> to life
      </h1>
      <p className="page-lede">Plan, build, review and ship software projects. Each project has its own workspace and design documents.</p>
      <div className="content-grid">
        <div>
          <form className="composer glass" onSubmit={startFromIdea}>
            <span className="composer-icon">
              <Icon name="sparkle" size={20} />
            </span>
            <textarea
              className="composer-input"
              aria-label="Describe what you want to build"
              placeholder="Describe what you want to build…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
            />
            <div className="composer-foot">
              <span className="subtle">You'll name it and record what's confirmed on the next step.</span>
              <button type="submit" className="round-btn" aria-label="Continue with this description" title="Continue">
                <Icon name="send" size={18} />
              </button>
            </div>
          </form>

          <section aria-labelledby="projects-title" className="section">
            <div className="section-head">
              <h2 className="section-title" id="projects-title">
                Projects {projects && <span className="count-pill">{projects.length}</span>}
              </h2>
              {projects && projects.length > 0 && newButton}
            </div>
            {!projects && !error && <p className="loading">Loading projects…</p>}
            {error && <Alert tone="danger" title="Could not load projects">{error}</Alert>}
            {projects && projects.length === 0 && (
              <div className="card">
                <Empty title="No projects yet" action={!creating && newButton}>
                  Create your first project from an idea, or import an existing git repository. You can record what is confirmed and what is still an assumption.
                </Empty>
              </div>
            )}
            {projects && projects.length > 0 && (
              <ul className="card-grid" aria-label="All projects">
                {projects.map((p) => (
                  <ProjectCard key={p.id} project={p} onOpen={() => onOpen(p.id, p.name)} />
                ))}
              </ul>
            )}
          </section>
        </div>
        <aside aria-label="Project details panel">
          {creating ? (
            <CreateProjectPanel key={creating.idea} initialIdea={creating.idea} onCreated={onCreated} onCancel={onCancelCreate} />
          ) : importing ? (
            <ImportProjectPanel onCreated={onCreated} onCancel={() => setImporting(false)} />
          ) : (
            <section className="card">
              <h2 className="card-title">How projects work</h2>
              <ol className="stages">
                {STAGES.map((s, i) => (
                  <li key={s}>
                    <span className="stage-num">{i + 1}</span>
                    {s}
                  </li>
                ))}
              </ol>
              <p className="muted">
                Each piece of work is a workflow run with an explicit state, and every change is recorded in the activity log.
              </p>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
