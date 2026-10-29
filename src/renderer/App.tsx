import { useCallback, useEffect, useState } from 'react';
import type { AgentStatus, AppStatus, Project, RecentBuild, Settings, ToolScan } from '../shared/api.ts';
import { call, iap } from './api.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { Icon } from './icons.tsx';
import { SidePanel } from './SidePanel.tsx';
import { ActivityView } from './views/ActivityView.tsx';
import { BuildHome } from './views/BuildView.tsx';
import { PagesView } from './views/PagesView.tsx';
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

export type Section = 'home' | 'pages' | 'projects' | 'activity' | 'studio' | 'preferences' | 'tools' | 'updates' | 'iterative' | 'platform' | 'settings';

type NavIcon = 'home' | 'pages' | 'projects' | 'activity' | 'studio' | 'bookmark' | 'tools' | 'radar' | 'iterate' | 'shield' | 'settings';

/**
 * Four places (M15): Build, Projects, Library and Settings. Less-used screens
 * sit one level down, as tabs of Library and Settings, instead of competing
 * with the work in the rail.
 */
type Group = { id: Section; label: string; icon: NavIcon; tabs?: Section[] };
const NAV: Group[] = [
  { id: 'home', label: 'Build', icon: 'home' },
  { id: 'pages', label: 'Pages', icon: 'pages' },
  { id: 'projects', label: 'Projects', icon: 'projects' },
  { id: 'studio', label: 'Library', icon: 'studio', tabs: ['studio', 'preferences'] },
];
const SETTINGS_GROUP: Group = { id: 'settings', label: 'Settings', icon: 'settings', tabs: ['settings', 'activity', 'tools', 'updates', 'iterative', 'platform'] };

const TAB_LABEL: Partial<Record<Section, string>> = { settings: 'General', preferences: 'Preferences and lessons' };

const groupOf = (s: Section): Group => [...NAV, SETTINGS_GROUP].find((g) => g.id === s || g.tabs?.includes(s))!;

