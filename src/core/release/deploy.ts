// Controlled deployment of a prepared release (M20: FR-SHIP-002, FR-SEC-003,
// DEC-038).
//
//   prepared release with a deploy command → request (what the approval shows)
//   → the person approves, typing the environment's name → verify: the
//   release's own worktree is at the prepared commit and its version matches
//   → deploy command → health checks (a command, or an address that must
//   answer 2xx, retried) → healthy, unhealthy or failed → rollback command
//   when the person approves it
//
// Every step is kept append-only with its output, and the release itself never
// changes. Only the commands written in the prepared plan ever run; the
// renderer cannot supply a command here.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationError } from '../errors.ts';
import { redactString } from '../redact.ts';
import type { Deployment, DeploymentStatus, DeploymentStep, Release, Workspace } from '../workspace.ts';
import { runCheck, type CheckResult } from '../build/checks.ts';
import { git, resetDetachedWorktree } from '../build/git.ts';

export type Fetcher = (url: string, init: { signal: AbortSignal; redirect: 'manual' }) => Promise<{ status: number }>;

export interface DeployRequest {
  releaseId: string;
  environment: string;
  version: string;
  commit: string;
  folder: string;
  deploy: string;
  health: string;
  rollback: string;
  /** Configuration names passed through from the app's environment. */
  envVars: string[];
}

export interface DeploymentDetail {
  deployment: Deployment;
  steps: DeploymentStep[];
  /** What the person can do next. */
  next: ('check_health' | 'rollback')[];
}

const DEFAULT_DEPLOY_TIMEOUT_MS = 30 * 60_000;
const HEALTH_TIMEOUT_MS = 10_000;
const busy = new Set<string>();

export class Deployer {
  private readonly ws: Workspace;
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;
  private readonly healthTries: number;
  private readonly healthDelayMs: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(ws: Workspace, options: { fetcher?: Fetcher; timeoutMs?: number; healthTries?: number; healthDelayMs?: number; env?: NodeJS.ProcessEnv } = {}) {
    this.ws = ws;
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DEPLOY_TIMEOUT_MS;
    this.healthTries = options.healthTries ?? 5;
    this.healthDelayMs = options.healthDelayMs ?? 3_000;
    this.env = options.env ?? process.env;
  }

  /** What a deployment would run, for the approval. Throws when the release cannot be deployed by the app. */
  request(releaseId: string): DeployRequest {
    const r = this.ws.getRelease(releaseId);
    if (r.status !== 'prepared') throw new ValidationError('Prepare the release first: only a release whose gates passed can be deployed.');
    const p = r.plan;
    if (!p.deployCommand) throw new ValidationError('This release has no deploy command, so the app cannot deploy it. Deploy it yourself using its plan.');
    if (!p.environment || !p.rollbackCommand || (!p.healthCommand && !p.healthUrl)) throw new ValidationError('The plan needs an environment, a health check and a rollback command before the app can deploy it.');
    if (!r.worktree || !r.commit) throw new ValidationError('The release has no checked copy of the code. Run the ship-check again.');
    return {
      releaseId: r.id,
      environment: p.environment,
      version: r.version,
      commit: r.commit,
      folder: r.worktree,
      deploy: p.deployCommand,
      health: p.healthUrl || p.healthCommand!,
      rollback: p.rollbackCommand,
      envVars: p.envVars,
    };
  }

  detail(deploymentId: string): DeploymentDetail {
    const deployment = this.ws.getDeployment(deploymentId);
    const next: DeploymentDetail['next'] = [];
    if (deployment.status === 'healthy' || deployment.status === 'unhealthy') next.push('check_health');
    if (['healthy', 'unhealthy', 'failed', 'rollback_failed'].includes(deployment.status)) next.push('rollback');
    return { deployment, steps: this.ws.listDeploymentSteps(deploymentId), next };
  }

  list(releaseId: string): DeploymentDetail[] {
    return this.ws.listDeployments(releaseId).map((d) => this.detail(d.id));
  }

