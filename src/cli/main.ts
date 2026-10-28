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
import type { AgentTask } from '../core/workspace.ts';
import { allowedTransitions, RUN_STATES, WORKFLOWS, type RunState } from '../core/workflow.ts';

const USAGE = `Usage: iap <command> [options]

Projects
  project create --name <name> [--idea <text>] [--confirmed <fact>]... [--assumption <fact>]...
  project list
  project show <projectId>

Workflow runs
  run start <projectId> --workflow <${WORKFLOWS.join('|')}> [--title <text>]
  run move <runId> <state> [--reason <text>] [--resolution <text>]
  run list [projectId]
  run show <runId>

Claude Code tools (read-only: nothing is changed or removed)
  tools scan [--include <projectDir>]...   Inventory plugins, skills, commands, agents, hooks and MCP servers, and report conflicts
  tools show                               Show the latest scan

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
  build new <projectId> --kind <feature|bugfix> --title <t> --goal <text> --check <id=command>...
            [--req <REQ-ID>]... [--component <path>]... [--repro <steps>]
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

Audit and health
  events [--project <id>] [--run <id>] [--limit <n>]
  doctor
  recover --confirm        If the database is corrupt, move it aside (kept, not deleted) and start fresh

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
      case 'project show': {
        const project = ws.getProject(need(rest[0], 'projectId'));
        const runs = ws.listRuns(project.id);
        print({ ...project, runs }, () => {
          out(`${project.name} (${project.id})`);
          out(`  status: ${project.status}   origin: ${project.origin}   created: ${project.createdAt}`);
          if (project.idea) out(`  idea: ${project.idea}`);
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
  if (b.branch) out(`  branch ${b.branch} in ${b.worktree}`);
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
