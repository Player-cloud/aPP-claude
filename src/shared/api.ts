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
import type { BackupInfo, MaintenanceOverview, RecoveryTest } from '../core/maintain/maintain.ts';
import type { KnownGood } from '../core/workspace.ts';
import type { Preference, PreferenceDetail, Resolution } from '../core/learn/preferences.ts';
import type { NoteKind, NoteStatus, SessionSummary, VaultNote } from '../core/learn/vault.ts';
export type { Preference, PreferenceDetail, PreferenceMatch, PreferenceScope, PreferenceSource, PreferenceStatus, Resolution } from '../core/learn/preferences.ts';
export type { NoteKind, NoteStatus, SessionSummary, SummaryItem, VaultNote } from '../core/learn/vault.ts';
import type { LearningSource, SourceImportResult } from '../core/learn/lessons.ts';
import type { DetectResult, SkillDraft, SkillProposal } from '../core/learn/skills.ts';
import type { AddonDecision, AddonsOverview, Criterion, CriterionReview } from '../core/learn/addons.ts';
export type { Extraction, LearningSource, Lesson, LessonCitation, LessonSuggestion, SourceImportResult, SuggestionKind } from '../core/learn/lessons.ts';
export type { DetectResult, SkillDecision, SkillDraft, SkillDuplicate, SkillExample, SkillProposal, SkillStatus } from '../core/learn/skills.ts';
export type { Addon, AddonDecision, AddonReview, AddonsOverview, AddonStatus, Criterion, CriterionReview, ScanFact } from '../core/learn/addons.ts';