  /**
   * Deploys after the caller has asked the person. `confirmEnvironment` is
   * the name they typed: it must match the plan, so a release meant for one
   * environment is never sent to another by a slip.
   */
  async deploy(releaseId: string, confirmEnvironment: string): Promise<DeploymentDetail> {
    const req = this.request(releaseId);
    if (confirmEnvironment.trim() !== req.environment) throw new ValidationError(`Type the environment's name exactly ("${req.environment}") to deploy to it.`);
    if (busy.has(releaseId)) throw new ValidationError('A deployment of this release is already running.');
    const running = this.ws.listDeployments(releaseId).find((d) => d.status === 'running' || d.status === 'rolling_back');
    if (running) throw new ValidationError('A deployment of this release is still recorded as running. Wait for it, or check its health.');
    busy.add(releaseId);
    try {
      const d = this.ws.createDeployment({ releaseId, environment: req.environment, version: req.version, commit: req.commit });
      const verified = await this.verify(d.id, this.ws.getRelease(releaseId), req);
      if (!verified) return this.finish(d.id, 'failed');
      const deployed = await this.run(d.id, 'deploy', req.folder, req.deploy, req);
      if (deployed.status !== 'passed') return this.finish(d.id, 'failed');
      return this.finish(d.id, (await this.health(d.id, req)) ? 'healthy' : 'unhealthy');
    } finally {
      busy.delete(releaseId);
    }
  }

  /** Monitoring: runs the health check again and records the result. */
  async checkHealth(deploymentId: string): Promise<DeploymentDetail> {
    const d = this.ws.getDeployment(deploymentId);
    if (d.status !== 'healthy' && d.status !== 'unhealthy') throw new ValidationError(`This deployment is ${d.status.replace('_', ' ')}; there is nothing to check.`);
    const req = this.request(d.releaseId);
    return this.exclusive(d.releaseId, async () => this.finish(deploymentId, (await this.health(deploymentId, req, 1)) ? 'healthy' : 'unhealthy'));
  }

  /** Runs the plan's rollback command, after the caller has asked the person. */
  async rollback(deploymentId: string): Promise<DeploymentDetail> {
    const d = this.ws.getDeployment(deploymentId);
    if (!['healthy', 'unhealthy', 'failed', 'rollback_failed'].includes(d.status)) throw new ValidationError(`This deployment is ${d.status.replace('_', ' ')}; it cannot be rolled back.`);
    const req = this.request(d.releaseId);
    return this.exclusive(d.releaseId, async () => {
      this.ws.setDeploymentStatus(deploymentId, 'rolling_back');
      const r = await this.run(deploymentId, 'rollback', req.folder, req.rollback, req);
      return this.finish(deploymentId, r.status === 'passed' ? 'rolled_back' : 'rollback_failed');
    });
  }

  /** The release's copy of the code is moved back to the prepared commit, and the version it says it is matches. */
  private async verify(deploymentId: string, release: Release, req: DeployRequest): Promise<boolean> {
    const started = Date.now();
    const startedAt = new Date().toISOString();
    const lines: string[] = [];
    let ok = true;
    try {
      await resetDetachedWorktree(req.folder, req.commit);
      const head = (await git(req.folder, ['rev-parse', 'HEAD'])).trim();
      if (head !== req.commit) {
        ok = false;
        lines.push(`The release folder is at ${head.slice(0, 12)}, not the prepared commit ${req.commit.slice(0, 12)}.`);
      } else lines.push(`At the prepared commit ${req.commit.slice(0, 12)}.`);
      const pkg = packageVersion(req.folder);
      const want = release.version.replace(/^v/, '');
      if (pkg && pkg !== want) {
        ok = false;
        lines.push(`package.json says version ${pkg}, but the release is ${want}.`);
      } else lines.push(pkg ? `package.json version ${pkg} matches the release.` : 'No package.json version to compare; the commit identifies the release.');
      lines.push(`Environment: ${req.environment} (typed by the person to approve).`);
    } catch (e) {
      ok = false;
      lines.push(`Could not check the release folder: ${(e as Error).message}`);
    }
    this.ws.recordDeploymentStep(deploymentId, { kind: 'verify', target: `${req.environment} ${release.version} @ ${req.commit.slice(0, 12)}`, status: ok ? 'passed' : 'failed', exitCode: null, durationMs: Date.now() - started, output: lines.join('\n'), startedAt });
    return ok;
  }

