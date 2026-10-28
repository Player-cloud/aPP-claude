// The main agent's deterministic shell (M3: FR-APP-003, ROADMAP Phase 2).
//
// A request is planned by the model, the plan is validated, a strategy is
// chosen by rules (strategy.ts), subtasks run under budget, timeout and
// permission limits, and results are reconciled before anything counts as
// done. A failure, timeout, denied tool or budget stop can never surface as
// success: the request succeeds only when every subtask succeeded and passed
// its output contract.

import { ValidationError } from '../errors.ts';
import { redactString } from '../redact.ts';
import type { AgentTask, AgentTaskSpec, AgentTaskStatus, Workspace } from '../workspace.ts';
import type { ModelAdapter, ModelRequest, ModelResponse } from './model.ts';
import { chooseStrategy, orderSubtasks, type PlannedSubtask, type Risk } from './strategy.ts';

export interface AgentRequest {
  runId: string | null;
  title: string;
  goal: string;
  /** Tools the delegated tasks may request. Tool execution itself arrives with the sandbox (M3 runs none). */
  allowedTools?: string[];
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;
// Thinking counts as output, so the allowance must leave room for it.
const MAX_OUTPUT_TOKENS = 8_000;

/**
 * Estimated cost of billable calls in flight, per workspace. Parallel calls
 * (a team, or two requests at once) each reserve their estimate, so together
 * they can never pass the budget check for more than the budget allows.
 */
const inFlight = new WeakMap<Workspace, number>();
const MAX_SUBTASKS = 10;
const TEAM_CONCURRENCY = 3;

type CallOutcome =
  | { ok: true; response: ModelResponse }
  | { ok: false; status: Exclude<AgentTaskStatus, 'queued' | 'running' | 'succeeded'>; failure: string; resolution: string | null };

export class Orchestrator {
  private readonly ws: Workspace;
  private readonly model: ModelAdapter;

  constructor(ws: Workspace, model: ModelAdapter) {
    this.ws = ws;
    this.model = model;
  }

  async run(request: AgentRequest): Promise<AgentTask> {
    const goal = request.goal?.trim();
    if (!goal) throw new ValidationError('Describe what the agent should do.');
    if (request.runId) {
      const run = this.ws.getRun(request.runId);
      if (run.state !== 'running') {
        throw new ValidationError(`The agent can only work on a run that has been started (this one is "${run.state}").`);
      }
    }
    const base: AgentTaskSpec = {
      goal,
      allowedTools: request.allowedTools ?? [],
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      output: { kind: 'json', requiredKeys: ['subtasks'] },
    };
    const root = this.ws.createAgentTask({ runId: request.runId, parentId: null, kind: 'request', title: request.title, spec: base });
    this.ws.updateAgentTask(root.id, { status: 'running', model: this.model.id });

    // 1. Plan.
    const planned = await this.call(root, 'plan', `Break this goal into subtasks. Reply with JSON {"subtasks":[...]}.\n\nGoal: ${goal}`);
    if (!planned.ok) return this.finish(root.id, planned.status, planned.failure, planned.resolution);
    const plan = parsePlan(planned.response.text);
    if ('error' in plan) return this.finish(root.id, 'failed', `The plan did not match its contract: ${plan.error}`, 'Run the request again or make the goal more specific.');
    const ordered = orderSubtasks(plan.subtasks);
    if ('error' in ordered) return this.finish(root.id, 'failed', `The plan cannot be executed: ${ordered.error}`, 'Run the request again or make the goal more specific.');

    // 2. Strategy.
    const budget = this.budgetState();
    const estimate = ordered.reduce((sum, s) => sum + this.model.estimateCostUsd(workRequest(s, base)), 0);
    const decision = chooseStrategy(ordered, { remainingUsd: budget.remaining, estimatedUsd: estimate });
    this.ws.updateAgentTask(root.id, { strategy: decision.strategy, rationale: decision.rationale });

    // 3. Execute.
    const subSpec = (s: PlannedSubtask): AgentTaskSpec => ({ ...base, goal: s.goal, output: { kind: 'text', mustInclude: [] } });
    let children: AgentTask[];
    if (decision.strategy === 'single') {
      const combined: PlannedSubtask = {
        title: request.title,
        goal: ordered.length === 1 ? ordered[0]!.goal : ordered.map((s, i) => `${i + 1}. ${s.title}: ${s.goal}`).join('\n'),
        writes: [],
        dependsOn: [],
        risk: 'low',
        estTokens: 0,
      };
      children = [await this.work(root, combined, subSpec(combined))];
    } else if (decision.strategy === 'subagents') {
      // One at a time; a subtask whose dependency did not succeed is cancelled, not started.
      const results = new Map<string, AgentTask>();
      for (const s of ordered) {
        const blocker = s.dependsOn.map((d) => results.get(d)!).find((t) => t.status !== 'succeeded');
        results.set(s.title, blocker ? this.skip(root, s, subSpec(s), `Not started because "${blocker.title}" did not succeed.`) : await this.work(root, s, subSpec(s)));
      }
      children = ordered.map((s) => results.get(s.title)!);
    } else {
      children = await this.team(root, ordered, subSpec);
    }

    // 4. Reconcile: success only if every subtask succeeded.
    return this.reconcile(root, children);
  }

