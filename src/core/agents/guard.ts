// One model call under the monthly budget and a timeout (DEC-018). Shared by
// the orchestrator and the planning workflow so no caller can reach a
// billable model without the same checks.

import { redactString } from '../redact.ts';
import type { Workspace } from '../workspace.ts';
import type { ModelAdapter, ModelRequest, ModelResponse } from './model.ts';

/**
 * Estimated cost of billable calls in flight, per workspace. Parallel calls
 * (a team, or two requests at once) each reserve their estimate, so together
 * they can never pass the budget check for more than the budget allows.
 */
const inFlight = new WeakMap<Workspace, number>();

export type GuardedOutcome =
  | { ok: true; response: ModelResponse }
  | { ok: false; status: 'blocked' | 'timed_out' | 'failed'; failure: string; resolution: string };

export async function guardedCall(
  ws: Workspace,
  model: ModelAdapter,
  request: Omit<ModelRequest, 'signal'>,
  options: { taskId: string | null; timeoutMs: number },
): Promise<GuardedOutcome> {
  let reserved = 0;
  if (model.billable) {
    const cap = ws.monthlyBudgetUsd();
    if (cap === null) {
      return { ok: false, status: 'blocked', failure: 'Real model calls are off: no monthly budget is set.', resolution: 'Choose a monthly budget in Settings to allow real calls.' };
    }
    const estimate = model.estimateCostUsd(request);
    const available = Math.max(0, cap - ws.spentThisMonth()) - (inFlight.get(ws) ?? 0);
    if (estimate > available) {
      return {
        ok: false,
        status: 'blocked',
        failure: `This call (up to $${estimate.toFixed(2)}) would exceed the monthly budget ($${Math.max(0, available).toFixed(2)} of $${cap} left).`,
        resolution: 'Raise the monthly budget in Settings, or wait until next month.',
      };
    }
    reserved = estimate;
    inFlight.set(ws, (inFlight.get(ws) ?? 0) + reserved);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  let response: ModelResponse;
  try {
    response = await model.call({ ...request, signal: controller.signal });
  } catch (e) {
    if (timedOut) {
      // An abandoned call may still be billed, so its estimate is counted as spent.
      if (reserved) ws.recordSpend({ taskId: options.taskId, model: model.id, inputTokens: 0, outputTokens: 0, costUsd: reserved });
      return { ok: false, status: 'timed_out', failure: `No answer within ${Math.round(options.timeoutMs / 1000)} s.`, resolution: 'Retry, or split the task into smaller parts.' };
    }
    return {
      ok: false,
      status: 'failed',
      failure: `The model call failed: ${redactString((e as Error).message)}`,
      resolution: 'Retry the request. If it keeps failing, check the API key and connection in Settings.',
    };
  } finally {
    clearTimeout(timer);
    if (reserved) inFlight.set(ws, Math.max(0, (inFlight.get(ws) ?? 0) - reserved));
  }

  ws.recordSpend({ taskId: options.taskId, model: model.id, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, costUsd: response.costUsd });
  if (response.problem) return { ok: false, status: 'failed', failure: response.problem, resolution: 'Retry, or rephrase the goal more narrowly.' };
  return { ok: true, response };
}
