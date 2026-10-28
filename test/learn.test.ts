// M14 learning (PR 1): approved preferences with duplicate and conflict checks,
// session wrap-ups saved to the Vault only on request, one feedback path, and the
// memory-tool overlap the tool scan reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempHome } from './helpers.ts';
import { Workspace } from '../src/core/workspace.ts';
import { appPaths } from '../src/core/paths.ts';
import { SimulatedModel } from '../src/core/agents/model.ts';
import { Builder } from '../src/core/build/builder.ts';
import { detectConflicts } from '../src/core/conflicts.ts';
import type { Inventory, ToolEntry } from '../src/core/inventory.ts';
import { Preferences, proposeWording } from '../src/core/learn/preferences.ts';
import { renderSummary, Vault } from '../src/core/learn/vault.ts';
import { AppService } from '../src/main/service.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const { home, cleanup } = tempHome();
  let clock = Date.parse('2026-10-28T09:00:00.000Z');
  const tick = (ms = 60_000) => (clock += ms);
  const ws = Workspace.open(home, { actor: 'joshua', now: () => new Date(clock) });
  t.after(() => {
    try {
      ws.close();
    } catch {
      // already closed by the test
    }
    cleanup();
  });
  return { home, ws, tick, prefs: new Preferences(ws), vault: new Vault(ws), now: () => new Date(clock).toISOString() };
}

test('M14-AC1: feedback becomes a preference only after the proposed wording is approved', (t) => {
  const { ws, prefs } = setup(t);
  assert.equal(proposeWording('  please   from now on use British English in the UI text '), 'Use British English in the UI text.');
  assert.equal(proposeWording('I would like you to keep commits small'), 'Keep commits small.');

  const p = prefs.propose({ text: 'Please use British English in the UI text', source: { type: 'feedback', summary: 'Feedback typed by joshua', ref: null, quote: 'Please use British English in the UI text' } });
  assert.equal(p.status, 'proposed');
  assert.equal(p.text, 'Use British English in the UI text.');
  assert.equal(p.source.type, 'feedback');
  assert.equal(p.source.quote, 'Please use British English in the UI text');
  assert.deepEqual(prefs.forWork(null), [], 'a proposal is not used');

  const edited = prefs.edit(p.id, { text: 'Use British English in all UI text' });
  assert.equal(edited.text, 'Use British English in all UI text.');
  assert.equal(edited.proposedText, 'Use British English in the UI text.', 'the proposed wording is kept');
  const active = prefs.approve(p.id);
  assert.equal(active.status, 'active');
  assert.equal(active.approver, 'joshua');
  assert.deepEqual(prefs.forWork(null).map((x) => x.number), [1]);
  assert.ok(ws.listEvents().some((e) => e.type === 'preference.approved' && e.payload.edited === true));
  assert.throws(() => prefs.approve(p.id), /only a proposal can be approved/);
});

test('M14-AC2: duplicates and conflicts are surfaced, never combined silently', (t) => {
  const { prefs } = setup(t);
  const first = prefs.approve(prefs.propose({ text: 'Always write tests for new code' }).id);

  const dup = prefs.propose({ text: 'Write tests for all new code' });
  const d = prefs.detail(dup.id);
  assert.equal(d.matches.length, 1);
  assert.equal(d.matches[0]!.kind, 'duplicate');
  assert.throws(() => prefs.approve(dup.id), /Decide first: PREF-1 may duplicate this/);
  assert.equal(prefs.detail(dup.id).preference.status, 'proposed', 'nothing changed');
  assert.throws(() => prefs.approve(dup.id, [{ id: 'pref_other', action: 'keep_both' }]), /does not match/);
  const kept = prefs.approve(dup.id, [{ id: first.id, action: 'keep_both' }]);
  assert.equal(kept.status, 'active');
  assert.deepEqual(kept.resolutions, [{ id: first.id, kind: 'duplicate', action: 'keep_both' }]);
  assert.equal(prefs.detail(first.id).preference.status, 'active', 'both are kept');

  const against = prefs.propose({ text: 'Never write tests for new code' });
  const matches = prefs.detail(against.id).matches;
  assert.ok(matches.length >= 1 && matches.every((m) => m.kind === 'conflict'), JSON.stringify(matches));
  const replaced = prefs.approve(
    against.id,
    matches.map((m) => ({ id: m.id, action: 'replace' as const })),
  );
  assert.equal(replaced.status, 'active');
  for (const m of matches) {
    const old = prefs.detail(m.id).preference;
    assert.equal(old.status, 'removed');
    assert.equal(old.reason, `Replaced by PREF-${replaced.number}`);
  }

  // Unrelated wording does not match.
  assert.deepEqual(prefs.detail(prefs.propose({ text: 'Use the dark theme in screenshots' }).id).matches, []);
});

