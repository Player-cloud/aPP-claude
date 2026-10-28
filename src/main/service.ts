// Main-process side of the IPC contract. Kept free of Electron imports so it
// can be unit-tested with plain Node. Every argument from the renderer is
// treated as untrusted and validated here, the security boundary (ARCH §3.2):
// UI controls are not relied on for authorization or validation.

import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_MODEL, ClaudeModel, type ClaudeClient } from '../core/agents/claude.ts';
import { SimulatedModel, type ModelAdapter } from '../core/agents/model.ts';
import { Orchestrator } from '../core/agents/orchestrator.ts';
import { Planner } from '../core/planner.ts';
import { Builder, type BuildInput } from '../core/build/builder.ts';
import { Releaser, type ReleaseInput } from '../core/release/releaser.ts';
import type { ReleasePlan } from '../core/release/gates.ts';
import { Assessor } from '../core/assess/assessor.ts';
import { CAPABILITIES, CATEGORIES } from '../core/assess/capabilities.ts';
import { REFERENCE_KINDS, Studio, type ReferenceEdit } from '../core/studio/library.ts';
import { Backlog, type ImprovementStatus } from '../core/iterate/backlog.ts';
import { Cleanup, claudeRunner, type CleanupPlan } from '../core/cleanup/cleanup.ts';
import { IapError, StateCorruptError, StateTooNewError, ValidationError } from '../core/errors.ts';
import { defaultScanRoots, type ScanRoots } from '../core/inventory.ts';
import { appPaths } from '../core/paths.ts';
import { runToolScan } from '../core/tools.ts';
import { allowedTransitions, isRunState } from '../core/workflow.ts';
import { moveCorruptStateAside, Workspace, type Fact, type WorkflowRun } from '../core/workspace.ts';
import type { AgentStatus, AppStatus, IapApi, Result, RunWithNext } from '../shared/api.ts';
import { MemoryKeyStore, type KeyStore } from './keystore.ts';

// Most handlers answer synchronously; the agent and planning drafts wait for (simulated) model calls.
type AsyncMethod = 'runCleanup' | 'restoreCleanup' | 'runAgent' | 'draftBrief' | 'draftSpec' | 'setProjectRepo' | 'initProjectRepo' | 'startBuild' | 'runBuildAgent' | 'verifyBuild' | 'completeBuild' | 'buildDiff' | 'checkRelease' | 'prepareRelease' | 'importProject' | 'runAssessment' | 'importReferences' | 'suggestReference';
type Handlers = { [K in keyof IapApi]: (...args: unknown[]) => K extends AsyncMethod ? ReturnType<IapApi[K]> : Awaited<ReturnType<IapApi[K]>> };

function str(value: unknown, label: string, optional = false): string | undefined {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw new ValidationError(`${label} is required.`);
  }
  if (typeof value !== 'string') throw new ValidationError(`${label} must be text.`);
  return value;
}

function obj(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function facts(value: unknown): Fact[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 200) throw new ValidationError('Facts must be a list of at most 200 items.');
  return value.map((item) => {
    const f = obj(item, 'Fact');
    return { kind: str(f.kind, 'Fact kind') as Fact['kind'], text: str(f.text, 'Fact text')! };
  });
}

/** Anthropic API keys start with this; anything else is rejected before it is stored. */
const API_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;

export interface ServiceOptions {
  scanRoots?: () => ScanRoots;
  keyStore?: KeyStore;
  /** Builds the API client from the stored key. Tests pass a fake so no real call is ever made. */
  claudeClient?: (apiKey: string) => ClaudeClient;
  /**
   * Asks the person, outside the renderer, before a build's check commands
   * first run (M6). The desktop app shows a native dialog; a renderer cannot
   * approve commands by itself.
   */
  confirmChecks?: (request: { title: string; commands: string[]; folder: string }) => Promise<boolean>;
  checkTimeoutMs?: number;
  /**
   * Lets the person pick reference files in a native dialog (M9). The renderer
   * never supplies a path, so a page cannot make the app read a file the
   * person did not choose. Returns nothing when the person cancels.
   */
  pickFiles?: () => Promise<string[]>;
  /**
   * Asks the person, outside the renderer, before a tool cleanup changes their
   * Claude Code setup (M11). The desktop app shows a native dialog.
   */
  confirmCleanup?: (request: { title: string; lines: string[] }) => Promise<boolean>;
  /** Replaces the `claude` executable. Tests pass a stand-in; the app finds claude on PATH. */
  claudeCommand?: string[];
}

