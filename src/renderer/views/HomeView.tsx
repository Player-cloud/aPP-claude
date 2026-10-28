// Command Centre (DEC-021): the default screen. Every number and state here
// comes from the workspace; anything not built yet is labelled Planned and
// anything not run yet says "Not checked" instead of looking healthy.
import { useState } from 'react';
import type { AgentStatus, Project, RunWithNext, ToolScan, Workflow } from '../../shared/api.ts';
import type { Section } from '../App.tsx';
import { call, iap } from '../api.ts';
import { Icon } from '../icons.tsx';
import { Alert, Badge, Empty, formatTime, relativeTime, RUN_GROUPS, runStep, StateBadge, needsPerson, type Tone } from '../ui.tsx';
import { useAsync } from '../useAsync.ts';
import { describe } from './ActivityView.tsx';

const WORKFLOW_LABEL: Record<Workflow, string> = {
  plan: 'Plan',
  build: 'Build',
  design: 'Design',
  review: 'Review',
  ship: 'Ship',
  assess: 'Assessment',
  maintenance: 'Maintenance',
};

type Run = RunWithNext & { projectName: string };

function Metric({ label, value, detail, status, tone }: { label: string; value: string; detail: string; status: string; tone: Tone }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      <span className="metric-detail">{detail}</span>
      <span className="metric-status" data-tone={tone}>
        <span className="status-dot" aria-hidden="true" />
        {status}
      </span>
    </div>
  );
}

function RunTile({ run, onOpen }: { run: Run; onOpen: () => void }) {
  const step = runStep(run.state, run.blockedFrom);
  return (
    <li>
      <button type="button" className="run-tile" onClick={onOpen} aria-label={`${run.title}, ${run.projectName}`}>
        <span className="run-tile-title">{run.title}</span>
        <span className="run-tile-project">{run.projectName}</span>
        <span className="run-tile-tags">
          <span className="tag">{WORKFLOW_LABEL[run.workflow] ?? run.workflow}</span>
          <StateBadge state={run.state} />
        </span>
        {step && run.state !== 'completed' && (
          <span className="run-tile-progress">
            <span className="progress-track" aria-hidden="true">
              <span className="progress-fill" style={{ width: `${(step.step / step.of) * 100}%` }} />
            </span>
            <span className="subtle">
              Step {step.step} of {step.of}
            </span>
          </span>
        )}
        {run.state === 'blocked' && run.blockerReason && <span className="run-tile-note">{run.blockerReason}</span>}
      </button>
    </li>
  );
}

