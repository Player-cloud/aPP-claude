// M4: read-only tool inventory and conflict detection (FR-TOOL-001/002).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './helpers.ts';
import { buildClaudeFixture, CANARIES } from './claude-fixture.ts';
import { defaultScanRoots, parseFrontmatter, scanInventory } from '../src/core/inventory.ts';
import { runToolScan } from '../src/core/tools.ts';
import { Workspace } from '../src/core/workspace.ts';
import { AppService } from '../src/main/service.ts';

function treeHash(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      h.update(`${p}|${st.mtimeMs}|${st.size}\n`);
      if (st.isDirectory()) walk(p);
      else h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

test('M4-AC1: inventories plugins, skills, commands, agents, hooks and MCP servers with scope and provenance', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const roots = buildClaudeFixture(home);
  const inv = scanInventory(roots);
  const find = (kind: string, name: string, scope?: string) =>
    inv.entries.filter((e) => e.kind === kind && e.name === name && (!scope || e.scope === scope));

  assert.equal(find('skill', 'deploy', 'user').length, 1);
  assert.equal(find('skill', 'deploy', 'project').length, 1);
  assert.equal(find('command', 'commit')[0]!.details.folder, 'git');
  assert.equal(find('agent', 'planner')[0]!.details.tools, 'Read, Grep');

  const pluginReview = find('command', 'review', 'plugin')[0]!;
  assert.equal(pluginReview.invocation, '/review-kit:review');
  assert.equal(pluginReview.owner, 'review-kit@acme');
  assert.equal(pluginReview.removal.method, 'via-plugin');

  const kit = find('plugin', 'review-kit@acme');
  assert.deepEqual(kit.map((p) => [p.scope, p.version, p.status]).sort(), [['project', '1.0.0', 'enabled'], ['user', '1.2.0', 'enabled']]);
  assert.equal(find('plugin', 'review-kit@other')[0]!.status, 'unknown', 'not mentioned in settings → unknown, not guessed');
  assert.equal(find('plugin', 'broken@acme')[0]!.status, 'disabled');
  assert.equal(find('marketplace', 'acme')[0]!.details.location, 'acme/plugins');

  // MCP servers from every scope, with approval state for project servers.
  assert.equal(find('mcp_server', 'db', 'local')[0]!.scopeDetail, roots.project);
  assert.equal(find('mcp_server', 'docs', 'project')[0]!.status, 'enabled');
  assert.equal(find('mcp_server', 'other', 'project')[0]!.status, 'unknown');
  assert.equal(find('mcp_server', 'github', 'plugin')[0]!.details['env vars (values hidden)'], 'GITHUB_TOKEN');

  // Hooks from user settings, a plugin, and organisation policy.
  assert.equal(inv.entries.filter((e) => e.kind === 'hook').length, 4);
  const managedHook = inv.entries.find((e) => e.kind === 'hook' && e.scope === 'managed')!;
  assert.equal(managedHook.provenance, 'organisation');
  assert.equal(managedHook.removal.method, 'not-removable');

  // Nothing is claimed as managed by the app, and unknowns stay unknown.
  assert.ok(inv.entries.every((e) => e.appManaged === false));
  assert.equal(find('agent', 'planner')[0]!.version, null);
  // The project folder recorded in ~/.claude.json was scanned; the deleted one was skipped.
  assert.deepEqual(inv.roots.projectDirs, [roots.project]);
});

test('M4-AC2: never exposes credentials from configuration', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const out = JSON.stringify(runToolScan(buildClaudeFixture(home)));
  for (const canary of CANARIES) assert.ok(!out.includes(canary), `leaked ${canary}`);
  assert.match(out, /api\.example\.com\/mcp \(credentials\/query hidden\)/);
  assert.match(out, /PGPASSWORD/, 'env var names are kept so the user can see what a server needs');
});

test('M4-AC3: the scan is read-only', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const roots = buildClaudeFixture(home);
  const before = treeHash(home);
  runToolScan(roots);
  assert.equal(treeHash(home), before);
});

