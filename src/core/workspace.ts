// Persistent workspace (FR-APP-002, FR-PROJ-001, FR-SEC-004).
//
// One SQLite file holds projects, workflow runs and an append-only audit log.
// Each project also gets a directory with a docs/designs/ location (FR-PLAN-001).
// All writes go through this class so validation, redaction and audit events
// cannot be skipped by a caller.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { appPaths, type AppPaths } from './paths.ts';
import { redact, redactString } from './redact.ts';
import { NotFoundError, StateCorruptError, StateTooNewError, ValidationError } from './errors.ts';
import type { ToolScan } from './tools.ts';
import { renderMarkdown, type PlanChange, type PlanDoc, type PlanKind, type PlanStatus } from './planning.ts';
import type { Check, CheckResult } from './build/checks.ts';
import type { ChangedFile } from './build/git.ts';
import type { Risk } from './build/review.ts';
import type { AgentStep } from './build/agent.ts';
import { isWorkflow, planTransition, type RunState, type TransitionInput, type Workflow } from './workflow.ts';

export const SCHEMA_VERSION = 6;

/** Older tool scans beyond this many are pruned; the audit log keeps a record of every scan. */
const KEEP_TOOL_SCANS = 20;

export type FactKind = 'confirmed' | 'assumption';
export interface Fact {
  kind: FactKind;
  text: string;
}

export interface Project {
  id: string;
  name: string;
  origin: 'new' | 'imported';
  status: 'active' | 'archived';
  idea: string | null;
  facts: Fact[];
  workspacePath: string;
  docsPath: string;
  /** The git repository that build work happens in (M6). Null until the person chooses one. */
  repoPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRun {
  id: string;
  projectId: string;
  workflow: Workflow;
  title: string;
  state: RunState;
  blockedFrom: RunState | null;
  blockerReason: string | null;
  blockerResolution: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  seq: number;
  at: string;
  actor: string;
  type: string;
  projectId: string | null;
  runId: string | null;
  payload: Record<string, unknown>;
}

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('new','imported')),
      status TEXT NOT NULL CHECK (status IN ('active','archived')),
      idea TEXT,
      facts TEXT NOT NULL DEFAULT '[]',
      workspace_path TEXT NOT NULL,
      docs_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      workflow TEXT NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      blocked_from TEXT,
      blocker_reason TEXT,
      blocker_resolution TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX runs_project ON runs(project_id);
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      type TEXT NOT NULL,
      project_id TEXT,
      run_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX events_project ON events(project_id);
    CREATE TRIGGER events_no_update BEFORE UPDATE ON events
      BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
    CREATE TRIGGER events_no_delete BEFORE DELETE ON events
      BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
  `,
  2: `
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
  3: `
    CREATE TABLE tool_scans (
      id TEXT PRIMARY KEY,
      scanned_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX tool_scans_at ON tool_scans(scanned_at);
  `,
  4: `
    CREATE TABLE agent_tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES runs(id),
      parent_id TEXT REFERENCES agent_tasks(id),
      kind TEXT NOT NULL CHECK (kind IN ('request','subtask','reconcile')),
      title TEXT NOT NULL,
      spec TEXT NOT NULL,
      status TEXT NOT NULL,
      strategy TEXT,
      rationale TEXT NOT NULL DEFAULT '[]',
      output TEXT,
      failure TEXT,
      resolution TEXT,
      model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX agent_tasks_run ON agent_tasks(run_id);
    CREATE INDEX agent_tasks_parent ON agent_tasks(parent_id);
    CREATE TABLE spend (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      task_id TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL
    );
    CREATE TRIGGER spend_no_update BEFORE UPDATE ON spend
      BEGIN SELECT RAISE(ABORT, 'the spend ledger is append-only'); END;
    CREATE TRIGGER spend_no_delete BEFORE DELETE ON spend
      BEGIN SELECT RAISE(ABORT, 'the spend ledger is append-only'); END;
  `,
  5: `
    CREATE TABLE plan_docs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      kind TEXT NOT NULL CHECK (kind IN ('brief','spec')),
      version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft','approved','superseded','discarded')),
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      change_note TEXT,
      changes TEXT,
      based_on TEXT REFERENCES plan_docs(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      approved_at TEXT,
      UNIQUE (project_id, kind, version)
    );
    -- An approved version is a record of a decision: its content can never change.
    CREATE TRIGGER plan_docs_approved_frozen BEFORE UPDATE OF content, change_note ON plan_docs
      WHEN OLD.status <> 'draft'
      BEGIN SELECT RAISE(ABORT, 'only a draft can be edited'); END;
    CREATE TRIGGER plan_docs_no_delete BEFORE DELETE ON plan_docs
      BEGIN SELECT RAISE(ABORT, 'planning documents are never deleted'); END;
  `,
  6: `
    ALTER TABLE projects ADD COLUMN repo_path TEXT;
    CREATE TABLE builds (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      kind TEXT NOT NULL CHECK (kind IN ('feature','bugfix')),
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      requirement_ids TEXT NOT NULL,
      components TEXT NOT NULL,
      checks TEXT NOT NULL,
      repro TEXT,
      status TEXT NOT NULL CHECK (status IN ('draft','in_progress','review','completed','abandoned')),
      repo_path TEXT,
      branch TEXT,
      worktree TEXT,
      base_commit TEXT,
      agent TEXT,
      changed_files TEXT,
      risks TEXT,
      note TEXT,
      report_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX builds_project ON builds(project_id, created_at);
    -- Check results are evidence (FR-BUILD-002): recorded once, never changed or removed.
    CREATE TABLE check_runs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      build_id TEXT NOT NULL REFERENCES builds(id),
      phase TEXT NOT NULL CHECK (phase IN ('baseline','agent','verify')),
      check_id TEXT NOT NULL,
      command TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('passed','failed','timed_out','error','not_run')),
      exit_code INTEGER,
      duration_ms INTEGER NOT NULL,
      output TEXT NOT NULL,
      started_at TEXT NOT NULL
    );
    CREATE TRIGGER check_runs_no_update BEFORE UPDATE ON check_runs
      BEGIN SELECT RAISE(ABORT, 'check results are append-only'); END;
    CREATE TRIGGER check_runs_no_delete BEFORE DELETE ON check_runs
      BEGIN SELECT RAISE(ABORT, 'check results are append-only'); END;
  `,
};

