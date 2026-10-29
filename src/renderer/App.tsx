import { useCallback, useEffect, useState } from 'react';
import type { AgentStatus, AppStatus, Project, Settings, ToolScan } from '../shared/api.ts';
import { call, iap } from './api.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { Icon } from './icons.tsx';
import { SidePanel } from './SidePanel.tsx';
import { ActivityView } from './views/ActivityView.tsx';
import { BuildHome } from './views/BuildView.tsx';
import { IterativeView, type ImprovementFilter } from './views/IterativeView.tsx';
import { LearningStudioView, type StudioFilter } from './views/LearningStudioView.tsx';
import { ProjectDetail } from './views/ProjectDetail.tsx';
import { PlatformView } from './views/PlatformView.tsx';
import { PreferencesView, type PreferencesTab } from './views/PreferencesView.tsx';
import { ProjectsView } from './views/ProjectsView.tsx';
import { RecoveryView } from './views/RecoveryView.tsx';
import { SettingsView } from './views/SettingsView.tsx';
import { ToolsView, type ToolFilter } from './views/ToolsView.tsx';
import { UpdatesView, type UpdateFilter } from './views/UpdatesView.tsx';

export type Section = 'home' | 'projects' | 'activity' | 'studio' | 'preferences' | 'tools' | 'updates' | 'iterative' | 'platform' | 'settings';

type NavIcon = 'home' | 'projects' | 'activity' | 'studio' | 'bookmark' | 'tools' | 'radar' | 'iterate' | 'shield' | 'settings';

/**
 * Four places (M15): Build, Projects, Library and Settings. Less-used screens
 * sit one level down, as tabs of Library and Settings, instead of competing
 * with the work in the rail.
 */
type Group = { id: Section; label: string; icon: NavIcon; tabs?: Section[] };
const NAV: Group[] = [
  { id: 'home', label: 'Build', icon: 'home' },
  { id: 'projects', label: 'Projects', icon: 'projects' },
  { id: 'studio', label: 'Library', icon: 'studio', tabs: ['studio', 'preferences'] },
];
const SETTINGS_GROUP: Group = { id: 'settings', label: 'Settings', icon: 'settings', tabs: ['settings', 'activity', 'tools', 'updates', 'iterative', 'platform'] };

const TAB_LABEL: Partial<Record<Section, string>> = { settings: 'General', preferences: 'Preferences and lessons' };

const groupOf = (s: Section): Group => [...NAV, SETTINGS_GROUP].find((g) => g.id === s || g.tabs?.includes(s))!;

export const SECTION_LABEL: Record<Section, string> = {
  home: 'Build',
  projects: 'Projects',
  activity: 'Activity',
  studio: 'Learning Studio',
  preferences: 'Preferences',
  tools: 'Tools',
  updates: 'Updates',
  iterative: 'Improvements',
  platform: 'Platform',
  settings: 'Settings',
};

function applyTheme(theme: Settings['theme']) {
  const resolved =
    theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
  document.documentElement.dataset.theme = resolved;
}

// First-run tour (M17 N, DEC-034): what each rail item is for, once, until dismissed.
const TOUR: { icon: NavIcon; name: string; text: string }[] = [
  { icon: 'home', name: 'Build', text: 'Ask Claude for a change, watch it work, then keep or undo the result.' },
  { icon: 'projects', name: 'Projects', text: 'Your projects with their plans, results and releases.' },
  { icon: 'studio', name: 'Library', text: 'Lessons, skills and preferences the app has learned with you.' },
  { icon: 'settings', name: 'Settings', text: 'Your API key, budget, theme, tools and updates.' },
];

function Tour({ onDone }: { onDone: () => void }) {
  return (
    <aside className="tour" aria-labelledby="tour-title">
      <div className="tour-head">
        <h2 id="tour-title" className="tour-title">
          Getting around
        </h2>
        <button type="button" className="btn btn-sm" onClick={onDone}>
          Got it
        </button>
      </div>
      <ul className="tour-list">
        {TOUR.map((t) => (
          <li key={t.name}>
            <span className="tour-icon" aria-hidden="true">
              <Icon name={t.icon} size={18} />
            </span>
            <span>
              <b>{t.name}</b> {t.text}
            </span>
          </li>
        ))}
        <li>
          <span className="tour-icon" aria-hidden="true">
            <Icon name="search" size={18} />
          </span>
          <span>
            <kbd>Ctrl K</kbd> finds a project or page from anywhere.
          </span>
        </li>
      </ul>
    </aside>
  );
}