  private async team(root: AgentTask, ordered: PlannedSubtask[], spec: (s: PlannedSubtask) => AgentTaskSpec): Promise<AgentTask[]> {
    const results = new Map<string, AgentTask>();
    let pending = [...ordered];
    while (pending.length) {
      const ready = pending.filter((s) => s.dependsOn.every((d) => results.has(d)));
      pending = pending.filter((s) => !ready.includes(s));
      for (let i = 0; i < ready.length; i += TEAM_CONCURRENCY) {
        const batch = ready.slice(i, i + TEAM_CONCURRENCY);
        const done = await Promise.all(
          batch.map((s) => {
            const blocker = s.dependsOn.map((d) => results.get(d)!).find((t) => t.status !== 'succeeded');
            return blocker ? this.skip(root, s, spec(s), `Not started because "${blocker.title}" did not succeed.`) : this.work(root, s, spec(s));
          }),
        );
        batch.forEach((s, j) => results.set(s.title, done[j]!));
      }
    }
    return ordered.map((s) => results.get(s.title)!);
  }

  private async work(root: AgentTask, subtask: PlannedSubtask, spec: AgentTaskSpec): Promise<AgentTask> {
    const task = this.ws.createAgentTask({ runId: root.runId, parentId: root.id, kind: 'subtask', title: subtask.title, spec });
    this.ws.updateAgentTask(task.id, { status: 'running', model: this.model.id });
    const outcome = await this.call(task, 'work', subtask.goal);
    if (!outcome.ok) return this.finish(task.id, outcome.status, outcome.failure, outcome.resolution);
    const problem = checkContract(outcome.response.text, spec.output);
    if (problem) return this.finish(task.id, 'failed', `The result did not pass verification: ${problem}`, 'Retry the task; if it keeps failing, narrow its goal.');
    return this.ws.updateAgentTask(task.id, { status: 'succeeded', output: outcome.response.text });
  }

  private skip(root: AgentTask, subtask: PlannedSubtask, spec: AgentTaskSpec, why: string): AgentTask {
    const task = this.ws.createAgentTask({ runId: root.runId, parentId: root.id, kind: 'subtask', title: subtask.title, spec });
    return this.ws.updateAgentTask(task.id, { status: 'cancelled', failure: why });
  }

