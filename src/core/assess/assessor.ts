// Import an existing repository and assess it, read-only (M8: FR-PROJ-002/003/004, DEC-023).
//
//   import (person: name, folder) → scope recorded → snapshot of the current
//   commit from git's object store → codebase summary and capability findings
//   for that scope only → repository re-checked unchanged → report saved in the
//   app's project folder
//
// Nothing here writes to the repository, runs its code, or contacts an outside
// service. No model is called, so an assessment costs nothing.

import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { ValidationError } from '../errors.ts';
import { credentialLines, redactString } from '../redact.ts';
import type { Assessment, Project, Workspace } from '../workspace.ts';
import { git, inspectRepo } from '../build/git.ts';
import { takeSnapshot } from './snapshot.ts';
import {
  buildIndex,
  CAPABILITIES,
  CAPABILITY_IDS,
  CATEGORIES,
  codebaseObservations,
  evaluateCapability,
  summarizeCodebase,
  type CapabilityFinding,
  type CapabilityStatus,
  type CategoryId,
  type CodebaseSummary,
  type Observation,
} from './capabilities.ts';

export type ScopeKind = 'full' | 'codebase' | 'category' | 'capability';

export interface AssessmentScope {
  kind: ScopeKind;
  /** The category or capability id for a focused assessment; null otherwise. */
  target: string | null;
  /** Capabilities the person said the project does not need. */
  notApplicable: string[];
}

export interface AssessmentReport {
  repository: string;
  commit: string;
  branch: string | null;
  scopeLabel: string;
  /** What was read, so the reader can judge the findings. */
  inspected: string[];
  /** What was not read or not checked, and why. */
  notInspected: string[];
  /** For a focused assessment: what outside the scope had to be read to interpret it. */
  disclosed: string[];
  codebase: CodebaseSummary | null;
  observations: Observation[];
  capabilities: CapabilityFinding[];
  counts: Partial<Record<CapabilityStatus, number>>;
  /** HEAD, every branch and tag, and `git status` were the same before and after. */
  unchanged: boolean;
  unchangedEvidence: string;
}

export const STATUS_LABEL: Record<CapabilityStatus, string> = {
  implemented_in_code: 'Implemented in code',
  configured_externally: 'Configured externally',
  partly_present: 'Partly present',
  missing: 'Missing',
  not_verified: 'Not verified',
  not_applicable: 'Not applicable',
};

const busy = new Set<string>();

export class Assessor {
  private readonly ws: Workspace;

  constructor(ws: Workspace) {
    this.ws = ws;
  }

  /** Registers an existing git repository as a project. Reads only what git needs to confirm it is a repository. */
  async importProject(input: { name: string; path: string; idea?: string }): Promise<Project> {
    const path = typeof input.path === 'string' ? input.path.trim() : '';
    if (!path || !isAbsolute(path)) throw new ValidationError('Give the full path of the repository folder.');
    const repo = await inspectRepo(normalize(path));
    return this.ws.importProject({ name: input.name, idea: input.idea, repoPath: repo.root });
  }

  list(projectId: string): Assessment[] {
    return this.ws.listAssessments(projectId);
  }

  detail(assessmentId: string): Assessment {
    return this.ws.getAssessment(assessmentId);
  }

  /** Records the scope, then assesses the repository's current commit within it. */
  async run(projectId: string, scopeInput: unknown): Promise<Assessment> {
    const project = this.ws.getProject(projectId);
    if (!project.repoPath) throw new ValidationError('Choose the git repository for this project first.');
    const scope = parseScope(scopeInput);
    if (busy.has(project.id)) throw new ValidationError('An assessment of this project is already running.');
    busy.add(project.id);
    const assessment = this.ws.createAssessment({ projectId: project.id, scope, repoPath: project.repoPath });
    let commit: string | null = null;
    try {
      const repo = await inspectRepo(project.repoPath);
      commit = repo.head;
      const before = await repoState(repo.root);
      const report = await this.assess(repo, scope);
      const after = await repoState(repo.root);
      report.unchanged = before === after;
      report.unchangedEvidence = report.unchanged
        ? 'HEAD, every branch and tag, and git status were identical before and after the assessment.'
        : 'The repository changed while the assessment ran (HEAD, a branch, a tag or git status differs). Something else was working in it; run the assessment again.';
      const reportPath = this.writeReport(project, assessment.id, scope, report);
      return this.ws.finishAssessment(assessment.id, { commit, report, reportPath, error: null });
    } catch (e) {
      this.ws.finishAssessment(assessment.id, { commit, report: null, reportPath: null, error: (e as Error).message.slice(0, 2_000) });
      throw e;
    } finally {
      busy.delete(project.id);
    }
  }

