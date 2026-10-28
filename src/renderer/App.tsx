import { useCallback, useEffect, useState } from 'react';
import type { AgentStatus, AppStatus, Project, RunWithNext, Settings, ToolScan } from '../shared/api.ts';
import { call, iap } from './api.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { Icon } from './icons.tsx';
import { SidePanel } from './SidePanel.tsx';
import { needsPerson } from './ui.tsx';
import { ActivityView } from './views/ActivityView.tsx';
import { HomeView } from './views/HomeView.tsx';
import { IterativeView } from './views/IterativeView.tsx';
import { ProjectDetail } from './views/ProjectDetail.tsx';
import { ProjectsView } from './views/ProjectsView.tsx';
import { RecoveryView } from './views/RecoveryView.tsx';
import { SettingsView } from './views/SettingsView.tsx';
import { ToolsView, type ToolFilter } from './views/ToolsView.tsx';

export type Section = 'home' | 'projects' | 'activity' | 'tools' | 'iterative' | 'settings';

type NavIcon = 'home' | 'projects' | 'activity' | 'tools' | 'iterate' | 'settings';

// Groups are separated by a divider in the rail: Project Layer, then Iterative Layer.
const NAV: { id: Section; label: string; icon: NavIcon; tag?: string }[][] = [
  [
    { id: 'home', label: 'Home', icon: 'home' },
    { id: 'projects', label: 'Projects', icon: 'projects' },
    { id: 'activity', label: 'Activity', icon: 'activity' },
  ],
  [
    { id: 'tools', label: 'Tools', icon: 'tools' },
    { id: 'iterative', label: 'Improvements', icon: 'iterate', tag: 'Planned' },
  ],
];

export const SECTION_LABEL: Record<Section, string> = {
  home: 'Home',
  projects: 'Projects',
  activity: 'Activity',
  tools: 'Tools',
  iterative: 'Improvements',
  settings: 'Settings',
};

function applyTheme(theme: Settings['theme']) {
  const resolved =
    theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
  document.documentElement.dataset.theme = resolved;
}

function RailButton({ label, icon, tag, current, onClick }: { label: string; icon: NavIcon; tag?: string; current: boolean; onClick: () => void }) {
  const name = tag ? `${label} (${tag})` : label;
  return (
    <button type="button" className="rail-item" aria-current={current ? 'page' : undefined} aria-label={name} onClick={onClick}>
      <Icon name={icon} size={20} />
      <span className="rail-tip" aria-hidden="true">
        {name}
      </span>
    </button>
  );
}

