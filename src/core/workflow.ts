// Explicit workflow-run state model (SYSTEM_ARCHITECTURE.md §4).
//
// Interpretation recorded in docs/DECISIONS.md (DEC-004): the architecture lists
// `blocked` among terminal states, but FR-APP-004 requires a blocked run to
// explain how to resolve the blocker, so `blocked` is resumable to the state
// it was blocked from. `completed`, `cancelled` and `failed` are terminal.

import { InvalidTransitionError, ValidationError } from './errors.ts';

export const RUN_STATES = [
  'draft',
  'planned',
  'approved',
  'running',
  'verification',
  'awaiting_approval',
  'completed',
  'blocked',
  'cancelled',
  'failed',
] as const;

export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set(['completed', 'cancelled', 'failed']);

export const WORKFLOWS = ['plan', 'build', 'design', 'review', 'ship', 'assess', 'maintenance'] as const;
export type Workflow = (typeof WORKFLOWS)[number];

// Forward path plus the documented ways back (revise a plan, rework after
// verification or a rejected approval). `blocked` is handled separately.
const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  draft: ['planned', 'cancelled'],
  planned: ['approved', 'draft', 'cancelled', 'blocked'],
  approved: ['running', 'planned', 'cancelled', 'blocked'],
  running: ['verification', 'failed', 'cancelled', 'blocked'],
  verification: ['awaiting_approval', 'running', 'failed', 'cancelled', 'blocked'],
  awaiting_approval: ['completed', 'running', 'cancelled', 'blocked'],
  blocked: [], // resolved dynamically: back to blockedFrom, or cancelled/failed
  completed: [],
  cancelled: [],
  failed: [],
};

export function isRunState(value: string): value is RunState {
  return (RUN_STATES as readonly string[]).includes(value);
}

export function isWorkflow(value: string): value is Workflow {
  return (WORKFLOWS as readonly string[]).includes(value);
}

export function allowedTransitions(from: RunState, blockedFrom?: RunState | null): RunState[] {
  if (from === 'blocked') {
    return blockedFrom ? [blockedFrom, 'cancelled', 'failed'] : ['cancelled', 'failed'];
  }
  return [...TRANSITIONS[from]];
}

export interface TransitionInput {
  to: RunState;
  reason?: string;
  resolution?: string;
}

/**
 * Validates a transition and returns what must be stored. Throws on any
 * invalid move so the state can never be advanced by an unchecked write.
 */
export function planTransition(
  current: { state: RunState; blockedFrom: RunState | null },
  input: TransitionInput,
): { state: RunState; blockedFrom: RunState | null; blockerReason: string | null; blockerResolution: string | null } {
  const allowed = allowedTransitions(current.state, current.blockedFrom);
  if (!allowed.includes(input.to)) {
    throw new InvalidTransitionError(current.state, input.to, allowed);
  }
  if (input.to === 'blocked') {
    if (!input.reason?.trim() || !input.resolution?.trim()) {
      throw new ValidationError('A blocked run must state the blocker (--reason) and how to resolve it (--resolution).');
    }
    return {
      state: 'blocked',
      blockedFrom: current.state,
      blockerReason: input.reason.trim(),
      blockerResolution: input.resolution.trim(),
    };
  }
  if (input.to === 'failed' && !input.reason?.trim()) {
    throw new ValidationError('A failed run must record why it failed (--reason).');
  }
  return { state: input.to, blockedFrom: null, blockerReason: null, blockerResolution: null };
}