export const SECTION_LABEL: Record<Section, string> = {
  home: 'Build',
  pages: 'Pages',
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

function resolveTheme(theme: Settings['theme']): 'light' | 'dark' {
  return theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
}
function applyTheme(theme: Settings['theme']) {
  document.documentElement.dataset.theme = resolveTheme(theme);
}

// Project tiles in the rail (M18, DEC-036): a letter on a colour that stays with the project.
const TILE_COLOURS = [
  ['#5d8bff', '#7a5cff'],
  ['#ffb36b', '#ef5f7d'],
  ['#3fd1b5', '#2b8fd6'],
  ['#f7c948', '#f08a3c'],
  ['#8ee07a', '#2fa46b'],
  ['#d38cff', '#6f5cff'],
];
function tileColour(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [a, b] = TILE_COLOURS[h % TILE_COLOURS.length]!;
  return `linear-gradient(140deg, ${a}, ${b})`;
}

/** What the agent is doing, in one line for the status pill: the running task first, then work waiting for the person. */
function agentLine(builds: RecentBuild[], agent: AgentStatus | null): { lead: string; rest: string; build: RecentBuild | null; tone: 'live' | 'warn' | 'idle' } {
  const running = builds.filter((b) => b.running);
  if (running[0]) return { lead: 'Claude is working', rest: `on “${running[0].title}”${running.length > 1 ? ` and ${running.length - 1} more` : ''}`, build: running[0], tone: 'live' };
  const waiting = builds.filter((b) => b.status === 'review');
  if (waiting[0]) return { lead: `${waiting.length} ready for you`, rest: `“${waiting[0].title}”`, build: waiting[0], tone: 'warn' };
  return { lead: 'Nothing running', rest: agent?.mode === 'needs_key' ? 'add an API key in Settings to use Claude' : 'ask for a change below', build: null, tone: 'idle' };
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

function RailButton({ label, tip, icon, current, onClick }: { label: string; tip?: string; icon: NavIcon | 'search' | 'sun' | 'moon'; current: boolean; onClick: () => void }) {
  return (
    <button type="button" className="rail-item" aria-current={current ? 'page' : undefined} aria-label={label} onClick={onClick}>
      <Icon name={icon} size={20} />
      <span className="rail-tip" aria-hidden="true">
        {tip ?? label}
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
  const [pagesBuild, setPagesBuild] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Every task's state, for the status pill and the project tiles; refreshed often while anything runs.
  const [work, setWork] = useState<RecentBuild[]>([]);
  useEffect(() => {
    let live = true;
    const load = () =>
      call(iap().recentBuilds())
        .then((b) => live && setWork(b))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, work.some((b) => b.running) ? 1_500 : 5_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [section, projectId, openBuild, work.some((b) => b.running)]);

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
    <div className={section === 'home' || section === 'pages' ? 'shell no-side' : 'shell'}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <nav className="rail" aria-label="Primary">
        <div className="brand-mark" title="Iterative Platform">
          <Icon name="logo" />
        </div>
        <div className="rail-seg" role="group" aria-label="Places">
          {NAV.map((n) => (
            <RailButton key={n.id} label={n.label} icon={n.icon} current={group.id === n.id} onClick={() => go(n.id)} />
          ))}
        </div>
        <RailButton label="Search" tip="Search  Ctrl K" icon="search" current={false} onClick={() => setPaletteOpen(true)} />
        {(projects?.length ?? 0) > 0 && <hr className="rail-rule" />}
        {(projects ?? [])
          .filter((p) => p.kind !== 'maintenance')
          .slice(0, 5)
          .map((p) => {
            const mine = work.filter((b) => b.projectId === p.id);
            const state = mine.some((b) => b.running) ? 'live' : mine.some((b) => b.status === 'review') ? 'warn' : null;
            return (
              <button
                key={p.id}
                type="button"
                className="rail-project"
                style={{ background: tileColour(p.id) }}
                aria-current={projectId === p.id ? 'page' : undefined}
                aria-label={`Project ${p.name}${state === 'live' ? ', working' : state === 'warn' ? ', waiting for you' : ''}`}
                onClick={() => openProject(p.id, p.name)}
              >
                <span aria-hidden="true">{p.name.trim().charAt(0).toUpperCase() || '?'}</span>
                {state && <span className="rail-project-dot" data-tone={state} aria-hidden="true" />}
                <span className="rail-tip" aria-hidden="true">
                  {p.name}
                </span>
              </button>
            );
          })}
        <button type="button" className="rail-project rail-project-add" aria-label="Add a project" onClick={() => startCreating()}>
          <Icon name="plus" size={16} />
          <span className="rail-tip" aria-hidden="true">
            New or imported project
          </span>
        </button>
        <div className="rail-spacer" />
        {settings && (
          <RailButton
            label={resolveTheme(settings.theme) === 'dark' ? 'Switch to the day sky' : 'Switch to the night sky'}
            tip="Day / night"
            icon={resolveTheme(settings.theme) === 'dark' ? 'sun' : 'moon'}
            current={false}
            onClick={() =>
              void call(iap().updateSetting({ key: 'theme', value: resolveTheme(settings.theme) === 'dark' ? 'light' : 'dark' }))
                .then(setSettings)
                .catch(() => undefined)
            }
          />
        )}
        <RailButton label={SETTINGS_GROUP.label} icon={SETTINGS_GROUP.icon} current={group.id === 'settings'} onClick={() => go('settings')} />
      </nav>

      {section !== 'home' && section !== 'pages' && (
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
          {(() => {
            const line = agentLine(work, agent);
            return (
              <div className="agent-pill" role="status" data-tone={line.tone}>
                <span className="orb" data-busy={line.tone === 'live'} aria-hidden="true" />
                <span className="agent-pill-text">
                  <b>{line.lead}</b> {line.rest}
                </span>
                {line.build && line.build.id !== openBuild && (
                  <button
                    type="button"
                    className="agent-pill-open"
                    onClick={() => {
                      go('home');
                      setOpenBuild(line.build!.id);
                    }}
                  >
                    Open
                  </button>
                )}
                <button type="button" className="agent-pill-key" onClick={() => setPaletteOpen(true)} aria-label="Search (Ctrl K)" aria-keyshortcuts="Control+K">
                  <kbd>Ctrl K</kbd>
                </button>
              </div>
            );
          })()}
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
          {section === 'home' && (
            <BuildHome
              projects={projects}
              agent={agent}
              onProjectsChanged={() => void loadProjects()}
              openBuild={openBuild}
              onOpenBuild={setOpenBuild}
              onPages={(id) => {
                go('pages');
                setPagesBuild(id);
              }}
            />
          )}
          {section === 'pages' && (
            <PagesView
              buildId={pagesBuild}
              onBuild={setPagesBuild}
              onOpenTask={(id) => {
                go('home');
                setOpenBuild(id);
              }}
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
