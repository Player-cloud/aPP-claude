#!/usr/bin/env node
// `iap` — command-line surface for the workspace core. The Electron shell will
// call the same core API; the CLI is the first usable interface and the
// end-to-end test harness for milestone M1.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAppHome } from '../core/paths.ts';
import { IapError, StateCorruptError, StateTooNewError, ValidationError } from '../core/errors.ts';
import { moveCorruptStateAside, Workspace, type Fact, type WorkflowRun } from '../core/workspace.ts';
import { defaultScanRoots } from '../core/inventory.ts';
import { runToolScan, type ToolScan } from '../core/tools.ts';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeModel } from '../core/agents/claude.ts';
import { SimulatedModel, type ModelAdapter } from '../core/agents/model.ts';
import { Orchestrator } from '../core/agents/orchestrator.ts';
import { Planner } from '../core/planner.ts';
import { Builder, type BuildDetail } from '../core/build/builder.ts';
import { Releaser, type ReleaseDetail } from '../core/release/releaser.ts';
import type { ReleasePlan } from '../core/release/gates.ts';
import { Assessor, scopeLabel, STATUS_LABEL } from '../core/assess/assessor.ts';
import { CAPABILITIES, CATEGORIES } from '../core/assess/capabilities.ts';
import { Studio, type DesignReference, type ReferenceEdit } from '../core/studio/library.ts';
import { describeAudit } from '../core/design/audit.ts';
import { Cleanup, claudeRunner, type CleanupPlan } from '../core/cleanup/cleanup.ts';
import { bundledVersions, claudeVersionReader, fixtureFetcher, httpFetcher, UpdateMonitor, type UpdateCheck, type UpdateItem } from '../core/updates/updates.ts';
import { CLAUDE_MODEL } from '../core/agents/claude.ts';
import { homedir } from 'node:os';
import { Backlog, type ImprovementDetail, type ImprovementStatus, type SelfAssessmentRecord } from '../core/iterate/backlog.ts';
import type { Assessment } from '../core/workspace.ts';
import { listBackups, Maintenance, restoreBackup, type MaintenanceOverview } from '../core/maintain/maintain.ts';
import type { AgentTask } from '../core/workspace.ts';
import { allowedTransitions, RUN_STATES, WORKFLOWS, type RunState } from '../core/workflow.ts';

const USAGE = `Usage: iap <command> [options]

Projects
  project create --name <name> [--idea <text>] [--confirmed <fact>]... [--assumption <fact>]...
  project list
  project show <projectId>
  project import --name <name> --path <repositoryFolder> [--idea <text>]   Use an existing git repository (nothing in it is changed)

Workflow runs
  run start <projectId> --workflow <${WORKFLOWS.join('|')}> [--title <text>]
  run move <runId> <state> [--reason <text>] [--resolution <text>]
  run list [projectId]
  run show <runId>

Claude Code tools (read-only: nothing is changed or removed)
  tools scan [--include <projectDir>]...   Inventory plugins, skills, commands, agents, hooks and MCP servers, and report conflicts
  tools show                               Show the latest scan

Tool cleanup (changes your Claude Code setup only after --confirm; plans are kept for good)
  tools options <toolId> [--finding <findingId>]        Ways to resolve it, least disruptive first
  tools plan <toolId> --action <keep|configure|disable|replace|uninstall> [--finding <findingId>]   Dry run: nothing changes
  tools run <planId> --confirm [--accept] [--reason <why>]   Make the change (--accept: other tools or workflows depend on it)
  tools restore <planId> --confirm                     Undo it where the app can
  tools cancel <planId> | tools cleanups

Updates (asks trusted sources what is new; nothing is ever installed by the app)
  updates check                               Ask npm, the release notes, the security advisories, the model list (with ANTHROPIC_API_KEY) and plugin marketplaces
  updates list | updates show <UPD-n>
  updates approve <UPD-n> [--note <text>]     Record that you want it (the app shows how to install it; it installs nothing)
  updates dismiss <UPD-n> --reason <why> | updates reopen <UPD-n>
  updates verify <UPD-n>                      After you installed it: check the version and run a fresh tool scan

Main agent (simulated unless a monthly budget is set and ANTHROPIC_API_KEY holds your key)
  agent run [runId] --goal <text> [--title <text>]   Plan, delegate and reconcile a request (the run must be "running")
  agent list <runId>                                 Show the agent tasks for a run

Planning (concept brief → specification, versioned under the project's docs/designs/)
  plan show <projectId>                       Status of the brief and spec, and whether EGM is available
  plan brief <projectId>                      Draft the concept brief from the project's idea and facts
  plan spec <projectId>                       Draft the specification from the approved brief
  plan edit <docId> --file <content.json> [--note <why>]   Replace a draft's content
  plan approve <docId>                        Approve a draft (an approved version never changes)
  plan revise <docId>                         Start the next version of an approved document
  plan discard <docId>                        Discard a draft (kept in the history)
  plan diff <earlierDocId> <laterDocId>       What changed between two versions

Build work (each feature or bug fix gets its own git worktree and branch; nothing is merged for you)
  build repo <projectId> <folder> | --init    Use a git repository for this project (--init: the app's own project folder)
  build new <projectId> --kind <feature|bugfix|ui_polish> --title <t> --goal <text> --check <id=command>...
            [--req <REQ-ID>]... [--component <path>]... [--repro <steps>]
            [--ref <refId>]... [--motion]      ui_polish: Learning Studio references to follow; --motion if animation is asked for
  build start <buildId> --confirm             Create the worktree and run the checks once (--confirm approves the commands)
  build agent <buildId>                       Let the agent change the worktree (simulated unless real calls are on)
  build verify <buildId>                      Run the checks again and review the diff
  build done <buildId> [--note <why the remaining risks are acceptable>]
  build abandon <buildId> [--note <why>]
  build list <projectId> | build show <buildId> | build diff <buildId>

Releases (quality gate and ship-check; preparing a release never deploys, tags or pushes)
  release new <projectId> --version <x.y.z> --check <id=command>... [--build <buildId>]...
            [--target <t>] [--health <t>] [--rollback <t>] [--monitoring <t>] [--migrations <t>] [--env <NAME>]...
  release plan <releaseId> [--build <buildId>]... [plan options as above]   Change the plan or included work
  release check <releaseId> --confirm         Run the ship-check on the repository's current commit (exit 4 if a gate blocks)
  release classify <releaseId> <REQ-ID> --kind <intentional_deviation|spec_change> --note <why>
  release except <releaseId> <gateId> --reason <why> --mitigation <how>      Accept a failed gate (kept for good)
  release prepare <releaseId>                 Mark it prepared (needs every required gate passed or excepted)
  release abandon <releaseId>
  release list <projectId> | release show <releaseId>

Assessment (read-only: reads the repository's current commit from git, never runs its code or contacts outside services)
  assess run <projectId> [--scope <full|codebase|category:<id>|capability:<id>>] [--not-applicable <capabilityId>]...
  assess capabilities                          List the categories and capabilities a scope can name
  assess list <projectId> | assess show <assessmentId>

Learning Studio (design references: copied into the app, never changing a spec)
  ref import <file>... [--project <projectId>]   Add PNG, JPEG, GIF, WebP, MP4, MOV or WebM files (the originals are left alone)
  ref list [--query <text>] [--tag <tag>] [--kind <kind>] [--project <projectId>] [--archived]
  ref show <refId>
  ref edit <refId> [--title <t>] [--kind <kind>] [--tag <tag>]... [--notes <text>] [--explanation <text>] [--project <projectId> | --unlink]
  ref suggest <refId>                         Ask for a kind, tags and explanation (simulated unless real calls are on)
  ref accept <refId>                          Apply the suggestion as it is
  ref archive <refId> [--restore]             Hide it from the library (references are never deleted)

Improvements (the app assesses its own records; approving an item changes nothing in the app)
  iter assess                                 Read the app's own records and file what went wrong as backlog items
  iter list [--status <status>]               Statuses: idea, proposed, approved, in_progress, verified, released, blocked, rejected
  iter show <IMP-n>
  iter feedback <text> [--title <t>]          Add an idea
  iter edit <IMP-n> [--title <t>] [--problem <t>] [--expected <t>] [--criteria <t>] [--priority <low|medium|high>]
            [--risk <low|medium|high>] [--depends <IMP-n>]...      Only before approval
  iter move <IMP-n> <status> [--reason <why>] [--result <what was done>] [--outcome <measured outcome>]
  iter merge <duplicate IMP-n> --into <IMP-n>  Link a duplicate to the item that stays (nothing is deleted)
  iter measure <IMP-n>                        After release: did the problem come back? (reopens it as a new item if so)
  iter outcome <IMP-n> --verdict <improved|not_improved> --note <what you observed>   Your own judgement, for items no detector counts

Platform maintenance (approved items are built in worktrees of the app's own source; the running app is never changed)
  platform setup <sourceFolder>              Use the app's source repository (records the running version as known-good)
  platform status
  platform start <IMP-n|UPD-n> [--kind <feature|bugfix|ui_polish>] [--component <path>]... [--check <id=command>]...
                                              A build with the mandatory checks; then: iap build start <buildId> --confirm
  platform approve <buildId> --reason <why> --confirm   Approve its changes to protected areas (permissions, security, gates, config, data)
  platform backup | platform backups          Copy the database before installing a new version; list the copies
  platform test-recovery <backupFile>         Open a copy of a backup in a throwaway folder, as a restore would
  platform known-good <releaseId> --note <health check result>   From the installed version: record it as known-good

Audit and health
  events [--project <id>] [--run <id>] [--limit <n>]
  doctor
  recover --confirm        If the database is corrupt, move it aside (kept, not deleted) and start fresh
  recover --from <backupFile> --confirm   With the app closed: put a backup in place (the current database is moved aside)

Global options
  --json                   Machine-readable output
  Data directory: $IAP_HOME, or the OS default (see docs/OPERATIONS.md)

Run states: ${RUN_STATES.join(', ')}`;

