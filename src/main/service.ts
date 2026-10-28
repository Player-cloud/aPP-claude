// Main-process side of the IPC contract. Kept free of Electron imports so it
// can be unit-tested with plain Node. Every argument from the renderer is
// treated as untrusted and validated here, the security boundary (ARCH §3.2):
// UI controls are not relied on for authorization or validation.

import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_MODEL, ClaudeModel, type ClaudeClient } from '../core/agents/claude.ts';
import { SimulatedModel, type ModelAdapter } from '../core/agents/model.ts';
import { Orchestrator } from '../core/agents/orchestrator.ts';
import { Planner } from '../core/planner.ts';
import { IapError, StateCorruptError, StateTooNewError, ValidationError } from '../core/errors.ts';
import { defaultScanRoots, type ScanRoots } from '../core/inventory.ts';
import { appPaths } from '../core/paths.ts';
import { runToolScan } from '../core/tools.ts';
import { allowedTransitions, isRunState } from '../core/workflow.ts';
import { moveCorruptStateAside, Workspace, type Fact, type WorkflowRun } from '../core/workspace.ts';
import type { AgentStatus, AppStatus, IapApi, Result, RunWithNext } from '../shared/api.ts';
import { MemoryKeyStore, type KeyStore } from './keystore.ts';

// Most handlers answer synchronously; the agent and planning drafts wait for (simulated) model calls.
type AsyncMethod = 'runAgent' | 'draftBrief' | 'draftSpec';
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

  constructor(home: string, version: string, options: ServiceOptions = {}) {
    this.home = home;
    this.version = version;
    this.scanRoots = options.scanRoots ?? (() => defaultScanRoots());
    this.keys = options.keyStore ?? new MemoryKeyStore();
    this.claudeClient = options.claudeClient ?? ((apiKey) => new Anthropic({ apiKey, maxRetries: 1 }));
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