/** A skill proposal with the SKILL.md it would export (M14). */
export interface SkillDetail {
  proposal: SkillProposal;
  skillMd: string;
}
export type { BackupInfo, MaintenanceOverview, PlatformCandidate, ProtectedArea, RecoveryTest } from '../core/maintain/maintain.ts';
export type { BuildSource, KnownGood, Measurement, ProtectedApproval } from '../core/workspace.ts';
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
  /** M13: measure a released item from the self-assessment record, or record the person's own judgement. */
  measureImprovement(id: string): Promise<Result<ImprovementDetail>>;
  recordImprovementOutcome(input: { id: string; verdict: 'improved' | 'not_improved'; detail: string }): Promise<Result<ImprovementDetail>>;
  /** Platform maintenance (M13): approved items become builds in a worktree of the app's own source code. */
  getMaintenance(): Promise<Result<MaintenanceOverview>>;
  setupMaintenance(input: { path: string }): Promise<Result<MaintenanceOverview>>;
  startPlatformWork(input: { improvementId?: string; updateId?: string; kind?: string; components?: string[] }): Promise<Result<Build>>;
  /** Asks in a native dialog first. */
  approveProtectedChange(input: { buildId: string; reason: string }): Promise<Result<BuildDetail>>;
  markKnownGood(input: { releaseId: string; note: string }): Promise<Result<KnownGood>>;
  backupDatabase(): Promise<Result<BackupInfo>>;
  /** Works while the database cannot be opened, too. */
  listBackups(): Promise<Result<BackupInfo[]>>;
  testRecovery(file: string): Promise<Result<RecoveryTest>>;
  /** Asks in a native dialog first. The current database is moved aside, never deleted. */
  restoreBackup(file: string): Promise<Result<{ restored: string; movedAside: string | null; status: AppStatus }>>;
  /** Preferences (M14): proposed wording becomes active only when the person approves it; duplicates and conflicts need a decision. */
  listPreferences(filter?: { status?: string; projectId?: string }): Promise<Result<Preference[]>>;
  getPreference(id: string): Promise<Result<PreferenceDetail>>;
  /** With fromFeedback, the text is recorded as the feedback it came from. */
  proposePreference(input: { text: string; scope?: 'global' | 'project'; projectId?: string; fromFeedback?: boolean }): Promise<Result<PreferenceDetail>>;
  editPreference(input: { id: string; text?: string; scope?: 'global' | 'project'; projectId?: string | null; resolutions?: Resolution[] }): Promise<Result<PreferenceDetail>>;
  approvePreference(input: { id: string; resolutions?: { id: string; action: 'keep_both' | 'replace' }[] }): Promise<Result<PreferenceDetail>>;
  rejectPreference(input: { id: string; reason?: string }): Promise<Result<PreferenceDetail>>;
  removePreference(input: { id: string; reason?: string }): Promise<Result<PreferenceDetail>>;
  /** Session wrap-up (M14): built from the records, saved to the Vault inbox only on request. */
  wrapUp(input?: { from?: string; hours?: number }): Promise<Result<SessionSummary>>;
  saveWrapUp(input: { from: string; to: string; title?: string }): Promise<Result<VaultNote>>;
  listVaultNotes(filter?: { status?: NoteStatus; kind?: NoteKind }): Promise<Result<VaultNote[]>>;
  addVaultNote(input: { title: string; body: string; projectId?: string }): Promise<Result<VaultNote>>;
  editVaultNote(input: { id: string; title?: string; body?: string }): Promise<Result<VaultNote>>;
  fileVaultNote(input: { id: string; status: 'kept' | 'archived' }): Promise<Result<VaultNote>>;
  proposePreferenceFromNote(input: { noteId: string; line: string; scope?: 'global' | 'project'; projectId?: string }): Promise<Result<PreferenceDetail>>;
  /** Lessons (M14): sources come from a native picker; reading one stores lessons and suggestions and changes nothing else. */
  importSources(input?: { projectId?: string }): Promise<Result<SourceImportResult>>;
  listSources(filter?: { archived?: boolean }): Promise<Result<LearningSource[]>>;
  getSource(id: string): Promise<Result<LearningSource>>;
  readLessons(id: string): Promise<Result<LearningSource>>;
  decideSuggestion(input: { sourceId: string; suggestion: number; action: 'preference' | 'improvement' | 'dismiss'; scope?: 'global' | 'project'; projectId?: string }): Promise<Result<LearningSource>>;
  saveLessonsToVault(id: string): Promise<Result<{ source: LearningSource; note: VaultNote }>>;
  archiveSource(input: { id: string; archived?: boolean }): Promise<Result<LearningSource>>;
  /** Skill proposals (M14): from repeated work, checked against the tool scan, exported as a file only. */
  detectSkills(): Promise<Result<DetectResult>>;
  listSkills(filter?: { status?: string }): Promise<Result<SkillProposal[]>>;
  getSkill(id: string): Promise<Result<SkillDetail>>;
  editSkill(input: { id: string } & Partial<Omit<SkillDraft, 'workflow' | 'permissions' | 'tests'> & { workflow: string[]; permissions: string[]; tests: string[] }>): Promise<Result<SkillDetail>>;
  approveSkill(input: { id: string; decisions?: { id: string; note: string }[] }): Promise<Result<SkillDetail>>;
  rejectSkill(input: { id: string; reason: string }): Promise<Result<SkillDetail>>;
  /** Asks for a folder in a native dialog; null when the person cancels. Never writes into Claude Code's folders. */
  exportSkill(id: string): Promise<Result<{ proposal: SkillProposal; path: string } | null>>;
  /** Add-on reviews (M14): a decision is a record; the app never installs or changes an add-on. */
  listAddons(): Promise<Result<AddonsOverview>>;
  reviewAddon(input: { key: string; criteria: Partial<Record<Criterion, CriterionReview>>; decision: AddonDecision; reason: string }): Promise<Result<AddonsOverview>>;
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
  'measureImprovement',
  'recordImprovementOutcome',
  'getMaintenance',
  'setupMaintenance',
  'startPlatformWork',
  'approveProtectedChange',
  'markKnownGood',
  'backupDatabase',
  'listBackups',
  'testRecovery',
  'restoreBackup',
  'listPreferences',
  'getPreference',
  'proposePreference',
  'editPreference',
  'approvePreference',
  'rejectPreference',
  'removePreference',
  'wrapUp',
  'saveWrapUp',
  'listVaultNotes',
  'addVaultNote',
  'editVaultNote',
  'fileVaultNote',
  'proposePreferenceFromNote',
  'importSources',
  'listSources',
  'getSource',
  'readLessons',
  'decideSuggestion',
  'saveLessonsToVault',
  'archiveSource',
  'detectSkills',
  'listSkills',
  'getSkill',
  'editSkill',
  'approveSkill',
  'rejectSkill',
  'exportSkill',
  'listAddons',
  'reviewAddon',
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