type Out = (line: string) => void;

export async function run(argv: string[], out: Out = console.log, err: Out = console.error): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      idea: { type: 'string' },
      confirmed: { type: 'string', multiple: true },
      assumption: { type: 'string', multiple: true },
      workflow: { type: 'string' },
      title: { type: 'string' },
      reason: { type: 'string' },
      resolution: { type: 'string' },
      project: { type: 'string' },
      run: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean', default: false },
      confirm: { type: 'boolean', default: false },
      include: { type: 'string', multiple: true },
      goal: { type: 'string' },
      file: { type: 'string' },
      note: { type: 'string' },
      kind: { type: 'string' },
      check: { type: 'string', multiple: true },
      req: { type: 'string', multiple: true },
      component: { type: 'string', multiple: true },
      repro: { type: 'string' },
      init: { type: 'boolean', default: false },
      version: { type: 'string' },
      build: { type: 'string', multiple: true },
      target: { type: 'string' },
      health: { type: 'string' },
      rollback: { type: 'string' },
      monitoring: { type: 'string' },
      migrations: { type: 'string' },
      env: { type: 'string', multiple: true },
      mitigation: { type: 'string' },
      path: { type: 'string' },
      scope: { type: 'string' },
      'not-applicable': { type: 'string', multiple: true },
      query: { type: 'string' },
      tag: { type: 'string', multiple: true },
      notes: { type: 'string' },
      explanation: { type: 'string' },
      unlink: { type: 'boolean', default: false },
      archived: { type: 'boolean', default: false },
      restore: { type: 'boolean', default: false },
      ref: { type: 'string', multiple: true },
      motion: { type: 'boolean', default: false },
      status: { type: 'string' },
      problem: { type: 'string' },
      expected: { type: 'string' },
      criteria: { type: 'string' },
      priority: { type: 'string' },
      risk: { type: 'string' },
      depends: { type: 'string', multiple: true },
      result: { type: 'string' },
      outcome: { type: 'string' },
      into: { type: 'string' },
      action: { type: 'string' },
      finding: { type: 'string' },
      accept: { type: 'boolean', default: false },
      from: { type: 'string' },
      verdict: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, sub, ...rest] = positionals;
  const home = resolveAppHome();
  const print = (data: unknown, human: () => void) => (values.json ? out(JSON.stringify(data, null, 2)) : human());
  const planOptions = () => {
    const p: Partial<ReleasePlan> = {};
    if (values.target !== undefined) p.target = values.target;
    if (values.health !== undefined) p.healthCheck = values.health;
    if (values.rollback !== undefined) p.rollback = values.rollback;
    if (values.monitoring !== undefined) p.monitoring = values.monitoring;
    if (values.migrations !== undefined) p.migrations = values.migrations;
    if (values.env !== undefined) p.envVars = values.env;
    return p;
  };

  if (!command || values.help) {
    out(USAGE);
    return command ? 0 : 1;
  }

  // `recover` must work when the database cannot be opened, so it runs first.
  if (command === 'recover' && values.from !== undefined) {
    const backups = listBackups(home);
    const info = backups.find((b) => b.path === resolve(values.from!) || b.file === values.from);
    if (!info) {
      err(`${values.from} is not in the backups folder. Backups:\n${backups.map((b) => `  ${b.file}`).join('\n') || '  none'}`);
      return 1;
    }
    if (!values.confirm) {
      err(`recover --from replaces the current database with the backup ${info.file} (taken by ${info.version ?? 'an unknown version'}). The current database is moved aside, not deleted. Close the app first, then re-run with --confirm.`);
      return 1;
    }
    try {
      const r = restoreBackup(home, info.path);
      const ws = Workspace.open(home);
      try {
        ws.recordPlatformEvent('platform.restored', { backup: r.restored, movedAside: r.movedAside, via: 'cli' });
      } finally {
        ws.close();
      }
      print(r, () => out(`Restored ${r.restored}.${r.movedAside ? ` The previous database is at ${r.movedAside}.` : ''}`));
      return 0;
    } catch (e) {
      return fail(e, err);
    }
  }
  if (command === 'recover') {
    if (!values.confirm) {
      err('recover moves the current database aside and starts a new, empty one. Re-run with --confirm to proceed.');
      return 1;
    }
    try {
      Workspace.open(home).close();
      err('The database opened and passed its integrity check, so there is nothing to recover. Nothing was moved.');
      return 1;
    } catch (e) {
      if (!(e instanceof StateCorruptError)) return fail(e, err);
    }
    const moved = moveCorruptStateAside(home);
    print({ moved }, () => out(moved ? `Moved database to ${moved}. A fresh database will be created on next use.` : 'No database found; nothing to recover.'));
    return 0;
  }

  let ws: Workspace;
  try {
    ws = Workspace.open(home);
  } catch (e) {
    return fail(e, err);
  }

  try {
    switch (`${command} ${sub ?? ''}`.trim()) {
      case 'project create': {
        const facts: Fact[] = [
          ...(values.confirmed ?? []).map((text) => ({ kind: 'confirmed' as const, text })),
          ...(values.assumption ?? []).map((text) => ({ kind: 'assumption' as const, text })),
        ];
        const project = ws.createProject({ name: values.name ?? '', idea: values.idea, facts });
        print(project, () => {
          out(`Created project ${project.id} "${project.name}"`);
          out(`  workspace: ${project.workspacePath}`);
          out(`  designs:   ${project.docsPath}`);
        });
        return 0;
      }
      case 'project list': {
        const projects = ws.listProjects();
        print(projects, () => {
          if (!projects.length) out('No projects yet. Create one with: iap project create --name <name>');
          for (const p of projects) out(`${p.id}  ${p.status.padEnd(8)}  ${p.name}`);
        });
        return 0;
      }
      case 'project import': {
        const project = await new Assessor(ws).importProject({ name: values.name ?? '', path: values.path ?? '', idea: values.idea });
        print(project, () => {
          out(`Imported ${project.id} "${project.name}" from ${project.repoPath}`);
          out('  Nothing in the repository was changed. Assess it with: iap assess run ' + project.id);
        });
        return 0;
      }
      case 'assess run': {
        const a = await new Assessor(ws).run(need(rest[0], 'projectId'), parseScopeOption(values.scope, values['not-applicable']));
        print(a, () => describeAssessment(a, out));
        return 0;
      }
      case 'assess capabilities': {
        print({ categories: CATEGORIES, capabilities: CAPABILITIES.map(({ id, title, category }) => ({ id, title, category })) }, () => {
          for (const c of CATEGORIES) {
            out(`${c.id}  (${c.title})`);
            for (const cap of CAPABILITIES.filter((x) => x.category === c.id)) out(`  ${cap.id.padEnd(16)} ${cap.title}`);
          }
        });
        return 0;
      }
      case 'assess list': {
        const list = ws.listAssessments(need(rest[0], 'projectId'));
        print(list, () => {
          if (!list.length) out('No assessments yet.');
          for (const a of list) out(`${a.id}  ${a.status.padEnd(9)} ${a.commit?.slice(0, 12) ?? '-'.padEnd(12)}  ${scopeLabel(a.scope)}`);
        });
        return 0;
      }
      case 'assess show': {
        const a = ws.getAssessment(need(rest[0], 'assessmentId'));
        print(a, () => describeAssessment(a, out));
        return 0;
      }
      case 'ref import': {
        if (!rest.length) throw new ValidationError('Missing <file>.');
        const result = await new Studio(ws, new SimulatedModel()).importFiles(rest.map((f) => resolve(f)), values.project ?? null);
        print(result, () => {
          for (const r of result.imported) out(`Added ${r.id}  ${r.kind.padEnd(12)} ${r.title}`);
          for (const s of result.skipped) out(`Skipped ${s.file}: ${s.reason}`);
        });
        return result.imported.length || !result.skipped.length ? 0 : 1;
      }
      case 'ref list': {
        const list = new Studio(ws, new SimulatedModel()).list({ projectId: values.project, query: values.query, tag: values.tag?.[0], kind: values.kind, archived: values.archived });
        print(list, () => {
          if (!list.length) out('No references match.');
          for (const r of list) out(`${r.id}  ${r.kind.padEnd(12)} ${r.title}${r.tags.length ? `  [${r.tags.join(', ')}]` : ''}`);
        });
        return 0;
      }
      case 'ref show': {
        const r = ws.getReference(need(rest[0], 'refId'));
        print(r, () => describeReference(r, out));
        return 0;
      }
      case 'ref edit': {
        const edit: ReferenceEdit = {};
        if (values.title !== undefined) edit.title = values.title;
        if (values.kind !== undefined) edit.kind = values.kind;
        if (values.tag !== undefined) edit.tags = values.tag;
        if (values.notes !== undefined) edit.notes = values.notes || null;
        if (values.explanation !== undefined) edit.explanation = values.explanation || null;
        if (values.unlink) edit.projectId = null;
        else if (values.project !== undefined) edit.projectId = values.project;
        const r = new Studio(ws, new SimulatedModel()).update(need(rest[0], 'refId'), edit);
        print(r, () => describeReference(r, out));
        return 0;
      }
      case 'ref suggest':
      case 'ref accept': {
        const id = need(rest[0], 'refId');
        const r = sub === 'suggest' ? await new Studio(ws, agentModel(ws)).suggest(id) : new Studio(ws, new SimulatedModel()).acceptSuggestion(id);
        print(r, () => describeReference(r, out));
        return 0;
      }
      case 'ref archive': {
        const r = new Studio(ws, new SimulatedModel()).archive(need(rest[0], 'refId'), !values.restore);
        print(r, () => out(`${r.id} is ${r.status}.`));
        return 0;
      }
      case 'tools options': {
        const opts = cliCleanup(ws).options(need(rest[0], 'toolId'), values.finding ?? null);
        print(opts, () => {
          for (const o of opts) out(`${o.available ? '✓' : '✗'} ${o.action.padEnd(10)} ${o.label}: ${o.available ? o.detail : o.why}`);
        });
        return 0;
      }
      case 'tools plan': {
        const p = cliCleanup(ws).plan(need(rest[0], 'toolId'), need(values.action, '--action'), values.finding ?? null);
        print(p, () => describeCleanup(p, out));
        return 0;
      }
      case 'tools run':
      case 'tools restore': {
        const id = need(rest[0], 'planId');
        const p = ws.getCleanupPlan(id);
        if (!values.confirm && (sub === 'restore' || p.mechanism !== 'record')) {
          describeCleanup(p, err);
          err('Re-run with --confirm to make this change.');
          return 1;
        }
        const done = sub === 'run' ? await cliCleanup(ws).execute(id, { acceptDependencies: values.accept, reason: values.reason ?? null }) : await cliCleanup(ws).restore(id);
        print(done, () => describeCleanup(done, out));
        return done.status === 'done' || done.status === 'recorded' || done.status === 'restored' ? 0 : 1;
      }
      case 'tools cancel': {
        const p = cliCleanup(ws).cancel(need(rest[0], 'planId'));
        print(p, () => out(`${p.id} is cancelled. Nothing was changed.`));
        return 0;
      }
      case 'tools cleanups': {
        const list = ws.listCleanupPlans();
        print(list, () => {
          if (!list.length) out('No cleanup plans yet.');
          for (const p of list) out(`${p.id}  ${p.status.padEnd(9)} ${p.action.padEnd(9)} ${p.entry.invocation ?? p.entry.name}`);
        });
        return 0;
      }
      case 'updates check': {
        const c = await cliUpdates(ws).check();
        print(c, () => describeCheck(c, ws, out));
        return 0;
      }
      case 'updates list': {
        const { items, stale } = cliUpdates(ws).overview();
        print(items, () => {
          if (!items.length) out('Nothing found yet. Run: iap updates check');
          for (const i of items) out(`UPD-${i.number}  ${i.stage.padEnd(11)} ${i.priority.padEnd(11)} ${i.title}`);
          for (const s of stale) out(`stale source: ${s.name} (last answered ${s.lastOk ?? 'never'})`);
        });
        return 0;
      }
      case 'updates show': {
        const i = ws.getUpdate(updateId(ws, need(rest[0], 'UPD-n')));
        print(i, () => describeUpdate(i, out));
        return 0;
      }
      case 'updates approve':
      case 'updates dismiss':
      case 'updates reopen':
      case 'updates verify': {
        const m = cliUpdates(ws);
        const id = updateId(ws, need(rest[0], 'UPD-n'));
        const i = sub === 'approve' ? m.approve(id, values.note ?? null) : sub === 'dismiss' ? m.dismiss(id, values.reason ?? '') : sub === 'reopen' ? m.reopen(id) : await m.verify(id);
        print(i, () => describeUpdate(i, out));
        return sub === 'verify' && i.stage === 'failed' ? 4 : 0;
      }
      case 'iter assess': {
        const a = new Backlog(ws).assess();
        print(a, () => describeSelfAssessment(a, out));
        return 0;
      }
      case 'iter list': {
        const { items } = new Backlog(ws).overview({ status: values.status });
        print(items, () => {
          if (!items.length) out('No improvements yet. Run: iap iter assess, or add one with: iap iter feedback <text>');
          for (const i of items) out(`IMP-${i.number}  ${i.status.padEnd(11)} ${i.priority.padEnd(6)} ${i.title}`);
        });
        return 0;
      }
      case 'iter show': {
        const b = new Backlog(ws);
        const d = b.detail(b.resolve(need(rest[0], 'IMP-n')).id);
        print(d, () => describeImprovement(d, out));
        return 0;
      }
      case 'iter feedback': {
        const i = new Backlog(ws).feedback({ text: rest.join(' '), title: values.title });
        print(i, () => out(`Added IMP-${i.number} as an idea: ${i.title}`));
        return 0;
      }
      case 'iter edit': {
        const b = new Backlog(ws);
        const id = b.resolve(need(rest[0], 'IMP-n')).id;
        const fields: Record<string, unknown> = {};
        if (values.title !== undefined) fields.title = values.title;
        if (values.problem !== undefined) fields.problem = values.problem;
        if (values.expected !== undefined) fields.expectedOutcome = values.expected;
        if (values.criteria !== undefined) fields.successCriteria = values.criteria;
        if (values.priority !== undefined) fields.priority = values.priority;
        if (values.risk !== undefined) fields.risk = values.risk;
        if (values.depends !== undefined) fields.dependencies = values.depends.map((d) => b.resolve(d).id);
        b.edit(id, fields);
        const d = b.detail(id);
        print(d, () => describeImprovement(d, out));
        return 0;
      }
      case 'iter move': {
        const b = new Backlog(ws);
        const id = b.resolve(need(rest[0], 'IMP-n')).id;
        b.move(id, { to: need(rest[1], 'status') as ImprovementStatus, reason: values.reason, result: values.result, measuredOutcome: values.outcome });
        const d = b.detail(id);
        print(d, () => out(`IMP-${d.item.number} is ${d.item.status}.${d.item.approver && d.item.status === 'approved' ? ` Approved by ${d.item.approver}.` : ''}`));
        return 0;
      }
      case 'iter merge': {
        const b = new Backlog(ws);
        const kept = b.merge(b.resolve(need(rest[0], 'IMP-n')).id, b.resolve(need(values.into, '--into')).id);
        print(kept, () => out(`Merged into IMP-${kept.number}: ${kept.title}`));
        return 0;
      }
      case 'iter measure': {
        const b = new Backlog(ws);
        const id = b.resolve(need(rest[0], 'IMP-n')).id;
        const m = b.measure(id);
        const d = b.detail(id);
        print(d, () => {
          out(`IMP-${d.item.number} ${m.verdict.replace('_', ' ')}: ${m.detail}`);
          if (d.reopenedBy) out(`Reopened as IMP-${d.reopenedBy.number} (proposed): ${d.reopenedBy.title}`);
        });
        return m.verdict === 'not_improved' ? 4 : 0;
      }
      case 'iter outcome': {
        const b = new Backlog(ws);
        const id = b.resolve(need(rest[0], 'IMP-n')).id;
        const m = b.recordOutcome(id, values.verdict, values.note);
        const d = b.detail(id);
        print(d, () => out(`IMP-${d.item.number} ${m.verdict.replace('_', ' ')}.${d.reopenedBy ? ` Reopened as IMP-${d.reopenedBy.number}.` : ''}`));
        return 0;
      }
      case 'platform setup':
      case 'platform status': {
        const m = maintenance(ws);
        const o = sub === 'setup' ? await m.setup(resolve(need(rest[0], 'sourceFolder'))) : m.overview();
        print(o, () => describeMaintenance(o, out));
        return 0;
      }
      case 'platform start': {
        const ref = need(rest[0], 'IMP-n|UPD-n');
        const isUpdate = /^UPD-/i.test(ref) || ref.startsWith('upd_');
        const b = maintenance(ws).start({ [isUpdate ? 'updateId' : 'improvementId']: ref, kind: values.kind as 'feature' | undefined, components: values.component, checks: parseChecks(values.check) });
        print(b, () => out(`${b.id}  platform ${b.kind} draft: ${b.title}\n  checks: ${b.checks.map((c) => c.command).join('; ')}\nStart it with: iap build start ${b.id} --confirm`));
        return 0;
      }
      case 'platform approve': {
        const id = need(rest[0], 'buildId');
        const m = maintenance(ws);
        const request = m.protectedRequest(id, values.reason ?? '');
        if (!values.confirm) {
          err(`This approves changes to protected areas:\n${request.lines.map((l) => `  ${l}`).join('\n')}\nRe-run with --confirm to approve them.`);
          return 1;
        }
        const b = m.approveProtected(id, values.reason ?? '');
        print(b, () => out(`Approved by ${b.protectedApproval!.by}: ${b.protectedApproval!.files.join(', ')}`));
        return 0;
      }
      case 'platform backup': {
        const info = maintenance(ws).backup();
        print(info, () => out(`Backed up to ${info.path} (data format ${info.schemaVersion}, ${info.sizeBytes} bytes). Test it with: iap platform test-recovery ${info.file}`));
        return 0;
      }
      case 'platform backups': {
        const list = listBackups(home);
        print(list, () => {
          if (!list.length) out('No backups yet. Take one with: iap platform backup');
          for (const b of list) out(`${b.file}  data format ${b.schemaVersion ?? '?'}  ${b.restorable ? 'restorable' : `NOT restorable: ${b.problem}`}`);
        });
        return 0;
      }
      case 'platform test-recovery': {
        const r = maintenance(ws).testRecovery(need(rest[0], 'backupFile'));
        print(r, () => out(`${r.passed ? 'PASSED' : 'FAILED'}: ${r.detail}`));
        return r.passed ? 0 : 4;
      }
      case 'platform known-good': {
        const k = maintenance(ws).markKnownGood(need(rest[0], 'releaseId'), values.note ?? '');
        print(k, () => out(`${k.version} is recorded as known-good${k.backupPath ? `, with the backup ${k.backupPath}` : ''}.`));
        return 0;
      }
      case 'project show': {
        const project = ws.getProject(need(rest[0], 'projectId'));
        const runs = ws.listRuns(project.id);
        print({ ...project, runs }, () => {
          out(`${project.name} (${project.id})`);
          out(`  status: ${project.status}   origin: ${project.origin}   created: ${project.createdAt}`);
          if (project.idea) out(`  idea: ${project.idea}`);
          if (project.repoPath) out(`  repository: ${project.repoPath}`);
          const confirmed = project.facts.filter((f) => f.kind === 'confirmed');
          const assumptions = project.facts.filter((f) => f.kind === 'assumption');
          out(`  confirmed (${confirmed.length}):`);
          for (const f of confirmed) out(`    - ${f.text}`);
          out(`  assumptions (${assumptions.length}):`);
          for (const f of assumptions) out(`    - ${f.text}`);
          out(`  runs (${runs.length}):`);
          for (const r of runs) out(`    ${describeRun(r)}`);
        });
        return 0;
      }
      case 'run start': {
        const created = ws.startRun({
          projectId: need(rest[0], 'projectId'),
          workflow: values.workflow ?? '',
          title: values.title,
        });
        print(created, () => out(`Started ${describeRun(created)}`));
        return 0;
      }
      case 'run move': {
        const to = need(rest[1], 'state');
        if (!(RUN_STATES as readonly string[]).includes(to)) throw new ValidationError(`Unknown state "${to}".`);
        const moved = ws.transitionRun(need(rest[0], 'runId'), {
          to: to as RunState,
          reason: values.reason,
          resolution: values.resolution,
        });
        print(moved, () => out(describeRun(moved)));
        return 0;
      }
      case 'run list': {
        const runs = ws.listRuns(rest[0]);
        print(runs, () => {
          if (!runs.length) out('No workflow runs.');
          for (const r of runs) out(describeRun(r));
        });
        return 0;
      }
      case 'run show': {
        const shown = ws.getRun(need(rest[0], 'runId'));
        const history = ws.listEvents({ runId: shown.id, limit: 10_000 });
        print({ ...shown, next: allowedTransitions(shown.state, shown.blockedFrom), history }, () => {
          out(describeRun(shown));
          out(`  next allowed: ${allowedTransitions(shown.state, shown.blockedFrom).join(', ') || 'none (terminal)'}`);
          for (const e of history) out(`  ${e.at}  ${e.type}  ${JSON.stringify(e.payload)}`);
        });
        return 0;
      }
      case 'events': {
        const limit = values.limit ? Number.parseInt(values.limit, 10) : 50;
        if (!Number.isFinite(limit)) throw new ValidationError('--limit must be a number.');
        const events = ws.listEvents({ projectId: values.project, runId: values.run, limit });
        print(events, () => {
          for (const e of events) {
            out(`#${e.seq} ${e.at} ${e.actor} ${e.type} ${e.projectId ?? '-'} ${e.runId ?? '-'} ${JSON.stringify(e.payload)}`);
          }
        });
        return 0;
      }
      case 'tools scan': {
        const scan = ws.saveToolScan(runToolScan(defaultScanRoots(process.env, process.platform, undefined, (values.include ?? []).map((d) => resolve(d)))));
        print(scan, () => describeScan(scan, out));
        return 0;
      }
      case 'tools show': {
        const scan = ws.latestToolScan();
        print(scan, () => (scan ? describeScan(scan, out) : out('No scan yet. Run: iap tools scan')));
        return 0;
      }
      case 'agent run': {
        const goal = values.goal ?? '';
        const root = await new Orchestrator(ws, agentModel(ws)).run({ runId: rest[0] ?? null, title: values.title ?? goal.slice(0, 80), goal });
        const tasks = [root, ...ws.listAgentTasks({ parentId: root.id })];
        print(tasks, () => tasks.forEach((t) => out(describeTask(t))));
        return root.status === 'succeeded' ? 0 : 4;
      }
      case 'agent list': {
        const tasks = ws.listAgentTasks({ runId: need(rest[0], 'runId') });
        print(tasks, () => {
          if (!tasks.length) out('No agent tasks for this run.');
          for (const t of tasks) out(describeTask(t));
        });
        return 0;
      }
      case 'plan show': {
        const o = new Planner(ws, new SimulatedModel()).overview(need(rest[0], 'projectId'));
        print(o, () => {
          for (const kind of ['brief', 'spec'] as const) {
            const part = o[kind];
            out(`${kind === 'brief' ? 'Concept brief' : 'Specification'}:`);
            if (!part.versions.length) out('  not started');
            for (const d of part.versions) out(`  ${d.id}  v${d.version}  ${d.status.padEnd(10)} drafted by ${d.source}${d.changeNote ? `  (${d.changeNote})` : ''}`);
          }
          if (o.specOutdated) out('The approved spec was drafted from an older brief: revise it.');
          out(`EGM: ${o.egm.message}`);
        });
        return 0;
      }
      case 'plan brief':
      case 'plan spec': {
        const planner = new Planner(ws, agentModel(ws));
        const doc = sub === 'brief' ? await planner.draftBrief(need(rest[0], 'projectId')) : await planner.draftSpec(need(rest[0], 'projectId'));
        print(doc, () => out(`${doc.id}  v${doc.version} draft, drafted by ${doc.source}. Edit it with: iap plan edit ${doc.id} --file <content.json>`));
        return 0;
      }
      case 'plan edit': {
        if (!values.file) throw new ValidationError('--file is required.');
        let content: unknown;
        try {
          content = JSON.parse(readFileSync(values.file, 'utf8'));
        } catch (e) {
          throw new ValidationError(`Could not read ${values.file} as JSON: ${(e as Error).message}`);
        }
        const doc = new Planner(ws, new SimulatedModel()).saveDraft(need(rest[0], 'docId'), { content, changeNote: values.note });
        print(doc, () => out(`${doc.id}  v${doc.version} saved`));
        return 0;
      }
      case 'plan approve':
      case 'plan revise':
      case 'plan discard': {
        const planner = new Planner(ws, new SimulatedModel());
        const id = need(rest[0], 'docId');
        const doc = sub === 'approve' ? planner.approve(id) : sub === 'revise' ? planner.revise(id) : planner.discard(id);
        print(doc, () => {
          out(`${doc.id}  ${doc.kind} v${doc.version} ${doc.status}`);
          for (const c of doc.changes ?? []) out(`  ${c.kind} ${c.target}: ${c.detail}`);
        });
        return 0;
      }
      case 'plan diff': {
        const changes = new Planner(ws, new SimulatedModel()).compare(need(rest[0], 'earlierDocId'), need(rest[1], 'laterDocId'));
        print(changes, () => {
          if (!changes.length) out('No differences.');
          for (const c of changes) out(`${c.kind.padEnd(8)} ${c.target}: ${c.detail}`);
        });
        return 0;
      }
      case 'build repo': {
        const builder = new Builder(ws, new SimulatedModel());
        const projectId = need(rest[0], 'projectId');
        const p = values.init ? await builder.initProjectRepo(projectId) : await builder.setRepo(projectId, resolve(need(rest[1], 'folder')));
        print(p, () => out(`Build work for ${p.name} happens in ${p.repoPath}`));
        return 0;
      }
      case 'build new': {
        const checks = parseChecks(values.check);
        const b = new Builder(ws, new SimulatedModel()).create(need(rest[0], 'projectId'), {
          kind: (values.kind ?? '') as 'feature',
          title: values.title ?? '',
          goal: values.goal ?? '',
          requirementIds: values.req,
          components: values.component,
          checks,
          repro: values.repro ?? null,
          referenceIds: values.ref,
          motion: values.motion,
        });
        print(b, () => out(`${b.id}  ${b.kind} draft: ${b.title}. Start it with: iap build start ${b.id} --confirm`));
        return 0;
      }
      case 'build start': {
        const id = need(rest[0], 'buildId');
        const b = ws.getBuild(id);
        if (!values.confirm) {
          err(`These commands will run on this computer with your permissions:\n${b.checks.map((c) => `  ${c.id}: ${c.command}`).join('\n')}\nRe-run with --confirm to approve them.`);
          return 1;
        }
        const d = await new Builder(ws, new SimulatedModel()).start(id);
        print(d, () => describeBuild(d, out));
        return 0;
      }
      case 'build agent':
      case 'build verify': {
        const id = need(rest[0], 'buildId');
        const d = sub === 'agent' ? await new Builder(ws, agentModel(ws)).runAgent(id) : await new Builder(ws, new SimulatedModel()).verify(id);
        print(d, () => describeBuild(d, out));
        return 0;
      }
      case 'build done':
      case 'build abandon': {
        const builder = new Builder(ws, new SimulatedModel());
        const id = need(rest[0], 'buildId');
        const d = sub === 'done' ? await builder.complete(id, values.note ?? null) : builder.abandon(id, values.note ?? null);
        print(d, () => describeBuild(d, out));
        return 0;
      }
      case 'build list': {
        const builds = ws.listBuilds(need(rest[0], 'projectId'));
        print(builds, () => {
          if (!builds.length) out('No build work yet.');
          for (const b of builds) out(`${b.id}  ${b.kind.padEnd(8)} ${b.status.padEnd(12)} ${b.title}`);
        });
        return 0;
      }
      case 'build show': {
        const d = new Builder(ws, new SimulatedModel()).detail(need(rest[0], 'buildId'));
        print(d, () => describeBuild(d, out));
        return 0;
      }
      case 'build diff': {
        const diff = await new Builder(ws, new SimulatedModel()).diff(need(rest[0], 'buildId'));
        print(diff, () => out(diff.patch || 'No changes.'));
        return 0;
      }
      case 'release new': {
        const r = new Releaser(ws).create(need(rest[0], 'projectId'), { version: values.version ?? '', plan: planOptions(), checks: parseChecks(values.check), buildIds: values.build ?? [] });
        print(r, () => out(`${r.id}  release ${r.version} draft. Run the ship-check with: iap release check ${r.id} --confirm`));
        return 0;
      }
      case 'release plan': {
        const id = need(rest[0], 'releaseId');
        const current = ws.getRelease(id);
        const r = new Releaser(ws).edit(id, { plan: { ...current.plan, ...planOptions() }, buildIds: values.build });
        print(r, () => out(`${r.id}  release ${r.version} ${r.status}. Run the ship-check again.`));
        return 0;
      }
      case 'release check': {
        const id = need(rest[0], 'releaseId');
        const r = ws.getRelease(id);
        if (!values.confirm) {
          err(`These commands will run on this computer with your permissions:\n${r.checks.map((c) => `  ${c.id}: ${c.command}`).join('\n')}\nRe-run with --confirm to approve them.`);
          return 1;
        }
        const d = await new Releaser(ws).check(id);
        print(d, () => describeRelease(d, out));
        return d.blocking.length ? 4 : 0;
      }
      case 'release classify': {
        const d = new Releaser(ws).classify(need(rest[0], 'releaseId'), need(rest[1], 'REQ-ID'), values.kind ?? '', values.note ?? '');
        print(d, () => describeRelease(d, out));
        return 0;
      }
      case 'release except': {
        const d = new Releaser(ws).addException(need(rest[0], 'releaseId'), need(rest[1], 'gateId'), values.reason ?? '', values.mitigation ?? '');
        print(d, () => describeRelease(d, out));
        return 0;
      }
      case 'release prepare':
      case 'release abandon': {
        const releaser = new Releaser(ws);
        const id = need(rest[0], 'releaseId');
        const d = sub === 'prepare' ? await releaser.prepare(id) : releaser.abandon(id);
        print(d, () => describeRelease(d, out));
        return 0;
      }
      case 'release list': {
        const releases = ws.listReleases(need(rest[0], 'projectId'));
        print(releases, () => {
          if (!releases.length) out('No releases yet.');
          for (const r of releases) out(`${r.id}  ${r.version.padEnd(10)} ${r.status.padEnd(10)} ${r.ready === null ? 'not checked' : r.ready ? 'ready' : 'blocked'}`);
        });
        return 0;
      }
      case 'release show': {
        const d = new Releaser(ws).detail(need(rest[0], 'releaseId'));
        print(d, () => describeRelease(d, out));
        return 0;
      }
      case 'doctor': {
        const health = ws.health();
        print({ home, db: ws.paths.db, ...health }, () => {
          out(`data directory: ${home}`);
          out(`database:       ${ws.paths.db}`);
          out(`schema version: ${health.schemaVersion}`);
          out(`integrity:      ${health.integrity}`);
          out(`projects: ${health.projects}   runs: ${health.runs}   events: ${health.events}`);
        });
        return health.integrity === 'ok' ? 0 : 2;
      }
      default:
        err(`Unknown command "${positionals.join(' ')}".\n\n${USAGE}`);
        return 1;
    }
  } catch (e) {
    return fail(e, err);
  } finally {
    ws.close();
  }
}

