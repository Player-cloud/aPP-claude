// A stand-in for Claude Code's `claude` command in tests. It changes the fixture's
// files the way the documented commands do, records every call, and can be told
// to fail (FAKE_CLAUDE_MODE=fail) or to claim success without doing anything (noop).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [area, verb, name, flag, scope] = process.argv.slice(2);
const config = process.env.FAKE_CLAUDE_CONFIG;
const userFile = process.env.FAKE_CLAUDE_USER_FILE;
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\n');
if (process.env.FAKE_CLAUDE_MODE === 'fail') {
  console.error(`Failed to ${verb} "${name}": another enabled plugin depends on it`);
  process.exit(1);
}
if (process.env.FAKE_CLAUDE_MODE === 'noop') {
  console.log(`Successfully did ${verb} ${name}`);
  process.exit(0);
}
if (flag !== '--scope') process.exit(1);
const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {});
const write = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2));
const settings = scope === 'user' ? join(config, 'settings.json') : join(process.cwd(), '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json');
const installed = join(config, 'plugins', 'installed_plugins.json');
const removed = join(config, 'plugins', 'removed.json');

if (area === 'plugin' && (verb === 'disable' || verb === 'enable')) {
  const s = read(settings);
  s.enabledPlugins = { ...(s.enabledPlugins ?? {}), [name]: verb === 'enable' };
  write(settings, s);
} else if (area === 'plugin' && verb === 'uninstall') {
  const all = read(installed);
  const keep = [];
  const gone = [];
  for (const r of all.plugins[name] ?? []) (r.scope === scope ? gone : keep).push(r);
  if (!gone.length) {
    console.error(`Failed to uninstall plugin "${name}"`);
    process.exit(1);
  }
  all.plugins[name] = keep;
  if (!keep.length) delete all.plugins[name];
  write(installed, all);
  write(removed, { ...read(removed), [`${name}|${scope}`]: gone });
} else if (area === 'plugin' && verb === 'install') {
  const back = read(removed)[`${name}|${scope}`];
  if (!back) process.exit(1);
  const all = read(installed);
  all.plugins[name] = [...(all.plugins[name] ?? []), ...back];
  write(installed, all);
} else if (area === 'mcp' && verb === 'remove') {
  const u = read(userFile);
  if (scope === 'user') delete u.mcpServers[name];
  else delete u.projects[process.cwd()].mcpServers[name];
  write(userFile, u);
} else process.exit(1);
console.log(`Successfully ${verb}d ${name} (scope: ${scope})`);
