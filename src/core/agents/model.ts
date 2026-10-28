// Model adapters (M3). The orchestrator talks to models only through this
// interface, so policy (budget, timeouts, permissions, output contracts) is
// enforced in deterministic code, not by the model (ARCH §5).
//
// The simulated adapter is used until a monthly budget and an API key are set
// (DEC-017); the Claude adapter (claude.ts, DEC-018) implements the same interface.

import { simulatedBrief, simulatedSpec } from '../planning.ts';

export interface ToolRequest {
  tool: string;
  input: string;
}

export interface ModelRequest {
  /**
   * "plan" asks for a task plan as JSON; "work" for a task's output; "brief"
   * and "spec" for planning documents as JSON (M5). The instructions for
   * "brief" and "spec" are JSON written by planner.ts.
   */
  purpose: 'plan' | 'work' | 'brief' | 'spec';
  taskTitle: string;
  instructions: string;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface ModelResponse {
  text: string;
  toolRequests: ToolRequest[];
  usage: { inputTokens: number; outputTokens: number };
  /** Cost in US dollars as reported or computed by the adapter. */
  costUsd: number;
  /** Set when the model answered but did not finish properly (cut off, declined). The call is still paid for. */
  problem?: string;
}

export interface ModelAdapter {
  readonly id: string;
  /** True when calls cost money and therefore need a budget. */
  readonly billable: boolean;
  /** Upper-bound cost estimate used for the budget check before a call. */
  estimateCostUsd(request: Omit<ModelRequest, 'signal'>): number;
  call(request: ModelRequest): Promise<ModelResponse>;
}

/** Scripted behaviour for one call to the simulated model, matched by task title. */
export interface SimulatedStep {
  text?: string;
  toolRequests?: ToolRequest[];
  /** Throw this message instead of answering (simulates an agent or API failure). */
  fail?: string;
  /** Answer after this many milliseconds (or never, if it exceeds the timeout). */
  delayMs?: number;
  costUsd?: number;
}

export type SimulatedScript = (request: Omit<ModelRequest, 'signal'>) => SimulatedStep;

/**
 * A deterministic stand-in for a model. It never calls a network service. By
 * default it plans a single task and answers with a clearly labelled
 * placeholder, so the UI can never pass it off as real AI output.
 */
export class SimulatedModel implements ModelAdapter {
  readonly id = 'simulated';
  readonly billable: boolean;
  private readonly script: SimulatedScript;

  /** `billable` exists for tests of the budget guard; the app always uses a free simulated model. */
  constructor(script: SimulatedScript = defaultScript, options: { billable?: boolean } = {}) {
    this.script = script;
    this.billable = options.billable ?? false;
  }

  estimateCostUsd(request: Omit<ModelRequest, 'signal'>): number {
    return this.script(request).costUsd ?? 0;
  }

  async call(request: ModelRequest): Promise<ModelResponse> {
    const { signal, ...rest } = request;
    const step = this.script(rest);
    if (step.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, step.delayMs);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
    }
    if (signal.aborted) throw new Error('aborted');
    if (step.fail) throw new Error(step.fail);
    const text = step.text ?? '';
    return {
      text,
      toolRequests: step.toolRequests ?? [],
      usage: { inputTokens: Math.ceil(rest.instructions.length / 4), outputTokens: Math.ceil(text.length / 4) },
      costUsd: step.costUsd ?? 0,
    };
  }
}

export const SIMULATED_NOTE = '[Simulated model: no AI was called. This placeholder shows the workflow, not real work.]';

function defaultScript(request: Omit<ModelRequest, 'signal'>): SimulatedStep {
  // Planning drafts are templates built from the person's own words, with TODO placeholders.
  if (request.purpose === 'brief') return { text: JSON.stringify(simulatedBrief(JSON.parse(request.instructions))) };
  if (request.purpose === 'spec') return { text: JSON.stringify(simulatedSpec(JSON.parse(request.instructions))) };
  if (request.purpose === 'plan') {
    return { text: JSON.stringify({ subtasks: [{ title: request.taskTitle, goal: request.instructions, writes: [], dependsOn: [], risk: 'low', estTokens: 2000 }] }) };
  }
  return { text: `${SIMULATED_NOTE}\n\nTask: ${request.taskTitle}` };
}