  private async run(deploymentId: string, kind: 'deploy' | 'rollback' | 'health', folder: string, command: string, req: DeployRequest): Promise<CheckResult> {
    const env: Record<string, string> = { IAP_RELEASE_VERSION: req.version, IAP_RELEASE_COMMIT: req.commit, IAP_ENVIRONMENT: req.environment };
    // The configuration the plan names is passed through, even names the checks would hide (DEC-038).
    for (const name of req.envVars) if (this.env[name] !== undefined) env[name] = this.env[name]!;
    const r = await runCheck(folder, { id: kind, command }, { timeoutMs: kind === 'health' ? HEALTH_TIMEOUT_MS * 6 : this.timeoutMs, env });
    this.ws.recordDeploymentStep(deploymentId, { kind, target: command, status: r.status, exitCode: r.exitCode, durationMs: r.durationMs, output: r.output, startedAt: r.startedAt });
    return r;
  }

  /** The health check, tried until it passes or the tries run out. Every try is kept. */
  private async health(deploymentId: string, req: DeployRequest, tries = this.healthTries): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, this.healthDelayMs));
      const ok = req.health.match(/^https?:\/\//i) ? await this.probe(deploymentId, req.health) : (await this.run(deploymentId, 'health', req.folder, req.health, req)).status === 'passed';
      if (ok) return true;
    }
    return false;
  }

  private async probe(deploymentId: string, url: string): Promise<boolean> {
    const started = Date.now();
    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    let status: DeploymentStep['status'] = 'failed';
    let code: number | null = null;
    let output: string;
    try {
      const res = await this.fetcher(url, { signal: controller.signal, redirect: 'manual' });
      code = res.status;
      status = res.status >= 200 && res.status < 300 ? 'passed' : 'failed';
      output = `HTTP ${res.status}`;
    } catch (e) {
      status = controller.signal.aborted ? 'timed_out' : 'error';
      output = controller.signal.aborted ? `No answer within ${HEALTH_TIMEOUT_MS / 1000} s.` : `Could not reach it: ${redactString((e as Error).message)}`;
    } finally {
      clearTimeout(timer);
    }
    this.ws.recordDeploymentStep(deploymentId, { kind: 'health', target: url, status, exitCode: code, durationMs: Date.now() - started, output, startedAt });
    return status === 'passed';
  }

  private finish(deploymentId: string, status: DeploymentStatus): DeploymentDetail {
    if (this.ws.getDeployment(deploymentId).status !== status) this.ws.setDeploymentStatus(deploymentId, status);
    return this.detail(deploymentId);
  }

  private async exclusive<T>(releaseId: string, fn: () => Promise<T>): Promise<T> {
    if (busy.has(releaseId)) throw new ValidationError('Another deployment step of this release is running. Wait for it to finish.');
    busy.add(releaseId);
    try {
      return await fn();
    } finally {
      busy.delete(releaseId);
    }
  }
}

function packageVersion(folder: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** The lines the approval dialog shows (FR-SEC-003: the person sees exactly what will run, where). */
export function approvalLines(req: DeployRequest): string[] {
  return [
    `Environment: ${req.environment}`,
    `Version: ${req.version} (commit ${req.commit.slice(0, 12)})`,
    `Runs in: ${req.folder}`,
    '',
    `Deploy: ${req.deploy}`,
    `Then checks: ${req.health}`,
    `If it goes wrong, you can run: ${req.rollback}`,
    ...(req.envVars.length ? ['', `Passes these settings from your environment: ${req.envVars.join(', ')}`] : []),
  ];
}