test('M4-AC4: detects and classifies conflicts with evidence, without treating every overlap as an error', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const scan = runToolScan(buildClaudeFixture(home));
  const by = (category: string) => scan.findings.filter((f) => f.category === category);
  const severities = (category: string) => by(category).map((f) => f.severity);

  assert.deepEqual(by('duplicate_invocation').map((f) => f.title).sort(), ['2 tools answer /deploy', '2 tools answer /review']);
  assert.deepEqual(severities('duplicate_invocation'), ['potential', 'potential']);
  assert.deepEqual(severities('similar_name'), ['informational'], 'a namespaced plugin command does not collide');
  assert.deepEqual(severities('duplicate_mcp_name'), ['potential'], 'github: different settings in user and plugin scope');
  assert.deepEqual(severities('duplicate_mcp_server'), ['potential'], 'gh2 and the plugin github server run the same command');
  assert.deepEqual(severities('duplicate_hook'), ['potential']);
  assert.deepEqual(severities('plugin_not_installed'), ['confirmed']);
  assert.equal(by('plugin_not_installed')[0]!.title, 'Plugin ghost@acme is enabled but not installed');
  assert.equal(by('plugin_files_missing').length, 2, 'broken@acme and the missing 1.0.0 copy');
  assert.deepEqual(severities('plugin_version_mismatch'), ['potential']);
  assert.deepEqual(severities('plugin_name_clash'), ['potential']);
  assert.deepEqual(severities('invalid_config'), ['confirmed']);
  assert.equal(scan.findings.filter((f) => f.severity === 'release_blocking').length, 0);

  for (const f of scan.findings) {
    assert.ok(f.evidence.length > 0, `${f.title} has evidence`);
    assert.ok(f.recommendation.length > 0);
    assert.doesNotMatch(f.recommendation, /\brm\b|delete -|rmdir/i, 'no destructive commands are suggested');
  }
  // Sorted most severe first.
  assert.equal(scan.findings[0]!.severity, 'confirmed');
  assert.ok(scan.notChecked.some((n) => n.includes('MCP tool names')));
});

test('M4-AC5: an empty or missing setup scans cleanly', (t) => {
  const { home, cleanup } = tempHome();
  t.after(cleanup);
  const scan = runToolScan({ configDir: join(home, 'none'), userConfigFile: join(home, 'none.json'), managedDirs: [], projectDirs: [] });
  assert.deepEqual([scan.entries.length, scan.findings.length, scan.issues.length], [0, 0, 0]);
});

test('M4-AC6: scans are stored redacted, audited and pruned; the IPC handler scans only main-process roots', (t) => {
  const { home, cleanup } = tempHome();
  const roots = buildClaudeFixture(join(home, 'fixture'));
  const s = new AppService(join(home, 'app'), '0.0.0-test', () => roots);
  t.after(() => {
    s.close();
    cleanup();
  });
  assert.deepEqual(s.handlers.getToolScan(), { ok: true, value: null });
  const r = s.handlers.scanTools('/etc' as never);
  assert.ok(r.ok);
  assert.equal(r.value.roots.configDir, roots.configDir, 'renderer arguments are ignored');
  const latest = s.handlers.getToolScan();
  assert.ok(latest.ok && latest.value?.id === r.value.id);
  s.close();

  const ws = Workspace.open(join(home, 'app'));
  for (let i = 0; i < 22; i++) ws.saveToolScan(runToolScan(roots));
  const count = (ws as unknown as { db: { prepare(sql: string): { get(): { n: number } } } }).db.prepare('SELECT COUNT(*) AS n FROM tool_scans').get().n;
  assert.equal(count, 20);
  assert.equal(ws.listEvents({ limit: 1000 }).filter((e) => e.type === 'tools.scanned').length, 23, 'every scan stays in the audit log');
  ws.close();
});

test('M4: default locations per OS and CLAUDE_CONFIG_DIR', () => {
  assert.deepEqual(defaultScanRoots({}, 'linux', '/home/u'), {
    configDir: '/home/u/.claude',
    userConfigFile: '/home/u/.claude.json',
    managedDirs: ['/etc/claude-code'],
    projectDirs: [],
  });
  assert.deepEqual(defaultScanRoots({}, 'darwin', '/Users/u').managedDirs, ['/Library/Application Support/ClaudeCode']);
  assert.ok(defaultScanRoots({}, 'win32', 'C:\\Users\\u').managedDirs.includes('C:\\Program Files\\ClaudeCode'));
  assert.equal(defaultScanRoots({}, 'win32', 'C:\\Users\\u').configDir, 'C:\\Users\\u\\.claude');
  const custom = defaultScanRoots({ CLAUDE_CONFIG_DIR: '/cfg' }, 'linux', '/home/u');
  assert.equal(custom.configDir, '/cfg');
  assert.match(custom.userConfigFile, /^\/cfg[\\/]\.claude\.json$/);
});

test('M4: frontmatter parsing ignores everything after the header', () => {
  assert.deepEqual(parseFrontmatter('---\nname: "x"\ndescription: Does y\n---\nname: not-this'), { name: 'x', description: 'Does y' });
  assert.deepEqual(parseFrontmatter('no header'), {});
});
