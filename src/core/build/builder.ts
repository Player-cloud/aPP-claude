// Build Feature and Fix a Bug workflows (M6: FR-BUILD-001/002/003, DEC-020).
//
//   define (person) → start: worktree + baseline checks → agent (or the person)
//   changes the worktree → verify: checks again, diff, review → complete or abandon
//
// The person defines the task and approves its checks; the model can only
// work inside the worktree. Check results are real and stored as evidence,
// the review is computed from the diff, and the change stays on its own
// branch for the person to merge. Nothing here merges, pushes or deletes.

import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import type { ModelAdapter } from '../agents/model.ts';
import { ValidationError } from '../errors.ts';
import type { Spec } from '../planning.ts';
import { redactString } from '../redact.ts';
import type { Build, BuildKind, CheckRun, Workspace } from '../workspace.ts';
import { runBuildAgent } from './agent.ts';
import { normalizeChecks, runCheck, type Check, type CheckResult } from './checks.ts';
import { addWorktree, commitWorktree, diffWorktree, git, inspectRepo, type Diff } from './git.ts';
import { reviewChange } from './review.ts';

export interface BuildInput {
  kind: BuildKind;
  title: string;
  goal: string;
  requirementIds?: string[];
  components?: string[];
  checks: Check[];
  repro?: string | null;
}

export interface BuildDetail {
  build: Build;
  checkRuns: CheckRun[];
}

/** Builds with an operation in progress, so two cannot run on the same worktree at once. */
const busy = new Set<string>();

export class Builder {
  private readonly ws: Workspace;
  private readonly model: ModelAdapter;
  private readonly checkTimeoutMs: number | undefined;

  constructor(ws: Workspace, model: ModelAdapter, options: { checkTimeoutMs?: number } = {}) {
    this.ws = ws;
    this.model = model;
    this.checkTimeoutMs = options.checkTimeoutMs;
  }

  detail(buildId: string): BuildDetail {
    return { build: this.ws.getBuild(buildId), checkRuns: this.ws.listCheckRuns(buildId) };
  }

  /** Uses an existing git repository (with at least one commit) for this project's build work. */
  async setRepo(projectId: string, path: string) {
    if (!isAbsolute(path)) throw new ValidationError('Give the full path of the repository folder.');
    const repo = await inspectRepo(normalize(path));
    return this.ws.setProjectRepo(projectId, repo.root);
  }

  /** Makes the app's own project folder a git repository, for projects that start here. Never touches another folder. */
  async initProjectRepo(projectId: string) {
    const project = this.ws.getProject(projectId);
    try {
      await inspectRepo(project.workspacePath);
      return this.ws.setProjectRepo(projectId, project.workspacePath);
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
    }
    const at = project.workspacePath;
    await git(at, ['init', '-q']);
    await git(at, ['add', '-A']);
    await git(at, ['-c', 'user.name=Iterative Platform', '-c', 'user.email=iap@localhost', 'commit', '-q', '--allow-empty', '-m', 'Start project']);
    return this.ws.setProjectRepo(projectId, at);
  }

  create(projectId: string, input: BuildInput): Build {
    return this.ws.createBuild({ projectId, ...this.validate(projectId, input) });
  }

  edit(buildId: string, input: BuildInput): Build {
    const build = this.ws.getBuild(buildId);
    if (build.kind !== input.kind) throw new ValidationError('The kind of a build cannot change.');
    const v = this.validate(build.projectId, input);
    return this.ws.updateBuild(buildId, { title: v.title, goal: v.goal, requirementIds: v.requirementIds, components: v.components, checks: v.checks, repro: v.repro });
  }

  /** Creates the worktree on a new branch and runs every check once, before anything changes. */
  async start(buildId: string): Promise<BuildDetail> {
    return this.exclusive(buildId, async () => {
      const build = this.ws.getBuild(buildId);
      if (build.status !== 'draft') throw new ValidationError('This work has already started.');
      const project = this.ws.getProject(build.projectId);
      if (!project.repoPath) throw new ValidationError('Choose the git repository for this project first.');
      const repo = await inspectRepo(project.repoPath);
      const worktree = join(this.ws.paths.worktrees, build.id);
      const branch = `iap/${build.kind === 'feature' ? 'feature' : 'fix'}-${build.id.slice(6, 14)}`;
      mkdirSync(this.ws.paths.worktrees, { recursive: true });
      await addWorktree(repo.root, worktree, branch, repo.head);
      this.ws.updateBuild(
        buildId,
        { status: 'in_progress', repoPath: repo.root, branch, worktree, baseCommit: repo.head },
        { type: 'build.started', payload: { branch, baseCommit: repo.head, worktree } },
      );
      await this.runChecks(buildId, 'baseline');
      return this.detail(buildId);
    });
  }

