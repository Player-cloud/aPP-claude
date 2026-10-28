// M12 external change monitor: fixed trusted sources, honest coverage (what did
// not answer is listed), one item per tool and version, and separate discovery,
// approval, installation and verification. Nothing here touches the network:
// every source answers from a table, and Claude Code is a stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tempHome } from './helpers.ts';
import { buildClaudeFixture } from './claude-fixture.ts';
import { Workspace } from '../src/core/workspace.ts';
import { appPaths } from '../src/core/paths.ts';
import { runToolScan } from '../src/core/tools.ts';
import {
  changelogBetween,
  compareVersions,
  githubRepo,
  httpFetcher,
  isMajorBump,
  notesHint,
  UpdateMonitor,
  type Fetcher,
  type ModelInfo,
  type MonitorInputs,
} from '../src/core/updates/updates.ts';
import { AppService } from '../src/main/service.ts';
import { IAP_METHODS } from '../src/shared/api.ts';
import type { ToolEntry } from '../src/core/inventory.ts';

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const NPM = 'https://registry.npmjs.org/';
const CC_NOTES = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md';
const SDK_NOTES = 'https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/CHANGELOG.md';
const MARKET = 'https://raw.githubusercontent.com/acme/plugins/HEAD/.claude-plugin/marketplace.json';
const ADVISORIES = `${NPM}-/npm/v1/security/advisories/bulk`;

type Answer = { status?: number; json?: unknown; text?: string } | 'down';

function sources(): Record<string, Answer> {
  return {
    [`${NPM}@anthropic-ai%2fsdk/latest`]: { json: { version: '1.4.0' } },
    [`${NPM}@anthropic-ai%2fsdk/1.3.0`]: { json: { version: '1.3.0' } },
    [`${NPM}electron/latest`]: { json: { version: '46.0.1' } },
    [`${NPM}electron/45.1.0`]: { json: { version: '45.1.0' } },
    [`${NPM}react/latest`]: 'down',
    [`${NPM}react-dom/latest`]: { json: { version: '18.3.1' } },
    [`${NPM}react-dom/18.3.1`]: { json: { version: '18.3.1', deprecated: 'Use a newer [release](https://react.dev).' } },
    [`${NPM}@anthropic-ai%2fclaude-code/latest`]: { json: { version: '2.1.0' } },
    [`${NPM}@anthropic-ai%2fclaude-code/2.0.0`]: { json: { version: '2.0.0' } },
    [ADVISORIES]: { json: { electron: [{ id: 1105820, url: 'https://github.com/advisories/GHSA-test', title: 'Heap overflow in NativeImage', severity: 'moderate', vulnerable_versions: '<45.2.0' }] } },
    [CC_NOTES]: { text: '# Changelog\n\n## 2.1.0\n\n- Added plugin update notes\n- Fixed a crash\n\n## 2.0.1\n\n- Faster startup\n\n## 2.0.0\n\n- Old entry\n' },
    [SDK_NOTES]: {
      text: '# Changelog\n\n## [1.4.0](https://github.com/x/compare/a...b) (2026-10-27)\n\n### Features\n\n* **api:** add something\n* removed the legacy beta header\n\n## [1.3.0](https://x) (2026-10-23)\n\n* old\n',
    },
    [MARKET]: { json: { name: 'acme', plugins: [{ name: 'review-kit', version: '1.3.0', description: 'Reviews code' }, { name: 'broken' }] } },
  };
}

function setup(t: { after: (fn: () => void) => void }, opts: { models?: ModelInfo[] | null } = {}) {
  const { home, cleanup } = tempHome();
  const roots = buildClaudeFixture(join(home, 'fixture'));
  let clock = Date.parse('2026-10-28T10:00:00Z');
  const ws = Workspace.open(home, { actor: 'joshua', now: () => new Date(clock) });
  t.after(() => {
    ws.close();
    cleanup();
  });
  ws.saveToolScan(runToolScan(roots));
  const table = sources();
  const asked: { url: string; method: string; body?: string }[] = [];
  const fetcher: Fetcher = async (url, init = {}) => {
    asked.push({ url, method: init.method ?? 'GET', body: init.body });
    const a = table[url];
    if (!a) return { status: 404, text: 'not found' };
    if (a === 'down') throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
    return { status: a.status ?? 200, text: a.text ?? JSON.stringify(a.json) };
  };
  const state = { claude: '2.0.0' as string | null, bundled: { '@anthropic-ai/sdk': '1.3.0', electron: '45.1.0', react: '18.3.1', 'react-dom': '18.3.1' } as Record<string, string | null> };
  const inputs: MonitorInputs = {
    fetcher,
    bundled: state.bundled,
    claudeVersion: async () => (state.claude ? { version: state.claude, error: null } : { version: null, error: 'Claude Code (the claude command) was not found on PATH.' }),
    listModels: opts.models ? async () => opts.models! : null,
    currentModel: 'claude-opus-5-5',
    rescan: () => runToolScan(roots),
  };
  const monitor = new UpdateMonitor(ws, inputs);
  const tick = (ms = 60_000) => (clock += ms);
  const byTitle = (re: RegExp) => monitor.overview().items.find((i) => re.test(i.title))!;
  return { home, ws, roots, monitor, table, asked, state, tick, byTitle };
}