function RunsBoard({ runs, onOpen }: { runs: Run[]; onOpen: (r: Run) => void }) {
  const [view, setView] = useState<'board' | 'list'>('board');
  const closed = runs.filter((r) => r.state === 'failed' || r.state === 'cancelled').length;
  return (
    <section className="card" aria-labelledby="board-title">
      <div className="card-head">
        <h2 className="card-title" id="board-title">
          Workflow runs <span className="count-pill">{runs.length}</span>
        </h2>
        <div className="segmented" role="group" aria-label="Show runs as">
          <button type="button" aria-pressed={view === 'board'} onClick={() => setView('board')}>
            Board
          </button>
          <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>
            List
          </button>
        </div>
      </div>
      {runs.length === 0 && <Empty title="No workflow runs yet">Open a project and start a run. Its state shows up here.</Empty>}
      {runs.length > 0 && view === 'board' && (
        <>
          <div className="board">
            {RUN_GROUPS.map((g) => {
              const list = runs.filter((r) => g.states.includes(r.state));
              return (
                <section key={g.id} className="board-col" data-group={g.id} aria-label={`${g.label}, ${list.length}`}>
                  <h3 className="board-col-title">
                    <span className="status-dot" aria-hidden="true" />
                    {g.label} <span className="subtle">{list.length}</span>
                  </h3>
                  {list.length > 0 ? (
                    <ul className="board-list">
                      {list.map((r) => (
                        <RunTile key={r.id} run={r} onOpen={() => onOpen(r)} />
                      ))}
                    </ul>
                  ) : (
                    <p className="board-empty">None</p>
                  )}
                </section>
              );
            })}
          </div>
          {closed > 0 && <p className="subtle board-foot">{closed} failed or cancelled {closed === 1 ? 'run is' : 'runs are'} in the list view.</p>}
        </>
      )}
      {runs.length > 0 && view === 'list' && (
        <div className="table-scroll">
          <table className="table" aria-label="All workflow runs">
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Project</th>
                <th scope="col">Workflow</th>
                <th scope="col">State</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>
                    <button type="button" className="link-btn" onClick={() => onOpen(r)}>
                      {r.title}
                    </button>
                  </td>
                  <td>{r.projectName}</td>
                  <td>{WORKFLOW_LABEL[r.workflow] ?? r.workflow}</td>
                  <td>
                    <StateBadge state={r.state} />
                  </td>
                  <td className="subtle">{formatTime(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AgentCard({ agent, onGo }: { agent: AgentStatus | null; onGo: (s: Section) => void }) {
  const mode = agent?.mode;
  return (
    <section className="card card-glass" aria-labelledby="agent-title">
      <div className="card-head">
        <h2 className="card-title" id="agent-title">
          Agent
        </h2>
        {agent && <Badge tone={mode === 'claude' ? 'ok' : mode === 'needs_key' ? 'warn' : 'neutral'}>{mode === 'claude' ? 'Claude' : mode === 'needs_key' ? 'Needs API key' : 'Simulated'}</Badge>}
      </div>
      {!agent && <p className="muted">Agent status could not be read.</p>}
      {agent && (
        <>
          <p className="muted">
            {mode === 'claude'
              ? `Real calls to ${agent.model} are on.`
              : mode === 'needs_key'
                ? 'A budget is set, but no API key is stored, so the simulated model runs.'
                : 'No real model calls: the simulated model runs and nothing is billed.'}
          </p>
          {agent.budgetUsd !== null && (
            <p className="subtle">
              ${agent.spentUsd.toFixed(2)} of ${agent.budgetUsd} used this month
            </p>
          )}
          <p className="subtle">The agent works inside a running workflow run. Open a run to give it a goal.</p>
          <div className="btn-row">
            <button type="button" className="btn btn-sm" onClick={() => onGo('settings')}>
              AI settings
            </button>
          </div>
        </>
      )}
    </section>
  );
}

const ITERATIVE_CHECKS = ['Tool conflicts', 'Workflow failures', 'Slow or costly steps'];

function IterativeCard({ onGo }: { onGo: (s: Section) => void }) {
  return (
    <section className="card card-glass" aria-labelledby="iter-title">
      <div className="card-head">
        <h2 className="card-title" id="iter-title">
          Iterative Layer
        </h2>
        <Badge tone="neutral">Planned</Badge>
      </div>
      <p className="muted">Will observe how the platform works and propose improvements for your approval. Nothing has been analysed yet.</p>
      <ul className="check-list" aria-label="Iterative checks">
        {ITERATIVE_CHECKS.map((c) => (
          <li key={c}>
            <span className="check-ring" aria-hidden="true" />
            <span>{c}</span>
            <span className="subtle">Not checked</span>
          </li>
        ))}
      </ul>
      <button type="button" className="link-btn" onClick={() => onGo('iterative')}>
        What is planned
      </button>
    </section>
  );
}

function RecentActivity({ onGo }: { onGo: (s: Section) => void }) {
  const events = useAsync(() => call(iap().listEvents({ limit: 6 })), []);
  return (
    <section className="card card-glass" aria-labelledby="recent-activity-title">
      <div className="card-head">
        <h2 className="card-title" id="recent-activity-title">
          Recent activity
        </h2>
        <button type="button" className="link-btn" onClick={() => onGo('activity')}>
          View all
        </button>
      </div>
      {events.error && <Alert tone="danger">{events.error}</Alert>}
      {events.data && events.data.length === 0 && <p className="muted">Nothing has happened yet.</p>}
      {events.data && events.data.length > 0 && (
        <ul className="feed">
          {[...events.data].reverse().map((e) => (
            <li key={e.seq}>
              <span className="feed-text">{describe(e.type, e.payload)}</span>
              <time className="subtle" dateTime={e.at} title={formatTime(e.at)}>
                {relativeTime(e.at)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function HomeView({
  projects,
  projectsError,
  runs,
  toolScan,
  agent,
  onCreate,
  onOpen,
  onGo,
}: {
  projects: Project[] | null;
  projectsError: string | null;
  runs: Record<string, RunWithNext[]> | null;
  toolScan: ToolScan | null | undefined;
  agent: AgentStatus | null;
  onCreate: () => void;
  onOpen: (id: string, name: string) => void;
  onGo: (s: Section) => void;
}) {
  const names = new Map(projects?.map((p) => [p.id, p.name]) ?? []);
  const allRuns: Run[] = runs
    ? Object.entries(runs)
        .flatMap(([pid, list]) => list.map((r) => ({ ...r, projectName: names.get(pid) ?? 'Project' })))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    : [];
  const open = allRuns.filter((r) => !['completed', 'failed', 'cancelled'].includes(r.state));
  const waiting = open.filter((r) => needsPerson(r.state)).length;
  const working = open.filter((r) => r.state === 'running' || r.state === 'verification').length;
  const recent = [...(projects ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4);
  const findings = toolScan?.findings.length ?? 0;

  const summary = !projects
    ? 'Loading your workspace…'
    : projects.length === 0
      ? 'Start with an idea. Each project gets its own workspace, plan and build history.'
      : open.length === 0
        ? 'No runs are open right now.'
        : waiting > 0
          ? `${waiting} ${waiting === 1 ? 'run is' : 'runs are'} waiting on you${working > 0 ? `, and ${working} ${working === 1 ? 'is' : 'are'} working` : ''}.`
          : working > 0
            ? `${working} ${working === 1 ? 'run is' : 'runs are'} working. Nothing is waiting on you.`
            : `${open.length} open ${open.length === 1 ? 'run is' : 'runs are'} still being planned. Nothing is waiting on you.`;

  return (
    <>
      <p className="eyebrow">Command Centre</p>
      <h1 className="page-title">Welcome back</h1>
      <p className="page-lede">{summary}</p>

      <div className="quick-actions" role="group" aria-label="Quick actions">
        <button type="button" className="btn btn-primary" onClick={onCreate}>
          <Icon name="plus" size={16} /> New project
        </button>
        <button type="button" className="btn" onClick={() => onGo('projects')}>
          <Icon name="projects" size={16} /> All projects
        </button>
        <button type="button" className="btn" onClick={() => onGo('tools')}>
          <Icon name="tools" size={16} /> Manage tools
        </button>
        <button type="button" className="btn" onClick={() => onGo('activity')}>
          <Icon name="activity" size={16} /> Activity log
        </button>
        <button type="button" className="btn" disabled title="The Iterative Layer is not built yet">
          <Icon name="iterate" size={16} /> Iterative analysis · Planned
        </button>
      </div>

      {projectsError && <Alert tone="danger" title="Could not load projects">{projectsError}</Alert>}

      <section className="metrics" aria-label="Summary">
        <Metric
          label="Projects"
          value={projects ? String(projects.length) : '–'}
          detail={projects ? `${projects.filter((p) => p.repoPath).length} with a repository` : 'Loading'}
          status="From workspace"
          tone="neutral"
        />
        <Metric
          label="Open runs"
          value={runs ? String(open.length) : '–'}
          detail={runs ? `${working} working · ${waiting} need you` : 'Loading'}
          status={waiting > 0 ? 'Needs you' : working > 0 ? 'Working' : 'Nothing waiting'}
          tone={waiting > 0 ? 'warn' : working > 0 ? 'live' : 'neutral'}
        />
        <Metric
          label="Tools found"
          value={toolScan ? String(toolScan.entries.length) : '–'}
          detail={toolScan ? `${findings} ${findings === 1 ? 'finding' : 'findings'} to review` : toolScan === null ? 'No scan yet' : 'Loading'}
          status={toolScan ? `Scanned ${relativeTime(toolScan.scannedAt)}` : 'Not checked'}
          tone={toolScan && findings > 0 ? 'warn' : 'neutral'}
        />
        <Metric
          label="AI spend this month"
          value={agent ? `$${agent.spentUsd.toFixed(2)}` : '–'}
          detail={agent?.budgetUsd != null ? `of $${agent.budgetUsd} budget` : 'No budget set'}
          status={agent?.mode === 'claude' ? 'Real calls on' : 'Simulated model'}
          tone={agent?.mode === 'claude' ? 'ok' : 'neutral'}
        />
      </section>

      <div className="content-grid">
        <div>
          <RunsBoard
            runs={allRuns}
            onOpen={(r) => onOpen(r.projectId, r.projectName)}
          />
          <section aria-labelledby="recent-title" className="section">
            <div className="section-head">
              <h2 className="section-title" id="recent-title">
                Recent projects
              </h2>
              {projects && projects.length > 0 && (
                <button type="button" className="link-btn" onClick={() => onGo('projects')}>
                  All projects
                </button>
              )}
            </div>
            {projects && projects.length === 0 && (
              <div className="card">
                <Empty title="No projects yet">Use New project above to start from an idea. You can record what is confirmed and what is still an assumption.</Empty>
              </div>
            )}
            {recent.length > 0 && (
              <ul className="card-grid" aria-label="Recent projects">
                {recent.map((p) => {
                  const list = runs?.[p.id] ?? [];
                  const need = list.filter((r) => needsPerson(r.state)).length;
                  return (
                    <li key={p.id}>
                      <button type="button" className="project-card" onClick={() => onOpen(p.id, p.name)}>
                        <span className="project-card-top">
                          <span className="icon-tile">
                            <Icon name="projects" />
                          </span>
                          {need > 0 && <Badge tone="warn">{need} need you</Badge>}
                        </span>
                        <span className="project-card-name">{p.name}</span>
                        <span className="project-card-idea">{p.idea ?? 'No idea recorded yet.'}</span>
                        <span className="project-card-foot">
                          <span className="subtle">
                            {list.length} {list.length === 1 ? 'run' : 'runs'}
                          </span>
                          <span className="subtle">Updated {relativeTime(p.updatedAt)}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
        <aside className="context-col" aria-label="Context">
          <AgentCard agent={agent} onGo={onGo} />
          <IterativeCard onGo={onGo} />
          <RecentActivity onGo={onGo} />
        </aside>
      </div>
    </>
  );
}