/** What the native approval dialog shows: the exact command or move, and what else changes. */
function cleanupLines(p: CleanupPlan): string[] {
  const d = p.dryRun;
  return [
    ...(d.command ? [`Runs: ${d.command.display}`, `In: ${d.command.cwd}`] : []),
    ...(d.move ? [`Moves: ${d.move.from}`, `To: ${d.move.to}`] : []),
    ...d.targets.map((t) => `Changes: ${t}`),
    ...(d.dependents.length ? [`Also affects ${d.dependents.length}: ${d.dependents.slice(0, 6).map((x) => x.label).join(', ')}${d.dependents.length > 6 ? ', …' : ''}`] : []),
    ...d.workflows.map((w) => `Workflow: ${w}`),
    ...d.risks.map((r) => `Risk: ${r}`),
    ...d.recovery.map((r) => `Undo: ${r}`),
  ];
}

/** A build definition from the renderer. Contents are validated in builder.ts. */
function ids(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 200 || v.some((x) => typeof x !== 'string')) throw new ValidationError('Choose the work this release includes.');
  return v as string[];
}

function releaseInput(i: Record<string, unknown>): ReleaseInput {
  return {
    version: str(i.version, 'Version')!,
    plan: (i.plan === undefined ? {} : obj(i.plan, 'Release plan')) as Partial<ReleasePlan>,
    checks: i.checks as ReleaseInput['checks'],
    buildIds: i.buildIds === undefined ? [] : ids(i.buildIds),
  };
}

function buildInput(value: unknown): BuildInput {
  const i = obj(value, 'Build');
  const strings = (v: unknown, label: string) => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new ValidationError(`${label} must be a list of text items.`);
    return v as string[];
  };
  return {
    kind: str(i.kind, 'Kind') as BuildInput['kind'],
    title: str(i.title, 'Title')!,
    goal: str(i.goal, 'Goal')!,
    requirementIds: strings(i.requirementIds, 'Requirement IDs'),
    components: strings(i.components, 'Components'),
    checks: i.checks as BuildInput['checks'],
    repro: str(i.repro, 'Reproduction steps', true) ?? null,
    referenceIds: strings(i.referenceIds, 'References'),
    motion: i.motion === undefined ? undefined : (i.motion as boolean),
  };
}

const withNext = (run: WorkflowRun): RunWithNext => ({ ...run, next: allowedTransitions(run.state, run.blockedFrom) });

export class AppService {
  private ws: Workspace | null = null;
  private openError: IapError | null = null;
  private readonly home: string;
  private readonly version: string;
  private readonly scanRoots: () => ScanRoots;
  private readonly keys: KeyStore;
  private readonly claudeClient: (apiKey: string) => ClaudeClient;
  private readonly confirmChecks: NonNullable<ServiceOptions['confirmChecks']>;
  private readonly confirmCleanup: NonNullable<ServiceOptions['confirmCleanup']>;
  private readonly claudeCommand: string[] | undefined;
  private readonly checkTimeoutMs: number | undefined;
  private readonly pickFiles: () => Promise<string[]>;

  constructor(home: string, version: string, options: ServiceOptions = {}) {
    this.home = home;
    this.version = version;
    this.scanRoots = options.scanRoots ?? (() => defaultScanRoots());
    this.keys = options.keyStore ?? new MemoryKeyStore();
    this.claudeClient = options.claudeClient ?? ((apiKey) => new Anthropic({ apiKey, maxRetries: 1 }));
    // Without a way to ask (plain Node, tests), commands never run unless a caller supplies one.
    this.confirmChecks = options.confirmChecks ?? (async () => false);
    this.confirmCleanup = options.confirmCleanup ?? (async () => false);
    this.claudeCommand = options.claudeCommand;
    this.checkTimeoutMs = options.checkTimeoutMs;
    this.pickFiles = options.pickFiles ?? (async () => []);
    this.tryOpen();
  }

  agentStatus(): AgentStatus {
    const ws = this.workspace();
    const budgetUsd = ws.monthlyBudgetUsd();
    const keyStored = this.keys.has();
    const mode = budgetUsd === null ? 'simulated' : keyStored ? 'claude' : 'needs_key';
    return {
      mode,
      model: mode === 'claude' ? CLAUDE_MODEL : 'simulated',
      budgetUsd,
      spentUsd: ws.spentThisMonth(),
      keyStored,
      keyStorageAvailable: this.keys.available(),
    };
  }