test('M14-AC3: preferences are scoped to everything or to one project', (t) => {
  const { ws, prefs } = setup(t);
  const a = ws.createProject({ name: 'Club HR' });
  const b = ws.createProject({ name: 'Rota' });
  assert.throws(() => prefs.propose({ text: 'Use metric units', scope: 'project' }), /Choose the project/);
  assert.throws(() => prefs.propose({ text: 'Use metric units', scope: 'global', projectId: a.id }), /not tied to a project/);
  assert.throws(() => prefs.propose({ text: 'Use metric units', scope: 'team' }), /global or project/);

  const forA = prefs.approve(prefs.propose({ text: 'Show money in pounds', projectId: a.id }).id);
  assert.equal(forA.scope, 'project');
  // The same words for a different project do not clash with A's.
  assert.deepEqual(prefs.detail(prefs.propose({ text: 'Show money in pounds', projectId: b.id }).id).matches, []);
  const global = prefs.approve(prefs.propose({ text: 'Keep replies short' }).id);
  assert.deepEqual(prefs.forWork(a.id).map((p) => p.id).sort(), [forA.id, global.id].sort());
  assert.deepEqual(prefs.forWork(b.id).map((p) => p.id), [global.id]);
  assert.deepEqual(prefs.list({ projectId: b.id }).map((p) => p.scope).sort(), ['global', 'project']);

  // Moving a project preference to global re-checks it against everything.
  const moved = prefs.edit(forA.id, { scope: 'global' });
  assert.equal(moved.projectId, null);
});

test('M14-AC4: an active preference can be edited and removed, and the history stays', (t) => {
  const { home, prefs, ws } = setup(t);
  const p = prefs.approve(prefs.propose({ text: 'Use tabs for indentation' }).id);
  const other = prefs.approve(prefs.propose({ text: 'Name branches after the ticket' }).id);
  // Editing an active preference into a clash needs the same decision as approving.
  assert.throws(() => prefs.edit(other.id, { text: 'Never use tabs for indentation' }), /Decide first: PREF-1 may contradict/);
  const changed = prefs.edit(p.id, { text: 'Use two spaces for indentation' });
  assert.equal(changed.status, 'active');
  assert.ok(ws.listEvents().some((e) => e.type === 'preference.edited' && e.payload.before === 'Use tabs for indentation.'));

  const removed = prefs.remove(p.id, 'Changed my mind');
  assert.equal(removed.status, 'removed');
  assert.equal(removed.reason, 'Changed my mind');
  assert.throws(() => prefs.edit(p.id, { text: 'x y z' }), /can no longer change/);
  assert.throws(() => prefs.remove(p.id, 'again'), /only an active preference/);
  assert.equal(prefs.list({}).length, 2, 'removed preferences stay in the list');
  assert.throws(() => prefs.reject(other.id, 'no'), /only a proposal can be rejected/);
  assert.equal(prefs.reject(prefs.propose({ text: 'Use emoji in commit messages' }).id, 'No thanks').status, 'rejected');

  const raw = new DatabaseSync(appPaths(home).db);
  assert.throws(() => raw.exec('DELETE FROM preferences'), /never deleted/);
  assert.throws(() => raw.exec(`UPDATE preferences SET status = 'active' WHERE id = '${p.id}'`), /cannot change/);
  assert.throws(() => raw.exec(`UPDATE preferences SET source = '{}' WHERE id = '${other.id}'`), /cannot change/);
  raw.close();
});

test('M14-AC5: approved preferences guide the build agent and say they never override its rules', async (t) => {
  const { home, ws, prefs } = setup(t);
  const project = ws.createProject({ name: 'Sum' });
  const repo = join(home, 'repo');
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'test', 'ok.mjs'), "console.log('ok');\n");
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: repo });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  prefs.approve(prefs.propose({ text: 'Keep functions under 40 lines' }).id);
  prefs.approve(prefs.propose({ text: 'Explain every new dependency', projectId: project.id }).id);
  const other = ws.createProject({ name: 'Other' });
  prefs.approve(prefs.propose({ text: 'Use Python', projectId: other.id }).id);
  prefs.propose({ text: 'Not yet approved' });

  let seen = '';
  const model = new SimulatedModel((r) => {
    if (r.purpose === 'build') seen = r.instructions;
    return { text: 'Looked only.' };
  });
  const builder = new Builder(ws, model, { checkTimeoutMs: 30_000 });
  await builder.setRepo(project.id, repo);
  const build = builder.create(project.id, { kind: 'bugfix', title: 't', goal: 'g', repro: 'r', checks: [{ id: 'unit', command: 'node test/ok.mjs' }] });
  await builder.start(build.id);
  await builder.runAgent(build.id);
  assert.match(seen, /never override the rules, the approved checks or an approval/);
  assert.match(seen, /PREF-1: Keep functions under 40 lines\./);
  assert.match(seen, /PREF-2: Explain every new dependency\./);
  assert.doesNotMatch(seen, /Use Python|Not yet approved/);
});