/** "--scope category:operations" etc. Validated again by the assessor. */
function parseScopeOption(scope: string | undefined, notApplicable: string[] | undefined): unknown {
  const [kind, target] = (scope ?? 'full').split(':', 2);
  return { kind, target: target ?? null, notApplicable: notApplicable ?? [] };
}

function describeAssessment(a: Assessment, out: Out): void {
  out(`${a.id}  assessment ${a.status}${a.commit ? ` of ${a.commit.slice(0, 12)}` : ''}: ${scopeLabel(a.scope)}`);
  if (a.error) out(`  Failed: ${a.error}`);
  const r = a.report;
  if (!r) return;
  out(`  Repository unchanged: ${r.unchanged ? 'yes' : 'NO'}. ${r.unchangedEvidence}`);
  for (const o of r.observations) out(`  FINDING  ${o.impact.padEnd(6)} ${o.title}`);
  for (const f of r.capabilities) out(`  ${STATUS_LABEL[f.status].padEnd(20)} ${f.title.padEnd(16)} confidence ${f.confidence}${f.externalState ? ', outside the code not verified' : ''}`);
  for (const x of r.notInspected) out(`  not inspected: ${x}`);
  if (a.reportPath) out(`  Report: ${a.reportPath}`);
}

function cliCleanup(ws: Workspace): Cleanup {
  // The same folders as the last scan, so the rescan after a change can be compared with it.
  return new Cleanup(ws, ws.latestToolScan()?.roots ?? defaultScanRoots(), claudeRunner(process.env.IAP_CLAUDE_COMMAND ? JSON.parse(process.env.IAP_CLAUDE_COMMAND) as string[] : undefined));
}