  /** For reads and edits that never call a model. */
  private planner(): Planner {
    return new Planner(this.workspace(), new SimulatedModel());
  }

  /** For drafting: the same model choice as the agent. */
  private agentPlanner(): Planner {
    return new Planner(this.workspace(), this.agentModel());
  }

  private builder(model: ModelAdapter = new SimulatedModel()): Builder {
    return new Builder(this.workspace(), model, { checkTimeoutMs: this.checkTimeoutMs });
  }

  /** Starts a build after the person approves its commands in a dialog the renderer cannot answer. */
  private releaser(): Releaser {
    return new Releaser(this.workspace(), { checkTimeoutMs: this.checkTimeoutMs });
  }

  /** The ship-check runs commands, so the person approves them every time it runs. */
  private async checkRelease(releaseId: string) {
    const ws = this.workspace();
    const release = ws.getRelease(releaseId);
    const project = ws.getProject(release.projectId);
    if (!project.repoPath) throw new ValidationError('Choose the git repository for this project first.');
    const approved = await this.confirmChecks({ title: `Ship-check for release ${release.version}`, commands: release.checks.map((c) => c.command), folder: project.repoPath });
    if (!approved) throw new ValidationError('The check commands were not approved, so nothing ran.');
    return this.releaser().check(releaseId);
  }

  private async startBuild(buildId: string) {
    const ws = this.workspace();
    const build = ws.getBuild(buildId);
    if (build.status !== 'draft') throw new ValidationError('This work has already started.');
    const project = ws.getProject(build.projectId);
    const approved = await this.confirmChecks({ title: build.title, commands: build.checks.map((c) => c.command), folder: project.repoPath ?? project.workspacePath });
    if (!approved) throw new ValidationError('The check commands were not approved, so nothing ran.');
    return this.builder().start(buildId);
  }

  /** Real calls need both a budget and a key; otherwise the simulated model runs and says so. */
  private agentModel(): ModelAdapter {
    const status = this.agentStatus();
    if (status.mode === 'simulated') return new SimulatedModel();
    const key = this.keys.get();
    if (!key) {
      throw new ValidationError('A monthly budget is set but no API key is stored. Add your Anthropic API key in Settings → AI usage, or choose "No real calls" to use the simulated agent.');
    }
    return new ClaudeModel(this.claudeClient(key));
  }

  /** For the main process's reference protocol only: the app's copy of a reference and its type. Never exposed over IPC. */
  referenceFile(id: string): { path: string; mediaType: string } | null {
    if (!/^ref_[0-9a-f-]{36}$/.test(id) || !this.ws) return null;
    try {
      const r = this.ws.getReference(id);
      return { path: r.storedPath, mediaType: r.mediaType };
    } catch {
      return null;
    }
  }

  private tryOpen(): void {
    try {
      this.ws = Workspace.open(this.home);
      this.openError = null;
    } catch (e) {
      if (e instanceof StateCorruptError || e instanceof StateTooNewError) {
        this.ws = null;
        this.openError = e;
      } else {
        throw e;
      }
    }
  }

  private workspace(): Workspace {
    if (!this.ws) throw this.openError ?? new IapError('UNAVAILABLE', 'Workspace is not open.');
    return this.ws;
  }

