// Main-process side of the IPC contract. Kept free of Electron imports so it
// can be unit-tested with plain Node. Every argument from the renderer is
// treated as untrusted and validated here, the security boundary (ARCH §3.2):
// UI controls are not relied on for authorization or validation.

import { IapError, StateCorruptError, StateTooNewError, ValidationError } from '../core/errors.ts';
import { appPaths } from '../core/paths.ts';
import { allowedTransitions, isRunState } from '../core/workflow.ts';
import { moveCorruptStateAside, Workspace, type Fact, type WorkflowRun } from '../core/workspace.ts';
import type { AppStatus, IapApi, Result, RunWithNext } from '../shared/api.ts';

type Handlers = { [K in keyof IapApi]: (...args: unknown[]) => Awaited<ReturnType<IapApi[K]>> };

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

const withNext = (run: WorkflowRun): RunWithNext => ({ ...run, next: allowedTransitions(run.state, run.blockedFrom) });

export class AppService {
  private ws: Workspace | null = null;
  private openError: IapError | null = null;
  private readonly home: string;
  private readonly version: string;

  constructor(home: string, version: string) {
    this.home = home;
    this.version = version;
    this.tryOpen();
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
  };
}

function wrap<T>(fn: () => T): Result<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    if (e instanceof IapError) return { ok: false, error: { code: e.code, message: e.message } };
    // Never leak stack traces or internals to the renderer.
    console.error(e);
    return { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong. Details were written to the application log.' } };
  }
}
