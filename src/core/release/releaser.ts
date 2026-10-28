// Release candidates and the ship-check (M7: FR-QA-001, FR-QA-004, FR-SHIP-001, DEC-022).
//
//   define (person: version, plan, checks, included work) → check: release
//   checks on the repository's current commit in an app-owned detached
//   worktree, secrets scan, evidence gathered, gates evaluated → classify drift
//   or record exceptions (person) → prepare
//
// "Prepared" means the gates passed (or were knowingly excepted) on a known
// commit. It is release preparation only: nothing here deploys, tags, pushes
// or publishes. Deployment is a separate step with its own approval.

import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotFoundError, ValidationError } from '../errors.ts';
import { credentialLines, redactString } from '../redact.ts';
import type { Release, ReleaseCheckRun, Workspace } from '../workspace.ts';
import { normalizeChecks, runCheck, type Check, type CheckResult } from '../build/checks.ts';
import { addDetachedWorktree, inspectRepo, isAncestor, resetDetachedWorktree, trackedFiles } from '../build/git.ts';
import { GATE_IDS, blockingGates, evaluateGates, type Gate, type GateException, type IncludedBuild, type ReleaseEvidence, type ReleasePlan } from './gates.ts';

export interface ReleaseInput {
  version: string;
  plan: Partial<ReleasePlan>;
  checks: Check[];
  buildIds: string[];
}

export interface ReleaseDetail {
  release: Release;
  checkRuns: ReleaseCheckRun[];
  exceptions: GateException[];
  /** Required gates that stop the release from being prepared. Empty when it can be. */
  blocking: string[];
}

const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_SCAN_BYTES = 1_000_000;
const MAX_SCAN_FILES = 20_000;

const busy = new Set<string>();

export class Releaser {
  private readonly ws: Workspace;
  private readonly checkTimeoutMs: number | undefined;

  constructor(ws: Workspace, options: { checkTimeoutMs?: number } = {}) {
    this.ws = ws;
    this.checkTimeoutMs = options.checkTimeoutMs;
  }

  detail(releaseId: string): ReleaseDetail {
    const release = this.ws.getRelease(releaseId);
    return {
      release,
      checkRuns: this.ws.listReleaseCheckRuns(releaseId),
      exceptions: this.ws.listGateExceptions(releaseId),
      blocking: release.gates ? blockingGates(release.gates).map((g) => g.id) : [],
    };
  }

  create(projectId: string, input: ReleaseInput): Release {
    const project = this.ws.getProject(projectId);
    const version = String(input.version ?? '').trim();
    if (!VERSION.test(version)) throw new ValidationError('Use a version like 1.2.0.');
    const checks = normalizeChecks(input.checks);
    if (!checks.length) throw new ValidationError('Add at least one release check, such as your test command.');
    return this.ws.createRelease({ projectId: project.id, version, plan: plan(input.plan), checks, buildIds: this.buildIds(projectId, input.buildIds) });
  }

  /** Changes the plan or the included work. Gates found earlier no longer apply, so the release goes back to draft. */
  edit(releaseId: string, input: { plan?: Partial<ReleasePlan>; buildIds?: string[] }): Release {
    const r = this.open(releaseId);
    if (busy.has(releaseId)) throw new ValidationError('Wait for the ship-check to finish.');
    return this.ws.updateRelease(
      releaseId,
      {
        plan: input.plan ? plan(input.plan) : r.plan,
        buildIds: input.buildIds ? this.buildIds(r.projectId, input.buildIds) : r.buildIds,
        status: 'draft',
        evidence: null,
        gates: null,
        ready: null,
      },
      { type: 'release.edited', payload: { builds: input.buildIds ?? r.buildIds } },
    );
  }

