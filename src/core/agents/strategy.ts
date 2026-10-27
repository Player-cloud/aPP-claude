// Execution strategy choice (FR-APP-003, ARCH §6). Deterministic and
// explainable: the simplest strategy wins unless the plan clearly justifies
// delegation, and every choice records its reasons.

export type Strategy = 'single' | 'subagents' | 'team';
export type Risk = 'low' | 'medium' | 'high';

export interface PlannedSubtask {
  title: string;
  goal: string;
  /** Files or areas the subtask changes. Overlap means the subtasks conflict. */
  writes: string[];
  /** Titles of subtasks that must finish first. */
  dependsOn: string[];
  risk: Risk;
  estTokens: number;
}

export interface StrategyDecision {
  strategy: Strategy;
  rationale: string[];
}

/** Below this many tokens a subtask does not need its own context window. */
export const ISOLATION_THRESHOLD_TOKENS = 8_000;
/** A team needs at least this many independent subtasks to pay for coordination. */
export const TEAM_MIN_PARALLEL = 3;
/** Teams cost roughly this much more than the same work done sequentially. */
export const TEAM_OVERHEAD = 1.5;

export function chooseStrategy(subtasks: PlannedSubtask[], budget: { remainingUsd: number | null; estimatedUsd: number }): StrategyDecision {
  const rationale: string[] = [];
  if (subtasks.length <= 1) {
    return { strategy: 'single', rationale: ['One task: a single agent is simplest, and delegation would add no value.'] };
  }

  const overlaps = conflictingPairs(subtasks);
  if (overlaps.length) {
    rationale.push(`Subtasks would change the same files (${overlaps.join('; ')}), so they run one after another in one agent.`);
    return { strategy: 'single', rationale };
  }

  const independent = subtasks.filter((s) => s.dependsOn.length === 0);
  const large = subtasks.filter((s) => s.estTokens >= ISOLATION_THRESHOLD_TOKENS);
  if (large.length === 0) {
    rationale.push(`All ${subtasks.length} subtasks are small (under ${ISOLATION_THRESHOLD_TOKENS.toLocaleString('en-US')} tokens), so separate contexts would cost more than they save.`);
    return { strategy: 'single', rationale };
  }
  rationale.push(`${large.length} of ${subtasks.length} subtasks are large enough to benefit from their own context.`);

  const highRisk = subtasks.some((s) => s.risk === 'high');
  const teamAffordable = budget.remainingUsd === null || budget.estimatedUsd * TEAM_OVERHEAD <= budget.remainingUsd;
  if (independent.length >= TEAM_MIN_PARALLEL && !highRisk && teamAffordable) {
    rationale.push(`${independent.length} subtasks are independent and change different files, so they can run in parallel as a team.`);
    if (budget.remainingUsd !== null) rationale.push(`The budget covers the team's coordination overhead (about ${TEAM_OVERHEAD}×).`);
    return { strategy: 'team', rationale };
  }
  if (independent.length >= TEAM_MIN_PARALLEL) {
    if (highRisk) rationale.push('At least one subtask is high risk, so work stays sequential and each result is checked before the next starts.');
    if (!teamAffordable) rationale.push(`A team would cost about ${TEAM_OVERHEAD}× more than the remaining budget allows.`);
  } else {
    rationale.push(`Only ${independent.length} subtask(s) can start independently, which is too few for a team.`);
  }
  rationale.push('Subagents run one at a time with isolated contexts, and the main agent reconciles their results.');
  return { strategy: 'subagents', rationale };
}

function conflictingPairs(subtasks: PlannedSubtask[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < subtasks.length; i++) {
    for (let j = i + 1; j < subtasks.length; j++) {
      const shared = subtasks[i]!.writes.filter((w) => subtasks[j]!.writes.includes(w));
      if (shared.length) out.push(`"${subtasks[i]!.title}" and "${subtasks[j]!.title}" both change ${shared.join(', ')}`);
    }
  }
  return out;
}

/** Orders subtasks so dependencies come first; rejects unknown or circular dependencies. */
export function orderSubtasks(subtasks: PlannedSubtask[]): PlannedSubtask[] | { error: string } {
  const byTitle = new Map(subtasks.map((s) => [s.title, s]));
  for (const s of subtasks) {
    for (const d of s.dependsOn) if (!byTitle.has(d)) return { error: `"${s.title}" depends on unknown subtask "${d}".` };
  }
  const done = new Set<string>();
  const out: PlannedSubtask[] = [];
  while (out.length < subtasks.length) {
    const ready = subtasks.filter((s) => !done.has(s.title) && s.dependsOn.every((d) => done.has(d)));
    if (!ready.length) return { error: 'The plan has a circular dependency.' };
    for (const s of ready) {
      done.add(s.title);
      out.push(s);
    }
  }
  return out;
}
