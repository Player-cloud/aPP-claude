// Quality gate and ship-check (M7: FR-QA-001, FR-QA-004, FR-SHIP-001). The
// gates are deterministic code over evidence the app recorded itself: the
// approved spec, completed builds and their check runs, release check runs on
// the exact release commit, a secrets scan, and the person's release plan.
// Nothing here deploys. A required gate that fails or cannot run blocks the
// release unless the person records an exception with a mitigation plan.
//
// A platform release (M13, DEC-029) checks approved backlog items and updates
// instead of a product specification, adds the protected-changes gate, and
// takes no exceptions.

import type { Requirement } from '../planning.ts';
import { ranNoTests, type CheckResult } from '../build/checks.ts';
import type { Risk } from '../build/review.ts';

export type GateStatus = 'passed' | 'failed' | 'skipped' | 'blocked';
export type Severity = 'critical' | 'high' | 'medium' | 'low';

/** FR-QA-001 finding classes. Only the person can mark a finding as an intentional deviation or a spec change. */
export type DriftKind = 'defect' | 'missing_requirement' | 'intentional_deviation' | 'spec_change' | 'optional_improvement';

export interface DriftFinding {
  requirementId: string;
  kind: DriftKind;
  /** What was observed: which builds implement it, or that none does. */
  observed: string;
  evidence: string[];
  note: string | null;
}

export interface GateException {
  gateId: string;
  /** The commit it was given for. It does not carry over to a later commit. */
  commit: string;
  reason: string;
  mitigation: string;
  actor: string;
  at: string;
}

export interface Gate {
  id: GateId;
  title: string;
  required: boolean;
  status: GateStatus;
  severity: Severity;
  summary: string;
  evidence: string[];
  findings?: DriftFinding[];
  exception?: GateException;
}

export const GATE_IDS = ['spec', 'drift', 'builds', 'risks', 'tests', 'secrets', 'reviews', 'plan', 'protected'] as const;
export type GateId = (typeof GATE_IDS)[number];

export interface ReleasePlan {
  /** Where the release would go, for example "Windows installer on GitHub Releases". */
  target: string;
  /** How to tell the release works once it is out. */
  healthCheck: string;
  /** How to undo or mitigate a bad release. */
  rollback: string;
  monitoring: string;
  /** Database or data migrations, or "none". */
  migrations: string;
  /** Configuration the target needs, by name only (never values). */
  envVars: string[];
}

export interface IncludedBuild {
  id: string;
  title: string;
  kind: 'feature' | 'bugfix' | 'ui_polish';
  status: string;
  requirementIds: string[];
  /** The latest result of each check in the build's last verification. */
  verify: CheckResult[];
  risks: Risk[];
  note: string | null;
  /** True when the build's branch is part of the release commit. */
  merged: boolean;
  branch: string | null;
  /** Platform work (M13): the item it implements, its protected files, and whether the person approved them. */
  source?: { type: 'improvement' | 'update'; id: string; ref: string; title: string } | null;
  protectedFiles?: string[];
  protectedApproved?: boolean;
}

/** For a platform release: where each included item stands now. */
export interface PlatformItems {
  items: { ref: string; title: string; status: string; approved: boolean }[];
}

export interface GateInput {
  spec: { requirements: Requirement[] } | null;
  specOutdated: boolean;
  builds: IncludedBuild[];
  /** Release checks on the release commit; empty when they have not run. */
  checks: { defined: number; results: CheckResult[] };
  /** "path:line" for each line that looks like a credential. Values are never kept. */
  secrets: string[] | null;
  /** Review tools found in the tool inventory (not run). */
  reviewTools: string[];
  plan: ReleasePlan;
  classifications: Record<string, { kind: 'intentional_deviation' | 'spec_change'; note: string }>;
  exceptions: GateException[];
  /** Set for a platform release (M13). */
  platform?: PlatformItems | null;
}