function RailButton({ label, icon, current, onClick }: { label: string; icon: NavIcon; current: boolean; onClick: () => void }) {
  const name = label;
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
  const [studioFilter, setStudioFilter] = useState<StudioFilter>('all');
  const [improvementFilter, setImprovementFilter] = useState<ImprovementFilter>('all');
  const [updateFilter, setUpdateFilter] = useState<UpdateFilter>('all');
  const [prefTab, setPrefTab] = useState<PreferencesTab>('preferences');
  // The task open on the Build screen, if any.
  const [openBuild, setOpenBuild] = useState<string | null>(null);
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

  // Refreshed on every navigation, so the model and budget never lag behind a change made on another screen.
  useEffect(() => {
    call(iap().agentStatus())
      .then(setAgent)
      .catch(() => setAgent(null));
  }, [projects, section, projectId, openBuild]);

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
    if (section !== 'tools' || toolScan !== undefined) return;
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
    setStudioFilter('all');
    setOpenBuild(null);
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
  const group = groupOf(section);

  return (
    <div className={section === 'home' ? 'shell no-side' : 'shell'}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <nav className="rail" aria-label="Primary">
        <div className="brand-mark" title="Iterative Platform">
          <Icon name="logo" />
        </div>
        <div className="rail-group">
          {NAV.map((n) => (
            <RailButton key={n.id} label={n.label} icon={n.icon} current={group.id === n.id} onClick={() => go(n.id)} />
          ))}
        </div>
        <div className="rail-spacer" />
        <RailButton label={SETTINGS_GROUP.label} icon={SETTINGS_GROUP.icon} current={group.id === 'settings'} onClick={() => go('settings')} />
      </nav>

      {section !== 'home' && (
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
          toolScan={toolScan ?? null}
          toolFilter={toolFilter}
          onToolFilter={setToolFilter}
          studioFilter={studioFilter}
          onStudioFilter={setStudioFilter}
          improvementFilter={improvementFilter}
          onImprovementFilter={setImprovementFilter}
          updateFilter={updateFilter}
          onUpdateFilter={setUpdateFilter}
          prefTab={prefTab}
          onPrefTab={setPrefTab}
        />
      )}

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
            <span className="topbar-search-text">Search tasks, files and to-dos…</span>
            <kbd>Ctrl K</kbd>
          </button>
          <div className="topbar-actions">
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
          {group.tabs && (
            <nav className="section-tabs" aria-label={`${group.label} sections`}>
              {group.tabs.map((t) => (
                <button key={t} type="button" className="section-tab" aria-current={section === t ? 'page' : undefined} onClick={() => go(t)}>
                  {TAB_LABEL[t] ?? SECTION_LABEL[t]}
                </button>
              ))}
            </nav>
          )}
          {section === 'home' && !openBuild && settings?.tour === 'new' && (
            <Tour onDone={() => void call(iap().updateSetting({ key: 'tour', value: 'done' })).then(setSettings).catch(() => undefined)} />
          )}
          {section === 'home' && <BuildHome projects={projects} agent={agent} onProjectsChanged={() => void loadProjects()} openBuild={openBuild} onOpenBuild={setOpenBuild} />}
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
          {section === 'projects' && projectId && <ProjectDetail projectId={projectId} onLoaded={setProjectName} agent={agent} />}
          {section === 'activity' && (
            <ActivityView projectId={activityProject} projectName={projects?.find((p) => p.id === activityProject)?.name ?? null} />
          )}
          {section === 'studio' && <LearningStudioView projects={projects ?? []} filter={studioFilter} onFilter={setStudioFilter} />}
          {section === 'tools' && <ToolsView scan={toolScan} error={toolError} filter={toolFilter} onScan={scanTools} onRefresh={async () => setToolScan(await call(iap().getToolScan()))} />}
          {section === 'updates' && <UpdatesView filter={updateFilter} onFilter={setUpdateFilter} />}
          {section === 'iterative' && (
            <IterativeView
              filter={improvementFilter}
              onFilter={setImprovementFilter}
              onOpenPreferences={() => {
                go('preferences');
                setPrefTab('preferences');
              }}
            />
          )}
          {section === 'preferences' && <PreferencesView projects={projects ?? []} tab={prefTab} onTab={setPrefTab} />}
          {section === 'platform' && (
            <PlatformView
              onOpenProject={(id, name) => {
                void loadProjects();
                openProject(id, name);
              }}
            />
          )}
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
        project={projectId && projectName ? { id: projectId, name: projectName } : null}
        openBuild={openBuild}
        onOpenBuild={(id) => {
          go('home');
          setOpenBuild(id);
        }}
        onLessons={() => {
          go('preferences');
          setPrefTab('lessons');
        }}
      />
    </div>
  );
}
