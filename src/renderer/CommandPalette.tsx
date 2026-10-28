// Search and go (Ctrl K). Lists destinations, projects and the safe "New
// project" action only: nothing that changes or deletes work runs from here.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Project } from '../shared/api.ts';
import { SECTION_LABEL, type Section } from './App.tsx';
import { Icon } from './icons.tsx';

type Item = { id: string; label: string; hint: string; icon: 'home' | 'projects' | 'activity' | 'studio' | 'tools' | 'iterate' | 'settings' | 'plus'; run: () => void };

const DESTINATIONS: { id: Section; icon: Item['icon'] }[] = [
  { id: 'home', icon: 'home' },
  { id: 'projects', icon: 'projects' },
  { id: 'activity', icon: 'activity' },
  { id: 'studio', icon: 'studio' },
  { id: 'tools', icon: 'tools' },
  { id: 'iterative', icon: 'iterate' },
  { id: 'settings', icon: 'settings' },
];

export function CommandPalette({
  open,
  projects,
  onClose,
  onGo,
  onOpen,
  onCreate,
}: {
  open: boolean;
  projects: Project[];
  onClose: () => void;
  onGo: (s: Section) => void;
  onOpen: (id: string, name: string) => void;
  onCreate: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery('');
      setActive(0);
      d.showModal(); // focus moves into the dialog and returns to the opener on close
    } else if (!open && d.open) d.close();
  }, [open]);

  const items = useMemo(() => {
    const all: Item[] = [
      { id: 'new', label: 'New project', hint: 'Action', icon: 'plus', run: onCreate },
      ...DESTINATIONS.map((d) => ({ id: d.id, label: SECTION_LABEL[d.id], hint: 'Go to', icon: d.icon, run: () => onGo(d.id) })),
      ...projects.map((p) => ({ id: p.id, label: p.name, hint: 'Project', icon: 'projects' as const, run: () => onOpen(p.id, p.name) })),
    ];
    const q = query.trim().toLowerCase();
    return q ? all.filter((i) => i.label.toLowerCase().includes(q)) : all;
  }, [query, projects, onCreate, onGo, onOpen]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(items[active]);
    }
  };

  return (
    <dialog ref={dialog} className="palette" aria-label="Search and go" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <div className="palette-box">
        <label className="palette-search">
          <Icon name="search" size={18} />
          <input
            className="palette-input"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[active] ? `palette-${items[active].id}` : undefined}
            aria-label="Search projects or go to"
            placeholder="Search projects or go to…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            autoFocus
          />
          <kbd>Esc</kbd>
        </label>
        <ul className="palette-list" id="palette-list" role="listbox" aria-label="Results">
          {items.map((item, i) => (
            <li
              key={item.id}
              id={`palette-${item.id}`}
              role="option"
              aria-selected={i === active}
              className="palette-item"
              onMouseMove={() => setActive(i)}
              onClick={() => choose(item)}
            >
              <Icon name={item.icon} size={18} />
              <span className="palette-label">{item.label}</span>
              <span className="palette-hint">{item.hint}</span>
            </li>
          ))}
          {items.length === 0 && <li className="palette-empty">Nothing matches “{query.trim()}”.</li>}
        </ul>
      </div>
    </dialog>
  );
}
