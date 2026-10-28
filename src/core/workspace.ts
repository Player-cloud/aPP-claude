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
import type { DriftKind, Gate, GateException, ReleaseEvidence, ReleasePlan } from './release/gates.ts';
import type { AssessmentReport, AssessmentScope } from './assess/assessor.ts';
import type { DesignReference, ReferenceKind, ReferenceSuggestion } from './studio/library.ts';
import type { UiAudit } from './design/audit.ts';
import type { Evidence, Improvement, SelfAssessmentRecord } from './iterate/backlog.ts';
import type { SelfAssessmentReport } from './iterate/assess.ts';
import type { CleanupPlan } from './cleanup/cleanup.ts';
import { isWorkflow, planTransition, type RunState, type TransitionInput, type Workflow } from './workflow.ts';

export const SCHEMA_VERSION = 12;

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

/** One read-only assessment of a project's repository (M8). */
export interface Assessment {
  id: string;
  projectId: string;
  scope: AssessmentScope;
  status: 'scoped' | 'completed' | 'failed';
  repoPath: string;
  commit: string | null;
  report: AssessmentReport | null;
  reportPath: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
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

/**
 * Migrations that rebuild a table other tables point at. SQLite's documented way
 * is to switch foreign keys off around the transaction and run foreign_key_check
 * before committing.
 */
const REBUILDS = new Set([10]);

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
  7: `
    ALTER TABLE builds ADD COLUMN result_commit TEXT;
    CREATE TABLE releases (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft','checked','prepared','abandoned')),
      plan TEXT NOT NULL,
      checks TEXT NOT NULL,
      build_ids TEXT NOT NULL,
      classifications TEXT NOT NULL,
      commit_hash TEXT,
      worktree TEXT,
      evidence TEXT,
      gates TEXT,
      ready INTEGER,
      checks_approved_at TEXT,
      report_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      checked_at TEXT,
      prepared_at TEXT
    );
    CREATE INDEX releases_project ON releases(project_id, created_at);
    CREATE TABLE release_check_runs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      release_id TEXT NOT NULL REFERENCES releases(id),
      commit_hash TEXT NOT NULL,
      check_id TEXT NOT NULL,
      command TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('passed','failed','timed_out','error','not_run')),
      exit_code INTEGER,
      duration_ms INTEGER NOT NULL,
      output TEXT NOT NULL,
      started_at TEXT NOT NULL
    );
    CREATE TRIGGER release_check_runs_no_update BEFORE UPDATE ON release_check_runs
      BEGIN SELECT RAISE(ABORT, 'check results are append-only'); END;
    CREATE TRIGGER release_check_runs_no_delete BEFORE DELETE ON release_check_runs
      BEGIN SELECT RAISE(ABORT, 'check results are append-only'); END;
    -- FR-QA-004: an exception to a gate is an authorisation; it is kept for good.
    CREATE TABLE release_exceptions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      release_id TEXT NOT NULL REFERENCES releases(id),
      gate_id TEXT NOT NULL,
      commit_hash TEXT NOT NULL,
      reason TEXT NOT NULL,
      mitigation TEXT NOT NULL,
      actor TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE TRIGGER release_exceptions_no_update BEFORE UPDATE ON release_exceptions
      BEGIN SELECT RAISE(ABORT, 'exceptions are append-only'); END;
    CREATE TRIGGER release_exceptions_no_delete BEFORE DELETE ON release_exceptions
      BEGIN SELECT RAISE(ABORT, 'exceptions are append-only'); END;
  `,
  8: `
    -- M8: read-only assessments. The scope is recorded before the assessment runs (FR-PROJ-003);
    -- a finished report never changes and no assessment is ever deleted.
    CREATE TABLE assessments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      scope TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('scoped','completed','failed')),
      repo_path TEXT NOT NULL,
      commit_hash TEXT,
      report TEXT,
      report_path TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX assessments_project ON assessments(project_id, created_at);
    CREATE TRIGGER assessments_finished_frozen BEFORE UPDATE ON assessments
      WHEN OLD.status <> 'scoped'
      BEGIN SELECT RAISE(ABORT, 'a finished assessment cannot change'); END;
    CREATE TRIGGER assessments_no_delete BEFORE DELETE ON assessments
      BEGIN SELECT RAISE(ABORT, 'assessments are never deleted'); END;
  `,
  9: `
    -- M9 Learning Studio: design references. The file is a copy in the app's data folder;
    -- a reference is archived, never deleted, so the audit trail keeps pointing at something.
    CREATE TABLE design_refs (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id),
      title TEXT NOT NULL,
      file_name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      kind TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      notes TEXT,
      explanation TEXT,
      suggestion TEXT,
      stored_path TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','archived')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX design_refs_project ON design_refs(project_id, created_at);
    CREATE TRIGGER design_refs_no_delete BEFORE DELETE ON design_refs
      BEGIN SELECT RAISE(ABORT, 'references are archived, never deleted'); END;
  `,
  10: `
    -- M9 "Polish the UI" work: a third kind of build, with the references it uses,
    -- whether motion was asked for, and the UI audit taken before it started.
    -- SQLite cannot change a CHECK, so the table is rebuilt (with foreign keys off, see
    -- REBUILDS); check_runs keep pointing at the same ids, which is checked before commit.
    CREATE TABLE builds_v10 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      kind TEXT NOT NULL CHECK (kind IN ('feature','bugfix','ui_polish')),
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
      completed_at TEXT,
      result_commit TEXT,
      reference_ids TEXT NOT NULL DEFAULT '[]',
      motion INTEGER NOT NULL DEFAULT 0,
      ui_audit TEXT
    );
    INSERT INTO builds_v10 (id, project_id, kind, title, goal, requirement_ids, components, checks, repro, status, repo_path, branch, worktree, base_commit,
                            agent, changed_files, risks, note, report_path, created_at, updated_at, completed_at, result_commit)
      SELECT id, project_id, kind, title, goal, requirement_ids, components, checks, repro, status, repo_path, branch, worktree, base_commit,
             agent, changed_files, risks, note, report_path, created_at, updated_at, completed_at, result_commit FROM builds;
    DROP TABLE builds;
    ALTER TABLE builds_v10 RENAME TO builds;
    CREATE INDEX builds_project ON builds(project_id, created_at);
  `,
  11: `
    -- M10 Iterative Layer: the improvement backlog and the app's self-assessments.
    -- Items are never deleted (a duplicate is merged, which links it); a self-assessment
    -- is frozen once written.
    CREATE TABLE improvements (
      id TEXT PRIMARY KEY,
      number INTEGER NOT NULL UNIQUE,
      title TEXT NOT NULL,
      problem TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '[]',
      expected_outcome TEXT NOT NULL DEFAULT '',
      success_criteria TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL CHECK (priority IN ('low','medium','high')),
      risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
      dependencies TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK (status IN ('idea','proposed','approved','in_progress','verified','released','blocked','rejected')),
      blocked_from TEXT,
      reason TEXT,
      source TEXT NOT NULL CHECK (source IN ('self_assessment','feedback')),
      signature TEXT,
      approver TEXT,
      approved_at TEXT,
      result TEXT,
      measured_outcome TEXT,
      merged_into TEXT REFERENCES improvements(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      released_at TEXT
    );
    CREATE INDEX improvements_signature ON improvements(signature);
    CREATE TRIGGER improvements_no_delete BEFORE DELETE ON improvements
      BEGIN SELECT RAISE(ABORT, 'improvements are never deleted'); END;
    CREATE TRIGGER improvements_released_final BEFORE UPDATE ON improvements
      WHEN OLD.status = 'released' AND (NEW.status <> 'released' OR NEW.measured_outcome IS NOT OLD.measured_outcome OR NEW.result IS NOT OLD.result)
      BEGIN SELECT RAISE(ABORT, 'a released improvement cannot change'); END;
    CREATE TABLE self_assessments (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      report TEXT NOT NULL,
      created TEXT NOT NULL,
      updated TEXT NOT NULL
    );
    CREATE INDEX self_assessments_at ON self_assessments(at);
    CREATE TRIGGER self_assessments_frozen BEFORE UPDATE ON self_assessments
      BEGIN SELECT RAISE(ABORT, 'a self-assessment cannot change'); END;
    CREATE TRIGGER self_assessments_no_delete BEFORE DELETE ON self_assessments
      BEGIN SELECT RAISE(ABORT, 'self-assessments are never deleted'); END;
  `,
  12: `
    -- M11 safe tool cleanup: one row per planned change, with its dry run, the person's
    -- approval and the verified result. Never deleted; a finished plan only moves to restored.
    CREATE TABLE cleanup_plans (
      id TEXT PRIMARY KEY,
      scan_id TEXT NOT NULL,
      finding_id TEXT,
      entry_id TEXT NOT NULL,
      entry TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('keep','configure','disable','replace','uninstall')),
      mechanism TEXT NOT NULL CHECK (mechanism IN ('record','claude-cli','move-aside','manual')),
      dry_run TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('planned','recorded','manual','done','partial','failed','stale','cancelled','restored')),
      approval TEXT,
      result TEXT,
      restore TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX cleanup_plans_created ON cleanup_plans(created_at);
    CREATE TRIGGER cleanup_plans_no_delete BEFORE DELETE ON cleanup_plans
      BEGIN SELECT RAISE(ABORT, 'cleanup plans are never deleted'); END;
    CREATE TRIGGER cleanup_plans_final BEFORE UPDATE ON cleanup_plans
      WHEN OLD.status IN ('recorded','manual','failed','stale','cancelled','restored')
        OR (OLD.status IN ('done','partial') AND NEW.status NOT IN ('done','partial','restored'))
        OR NEW.dry_run IS NOT OLD.dry_run OR NEW.entry IS NOT OLD.entry
      BEGIN SELECT RAISE(ABORT, 'a finished cleanup plan cannot change'); END;
  `,
};