/** The evidence a ship-check gathers. Stored with the release (field names avoid the redactor's secret-looking keys). */
export interface ReleaseEvidence {
  commit: string;
  spec: { requirements: Requirement[] } | null;
  specOutdated: boolean;
  builds: IncludedBuild[];
  checksDefined: number;
  checkResults: CheckResult[];
  /** "path:line" of lines that look like a credential; null when the scan could not run. */
  flaggedLines: string[] | null;
  reviewTools: string[];
  /** Set for a platform release (M13). */
  platform?: PlatformItems | null;
}

const CRITICAL_RISKS = new Set<Risk['kind']>(['regression', 'weakened_test', 'deleted_test']);

export function evaluateGates(input: GateInput): Gate[] {
  const gates: Gate[] = [
    input.platform ? platformItemsGate(input.platform) : specGate(input),
    input.platform ? { id: 'drift', title: 'Specification drift', required: false, severity: 'low', status: 'skipped', summary: 'Platform work follows approved improvements and updates, not a product specification.', evidence: [] } : driftGate(input),
    buildsGate(input),
    risksGate(input),
    testsGate(input),
    secretsGate(input),
    reviewsGate(input),
    planGate(input),
    ...(input.platform ? [protectedGate(input)] : []),
  ];
  for (const g of gates) {
    const ex = [...input.exceptions].reverse().find((e) => e.gateId === g.id);
    if (ex && (g.status === 'failed' || g.status === 'blocked')) g.exception = ex;
  }
  return gates;
}

/** Required gates that failed or could not run, without a recorded exception. */
export function blockingGates(gates: Gate[]): Gate[] {
  return gates.filter((g) => g.required && (g.status === 'failed' || g.status === 'blocked') && !g.exception);
}

function specGate({ spec, specOutdated }: GateInput): Gate {
  const base = { id: 'spec' as const, title: 'Approved specification', required: true, severity: 'high' as const };
  if (!spec) return { ...base, status: 'failed', summary: 'No specification has been approved.', evidence: [] };
  if (specOutdated) return { ...base, status: 'failed', summary: 'The concept brief was revised after the specification was approved.', evidence: [] };
  return { ...base, status: 'passed', summary: `Approved, with ${spec.requirements.length} requirements.`, evidence: [] };
}

function platformItemsGate({ items }: PlatformItems): Gate {
  const base = { id: 'spec' as const, title: 'Approved platform items', required: true, severity: 'high' as const };
  if (!items.length) return { ...base, status: 'failed', summary: 'No platform work is included.', evidence: [] };
  const evidence = items.map((i) => `${i.ref} ${i.title}: ${i.status.replace('_', ' ')}`);
  const bad = items.filter((i) => !i.approved);
  if (bad.length) return { ...base, status: 'failed', summary: `${bad.map((i) => i.ref).join(', ')} ${bad.length === 1 ? 'is' : 'are'} no longer approved.`, evidence };
  return { ...base, status: 'passed', summary: `Every included change implements an item you approved (${items.map((i) => i.ref).join(', ')}).`, evidence };
}

function protectedGate({ builds }: GateInput): Gate {
  const base = { id: 'protected' as const, title: 'Protected changes have your approval', required: true, severity: 'critical' as const };
  const touching = builds.filter((b) => b.protectedFiles?.length);
  const missing = touching.filter((b) => !b.protectedApproved);
  const evidence = touching.map((b) => `${b.title}: ${b.protectedFiles!.join(', ')} (${b.protectedApproved ? 'approved' : 'NOT approved'})`);
  if (missing.length) return { ...base, status: 'failed', summary: `${missing.length} item${missing.length === 1 ? ' changes' : 's change'} permissions, security, release gates, configuration or stored data without your approval.`, evidence };
  return { ...base, status: 'passed', summary: touching.length ? `${touching.length} item${touching.length === 1 ? '' : 's'} with protected changes, all approved.` : 'No protected area is changed.', evidence };
}

