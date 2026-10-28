// M11 safe tool cleanup: options least disruptive first, a dry run that names
// exact targets, Claude Code's own commands (a stand-in here), moves into the
// app's backup folder, verification by scanning again, and honest results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tempHome } from './helpers.ts';
import { buildClaudeFixture } from './claude-fixture.ts';
import { Workspace } from '../src/core/workspace.ts';
import { appPaths } from '../src/core/paths.ts';
import { runToolScan } from '../src/core/tools.ts';
import { Cleanup, claudeRunner, remediationOptions } from '../src/core/cleanup/cleanup.ts';
import { AppService } from '../src/main/service.ts';

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));

function setup(t: { after: (fn: () => void) => void }) {
  const { home, cleanup } = tempHome();
  const roots = buildClaudeFixture(join(home, 'fixture'));
  const log = join(home, 'claude-calls.jsonl');
  writeFileSync(log, '');
  Object.assign(process.env, { FAKE_CLAUDE_CONFIG: roots.configDir, FAKE_CLAUDE_USER_FILE: roots.userConfigFile, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MODE: '' });
  const ws = Workspace.open(home, { actor: 'joshua' });
  t.after(() => {
    ws.close();
    cleanup();
  });
  const scan = ws.saveToolScan(runToolScan(roots));
  const cleanupApi = new Cleanup(ws, roots, claudeRunner([process.execPath, FAKE]));
  const calls = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { args: string[]; cwd: string });
  const find = (pred: (e: (typeof scan.entries)[number]) => boolean) => ws.latestToolScan()!.entries.find(pred)!;
  return { home, ws, roots, scan, cleanup: cleanupApi, calls, find };
}

test('M11: options run from least to most disruptive, and unsafe ones say why they are not offered', (t) => {
  const { scan, roots, find } = setup(t);
  const plugin = find((e) => e.kind === 'plugin' && e.name === 'review-kit@acme' && e.scope === 'user');
  const opts = remediationOptions(plugin, scan, roots, null);
  assert.deepEqual(opts.map((o) => o.action), ['keep', 'configure', 'disable', 'replace', 'uninstall']);
  assert.ok(opts.find((o) => o.action === 'disable')!.available);
  assert.equal(opts.find((o) => o.action === 'replace')!.why, 'No other tool in this finding.');

  const pluginSkill = find((e) => e.kind === 'skill' && e.owner === 'review-kit@acme');
  assert.match(remediationOptions(pluginSkill, scan, roots, null).find((o) => o.action === 'disable')!.why!, /Disable the plugin instead/);
  const managedHook = find((e) => e.kind === 'hook' && e.scope === 'managed');
  assert.ok(remediationOptions(managedHook, scan, roots, null).every((o) => o.action === 'keep' || o.action === 'configure' || !o.available));
  const marketplace = find((e) => e.kind === 'marketplace');
  assert.match(remediationOptions(marketplace, scan, roots, null).find((o) => o.action === 'uninstall')!.why!, /too broad/);
  const userSkill = find((e) => e.kind === 'skill' && e.scope === 'user' && e.name === 'deploy');
  const skillOpts = remediationOptions(userSkill, scan, roots, null);
  assert.equal(skillOpts.find((o) => o.action === 'disable')!.mechanism, 'move-aside');
  assert.equal(skillOpts.find((o) => o.action === 'uninstall')!.available, false);
});

test('M11: a dry run names exact targets, dependents, risks and recovery, and changes nothing', (t) => {
  const { ws, cleanup, calls, find, roots } = setup(t);
  const settingsBefore = readFileSync(join(roots.configDir, 'settings.json'), 'utf8');
  const plugin = find((e) => e.kind === 'plugin' && e.name === 'review-kit@acme' && e.scope === 'user');
  const plan = cleanup.plan(plugin.id, 'uninstall', null);
  assert.equal(plan.status, 'planned');
  assert.equal(plan.dryRun.command!.display, 'claude plugin uninstall review-kit@acme --scope user');
  assert.ok(plan.dryRun.dependents.length >= 3, 'its skills, commands and servers are listed');
  assert.ok(plan.dryRun.needsAcceptance);
  assert.ok(plan.dryRun.risks.some((r) => /saved options, secrets and data/.test(r)));
  assert.ok(plan.dryRun.recovery.some((r) => /claude plugin install review-kit@acme --scope user/.test(r)));
  assert.equal(calls().length, 0);
  assert.equal(readFileSync(join(roots.configDir, 'settings.json'), 'utf8'), settingsBefore);
  assert.ok(ws.listEvents({ limit: 20 }).some((e) => e.type === 'cleanup.planned'));
});

