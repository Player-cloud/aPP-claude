// Persistent workspace (FR-APP-002, FR-PROJ-001, FR-SEC-004).
//
// One SQLite file holds projects, workflow runs and an append-only audit log.
// Each project also gets a directory with a docs/designs/ location (FR-PLAN-001).
// All writes go through this class so validation, redaction and audit events
// cannot be skipped by a caller.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { appPaths, type AppPaths } from './paths.ts';
import { redact, redactString } from './redact.ts';
import { NotFoundError, StateCorruptError, StateTooNewError, ValidationError } from './errors.ts';
import { isWorkflow, planTransition, type RunState, type TransitionInput, type Workflow } from './workflow.ts';

export const SCHEMA_VERSION = 1;

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
};

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