  /** Lets the agent change the worktree. It may run approved checks; its results are stored as "agent" evidence. */
  async runAgent(buildId: string, options: { maxCostUsd?: number } = {}): Promise<BuildDetail> {
    return this.exclusive(buildId, async () => {
      const build = this.ws.getBuild(buildId);
      if (build.status !== 'in_progress' && build.status !== 'review') throw new ValidationError('Start the work before running the agent.');
      const outcome = await runBuildAgent(this.ws, this.model, {
        title: build.title,
        instructions: this.instructions(build),
        worktree: build.worktree!,
        checks: build.checks,
        checkTimeoutMs: this.checkTimeoutMs,
        maxCostUsd: options.maxCostUsd,
      });
      for (const r of outcome.checkResults) this.ws.recordCheckRun(buildId, 'agent', r);
      const { checkResults: _results, ...rest } = outcome;
      this.ws.updateBuild(
        buildId,
        { status: 'in_progress', agent: { ...rest, model: this.model.id, at: new Date().toISOString() } },
        { type: 'build.agent', payload: { model: this.model.id, status: outcome.status, files: outcome.filesWritten, costUsd: outcome.costUsd } },
      );
      return this.detail(buildId);
    });
  }

  /** Runs every check again, reads the diff against the base commit, and reviews the change. */
  async verify(buildId: string): Promise<BuildDetail> {
    return this.exclusive(buildId, async () => {
      const build = this.ws.getBuild(buildId);
      if (build.status !== 'in_progress' && build.status !== 'review') throw new ValidationError('Start the work before verifying it.');
      const final = await this.runChecks(buildId, 'verify');
      const diff = await diffWorktree(build.worktree!, build.baseCommit!);
      const baseline = this.latest(buildId, 'baseline');
      const risks = reviewChange({ kind: build.kind, files: diff.files, patch: diff.patch, truncated: diff.truncated, components: build.components, baseline, final });
      this.ws.updateBuild(
        buildId,
        { status: 'review', changedFiles: diff.files, risks },
        { type: 'build.verified', payload: { files: diff.files.length, risks: risks.map((r) => r.kind), checks: final.map((r) => `${r.checkId}:${r.status}`) } },
      );
      this.writeReport(buildId);
      return this.detail(buildId);
    });
  }

  /**
   * Marks reviewed work done. Remaining risks need the person's explanation.
   * The change is committed on the build's own branch (in the app's worktree) so
   * it can be merged; nothing is merged or pushed.
   */
  async complete(buildId: string, note: string | null): Promise<BuildDetail> {
    const build = this.ws.getBuild(buildId);
    if (build.status !== 'review') throw new ValidationError('Verify the change before marking it done.');
    const text = note?.trim().slice(0, 4_000) || null;
    if (build.risks?.length && (!text || text.length < 10)) throw new ValidationError('Explain why the remaining risks are acceptable before marking this done.');
    return await this.exclusive(buildId, async () => {
      const resultCommit = await commitWorktree(build.worktree!, `${build.kind === 'bugfix' ? 'Fix' : 'Add'}: ${build.title}\n\nIterative Platform build ${build.id}`);
      this.ws.updateBuild(
        buildId,
        { status: 'completed', note: text, completedAt: new Date().toISOString(), resultCommit },
        { type: 'build.completed', payload: { risks: build.risks?.map((r) => r.kind) ?? [], commit: resultCommit } },
      );
      this.writeReport(buildId);
      return this.detail(buildId);
    });
  }

  /** Stops the work. The worktree and branch stay on disk for the person to inspect or remove. */
  abandon(buildId: string, reason: string | null): BuildDetail {
    const build = this.ws.getBuild(buildId);
    if (busy.has(buildId)) throw new ValidationError('Wait for the current step to finish.');
    if (build.status === 'completed' || build.status === 'abandoned') throw new ValidationError(`This work is already ${build.status}.`);
    this.ws.updateBuild(buildId, { status: 'abandoned', note: reason?.trim().slice(0, 4_000) || build.note }, { type: 'build.abandoned', payload: {} });
    if (build.worktree) this.writeReport(buildId);
    return this.detail(buildId);
  }