  private async assess(repo: { root: string; head: string; branch: string | null }, scope: AssessmentScope): Promise<AssessmentReport> {
    const snapshot = await takeSnapshot(repo.root, repo.head, repo.branch);
    const index = buildIndex(snapshot);
    const caps = capabilitiesIn(scope);
    const codebaseInScope = scope.kind === 'full' || scope.kind === 'codebase';
    const scanCredentials = codebaseInScope || caps.some((c) => c.id === 'secrets');
    const credentials = scanCredentials ? [...snapshot.texts].flatMap(([path, text]) => credentialLines(path, text)) : null;

    const codebase = codebaseInScope ? summarizeCodebase(index) : null;
    const observations = codebase ? codebaseObservations(codebase, index, credentials) : [];
    const capabilities = caps.map((c) => evaluateCapability(c, index, scope.notApplicable.includes(c.id), credentials));
    const counts: AssessmentReport['counts'] = {};
    for (const f of capabilities) counts[f.status] = (counts[f.status] ?? 0) + 1;

    const mb = (n: number) => (n < 1_000_000 ? `${Math.max(1, Math.round(n / 1_000))} KB` : `${(n / 1_000_000).toFixed(1)} MB`);
    const inspected = [
      `Commit ${snapshot.commit.slice(0, 12)}${snapshot.branch ? ` on branch ${snapshot.branch}` : ' (detached HEAD)'} of ${snapshot.root}`,
      `${snapshot.files.length.toLocaleString('en-GB')} files listed at that commit`,
      `${snapshot.texts.size.toLocaleString('en-GB')} text files read (${mb(snapshot.bytesRead)}) from git's object store, not from the working folder`,
      snapshot.manifests.length ? `${snapshot.manifests.length} dependency ${snapshot.manifests.length === 1 ? 'manifest' : 'manifests'}: ${snapshot.manifests.slice(0, 8).join(', ')}${snapshot.manifests.length > 8 ? ', …' : ''}` : 'No dependency manifests were found',
    ];
    if (credentials) inspected.push(`Every text file read was scanned for known credential formats (only file and line are reported)`);

    const notInspected = [
      'Tests, builds and scripts were not run: the assessment never runs code from the repository.',
      'Outside services (hosting, databases, email, DNS, identity and others) were not contacted: no connector is set up, so their real state is "not verified".',
      'Git history before this commit was not read.',
    ];
    if (snapshot.uncommitted.length) notInspected.unshift(`${snapshot.uncommitted.length} uncommitted ${snapshot.uncommitted.length === 1 ? 'change' : 'changes'} in the working folder (the report covers the commit only)`);
    for (const k of snapshot.skipped) notInspected.push(`${k.count.toLocaleString('en-GB')} ${k.reason}, for example ${k.examples.join(', ')}`);
    for (const m of snapshot.submodules) notInspected.push(`Submodule ${m} (a separate repository)`);
    for (const m of snapshot.unreadableManifests) notInspected.push(`Manifest ${m} could not be parsed`);

    const disclosed =
      scope.kind === 'category' || scope.kind === 'capability'
        ? [
            `The list of files at commit ${snapshot.commit.slice(0, 12)}, to match file names`,
            `The ${snapshot.manifests.length} dependency manifests, to know which libraries are declared`,
            `The text of ${snapshot.texts.size.toLocaleString('en-GB')} files, searched only for this scope's patterns; nothing else from them is reported`,
          ]
        : [];

    return {
      repository: snapshot.root,
      commit: snapshot.commit,
      branch: snapshot.branch,
      scopeLabel: scopeLabel(scope),
      inspected,
      notInspected,
      disclosed,
      codebase,
      observations,
      capabilities,
      counts,
      unchanged: false,
      unchangedEvidence: '',
    };
  }

