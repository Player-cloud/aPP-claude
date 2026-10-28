// Small shared UI pieces built on the design tokens.
import type { ReactNode } from 'react';
import type { RunState } from '../shared/api.ts';

// live (cyan) is only for work that is really running (DEC-021).
export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'live' | 'neutral';

const STATE_TONE: Record<RunState, Tone> = {
  draft: 'neutral',
  planned: 'info',
  approved: 'info',
  running: 'live',
  verification: 'live',
  awaiting_approval: 'warn',
  completed: 'ok',
  blocked: 'danger',
  cancelled: 'neutral',
  failed: 'danger',
};

export const stateLabel = (state: string) => state.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function StateBadge({ state }: { state: RunState }) {
  return (
    <span className="badge" data-tone={STATE_TONE[state]}>
      {stateLabel(state)}
    </span>
  );
}

export function Badge({ tone = 'info', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  );
}

export function Alert({ tone = 'info', title, children }: { tone?: 'info' | 'warn' | 'danger'; title?: string; children: ReactNode }) {
  return (
    <div className="alert" data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
      <div>
        {title && (
          <p>
            <strong>{title}</strong>
          </p>
        )}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** Run states grouped the way the Command Centre board shows them. */
export const RUN_GROUPS: { id: string; label: string; states: RunState[] }[] = [
  { id: 'planning', label: 'Planning', states: ['draft', 'planned', 'approved'] },
  { id: 'running', label: 'Running', states: ['running', 'verification'] },
  { id: 'needs-you', label: 'Needs you', states: ['awaiting_approval', 'blocked'] },
  { id: 'done', label: 'Done', states: ['completed'] },
];

export const needsPerson = (state: RunState) => state === 'awaiting_approval' || state === 'blocked';

/** Position on the forward path draft → completed, or null off it (blocked, failed, cancelled). */
const FORWARD: RunState[] = ['draft', 'planned', 'approved', 'running', 'verification', 'awaiting_approval', 'completed'];
export function runStep(state: RunState, blockedFrom: RunState | null): { step: number; of: number } | null {
  const i = FORWARD.indexOf(state === 'blocked' && blockedFrom ? blockedFrom : state);
  return i < 0 ? null : { step: i + 1, of: FORWARD.length };
}

export function relativeTime(iso: string, now = Date.now()) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