test('M12: versions, release notes and marketplaces are read conservatively', () => {
  assert.equal(compareVersions('2.1.10', '2.1.9')! > 0, true);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('latest', '1.0.0'), null);
  assert.ok(isMajorBump('45.1.0', '46.0.0'));
  assert.ok(isMajorBump('0.4.2', '0.5.0'));
  assert.ok(!isMajorBump('1.3.0', '1.4.0'));

  const cc = changelogBetween(sources()[CC_NOTES] !== 'down' ? (sources()[CC_NOTES] as { text: string }).text : '', '2.0.0', '2.1.0');
  assert.deepEqual(cc, { lines: ['Added plugin update notes', 'Fixed a crash', 'Faster startup'], total: 3, versions: 2 });
  const sdk = changelogBetween((sources()[SDK_NOTES] as { text: string }).text, '1.3.0', '1.4.0');
  assert.deepEqual(sdk.lines, ['**api:** add something', 'removed the legacy beta header']);
  assert.equal(notesHint(sdk.lines)?.priority, 'breaking');
  assert.equal(notesHint(['Fixed CVE-2026-1234 in the proxy'])?.priority, 'security');
  assert.equal(notesHint(['Faster startup']), null);

  const market = (details: Record<string, string>) => ({ details }) as unknown as ToolEntry;
  assert.equal(githubRepo(market({ type: 'github', location: 'acme/plugins' })), 'acme/plugins');
  assert.equal(githubRepo(market({ type: 'git', location: 'https://github.com/acme/plugins.git' })), 'acme/plugins');
  assert.equal(githubRepo(market({ type: 'github', location: '../../etc' })), null);
  assert.equal(githubRepo(market({ type: 'url', location: 'https://evil.example/m.json' })), null);
});