  private reconcile(root: AgentTask, children: AgentTask[]): AgentTask {
    const check = this.ws.createAgentTask({
      runId: root.runId,
      parentId: root.id,
      kind: 'reconcile',
      title: 'Reconcile results',
      spec: { ...root.spec, goal: 'Check every delegated result before the request counts as done.', output: { kind: 'text', mustInclude: [] } },
    });
    const notDone = children.filter((c) => c.status !== 'succeeded');
    if (notDone.length) {
      const summary = notDone.map((c) => `"${c.title}" ${c.status.replace('_', ' ')}${c.failure ? ` (${c.failure})` : ''}`).join('; ');
      this.ws.updateAgentTask(check.id, { status: 'failed', failure: `${notDone.length} of ${children.length} subtasks did not succeed: ${summary}` });
      // A budget stop or a denied permission is something the user can resolve; anything else is a failure.
      const blocked = notDone.find((c) => c.status === 'blocked' || c.status === 'permission_denied');
      return this.finish(
        root.id,
        blocked ? 'blocked' : 'failed',
        `Not complete: ${summary}`,
        blocked?.resolution ?? 'Review the failed subtasks, then run the request again.',
      );
    }
    this.ws.updateAgentTask(check.id, { status: 'succeeded', output: `All ${children.length} subtask(s) succeeded and passed verification.` });
    const output = children.length === 1 ? children[0]!.output : children.map((c) => `## ${c.title}\n\n${c.output}`).join('\n\n');
    return this.ws.updateAgentTask(root.id, { status: 'succeeded', output, failure: null, resolution: null });
  }

  private finish(id: string, status: AgentTaskStatus, failure: string, resolution: string | null): AgentTask {
    return this.ws.updateAgentTask(id, { status, failure, resolution });
  }

  private budgetState(): { cap: number | null; remaining: number | null } {
    if (!this.model.billable) return { cap: null, remaining: null };
    const cap = this.ws.monthlyBudgetUsd();
    return { cap, remaining: cap === null ? 0 : Math.max(0, cap - this.ws.spentThisMonth()) };
  }