function cliUpdates(ws: Workspace): UpdateMonitor {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return new UpdateMonitor(ws, {
    fetcher: process.env.IAP_UPDATE_FIXTURE ? fixtureFetcher(process.env.IAP_UPDATE_FIXTURE) : httpFetcher(),
    bundled: bundledVersions(),
    claudeVersion: claudeVersionReader(claudeRunner(process.env.IAP_CLAUDE_COMMAND ? (JSON.parse(process.env.IAP_CLAUDE_COMMAND) as string[]) : undefined), homedir()),
    listModels: apiKey
      ? async () => (await new Anthropic({ apiKey, maxRetries: 1 }).models.list({ limit: 100 })).data.map((m) => ({ id: m.id, createdAt: m.created_at ?? null, name: m.display_name ?? null }))
      : null,
    currentModel: CLAUDE_MODEL,
    rescan: () => runToolScan(ws.latestToolScan()?.roots ?? defaultScanRoots()),
  });
}

/** Accepts UPD-n or the id. */
function updateId(ws: Workspace, ref: string): string {
  const n = /^UPD-(\d+)$/i.exec(ref);
  if (!n) return ref;
  const hit = ws.listUpdates({}).find((i) => i.number === Number(n[1]));
  if (!hit) throw new ValidationError(`No update ${ref}.`);
  return hit.id;
}