test('M12: a check finds updates, advisories and deprecations, maps them to workflows, and lists what did not answer', async (t) => {
  const { ws, monitor, asked, byTitle } = setup(t);
  const check = await monitor.check();
  const status = Object.fromEntries(check.sources.map((s) => [s.id, s.status]));
  assert.equal(status['npm:react'], 'unreachable');
  assert.equal(status['anthropic:models'], 'not_checked');
  assert.equal(status['npm:advisories'], 'ok');
  assert.equal(status['market:acme'], 'ok');
  assert.match(check.sources.find((s) => s.id === 'anthropic:models')!.detail, /No API key/);
  assert.ok(check.notChecked.some((n) => /MCP servers/.test(n)));
  assert.ok(check.notChecked.some((n) => /could not be compared/.test(n)), 'broken@acme declares no version in the marketplace');

  const sdk = byTitle(/Anthropic SDK 1\.4\.0/);
  assert.equal(sdk.stage, 'recommended');
  assert.equal(sdk.priority, 'breaking', 'the release notes say something was removed');
  assert.equal(sdk.confidence, 'medium');
  assert.deepEqual(sdk.summary, ['**api:** add something', 'removed the legacy beta header']);
  assert.ok(sdk.impacts.workflows.includes('Build Feature agent'));
  assert.ok(sdk.impacts.tests.includes('test/claude.test.ts'));
  assert.match(sdk.installSteps.join(' '), /new app release/);
  assert.equal(sdk.approval, null);
  assert.equal(sdk.installed, null);

  const electron = byTitle(/Electron 46\.0\.1/);
  assert.equal(electron.priority, 'breaking');
  assert.equal(electron.confidence, 'high');
  const advisory = byTitle(/Heap overflow/);
  assert.equal(advisory.priority, 'security');
  assert.equal(advisory.observedVersion, null);
  assert.ok(advisory.summary.includes('Affected versions: <45.2.0'));
  const deprecated = byTitle(/React DOM 18\.3\.1 is deprecated/);
  assert.equal(deprecated.priority, 'deprecation');
  assert.deepEqual(deprecated.summary, ['npm says: Use a newer release.']);

  const cc = byTitle(/Claude Code 2\.1\.0/);
  assert.equal(cc.priority, 'improvement');
  assert.match(cc.installSteps[0]!, /claude update/);
  assert.ok(cc.impacts.workflows.some((w) => /Tool cleanup/.test(w)));

  const plugins = monitor.overview().items.filter((i) => i.kind === 'plugin');
  assert.deepEqual(plugins.map((p) => p.toolName).sort(), ['review-kit@acme (project)', 'review-kit@acme (user)']);
  const userPlugin = plugins.find((p) => p.toolName.endsWith('(user)'))!;
  assert.equal(userPlugin.installedVersion, '1.2.0');
  assert.match(userPlugin.installSteps[0]!, /claude plugin update review-kit@acme --scope user/);
  assert.ok(userPlugin.impacts.workflows.some((w) => /Provides/.test(w)));

  // Only the fixed hosts were asked, and only package names and versions were sent.
  for (const a of asked) assert.match(a.url, /^https:\/\/(registry\.npmjs\.org|raw\.githubusercontent\.com)\//);
  const bulk = asked.find((a) => a.method === 'POST')!;
  assert.deepEqual(JSON.parse(bulk.body!), { '@anthropic-ai/sdk': ['1.3.0'], electron: ['45.1.0'], react: ['18.3.1'], 'react-dom': ['18.3.1'], '@anthropic-ai/claude-code': ['2.0.0'] });

  const events = ws.listEvents({ limit: 100 }).map((e) => e.type);
  assert.ok(events.includes('update.checked'));
  assert.equal(events.filter((e) => e === 'update.discovered').length, check.created.length);
});

test('M12: checking again updates the same items, and a newer release supersedes an older open one', async (t) => {
  const { monitor, table, tick, byTitle } = setup(t);
  const first = await monitor.check();
  tick();
  const again = await monitor.check();
  assert.equal(again.created.length, 0);
  assert.equal(again.updated.length, first.created.length);
  assert.equal(byTitle(/Claude Code 2\.1\.0/).lastCheckId, again.id);

  table[`${NPM}@anthropic-ai%2fclaude-code/latest`] = { json: { version: '2.2.0' } };
  tick();
  const third = await monitor.check();
  assert.equal(third.created.length, 1);
  assert.equal(byTitle(/Claude Code 2\.1\.0/).stage, 'superseded');
  assert.equal(byTitle(/Claude Code 2\.2\.0/).stage, 'recommended');
});

test('M12: approval installs nothing; installation is seen by a later check; verification records evidence', async (t) => {
  const { ws, monitor, state, table, tick, byTitle } = setup(t);
  await monitor.check();
  const cc = byTitle(/Claude Code 2\.1\.0/);
  assert.throws(() => monitor.dismiss(cc.id, '  '), /Say why/);
  const approved = monitor.approve(cc.id, 'Want the plugin fixes');
  assert.equal(approved.stage, 'approved');
  assert.deepEqual({ by: approved.approval!.by, note: approved.approval!.note }, { by: 'joshua', note: 'Want the plugin fixes' });
  assert.throws(() => monitor.approve(cc.id, null), /Only a recommended update/);
  await assert.rejects(monitor.verify(cc.id), /Only an installed update/);

  // Still 2.0.0: the next check does not claim it is installed.
  tick();
  await monitor.check();
  assert.equal(ws.getUpdate(cc.id).stage, 'approved');

  // The person updated Claude Code outside the app.
  state.claude = '2.1.0';
  tick();
  const seen = await monitor.check();
  assert.ok(seen.installed.includes(cc.id));
  const installed = ws.getUpdate(cc.id);
  assert.equal(installed.stage, 'installed');
  assert.match(installed.installed!.evidence, /Claude Code 2\.1\.0 is installed/);

  const verified = await monitor.verify(cc.id);
  assert.equal(verified.stage, 'verified', verified.verification!.evidence.join('\n'));
  assert.match(verified.verification!.evidence[0]!, /Version 2\.1\.0 is in place/);
  assert.ok(verified.verification!.evidence.some((e) => /fresh tool scan finished/.test(e)));
  assert.throws(() => monitor.dismiss(cc.id, 'no'), /Only an open update/);

  // An advisory clears when the installed version is no longer affected.
  const advisory = byTitle(/Heap overflow/);
  state.bundled.electron = '45.2.0';
  table[`${NPM}electron/45.2.0`] = { json: { version: '45.2.0' } };
  table[ADVISORIES] = { json: {} };
  tick();
  await monitor.check();
  assert.equal(ws.getUpdate(advisory.id).stage, 'installed');
  const electronVerify = await monitor.verify(advisory.id);
  assert.equal(electronVerify.stage, 'verified');
  assert.ok(electronVerify.verification!.evidence.some((e) => /cannot rerun them on this computer/.test(e)));

  // Dismiss and reopen.
  const plugin = byTitle(/review-kit@acme 1\.3\.0 is available \(user install\)/);
  assert.equal(monitor.dismiss(plugin.id, 'Waiting for the team').stage, 'dismissed');
  assert.equal(monitor.reopen(plugin.id).stage, 'recommended');

  // Records are kept: no deletes, and a verified item cannot change.
  const db = new DatabaseSync(appPaths(ws.paths.home).db);
  t.after(() => db.close());
  assert.throws(() => db.exec(`DELETE FROM updates WHERE id = '${plugin.id}'`), /never deleted/);
  assert.throws(() => db.exec(`UPDATE updates SET stage = 'recommended' WHERE id = '${cc.id}'`), /cannot change/);
  assert.throws(() => db.exec(`UPDATE update_checks SET created = '[]'`), /cannot change/);
});

test('M12: verification fails honestly when the version is not in place', async (t) => {
  const { ws, monitor, state, tick, byTitle } = setup(t);
  await monitor.check();
  const cc = byTitle(/Claude Code 2\.1\.0/);
  state.claude = '2.1.0';
  tick();
  await monitor.check();
  state.claude = null; // uninstalled again before verifying
  const failed = await monitor.verify(cc.id);
  assert.equal(failed.stage, 'failed');
  assert.match(failed.verification!.evidence.join('\n'), /could not be read/);
  assert.equal(ws.listEvents({ limit: 5 }).at(-1)!.type, 'update.verification_failed');
});

test('M12: models are checked only with a key; a newer model is never adopted automatically', async (t) => {
  const { monitor, byTitle } = setup(t, {
    models: [
      { id: 'claude-opus-5-5', createdAt: '2026-08-01T00:00:00Z', name: 'Claude Opus 5.5' },
      { id: 'claude-opus-6', createdAt: '2026-10-20T00:00:00Z', name: 'Claude Opus 6' },
      { id: 'claude-haiku-4', createdAt: '2025-01-01T00:00:00Z', name: 'Claude Haiku 4' },
    ],
  });
  const check = await monitor.check();
  assert.equal(check.sources.find((s) => s.id === 'anthropic:models')!.status, 'ok');
  const m = byTitle(/Newer model available: Claude Opus 6/);
  assert.equal(m.priority, 'info');
  assert.match(m.recommendation, /keeps using claude-opus-5-5/);
  assert.equal(monitor.overview().items.filter((i) => i.kind === 'model').length, 1, 'older models are not reported');
  monitor.approve(m.id, null);
  await assert.rejects(monitor.verify(m.id), /Only an installed update/);
});

test('M12: a retired model and unreachable sources are reported, and long-silent sources count as stale', async (t) => {
  const { monitor, table, tick } = setup(t, { models: [{ id: 'claude-opus-6', createdAt: '2026-10-20T00:00:00Z', name: null }] });
  for (const k of Object.keys(table)) table[k] = 'down';
  const check = await monitor.check();
  assert.ok(check.sources.filter((s) => s.id.startsWith('npm:') && s.id !== 'npm:advisories').every((s) => s.status === 'unreachable'));
  assert.equal(check.sources.find((s) => s.id === 'npm:advisories')!.status, 'unreachable');
  assert.match(check.sources.find((s) => s.id === 'npm:advisories')!.detail, /were not checked/);
  const items = monitor.overview().items;
  assert.deepEqual(items.map((i) => i.title), ['claude-opus-5-5 is not in the model list']);
  const stale = monitor.overview().stale.map((s) => s.id);
  assert.ok(stale.includes('npm:electron') && stale.includes('market:acme'));

  // Answering again clears the staleness.
  Object.assign(table, sources());
  tick();
  await monitor.check();
  assert.ok(!monitor.overview().stale.some((s) => s.id === 'npm:electron'));
});

test('M12: the network fetcher only talks HTTPS to the trusted hosts', async () => {
  const f = httpFetcher(1_000);
  await assert.rejects(f('https://evil.example/x'), /Not a trusted source/);
  await assert.rejects(f('http://registry.npmjs.org/electron/latest'), /Not a trusted source/);
  await assert.rejects(f('https://registry.npmjs.org.evil.example/electron'), /Not a trusted source/);
});

test('M12: the service checks through its fetcher, and the renderer cannot name a source', async (t) => {
  const { home, cleanup: rm } = tempHome();
  const roots = buildClaudeFixture(join(home, 'fixture'));
  const urls: string[] = [];
  const service = new AppService(home, '0.0.0-test', {
    scanRoots: () => roots,
    claudeCommand: [process.execPath, FAKE],
    bundled: { '@anthropic-ai/sdk': '1.3.0', electron: '45.1.0', react: '18.3.1', 'react-dom': '18.3.1' },
    fetcher: async (url) => {
      urls.push(url);
      return url.endsWith('/latest') ? { status: 200, text: JSON.stringify({ version: '99.0.0' }) } : { status: 404, text: '' };
    },
    listModels: async () => {
      throw new Error('must not be called without a key');
    },
  });
  t.after(() => {
    service.close();
    rm();
  });
  process.env.FAKE_CLAUDE_VERSION = '2.0.5';
  t.after(() => delete process.env.FAKE_CLAUDE_VERSION);
  for (const m of ['checkUpdates', 'getUpdates', 'approveUpdate', 'dismissUpdate', 'reopenUpdate', 'verifyUpdate']) assert.ok((IAP_METHODS as readonly string[]).includes(m));
  const h = service.handlers;
  assert.ok(h.scanTools().ok);
  const c = await h.checkUpdates('https://evil.example');
  assert.ok(c.ok, c.ok ? '' : c.error.message);
  assert.ok(urls.every((u) => !u.includes('evil')));
  const cc = c.ok ? c.value.sources.find((s) => s.id === 'npm:@anthropic-ai/claude-code')! : null!;
  assert.equal(cc.detail, 'Installed 2.0.5, newest 99.0.0.');
  const o = h.getUpdates();
  assert.ok(o.ok && o.value.items.length >= 5);
  const first = o.ok ? o.value.items[0]! : null!;
  assert.equal(h.dismissUpdate({ id: first.id }).ok, false);
  assert.equal(h.approveUpdate('nope').ok, false);
  const ok = h.approveUpdate({ id: first.id, note: 'yes' });
  assert.ok(ok.ok && ok.value.stage === 'approved');
});

test('M12: the CLI checks, lists, shows and approves by UPD number', (t) => {
  const { home, cleanup: rm } = tempHome();
  t.after(rm);
  const roots = buildClaudeFixture(join(home, 'fixture'));
  const fixture = join(home, 'sources.json');
  writeFileSync(fixture, JSON.stringify({ [`${NPM}@anthropic-ai%2fclaude-code/latest`]: { json: { version: '2.5.0' } }, [CC_NOTES]: { text: '## 2.5.0\n- New thing\n' } }));
  const CLI = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
  const iap = (...args: string[]) => {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: roots.configDir, IAP_HOME: join(home, 'app'), IAP_UPDATE_FIXTURE: fixture, IAP_CLAUDE_COMMAND: JSON.stringify([process.execPath, FAKE]), FAKE_CLAUDE_VERSION: '2.0.0', ANTHROPIC_API_KEY: '' },
      encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const check = iap('updates', 'check');
  assert.equal(check.code, 0, check.err);
  assert.match(check.out, /unreachable +npm registry: electron: getaddrinfo ENOTFOUND/);
  assert.match(check.out, /not_checked +Anthropic model list/);
  assert.match(check.out, /UPD-1 +improvement +Claude Code 2\.5\.0 is available/);
  assert.match(iap('updates', 'list').out, /UPD-1 +recommended/);
  assert.match(iap('updates', 'show', 'UPD-1').out, /- New thing/);
  const approved = iap('updates', 'approve', 'UPD-1', '--note', 'go');
  assert.equal(approved.code, 0, approved.err);
  assert.match(approved.out, /approved by .* go/);
  assert.match(iap('updates', 'verify', 'UPD-1').err, /Only an installed update/);
  assert.doesNotMatch(readFileSync(fixture, 'utf8'), /installed/);
});