  /** One model call under budget, timeout and permission limits. */
  private async call(task: AgentTask, purpose: ModelRequest['purpose'], instructions: string): Promise<CallOutcome> {
    const request = { purpose, taskTitle: task.title, instructions, maxOutputTokens: task.spec.maxOutputTokens };
    let reserved = 0;
    if (this.model.billable) {
      const { cap, remaining } = this.budgetState();
      const estimate = this.model.estimateCostUsd(request);
      if (cap === null) {
        return { ok: false, status: 'blocked', failure: 'Real model calls are off: no monthly budget is set.', resolution: 'Choose a monthly budget in Settings to allow real calls.' };
      }
      const available = remaining! - (inFlight.get(this.ws) ?? 0);
      if (estimate > available) {
        return {
          ok: false,
          status: 'blocked',
          failure: `This call (up to $${estimate.toFixed(2)}) would exceed the monthly budget ($${Math.max(0, available).toFixed(2)} of $${cap} left).`,
          resolution: 'Raise the monthly budget in Settings, or wait until next month.',
        };
      }
      reserved = estimate;
      inFlight.set(this.ws, (inFlight.get(this.ws) ?? 0) + reserved);
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, task.spec.timeoutMs);
    let response: ModelResponse;
    try {
      response = await this.model.call({ ...request, signal: controller.signal });
    } catch (e) {
      if (timedOut) {
        // An abandoned call may still be billed, so its estimate is counted as spent.
        if (reserved) this.ws.recordSpend({ taskId: task.id, model: this.model.id, inputTokens: 0, outputTokens: 0, costUsd: reserved });
        return { ok: false, status: 'timed_out', failure: `No answer within ${Math.round(task.spec.timeoutMs / 1000)} s.`, resolution: 'Retry, or split the task into smaller parts.' };
      }
      return {
        ok: false,
        status: 'failed',
        failure: `The model call failed: ${redactString((e as Error).message)}`,
        resolution: 'Retry the request. If it keeps failing, check the API key and connection in Settings.',
      };
    } finally {
      clearTimeout(timer);
      if (reserved) inFlight.set(this.ws, Math.max(0, (inFlight.get(this.ws) ?? 0) - reserved));
    }

    this.ws.recordSpend({ taskId: task.id, model: this.model.id, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, costUsd: response.costUsd });
    const current = this.ws.getAgentTask(task.id);
    this.ws.updateAgentTask(task.id, {
      inputTokens: current.inputTokens + response.usage.inputTokens,
      outputTokens: current.outputTokens + response.usage.outputTokens,
      costUsd: current.costUsd + response.costUsd,
    });

    if (response.problem) {
      return { ok: false, status: 'failed', failure: response.problem, resolution: 'Retry, or rephrase the goal more narrowly.' };
    }
    const denied = response.toolRequests.filter((r) => !task.spec.allowedTools.includes(r.tool));
    if (denied.length) {
      return {
        ok: false,
        status: 'permission_denied',
        failure: `Requested ${denied.map((d) => `"${d.tool}"`).join(', ')}, which this task is not allowed to use.`,
        resolution: 'Allow the tool for this request if it is really needed, or narrow the goal.',
      };
    }
    return { ok: true, response };
  }
}

function workRequest(s: PlannedSubtask, spec: AgentTaskSpec) {
  return { purpose: 'work' as const, taskTitle: s.title, instructions: s.goal, maxOutputTokens: spec.maxOutputTokens };
}

const RISKS: Risk[] = ['low', 'medium', 'high'];

/** Validates the model's plan. The model's output is untrusted: every field is checked. */
export function parsePlan(text: string): { subtasks: PlannedSubtask[] } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return { error: 'not valid JSON' };
  }
  const list = (data as { subtasks?: unknown })?.subtasks;
  if (!Array.isArray(list) || list.length === 0) return { error: 'no subtasks' };
  if (list.length > MAX_SUBTASKS) return { error: `more than ${MAX_SUBTASKS} subtasks` };
  const subtasks: PlannedSubtask[] = [];
  for (const [i, raw] of list.entries()) {
    const s = raw as Record<string, unknown>;
    if (typeof s?.title !== 'string' || !s.title.trim() || typeof s.goal !== 'string' || !s.goal.trim()) return { error: `subtask ${i + 1} needs a title and a goal` };
    const strings = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null);
    const writes = s.writes === undefined ? [] : strings(s.writes);
    const dependsOn = s.dependsOn === undefined ? [] : strings(s.dependsOn);
    if (!writes || !dependsOn) return { error: `subtask ${i + 1} has invalid writes or dependsOn` };
    const risk = (s.risk ?? 'medium') as Risk;
    if (!RISKS.includes(risk)) return { error: `subtask ${i + 1} has an unknown risk "${String(s.risk)}"` };
    const estTokens = s.estTokens === undefined ? 4_000 : Number(s.estTokens);
    if (!Number.isFinite(estTokens) || estTokens < 0) return { error: `subtask ${i + 1} has an invalid estTokens` };
    subtasks.push({ title: s.title.trim().slice(0, 200), goal: s.goal.trim(), writes, dependsOn, risk, estTokens });
  }
  if (new Set(subtasks.map((s) => s.title)).size !== subtasks.length) return { error: 'subtask titles must be unique' };
  return { subtasks };
}

export function checkContract(text: string, contract: AgentTaskSpec['output']): string | null {
  if (!text.trim()) return 'the result is empty';
  if (contract.kind === 'text') {
    const missing = contract.mustInclude.filter((m) => !text.includes(m));
    return missing.length ? `missing ${missing.map((m) => `"${m}"`).join(', ')}` : null;
  }
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const missing = contract.requiredKeys.filter((k) => !(k in data));
    return missing.length ? `missing keys ${missing.join(', ')}` : null;
  } catch {
    return 'not valid JSON';
  }
}