  /**
   * Runs the ship-check on the repository's current commit. The caller has
   * already asked the person to approve the check commands.
   */
  async check(releaseId: string): Promise<ReleaseDetail> {
    this.open(releaseId);
    if (busy.has(releaseId)) throw new ValidationError('The ship-check is already running.');
    busy.add(releaseId);
    try {
      const r = this.ws.getRelease(releaseId);
      const project = this.ws.getProject(r.projectId);
      if (!project.repoPath) throw new ValidationError('Choose the git repository for this project first.');
      const repo = await inspectRepo(project.repoPath);
      const worktree = r.worktree ?? join(this.ws.paths.worktrees, r.id);
      if (r.worktree) await resetDetachedWorktree(worktree, repo.head);
      else {
        mkdirSync(this.ws.paths.worktrees, { recursive: true });
        await addDetachedWorktree(repo.root, worktree, repo.head);
      }
      // Earlier gates no longer apply while this check runs, even if it fails part way.
      this.ws.updateRelease(releaseId, { status: 'draft', evidence: null, gates: null, ready: null, worktree, commit: repo.head, checksApprovedAt: new Date().toISOString() }, { type: 'release.checking', payload: { commit: repo.head, clean: repo.clean, checks: r.checks.map((c) => c.command) } });

      const checkResults: CheckResult[] = [];
      for (const c of r.checks) {
        const res = await runCheck(worktree, c, { timeoutMs: this.checkTimeoutMs });
        this.ws.recordReleaseCheckRun(releaseId, repo.head, res);
        checkResults.push(res);
      }
      // The checks may have changed files; scan what is committed, not what they left behind.
      await resetDetachedWorktree(worktree, repo.head);
      const flaggedLines = await scanForCredentials(worktree);

      const brief = this.ws.approvedPlanDoc(r.projectId, 'brief');
      const spec = this.ws.approvedPlanDoc(r.projectId, 'spec');
      const evidence: ReleaseEvidence = {
        commit: repo.head,
        spec: spec && spec.kind === 'spec' ? { requirements: spec.content.requirements } : null,
        specOutdated: Boolean(spec && brief && spec.basedOn !== brief.id),
        builds: await this.included(r.buildIds, repo.root, repo.head),
        checksDefined: r.checks.length,
        checkResults: checkResults.map((c) => ({ ...c, output: c.output.slice(-2_000) })),
        flaggedLines,
        reviewTools: reviewTools(this.ws),
      };
      this.evaluate(releaseId, evidence, 'release.checked');
      return this.detail(releaseId);
    } finally {
      busy.delete(releaseId);
    }
  }

  /** The person says a drift finding is deliberate or a planned spec change (FR-QA-001). */
  classify(releaseId: string, requirementId: string, kind: string, note: string): ReleaseDetail {
    const r = this.open(releaseId);
    if (kind !== 'intentional_deviation' && kind !== 'spec_change') throw new ValidationError('Classify a finding as "intentional_deviation" or "spec_change".');
    const finding = r.gates?.find((g) => g.id === 'drift')?.findings?.find((f) => f.requirementId === requirementId);
    if (!finding) throw new ValidationError(`There is no drift finding for ${requirementId}. Run the ship-check first.`);
    const text = reason('Note', note);
    this.ws.updateRelease(releaseId, { classifications: { ...r.classifications, [requirementId]: { kind, note: text } } }, { type: 'release.classified', payload: { requirementId, kind, note: text } });
    if (r.evidence) this.evaluate(releaseId, r.evidence);
    return this.detail(releaseId);
  }

  /** The person accepts a failed or blocked gate, with a reason and a mitigation (FR-QA-004). The record is permanent. */
  addException(releaseId: string, gateId: string, why: string, mitigation: string): ReleaseDetail {
    const r = this.open(releaseId);
    if (!(GATE_IDS as readonly string[]).includes(gateId)) throw new ValidationError(`Unknown gate "${gateId}".`);
    const gate = r.gates?.find((g) => g.id === gateId);
    if (!gate) throw new ValidationError('Run the ship-check first.');
    if (gate.status !== 'failed' && gate.status !== 'blocked') throw new ValidationError('Only a failed or blocked gate needs an exception.');
    this.ws.recordGateException(releaseId, gateId, r.commit!, reason('Reason', why), reason('Mitigation', mitigation));
    if (r.evidence) this.evaluate(releaseId, r.evidence);
    return this.detail(releaseId);
  }

  /**
   * Marks the release prepared: every required gate passed or has an exception,
   * and the repository is still at the checked commit. Nothing is deployed.
   */
  async prepare(releaseId: string): Promise<ReleaseDetail> {
    const r = this.open(releaseId);
    if (busy.has(releaseId)) throw new ValidationError('Wait for the ship-check to finish.');
    if (r.status !== 'checked' || !r.gates || !r.commit) throw new ValidationError('Run the ship-check before preparing the release.');
    const blocking = blockingGates(r.gates);
    if (blocking.length) throw new ValidationError(`These gates block the release: ${blocking.map((g) => g.title).join('; ')}. Fix them, or record an exception with a mitigation.`);
    const project = this.ws.getProject(r.projectId);
    const repo = await inspectRepo(project.repoPath!);
    if (repo.head !== r.commit) throw new ValidationError('The repository has moved on since the ship-check. Run it again on the new commit.');
    const exceptions = r.gates.filter((g) => g.exception).map((g) => g.id);
    this.ws.updateRelease(
      releaseId,
      { status: 'prepared', preparedAt: new Date().toISOString() },
      { type: 'release.prepared', payload: { version: r.version, commit: r.commit, exceptions, deployed: false } },
    );
    this.writeReport(releaseId);
    return this.detail(releaseId);
  }