test('M14-AC6: the wrap-up separates confirmed decisions from assumptions and inferred next steps', (t) => {
  const { ws, tick, prefs, vault, now } = setup(t);
  const project = ws.createProject({ name: 'Club HR', facts: [{ kind: 'confirmed', text: 'Runs on Windows' }, { kind: 'assumption', text: 'About 40 members' }] });
  tick();
  const blocked = ws.startRun({ projectId: project.id, workflow: 'plan', title: 'Plan payroll' });
  ws.transitionRun(blocked.id, { to: 'planned' });
  ws.transitionRun(blocked.id, { to: 'blocked', reason: 'Waiting on the treasurer', resolution: 'Ask for the pay rates' });
  const open = ws.startRun({ projectId: project.id, workflow: 'plan', title: 'Plan rota' });
  ws.transitionRun(open.id, { to: 'planned' });
  ws.transitionRun(open.id, { to: 'approved' });
  prefs.approve(prefs.propose({ text: 'Keep the rota printable' }).id);
  prefs.propose({ text: 'Use the club colours' });
  tick();

  const s = vault.wrapUp();
  assert.ok(s.decisions.every((d) => d.basis === 'confirmed'));
  assert.ok(s.decisions.some((d) => /Approved the preference PREF-1 "Keep the rota printable\."/.test(d.text)), JSON.stringify(s.decisions));
  assert.ok(s.decisions.some((d) => /Moved "Plan rota" in Club HR from planned to approved/.test(d.text)));
  assert.ok(s.progress.some((d) => /Started the run "Plan payroll"/.test(d.text)));
  assert.ok(s.blockers.some((b) => /"Plan payroll" in Club HR is blocked: Waiting on the treasurer\. To resolve: Ask for the pay rates\./.test(b.text)));
  assert.ok(s.nextSteps.length >= 2 && s.nextSteps.every((n) => n.basis === 'inferred'));
  assert.ok(s.nextSteps.some((n) => /Move "Plan rota" in Club HR on from approved/.test(n.text)));
  assert.ok(s.nextSteps.some((n) => /PREF-2/.test(n.text)));
  assert.deepEqual(s.assumptions.map((a) => [a.text, a.basis]), [['Club HR: About 40 members', 'assumption']]);
  assert.ok(!JSON.stringify(s).includes('Runs on Windows'), 'confirmed facts are not listed as assumptions');
  const md = renderSummary(s);
  assert.match(md, /## Decisions \(confirmed\)/);
  assert.match(md, /## Assumptions \(not confirmed\)/);
  assert.match(md, /_\(inferred\)_/);

  // Nothing is stored until the person saves it.
  assert.equal(vault.list({}).length, 0);
  const note = vault.saveWrapUp({ from: s.from, to: s.to });
  assert.equal(note.status, 'inbox');
  assert.equal(note.kind, 'session');
  assert.deepEqual(note.summary!.decisions, s.decisions);
  assert.equal(prefs.list({ status: 'active' }).length, 1, 'saving a summary adds no preference');
  assert.throws(() => vault.saveWrapUp({ from: s.from, to: '2099-01-01T00:00:00.000Z' }), /cannot end in the future/);

  // A line becomes a preference only through a proposal.
  const line = s.decisions[0]!.text;
  const fromLine = vault.proposePreference(note.id, line);
  assert.equal(fromLine.status, 'proposed');
  assert.deepEqual([fromLine.source.type, fromLine.source.ref], ['wrap_up', note.id]);
  assert.throws(() => vault.proposePreference(note.id, 'Always deploy on Fridays'), /not in NOTE-1/);

  // The next wrap-up starts where the saved one ended.
  tick();
  assert.equal(vault.wrapUp().from, s.to);
  assert.equal(vault.wrapUp({ hours: 2 }).to, now());
  assert.throws(() => vault.wrapUp({ hours: 0 }), /Hours must be/);
});

test('M14-AC7: the Vault keeps notes; saved summaries cannot be rewritten', (t) => {
  const { home, vault } = setup(t);
  const s = vault.wrapUp();
  const session = vault.saveWrapUp({ from: s.from, to: s.to, title: 'Monday' });
  assert.throws(() => vault.edit(session.id, { body: 'nothing happened' }), /cannot be edited/);
  const note = vault.addNote({ title: 'Reading list', body: '- Refactoring UI' });
  assert.equal(vault.edit(note.id, { body: '- Refactoring UI\n- Design systems' }).body, '- Refactoring UI\n- Design systems');
  assert.equal(vault.file(note.id, 'kept').status, 'kept');
  assert.equal(vault.file('NOTE-1', 'archived').status, 'archived');
  assert.throws(() => vault.file(note.id, 'inbox'), /kept or archived/);
  assert.deepEqual(vault.list({ status: 'archived' }).map((n) => n.title), ['Monday']);
  assert.equal(vault.list({ kind: 'note' }).length, 1);

  const raw = new DatabaseSync(appPaths(home).db);
  assert.throws(() => raw.exec('DELETE FROM vault_notes'), /never deleted/);
  assert.throws(() => raw.exec(`UPDATE vault_notes SET body = 'x' WHERE id = '${session.id}'`), /cannot change/);
  raw.close();
});

function tool(kind: ToolEntry['kind'], name: string, extra: Partial<ToolEntry> = {}): ToolEntry {
  return {
    id: `${kind}:${name}`,
    kind,
    name,
    invocation: kind === 'plugin' ? null : `/${name}`,
    scope: 'user',
    scopeDetail: null,
    source: `/home/joshua/.claude/${kind}s/${name}`,
    version: null,
    status: 'enabled',
    provenance: 'user',
    owner: null,
    appManaged: false,
    description: null,
    details: {},
    removal: { method: 'manual', instructions: '' },
    ...extra,
  };
}

const inventory = (entries: ToolEntry[]): Inventory => ({ roots: { configDir: '', userConfigFile: '', managedDirs: [], projectDirs: [] }, entries, issues: [], references: { enabledPlugins: [] } });

test('M14-AC8: the tool scan reports memory and feedback tools that overlap (C6)', () => {
  assert.equal(detectConflicts(inventory([tool('skill', 'review')])).filter((f) => f.category === 'overlapping_memory').length, 0);
  const one = detectConflicts(inventory([tool('skill', 'wrap-up')])).filter((f) => f.category === 'overlapping_memory');
  assert.equal(one.length, 1);
  assert.equal(one[0]!.severity, 'informational');
  const many = detectConflicts(inventory([tool('skill', 'feedback'), tool('plugin', 'remember@claude-plugins'), tool('command', 'reflect-mod'), tool('skill', 'wrap-up', { status: 'disabled' })])).filter((f) => f.category === 'overlapping_memory');
  assert.equal(many.length, 1);
  assert.equal(many[0]!.severity, 'potential');
  assert.match(many[0]!.title, /3 tools save feedback or memory: feedback, reflect-mod, remember/);
  assert.equal(many[0]!.entryIds.length, 3, 'a disabled tool does not count');
  assert.match(many[0]!.recommendation, /nothing is changed without your approval/);
});

test('M14: the service routes feedback about the work to a proposed preference', async (t) => {
  const { home, cleanup } = tempHome();
  const service = new AppService(home, '0.16.0');
  t.after(() => {
    service.close();
    cleanup();
  });
  const h = service.handlers;
  const proposed = (await h.proposePreference({ text: 'please keep the UI in British English', fromFeedback: true })) as { ok: true; value: { preference: { status: string; source: { type: string; quote: string } } } };
  assert.ok(proposed.ok);
  assert.equal(proposed.value.preference.status, 'proposed');
  assert.deepEqual([proposed.value.preference.source.type, proposed.value.preference.source.quote], ['feedback', 'please keep the UI in British English']);
  const list = (await h.listPreferences()) as { ok: true; value: { id: string }[] };
  const id = list.value[0]!.id;
  assert.ok(((await h.approvePreference({ id })) as { ok: boolean }).ok);
  const dup = (await h.proposePreference({ text: 'Keep the UI in British English' })) as { ok: true; value: { preference: { id: string }; matches: { id: string; kind: string }[] } };
  assert.deepEqual(dup.value.matches.map((m) => m.kind), ['duplicate']);
  const refused = (await h.approvePreference({ id: dup.value.preference.id })) as { ok: false; error: { code: string; message: string } };
  assert.equal(refused.ok, false);
  assert.match(refused.error.message, /Decide first/);
  const wrap = (await h.wrapUp({ hours: 1 })) as { ok: true; value: { from: string; to: string } };
  assert.ok(wrap.ok);
  const saved = (await h.saveWrapUp({ from: wrap.value.from, to: wrap.value.to })) as { ok: true; value: { status: string } };
  assert.equal(saved.value.status, 'inbox');
  assert.equal(((await h.removePreference({ id: 42 })) as { ok: boolean }).ok, false);
});
