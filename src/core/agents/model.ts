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
   * "brief" and "spec" are JSON written by planner.ts. "build" is one turn of
   * the build agent's tool loop (M6, DEC-020): see `loop`. "classify" suggests
   * a kind, tags and an explanation for a design reference (M9), with `image`.
   * "lessons" reads a source the person imported, with `document`, and answers
   * with citations (M14, DEC-031).
   */
  purpose: 'plan' | 'work' | 'brief' | 'spec' | 'build' | 'classify' | 'lessons';
  taskTitle: string;
  instructions: string;
  maxOutputTokens: number;
  signal: AbortSignal;
  /** For "build": the tools offered and the conversation so far, oldest first. */
  loop?: { tools: LoopTool[]; turns: LoopTurn[] };
  /** For "classify": the image itself, base64-encoded. Its content is data, never instructions. */
  image?: { mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string };
  /** For "lessons": the source, as a PDF or as numbered passages. Its content is data, never instructions. */
  document?: SourceDocument;
}

export type SourceDocument = { title: string; kind: 'pdf'; data: string; pages: number | null } | { title: string; kind: 'passages'; passages: string[] };

/**
 * Where a cited claim comes from. Pages are 1-based; passages are 0-based
 * indexes into the passages sent. `end` is exclusive in both.
 */
export interface SourceCitation {
  kind: 'page' | 'passage';
  start: number;
  end: number;
  quote: string;
}

/** A piece of the answer and the source locations it cites (none for the model's own words). */
export interface CitedText {
  text: string;
  citations: SourceCitation[];
}

/** A tool the build agent may call. The schema is JSON Schema for its input. */
export interface LoopTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface LoopToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * One turn of the tool loop. An assistant turn keeps the adapter's own
 * content (`raw`) so it can be sent back unchanged, as the API requires for
 * thinking blocks; results answer every call of the turn before.
 */
export type LoopTurn =
  | { kind: 'assistant'; text: string; calls: LoopToolCall[]; raw: unknown }
  | { kind: 'results'; results: { id: string; content: string; isError: boolean }[] };

export interface ModelResponse {
  text: string;
  toolRequests: ToolRequest[];
  usage: { inputTokens: number; outputTokens: number };
  /** Cost in US dollars as reported or computed by the adapter. */
  costUsd: number;
  /** Set when the model answered but did not finish properly (cut off, declined). The call is still paid for. */
  problem?: string;
  /** For "build": the tools the model wants to call next (empty when it is done), and its content to send back. */
  calls?: LoopToolCall[];
  raw?: unknown;
  /** For "lessons": the answer in pieces with their citations; `text` is the same pieces joined. */
  cited?: CitedText[];
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
  /** For "build": tool calls to make this turn. */
  calls?: LoopToolCall[];
  /** For "lessons": the answer with citations. */
  cited?: CitedText[];
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
    const text = step.cited ? step.cited.map((c) => c.text).join('') : (step.text ?? '');
    return {
      text,
      toolRequests: step.toolRequests ?? [],
      usage: { inputTokens: Math.ceil(rest.instructions.length / 4), outputTokens: Math.ceil(text.length / 4) },
      costUsd: step.costUsd ?? 0,
      ...(rest.purpose === 'build' ? { calls: step.calls ?? [], raw: { text, calls: step.calls ?? [] } } : {}),
      ...(step.cited ? { cited: step.cited } : {}),
    };
  }
}

export const SIMULATED_NOTE = '[Simulated model: no AI was called. This placeholder shows the workflow, not real work.]';

function defaultScript(request: Omit<ModelRequest, 'signal'>): SimulatedStep {
  // Planning drafts are templates built from the person's own words, with TODO placeholders.
  if (request.purpose === 'brief') return { text: JSON.stringify(simulatedBrief(JSON.parse(request.instructions))) };
  if (request.purpose === 'spec') return { text: JSON.stringify(simulatedSpec(JSON.parse(request.instructions))) };
  if (request.purpose === 'build') {
    // Looks at the repository once with a real tool call, then stops without changing anything.
    const turns = request.loop?.turns ?? [];
    if (turns.length === 0) return { calls: [{ id: 'sim_1', name: 'list_files', input: { path: '.' } }] };
    return { text: `${SIMULATED_NOTE}\n\nThe simulated agent listed the repository files and made no changes. Make the change yourself in the worktree, then run the checks again.` };
  }
  if (request.purpose === 'lessons') return { cited: simulatedLessons(request.document) };
  if (request.purpose === 'classify') return { text: JSON.stringify(simulatedClassification(JSON.parse(request.instructions))) };
  if (request.purpose === 'plan') {
    return { text: JSON.stringify({ subtasks: [{ title: request.taskTitle, goal: request.instructions, writes: [], dependsOn: [], risk: 'low', estTokens: 2000 }] }) };
  }
  return { text: `${SIMULATED_NOTE}\n\nTask: ${request.taskTitle}` };
}

/** A guess from the file's name and size only, so it cannot pass for having looked at the picture. */
function simulatedClassification(input: { fileName?: string; mediaType?: string; width?: number | null; height?: number | null }): { kind: string; tags: string[]; explanation: string } {
  const name = String(input.fileName ?? '').toLowerCase();
  const words = name.replace(/\.[a-z0-9]+$/, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !/^\d+$/.test(w));
  const video = String(input.mediaType ?? '').startsWith('video/');
  const wide = (input.width ?? 0) >= (input.height ?? 0);
  const kind = video ? 'video' : /anim|motion|transition|gif/.test(name) ? 'animation' : /screen|shot|capture|dashboard|page/.test(name) ? 'screenshot' : /mock|figma|design|wireframe|ui/.test(name) ? 'ui_design' : 'other';
  const tags = [...new Set([...words.slice(0, 4), ...(video ? [] : [wide ? 'landscape' : 'portrait'])])];
  return { kind, tags, explanation: `${SIMULATED_NOTE} Suggested from the file name and size only; the image was not looked at.` };
}

/**
 * Quotes the first passages word for word, so the layout of cited lessons can
 * be seen without a model. It never pretends to have understood the source,
 * and a PDF is not read at all.
 */
function simulatedLessons(document: SourceDocument | undefined): CitedText[] {
  const out: CitedText[] = [{ text: '## Lessons\n', citations: [] }];
  const passages = document?.kind === 'passages' ? document.passages.slice(0, 3) : [];
  passages.forEach((p, i) => {
    const quote = p.replace(/^\[[\d:]+\]\s*/, '');
    out.push({ text: '- ', citations: [] }, { text: `[Simulated] The source says: “${quote.length > 160 ? `${quote.slice(0, 159)}…` : quote}”`, citations: [{ kind: 'passage', start: i, end: i + 1, quote: p }] }, { text: '\n', citations: [] });
  });
  out.push({ text: `\n## Suggestions\n- [other] ${SIMULATED_NOTE} No AI read this source${document?.kind === 'pdf' ? ' (a PDF is not read without a model)' : ''}; real suggestions appear here when a budget and an API key are set.\n`, citations: [] });
  return out;
}