export type ReleaseStatus = 'draft' | 'checked' | 'prepared' | 'abandoned';

/** A release candidate for one project (M7). Preparing it never deploys anything. */
export interface Release {
  id: string;
  projectId: string;
  version: string;
  status: ReleaseStatus;
  plan: ReleasePlan;
  checks: Check[];
  buildIds: string[];
  /** The person's classification of drift findings, by requirement ID. */
  classifications: Record<string, { kind: Extract<DriftKind, 'intentional_deviation' | 'spec_change'>; note: string }>;
  /** The commit the last ship-check ran on. */
  commit: string | null;
  worktree: string | null;
  /** What the last ship-check found, so classifications and exceptions can be re-evaluated without running the checks again. */
  evidence: ReleaseEvidence | null;
  gates: Gate[] | null;
  /** True when the last ship-check found no blocking gate. */
  ready: boolean | null;
  checksApprovedAt: string | null;
  reportPath: string | null;
  createdAt: string;
  updatedAt: string;
  checkedAt: string | null;
  preparedAt: string | null;
}

export interface ReleaseCheckRun extends CheckResult {
  seq: number;
  releaseId: string;
  commit: string;
}

export type BuildKind = 'feature' | 'bugfix' | 'ui_polish';
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
  /** The commit on the build's branch that holds the finished change (M7). */
  resultCommit: string | null;
  /** UI polish (M9): Learning Studio references to follow, whether motion was asked for, and the audit taken at start. */
  referenceIds: string[];
  motion: boolean;
  uiAudit: UiAudit | null;
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
      const rebuild = REBUILDS.has(version);
      if (rebuild) this.db.exec('PRAGMA foreign_keys = OFF');
      try {
        this.transaction(() => {
          this.db.exec(MIGRATIONS[version]!);
          if (rebuild && this.db.prepare('PRAGMA foreign_key_check').all().length) throw new Error(`Migration ${version} would leave broken references.`);
          this.db.exec(`PRAGMA user_version = ${version}`);
          this.record('schema.migrated', null, null, { from: version - 1, to: version, firstRun });
        });
      } finally {
        if (rebuild) this.db.exec('PRAGMA foreign_keys = ON');
      }
    }
  }

  private depth = 0;

  /** Nested calls join the outer transaction, so several writes commit or roll back together. */
  private transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth--;
    }
  }

  /** For core modules that write several records at once (M10 backlog). */
  inTransaction<T>(fn: () => T): T {
    return this.transaction(fn);
  }

  nowIso(): string {
    return this.timestamp();
  }

  /** The person using the app (the OS user name), who is recorded as the approver. */
  actorName(): string {
    return this.actor;
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
    return this.insertProject(input, 'new', null);
  }

  /**
   * Registers an existing repository as a project (M8, FR-PROJ-002). Only its
   * location is recorded: nothing in the repository is read or changed here.
   * The caller checks that the folder is a git repository.
   */
  importProject(input: { name: string; idea?: string; repoPath: string }): Project {
    const taken = this.listProjects().find((p) => p.repoPath === input.repoPath && p.status === 'active');
    if (taken) throw new ValidationError(`This repository is already the project "${taken.name}".`);
    return this.insertProject(input, 'imported', input.repoPath);
  }

  private insertProject(input: { name: string; idea?: string; facts?: Fact[] }, origin: Project['origin'], repoPath: string | null): Project {
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
          `INSERT INTO projects (id, name, origin, status, idea, facts, workspace_path, docs_path, repo_path, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, name, origin, idea, JSON.stringify(facts), workspacePath, docsPath, repoPath, at, at);
      this.record(origin === 'new' ? 'project.created' : 'project.imported', id, null, { name, origin, facts: facts.length, ...(repoPath ? { repoPath } : {}) });
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

  createBuild(input: {
    projectId: string;
    kind: BuildKind;
    title: string;
    goal: string;
    requirementIds: string[];
    components: string[];
    checks: Check[];
    repro: string | null;
    referenceIds?: string[];
    motion?: boolean;
  }): Build {
    const project = this.getProject(input.projectId);
    const id = `build_${randomUUID()}`;
    const at = this.timestamp();
    const title = redactString(requireText('Title', input.title, 200));
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO builds (id, project_id, kind, title, goal, requirement_ids, components, checks, repro, reference_ids, motion, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
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
          JSON.stringify(input.referenceIds ?? []),
          input.motion ? 1 : 0,
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
    patch: Partial<Pick<Build, 'title' | 'goal' | 'requirementIds' | 'components' | 'checks' | 'repro' | 'status' | 'repoPath' | 'branch' | 'worktree' | 'baseCommit' | 'agent' | 'changedFiles' | 'risks' | 'note' | 'reportPath' | 'completedAt' | 'resultCommit' | 'referenceIds' | 'motion' | 'uiAudit'>>,
    event?: { type: string; payload: Record<string, unknown> },
  ): Build {
    const build = this.getBuild(id);
    const definition = ['title', 'goal', 'requirementIds', 'components', 'checks', 'repro', 'referenceIds', 'motion'] as const;
    if (build.status !== 'draft' && definition.some((k) => k in patch)) throw new ValidationError('The task and its checks are fixed once work has started.');
    const n = { ...build, ...patch };
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE builds SET title = ?, goal = ?, requirement_ids = ?, components = ?, checks = ?, repro = ?, status = ?, repo_path = ?, branch = ?, worktree = ?,
             base_commit = ?, agent = ?, changed_files = ?, risks = ?, note = ?, report_path = ?, completed_at = ?, result_commit = ?,
             reference_ids = ?, motion = ?, ui_audit = ?, updated_at = ? WHERE id = ?`,
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
          n.resultCommit,
          JSON.stringify(n.referenceIds),
          n.motion ? 1 : 0,
          n.uiAudit ? JSON.stringify(n.uiAudit) : null,
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

  // ---- Learning Studio (M9) ---------------------------------------------------

  createReference(r: Omit<DesignReference, 'createdAt' | 'updatedAt' | 'status' | 'suggestion' | 'explanation'>): DesignReference {
    if (r.projectId) this.getProject(r.projectId);
    const at = this.timestamp();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO design_refs (id, project_id, title, file_name, media_type, size, sha256, width, height, kind, tags, notes, stored_path, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(r.id, r.projectId, redactString(r.title), redactString(r.fileName), r.mediaType, r.size, r.sha256, r.width, r.height, r.kind, JSON.stringify(r.tags), r.notes === null ? null : redactString(r.notes), r.storedPath, at, at);
      this.record('reference.imported', r.projectId, null, { referenceId: r.id, fileName: r.fileName, mediaType: r.mediaType, size: r.size, sha256: r.sha256 });
    });
    return this.getReference(r.id);
  }

  getReference(id: string): DesignReference {
    const row = this.db.prepare('SELECT * FROM design_refs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError('Reference', id);
    return toReference(row);
  }

  /** Active references, newest first; `projectId: null` lists the ones linked to no project. */
  listReferences(filter: { projectId?: string | null; archived?: boolean } = {}): DesignReference[] {
    const where = [filter.archived ? "status = 'archived'" : "status = 'active'"];
    const params: string[] = [];
    if (filter.projectId === null) where.push('project_id IS NULL');
    else if (filter.projectId !== undefined) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    return (this.db.prepare(`SELECT * FROM design_refs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id`).all(...params) as Record<string, unknown>[]).map(toReference);
  }

  findReferenceByHash(sha256: string): DesignReference | null {
    const row = this.db.prepare("SELECT * FROM design_refs WHERE sha256 = ? AND status = 'active'").get(sha256) as Record<string, unknown> | undefined;
    return row ? toReference(row) : null;
  }

  updateReference(
    id: string,
    patch: Partial<{ projectId: string | null; title: string; kind: ReferenceKind; tags: string[]; notes: string | null; explanation: string | null; suggestion: ReferenceSuggestion | null; status: 'active' | 'archived' }>,
    event: { type: string; payload: Record<string, unknown> },
  ): DesignReference {
    const r = this.getReference(id);
    if (patch.projectId) this.getProject(patch.projectId);
    const n = { ...r, ...patch };
    this.transaction(() => {
      this.db
        .prepare('UPDATE design_refs SET project_id = ?, title = ?, kind = ?, tags = ?, notes = ?, explanation = ?, suggestion = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(
          n.projectId,
          redactString(n.title),
          n.kind,
          JSON.stringify(n.tags),
          n.notes === null ? null : redactString(n.notes),
          n.explanation === null ? null : redactString(n.explanation),
          n.suggestion ? JSON.stringify(redact(n.suggestion)) : null,
          n.status,
          this.timestamp(),
          id,
        );
      this.record(event.type, n.projectId ?? r.projectId, null, { referenceId: id, ...event.payload });
    });
    return this.getReference(id);
  }

  // ---- Tool cleanup (M11) -------------------------------------------------------

  createCleanupPlan(p: Pick<CleanupPlan, 'id' | 'scanId' | 'findingId' | 'entry' | 'action' | 'mechanism' | 'dryRun' | 'status'>): CleanupPlan {
    const at = this.timestamp();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO cleanup_plans (id, scan_id, finding_id, entry_id, entry, action, mechanism, dry_run, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(p.id, p.scanId, p.findingId, p.entry.id, JSON.stringify(redact(p.entry)), p.action, p.mechanism, JSON.stringify(redact(p.dryRun)), p.status, at, at);
      this.record('cleanup.planned', null, null, { planId: p.id, entryId: p.entry.id, action: p.action, mechanism: p.mechanism, targets: p.dryRun.targets, command: p.dryRun.command?.display ?? null });
    });
    return this.getCleanupPlan(p.id);
  }

  getCleanupPlan(id: string): CleanupPlan {
    const row = this.db.prepare('SELECT * FROM cleanup_plans WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError('Cleanup plan', id);
    return toCleanupPlan(row);
  }

  listCleanupPlans(limit = 50): CleanupPlan[] {
    return (this.db.prepare('SELECT * FROM cleanup_plans ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map(toCleanupPlan);
  }

  updateCleanupPlan(id: string, patch: Partial<Pick<CleanupPlan, 'status' | 'approval' | 'result' | 'restore'>>, event: { type: string; payload: Record<string, unknown> }): CleanupPlan {
    const n = { ...this.getCleanupPlan(id), ...patch };
    const j = (v: unknown) => (v === null ? null : JSON.stringify(redact(v)));
    this.transaction(() => {
      this.db.prepare('UPDATE cleanup_plans SET status = ?, approval = ?, result = ?, restore = ?, updated_at = ? WHERE id = ?').run(n.status, j(n.approval), j(n.result), j(n.restore), this.timestamp(), id);
      this.record(event.type, null, null, { planId: id, ...event.payload });
    });
    return this.getCleanupPlan(id);
  }

  // ---- Improvement backlog (M10) ---------------------------------------------

  createImprovement(i: Pick<Improvement, 'title' | 'problem' | 'expectedOutcome' | 'successCriteria' | 'priority' | 'risk' | 'status' | 'source' | 'signature' | 'evidence'>): Improvement {
    const id = `imp_${randomUUID()}`;
    const at = this.timestamp();
    this.transaction(() => {
      const number = Number((this.db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM improvements').get() as { n: number }).n);
      this.db
        .prepare(
          `INSERT INTO improvements (id, number, title, problem, evidence, expected_outcome, success_criteria, priority, risk, status, source, signature, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, number, redactString(i.title), redactString(i.problem), JSON.stringify(redact(i.evidence)), redactString(i.expectedOutcome), redactString(i.successCriteria), i.priority, i.risk, i.status, i.source, i.signature, at, at);
      this.record('improvement.created', null, null, { improvementId: id, number, source: i.source, signature: i.signature, status: i.status });
    });
    return this.getImprovement(id);
  }

  getImprovement(id: string): Improvement {
    const row = this.db.prepare('SELECT * FROM improvements WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError('Improvement', id);
    return toImprovement(row);
  }

  /** Newest first. Merged duplicates are left out unless asked for. */
  listImprovements(filter: { status?: string; includeMerged?: boolean } = {}): Improvement[] {
    const where: string[] = [];
    const params: string[] = [];
    if (!filter.includeMerged) where.push('merged_into IS NULL');
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    const sql = `SELECT * FROM improvements ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY number DESC`;
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(toImprovement);
  }

  /** The live item tracking a finding: merged items lead to the item they were merged into. */
  findImprovementBySignature(signature: string): Improvement | null {
    const row = this.db.prepare('SELECT id FROM improvements WHERE signature = ? ORDER BY number LIMIT 1').get(signature) as { id: string } | undefined;
    if (!row) return null;
    let item = this.getImprovement(row.id);
    for (let hops = 0; item.mergedInto && hops < 100; hops++) item = this.getImprovement(item.mergedInto);
    return item;
  }

  updateImprovement(id: string, patch: Partial<Omit<Improvement, 'id' | 'number' | 'evidence' | 'source' | 'signature' | 'createdAt' | 'updatedAt'>>, event: { type: string; payload: Record<string, unknown> }): Improvement {
    const n = { ...this.getImprovement(id), ...patch };
    const t = (v: string | null) => (v === null ? null : redactString(v));
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE improvements SET title = ?, problem = ?, expected_outcome = ?, success_criteria = ?, priority = ?, risk = ?, dependencies = ?, status = ?, blocked_from = ?,
             reason = ?, approver = ?, approved_at = ?, result = ?, measured_outcome = ?, merged_into = ?, released_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          redactString(n.title),
          redactString(n.problem),
          redactString(n.expectedOutcome),
          redactString(n.successCriteria),
          n.priority,
          n.risk,
          JSON.stringify(n.dependencies),
          n.status,
          n.blockedFrom,
          t(n.reason),
          n.approver,
          n.approvedAt,
          t(n.result),
          t(n.measuredOutcome),
          n.mergedInto,
          n.releasedAt,
          this.timestamp(),
          id,
        );
      this.record(event.type, null, null, { improvementId: id, number: n.number, ...event.payload });
    });
    return this.getImprovement(id);
  }

  addImprovementEvidence(id: string, evidence: Evidence): Improvement {
    const item = this.getImprovement(id);
    this.transaction(() => {
      this.db.prepare('UPDATE improvements SET evidence = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(redact([...item.evidence, evidence])), this.timestamp(), id);
      this.record('improvement.evidence', null, null, { improvementId: id, number: item.number, source: evidence.source, occurrences: evidence.occurrences.length });
    });
    return this.getImprovement(id);
  }

  saveSelfAssessment(a: { id: string; report: SelfAssessmentReport; created: string[]; updated: string[] }): void {
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO self_assessments (id, at, actor, report, created, updated) VALUES (?, ?, ?, ?, ?, ?)')
        .run(a.id, a.report.at, this.actor, JSON.stringify(redact(a.report)), JSON.stringify(a.created), JSON.stringify(a.updated));
      this.record('self_assessment.completed', null, null, { assessmentId: a.id, findings: a.report.findings.length, created: a.created.length, updated: a.updated.length });
    });
  }

  getSelfAssessment(id: string): SelfAssessmentRecord {
    const row = this.db.prepare('SELECT * FROM self_assessments WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError('Self-assessment', id);
    return toSelfAssessment(row);
  }

  latestSelfAssessment(): SelfAssessmentRecord | null {
    const row = this.db.prepare('SELECT * FROM self_assessments ORDER BY at DESC, rowid DESC LIMIT 1').get() as Record<string, unknown> | undefined;
    return row ? toSelfAssessment(row) : null;
  }

  listSelfAssessments(limit = 20): SelfAssessmentRecord[] {
    return (this.db.prepare('SELECT * FROM self_assessments ORDER BY at DESC, rowid DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map(toSelfAssessment);
  }

  // ---- Assessments (M8) ------------------------------------------------------

  /** Records the scope before anything is read (FR-PROJ-003). */
  createAssessment(input: { projectId: string; scope: AssessmentScope; repoPath: string }): Assessment {
    const project = this.getProject(input.projectId);
    const id = `asm_${randomUUID()}`;
    this.transaction(() => {
      this.db
        .prepare(`INSERT INTO assessments (id, project_id, scope, status, repo_path, created_at) VALUES (?, ?, ?, 'scoped', ?, ?)`)
        .run(id, project.id, JSON.stringify(input.scope), input.repoPath, this.timestamp());
      this.record('assessment.scoped', project.id, null, { assessmentId: id, scope: input.scope, repoPath: input.repoPath });
    });
    return this.getAssessment(id);
  }

  /** Stores the finished report. A finished assessment is frozen by a database trigger. */
  finishAssessment(id: string, result: { commit: string | null; report: AssessmentReport | null; reportPath: string | null; error: string | null }): Assessment {
    const a = this.getAssessment(id);
    const status = result.error === null ? 'completed' : 'failed';
    this.transaction(() => {
      this.db
        .prepare('UPDATE assessments SET status = ?, commit_hash = ?, report = ?, report_path = ?, error = ?, completed_at = ? WHERE id = ?')
        .run(status, result.commit, result.report ? JSON.stringify(redact(result.report)) : null, result.reportPath, result.error === null ? null : redactString(result.error), this.timestamp(), id);
      this.record(`assessment.${status}`, a.projectId, null, {
        assessmentId: id,
        commit: result.commit,
        ...(result.report ? { counts: result.report.counts, unchanged: result.report.unchanged } : {}),
        ...(result.error === null ? {} : { error: result.error }),
      });
    });
    return this.getAssessment(id);
  }

  getAssessment(id: string): Assessment {
    const row = this.db.prepare('SELECT * FROM assessments WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError('Assessment', id);
    return toAssessment(row);
  }

  listAssessments(projectId: string): Assessment[] {
    this.getProject(projectId);
    return (this.db.prepare('SELECT * FROM assessments WHERE project_id = ? ORDER BY created_at DESC, id').all(projectId) as Record<string, unknown>[]).map(toAssessment);
  }

  // ---- Releases (M7) --------------------------------------------------------

  createRelease(input: { projectId: string; version: string; plan: ReleasePlan; checks: Check[]; buildIds: string[] }): Release {
    const project = this.getProject(input.projectId);
    const id = `rel_${randomUUID()}`;
    const at = this.timestamp();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO releases (id, project_id, version, status, plan, checks, build_ids, classifications, created_at, updated_at)
           VALUES (?, ?, ?, 'draft', ?, ?, ?, '{}', ?, ?)`,
        )
        .run(id, project.id, redactString(input.version), JSON.stringify(redact(input.plan)), JSON.stringify(input.checks.map((c) => ({ id: c.id, command: redactString(c.command) }))), JSON.stringify(input.buildIds), at, at);
      this.record('release.created', project.id, null, { releaseId: id, version: input.version, builds: input.buildIds, checks: input.checks.map((c) => c.command) });
    });
    return this.getRelease(id);
  }

  getRelease(id: string): Release {
    const row = this.db.prepare('SELECT * FROM releases WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError('Release', id);
    return toRelease(row);
  }

  listReleases(projectId: string): Release[] {
    this.getProject(projectId);
    return (this.db.prepare('SELECT * FROM releases WHERE project_id = ? ORDER BY created_at DESC, id').all(projectId) as Record<string, unknown>[]).map(toRelease);
  }

  updateRelease(
    id: string,
    patch: Partial<Pick<Release, 'plan' | 'buildIds' | 'classifications' | 'status' | 'commit' | 'worktree' | 'evidence' | 'gates' | 'ready' | 'checksApprovedAt' | 'reportPath' | 'checkedAt' | 'preparedAt'>>,
    event?: { type: string; payload: Record<string, unknown> },
  ): Release {
    const r = this.getRelease(id);
    if (r.status === 'prepared' || r.status === 'abandoned') {
      if (!(Object.keys(patch).length === 1 && 'reportPath' in patch)) throw new ValidationError(`This release is ${r.status} and cannot change.`);
    }
    const n = { ...r, ...patch };
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE releases SET plan = ?, build_ids = ?, classifications = ?, status = ?, commit_hash = ?, worktree = ?, evidence = ?, gates = ?, ready = ?,
             checks_approved_at = ?, report_path = ?, checked_at = ?, prepared_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          JSON.stringify(redact(n.plan)),
          JSON.stringify(n.buildIds),
          JSON.stringify(redact(n.classifications)),
          n.status,
          n.commit,
          n.worktree,
          n.evidence ? JSON.stringify(redact(n.evidence)) : null,
          n.gates ? JSON.stringify(redact(n.gates)) : null,
          n.ready === null ? null : n.ready ? 1 : 0,
          n.checksApprovedAt,
          n.reportPath,
          n.checkedAt,
          n.preparedAt,
          this.timestamp(),
          id,
        );
      if (event) this.record(event.type, r.projectId, null, { releaseId: id, ...event.payload });
    });
    return this.getRelease(id);
  }

  recordReleaseCheckRun(releaseId: string, commit: string, r: CheckResult): void {
    const release = this.getRelease(releaseId);
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO release_check_runs (release_id, commit_hash, check_id, command, status, exit_code, duration_ms, output, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(releaseId, commit, r.checkId, redactString(r.command), r.status, r.exitCode, r.durationMs, redactString(r.output), r.startedAt);
      this.record('release.check', release.projectId, null, { releaseId, commit, checkId: r.checkId, status: r.status, exitCode: r.exitCode });
    });
  }

  listReleaseCheckRuns(releaseId: string): ReleaseCheckRun[] {
    return (this.db.prepare('SELECT * FROM release_check_runs WHERE release_id = ? ORDER BY seq').all(releaseId) as Record<string, unknown>[]).map((row) => ({
      seq: Number(row.seq),
      releaseId: String(row.release_id),
      commit: String(row.commit_hash),
      checkId: String(row.check_id),
      command: String(row.command),
      status: row.status as CheckResult['status'],
      exitCode: row.exit_code === null ? null : Number(row.exit_code),
      durationMs: Number(row.duration_ms),
      output: String(row.output),
      startedAt: String(row.started_at),
    }));
  }

  /** Records a person's authorisation to release despite a failed gate (FR-QA-004). Kept for good. */
  recordGateException(releaseId: string, gateId: string, commit: string, reason: string, mitigation: string): GateException {
    const release = this.getRelease(releaseId);
    const at = this.timestamp();
    const actor = this.actor;
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO release_exceptions (release_id, gate_id, commit_hash, reason, mitigation, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(releaseId, gateId, commit, redactString(reason), redactString(mitigation), actor, at);
      this.record('release.exception', release.projectId, null, { releaseId, gateId, commit, reason: redactString(reason), mitigation: redactString(mitigation) });
    });
    return { gateId, commit, reason: redactString(reason), mitigation: redactString(mitigation), actor, at };
  }

  listGateExceptions(releaseId: string): GateException[] {
    return (this.db.prepare('SELECT * FROM release_exceptions WHERE release_id = ? ORDER BY seq').all(releaseId) as Record<string, unknown>[]).map((row) => ({
      gateId: String(row.gate_id),
      commit: String(row.commit_hash),
      reason: String(row.reason),
      mitigation: String(row.mitigation),
      actor: String(row.actor),
      at: String(row.at),
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
    resultCommit: (row.result_commit as string | null) ?? null,
    referenceIds: json<string[]>(row.reference_ids) ?? [],
    motion: row.motion === 1 || row.motion === 1n,
    uiAudit: json<UiAudit>(row.ui_audit),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: (row.completed_at as string | null) ?? null,
  };
}

function toRelease(row: Record<string, unknown>): Release {
  const json = <T>(v: unknown, d: T): T => (v === null || v === undefined ? d : (JSON.parse(String(v)) as T));
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    version: String(row.version),
    status: row.status as ReleaseStatus,
    plan: json<ReleasePlan>(row.plan, { target: '', healthCheck: '', rollback: '', monitoring: '', migrations: '', envVars: [] }),
    checks: json<Check[]>(row.checks, []),
    buildIds: json<string[]>(row.build_ids, []),
    classifications: json<Release['classifications']>(row.classifications, {}),
    commit: (row.commit_hash as string | null) ?? null,
    worktree: (row.worktree as string | null) ?? null,
    evidence: json<ReleaseEvidence | null>(row.evidence, null),
    gates: json<Gate[] | null>(row.gates, null),
    ready: row.ready === null || row.ready === undefined ? null : Number(row.ready) === 1,
    checksApprovedAt: (row.checks_approved_at as string | null) ?? null,
    reportPath: (row.report_path as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    checkedAt: (row.checked_at as string | null) ?? null,
    preparedAt: (row.prepared_at as string | null) ?? null,
  };
}

function toCleanupPlan(row: Record<string, unknown>): CleanupPlan {
  const json = <T,>(k: string) => (row[k] === null || row[k] === undefined ? null : (JSON.parse(String(row[k])) as T));
  return {
    id: String(row.id),
    scanId: String(row.scan_id),
    findingId: (row.finding_id as string | null) ?? null,
    entry: json<CleanupPlan['entry']>('entry')!,
    action: row.action as CleanupPlan['action'],
    mechanism: row.mechanism as CleanupPlan['mechanism'],
    dryRun: json<CleanupPlan['dryRun']>('dry_run')!,
    status: row.status as CleanupPlan['status'],
    approval: json<CleanupPlan['approval']>('approval'),
    result: json<CleanupPlan['result']>('result'),
    restore: json<CleanupPlan['restore']>('restore'),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toImprovement(row: Record<string, unknown>): Improvement {
  const opt = (k: string) => (row[k] as string | null) ?? null;
  return {
    id: String(row.id),
    number: Number(row.number),
    title: String(row.title),
    problem: String(row.problem),
    evidence: JSON.parse(String(row.evidence)) as Evidence[],
    expectedOutcome: String(row.expected_outcome),
    successCriteria: String(row.success_criteria),
    priority: row.priority as Improvement['priority'],
    risk: row.risk as Improvement['risk'],
    dependencies: JSON.parse(String(row.dependencies)) as string[],
    status: row.status as Improvement['status'],
    blockedFrom: opt('blocked_from') as Improvement['blockedFrom'],
    reason: opt('reason'),
    source: row.source as Improvement['source'],
    signature: opt('signature'),
    approver: opt('approver'),
    approvedAt: opt('approved_at'),
    result: opt('result'),
    measuredOutcome: opt('measured_outcome'),
    mergedInto: opt('merged_into'),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    releasedAt: opt('released_at'),
  };
}

function toSelfAssessment(row: Record<string, unknown>): SelfAssessmentRecord {
  return {
    id: String(row.id),
    at: String(row.at),
    actor: String(row.actor),
    report: JSON.parse(String(row.report)) as SelfAssessmentReport,
    created: JSON.parse(String(row.created)) as string[],
    updated: JSON.parse(String(row.updated)) as string[],
  };
}

function toReference(row: Record<string, unknown>): DesignReference {
  return {
    id: String(row.id),
    projectId: (row.project_id as string | null) ?? null,
    title: String(row.title),
    fileName: String(row.file_name),
    mediaType: String(row.media_type) as DesignReference['mediaType'],
    size: Number(row.size),
    sha256: String(row.sha256),
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height: row.height === null || row.height === undefined ? null : Number(row.height),
    kind: row.kind as ReferenceKind,
    tags: JSON.parse(String(row.tags)) as string[],
    notes: (row.notes as string | null) ?? null,
    explanation: (row.explanation as string | null) ?? null,
    suggestion: row.suggestion === null || row.suggestion === undefined ? null : (JSON.parse(String(row.suggestion)) as ReferenceSuggestion),
    storedPath: String(row.stored_path),
    status: row.status as DesignReference['status'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toAssessment(row: Record<string, unknown>): Assessment {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    scope: JSON.parse(String(row.scope)) as AssessmentScope,
    status: row.status as Assessment['status'],
    repoPath: String(row.repo_path),
    commit: (row.commit_hash as string | null) ?? null,
    report: row.report === null || row.report === undefined ? null : (JSON.parse(String(row.report)) as AssessmentReport),
    reportPath: (row.report_path as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    createdAt: String(row.created_at),
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
