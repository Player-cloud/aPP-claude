// The context panel between the rail and the work surface. Its contents follow
// the current section: the project explorer, the tool, update and improvement
// filters, or the settings groups. Hidden below 1060px (M2-AC9).
import { useState } from 'react';
import type { Project, ToolKind, ToolScan } from '../shared/api.ts';
import type { Section } from './App.tsx';
import { Icon } from './icons.tsx';
import { KIND_LABEL as REF_KIND_LABEL, type StudioFilter } from './views/LearningStudioView.tsx';
import { KIND_LABEL, type ToolFilter } from './views/ToolsView.tsx';
import { STATUS_LABEL, type ImprovementFilter } from './views/IterativeView.tsx';
import { STAGE_LABEL, type UpdateFilter } from './views/UpdatesView.tsx';
import type { PreferencesTab } from './views/PreferencesView.tsx';

const KIND_ORDER: ToolKind[] = ['plugin', 'skill', 'command', 'agent', 'hook', 'mcp_server', 'marketplace'];

function ToolFilters({ scan, filter, onFilter }: { scan: ToolScan | null; filter: ToolFilter; onFilter: (f: ToolFilter) => void }) {
  const item = (id: ToolFilter, label: string, count: number | null, icon: 'tools' | 'radar' | null = null) => (
    <li key={id}>
      <button type="button" className={icon ? 'tree-root' : 'tree-item'} aria-current={filter === id ? 'page' : undefined} onClick={() => onFilter(id)}>
        {icon && <Icon name={icon} size={18} />}
        <span className="tree-label">{label}</span>
        {count !== null && <span className="count-pill">{count}</span>}
      </button>
    </li>
  );
  return (
    <nav aria-label="Tool filters" className="tree">
      <ul className="side-list">
        {item('all', 'Everything', scan ? scan.entries.length : null, 'tools')}
        {item('findings', 'Findings', scan ? scan.findings.length : null, 'radar')}
      </ul>
      <ul className="tree-children">{KIND_ORDER.map((k) => item(k, KIND_LABEL[k], scan ? scan.summary.entries[k] ?? 0 : null))}</ul>
      <p className="side-note">Scanning is read-only. Nothing changes until you approve the exact change.</p>
    </nav>
  );
}

