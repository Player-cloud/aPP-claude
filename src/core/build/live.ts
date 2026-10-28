// Live progress of build work (M15, DEC-032). While the agent works, each
// step is added here as it happens so the app can show it in a timeline, and
// a step that needs the person (a command Claude wants to run) waits here for
// their answer. Live progress is kept in memory only: the lasting record is
// the build itself (its agent run, check results and audit events).

export type LiveEvent =
  /** A stage of the work, such as "Running the checks before the change". */
  | { seq: number; at: string; kind: 'phase'; text: string }
  /** What Claude says while it works. */
  | { seq: number; at: string; kind: 'say'; text: string }
  /** A tool call: reading, searching, editing, running a command. */
  | { seq: number; at: string; kind: 'step'; tool: string; target: string; ok: boolean; note: string }
  /** Claude's own to-do list for the task. */
  | { seq: number; at: string; kind: 'plan'; items: { text: string; status: 'pending' | 'in_progress' | 'completed' }[] }
  /** Claude asks to do something that needs the person's OK. */
  | { seq: number; at: string; kind: 'ask'; approvalId: string; tool: string; detail: string }
  | { seq: number; at: string; kind: 'answer'; approvalId: string; allowed: boolean }
  /** The work stopped: finished, failed or cancelled. */
  | { seq: number; at: string; kind: 'end'; status: 'review' | 'failed' | 'stopped'; text: string };

type NewEvent = LiveEvent extends infer E ? (E extends LiveEvent ? Omit<E, 'seq' | 'at'> : never) : never;

export interface LiveState {
  buildId: string;
  running: boolean;
  events: LiveEvent[];
  /** The question waiting for the person, if any. */
  pending: { approvalId: string; tool: string; detail: string } | null;
  /** Spend reported so far by the running agent. */
  costUsd: number;
}

/** What an agent run gets to report progress and ask the person. */
export interface AgentHooks {
  emit(event: NewEvent): void;
  /** Resolves true when the person allows it. Never resolves true on its own. */
  ask(tool: string, detail: string, signal?: AbortSignal): Promise<boolean>;
  cost(usd: number): void;
}

/** How long a question waits before it counts as "no". */
export const ASK_TIMEOUT_MS = 15 * 60_000;
const MAX_EVENTS = 2_000;

interface Entry {
  state: LiveState;
  controller: AbortController;
  waiting: Map<string, (allowed: boolean) => void>;
}

export class LiveRuns {
  private readonly runs = new Map<string, Entry>();
  private seq = 0;

  /** Starts (or restarts) live progress for a build. Returns the signal that stop() aborts. */
  begin(buildId: string): AbortSignal {
    const old = this.runs.get(buildId);
    if (old?.state.running) throw new Error('This work is already running.');
    const entry: Entry = {
      state: { buildId, running: true, events: old?.state.events ?? [], pending: null, costUsd: 0 },
      controller: new AbortController(),
      waiting: new Map(),
    };
    this.runs.set(buildId, entry);
    return entry.controller.signal;
  }

  isRunning(buildId: string): boolean {
    return this.runs.get(buildId)?.state.running ?? false;
  }

  emit(buildId: string, event: NewEvent): void {
    const entry = this.runs.get(buildId);
    if (!entry) return;
    const events = entry.state.events;
    events.push({ ...event, seq: ++this.seq, at: new Date().toISOString() } as LiveEvent);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  }

  hooks(buildId: string): AgentHooks {
    return {
      emit: (event) => this.emit(buildId, event),
      ask: (tool, detail, signal) => this.ask(buildId, tool, detail, signal),
      cost: (usd) => {
        const entry = this.runs.get(buildId);
        if (entry) entry.state.costUsd = usd;
      },
    };
  }

  ask(buildId: string, tool: string, detail: string, signal?: AbortSignal): Promise<boolean> {
    const entry = this.runs.get(buildId);
    if (!entry?.state.running) return Promise.resolve(false);
    const approvalId = `ask_${++this.seq}`;
    this.emit(buildId, { kind: 'ask', approvalId, tool, detail });
    entry.state.pending = { approvalId, tool, detail };
    return new Promise<boolean>((resolve) => {
      const settle = (allowed: boolean) => {
        if (!entry.waiting.delete(approvalId)) return;
        clearTimeout(timer);
        if (entry.state.pending?.approvalId === approvalId) entry.state.pending = null;
        this.emit(buildId, { kind: 'answer', approvalId, allowed });
        resolve(allowed);
      };
      const timer = setTimeout(() => settle(false), ASK_TIMEOUT_MS);
      entry.waiting.set(approvalId, settle);
      signal?.addEventListener('abort', () => settle(false), { once: true });
      entry.controller.signal.addEventListener('abort', () => settle(false), { once: true });
    });
  }

  /** The person's answer. Returns false when that question is no longer waiting. */
  answer(buildId: string, approvalId: string, allowed: boolean): boolean {
    const settle = this.runs.get(buildId)?.waiting.get(approvalId);
    if (!settle) return false;
    settle(allowed === true);
    return true;
  }

  stop(buildId: string): boolean {
    const entry = this.runs.get(buildId);
    if (!entry?.state.running) return false;
    entry.controller.abort();
    return true;
  }

  /** Stops everything, for when the app closes. */
  stopAll(): void {
    for (const id of this.runs.keys()) this.stop(id);
  }

  end(buildId: string, status: 'review' | 'failed' | 'stopped', text: string): void {
    const entry = this.runs.get(buildId);
    if (!entry) return;
    this.emit(buildId, { kind: 'end', status, text });
    for (const settle of [...entry.waiting.values()]) settle(false);
    entry.state.running = false;
    entry.state.pending = null;
  }

  /** Events after `since` (a sequence number), so a view can poll cheaply. */
  get(buildId: string, since = 0): LiveState | null {
    const entry = this.runs.get(buildId);
    if (!entry) return null;
    return { ...entry.state, events: entry.state.events.filter((e) => e.seq > since) };
  }
}