export type BuildKind = 'feature' | 'bugfix';
export type BuildStatus = 'draft' | 'in_progress' | 'review' | 'completed' | 'abandoned';
export type CheckPhase = 'baseline' | 'agent' | 'verify';

/** What the last agent run on a build did (M6). Its check results are stored as check runs. */
export interface BuildAgentRun {
  model: string;
  status: 'done' | 'blocked' | 'timed_out' | 'failed' | 'turn_limit';
  summary: string;
  steps: AgentStep[];
  filesWritten: string[];
  resolution: string | null;
  costUsd: number;
  at: string;
}

/** One feature or bug fix, worked on in its own git worktree (M6: FR-BUILD-001/003). */
export interface Build {
  id: string;
  projectId: string;
  kind: BuildKind;
  title: string;
  goal: string;
  requirementIds: string[];
  /** Files or folders the change is expected to touch. */
  components: string[];
  /** The commands the person approved. Fixed once work starts. */
  checks: Check[];
  /** For a bug fix: how to reproduce it. */
  repro: string | null;
  status: BuildStatus;
  repoPath: string | null;
  branch: string | null;
  worktree: string | null;
  baseCommit: string | null;
  agent: BuildAgentRun | null;
  changedFiles: ChangedFile[] | null;
  risks: Risk[] | null;
  /** The person's explanation for the risks that remain. */
  note: string | null;
  reportPath: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CheckRun extends CheckResult {
  seq: number;
  buildId: string;
  phase: CheckPhase;
}

export type AgentTaskKind = 'request' | 'subtask' | 'reconcile';
export type AgentTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'blocked' | 'permission_denied' | 'cancelled';

/** What a task may do and what it must return (FR-APP-003: scope, output, permissions, verification). */
export interface AgentTaskSpec {
  goal: string;
  /** Tool names the task may request. Anything else is denied. */
  allowedTools: string[];
  timeoutMs: number;
  maxOutputTokens: number;
  /** How the result is verified before it counts. */
  output: { kind: 'text'; mustInclude: string[] } | { kind: 'json'; requiredKeys: string[] };
}

export interface AgentTask {
  id: string;
  runId: string | null;
  parentId: string | null;
  kind: AgentTaskKind;
  title: string;
  spec: AgentTaskSpec;
  status: AgentTaskStatus;
  strategy: string | null;
  rationale: string[];
  output: string | null;
  failure: string | null;
  resolution: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
}

export type AgentTaskPatch = Partial<Pick<AgentTask, 'status' | 'strategy' | 'rationale' | 'output' | 'failure' | 'resolution' | 'model' | 'inputTokens' | 'outputTokens' | 'costUsd'>>;

function toPlanDoc(row: Record<string, unknown>): PlanDoc {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    kind: row.kind as PlanKind,
    version: row.version as number,
    status: row.status as PlanStatus,
    content: JSON.parse(row.content as string),
    source: row.source as string,
    changeNote: (row.change_note as string | null) ?? null,
    changes: row.changes ? (JSON.parse(row.changes as string) as PlanChange[]) : null,
    basedOn: (row.based_on as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    approvedAt: (row.approved_at as string | null) ?? null,
  } as PlanDoc;
}

function toAgentTask(row: Record<string, unknown>): AgentTask {
  return {
    id: row.id as string,
    runId: (row.run_id as string | null) ?? null,
    parentId: (row.parent_id as string | null) ?? null,
    kind: row.kind as AgentTaskKind,
    title: row.title as string,
    spec: JSON.parse(row.spec as string) as AgentTaskSpec,
    status: row.status as AgentTaskStatus,
    strategy: (row.strategy as string | null) ?? null,
    rationale: JSON.parse(row.rationale as string) as string[],
    output: (row.output as string | null) ?? null,
    failure: (row.failure as string | null) ?? null,
    resolution: (row.resolution as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    inputTokens: row.input_tokens as number,
    outputTokens: row.output_tokens as number,
    costUsd: row.cost_usd as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// Known settings and their allowed values. Unknown keys are rejected so the
// settings table cannot become an unvalidated dumping ground.
export const SETTINGS = {
  theme: { values: ['system', 'dark', 'light'], default: 'dark' },
  glass: { values: ['on', 'off'], default: 'on' },
  // Monthly cap in US dollars for billable model calls. "none" = no real calls (DEC-017).
  budget: { values: ['none', '20', '50', '100'], default: 'none' },
} as const satisfies Record<string, { values: readonly string[]; default: string }>;
export type SettingKey = keyof typeof SETTINGS;
export type Settings = { [K in SettingKey]: (typeof SETTINGS)[K]['values'][number] };

function defaultActor(): string {
  try {
    return userInfo().username || 'local-user';
  } catch {
    return 'local-user';
  }
}

function requireText(label: string, value: string | undefined, max: number): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) throw new ValidationError(`${label} is required.`);
  if (trimmed.length > max) throw new ValidationError(`${label} must be at most ${max} characters.`);
  return trimmed;
}

function optionalText(label: string, value: string | undefined, max: number): string | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;
  if (trimmed.length > max) throw new ValidationError(`${label} must be at most ${max} characters.`);
  return redactString(trimmed);
}

export interface OpenOptions {
  actor?: string;
  now?: () => Date;
}

export class Workspace {
  readonly paths: AppPaths;
  private readonly db: DatabaseSync;
  private readonly actor: string;
  private readonly now: () => Date;