test('M11: disabling a plugin runs Claude Code’s own command and is verified from the settings', async (t) => {
  const { ws, cleanup, calls, find, roots } = setup(t);
  const plugin = find((e) => e.kind === 'plugin' && e.name === 'review-kit@acme' && e.scope === 'user');
  const plan = cleanup.plan(plugin.id, 'disable', null);
  await assert.rejects(cleanup.execute(plan.id, {}), /Accept that they are affected/);
  const done = await cleanup.execute(plan.id, { acceptDependencies: true, reason: 'Two review commands collide' });
  assert.equal(done.status, 'done', done.result?.verification);
  assert.deepEqual(calls()[0]!.args, ['plugin', 'disable', 'review-kit@acme', '--scope', 'user']);
  assert.equal(JSON.parse(readFileSync(join(roots.configDir, 'settings.json'), 'utf8')).enabledPlugins['review-kit@acme'], false);
  assert.equal(done.approval!.by, 'joshua');
  assert.equal(done.approval!.reason, 'Two review commands collide');
  assert.ok(done.result!.scanId);
  const event = ws.listEvents({ limit: 30 }).find((e) => e.type === 'cleanup.done')!;
  assert.equal(event.payload.command, 'claude plugin disable review-kit@acme --scope user');
  assert.deepEqual(event.payload.recovery, ['claude plugin enable review-kit@acme --scope user (Restore runs this for you)']);

  const back = await cleanup.restore(plan.id);
  assert.equal(back.status, 'restored');
  assert.deepEqual(calls()[1]!.args, ['plugin', 'enable', 'review-kit@acme', '--scope', 'user']);
  await assert.rejects(cleanup.restore(plan.id), /Only a change that was made/);
});

test('M11: a failed or unverified command is recorded as failed or partial, never done', async (t) => {
  const { cleanup, find } = setup(t);
  const plugin = find((e) => e.kind === 'plugin' && e.name === 'review-kit@acme' && e.scope === 'user');
  process.env.FAKE_CLAUDE_MODE = 'fail';
  const failed = await cleanup.execute(cleanup.plan(plugin.id, 'disable', null).id, { acceptDependencies: true });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.result!.exitCode, 1);
  assert.match(failed.result!.output, /depends on it/);
  assert.ok(failed.result!.nextSteps.some((s) => /Scan again/.test(s)));

  process.env.FAKE_CLAUDE_MODE = 'noop';
  const partial = await cleanup.execute(cleanup.plan(plugin.id, 'disable', null).id, { acceptDependencies: true });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.result!.verified, false);
  assert.match(partial.result!.verification, /do not show review-kit@acme as disabled/);
});

test('M11: uninstall and MCP removal use the native commands; the MCP backup keeps no secrets', async (t) => {
  const { cleanup, calls, find, roots } = setup(t);
  const plugin = find((e) => e.kind === 'plugin' && e.name === 'review-kit@other');
  const un = await cleanup.execute(cleanup.plan(plugin.id, 'uninstall', null).id, { acceptDependencies: true });
  assert.equal(un.status, 'done', un.result?.verification);
  assert.equal(JSON.parse(readFileSync(join(roots.configDir, 'plugins', 'installed_plugins.json'), 'utf8')).plugins['review-kit@other'], undefined);
  assert.equal((await cleanup.restore(un.id)).status, 'restored');

  const server = find((e) => e.kind === 'mcp_server' && e.name === 'github' && e.scope === 'user');
  const plan = cleanup.plan(server.id, 'uninstall', null);
  assert.ok(plan.dryRun.risks.some((r) => /OAuth tokens/.test(r)));
  const removed = await cleanup.execute(plan.id, {});
  assert.equal(removed.status, 'done', removed.result?.verification);
  assert.deepEqual(calls().at(-1)!.args, ['mcp', 'remove', 'github', '--scope', 'user']);
  const backup = readFileSync(plan.dryRun.backupPath!, 'utf8');
  assert.match(backup, /"type": "http"/);
  assert.doesNotMatch(backup, /qs-canary-123/);
  await assert.rejects(cleanup.restore(removed.id), /cannot restore this automatically.*add-json/);
});

test('M11: a personal skill is moved aside exactly, verified, and restored', async (t) => {
  const { cleanup, calls, find, roots, home } = setup(t);
  const skill = find((e) => e.kind === 'skill' && e.scope === 'user' && e.name === 'deploy');
  const plan = cleanup.plan(skill.id, 'disable', null);
  assert.equal(plan.dryRun.move!.from, join(roots.configDir, 'skills', 'deploy'));
  assert.ok(plan.dryRun.move!.to.startsWith(appPaths(home).cleanup));
  const done = await cleanup.execute(plan.id, {});
  assert.equal(done.status, 'done', done.result?.verification);
  assert.equal(existsSync(join(roots.configDir, 'skills', 'deploy')), false);
  assert.ok(existsSync(join(plan.dryRun.move!.to, 'SKILL.md')));
  assert.ok(existsSync(join(roots.configDir, 'skills', 'review', 'SKILL.md')), 'the neighbouring skill is untouched');
  assert.equal(calls().length, 0, 'no command runs for a move');
  const back = await cleanup.restore(plan.id);
  assert.equal(back.status, 'restored');
  assert.ok(existsSync(join(roots.configDir, 'skills', 'deploy', 'SKILL.md')));
});