  async diff(buildId: string): Promise<Diff> {
    const build = this.ws.getBuild(buildId);
    if (!build.worktree || !build.baseCommit) throw new ValidationError('This work has not started yet.');
    const d = await diffWorktree(build.worktree, build.baseCommit);
    return { ...d, patch: redactString(d.patch) };
  }

  private async exclusive<T>(buildId: string, fn: () => Promise<T>): Promise<T> {
    if (busy.has(buildId)) throw new ValidationError('Another step is still running on this work. Wait for it to finish.');
    busy.add(buildId);
    try {
      return await fn();
    } finally {
      busy.delete(buildId);
    }
  }

  private async runChecks(buildId: string, phase: 'baseline' | 'verify'): Promise<CheckResult[]> {
    const build = this.ws.getBuild(buildId);
    const results: CheckResult[] = [];
    for (const check of build.checks) {
      const r = await runCheck(build.worktree!, check, { timeoutMs: this.checkTimeoutMs });
      this.ws.recordCheckRun(buildId, phase, r);
      results.push(r);
    }
    return results;
  }

  /** The most recent result of each check in a phase. */
  private latest(buildId: string, phase: 'baseline' | 'verify'): CheckResult[] {
    const byCheck = new Map<string, CheckResult>();
    for (const r of this.ws.listCheckRuns(buildId)) if (r.phase === phase) byCheck.set(r.checkId, r);
    return [...byCheck.values()];
  }

  private validate(projectId: string, input: BuildInput) {
    if (input.kind !== 'feature' && input.kind !== 'bugfix') throw new ValidationError('Kind must be "feature" or "bugfix".');
    const title = text('Title', input.title, 200);
    const goal = text(input.kind === 'feature' ? 'What to build' : 'What is wrong', input.goal, 10_000);
    const ids = list('Requirement IDs', input.requirementIds ?? [], 50, 20);
    const spec = this.ws.approvedPlanDoc(projectId, 'spec');
    const known = new Set((spec?.content as Spec | undefined)?.requirements.map((r) => r.id) ?? []);
    if (input.kind === 'feature' && ids.length === 0) {
      throw new ValidationError(spec ? 'Name the requirement IDs this feature implements.' : 'Approve a specification first: a feature implements its requirements.');
    }
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw new ValidationError(`${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not in the approved specification.`);
    // "src/, test/" or "src/ and test/" on one line means two folders, as people write them.
    const split = (input.components ?? []).flatMap((c) => (typeof c === 'string' ? c.split(/\s*,\s*|\s+and\s+/) : [c])).filter((c) => c !== '');
    const components = list('Components', split, 50, 300).map((c) => {
      const p = c.replace(/\\/g, '/');
      if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..')) throw new ValidationError(`Component "${c}" must be a path inside the repository.`);
      return p.replace(/^\.\//, '');
    });
    const checks = normalizeChecks(input.checks);
    if (checks.length === 0) throw new ValidationError('Add at least one check command (for example "npm test") so the change can be verified.');
    const repro = input.kind === 'bugfix' ? text('How to reproduce it', input.repro ?? '', 10_000) : null;
    return { kind: input.kind, title, goal, requirementIds: ids, components, checks, repro };
  }

  private instructions(build: Build): string {
    const spec = this.ws.approvedPlanDoc(build.projectId, 'spec')?.content as Spec | undefined;
    const reqs = (spec?.requirements ?? []).filter((r) => build.requirementIds.includes(r.id));
    const baseline = this.latest(build.id, 'baseline');
    const lines = [
      build.kind === 'feature' ? `Implement this feature: ${build.goal}` : `Fix this bug: ${build.goal}`,
      ...(build.repro ? ['', 'How to reproduce it:', build.repro] : []),
      ...(reqs.length ? ['', 'Requirements:', ...reqs.flatMap((r) => [`- ${r.id} (${r.priority}) ${r.title}`, ...r.acceptanceCriteria.map((c) => `  - accept: ${c}`)])] : []),
      ...(build.components.length ? ['', `Expected to change: ${build.components.join(', ')}. Say why if you need to change anything else.`] : []),
      '',
      'Approved checks (run them with run_check):',
      ...build.checks.map((c) => `- ${c.id}: ${c.command}`),
      '',
      'Results before any change:',
      ...(baseline.length ? baseline.map((r) => `- ${r.checkId}: ${r.status}`) : ['- none recorded']),
      ...(build.kind === 'bugfix'
        ? ['', 'Work in this order: find the root cause; add a regression test that fails because of the bug; make the smallest fix; run the checks.']
        : ['', 'Inspect the existing code and tests first. Add or update tests for the change.']),
    ];
    return lines.join('\n');
  }

  private writeReport(buildId: string): void {
    const build = this.ws.getBuild(buildId);
    const project = this.ws.getProject(build.projectId);
    const runs = this.ws.listCheckRuns(buildId);
    const md = renderReport(build, runs);
    const dir = join(project.workspacePath, 'docs', 'builds');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${build.id}.md`);
    writeFileSync(path, md);
    if (build.reportPath !== path) this.ws.updateBuild(buildId, { reportPath: path });
  }
}

function text(label: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${label} is required.`);
  if (value.length > max) throw new ValidationError(`${label} is longer than ${max} characters.`);
  return value.trim();
}

function list(label: string, value: unknown, maxItems: number, maxItem: number): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new ValidationError(`${label} must be a list of text items.`);
  const items = value.map((v: string) => v.trim()).filter(Boolean);
  if (items.length > maxItems) throw new ValidationError(`${label}: at most ${maxItems} items.`);
  if (items.some((i) => i.length > maxItem)) throw new ValidationError(`${label}: an item is longer than ${maxItem} characters.`);
  return [...new Set(items)];
}

