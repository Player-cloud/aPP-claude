import { useCallback, useEffect, useState } from 'react';
import type { AppStatus, Settings } from '../shared/api.ts';
import { call, iap } from './api.ts';
import { Icon } from './icons.tsx';
import { ActivityView } from './views/ActivityView.tsx';
import { IterativeView } from './views/IterativeView.tsx';
import { ProjectDetail } from './views/ProjectDetail.tsx';
import { ProjectsView } from './views/ProjectsView.tsx';
import { RecoveryView } from './views/RecoveryView.tsx';
import { SettingsView } from './views/SettingsView.tsx';

export type Section = 'projects' | 'activity' | 'iterative' | 'settings';

const NAV: { id: Section; label: string; icon: 'projects' | 'activity' | 'iterate' | 'settings'; group: string; tag?: string }[] = [
  { id: 'projects', label: 'Projects', icon: 'projects', group: 'Project Layer' },
  { id: 'activity', label: 'Activity', icon: 'activity', group: 'Project Layer' },
  { id: 'iterative', label: 'Improvements', icon: 'iterate', group: 'Iterative Layer', tag: 'Planned' },
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

export function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('projects');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await call(iap().status());
      setStatus(s);
      if (s.state === 'ready') {
        const loaded = await call(iap().getSettings());
        setSettings(loaded);
      }
    } catch (e) {
      setFatal((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (!settings) return;
    applyTheme(settings.theme);
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
  };

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <nav className="rail" aria-label="Primary">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="logo" />
          </span>
          <span className="brand-name">Iterative Platform</span>
        </div>
        {['Project Layer', 'Iterative Layer'].map((group) => (
          <div key={group} role="group" aria-label={group}>
            <div className="rail-group" aria-hidden="true">
              {group}
            </div>
            {NAV.filter((n) => n.group === group).map((n) => (
              <button
                key={n.id}
                type="button"
                className="nav-item"
                aria-current={section === n.id ? 'page' : undefined}
                aria-label={n.tag ? `${n.label} (${n.tag})` : n.label}
                onClick={() => go(n.id)}
              >
                <span className="nav-icon">
                  <Icon name={n.icon} />
                </span>
                <span className="nav-label">{n.label}</span>
                {n.tag && <span className="nav-tag">{n.tag}</span>}
              </button>
            ))}
          </div>
        ))}
        <div className="rail-spacer" />
        <button
          type="button"
          className="nav-item"
          aria-current={section === 'settings' ? 'page' : undefined}
          aria-label="Settings"
          onClick={() => go('settings')}
        >
          <span className="nav-icon">
            <Icon name="settings" />
          </span>
          <span className="nav-label">Settings</span>
        </button>
      </nav>

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
          <div className="topbar-actions subtle">v{status.version}</div>
        </header>
        <main className="content" id="main" tabIndex={-1}>
          {section === 'projects' && !projectId && (
            <ProjectsView
              onOpen={(id, name) => {
                setProjectId(id);
                setProjectName(name);
              }}
            />
          )}
          {section === 'projects' && projectId && <ProjectDetail projectId={projectId} onLoaded={setProjectName} />}
          {section === 'activity' && <ActivityView />}
          {section === 'iterative' && <IterativeView />}
          {section === 'settings' && settings && (
            <SettingsView status={status} settings={settings} onSettings={setSettings} />
          )}
        </main>
      </div>
    </div>
  );
}
