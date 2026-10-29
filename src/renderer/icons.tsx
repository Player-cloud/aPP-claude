// Minimal inline icon set (stroke icons, 18px). Decorative: always aria-hidden.
import type { ReactElement } from 'react';

const paths: Record<string, ReactElement> = {
  projects: <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />,
  activity: <path d="M3 12h4l3 -7 4 14 3 -7h4" />,
  iterate: <path d="M20 11a8 8 0 1 0 -2.3 5.7M20 5v6h-6" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </>
  ),
  home: <path d="M4 10.5L12 4l8 6.5M6 9.5V19a1 1 0 0 0 1 1h3.5v-5h3v5H17a1 1 0 0 0 1-1V9.5" />,
  board: <path d="M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  bookmark: <path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </>
  ),
  pages: (
    <>
      <rect x="3" y="4" width="13" height="10" rx="1.5" />
      <rect x="17" y="8" width="4" height="10" rx="1" />
      <path d="M7 18h6M10 14v4" />
    </>
  ),
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  arrowUp: <path d="M5 12l7-7 7 7M12 19V5" />,
  logo: <path d="M5 5l6 7-6 7M13 5l6 7-6 7" />,
  back: <path d="M15 5l-7 7 7 7" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" />
    </>
  ),
  arrow: <path d="M8 16L16 8M9 8h7v7" />,
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14" rx="3" />
      <path d="M8 3.5v4M16 3.5v4M4 10.5h16" />
    </>
  ),
  list: <path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01" />,
  sparkle: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />,
  send: <path d="M5 12h13M13 6l6 6-6 6" />,
  tools: <path d="M14.5 6.5a4 4 0 0 0-5.3 5.3L4 17l3 3 5.2-5.2a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.4-.6-.6-2.4z" />,
  radar: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <path d="M12 12l5.5-5.5" />
    </>
  ),
  palette: (
    <>
      <path d="M12 4a8 8 0 1 0 0 16c1.1 0 1.6-.8 1.6-1.6 0-1.3-1-1.6-1-2.6 0-.9.7-1.6 1.6-1.6H17a3 3 0 0 0 3-3C20 7.4 16.4 4 12 4z" />
      <circle cx="8" cy="11" r=".6" />
      <circle cx="11" cy="7.8" r=".6" />
      <circle cx="15" cy="8.4" r=".6" />
    </>
  ),
  studio: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <circle cx="9" cy="9.5" r="1.6" />
      <path d="M4 17l5-4.5 3.5 3 3-2.5 4.5 4" />
    </>
  ),
  shield: <path d="M12 3.5l7 2.6v5.4c0 4.4-3 7.7-7 9-4-1.3-7-4.6-7-9V6.1zM9 12l2 2 4-4" />,
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  archive: <path d="M4 5h16v4H4zM5.5 9v9.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9M10 13h4" />,
  database: (
    <>
      <ellipse cx="12" cy="6.5" rx="7" ry="2.8" />
      <path d="M5 6.5v11c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-11M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8" />
    </>
  ),
};

export function Icon({ name, size = 18 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}
