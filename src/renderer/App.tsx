import { useCallback, useEffect, useState } from 'react';
import type { AppStatus, Project, Settings } from '../shared/api.ts';
import { call, iap } from './api.ts';
import { Icon } from './icons.tsx';
import { SidePanel } from './SidePanel.tsx';
import { ActivityView } from './views/ActivityView.tsx';
import { IterativeView } from './views/IterativeView.tsx';
import { ProjectDetail } from './views/ProjectDetail.tsx';
import { ProjectsView } from './views/ProjectsView.tsx';
import { RecoveryView } from './views/RecoveryView.tsx';
import { SettingsView } from './views/SettingsView.tsx';

export type Section = 'projects' | 'activity' | 'iterative' | 'settings';

type NavIcon = 'projects' | 'activity' | 'iterate' | 'settings';

// Groups are separated by a divider in the rail: Project Layer, then Iterative Layer.
const NAV: { id: Section; label: string; icon: NavIcon; tag?: string }[][] = [
  [
    { id: 'projects', label: 'Projects', icon: 'projects' },
    { id: 'activity', label: 'Activity', icon: 'activity' },
  ],
  [{ id: 'iterative', label: 'Improvements', icon: 'iterate', tag: 'Planned' }],
];

const SECTION_LABEL: Record<Section, string> = {
  projects: 'Projects',
  activity: 'Activity',
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
  const [section, setSection] = useState<Section>('projects');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ idea: string } | null>(null);
  const [activityProject, setActivityProject] = useState<string | null>(null);

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
        section={section}
        projects={projects}
        selected={section === 'activity' ? activityProject : projectId}
        onSelect={(p) => {
          if (section === 'activity') setActivityProject(p?.id ?? null);
          else if (p) openProject(p.id, p.name);
          else go('projects');
        }}
        onCreate={() => startCreating()}
      />

      <div className="main">
        <header className="topbar">
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
          <div className="topbar-actions">
            <span className="pill">Iterative Platform v{status.version}</span>
          </div>
        </header>
        <main className="content" id="main" tabIndex={-1}>
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
          {section === 'iterative' && <IterativeView />}
          {section === 'settings' && settings && <SettingsView status={status} settings={settings} onSettings={setSettings} />}
        </main>
      </div>
    </div>
  );
}
