// Small shared UI pieces built on the design tokens.
import type { ReactNode } from 'react';
import type { RunState } from '../shared/api.ts';

type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

const STATE_TONE: Record<RunState, Tone> = {
  draft: 'neutral',
  planned: 'info',
  approved: 'info',
  running: 'info',
  verification: 'info',
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

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