function describeCheck(c: UpdateCheck, ws: Workspace, out: Out): void {
  out(`Update check ${c.at}`);
  for (const s of c.sources) out(`  ${s.status.padEnd(12)} ${s.name}: ${s.detail}`);
  for (const n of c.notChecked) out(`  not checked: ${n}`);
  out(`  ${c.created.length} new, ${c.updated.length} seen again, ${c.installed.length} now installed`);
  for (const id of c.created) {
    const i = ws.getUpdate(id);
    out(`  UPD-${i.number}  ${i.priority.padEnd(11)} ${i.title}`);
  }
}

function describeUpdate(i: UpdateItem, out: Out): void {
  out(`UPD-${i.number}  ${i.stage}  ${i.title}`);
  out(`  ${i.priority}, ${i.confidence} confidence. Installed ${i.installedVersion ?? 'unknown'}${i.observedVersion ? `, found ${i.observedVersion}` : ''}`);
  out(`  source: ${i.source.name}${i.source.url ? ` (${i.source.url})` : ''}, detected ${i.detectedAt}, last seen ${i.lastSeenAt}`);
  for (const l of i.summary) out(`  - ${l}`);
  for (const w of i.impacts.workflows) out(`  workflow: ${w}`);
  for (const t of i.impacts.tests) out(`  test: ${t}`);
  out(`  recommendation: ${i.recommendation}`);
  for (const e of i.evaluation) out(`  evaluate: ${e}`);
  for (const s of i.installSteps) out(`  install: ${s}`);
  if (i.approval) out(`  approved by ${i.approval.by} at ${i.approval.at}${i.approval.note ? `: ${i.approval.note}` : ''}`);
  if (i.dismissal) out(`  dismissed by ${i.dismissal.by}: ${i.dismissal.reason}`);
  if (i.installed) out(`  installed: ${i.installed.evidence}`);
  if (i.verification) {
    out(`  verification ${i.verification.passed ? 'passed' : 'FAILED'} at ${i.verification.at}`);
    for (const e of i.verification.evidence) out(`    ${e}`);
  }
}

