// Contract between the renderer and the main process. The renderer only ever
// sees these types; it never touches the database or filesystem directly.

import type { AgentTask, AuditEvent, Fact, Project, Settings, WorkflowRun } from '../core/workspace.ts';
import type { ToolScan } from '../core/tools.ts';
import type { PlanningOverview } from '../core/planner.ts';
import type { PlanChange, PlanDoc } from '../core/planning.ts';
import type { RunState, Workflow } from '../core/workflow.ts';

export type { AgentTask, AuditEvent, Fact, Project, RunState, Settings, ToolScan, Workflow, WorkflowRun };
export type { Finding, Severity } from '../core/conflicts.ts';
export type { PlanningOverview, EgmStatus } from '../core/planner.ts';
import type { BuildDetail, BuildInput } from '../core/build/builder.ts';
import type { Diff } from '../core/build/git.ts';
import type { Build } from '../core/workspace.ts';
export type { BuildDetail, BuildInput } from '../core/build/builder.ts';
export type { Diff, ChangedFile } from '../core/build/git.ts';
export type { Build, BuildAgentRun, CheckRun } from '../core/workspace.ts';
export type { Risk } from '../core/build/review.ts';
export type { Check } from '../core/build/checks.ts';
import type { ReleaseDetail, ReleaseInput } from '../core/release/releaser.ts';
import type { Release } from '../core/workspace.ts';
import type { ReleasePlan } from '../core/release/gates.ts';
export type { ReleaseDetail, ReleaseInput } from '../core/release/releaser.ts';
export type { Release, ReleaseCheckRun, ReleaseStatus } from '../core/workspace.ts';
export type { DriftFinding, DriftKind, Gate, GateException, GateId, GateStatus, ReleasePlan } from '../core/release/gates.ts';
export type { Brief, BriefField, PlanChange, PlanDoc, Priority, Requirement, Spec } from '../core/planning.ts';
export type { ToolEntry, ToolKind } from '../core/inventory.ts';
import type { Assessment } from '../core/workspace.ts';
import type { AssessmentScope } from '../core/assess/assessor.ts';
export type { Assessment } from '../core/workspace.ts';
export type { AssessmentReport, AssessmentScope, ScopeKind } from '../core/assess/assessor.ts';
export type { CapabilityFinding, CapabilityStatus, CategoryId, CodebaseSummary, Level, Observation } from '../core/assess/capabilities.ts';

import type { DesignReference, ImportResult } from '../core/studio/library.ts';
export type { DesignReference, ImportResult, ReferenceKind, ReferenceSuggestion } from '../core/studio/library.ts';

import type { Improvement, ImprovementDetail, ImprovementsOverview, SelfAssessmentRecord } from '../core/iterate/backlog.ts';
export type { Evidence, Improvement, ImprovementDetail, ImprovementLink, ImprovementStatus, ImprovementsOverview, Recurrence, SelfAssessmentRecord } from '../core/iterate/backlog.ts';
export type { Occurrence, SelfAssessmentReport, SelfFinding } from '../core/iterate/assess.ts';

import type { CleanupOption, CleanupPlan } from '../core/cleanup/cleanup.ts';
export type { CleanupAction, CleanupOption, CleanupPlan, CleanupResult, CleanupStatus, DryRun, Mechanism } from '../core/cleanup/cleanup.ts';
import type { UpdateCheck, UpdateItem, UpdatesOverview } from '../core/updates/updates.ts';
export type { Confidence, SourceResult, SourceStatus, UpdateCheck, UpdateImpact, UpdateItem, UpdateKind, UpdatePriority, UpdatesOverview, UpdateStage } from '../core/updates/updates.ts';

/** Kinds a reference can have, and the tags in use (M9). */
export interface ReferenceCatalog {
  kinds: string[];
  tags: { tag: string; count: number }[];
}

/** The capability model, for choosing a focused scope (M8). */
export interface AssessmentCatalog {
  categories: { id: string; title: string }[];
  capabilities: { id: string; title: string; category: string }[];
}

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