function driftGate({ spec, builds, classifications }: GateInput): Gate {
  const base = { id: 'drift' as const, title: 'Specification drift', required: true, severity: 'high' as const };
  if (!spec) return { ...base, status: 'blocked', summary: 'Cannot compare without an approved specification.', evidence: [] };
  const done = builds.filter((b) => b.status === 'completed' && b.kind === 'feature');
  const findings: DriftFinding[] = [];
  for (const r of spec.requirements) {
    const by = done.filter((b) => b.requirementIds.includes(r.id));
    const failing = by.filter((b) => b.verify.some((c) => c.status !== 'passed'));
    const cls = classifications[r.id];
    if (by.length && !failing.length) continue;
    const evidence = by.map((b) => `${b.title} (${b.id})`);
    if (cls) {
      findings.push({ requirementId: r.id, kind: cls.kind, observed: by.length ? 'Implemented with failing checks.' : 'Not implemented by any completed feature.', evidence, note: cls.note });
    } else if (failing.length) {
      findings.push({ requirementId: r.id, kind: 'defect', observed: `Implemented by ${failing.map((b) => b.title).join(', ')}, but its checks fail.`, evidence, note: null });
    } else {
      findings.push({
        requirementId: r.id,
        kind: r.priority === 'MUST' ? 'missing_requirement' : 'optional_improvement',
        observed: `${r.priority} requirement "${r.title}" is not implemented by any completed feature in this release.`,
        evidence: [],
        note: null,
      });
    }
  }
  const significant = findings.filter((f) => f.kind === 'defect' || f.kind === 'missing_requirement');
  return {
    ...base,
    status: significant.length ? 'failed' : 'passed',
    summary: significant.length
      ? `${significant.length} of ${spec.requirements.length} requirements are missing or defective.`
      : findings.length
        ? `No blocking drift; ${findings.length} finding${findings.length === 1 ? '' : 's'} recorded.`
        : 'Every requirement is implemented by a completed, verified feature.',
    evidence: [],
    findings,
  };
}

function buildsGate({ builds }: GateInput): Gate {
  const base = { id: 'builds' as const, title: 'Included work is finished, verified and merged', required: true, severity: 'high' as const };
  if (!builds.length) return { ...base, status: 'failed', summary: 'No completed features or bug fixes are included.', evidence: [] };
  const open = builds.filter((b) => b.status !== 'completed');
  const unverified = builds.filter((b) => b.status === 'completed' && (b.verify.length === 0 || b.verify.some((c) => c.status !== 'passed')));
  const unmerged = builds.filter((b) => b.status === 'completed' && !b.merged);
  const evidence = [
    ...open.map((b) => `${b.title}: ${b.status.replace('_', ' ')}, not finished`),
    ...unverified.map((b) => `${b.title}: last verification ${b.verify.length ? b.verify.map((c) => `${c.checkId} ${c.status}`).join(', ') : 'never ran'}`),
    ...unmerged.map((b) => `${b.title}: branch ${b.branch ?? '?'} is not in the release commit`),
  ];
  if (open.length) return { ...base, status: 'blocked', summary: `${open.length} included item${open.length === 1 ? ' is' : 's are'} not finished.`, evidence };
  if (unverified.length || unmerged.length) return { ...base, status: 'failed', summary: 'Some included work is not verified or not merged.', evidence };
  return { ...base, status: 'passed', summary: `${builds.length} item${builds.length === 1 ? '' : 's'} finished, verified and merged.`, evidence: builds.map((b) => b.title) };
}