function describeCleanup(p: CleanupPlan, out: Out): void {
  const d = p.dryRun;
  out(`${p.id}  ${p.status}  ${p.action} ${p.entry.invocation ?? p.entry.name} (${p.entry.scope})`);
  if (d.command) out(`  runs: ${d.command.display}  (in ${d.command.cwd})`);
  if (d.move) out(`  moves: ${d.move.from} → ${d.move.to}`);
  for (const t of d.targets) out(`  changes: ${t}`);
  if (d.dependents.length) out(`  also affects: ${d.dependents.map((x) => x.label).join(', ')}`);
  for (const w of d.workflows) out(`  workflow: ${w}`);
  for (const e of d.effects) out(`  effect: ${e}`);
  for (const r of d.risks) out(`  risk: ${r}`);
  for (const r of d.recovery) out(`  undo: ${r}`);
  for (const m of d.manual) out(`  do it yourself: ${m}`);
  if (d.needsAcceptance && p.status === 'planned') out('  Other tools or workflows depend on this: add --accept to go ahead.');
  for (const [name, r] of [['result', p.result], ['restore', p.restore]] as const) {
    if (!r) continue;
    out(`  ${name}: ${r.verification}${r.exitCode !== null ? ` (exit ${r.exitCode})` : ''}`);
    if (r.output) out(`    ${r.output.split('\n').slice(-5).join('\n    ')}`);
    for (const n of r.nextSteps) out(`    next: ${n}`);
  }
}