  abandon(releaseId: string): ReleaseDetail {
    this.open(releaseId);
    if (busy.has(releaseId)) throw new ValidationError('Wait for the ship-check to finish.');
    this.ws.updateRelease(releaseId, { status: 'abandoned' }, { type: 'release.abandoned', payload: {} });
    this.writeReport(releaseId);
    return this.detail(releaseId);
  }

  private open(releaseId: string): Release {
    const r = this.ws.getRelease(releaseId);
    if (r.status === 'prepared' || r.status === 'abandoned') throw new ValidationError(`This release is ${r.status}. Start a new one to change it.`);
    return r;
  }

  private evaluate(releaseId: string, evidence: ReleaseEvidence, eventType?: string): void {
    const r = this.ws.getRelease(releaseId);
    const gates = evaluateGates({
      spec: evidence.spec,
      specOutdated: evidence.specOutdated,
      builds: evidence.builds,
      checks: { defined: evidence.checksDefined, results: evidence.checkResults },
      secrets: evidence.flaggedLines,
      reviewTools: evidence.reviewTools,
      plan: r.plan,
      classifications: r.classifications,
      // An exception is for the commit it was given on; a new commit needs a new decision.
      exceptions: this.ws.listGateExceptions(releaseId).filter((e) => e.commit === evidence.commit),
    });
    const blocking = blockingGates(gates);
    this.ws.updateRelease(
      releaseId,
      { status: 'checked', evidence, gates, ready: blocking.length === 0, checkedAt: eventType ? new Date().toISOString() : r.checkedAt },
      eventType ? { type: eventType, payload: { commit: evidence.commit, gates: gates.map((g) => `${g.id}:${g.status}`), blocking: blocking.map((g) => g.id) } } : undefined,
    );
    this.writeReport(releaseId);
  }

  private buildIds(projectId: string, ids: unknown): string[] {
    if (!Array.isArray(ids)) throw new ValidationError('Choose the work this release includes.');
    const out = [...new Set(ids.map(String))];
    for (const id of out) {
      let b;
      try {
        b = this.ws.getBuild(id);
      } catch (e) {
        if (e instanceof NotFoundError) throw new ValidationError(`Unknown build ${id}.`);
        throw e;
      }
      if (b.projectId !== projectId) throw new ValidationError(`${b.title} belongs to another project.`);
      if (b.status === 'abandoned') throw new ValidationError(`${b.title} was abandoned and cannot be released.`);
    }
    return out;
  }

  private async included(ids: string[], repo: string, head: string): Promise<IncludedBuild[]> {
    const out: IncludedBuild[] = [];
    for (const id of ids) {
      const b = this.ws.getBuild(id);
      const latest = new Map<string, CheckResult>();
      for (const run of this.ws.listCheckRuns(id)) if (run.phase === 'verify') latest.set(run.checkId, run);
      out.push({
        id: b.id,
        title: b.title,
        kind: b.kind,
        status: b.status,
        requirementIds: b.requirementIds,
        verify: [...latest.values()].map(({ checkId, command, status, exitCode, durationMs, output, startedAt }) => ({ checkId, command, status, exitCode, durationMs, output: output.slice(-2_000), startedAt })),
        risks: b.risks ?? [],
        note: b.note,
        merged: b.resultCommit ? await isAncestor(repo, b.resultCommit, head) : false,
        branch: b.branch,
      });
    }
    return out;
  }