const STATUS_WORD: Record<CheckResult['status'], string> = { passed: 'passed', failed: 'FAILED', timed_out: 'TIMED OUT', error: 'could not run', not_run: 'not run' };

/** The hand-off report (FR-BUILD-001: diff and unresolved risks are reported). Exported for tests. */
export function renderReport(build: Build, runs: CheckRun[]): string {
  const out = [
    `# ${build.kind === 'feature' ? 'Feature' : 'Bug fix'}: ${build.title}`,
    '',
    `Status: **${build.status}**. Branch \`${build.branch ?? '(not started)'}\` from commit \`${build.baseCommit?.slice(0, 12) ?? '-'}\`.`,
    ...(build.requirementIds.length ? [`Requirements: ${build.requirementIds.join(', ')}`] : []),
    '',
    '## Task',
    '',
    build.goal,
    ...(build.repro ? ['', '**How to reproduce:**', '', build.repro] : []),
    '',
    '## Checks',
    '',
    '| Phase | Check | Command | Result | Exit code | Time |',
    '|---|---|---|---|---|---|',
    ...runs.map((r) => `| ${r.phase} | ${r.checkId} | \`${r.command.replace(/\|/g, '\\|')}\` | ${STATUS_WORD[r.status]} | ${r.exitCode ?? '-'} | ${Math.round(r.durationMs / 1000)} s |`),
    ...(runs.length ? [] : ['| - | - | - | No checks have run | - | - |']),
    '',
    '## Agent',
    '',
    build.agent
      ? `${build.agent.model === 'simulated' ? 'Simulated agent (no AI was called)' : build.agent.model}: ${build.agent.status}, ${build.agent.steps.length} tool calls, $${build.agent.costUsd.toFixed(2)}. Files written: ${build.agent.filesWritten.join(', ') || 'none'}.\n\n${build.agent.summary}`
      : 'The agent has not been run. Any change was made by hand.',
    '',
    '## Changed files',
    '',
    ...(build.changedFiles?.length ? build.changedFiles.map((f) => `- ${f.status} \`${f.path}\` (+${f.added} -${f.removed})`) : ['- None recorded yet.']),
    '',
    '## Unresolved risks',
    '',
    ...(build.risks === null ? ['Not reviewed yet.'] : build.risks.length ? build.risks.map((r) => `- **${r.kind.replace(/_/g, ' ')}**: ${r.detail}`) : ['None found by the automatic review.']),
    ...(build.note ? ['', `**Note:** ${build.note}`] : []),
    '',
    '## Next step',
    '',
    build.status === 'completed'
      ? `The change is committed${build.resultCommit ? ` as \`${build.resultCommit.slice(0, 12)}\`` : ''} on branch \`${build.branch}\` in \`${build.worktree}\`. Review it and merge it yourself, for example \`git merge ${build.branch}\` in the repository.`
      : build.status === 'abandoned'
        ? `Abandoned. The worktree is still at \`${build.worktree ?? '-'}\`; remove it with \`git worktree remove\` when you no longer need it.`
        : 'Not finished.',
    '',
  ];
  return out.join('\n');
}