function StudioFilters({ filter, onFilter }: { filter: StudioFilter; onFilter: (f: StudioFilter) => void }) {
  return (
    <nav aria-label="Reference filters" className="tree">
      <button type="button" className="tree-root" aria-current={filter === 'all' ? 'page' : undefined} onClick={() => onFilter('all')}>
        <Icon name="studio" size={18} />
        <span className="tree-label">All references</span>
      </button>
      <ul className="tree-children">
        {Object.entries(REF_KIND_LABEL).map(([id, label]) => (
          <li key={id}>
            <button type="button" className="tree-item" aria-current={filter === id ? 'page' : undefined} onClick={() => onFilter(id)}>
              <span className="tree-label">{label}</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="tree-root" aria-current={filter === 'archived' ? 'page' : undefined} onClick={() => onFilter('archived')}>
        <Icon name="archive" size={18} />
        <span className="tree-label">Archived</span>
      </button>
      <p className="side-note">A reference never changes a project's specification.</p>
    </nav>
  );
}

function ImprovementFilters({ filter, onFilter }: { filter: ImprovementFilter; onFilter: (f: ImprovementFilter) => void }) {
  return (
    <>
      <nav aria-label="Improvement filters" className="tree">
        <button type="button" className="tree-root" aria-current={filter === 'all' ? 'page' : undefined} onClick={() => onFilter('all')}>
          <Icon name="iterate" size={18} />
          <span className="tree-label">Backlog</span>
        </button>
        <ul className="tree-children">
          {(Object.entries(STATUS_LABEL) as [ImprovementFilter, string][]).map(([id, label]) => (
            <li key={id}>
              <button type="button" className="tree-item" aria-current={filter === id ? 'page' : undefined} onClick={() => onFilter(id)}>
                <span className="tree-label">{label}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="side-note">Only you approve. Approving changes nothing in the app.</p>
      </nav>
    </>
  );
}

function UpdateFilters({ filter, onFilter }: { filter: UpdateFilter; onFilter: (f: UpdateFilter) => void }) {
  return (
    <nav aria-label="Update filters" className="tree">
      <button type="button" className="tree-root" aria-current={filter === 'all' ? 'page' : undefined} onClick={() => onFilter('all')}>
        <Icon name="radar" size={18} />
        <span className="tree-label">All open and recent</span>
      </button>
      <ul className="tree-children">
        {(Object.entries(STAGE_LABEL) as [UpdateFilter, string][]).map(([id, label]) => (
          <li key={id}>
            <button type="button" className="tree-item" aria-current={filter === id ? 'page' : undefined} onClick={() => onFilter(id)}>
              <span className="tree-label">{label}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="side-note">Checking only reads trusted sources. The app never installs an update.</p>
    </nav>
  );
}

const SETTINGS_GROUPS = [
  { icon: 'palette', label: 'Appearance', target: 'appearance-title' },
  { icon: 'sparkle', label: 'AI usage', target: 'ai-title' },
  { icon: 'database', label: 'Data', target: 'data-title' },
] as const;

const PREFERENCE_TABS = [
  { icon: 'bookmark', label: 'Preferences', tab: 'preferences' },
  { icon: 'list', label: 'Wrap-up', tab: 'wrapup' },
  { icon: 'archive', label: 'Vault', tab: 'vault' },
] as const;

const PLATFORM_GROUPS = [
  { icon: 'board', label: 'Platform work', target: 'plat-work' },
  { icon: 'archive', label: 'Backups and recovery', target: 'plat-recovery' },
  { icon: 'shield', label: 'Rules', target: 'plat-rules' },
] as const;

function ProjectTree({
  section,
  projects,
  selected,
  onSelect,
}: {
  section: Section;
  projects: Project[] | null;
  selected: string | null;
  onSelect: (p: Project | null) => void;
}) {
  const [filter, setFilter] = useState('');
  const shown = projects?.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase())) ?? [];
  return (
    <>
      <label className="side-search">
        <Icon name="search" size={16} />
        <input className="side-search-input" type="search" placeholder="Search projects" aria-label="Search projects" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </label>
      <nav aria-label="Projects" className="tree">
        <button type="button" className="tree-root" aria-current={selected === null ? 'page' : undefined} onClick={() => onSelect(null)}>
          <Icon name={section === 'activity' ? 'activity' : 'projects'} size={18} />
          <span className="tree-label">{section === 'activity' ? 'All activity' : 'All projects'}</span>
          {section === 'projects' && projects && <span className="count-pill">{projects.length}</span>}
        </button>
        {shown.length > 0 && (
          <ul className="tree-children">
            {shown.map((p) => (
              <li key={p.id}>
                <button type="button" className="tree-item" aria-current={selected === p.id ? 'page' : undefined} onClick={() => onSelect(p)}>
                  <span className="tree-label">{p.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {projects && projects.length > 0 && shown.length === 0 && <p className="side-note">No projects match “{filter.trim()}”.</p>}
        {projects && projects.length === 0 && <p className="side-note">Projects you create appear here.</p>}
      </nav>
    </>
  );
}

export function SidePanel({
  section,
  projects,
  selected,
  onSelect,
  onCreate,
  toolScan,
  toolFilter,
  onToolFilter,
  studioFilter,
  onStudioFilter,
  improvementFilter,
  onImprovementFilter,
  updateFilter,
  onUpdateFilter,
  prefTab,
  onPrefTab,
}: {
  section: Section;
  projects: Project[] | null;
  selected: string | null;
  onSelect: (p: Project | null) => void;
  onCreate: () => void;
  toolScan: ToolScan | null;
  toolFilter: ToolFilter;
  onToolFilter: (f: ToolFilter) => void;
  studioFilter: StudioFilter;
  onStudioFilter: (f: StudioFilter) => void;
  improvementFilter: ImprovementFilter;
  onImprovementFilter: (f: ImprovementFilter) => void;
  updateFilter: UpdateFilter;
  onUpdateFilter: (f: UpdateFilter) => void;
  prefTab: PreferencesTab;
  onPrefTab: (t: PreferencesTab) => void;
}) {
  const title = { home: 'Projects', projects: 'Projects', activity: 'Activity', studio: 'Learning Studio', preferences: 'Preferences', tools: 'Tools', updates: 'Updates', iterative: 'Improvements', platform: 'Platform', settings: 'Settings' }[section];
  return (
    <aside className="side" aria-label={`${title} panel`}>
      <div className="side-head">
        <h2 className="side-title">{title}</h2>
        {section === 'projects' && (
          <button type="button" className="icon-btn" aria-label="Create a project" title="Create a project" onClick={onCreate}>
            <Icon name="plus" size={16} />
          </button>
        )}
      </div>
      {(section === 'projects' || section === 'activity') && <ProjectTree section={section} projects={projects} selected={selected} onSelect={onSelect} />}
      {section === 'studio' && <StudioFilters filter={studioFilter} onFilter={onStudioFilter} />}
      {section === 'tools' && <ToolFilters scan={toolScan} filter={toolFilter} onFilter={onToolFilter} />}
      {section === 'updates' && <UpdateFilters filter={updateFilter} onFilter={onUpdateFilter} />}
      {section === 'iterative' && <ImprovementFilters filter={improvementFilter} onFilter={onImprovementFilter} />}
      {section === 'preferences' && (
        <nav aria-label="Preference pages" className="tree">
          {PREFERENCE_TABS.map((g) => (
            <button key={g.tab} type="button" className="tree-root" aria-current={prefTab === g.tab ? 'page' : undefined} onClick={() => onPrefTab(g.tab)}>
              <Icon name={g.icon} size={18} />
              <span className="tree-label">{g.label}</span>
            </button>
          ))}
          <p className="side-note">Nothing is used until you approve it, and nothing is deleted.</p>
        </nav>
      )}
      {section === 'platform' && (
        <nav aria-label="Platform groups" className="tree">
          {PLATFORM_GROUPS.map((g) => (
            <button key={g.target} type="button" className="tree-root" onClick={() => document.getElementById(g.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
              <Icon name={g.icon} size={18} />
              <span className="tree-label">{g.label}</span>
            </button>
          ))}
        </nav>
      )}
      {section === 'settings' && (
        <nav aria-label="Settings groups" className="tree">
          {SETTINGS_GROUPS.map((g) => (
            <button key={g.target} type="button" className="tree-root" onClick={() => document.getElementById(g.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
              <Icon name={g.icon} size={18} />
              <span className="tree-label">{g.label}</span>
            </button>
          ))}
        </nav>
      )}
    </aside>
  );
}