test('M11: a tool that changed after planning is not touched', async (t) => {
  const { cleanup, find, roots } = setup(t);
  const command = find((e) => e.kind === 'command' && e.scope === 'user' && e.name === 'review');
  const plan = cleanup.plan(command.id, 'disable', null);
  writeFileSync(join(roots.configDir, 'commands', 'review.md'), '---\ndescription: Edited since\n---\n');
  const stale = await cleanup.execute(plan.id, {});
  assert.equal(stale.status, 'stale');
  assert.ok(existsSync(join(roots.configDir, 'commands', 'review.md')));
});

test('M11: keep records a decision; manual plans give steps; plans are never deleted or rewritten', async (t) => {
  const { home, ws, cleanup, find, calls } = setup(t);
  const hook = find((e) => e.kind === 'hook' && e.scope === 'managed');
  const manual = cleanup.plan(hook.id, 'uninstall', null);
  assert.equal(manual.status, 'manual');
  assert.ok(manual.dryRun.manual.some((m) => /organisation/.test(m)));
  await assert.rejects(cleanup.execute(manual.id, {}), /manual/);
  const kept = await cleanup.execute(cleanup.plan(hook.id, 'keep', null).id, { reason: 'Required by IT' });
  assert.equal(kept.status, 'recorded');
  assert.equal(calls().length, 0);
  assert.equal(ws.listCleanupPlans().length, 2);
  const raw = new DatabaseSync(appPaths(home).db);
  try {
    assert.throws(() => raw.exec('DELETE FROM cleanup_plans'), /never deleted/);
    assert.throws(() => raw.exec(`UPDATE cleanup_plans SET status = 'planned' WHERE id = '${kept.id}'`), /cannot change/);
  } finally {
    raw.close();
  }
});

test('M11: the service asks the person before running anything, and refuses without approval', async (t) => {
  const { home, cleanup: rm } = tempHome();
  const roots = buildClaudeFixture(join(home, 'fixture'));
  const log = join(home, 'calls.jsonl');
  writeFileSync(log, '');
  Object.assign(process.env, { FAKE_CLAUDE_CONFIG: roots.configDir, FAKE_CLAUDE_USER_FILE: roots.userConfigFile, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MODE: '' });
  const asked: string[][] = [];
  let answer = false;
  const service = new AppService(home, '0.0.0-test', {
    scanRoots: () => roots,
    claudeCommand: [process.execPath, FAKE],
    confirmCleanup: async (r) => {
      asked.push(r.lines);
      return answer;
    },
  });
  t.after(() => {
    service.close();
    rm();
  });
  const h = service.handlers;
  const scan = h.scanTools();
  assert.ok(scan.ok);
  const plugin = scan.ok ? scan.value.entries.find((e) => e.kind === 'plugin' && e.name === 'review-kit@acme' && e.scope === 'user')! : null!;
  assert.equal(h.planCleanup({ entryId: plugin.id, action: 'nonsense' }).ok, false);
  const plan = h.planCleanup({ entryId: plugin.id, action: 'disable' });
  assert.ok(plan.ok);
  const id = plan.ok ? plan.value.id : '';
  const refused = await h.runCleanup({ planId: id, acceptDependencies: true });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.error.message, /not approved/i);
  assert.match(asked[0]!.join('\n'), /claude plugin disable review-kit@acme --scope user/);
  assert.equal(readFileSync(log, 'utf8'), '');
  answer = true;
  const ran = await h.runCleanup({ planId: id, acceptDependencies: true });
  assert.ok(ran.ok && ran.value.status === 'done');
  const list = h.listCleanups();
  assert.ok(list.ok && list.value.length === 1);
});

test('M11: the CLI plans with no change and runs only with --confirm', (t) => {
  const { home, cleanup: rm } = tempHome();
  t.after(rm);
  const roots = buildClaudeFixture(join(home, 'fixture'));
  const CLI = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
  const iap = (...args: string[]) => {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: roots.configDir, IAP_HOME: join(home, 'app') },
      encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const scan = JSON.parse(iap('tools', 'scan', '--json').out) as { entries: { id: string; kind: string; scope: string; name: string }[] };
  const skill = scan.entries.find((e) => e.kind === 'skill' && e.scope === 'user' && e.name === 'deploy')!;
  const options = iap('tools', 'options', skill.id);
  assert.match(options.out, /✓ disable +Move it aside/);
  const plan = JSON.parse(iap('tools', 'plan', skill.id, '--action', 'disable', '--json').out) as { id: string };
  const unconfirmed = iap('tools', 'run', plan.id);
  assert.equal(unconfirmed.code, 1);
  assert.match(unconfirmed.err, /--confirm/);
  assert.ok(existsSync(join(roots.configDir, 'skills', 'deploy', 'SKILL.md')));
  const ran = iap('tools', 'run', plan.id, '--confirm');
  assert.equal(ran.code, 0, ran.err + ran.out);
  assert.match(ran.out, /no longer in the scan/);
  assert.ok(!existsSync(join(roots.configDir, 'skills', 'deploy')));
  assert.match(iap('tools', 'cleanups').out, /done +disable +\/deploy/);
  assert.equal(iap('tools', 'restore', plan.id, '--confirm').code, 0);
  assert.ok(existsSync(join(roots.configDir, 'skills', 'deploy', 'SKILL.md')));
});