function describeSelfAssessment(a: SelfAssessmentRecord, out: Out): void {
  out(`Self-assessment ${a.id} at ${a.at}`);
  out(`  Read: ${a.report.sources.map((s) => `${s.name} ${s.count}`).join(', ')}`);
  if (!a.report.findings.length) out('  Nothing went wrong in the records read.');
  for (const f of a.report.findings) {
    out(`  - ${f.observation.text}`);
    out(`    Likely cause (${f.inference.confidence} confidence): ${f.inference.text}`);
    out(`    Recommendation: ${f.recommendation.title}`);
  }
  out(`  Backlog: ${a.created.length} new, ${a.updated.length} with new evidence`);
  out('  Not recorded, so not assessed:');
  for (const g of a.report.gaps) out(`    ${g}`);
}

/** The CLI runs from the source tree, so the running version is the one in package.json. */
function maintenance(ws: Workspace): Maintenance {
  const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  return new Maintenance(ws, new Builder(ws, new SimulatedModel()), version);
}

function describeMaintenance(o: MaintenanceOverview, out: Out): void {
  if (!o.project) {
    out(`Platform maintenance is not set up. Run: iap platform setup <folder with the app's source code>   (running ${o.runningVersion})`);
    return;
  }
  out(`Platform maintenance: ${o.project.repoPath}   running ${o.runningVersion}   project ${o.project.id}`);
  out(`  mandatory checks: ${o.mandatoryChecks.map((c) => c.command).join('; ')}`);
  out(`  release adds: ${o.releaseChecks.filter((c) => !o.mandatoryChecks.includes(c)).map((c) => c.command).join('; ')}`);
  out(`  protected areas: ${o.protectedAreas.map((a) => a.title).join('; ')}`);
  for (const k of o.knownGood) out(`  known-good ${k.version}${k.commit ? ` (${k.commit.slice(0, 12)})` : ''} at ${k.at} by ${k.actor}: ${k.note}`);
  out(`  backups: ${o.backups.length ? o.backups.map((b) => b.file).join(', ') : 'none (take one before installing a new version: iap platform backup)'}`);
  for (const c of o.candidates) out(`  can build: ${c.ref} ${c.title}${c.blocked ? ` [${c.blocked}]` : ''}`);
  for (const b of o.builds) out(`  build ${b.id} ${b.status.padEnd(11)} ${b.title}`);
}

function describeImprovement({ item: i, allowed, recurrence, dependencies, mergedFrom, mergedInto, builds, releases, measurements, reopens, reopenedBy }: ImprovementDetail, out: Out): void {
  out(`IMP-${i.number}  ${i.title}`);
  out(`  status: ${i.status}${i.reason ? ` (${i.reason})` : ''}   priority: ${i.priority}   risk: ${i.risk}   from: ${i.source === 'feedback' ? 'feedback' : 'self-assessment'}`);
  out(`  problem: ${i.problem}`);
  out(`  expected outcome: ${i.expectedOutcome || '-'}`);
  out(`  success criteria: ${i.successCriteria || '-'}`);
  if (dependencies.length) out(`  depends on: ${dependencies.map((d) => `IMP-${d.number} (${d.status})`).join(', ')}`);
  if (i.approver) out(`  approved by ${i.approver} at ${i.approvedAt}`);
  if (i.result) out(`  result: ${i.result}`);
  if (i.measuredOutcome) out(`  measured outcome: ${i.measuredOutcome}`);
  out(`  recurrence: ${recurrence.sinceApproval === null ? recurrence.note : `${recurrence.sinceApproval} since approval (${recurrence.note})`}`);
  if (mergedInto) out(`  merged into IMP-${mergedInto.number}`);
  if (mergedFrom.length) out(`  merged from: ${mergedFrom.map((m) => `IMP-${m.number}`).join(', ')}`);
  for (const b of builds) out(`  platform work: ${b.id} ${b.status} ${b.title}`);
  for (const r of releases) out(`  in prepared release ${r.version} (${r.id})`);
  for (const m of measurements) out(`  measured ${m.at}: ${m.verdict.replace('_', ' ')} (${m.method === 'person' ? `by ${m.actor}` : 'from recurrence'}): ${m.detail}`);
  if (reopens) out(`  reopens IMP-${reopens.number} (${reopens.status})`);
  if (reopenedBy) out(`  reopened as IMP-${reopenedBy.number} (${reopenedBy.status})`);
  out('  evidence:');
  for (const e of i.evidence) {
    out(`    ${e.at}  ${e.summary}`);
    for (const o of e.occurrences.slice(0, 5)) out(`      ${o.id}  ${o.label}`);
    if (e.occurrences.length > 5) out(`      … and ${e.occurrences.length - 5} more`);
  }
  out(`  can move to: ${allowed.join(', ') || 'nothing (final)'}`);
}

