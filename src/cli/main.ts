#!/usr/bin/env node
// `iap` — command-line surface for the workspace core. The Electron shell will
// call the same core API; the CLI is the first usable interface and the
// end-to-end test harness for milestone M1.

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAppHome } from '../core/paths.ts';
import { IapError, StateCorruptError, StateTooNewError, ValidationError } from '../core/errors.ts';
import { moveCorruptStateAside, Workspace, type Fact, type WorkflowRun } from '../core/workspace.ts';
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

Audit and health
  events [--project <id>] [--run <id>] [--limit <n>]
  doctor
  recover --confirm        If the database is corrupt, move it aside (kept, not deleted) and start fresh

Global options
  --json                   Machine-readable output
  Data directory: $IAP_HOME, or the OS default (see docs/OPERATIONS.md)

Run states: ${RUN_STATES.join(', ')}`;

type Out = (line: string) => void;

export function run(argv: string[], out: Out = console.log, err: Out = console.error): number {
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
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, sub, ...rest] = positionals;
  const home = resolveAppHome();
  const print = (data: unknown, human: () => void) => (values.json ? out(JSON.stringify(data, null, 2)) : human());

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
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    // parseArgs rejects unknown flags by throwing
    console.error(`Error: ${(e as Error).message}\n\n${USAGE}`);
    process.exitCode = 1;
  }
}