  private writeReport(releaseId: string): void {
    const d = this.detail(releaseId);
    const project = this.ws.getProject(d.release.projectId);
    const dir = join(project.workspacePath, 'docs', 'releases');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${d.release.id}.md`);
    writeFileSync(path, renderReleaseReport(d));
    if (d.release.reportPath !== path) this.ws.updateRelease(releaseId, { reportPath: path });
  }
}

/**
 * Lines in tracked files that match a known credential format. Only "path:line"
 * is kept; the value is never stored or shown. Large and binary files are skipped.
 */
export async function scanForCredentials(worktree: string): Promise<string[] | null> {
  let files: string[];
  try {
    files = await trackedFiles(worktree);
  } catch {
    return null;
  }
  const hits: string[] = [];
  for (const rel of files.slice(0, MAX_SCAN_FILES)) {
    const abs = join(worktree, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_SCAN_BYTES) continue;
    const buf = readFileSync(abs);
    if (buf.includes(0)) continue;
    hits.push(...credentialLines(rel, buf.toString('utf8')));
  }
  return [...new Set(hits)];
}

function reviewTools(ws: Workspace): string[] {
  const scan = ws.latestToolScan();
  if (!scan) return [];
  const names = scan.entries.filter((e) => /review|security/i.test(`${e.name} ${e.invocation ?? ''}`)).map((e) => e.invocation ?? e.name);
  return [...new Set(names)].slice(0, 10);
}

function plan(input: Partial<ReleasePlan> | undefined): ReleasePlan {
  const p = input ?? {};
  const field = (label: string, v: unknown) => {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') throw new ValidationError(`${label} must be text.`);
    if (v.length > 2_000) throw new ValidationError(`${label} is longer than 2000 characters.`);
    return v.trim();
  };
  const envVars = p.envVars ?? [];
  if (!Array.isArray(envVars) || envVars.length > 100) throw new ValidationError('List at most 100 configuration names.');
  for (const n of envVars) {
    if (typeof n !== 'string' || !ENV_NAME.test(n)) throw new ValidationError(`"${String(n).slice(0, 40)}" is not a configuration name. List names only, never values.`);
  }
  return {
    target: field('Deployment target', p.target),
    healthCheck: field('Health check', p.healthCheck),
    rollback: field('Rollback', p.rollback),
    monitoring: field('Monitoring', p.monitoring),
    migrations: field('Migrations', p.migrations),
    envVars: [...new Set(envVars as string[])],
  };
}

function reason(label: string, v: unknown): string {
  if (typeof v !== 'string' || v.trim().length < 10) throw new ValidationError(`${label} needs at least 10 characters.`);
  if (v.length > 4_000) throw new ValidationError(`${label} is longer than 4000 characters.`);
  return v.trim();
}

const STATUS_LABEL: Record<Gate['status'], string> = { passed: 'passed', failed: 'FAILED', blocked: 'BLOCKED', skipped: 'skipped' };

export function renderReleaseReport({ release: r, checkRuns, exceptions, blocking }: ReleaseDetail): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = [
    `# Release ${r.version}`,
    '',
    `Status: **${r.status}**. ${r.commit ? `Checked on commit \`${r.commit.slice(0, 12)}\`` : 'Not checked yet'}${r.checkedAt ? ` at ${r.checkedAt}` : ''}.`,
    '',
    'This report is release preparation only. Nothing was deployed, tagged, pushed or published.',
    '',
    '## Gates',
    '',
  ];
  if (!r.gates) lines.push('The ship-check has not run since the release was last changed.');
  else {
    lines.push('| Gate | Required | Result | Summary |', '| --- | --- | --- | --- |');
    for (const g of r.gates) lines.push(`| ${cell(g.title)} | ${g.required ? 'yes' : 'no'} | ${STATUS_LABEL[g.status]}${g.exception ? ' (exception)' : ''} | ${cell(g.summary)} |`);
    for (const g of r.gates) {
      if (!g.evidence.length && !g.findings?.length) continue;
      lines.push('', `### ${g.title}`, '');
      for (const e of g.evidence) lines.push(`- ${e}`);
      for (const f of g.findings ?? []) lines.push(`- **${f.requirementId}** (${f.kind.replace('_', ' ')}): ${f.observed}${f.note ? ` Note: ${f.note}` : ''}`);
    }
  }
  lines.push('', '## Exceptions', '');
  if (!exceptions.length) lines.push('None.');
  for (const e of exceptions) lines.push(`- **${e.gateId}** on \`${e.commit.slice(0, 12)}\`, by ${e.actor} at ${e.at}. Reason: ${e.reason} Mitigation: ${e.mitigation}`);
  lines.push('', '## Release plan', '');
  lines.push(`- Target: ${r.plan.target || '(missing)'}`, `- Health check: ${r.plan.healthCheck || '(missing)'}`, `- Rollback: ${r.plan.rollback || '(missing)'}`);
  lines.push(`- Monitoring: ${r.plan.monitoring || 'not described'}`, `- Migrations: ${r.plan.migrations || 'not described'}`, `- Configuration: ${r.plan.envVars.join(', ') || 'none listed'}`);
  lines.push('', '## Check runs', '');
  if (!checkRuns.length) lines.push('None yet.');
  else {
    lines.push('| Commit | Check | Command | Result | Exit |', '| --- | --- | --- | --- | --- |');
    for (const c of checkRuns) lines.push(`| \`${c.commit.slice(0, 12)}\` | ${cell(c.checkId)} | \`${cell(c.command)}\` | ${c.status === 'passed' ? 'passed' : c.status.toUpperCase()} | ${c.exitCode ?? '-'} |`);
  }
  lines.push('', '## Next step', '');
  if (r.status === 'prepared') lines.push(`Prepared at ${r.preparedAt}. Nothing was deployed. Deploy commit \`${r.commit}\` yourself using the plan above; this app does not deploy.`);
  else if (r.status === 'abandoned') lines.push('Abandoned.');
  else if (r.gates && !blocking.length) lines.push('Every required gate passed or has an exception. The release can be marked prepared.');
  else if (r.gates) lines.push(`Blocked by: ${blocking.join(', ')}. Fix these, or record an exception with a mitigation.`);
  else lines.push('Run the ship-check.');
  return redactString(lines.join('\n')) + '\n';
}