function describeReference(r: DesignReference, out: Out): void {
  out(`${r.id}  ${r.kind} "${r.title}" (${r.status})`);
  out(`  file: ${r.fileName}, ${r.mediaType}, ${r.size} bytes${r.width ? `, ${r.width}×${r.height}` : ''}`);
  out(`  project: ${r.projectId ?? 'none'}   tags: ${r.tags.join(', ') || 'none'}`);
  if (r.notes) out(`  notes: ${r.notes}`);
  if (r.explanation) out(`  explanation: ${r.explanation}`);
  const s = r.suggestion;
  if (s) out(`  suggestion (${s.model}, ${s.status}): ${s.kind}; ${s.tags.join(', ') || 'no tags'}; ${s.explanation}`);
}

function need(value: string | undefined, label: string): string {
  if (!value) throw new ValidationError(`Missing <${label}>.`);
  return value;
}

function describeRun(r: WorkflowRun): string {
  const base = `${r.id}  ${r.workflow.padEnd(11)} ${r.state.padEnd(17)} ${r.title}`;
  return r.state === 'blocked'
    ? `${base}\n      BLOCKED (from ${r.blockedFrom}): ${r.blockerReason}\n      To resolve: ${r.blockerResolution}`
    : base;
}

/** Same rule as the app: real calls need a monthly budget and a key. The CLI reads the key from the environment. */
function agentModel(ws: Workspace): ModelAdapter {
  if (ws.monthlyBudgetUsd() === null) return new SimulatedModel();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new ValidationError('A monthly budget is set, so real calls are on, but ANTHROPIC_API_KEY is not set.');
  return new ClaudeModel(new Anthropic({ apiKey, maxRetries: 1 }));
}

function parseChecks(values: string[] | undefined) {
  return (values ?? []).map((c) => {
    const at = c.indexOf('=');
    if (at < 1) throw new ValidationError(`--check "${c}" must look like id=command, for example unit="npm test".`);
    return { id: c.slice(0, at).trim(), command: c.slice(at + 1).trim() };
  });
}

function describeRelease({ release: r, checkRuns, exceptions, blocking }: ReleaseDetail, out: Out): void {
  out(`${r.id}  release ${r.version} ${r.status}${r.commit ? ` on ${r.commit.slice(0, 12)}` : ''}`);
  for (const g of r.gates ?? []) {
    out(`  ${g.status.toUpperCase().padEnd(8)} ${g.required ? 'required' : 'optional'} ${g.id.padEnd(8)} ${g.summary}${g.exception ? ' [exception recorded]' : ''}`);
    for (const e of g.evidence.slice(0, 10)) out(`      ${e}`);
    for (const f of g.findings ?? []) out(`      ${f.requirementId} ${f.kind}: ${f.observed}${f.note ? ` (${f.note})` : ''}`);
  }
  for (const c of checkRuns.slice(-r.checks.length)) out(`  check ${c.checkId.padEnd(12)} ${c.status.padEnd(9)} exit ${c.exitCode ?? '-'}  ${c.command}`);
  for (const e of exceptions) out(`  exception ${e.gateId} by ${e.actor}: ${e.reason} / mitigation: ${e.mitigation}`);
  if (r.status === 'prepared') out('  Prepared. Nothing was deployed, tagged or pushed.');
  else if (r.gates) out(blocking.length ? `  Blocked by: ${blocking.join(', ')}` : '  Ready to prepare: iap release prepare ' + r.id);
  if (r.reportPath) out(`  report: ${r.reportPath}`);
}

function describeBuild({ build: b, checkRuns }: BuildDetail, out: Out): void {
  out(`${b.id}  ${b.kind} ${b.status}: ${b.title}`);
  if (b.source) out(`  platform work for ${b.source.ref}${b.protectedApproval ? `; protected changes approved by ${b.protectedApproval.by}: ${b.protectedApproval.files.join(', ')}` : ''}`);
  if (b.branch) out(`  branch ${b.branch} in ${b.worktree}`);
  if (b.uiAudit) for (const line of describeAudit(b.uiAudit)) out(`  audit: ${line}`);
  if (b.referenceIds.length) out(`  references: ${b.referenceIds.join(', ')}${b.motion ? '   motion: yes' : ''}`);
  for (const r of checkRuns) out(`  ${r.phase.padEnd(8)} ${r.checkId.padEnd(12)} ${r.status.padEnd(9)} exit ${r.exitCode ?? '-'}  ${r.command}`);
  if (b.agent) out(`  agent (${b.agent.model}): ${b.agent.status}, ${b.agent.steps.length} tool calls, files written: ${b.agent.filesWritten.join(', ') || 'none'}`);
  if (b.changedFiles) out(`  changed: ${b.changedFiles.map((f) => `${f.path} (+${f.added} -${f.removed})`).join(', ') || 'nothing'}`);
  if (b.risks) for (const r of b.risks) out(`  risk ${r.kind}: ${r.detail}`);
  if (b.risks && !b.risks.length) out('  No risks found by the review.');
  if (b.reportPath) out(`  report: ${b.reportPath}`);
}

function describeTask(t: AgentTask): string {
  const lines = [`${t.parentId ? '  ' : ''}${t.id}  ${t.kind.padEnd(9)} ${t.status.padEnd(17)} ${t.title}${t.strategy ? `  [${t.strategy}]` : ''}`];
  const pad = t.parentId ? '      ' : '    ';
  for (const r of t.rationale) lines.push(`${pad}why: ${r}`);
  if (t.failure) lines.push(`${pad}problem: ${t.failure}`);
  if (t.resolution) lines.push(`${pad}to resolve: ${t.resolution}`);
  if (t.output && !t.parentId) lines.push(...t.output.split('\n').map((l) => `${pad}${l}`));
  return lines.join('\n');
}

function describeScan(scan: ToolScan, out: Out): void {
  out(`Scan ${scan.id} at ${scan.scannedAt} (read-only)`);
  out(`  config: ${scan.roots.configDir}   projects scanned: ${scan.roots.projectDirs.length}`);
  out(`  found: ${Object.entries(scan.summary.entries).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing'}`);
  for (const e of scan.entries) {
    out(`  ${e.kind.padEnd(11)} ${e.scope.padEnd(8)} ${(e.invocation ?? e.name).padEnd(32)} ${e.version ?? '-'}  ${e.status}`);
  }
  out(`Findings (${scan.findings.length}):`);
  for (const f of scan.findings) {
    out(`  [${f.severity}] ${f.title}`);
    for (const ev of f.evidence) out(`      evidence: ${ev}`);
    if (f.inference) out(`      meaning:  ${f.inference}`);
    out(`      suggest:  ${f.recommendation}`);
  }
  for (const i of scan.issues) out(`  issue: ${i.path}: ${i.problem}`);
  out('Not checked:');
  for (const n of scan.notChecked) out(`  - ${n}`);
}

function fail(e: unknown, err: Out): number {
  if (e instanceof StateCorruptError || e instanceof StateTooNewError) {
    err(e.message);
    return 2;
  }
  if (e instanceof IapError) {
    err(`Error: ${e.message}`);
    return 1;
  }
  err(`Unexpected error: ${(e as Error)?.stack ?? String(e)}`);
  return 3;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (e) {
    // parseArgs rejects unknown flags by throwing
    console.error(`Error: ${(e as Error).message}\n\n${USAGE}`);
    process.exitCode = 1;
  }
}