export interface AgentStatus {
  /** `simulated` without a budget; `needs_key` with a budget but no key; `claude` when real calls are on. */
  mode: 'simulated' | 'claude' | 'needs_key';
  model: string;
  budgetUsd: number | null;
  spentUsd: number;
  keyStored: boolean;
  keyStorageAvailable: boolean;
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
  /** Read-only scan of the user's Claude Code tools (M4). Changes nothing outside the app's database. */
  scanTools(): Promise<Result<ToolScan>>;
  getToolScan(): Promise<Result<ToolScan | null>>;
  /** Main agent on a running run (M3). Uses the simulated model only: no AI is called and nothing is billed. */
  runAgent(input: { runId: string; goal: string }): Promise<Result<AgentTask>>;
  listAgentTasks(runId: string): Promise<Result<AgentTask[]>>;
  agentStatus(): Promise<Result<AgentStatus>>;
  /** Stores the key encrypted by the OS. No method ever returns it. */
  setApiKey(input: { key: string }): Promise<Result<AgentStatus>>;
  clearApiKey(): Promise<Result<AgentStatus>>;
  /** Build work (M6): features and bug fixes in their own git worktrees. */
  setProjectRepo(input: { projectId: string; path: string }): Promise<Result<Project>>;
  initProjectRepo(projectId: string): Promise<Result<Project>>;
  listBuilds(projectId: string): Promise<Result<Build[]>>;
  getBuild(buildId: string): Promise<Result<BuildDetail>>;
  createBuild(input: BuildInput & { projectId: string }): Promise<Result<Build>>;
  editBuild(input: BuildInput & { buildId: string }): Promise<Result<Build>>;
  startBuild(buildId: string): Promise<Result<BuildDetail>>;
  runBuildAgent(buildId: string): Promise<Result<BuildDetail>>;
  verifyBuild(buildId: string): Promise<Result<BuildDetail>>;
  completeBuild(input: { buildId: string; note?: string | null }): Promise<Result<BuildDetail>>;
  abandonBuild(input: { buildId: string; reason?: string | null }): Promise<Result<BuildDetail>>;
  buildDiff(buildId: string): Promise<Result<Diff>>;
  /** Releases (M7): quality gate and ship-check. Preparing a release never deploys it. */
  listReleases(projectId: string): Promise<Result<Release[]>>;
  getRelease(releaseId: string): Promise<Result<ReleaseDetail>>;
  createRelease(input: ReleaseInput & { projectId: string }): Promise<Result<Release>>;
  editRelease(input: { releaseId: string; plan?: Partial<ReleasePlan>; buildIds?: string[] }): Promise<Result<Release>>;
  /** Asks the person to approve the check commands, then runs the ship-check on the repository's current commit. */
  checkRelease(releaseId: string): Promise<Result<ReleaseDetail>>;
  classifyDrift(input: { releaseId: string; requirementId: string; kind: 'intentional_deviation' | 'spec_change'; note: string }): Promise<Result<ReleaseDetail>>;
  addGateException(input: { releaseId: string; gateId: string; reason: string; mitigation: string }): Promise<Result<ReleaseDetail>>;
  prepareRelease(releaseId: string): Promise<Result<ReleaseDetail>>;
  abandonRelease(releaseId: string): Promise<Result<ReleaseDetail>>;
  /** Import and assessment (M8): read-only. Nothing in the repository is changed or run. */
  importProject(input: { name: string; path: string; idea?: string }): Promise<Result<Project>>;
  assessmentCatalog(): Promise<Result<AssessmentCatalog>>;
  listAssessments(projectId: string): Promise<Result<Assessment[]>>;
  getAssessment(assessmentId: string): Promise<Result<Assessment>>;
  /** Records the scope, then assesses the repository's current commit within it. */
  runAssessment(input: { projectId: string; scope: AssessmentScope }): Promise<Result<Assessment>>;
  /** Learning Studio (M9): design references. Files are chosen in a native dialog and copied into the app. */
  importReferences(input?: { projectId?: string }): Promise<Result<ImportResult>>;
  listReferences(filter?: { projectId?: string | null; query?: string; tag?: string; kind?: string; archived?: boolean }): Promise<Result<DesignReference[]>>;
  getReference(id: string): Promise<Result<DesignReference>>;
  referenceCatalog(): Promise<Result<ReferenceCatalog>>;
  updateReference(input: { id: string; title?: string; kind?: string; tags?: string[]; notes?: string | null; explanation?: string | null; projectId?: string | null }): Promise<Result<DesignReference>>;
  /** Asks the model (simulated or Claude) for a kind, tags and explanation; nothing is applied until accepted or edited. */
  suggestReference(id: string): Promise<Result<DesignReference>>;
  acceptReferenceSuggestion(id: string): Promise<Result<DesignReference>>;
  archiveReference(input: { id: string; archived: boolean }): Promise<Result<DesignReference>>;
  /** Tool cleanup (M11): plan (a dry run, nothing changes), then run or restore after the person approves in a native dialog. */
  cleanupOptions(input: { entryId: string; findingId?: string }): Promise<Result<CleanupOption[]>>;
  planCleanup(input: { entryId: string; action: string; findingId?: string }): Promise<Result<CleanupPlan>>;
  runCleanup(input: { planId: string; acceptDependencies?: boolean; reason?: string }): Promise<Result<CleanupPlan>>;
  restoreCleanup(planId: string): Promise<Result<CleanupPlan>>;
  cancelCleanup(planId: string): Promise<Result<CleanupPlan>>;
  listCleanups(): Promise<Result<CleanupPlan[]>>;
  // External change monitor (M12). Checking only reads trusted sources; nothing is installed.
  checkUpdates(): Promise<Result<UpdateCheck>>;
  getUpdates(): Promise<Result<UpdatesOverview>>;
  approveUpdate(input: { id: string; note?: string }): Promise<Result<UpdateItem>>;
  dismissUpdate(input: { id: string; reason: string }): Promise<Result<UpdateItem>>;
  reopenUpdate(id: string): Promise<Result<UpdateItem>>;
  verifyUpdate(id: string): Promise<Result<UpdateItem>>;
  /** Iterative Layer (M10): self-assessment and the improvement backlog. Approving an item changes nothing in the app. */
  improvementsOverview(filter?: { status?: string }): Promise<Result<ImprovementsOverview>>;
  getImprovement(id: string): Promise<Result<ImprovementDetail>>;
  runSelfAssessment(): Promise<Result<SelfAssessmentRecord>>;
  addFeedback(input: { text: string; title?: string }): Promise<Result<Improvement>>;
  editImprovement(input: { id: string; title?: string; problem?: string; expectedOutcome?: string; successCriteria?: string; priority?: string; risk?: string; dependencies?: string[] }): Promise<Result<ImprovementDetail>>;
  moveImprovement(input: { id: string; to: string; reason?: string; result?: string; measuredOutcome?: string }): Promise<Result<ImprovementDetail>>;
  mergeImprovement(input: { id: string; into: string }): Promise<Result<ImprovementDetail>>;
  /** Planning (M5): concept brief and specification, versioned. */
  getPlanning(projectId: string): Promise<Result<PlanningOverview>>;
  draftBrief(projectId: string): Promise<Result<PlanDoc>>;
  draftSpec(projectId: string): Promise<Result<PlanDoc>>;
  savePlanDraft(input: { docId: string; content: unknown; changeNote?: string | null }): Promise<Result<PlanDoc>>;
  approvePlanDoc(docId: string): Promise<Result<PlanDoc>>;
  revisePlanDoc(docId: string): Promise<Result<PlanDoc>>;
  discardPlanDraft(docId: string): Promise<Result<PlanDoc>>;
  comparePlanDocs(input: { before: string; after: string }): Promise<Result<PlanChange[]>>;
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
  'scanTools',
  'getToolScan',
  'cleanupOptions',
  'planCleanup',
  'runCleanup',
  'restoreCleanup',
  'cancelCleanup',
  'listCleanups',
  'checkUpdates',
  'getUpdates',
  'approveUpdate',
  'dismissUpdate',
  'reopenUpdate',
  'verifyUpdate',
  'runAgent',
  'listAgentTasks',
  'agentStatus',
  'setApiKey',
  'clearApiKey',
  'setProjectRepo',
  'initProjectRepo',
  'listBuilds',
  'getBuild',
  'createBuild',
  'editBuild',
  'startBuild',
  'runBuildAgent',
  'verifyBuild',
  'completeBuild',
  'abandonBuild',
  'buildDiff',
  'listReleases',
  'getRelease',
  'createRelease',
  'editRelease',
  'checkRelease',
  'classifyDrift',
  'addGateException',
  'prepareRelease',
  'abandonRelease',
  'importProject',
  'assessmentCatalog',
  'listAssessments',
  'getAssessment',
  'runAssessment',
  'importReferences',
  'listReferences',
  'getReference',
  'referenceCatalog',
  'updateReference',
  'suggestReference',
  'acceptReferenceSuggestion',
  'archiveReference',
  'improvementsOverview',
  'getImprovement',
  'runSelfAssessment',
  'addFeedback',
  'editImprovement',
  'moveImprovement',
  'mergeImprovement',
  'getPlanning',
  'draftBrief',
  'draftSpec',
  'savePlanDraft',
  'approvePlanDoc',
  'revisePlanDoc',
  'discardPlanDraft',
  'comparePlanDocs',
] as const satisfies readonly IapMethod[];

export const channel = (method: IapMethod) => `iap:${method}`;
