// The build agent's tool loop (M6, DEC-020). The model proposes tool calls;
// this code decides whether and how each one runs. Five tools only, all
// confined to one worktree, and checks only by the ID the person approved.
// Every turn goes through the budget guard, and the loop has a turn limit.

import { guardedCall } from '../agents/guard.ts';
import type { LoopTool, LoopTurn, ModelAdapter } from '../agents/model.ts';
import { redactString } from '../redact.ts';
import type { Workspace } from '../workspace.ts';
import { runCheck, type Check, type CheckResult } from './checks.ts';
import { listFiles, readFile, searchFiles, ToolInputError, writeFile } from './files.ts';

export const MAX_TURNS = 40;
const MAX_OUTPUT_TOKENS = 16_000;
const TURN_TIMEOUT_MS = 300_000;
const MAX_RESULT = 30_000;

const PATH = { type: 'string', description: 'Path relative to the repository root, with forward slashes. "." is the root.' };
export const BUILD_TOOLS: LoopTool[] = [
  {
    name: 'list_files',
    description: 'List files and folders under a folder (three levels deep; dependency and build folders are skipped).',
    schema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: PATH } },
  },
  {
    name: 'read_file',
    description: 'Read a text file.',
    schema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: PATH } },
  },
  {
    name: 'search',
    description: 'Search text files under a folder for a regular expression. Returns path:line: text for each match.',
    schema: { type: 'object', additionalProperties: false, required: ['pattern', 'path'], properties: { pattern: { type: 'string' }, path: PATH } },
  },
  {
    name: 'write_file',
    description: 'Create or replace a whole text file with the given content.',
    schema: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: PATH, content: { type: 'string' } } },
  },
  {
    name: 'run_check',
    description: 'Run one of the approved checks by its ID and get its real result. No other command can be run.',
    schema: { type: 'object', additionalProperties: false, required: ['check_id'], properties: { check_id: { type: 'string' } } },
  },
];

export interface AgentStep {
  tool: string;
  /** The path, pattern or check the call was about. */
  target: string;
  ok: boolean;
  note: string;
}

export interface AgentOutcome {
  status: 'done' | 'blocked' | 'timed_out' | 'failed' | 'turn_limit';
  summary: string;
  steps: AgentStep[];
  checkResults: CheckResult[];
  filesWritten: string[];
  resolution: string | null;
  costUsd: number;
}

/** Default spending limit for one agent run, on top of the monthly budget. */
export const DEFAULT_RUN_CAP_USD = 3;

export async function runBuildAgent(
  ws: Workspace,
  model: ModelAdapter,
  input: { title: string; instructions: string; worktree: string; checks: Check[]; checkTimeoutMs?: number; maxCostUsd?: number; signal?: AbortSignal },
): Promise<AgentOutcome> {
  const turns: LoopTurn[] = [];
  const steps: AgentStep[] = [];
  const checkResults: CheckResult[] = [];
  const written = new Set<string>();
  const cap = input.maxCostUsd ?? DEFAULT_RUN_CAP_USD;
  let spent = 0;
  const end = (status: AgentOutcome['status'], summary: string, resolution: string | null = null): AgentOutcome => ({
    status,
    summary: redactString(summary),
    steps,
    checkResults,
    filesWritten: [...written],
    resolution,
    costUsd: spent,
  });

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (input.signal?.aborted) return end('failed', 'Cancelled.');
    const request = { purpose: 'build' as const, taskTitle: input.title, instructions: input.instructions, maxOutputTokens: MAX_OUTPUT_TOKENS, loop: { tools: BUILD_TOOLS, turns } };
    // The history grows every turn, so one run is also capped on its own.
    if (model.billable && spent + model.estimateCostUsd(request) > cap) {
      return end('blocked', `The next turn could take this run past its $${cap.toFixed(2)} limit ($${spent.toFixed(2)} spent so far).`, 'Review what it changed so far, then run it again with a narrower task, or finish the change yourself.');
    }
    const outcome = await guardedCall(ws, model, request, { taskId: null, timeoutMs: TURN_TIMEOUT_MS });
    if (!outcome.ok) return end(outcome.status === 'blocked' ? 'blocked' : outcome.status === 'timed_out' ? 'timed_out' : 'failed', outcome.failure, outcome.resolution);
    const { response } = outcome;
    spent += response.costUsd;
    const calls = response.calls ?? [];
    turns.push({ kind: 'assistant', text: response.text, calls, raw: response.raw });
    if (calls.length === 0) return end('done', response.text || '(The agent gave no summary.)');

    const results: { id: string; content: string; isError: boolean }[] = [];
    for (const call of calls) {
      const args = (call.input ?? {}) as Record<string, unknown>;
      const target = String(args.path ?? args.check_id ?? args.pattern ?? '');
      try {
        let content: string;
        switch (call.name) {
          case 'list_files':
            content = listFiles(input.worktree, args.path);
            break;
          case 'read_file':
            content = readFile(input.worktree, args.path);
            break;
          case 'search':
            content = searchFiles(input.worktree, args.pattern, args.path);
            break;
          case 'write_file':
            content = writeFile(input.worktree, args.path, args.content);
            written.add(String(args.path).replace(/\\/g, '/'));
            break;
          case 'run_check': {
            const check = input.checks.find((c) => c.id === args.check_id);
            if (!check) throw new ToolInputError(`No approved check "${String(args.check_id)}". Approved: ${input.checks.map((c) => c.id).join(', ') || 'none'}.`);
            const r = await runCheck(input.worktree, check, { timeoutMs: input.checkTimeoutMs, signal: input.signal });
            checkResults.push(r);
            content = `Check "${r.checkId}" ${r.status} (exit code ${r.exitCode ?? 'none'}, ${Math.round(r.durationMs / 1000)} s).\n${r.output}`;
            break;
          }
          default:
            throw new ToolInputError(`Unknown tool "${call.name}".`);
        }
        steps.push({ tool: call.name, target, ok: true, note: call.name === 'run_check' ? (checkResults.at(-1)?.status ?? '') : '' });
        results.push({ id: call.id, content: content.slice(0, MAX_RESULT), isError: false });
      } catch (e) {
        const message = e instanceof ToolInputError ? e.message : `The tool failed: ${(e as Error).message}`;
        steps.push({ tool: call.name, target, ok: false, note: message });
        results.push({ id: call.id, content: message, isError: true });
      }
    }
    turns.push({ kind: 'results', results });
  }
  return end('turn_limit', `The agent stopped after ${MAX_TURNS} turns without finishing.`, 'Review what it changed, then run it again with a narrower task or finish the change yourself.');
}
