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
  plus: <path d="M12 5v14M5 12h14" />,
  logo: <path d="M5 5l6 7-6 7M13 5l6 7-6 7" />,
  back: <path d="M15 5l-7 7 7 7" />,
};

export function Icon({ name, size = 18 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}
