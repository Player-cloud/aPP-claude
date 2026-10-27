// The context panel between the rail and the work surface. Its contents follow
// the current section: the project explorer, the planned Iterative Layer
// modules, or the settings groups. Hidden below 1060px (M2-AC9).
import { useState } from 'react';
import type { Project, ToolKind, ToolScan } from '../shared/api.ts';
import type { Section } from './App.tsx';
import { Icon } from './icons.tsx';
import { KIND_LABEL, type ToolFilter } from './views/ToolsView.tsx';

const PLANNED = [
  { icon: 'iterate', label: 'Improvement backlog', hint: 'Proposals from workflow telemetry' },
  { icon: 'radar', label: 'Ecosystem monitor', hint: 'Updates to Claude, plugins and MCP servers' },
  { icon: 'tools', label: 'Safe cleanup', hint: 'Approved disable or uninstall of a conflicting tool' },
] as const;

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
      <p className="side-note">Read-only. The app never changes or removes these tools.</p>
    </nav>
  );
}

const SETTINGS_GROUPS = [
  { icon: 'palette', label: 'Appearance', target: 'appearance-title' },
  { icon: 'database', label: 'Data', target: 'data-title' },
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
}: {
  section: Section;
  projects: Project[] | null;
  selected: string | null;
  onSelect: (p: Project | null) => void;
  onCreate: () => void;
  toolScan: ToolScan | null;
  toolFilter: ToolFilter;
  onToolFilter: (f: ToolFilter) => void;
}) {
  const title = { projects: 'Projects', activity: 'Activity', tools: 'Tools', iterative: 'Improvements', settings: 'Settings' }[section];
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
      {section === 'tools' && <ToolFilters scan={toolScan} filter={toolFilter} onFilter={onToolFilter} />}
      {section === 'iterative' && (
        <ul className="side-list" aria-label="Planned modules">
          {PLANNED.map((m) => (
            <li key={m.label} className="side-row">
              <span className="side-icon">
                <Icon name={m.icon} size={16} />
              </span>
              <span className="side-row-text">
                <span>{m.label}</span>
                <span className="side-row-hint">{m.hint}</span>
              </span>
            </li>
          ))}
          <li className="side-note">Planned. Nothing here runs yet.</li>
        </ul>
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
