// Contract between the renderer and the main process. The renderer only ever
// sees these types; it never touches the database or filesystem directly.

import type { AuditEvent, Fact, Project, Settings, WorkflowRun } from '../core/workspace.ts';
import type { RunState, Workflow } from '../core/workflow.ts';

export type { AuditEvent, Fact, Project, RunState, Settings, Workflow, WorkflowRun };

export interface ApiError {
  code: string;
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface RunWithNext extends WorkflowRun {
  next: RunState[];
}

export interface AppStatus {
  /** `ready`, or `corrupt`/`too_new` when the database cannot be opened safely. */
  state: 'ready' | 'corrupt' | 'too_new';
  message: string | null;
  dataDir: string;
  dbPath: string;
  version: string;
}

export interface Health {
  schemaVersion: number;
  integrity: string;
  projects: number;
  runs: number;
  events: number;
}

/** Every method the preload bridge exposes as `window.iap`. */
export interface IapApi {
  status(): Promise<Result<AppStatus>>;
  recover(confirm: true): Promise<Result<{ movedTo: string | null }>>;
  listProjects(): Promise<Result<Project[]>>;
  getProject(id: string): Promise<Result<Project>>;
  createProject(input: { name: string; idea?: string; facts?: Fact[] }): Promise<Result<Project>>;
  listRuns(projectId: string): Promise<Result<RunWithNext[]>>;
  startRun(input: { projectId: string; workflow: string; title?: string }): Promise<Result<RunWithNext>>;
  moveRun(input: { runId: string; to: string; reason?: string; resolution?: string }): Promise<Result<RunWithNext>>;
  listEvents(filter: { projectId?: string; limit?: number }): Promise<Result<AuditEvent[]>>;
  getSettings(): Promise<Result<Settings>>;
  updateSetting(input: { key: string; value: string }): Promise<Result<Settings>>;
  health(): Promise<Result<Health>>;
}

export type IapMethod = keyof IapApi;

export const IAP_METHODS = [
  'status',
  'recover',
  'listProjects',
  'getProject',
  'createProject',
  'listRuns',
  'startRun',
  'moveRun',
  'listEvents',
  'getSettings',
  'updateSetting',
  'health',
] as const satisfies readonly IapMethod[];

export const channel = (method: IapMethod) => `iap:${method}`;