function risksGate({ builds }: GateInput): Gate {
  const base = { id: 'risks' as const, title: 'Review findings', required: true };
  const critical = builds.flatMap((b) => b.risks.filter((r) => CRITICAL_RISKS.has(r.kind)).map((r) => `${b.title}: ${r.detail}`));
  const other = builds.flatMap((b) => b.risks.filter((r) => !CRITICAL_RISKS.has(r.kind)).map((r) => `${b.title}: ${r.detail}${b.note ? ` (explained: ${b.note})` : ''}`));
  if (critical.length) return { ...base, severity: 'critical', status: 'failed', summary: `${critical.length} critical finding${critical.length === 1 ? '' : 's'} (regressions or weakened tests).`, evidence: [...critical, ...other] };
  return { ...base, severity: 'medium', status: 'passed', summary: other.length ? `No critical findings; ${other.length} explained risk${other.length === 1 ? '' : 's'}.` : 'No findings.', evidence: other };
}

function testsGate({ checks }: GateInput): Gate {
  const base = { id: 'tests' as const, title: 'Release checks on the release commit', required: true, severity: 'critical' as const };
  if (checks.defined === 0) return { ...base, status: 'failed', summary: 'No release checks are defined.', evidence: [] };
  if (checks.results.length === 0) return { ...base, status: 'blocked', summary: 'The release checks have not run.', evidence: [] };
  const evidence = checks.results.map((r) => `${r.checkId}: ${r.status} (exit ${r.exitCode ?? '-'}) ${r.command}`);
  const bad = checks.results.filter((r) => r.status !== 'passed');
  if (bad.length) return { ...base, status: 'failed', summary: `${bad.length} of ${checks.results.length} checks did not pass.`, evidence };
  const empty = checks.results.filter((r) => ranNoTests(r.output));
  if (empty.length) return { ...base, status: 'failed', summary: `${empty.map((r) => r.checkId).join(', ')} passed but found no tests.`, evidence };
  return { ...base, status: 'passed', summary: `All ${checks.results.length} checks passed.`, evidence };
}

function secretsGate({ secrets }: GateInput): Gate {
  const base = { id: 'secrets' as const, title: 'No credentials in the release files', required: true, severity: 'high' as const };
  if (secrets === null) return { ...base, status: 'blocked', summary: 'The release files have not been scanned.', evidence: [] };
  if (secrets.length) return { ...base, status: 'failed', summary: `${secrets.length} line${secrets.length === 1 ? ' looks' : 's look'} like a credential.`, evidence: secrets.slice(0, 50) };
  return { ...base, status: 'passed', summary: 'No known credential formats found in tracked files.', evidence: [] };
}

function reviewsGate({ reviewTools }: GateInput): Gate {
  // FR-SHIP-001: installed commands are verified before use. None are verified yet, so none run.
  return {
    id: 'reviews',
    title: 'Code review and security review tools',
    required: false,
    severity: 'medium',
    status: 'skipped',
    summary: reviewTools.length
      ? `Found ${reviewTools.join(', ')} in your Claude Code setup, but this app has not verified them, so they did not run.`
      : 'No verified code-review or security-review tool is connected, so none ran.',
    evidence: [],
  };
}

function planGate({ plan }: GateInput): Gate {
  const base = { id: 'plan' as const, title: 'Release plan: target, health check, rollback', required: true, severity: 'high' as const };
  const missing = [!plan.target && 'deployment target', !plan.healthCheck && 'health check', !plan.rollback && 'rollback or mitigation'].filter(Boolean) as string[];
  const notes = [
    `Monitoring: ${plan.monitoring || 'not described'}`,
    `Migrations: ${plan.migrations || 'not described'}`,
    `Configuration: ${plan.envVars.length ? plan.envVars.join(', ') : 'none listed'}`,
  ];
  if (missing.length) return { ...base, status: 'failed', summary: `Missing: ${missing.join(', ')}.`, evidence: notes };
  return { ...base, status: 'passed', summary: `Described for ${plan.target}. The app records the plan; it does not test it.`, evidence: [`Health check: ${plan.healthCheck}`, `Rollback: ${plan.rollback}`, ...notes] };
}