  private cleanup(): Cleanup {
    return new Cleanup(this.workspace(), this.scanRoots(), claudeRunner(this.claudeCommand));
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  status(): AppStatus {
    const paths = appPaths(this.home);
    const state = this.ws ? 'ready' : this.openError instanceof StateTooNewError ? 'too_new' : 'corrupt';
    return { state, message: this.openError?.message ?? null, dataDir: paths.home, dbPath: paths.db, version: this.version };
  }

  readonly handlers: Handlers = {
    status: () => wrap(() => this.status()),
    recover: (confirm) =>
      wrap(() => {
        if (confirm !== true) throw new ValidationError('Recovery must be explicitly confirmed.');
        if (this.ws) throw new ValidationError('The database is healthy; there is nothing to recover.');
        if (this.openError instanceof StateTooNewError) {
          throw new ValidationError('This database was written by a newer version. Upgrade the app instead of recovering.');
        }
        const movedTo = moveCorruptStateAside(this.home);
        this.tryOpen();
        return { movedTo };
      }),
    listProjects: () => wrap(() => this.workspace().listProjects()),
    getProject: (id) => wrap(() => this.workspace().getProject(str(id, 'Project id')!)),
    createProject: (input) =>
      wrap(() => {
        const i = obj(input, 'Project');
        return this.workspace().createProject({
          name: str(i.name, 'Project name')!,
          idea: str(i.idea, 'Idea', true),
          facts: facts(i.facts),
        });
      }),
    listRuns: (projectId) => wrap(() => this.workspace().listRuns(str(projectId, 'Project id')).map(withNext)),
    startRun: (input) =>
      wrap(() => {
        const i = obj(input, 'Run');
        return withNext(
          this.workspace().startRun({
            projectId: str(i.projectId, 'Project id')!,
            workflow: str(i.workflow, 'Workflow')!,
            title: str(i.title, 'Title', true),
          }),
        );
      }),
    moveRun: (input) =>
      wrap(() => {
        const i = obj(input, 'Transition');
        const to = str(i.to, 'Target state')!;
        if (!isRunState(to)) throw new ValidationError(`Unknown state "${to}".`);
        return withNext(
          this.workspace().transitionRun(str(i.runId, 'Run id')!, {
            to,
            reason: str(i.reason, 'Reason', true),
            resolution: str(i.resolution, 'Resolution', true),
          }),
        );
      }),
    listEvents: (filter) =>
      wrap(() => {
        const f = filter === undefined ? {} : obj(filter, 'Filter');
        const limit = f.limit === undefined ? 200 : f.limit;
        if (typeof limit !== 'number' || !Number.isInteger(limit)) throw new ValidationError('Limit must be a whole number.');
        return this.workspace().listEvents({ projectId: str(f.projectId, 'Project id', true), limit });
      }),
    getSettings: () => wrap(() => this.workspace().getSettings()),
    updateSetting: (input) =>
      wrap(() => {
        const i = obj(input, 'Setting');
        return this.workspace().updateSetting(str(i.key, 'Setting key')!, str(i.value, 'Setting value')!);
      }),
    health: () => wrap(() => this.workspace().health()),
    // The renderer cannot choose what is scanned: locations come from the main process only.
    scanTools: () => wrap(() => this.workspace().saveToolScan(runToolScan(this.scanRoots()))),
    getToolScan: () => wrap(() => this.workspace().latestToolScan()),
    // Tool cleanup (M11). Planning changes nothing; running or restoring asks the person in a native dialog first.
    cleanupOptions: (input) =>
      wrap(() => {
        const i = obj(input, 'Tool');
        return this.cleanup().options(str(i.entryId, 'Tool id')!, str(i.findingId, 'Finding id', true) ?? null);
      }),
    planCleanup: (input) =>
      wrap(() => {
        const i = obj(input, 'Plan');
        return this.cleanup().plan(str(i.entryId, 'Tool id')!, str(i.action, 'Action')!, str(i.findingId, 'Finding id', true) ?? null);
      }),
    runCleanup: (input) =>
      wrapAsync(async () => {
        const i = obj(input, 'Run');
        const plan = this.workspace().getCleanupPlan(str(i.planId, 'Plan id')!);
        const cleanup = this.cleanup();
        if (plan.mechanism !== 'record' && plan.status === 'planned') {
          if (plan.dryRun.needsAcceptance && i.acceptDependencies !== true) throw new ValidationError('Other tools or workflows depend on this. Accept that they are affected, or choose another option.');
          const approved = await this.confirmCleanup({ title: `${plan.action === 'uninstall' ? 'Uninstall' : 'Switch off'} ${plan.entry.invocation ?? plan.entry.name}?`, lines: cleanupLines(plan) });
          if (!approved) throw new ValidationError('Not approved. Nothing was changed.');
        }
        return cleanup.execute(plan.id, { acceptDependencies: i.acceptDependencies === true, reason: str(i.reason, 'Reason', true) ?? null });
      }),
    restoreCleanup: (planId) =>
      wrapAsync(async () => {
        const plan = this.workspace().getCleanupPlan(str(planId, 'Plan id')!);
        const what = plan.dryRun.move ? [`Move ${plan.dryRun.move.to} back to ${plan.dryRun.move.from}`] : plan.dryRun.recovery;
        if (!(await this.confirmCleanup({ title: `Restore ${plan.entry.invocation ?? plan.entry.name}?`, lines: what }))) throw new ValidationError('Not approved. Nothing was changed.');
        return this.cleanup().restore(plan.id);
      }),
    cancelCleanup: (planId) => wrap(() => this.cleanup().cancel(str(planId, 'Plan id')!)),
    listCleanups: () => wrap(() => this.workspace().listCleanupPlans()),
    // The renderer cannot grant tools: delegated tasks get none (DEC-017).
    runAgent: (input) =>
      wrapAsync(async () => {
        const i = obj(input, 'Agent request');
        const goal = str(i.goal, 'Goal')!;
        if (goal.length > 4_000) throw new ValidationError('The goal must be at most 4,000 characters.');
        const title = goal.trim().split('\n')[0]!.slice(0, 80);
        return new Orchestrator(this.workspace(), this.agentModel()).run({ runId: str(i.runId, 'Run id')!, title, goal });
      }),
    agentStatus: () => wrap(() => this.agentStatus()),
    // Build work (M6). Definitions are validated in builder.ts; commands only run after the native approval dialog.
    setProjectRepo: (input) =>
      wrapAsync(() => {
        const i = obj(input, 'Repository');
        return this.builder().setRepo(str(i.projectId, 'Project id')!, str(i.path, 'Folder')!);
      }),
    initProjectRepo: (projectId) => wrapAsync(() => this.builder().initProjectRepo(str(projectId, 'Project id')!)),
    listBuilds: (projectId) => wrap(() => this.workspace().listBuilds(str(projectId, 'Project id')!)),
    getBuild: (buildId) => wrap(() => this.builder().detail(str(buildId, 'Build id')!)),
    createBuild: (input) =>
      wrap(() => {
        const i = obj(input, 'Build');
        return this.builder().create(str(i.projectId, 'Project id')!, buildInput(input));
      }),
    editBuild: (input) =>
      wrap(() => {
        const i = obj(input, 'Build');
        return this.builder().edit(str(i.buildId, 'Build id')!, buildInput(input));
      }),
    startBuild: (buildId) => wrapAsync(() => this.startBuild(str(buildId, 'Build id')!)),
    runBuildAgent: (buildId) => wrapAsync(() => this.builder(this.agentModel()).runAgent(str(buildId, 'Build id')!)),
    verifyBuild: (buildId) => wrapAsync(() => this.builder().verify(str(buildId, 'Build id')!)),
    completeBuild: (input) =>
      wrapAsync(async () => {
        const i = obj(input, 'Completion');
        return this.builder().complete(str(i.buildId, 'Build id')!, str(i.note, 'Note', true) ?? null);
      }),
    abandonBuild: (input) =>
      wrap(() => {
        const i = obj(input, 'Abandon');
        return this.builder().abandon(str(i.buildId, 'Build id')!, str(i.reason, 'Reason', true) ?? null);
      }),
    buildDiff: (buildId) => wrapAsync(() => this.builder().diff(str(buildId, 'Build id')!)),
    // Releases (M7). Content is validated in releaser.ts.
    listReleases: (projectId) => wrap(() => this.workspace().listReleases(str(projectId, 'Project id')!)),
    getRelease: (releaseId) => wrap(() => this.releaser().detail(str(releaseId, 'Release id')!)),
    createRelease: (input) =>
      wrap(() => {
        const i = obj(input, 'Release');
        return this.releaser().create(str(i.projectId, 'Project id')!, releaseInput(i));
      }),
    editRelease: (input) =>
      wrap(() => {
        const i = obj(input, 'Release');
        return this.releaser().edit(str(i.releaseId, 'Release id')!, {
          plan: i.plan === undefined ? undefined : (obj(i.plan, 'Release plan') as Partial<ReleasePlan>),
          buildIds: i.buildIds === undefined ? undefined : ids(i.buildIds),
        });
      }),
    checkRelease: (releaseId) => wrapAsync(() => this.checkRelease(str(releaseId, 'Release id')!)),
    classifyDrift: (input) =>
      wrap(() => {
        const i = obj(input, 'Classification');
        return this.releaser().classify(str(i.releaseId, 'Release id')!, str(i.requirementId, 'Requirement')!, str(i.kind, 'Kind')!, str(i.note, 'Note')!);
      }),
    addGateException: (input) =>
      wrap(() => {
        const i = obj(input, 'Exception');
        return this.releaser().addException(str(i.releaseId, 'Release id')!, str(i.gateId, 'Gate')!, str(i.reason, 'Reason')!, str(i.mitigation, 'Mitigation')!);
      }),
    prepareRelease: (releaseId) => wrapAsync(() => this.releaser().prepare(str(releaseId, 'Release id')!)),
    abandonRelease: (releaseId) => wrap(() => this.releaser().abandon(str(releaseId, 'Release id')!)),
    // Import and assessment (M8). Read-only: the scope is validated in assessor.ts, and nothing in the repository runs.
    importProject: (input) =>
      wrapAsync(() => {
        const i = obj(input, 'Import');
        return new Assessor(this.workspace()).importProject({ name: str(i.name, 'Project name')!, path: str(i.path, 'Folder')!, idea: str(i.idea, 'Idea', true) });
      }),
    assessmentCatalog: () =>
      wrap(() => ({ categories: CATEGORIES.map(({ id, title }) => ({ id, title })), capabilities: CAPABILITIES.map(({ id, title, category }) => ({ id, title, category })) })),
    listAssessments: (projectId) => wrap(() => this.workspace().listAssessments(str(projectId, 'Project id')!)),
    getAssessment: (assessmentId) => wrap(() => this.workspace().getAssessment(str(assessmentId, 'Assessment id')!)),
    runAssessment: (input) =>
      wrapAsync(() => {
        const i = obj(input, 'Assessment');
        return new Assessor(this.workspace()).run(str(i.projectId, 'Project id')!, i.scope === undefined ? {} : obj(i.scope, 'Scope'));
      }),
    // Learning Studio (M9). Files come only from the native picker; edits are validated in library.ts.
    importReferences: (input) =>
      wrapAsync(async () => {
        const i = input === undefined ? {} : obj(input, 'Import');
        const projectId = str(i.projectId, 'Project id', true) ?? null;
        const files = await this.pickFiles();
        if (!files.length) return { imported: [], skipped: [] };
        return new Studio(this.workspace(), new SimulatedModel()).importFiles(files, projectId);
      }),
    listReferences: (filter) =>
      wrap(() => {
        const f = filter === undefined ? {} : obj(filter, 'Filter');
        const projectId = f.projectId === null ? null : str(f.projectId, 'Project id', true);
        return new Studio(this.workspace(), new SimulatedModel()).list({ projectId, query: str(f.query, 'Search', true), tag: str(f.tag, 'Tag', true), kind: str(f.kind, 'Kind', true), archived: f.archived === true });
      }),
    getReference: (id) => wrap(() => this.workspace().getReference(str(id, 'Reference id')!)),
    referenceCatalog: () => wrap(() => ({ kinds: [...REFERENCE_KINDS], tags: new Studio(this.workspace(), new SimulatedModel()).tagCounts() })),
    updateReference: (input) =>
      wrap(() => {
        const i = obj(input, 'Reference');
        const edit: ReferenceEdit = {};
        if (i.title !== undefined) edit.title = str(i.title, 'Title')!;
        if (i.kind !== undefined) edit.kind = str(i.kind, 'Kind')!;
        for (const k of ['notes', 'explanation'] as const) if (i[k] !== undefined) edit[k] = i[k] === null ? null : str(i[k], k)!;
        if (i.tags !== undefined) edit.tags = i.tags as string[];
        if (i.projectId !== undefined) edit.projectId = i.projectId === null ? null : str(i.projectId, 'Project id')!;
        return new Studio(this.workspace(), new SimulatedModel()).update(str(i.id, 'Reference id')!, edit);
      }),
    suggestReference: (id) => wrapAsync(() => new Studio(this.workspace(), this.agentModel()).suggest(str(id, 'Reference id')!)),
    acceptReferenceSuggestion: (id) => wrap(() => new Studio(this.workspace(), new SimulatedModel()).acceptSuggestion(str(id, 'Reference id')!)),
    archiveReference: (input) =>
      wrap(() => {
        const i = obj(input, 'Archive');
        return new Studio(this.workspace(), new SimulatedModel()).archive(str(i.id, 'Reference id')!, i.archived !== false);
      }),
    // Iterative Layer (M10). Only the person, through these calls, moves an item; nothing here changes the app.
    improvementsOverview: (filter) =>
      wrap(() => {
        const f = filter === undefined ? {} : obj(filter, 'Filter');
        return new Backlog(this.workspace()).overview({ status: str(f.status, 'Status', true) });
      }),
    getImprovement: (id) => wrap(() => new Backlog(this.workspace()).detail(str(id, 'Improvement id')!)),
    runSelfAssessment: () => wrap(() => new Backlog(this.workspace()).assess()),
    addFeedback: (input) =>
      wrap(() => {
        const i = obj(input, 'Feedback');
        return new Backlog(this.workspace()).feedback({ text: i.text, title: i.title });
      }),
    editImprovement: (input) =>
      wrap(() => {
        const i = obj(input, 'Improvement');
        const backlog = new Backlog(this.workspace());
        const id = str(i.id, 'Improvement id')!;
        const { id: _id, ...fields } = i;
        backlog.edit(id, fields);
        return backlog.detail(id);
      }),
    moveImprovement: (input) =>
      wrap(() => {
        const i = obj(input, 'Move');
        const backlog = new Backlog(this.workspace());
        const id = str(i.id, 'Improvement id')!;
        backlog.move(id, {
          to: str(i.to, 'Status')! as ImprovementStatus,
          reason: str(i.reason, 'Reason', true),
          result: str(i.result, 'Result', true),
          measuredOutcome: str(i.measuredOutcome, 'Measured outcome', true),
        });
        return backlog.detail(id);
      }),
    mergeImprovement: (input) =>
      wrap(() => {
        const i = obj(input, 'Merge');
        const backlog = new Backlog(this.workspace());
        return backlog.detail(backlog.merge(str(i.id, 'Improvement id')!, str(i.into, 'Item to keep')!).id);
      }),
    // Planning (M5). Content is validated in planner.ts; ids are checked to exist.
    getPlanning: (projectId) => wrap(() => this.planner().overview(str(projectId, 'Project id')!)),
    draftBrief: (projectId) => wrapAsync(() => this.agentPlanner().draftBrief(str(projectId, 'Project id')!)),
    draftSpec: (projectId) => wrapAsync(() => this.agentPlanner().draftSpec(str(projectId, 'Project id')!)),
    savePlanDraft: (input) =>
      wrap(() => {
        const i = obj(input, 'Draft');
        const note = i.changeNote === undefined ? undefined : i.changeNote === null ? null : str(i.changeNote, 'Change note')!;
        return this.planner().saveDraft(str(i.docId, 'Document id')!, { content: i.content, changeNote: note });
      }),
    approvePlanDoc: (docId) => wrap(() => this.planner().approve(str(docId, 'Document id')!)),
    revisePlanDoc: (docId) => wrap(() => this.planner().revise(str(docId, 'Document id')!)),
    discardPlanDraft: (docId) => wrap(() => this.planner().discard(str(docId, 'Document id')!)),
    comparePlanDocs: (input) =>
      wrap(() => {
        const i = obj(input, 'Comparison');
        return this.planner().compare(str(i.before, 'Earlier version')!, str(i.after, 'Later version')!);
      }),
    // The key goes in and never comes back out: no handler returns it.
    setApiKey: (input) =>
      wrap(() => {
        const key = str(obj(input, 'API key').key, 'API key')!.trim();
        if (!API_KEY_PATTERN.test(key)) throw new ValidationError('That does not look like an Anthropic API key (it should start with "sk-ant-").');
        if (!this.keys.available()) throw new ValidationError('This computer offers no secure storage, so the key was not saved.');
        this.keys.set(key);
        this.workspace().recordCredentialChange('stored', 'Anthropic API key');
        return this.agentStatus();
      }),
    clearApiKey: () =>
      wrap(() => {
        this.keys.clear();
        this.workspace().recordCredentialChange('removed', 'Anthropic API key');
        return this.agentStatus();
      }),
    listAgentTasks: (runId) => wrap(() => this.workspace().listAgentTasks({ runId: str(runId, 'Run id')! })),
  };
}

function wrap<T>(fn: () => T): Result<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return failure(e);
  }
}

async function wrapAsync<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return failure(e);
  }
}

function failure(e: unknown): { ok: false; error: { code: string; message: string } } {
  if (e instanceof IapError) return { ok: false, error: { code: e.code, message: e.message } };
  // Never leak stack traces or internals to the renderer.
  console.error(e);
  return { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong. Details were written to the application log.' } };
}