export function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('home');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ idea: string } | null>(null);
  const [activityProject, setActivityProject] = useState<string | null>(null);
  // undefined = not loaded yet, null = never scanned.
  const [toolScan, setToolScan] = useState<ToolScan | null | undefined>(undefined);
  const [toolError, setToolError] = useState<string | null>(null);
  const [toolFilter, setToolFilter] = useState<ToolFilter>('all');
  // Runs of every project, for the top bar's run status and the Command Centre.
  const [runs, setRuns] = useState<Record<string, RunWithNext[]> | null>(null);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const loadProjects = useCallback(async () => {
    try {
      setProjects(await call(iap().listProjects()));
      setProjectsError(null);
    } catch (e) {
      setProjectsError((e as Error).message);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await call(iap().status());
      setStatus(s);
      if (s.state === 'ready') {
        setSettings(await call(iap().getSettings()));
        await loadProjects();
      }
    } catch (e) {
      setFatal((e as Error).message);
    }
  }, [loadProjects]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const loadRuns = useCallback(async (list: Project[]) => {
    try {
      const all = await Promise.all(list.map(async (p) => [p.id, await call(iap().listRuns(p.id))] as const));
      setRuns(Object.fromEntries(all));
    } catch {
      setRuns(null);
    }
  }, []);

  // Refreshed on every navigation, so the run status never lags behind a change made on another screen.
  useEffect(() => {
    if (projects) void loadRuns(projects);
    call(iap().agentStatus())
      .then(setAgent)
      .catch(() => setAgent(null));
  }, [projects, section, projectId, loadRuns]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if ((section !== 'tools' && section !== 'home') || toolScan !== undefined) return;
    call(iap().getToolScan())
      .then(setToolScan)
      .catch((e: Error) => setToolError(e.message));
  }, [section, toolScan]);

  const scanTools = useCallback(async () => {
    setToolError(null);
    try {
      setToolScan(await call(iap().scanTools()));
    } catch (e) {
      setToolError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!settings) return;
    applyTheme(settings.theme);
    document.documentElement.dataset.glass = settings.glass;
    if (settings.theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => applyTheme('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [settings]);

  if (fatal) {
    return (
      <main className="content" id="main">
        <h1 className="page-title">The app could not start</h1>
        <p className="page-lede">{fatal}</p>
      </main>
    );
  }
  if (!status) return <p className="loading">Opening workspace…</p>;
  if (status.state !== 'ready') return <RecoveryView status={status} onRecovered={refreshStatus} />;

  const go = (next: Section) => {
    setSection(next);
    setProjectId(null);
    setProjectName(null);
    setCreating(null);
    setActivityProject(null);
    setToolFilter('all');
  };
  const openProject = (id: string, name: string) => {
    setSection('projects');
    setProjectId(id);
    setProjectName(name);
    setCreating(null);
  };
  const startCreating = (idea = '') => {
    go('projects');
    setCreating({ idea });
  };
  const allRuns = runs ? Object.values(runs).flat() : [];
  const waiting = allRuns.filter((r) => needsPerson(r.state)).length;
  const working = allRuns.filter((r) => r.state === 'running' || r.state === 'verification').length;
  const sideSection: Section = section === 'home' ? 'projects' : section;

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <nav className="rail" aria-label="Primary">
        <div className="brand-mark" title="Iterative Platform">
          <Icon name="logo" />
        </div>
        {NAV.map((group, i) => (
          <div key={i} className="rail-group" role="group" aria-label={i === 0 ? 'Project Layer' : 'Iterative Layer'}>
            {group.map((n) => (
              <RailButton key={n.id} label={n.label} icon={n.icon} tag={n.tag} current={section === n.id} onClick={() => go(n.id)} />
            ))}
          </div>
        ))}
        <div className="rail-spacer" />
        <RailButton label="Settings" icon="settings" current={section === 'settings'} onClick={() => go('settings')} />
      </nav>

      <SidePanel
        section={sideSection}
        projects={projects}
        selected={section === 'activity' ? activityProject : section === 'home' ? '' : projectId}
        onSelect={(p) => {
          if (section === 'activity') setActivityProject(p?.id ?? null);
          else if (p) openProject(p.id, p.name);
          else go('projects');
        }}
        onCreate={() => startCreating()}
        toolScan={toolScan ?? null}
        toolFilter={toolFilter}
        onToolFilter={setToolFilter}
      />

      <div className="main">
        <header className="topbar glass">
          <ol className="breadcrumbs" aria-label="Breadcrumb">
            <li>
              {projectId ? (
                <button type="button" onClick={() => go(section)}>
                  {SECTION_LABEL[section]}
                </button>
              ) : (
                <span aria-current="page">{SECTION_LABEL[section]}</span>
              )}
            </li>
            {projectId && <li aria-current="page">{projectName ?? 'Project'}</li>}
          </ol>
          <button type="button" className="topbar-search" onClick={() => setPaletteOpen(true)} aria-keyshortcuts="Control+K">
            <Icon name="search" size={16} />
            <span className="topbar-search-text">Search projects or go to…</span>
            <kbd>Ctrl K</kbd>
          </button>
          <div className="topbar-actions">
            {runs && (waiting > 0 || working > 0) && (
              <button type="button" className="status-pill" data-tone={waiting > 0 ? 'warn' : 'live'} onClick={() => go('home')}>
                <span className="status-dot" aria-hidden="true" />
                {waiting > 0 ? `${waiting} ${waiting === 1 ? 'run needs' : 'runs need'} you` : `${working} ${working === 1 ? 'run' : 'runs'} working`}
              </button>
            )}
            {agent && (
              <span className="status-pill" data-tone={agent.mode === 'claude' ? 'ok' : 'neutral'} title={agent.mode === 'claude' ? agent.model : undefined}>
                <span className="status-dot" aria-hidden="true" />
                {agent.mode === 'claude' ? 'Model: Claude' : agent.mode === 'needs_key' ? 'Model: needs API key' : 'Model: simulated'}
              </span>
            )}
            <span className="pill topbar-version">v{status.version}</span>
          </div>
        </header>
        <main className="content" id="main" tabIndex={-1}>
          {section === 'home' && (
            <HomeView
              projects={projects}
              projectsError={projectsError}
              runs={runs}
              toolScan={toolScan}
              agent={agent}
              onCreate={() => startCreating()}
              onOpen={openProject}
              onGo={go}
            />
          )}
          {section === 'projects' && !projectId && (
            <ProjectsView
              projects={projects}
              error={projectsError}
              creating={creating}
              onCreate={startCreating}
              onCancelCreate={() => setCreating(null)}
              onCreated={(id, name) => {
                void loadProjects();
                openProject(id, name);
              }}
              onOpen={openProject}
            />
          )}
          {section === 'projects' && projectId && <ProjectDetail projectId={projectId} onLoaded={setProjectName} />}
          {section === 'activity' && (
            <ActivityView projectId={activityProject} projectName={projects?.find((p) => p.id === activityProject)?.name ?? null} />
          )}
          {section === 'tools' && <ToolsView scan={toolScan} error={toolError} filter={toolFilter} onScan={scanTools} />}
          {section === 'iterative' && <IterativeView />}
          {section === 'settings' && settings && <SettingsView status={status} settings={settings} onSettings={setSettings} />}
        </main>
      </div>
      <CommandPalette
        open={paletteOpen}
        projects={projects ?? []}
        onClose={() => setPaletteOpen(false)}
        onGo={go}
        onOpen={openProject}
        onCreate={() => startCreating()}
      />
    </div>
  );
}