  private constructor(paths: AppPaths, db: DatabaseSync, options: OpenOptions) {
    this.paths = paths;
    this.db = db;
    this.actor = options.actor ?? defaultActor();
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Opens (or on first run, creates) the workspace under `home`.
   * A damaged database raises StateCorruptError and is left untouched.
   */
  static open(home: string, options: OpenOptions = {}): Workspace {
    const paths = appPaths(home);
    mkdirSync(paths.projects, { recursive: true });
    const firstRun = !existsSync(paths.db);

    let db: DatabaseSync;
    try {
      db = new DatabaseSync(paths.db);
    } catch (err) {
      throw new StateCorruptError(paths.db, (err as Error).message);
    }
    try {
      const check = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
      if (check?.quick_check !== 'ok') {
        throw new Error(`integrity check reported: ${check?.quick_check ?? 'no result'}`);
      }
      db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    } catch (err) {
      db.close();
      throw new StateCorruptError(paths.db, (err as Error).message);
    }

    const ws = new Workspace(paths, db, options);
    ws.migrate(firstRun);
    return ws;
  }

  close(): void {
    this.db.close();
  }

  private migrate(firstRun: boolean): void {
    const current = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (current > SCHEMA_VERSION) {
      this.db.close();
      throw new StateTooNewError(this.paths.db, current, SCHEMA_VERSION);
    }
    for (let version = current + 1; version <= SCHEMA_VERSION; version++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version]!);
        this.db.exec(`PRAGMA user_version = ${version}`);
        this.record('schema.migrated', null, null, { from: version - 1, to: version, firstRun });
      });
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private record(type: string, projectId: string | null, runId: string | null, payload: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO events (at, actor, type, project_id, run_id, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(this.timestamp(), this.actor, type, projectId, runId, JSON.stringify(redact(payload)));
  }

  // ---- Projects -----------------------------------------------------------

  createProject(input: { name: string; idea?: string; facts?: Fact[] }): Project {
    const name = requireText('Project name', input.name, 120);
    const idea = optionalText('Idea', input.idea, 10_000);
    const facts = (input.facts ?? []).map((fact) => {
      if (fact.kind !== 'confirmed' && fact.kind !== 'assumption') {
        throw new ValidationError(`Fact kind must be "confirmed" or "assumption", got "${String(fact.kind)}".`);
      }
      return { kind: fact.kind, text: redactString(requireText('Fact', fact.text, 2_000)) };
    });

    const id = `prj_${randomUUID()}`;
    const workspacePath = join(this.paths.projects, id);
    const docsPath = join(workspacePath, 'docs', 'designs');
    const at = this.timestamp();

    mkdirSync(docsPath, { recursive: true });
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO projects (id, name, origin, status, idea, facts, workspace_path, docs_path, created_at, updated_at)
           VALUES (?, ?, 'new', 'active', ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, name, idea, JSON.stringify(facts), workspacePath, docsPath, at, at);
      this.record('project.created', id, null, { name, origin: 'new', facts: facts.length });
    });
    return this.getProject(id);
  }

  getProject(id: string): Project {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError('Project', id);
    return toProject(row);
  }

  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY created_at, id').all() as Record<string, unknown>[]).map(
      toProject,
    );
  }

  // ---- Workflow runs ------------------------------------------------------

  startRun(input: { projectId: string; workflow: string; title?: string }): WorkflowRun {
    const project = this.getProject(input.projectId);
    if (!isWorkflow(input.workflow)) {
      throw new ValidationError(`Unknown workflow "${input.workflow}".`);
    }
    const title = optionalText('Title', input.title, 200) ?? `${input.workflow} run`;
    const id = `run_${randomUUID()}`;
    const at = this.timestamp();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO runs (id, project_id, workflow, title, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
        )
        .run(id, project.id, input.workflow, title, at, at);
      this.record('run.created', project.id, id, { workflow: input.workflow, title, state: 'draft' });
    });
    return this.getRun(id);
  }

  transitionRun(runId: string, input: TransitionInput): WorkflowRun {
    return this.transaction(() => {
      const run = this.getRun(runId);
      const next = planTransition(run, {
        to: input.to,
        reason: input.reason && redactString(input.reason),
        resolution: input.resolution && redactString(input.resolution),
      });
      this.db
        .prepare(
          `UPDATE runs SET state = ?, blocked_from = ?, blocker_reason = ?, blocker_resolution = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(next.state, next.blockedFrom, next.blockerReason, next.blockerResolution, this.timestamp(), runId);
      this.record('run.transitioned', run.projectId, runId, {
        from: run.state,
        to: next.state,
        reason: input.reason?.trim() || null,
        resolution: input.resolution?.trim() || null,
      });
      return this.getRun(runId);
    });
  }

  getRun(id: string): WorkflowRun {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError('Workflow run', id);
    return toRun(row);
  }

  listRuns(projectId?: string): WorkflowRun[] {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY created_at, id').all(projectId)
      : this.db.prepare('SELECT * FROM runs ORDER BY created_at, id').all();
    return (rows as Record<string, unknown>[]).map(toRun);
  }

  // ---- Settings -----------------------------------------------------------

  getSettings(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const out = Object.fromEntries(Object.entries(SETTINGS).map(([k, def]) => [k, def.default])) as Record<string, string>;
    for (const row of rows) {
      const def = (SETTINGS as Record<string, { values: readonly string[] }>)[row.key];
      if (def?.values.includes(row.value)) out[row.key] = row.value;
    }
    return out as Settings;
  }

  updateSetting(key: string, value: string): Settings {
    const def = (SETTINGS as Record<string, { values: readonly string[] }>)[key];
    if (!def) throw new ValidationError(`Unknown setting "${key}".`);
    if (!def.values.includes(value)) {
      throw new ValidationError(`Setting "${key}" must be one of: ${def.values.join(', ')}.`);
    }
    const previous = (this.getSettings() as Record<string, string>)[key];
    if (previous === value) return this.getSettings();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(key, value, this.timestamp());
      this.record('setting.changed', null, null, { key, from: previous, to: value });
    });
    return this.getSettings();
  }

  // ---- Audit log ----------------------------------------------------------

  listEvents(filter: { projectId?: string; runId?: string; limit?: number } = {}): AuditEvent[] {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 10_000);
    const where: string[] = [];
    const params: string[] = [];
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.runId) {
      where.push('run_id = ?');
      params.push(filter.runId);
    }
    const sql = `SELECT * FROM (SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY seq DESC LIMIT ${limit}) ORDER BY seq`;
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map((row) => ({
      seq: Number(row.seq),
      at: String(row.at),
      actor: String(row.actor),
      type: String(row.type),
      projectId: (row.project_id as string | null) ?? null,
      runId: (row.run_id as string | null) ?? null,
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    }));
  }

  /** Read-only health summary for `iap doctor`. */
  // ---- Planning documents (M5) --------------------------------------------
  // Content is validated and redacted by planning.ts before it gets here.

  createPlanDoc(input: { projectId: string; kind: PlanKind; content: PlanDoc['content']; source: string; basedOn: string | null; changeNote: string | null }): PlanDoc {
    const project = this.getProject(input.projectId);
    if (this.openPlanDraft(project.id, input.kind)) {
      throw new ValidationError(`This project already has a ${input.kind} draft. Edit or discard it first.`);
    }
    const id = `plan_${randomUUID()}`;
    const at = this.timestamp();
    const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM plan_docs WHERE project_id = ? AND kind = ?').get(project.id, input.kind) as { v: number };
    const version = row.v + 1;
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO plan_docs (id, project_id, kind, version, status, content, source, change_note, based_on, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, project.id, input.kind, version, JSON.stringify(input.content), input.source, input.changeNote, input.basedOn, at, at);
      this.record('plan.drafted', project.id, null, { docId: id, kind: input.kind, version, source: input.source });
    });
    return this.writePlanFile(this.getPlanDoc(id));
  }

  updatePlanDraft(id: string, patch: { content?: PlanDoc['content']; changeNote?: string | null }): PlanDoc {
    const doc = this.getPlanDoc(id);
    if (doc.status !== 'draft') throw new ValidationError(`Version ${doc.version} is ${doc.status} and cannot be edited. Start a revision instead.`);
    this.db
      .prepare('UPDATE plan_docs SET content = ?, change_note = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(patch.content ?? doc.content), patch.changeNote === undefined ? doc.changeNote : patch.changeNote, this.timestamp(), id);
    return this.writePlanFile(this.getPlanDoc(id));
  }

  /** Approves a draft, supersedes the previously approved version, and records what changed. */
  approvePlanDoc(id: string, changes: PlanChange[] | null, basedOn: string | null): PlanDoc {
    const doc = this.getPlanDoc(id);
    if (doc.status !== 'draft') throw new ValidationError(`Version ${doc.version} is already ${doc.status}.`);
    const previous = this.approvedPlanDoc(doc.projectId, doc.kind);
    const at = this.timestamp();
    this.transaction(() => {
      if (previous) this.db.prepare("UPDATE plan_docs SET status = 'superseded', updated_at = ? WHERE id = ?").run(at, previous.id);
      this.db
        .prepare("UPDATE plan_docs SET status = 'approved', changes = ?, based_on = ?, approved_at = ?, updated_at = ? WHERE id = ?")
        .run(changes ? JSON.stringify(changes) : null, basedOn, at, at, id);
      this.record('plan.approved', doc.projectId, null, {
        docId: id,
        kind: doc.kind,
        version: doc.version,
        ...(previous ? { supersedes: previous.version, changes: changes?.length ?? 0, note: doc.changeNote } : {}),
      });
    });
    if (previous) this.writePlanFile(this.getPlanDoc(previous.id));
    return this.writePlanFile(this.getPlanDoc(id));
  }

  discardPlanDraft(id: string): PlanDoc {
    const doc = this.getPlanDoc(id);
    if (doc.status !== 'draft') throw new ValidationError(`Only a draft can be discarded; version ${doc.version} is ${doc.status}.`);
    this.transaction(() => {
      this.db.prepare("UPDATE plan_docs SET status = 'discarded', updated_at = ? WHERE id = ?").run(this.timestamp(), id);
      this.record('plan.discarded', doc.projectId, null, { docId: id, kind: doc.kind, version: doc.version });
    });
    return this.writePlanFile(this.getPlanDoc(id));
  }

  getPlanDoc(id: string): PlanDoc {
    const row = this.db.prepare('SELECT * FROM plan_docs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError('Planning document', id);
    return toPlanDoc(row);
  }

  /** All versions, newest first. */
  listPlanDocs(projectId: string, kind?: PlanKind): PlanDoc[] {
    this.getProject(projectId);
    const rows = kind
      ? this.db.prepare('SELECT * FROM plan_docs WHERE project_id = ? AND kind = ? ORDER BY version DESC').all(projectId, kind)
      : this.db.prepare('SELECT * FROM plan_docs WHERE project_id = ? ORDER BY kind, version DESC').all(projectId);
    return (rows as Record<string, unknown>[]).map(toPlanDoc);
  }

  openPlanDraft(projectId: string, kind: PlanKind): PlanDoc | null {
    const row = this.db.prepare("SELECT * FROM plan_docs WHERE project_id = ? AND kind = ? AND status = 'draft'").get(projectId, kind) as Record<string, unknown> | undefined;
    return row ? toPlanDoc(row) : null;
  }

  approvedPlanDoc(projectId: string, kind: PlanKind): PlanDoc | null {
    const row = this.db.prepare("SELECT * FROM plan_docs WHERE project_id = ? AND kind = ? AND status = 'approved'").get(projectId, kind) as Record<string, unknown> | undefined;
    return row ? toPlanDoc(row) : null;
  }

  /**
   * Keeps docs/designs/ readable outside the app: every version has its own
   * file under versions/, and brief.md / spec.md hold the approved version.
   */
  private writePlanFile(doc: PlanDoc): PlanDoc {
    const project = this.getProject(doc.projectId);
    const markdown = renderMarkdown(doc, project.name);
    mkdirSync(join(project.docsPath, 'versions'), { recursive: true });
    writeFileSync(join(project.docsPath, 'versions', `${doc.kind}-v${doc.version}.md`), markdown);
    if (doc.status === 'approved') writeFileSync(join(project.docsPath, `${doc.kind}.md`), markdown);
    return doc;
  }

  // ---- Build work (M6) -----------------------------------------------------

  setProjectRepo(projectId: string, repoPath: string | null): Project {
    const project = this.getProject(projectId);
    this.transaction(() => {
      this.db.prepare('UPDATE projects SET repo_path = ?, updated_at = ? WHERE id = ?').run(repoPath, this.timestamp(), project.id);
      this.record('project.repo.set', project.id, null, { repoPath });
    });
    return this.getProject(project.id);
  }

  createBuild(input: { projectId: string; kind: BuildKind; title: string; goal: string; requirementIds: string[]; components: string[]; checks: Check[]; repro: string | null }): Build {
    const project = this.getProject(input.projectId);
    const id = `build_${randomUUID()}`;
    const at = this.timestamp();
    const title = redactString(requireText('Title', input.title, 200));
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO builds (id, project_id, kind, title, goal, requirement_ids, components, checks, repro, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        )
        .run(
          id,
          project.id,
          input.kind,
          title,
          redactString(input.goal),
          JSON.stringify(input.requirementIds),
          JSON.stringify(input.components),
          JSON.stringify(input.checks.map((c) => ({ id: c.id, command: redactString(c.command) }))),
          input.repro === null ? null : redactString(input.repro),
          at,
          at,
        );
      this.record('build.created', project.id, null, { buildId: id, kind: input.kind, title, requirementIds: input.requirementIds, checks: input.checks.map((c) => c.command) });
    });
    return this.getBuild(id);
  }

  getBuild(id: string): Build {
    const row = this.db.prepare('SELECT * FROM builds WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError('Build', id);
    return toBuild(row);
  }

  listBuilds(projectId: string): Build[] {
    this.getProject(projectId);
    return (this.db.prepare('SELECT * FROM builds WHERE project_id = ? ORDER BY created_at DESC, id').all(projectId) as Record<string, unknown>[]).map(toBuild);
  }

  /** Updates a build. Its definition (goal, checks, components) can only change while it is a draft. */
  updateBuild(
    id: string,
    patch: Partial<Pick<Build, 'title' | 'goal' | 'requirementIds' | 'components' | 'checks' | 'repro' | 'status' | 'repoPath' | 'branch' | 'worktree' | 'baseCommit' | 'agent' | 'changedFiles' | 'risks' | 'note' | 'reportPath' | 'completedAt'>>,
    event?: { type: string; payload: Record<string, unknown> },
  ): Build {
    const build = this.getBuild(id);
    const definition = ['title', 'goal', 'requirementIds', 'components', 'checks', 'repro'] as const;
    if (build.status !== 'draft' && definition.some((k) => k in patch)) throw new ValidationError('The task and its checks are fixed once work has started.');
    const n = { ...build, ...patch };
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE builds SET title = ?, goal = ?, requirement_ids = ?, components = ?, checks = ?, repro = ?, status = ?, repo_path = ?, branch = ?, worktree = ?,
             base_commit = ?, agent = ?, changed_files = ?, risks = ?, note = ?, report_path = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          redactString(n.title),
          redactString(n.goal),
          JSON.stringify(n.requirementIds),
          JSON.stringify(n.components),
          JSON.stringify(n.checks.map((c) => ({ id: c.id, command: redactString(c.command) }))),
          n.repro === null ? null : redactString(n.repro),
          n.status,
          n.repoPath,
          n.branch,
          n.worktree,
          n.baseCommit,
          n.agent ? JSON.stringify(redact(n.agent)) : null,
          n.changedFiles ? JSON.stringify(n.changedFiles) : null,
          n.risks ? JSON.stringify(redact(n.risks)) : null,
          n.note === null ? null : redactString(n.note),
          n.reportPath,
          n.completedAt,
          this.timestamp(),
          id,
        );
      if (event) this.record(event.type, build.projectId, null, { buildId: id, ...event.payload });
    });
    return this.getBuild(id);
  }

  recordCheckRun(buildId: string, phase: CheckPhase, r: CheckResult): CheckRun {
    const build = this.getBuild(buildId);
    let seq = 0;
    this.transaction(() => {
      const res = this.db
        .prepare(
          `INSERT INTO check_runs (build_id, phase, check_id, command, status, exit_code, duration_ms, output, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(buildId, phase, r.checkId, redactString(r.command), r.status, r.exitCode, r.durationMs, redactString(r.output), r.startedAt);
      seq = Number(res.lastInsertRowid);
      this.record('build.check', build.projectId, null, { buildId, phase, checkId: r.checkId, status: r.status, exitCode: r.exitCode });
    });
    return this.listCheckRuns(buildId).find((c) => c.seq === seq)!;
  }

  listCheckRuns(buildId: string): CheckRun[] {
    return (this.db.prepare('SELECT * FROM check_runs WHERE build_id = ? ORDER BY seq').all(buildId) as Record<string, unknown>[]).map((row) => ({
      seq: Number(row.seq),
      buildId: String(row.build_id),
      phase: row.phase as CheckPhase,
      checkId: String(row.check_id),
      command: String(row.command),
      status: row.status as CheckResult['status'],
      exitCode: row.exit_code === null ? null : Number(row.exit_code),
      durationMs: Number(row.duration_ms),
      output: String(row.output),
      startedAt: String(row.started_at),
    }));
  }

  // ---- Agent tasks and spend (M3) ----------------------------------------

  createAgentTask(input: { runId: string | null; parentId: string | null; kind: AgentTaskKind; title: string; spec: AgentTaskSpec }): AgentTask {
    if (input.runId) this.getRun(input.runId);
    const id = `task_${randomUUID()}`;
    const at = this.timestamp();
    const title = redactString(requireText('Task title', input.title, 200));
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO agent_tasks (id, run_id, parent_id, kind, title, spec, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        // Only the free-text goal can carry secrets; redact() would also blank keys like maxOutputTokens.
        .run(id, input.runId, input.parentId, input.kind, title, JSON.stringify({ ...input.spec, goal: redactString(input.spec.goal) }), at, at);
      this.record('agent.task.created', this.projectOfRun(input.runId), input.runId, { taskId: id, parentId: input.parentId, kind: input.kind, title });
    });
    return this.getAgentTask(id);
  }

  updateAgentTask(id: string, patch: AgentTaskPatch): AgentTask {
    const task = this.getAgentTask(id);
    const next = { ...task, ...patch };
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE agent_tasks SET status = ?, strategy = ?, rationale = ?, output = ?, failure = ?, resolution = ?, model = ?,
             input_tokens = ?, output_tokens = ?, cost_usd = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          next.status,
          next.strategy,
          JSON.stringify(next.rationale.map(redactString)),
          next.output === null ? null : redactString(next.output),
          next.failure === null ? null : redactString(next.failure),
          next.resolution === null ? null : redactString(next.resolution),
          next.model,
          next.inputTokens,
          next.outputTokens,
          next.costUsd,
          this.timestamp(),
          id,
        );
      if (patch.status && patch.status !== task.status) {
        this.record('agent.task.status', this.projectOfRun(task.runId), task.runId, {
          taskId: id,
          from: task.status,
          to: patch.status,
          ...(next.failure && patch.status !== 'succeeded' ? { reason: next.failure } : {}),
        });
      }
      if (patch.strategy && patch.strategy !== task.strategy) {
        this.record('agent.strategy.chosen', this.projectOfRun(task.runId), task.runId, { taskId: id, strategy: patch.strategy, rationale: next.rationale });
      }
    });
    return this.getAgentTask(id);
  }

  getAgentTask(id: string): AgentTask {
    const row = this.db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError('Agent task', id);
    return toAgentTask(row);
  }

  listAgentTasks(filter: { runId?: string; parentId?: string } = {}): AgentTask[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.runId) {
      where.push('run_id = ?');
      params.push(filter.runId);
    }
    if (filter.parentId) {
      where.push('parent_id = ?');
      params.push(filter.parentId);
    }
    const sql = `SELECT * FROM agent_tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, rowid`;
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(toAgentTask);
  }

  recordSpend(input: { taskId: string | null; model: string; inputTokens: number; outputTokens: number; costUsd: number }): void {
    if (!(input.costUsd >= 0) || !Number.isFinite(input.costUsd)) throw new ValidationError('Cost must be a non-negative number.');
    this.db
      .prepare('INSERT INTO spend (at, task_id, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)')
      .run(this.timestamp(), input.taskId, input.model, input.inputTokens, input.outputTokens, input.costUsd);
  }

  /** Totals recorded for one agent task. */
  listSpend(filter: { taskId: string }): { inputTokens: number; outputTokens: number; costUsd: number } {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o, COALESCE(SUM(cost_usd), 0) AS c FROM spend WHERE task_id = ?')
      .get(filter.taskId) as { i: number; o: number; c: number };
    return { inputTokens: row.i, outputTokens: row.o, costUsd: row.c };
  }

  /** Spend in the current calendar month (UTC). */
  spentThisMonth(): number {
    const now = this.now();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const row = this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM spend WHERE at >= ?').get(start) as { total: number };
    return row.total;
  }

  /** The monthly cap in dollars, or null when real (billable) calls are off. */
  monthlyBudgetUsd(): number | null {
    const value = this.getSettings().budget;
    return value === 'none' ? null : Number(value);
  }

  /** Audits that a credential was stored or removed. Only its name is recorded, never the value. */
  recordCredentialChange(action: 'stored' | 'removed', name: string): void {
    this.record(`credential.${action}`, null, null, { name });
  }

  private projectOfRun(runId: string | null): string | null {
    return runId ? this.getRun(runId).projectId : null;
  }

  // ---- Tool inventory (M4) -------------------------------------------------

  /** Stores a read-only tool scan (redacted) and records it in the audit log. */
  saveToolScan(scan: Omit<ToolScan, 'id' | 'scannedAt'>): ToolScan {
    const saved = redact({ ...scan, id: `scan_${randomUUID()}`, scannedAt: this.timestamp() }) as ToolScan;
    this.transaction(() => {
      this.db.prepare('INSERT INTO tool_scans (id, scanned_at, data) VALUES (?, ?, ?)').run(saved.id, saved.scannedAt, JSON.stringify(saved));
      this.db
        .prepare('DELETE FROM tool_scans WHERE id NOT IN (SELECT id FROM tool_scans ORDER BY scanned_at DESC, rowid DESC LIMIT ?)')
        .run(KEEP_TOOL_SCANS);
      this.record('tools.scanned', null, null, { scanId: saved.id, ...saved.summary });
    });
    return saved;
  }

  latestToolScan(): ToolScan | null {
    const row = this.db.prepare('SELECT data FROM tool_scans ORDER BY scanned_at DESC, rowid DESC LIMIT 1').get() as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ToolScan) : null;
  }

  health(): { schemaVersion: number; integrity: string; projects: number; runs: number; events: number } {
    const count = (table: string) => Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    return {
      schemaVersion: (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      integrity: String((this.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check),
      projects: count('projects'),
      runs: count('runs'),
      events: count('events'),
    };
  }
}

/**
 * Explicit, user-confirmed recovery from a corrupt database: the damaged file
 * (and its WAL/SHM companions) are renamed, never deleted, so they can be
 * inspected or restored. Returns the new location of the main file.
 */
export function moveCorruptStateAside(home: string, now: Date = new Date()): string | null {
  const { db } = appPaths(home);
  if (!existsSync(db)) return null;
  const suffix = `.corrupt-${now.toISOString().replace(/[:.]/g, '-')}`;
  for (const ext of ['', '-wal', '-shm']) {
    if (existsSync(db + ext)) renameSync(db + ext, db + suffix + ext);
  }
  return db + suffix;
}

function toBuild(row: Record<string, unknown>): Build {
  const json = <T>(v: unknown): T | null => (v === null || v === undefined ? null : (JSON.parse(String(v)) as T));
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    kind: row.kind as BuildKind,
    title: String(row.title),
    goal: String(row.goal),
    requirementIds: json<string[]>(row.requirement_ids) ?? [],
    components: json<string[]>(row.components) ?? [],
    checks: json<Check[]>(row.checks) ?? [],
    repro: (row.repro as string | null) ?? null,
    status: row.status as BuildStatus,
    repoPath: (row.repo_path as string | null) ?? null,
    branch: (row.branch as string | null) ?? null,
    worktree: (row.worktree as string | null) ?? null,
    baseCommit: (row.base_commit as string | null) ?? null,
    agent: json<BuildAgentRun>(row.agent),
    changedFiles: json<ChangedFile[]>(row.changed_files),
    risks: json<Risk[]>(row.risks),
    note: (row.note as string | null) ?? null,
    reportPath: (row.report_path as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: (row.completed_at as string | null) ?? null,
  };
}

function toProject(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    origin: row.origin as Project['origin'],
    status: row.status as Project['status'],
    idea: (row.idea as string | null) ?? null,
    facts: JSON.parse(String(row.facts)) as Fact[],
    workspacePath: String(row.workspace_path),
    docsPath: String(row.docs_path),
    repoPath: (row.repo_path as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toRun(row: Record<string, unknown>): WorkflowRun {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    workflow: row.workflow as Workflow,
    title: String(row.title),
    state: row.state as RunState,
    blockedFrom: (row.blocked_from as RunState | null) ?? null,
    blockerReason: (row.blocker_reason as string | null) ?? null,
    blockerResolution: (row.blocker_resolution as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