  private writeReport(project: Project, id: string, scope: AssessmentScope, report: AssessmentReport): string {
    // The app's own project folder: the assessed repository is never written to.
    const dir = join(project.workspacePath, 'docs', 'assessments');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.md`);
    writeFileSync(path, renderAssessmentReport(project.name, scope, report));
    return path;
  }
}

/** HEAD, every ref and the working-folder status, as one comparable string. */
async function repoState(root: string): Promise<string> {
  const head = await git(root, ['rev-parse', 'HEAD']);
  const refs = await git(root, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const status = await git(root, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal']);
  return `${head}\n${refs}\n${status}`;
}

/** Validates a scope from a caller. Unknown categories, capabilities or kinds are refused. */
export function parseScope(input: unknown): AssessmentScope {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const kind = i.kind ?? 'full';
  if (kind !== 'full' && kind !== 'codebase' && kind !== 'category' && kind !== 'capability') {
    throw new ValidationError('Choose a full assessment, the codebase only, one category or one capability.');
  }
  let target: string | null = null;
  if (kind === 'category') {
    if (!CATEGORIES.some((c) => c.id === i.target)) throw new ValidationError(`Choose a category: ${CATEGORIES.map((c) => c.id).join(', ')}.`);
    target = i.target as string;
  } else if (kind === 'capability') {
    if (typeof i.target !== 'string' || !CAPABILITY_IDS.includes(i.target)) throw new ValidationError(`Choose a capability: ${CAPABILITY_IDS.join(', ')}.`);
    target = i.target;
  }
  const na = i.notApplicable ?? [];
  if (!Array.isArray(na) || na.some((x) => typeof x !== 'string' || !CAPABILITY_IDS.includes(x))) {
    throw new ValidationError(`Not applicable must list capabilities from: ${CAPABILITY_IDS.join(', ')}.`);
  }
  return { kind, target, notApplicable: [...new Set(na as string[])] };
}

export function capabilitiesIn(scope: AssessmentScope) {
  if (scope.kind === 'codebase') return [];
  if (scope.kind === 'category') return CAPABILITIES.filter((c) => c.category === scope.target);
  if (scope.kind === 'capability') return CAPABILITIES.filter((c) => c.id === scope.target);
  return CAPABILITIES;
}

export function scopeLabel(scope: AssessmentScope): string {
  switch (scope.kind) {
    case 'full':
      return `Full assessment: the codebase and all ${CAPABILITIES.length} capabilities`;
    case 'codebase':
      return 'Codebase only: structure, stack, dependencies, tests, configuration and documentation';
    case 'category': {
      const cat = CATEGORIES.find((c) => c.id === scope.target)!;
      return `One category: ${cat.title} (${capabilitiesIn(scope).length} capabilities)`;
    }
    case 'capability': {
      const cap = CAPABILITIES.find((c) => c.id === scope.target)!;
      return `One capability: ${cap.title} (${CATEGORIES.find((c) => c.id === cap.category)!.title})`;
    }
  }
}

const LEVEL = (l: string) => l.charAt(0).toUpperCase() + l.slice(1);

export function renderAssessmentReport(projectName: string, scope: AssessmentScope, r: AssessmentReport): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = [
    `# Assessment: ${projectName}`,
    '',
    `Scope: **${r.scopeLabel}**. Commit \`${r.commit.slice(0, 12)}\`${r.branch ? ` on \`${r.branch}\`` : ''}.`,
    '',
    'This is an assessment from patterns in the repository, not a compliance certification. A status shows where to look, with its evidence and confidence; read the evidence before relying on it.',
    '',
    `Repository unchanged: **${r.unchanged ? 'yes' : 'NO'}**. ${r.unchangedEvidence}`,
    '',
    '## What was inspected',
    '',
    ...r.inspected.map((x) => `- ${x}`),
    '',
    '## What was not inspected',
    '',
    ...r.notInspected.map((x) => `- ${x}`),
  ];
  if (r.disclosed.length) lines.push('', '## Read outside the scope to interpret it', '', ...r.disclosed.map((x) => `- ${x}`));
  if (r.codebase) {
    const c = r.codebase;
    lines.push('', '## Codebase', '', '### Structure', '', `${c.structure.files} files. Largest folders: ${c.structure.topLevel.map((t) => `${t.name} (${t.files})`).join(', ') || 'none'}.`);
    lines.push('', `Languages by file count: ${c.structure.languages.map((l) => `${l.language} ${l.files}`).join(', ') || 'none recognised'}.`);
    lines.push('', '### Stack', '', ...(c.stack.length ? c.stack.map((s) => `- ${s.name} (${s.evidence})`) : ['No known framework was found in the declared dependencies.']));
    lines.push('', '### Dependencies', '');
    if (!c.dependencies.length) lines.push('No dependencies are declared.');
    for (const d of c.dependencies) lines.push(`- ${d.ecosystem}: ${d.runtime} runtime, ${d.dev} development, in ${d.manifests.join(', ')}. Lockfile: ${d.lockfile ?? 'none'}.`);
    lines.push('', '### Tests', '', `${c.tests.files} test ${c.tests.files === 1 ? 'file' : 'files'}${c.tests.examples.length ? `, for example ${c.tests.examples.join(', ')}` : ''}. Frameworks: ${c.tests.frameworks.join(', ') || 'none declared'}. Test scripts: ${c.tests.scripts.join('; ') || 'none'}. The tests were not run.`);
    lines.push('', '### Configuration', '', ...(c.configuration.length ? c.configuration.map((x) => `- ${x.item}: ${x.evidence}`) : ['Nothing recognised.']));
    lines.push('', '### Documentation', '', ...(c.documentation.length ? c.documentation.map((x) => `- ${x.item}: ${x.evidence}`) : ['Nothing recognised.']));
    lines.push('', '### Findings', '');
    if (!r.observations.length) lines.push('Nothing stood out.');
    for (const o of r.observations) {
      lines.push(`#### ${o.title}`, '', `Impact ${o.impact}, confidence ${o.confidence}. Next: ${o.nextAction}`, '', ...o.evidence.map((e) => `- ${e}`), '');
    }
  }
  if (r.capabilities.length) {
    lines.push('', '## Capabilities', '');
    lines.push(`Summary: ${Object.entries(r.counts).map(([k, n]) => `${STATUS_LABEL[k as CapabilityStatus]} ${n}`).join(', ')}.`, '');
    lines.push('| Category | Capability | Status | Outside the code | Confidence | Impact |', '| --- | --- | --- | --- | --- | --- |');
    for (const f of r.capabilities) {
      lines.push(`| ${CATEGORIES.find((c) => c.id === f.category)!.title} | ${cell(f.title)} | ${STATUS_LABEL[f.status]} | ${f.externalState === 'not_verified' ? 'not verified' : '-'} | ${LEVEL(f.confidence)} | ${LEVEL(f.impact)} |`);
    }
    for (const f of r.capabilities) {
      lines.push('', `### ${f.title}: ${STATUS_LABEL[f.status].toLowerCase()}`, '', f.reasoning, '', `Next: ${f.nextAction}`, '', ...f.evidence.map((e) => `- ${e}`));
    }
  }
  if (scope.kind !== 'full') lines.push('', '## Broader assessment', '', 'This assessment was focused. Run a full assessment to cover the codebase and every capability.');
  return redactString(lines.join('\n')) + '\n';
}

export type { CategoryId };
