// Read-only inventory of the user's Claude Code tools (FR-TOOL-001, M4).
//
// The scanner only reads files. It never starts MCP servers, runs hooks,
// executes plugin code, writes to Claude Code's configuration, or follows
// instructions found in the files it reads: everything it reads is untrusted
// data. Values that can carry credentials (MCP env vars, headers, URLs, hook
// commands) are reduced to key names or redacted before they leave this module.
//
// Locations follow Claude Code's documented layout. Where a location or
// format is not certain, the entry or field says "unknown" instead of guessing.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, posix, relative, win32 } from 'node:path';
import { redactString } from './redact.ts';

export type ToolKind = 'plugin' | 'marketplace' | 'skill' | 'command' | 'agent' | 'hook' | 'mcp_server';
/** managed = organisation policy; local = per-project entries in the user's own config file. */
export type ToolScope = 'managed' | 'user' | 'project' | 'local' | 'plugin' | 'unknown';
export type ToolStatus = 'enabled' | 'disabled' | 'unknown';
export type RemovalMethod = 'plugin-manager' | 'mcp-cli' | 'via-plugin' | 'manual' | 'not-removable';

export interface ToolEntry {
  id: string;
  kind: ToolKind;
  name: string;
  /** How the user invokes it, e.g. "/review" or "/my-plugin:review". Null when not directly invoked. */
  invocation: string | null;
  scope: ToolScope;
  /** Project folder for project/local scope, plugin id for plugin scope. */
  scopeDetail: string | null;
  /** File the entry was read from. */
  source: string;
  /** Null means unknown. */
  version: string | null;
  status: ToolStatus;
  /** Who installed it, as far as the files show. */
  provenance: 'user' | 'plugin' | 'organisation' | 'unknown';
  /** Plugin id when the entry is part of a plugin. */
  owner: string | null;
  /** The platform manages none of these yet (FR-TOOL-001: distinguish app-managed from user-installed). */
  appManaged: boolean;
  description: string | null;
  details: Record<string, string>;
  removal: { method: RemovalMethod; instructions: string };
}

export interface ScanIssue {
  path: string;
  problem: string;
}

export interface ScanRoots {
  /** Claude Code's configuration directory: $CLAUDE_CONFIG_DIR or ~/.claude. */
  configDir: string;
  /** The user's global config file (~/.claude.json). Only MCP-related keys are read. */
  userConfigFile: string;
  /** Organisation-managed settings directories for this OS. */
  managedDirs: string[];
  /** Extra project folders to include (each may contain .claude/ and .mcp.json). Folders recorded in userConfigFile are always included. */
  projectDirs: string[];
}

export interface Inventory {
  roots: ScanRoots;
  entries: ToolEntry[];
  issues: ScanIssue[];
  /** Raw facts the conflict detector needs that are not entries themselves. */
  references: { enabledPlugins: { id: string; enabled: boolean; source: string }[] };
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES_PER_DIR = 2000;
const MAX_DEPTH = 4;
const MAX_PROJECTS = 100;

export function defaultScanRoots(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  projectDirs: string[] = [],
): ScanRoots {
  // Join with the target platform's separator, not the host's (as in paths.ts).
  const pjoin = platform === 'win32' ? win32.join : posix.join;
  const custom = env.CLAUDE_CONFIG_DIR?.trim();
  const configDir = custom || pjoin(home, '.claude');
  // With CLAUDE_CONFIG_DIR set, Claude Code keeps .claude.json inside that directory.
  const userConfigFile = custom ? pjoin(custom, '.claude.json') : pjoin(home, '.claude.json');
  const managedDirs =
    platform === 'win32'
      ? ['C:\\Program Files\\ClaudeCode', 'C:\\ProgramData\\ClaudeCode']
      : platform === 'darwin'
        ? ['/Library/Application Support/ClaudeCode']
        : ['/etc/claude-code'];
  return { configDir, userConfigFile, managedDirs, projectDirs };
}

// ---- Small, defensive readers ---------------------------------------------

class Reader {
  readonly issues: ScanIssue[] = [];

  isFile(path: string): boolean {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }

  isDir(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  text(path: string): string | null {
    try {
      const size = statSync(path).size;
      if (size > MAX_FILE_BYTES) {
        this.issues.push({ path, problem: `Skipped: larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.` });
        return null;
      }
      return readFileSync(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.issues.push({ path, problem: `Could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'}).` });
      return null;
    }
  }

  json(path: string): Record<string, unknown> | null {
    const raw = this.text(path);
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      this.issues.push({ path, problem: 'Not a JSON object, so Claude Code is likely to ignore it.' });
    } catch {
      this.issues.push({ path, problem: 'Invalid JSON, so Claude Code is likely to ignore it or report an error.' });
    }
    return null;
  }

  /** Files under dir matching a predicate, depth-limited, without following directory symlinks. */
  files(dir: string, match: (name: string) => boolean, depth = MAX_DEPTH): string[] {
    const out: string[] = [];
    const walk = (current: string, level: number) => {
      if (level > depth || out.length >= MAX_FILES_PER_DIR) return;
      let names: string[];
      try {
        names = readdirSync(current).sort();
      } catch {
        return;
      }
      for (const name of names) {
        const full = join(current, name);
        let st;
        try {
          st = lstatSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(full, level + 1);
        else if ((st.isFile() || st.isSymbolicLink()) && match(name)) out.push(full);
        if (out.length >= MAX_FILES_PER_DIR) {
          this.issues.push({ path: dir, problem: `Stopped after ${MAX_FILES_PER_DIR} files.` });
          return;
        }
      }
    };
    if (this.isDir(dir)) walk(dir, 0);
    return out;
  }

  subdirs(dir: string): string[] {
    try {
      return readdirSync(dir)
        .sort()
        .map((n) => join(dir, n))
        .filter((p) => this.isDir(p));
    } catch {
      return [];
    }
  }
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const asString = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
const clip = (value: string, max = 240) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** The small YAML subset used in skill, command and agent frontmatter: top-level `key: value` lines. */
export function parseFrontmatter(text: string): Record<string, string> {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (value && value !== '|' && value !== '>') out[kv[1]!] = value;
  }
  return out;
}

/** Redact secrets and drop query strings and credentials from URLs. */
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    const hadSecretParts = !!(u.username || u.password || u.search);
    return `${u.protocol}//${u.host}${u.pathname}${hadSecretParts ? ' (credentials/query hidden)' : ''}`;
  } catch {
    return redactString(clip(url));
  }
}

function entryId(...parts: (string | null)[]): string {
  return 't_' + createHash('sha256').update(parts.map((p) => p ?? '').join('\u0000')).digest('hex').slice(0, 16);
}

// ---- Scanner ----------------------------------------------------------------

interface Origin {
  scope: ToolScope;
  scopeDetail: string | null;
  provenance: ToolEntry['provenance'];
  owner: string | null;
  /** Plugin short name, used to namespace invocations. */
  namespace: string | null;
  /** Plugin components follow their plugin's enabled state. */
  status?: ToolStatus;
}

export function scanInventory(roots: ScanRoots): Inventory {
  const r = new Reader();
  const entries: ToolEntry[] = [];
  const enabledPlugins: Inventory['references']['enabledPlugins'] = [];

  const add = (e: Omit<ToolEntry, 'id' | 'appManaged'>) => {
    entries.push({ ...e, id: entryId(e.kind, e.scope, e.scopeDetail, e.source, e.name, e.description), appManaged: false });
  };

  const removalFor = (origin: Origin, path: string, what: string): ToolEntry['removal'] => {
    if (origin.owner) return { method: 'via-plugin', instructions: `Part of plugin ${origin.owner}. Disable or uninstall the plugin instead of editing its files.` };
    if (origin.scope === 'managed') return { method: 'not-removable', instructions: 'Set by your organisation. Ask your administrator to change it.' };
    return { method: 'manual', instructions: `Remove or rename ${what} at ${path} yourself. The app will not delete it.` };
  };

  // Markdown-defined tools: skills (folder with SKILL.md), commands and agents (one file each).
  const scanSkills = (dir: string, origin: Origin) => {
    for (const skillDir of r.subdirs(dir)) {
      const file = join(skillDir, 'SKILL.md');
      if (!r.isFile(file)) continue;
      const fm = parseFrontmatter(r.text(file) ?? '');
      const name = fm.name || basename(skillDir);
      add({
        kind: 'skill',
        name,
        invocation: origin.namespace ? `/${origin.namespace}:${name}` : `/${name}`,
        ...originFields(origin),
        source: file,
        version: fm.version ?? null,
        status: 'unknown',
        description: fm.description ? clip(fm.description) : null,
        details: fm['allowed-tools'] ? { 'allowed tools': clip(fm['allowed-tools']) } : {},
        removal: removalFor(origin, skillDir, 'the skill folder'),
      });
    }
  };
  const scanCommands = (dir: string, origin: Origin) => {
    for (const file of r.files(dir, (n) => n.endsWith('.md'))) {
      const fm = parseFrontmatter(r.text(file) ?? '');
      const name = basename(file, '.md');
      const sub = relative(dir, file).split(/[\\/]/).slice(0, -1).join('/');
      add({
        kind: 'command',
        name,
        invocation: origin.namespace ? `/${origin.namespace}:${name}` : `/${name}`,
        ...originFields(origin),
        source: file,
        version: null,
        status: 'unknown',
        description: fm.description ? clip(fm.description) : null,
        details: sub ? { folder: sub } : {},
        removal: removalFor(origin, file, 'the command file'),
      });
    }
  };
  const scanAgents = (dir: string, origin: Origin) => {
    for (const file of r.files(dir, (n) => n.endsWith('.md'))) {
      const fm = parseFrontmatter(r.text(file) ?? '');
      const name = fm.name || basename(file, '.md');
      const details: Record<string, string> = {};
      if (fm.tools) details.tools = clip(fm.tools);
      if (fm.model) details.model = fm.model;
      add({
        kind: 'agent',
        name,
        invocation: origin.namespace ? `${origin.namespace}:${name}` : name,
        ...originFields(origin),
        source: file,
        version: null,
        status: 'unknown',
        description: fm.description ? clip(fm.description) : null,
        details,
        removal: removalFor(origin, file, 'the agent file'),
      });
    }
  };

  const scanHooks = (hooks: unknown, source: string, origin: Origin) => {
    const byEvent = asObject(hooks);
    if (!byEvent) return;
    for (const [event, groups] of Object.entries(byEvent)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        const g = asObject(group);
        const matcher = asString(g?.matcher) ?? '*';
        const list = Array.isArray(g?.hooks) ? g.hooks : [];
        for (const hook of list) {
          const h = asObject(hook);
          const command = asString(h?.command);
          const type = asString(h?.type) ?? 'unknown';
          const shown = command ? clip(redactString(command), 160) : `(${type} hook)`;
          add({
            kind: 'hook',
            name: `${event} · ${matcher}`,
            invocation: null,
            ...originFields(origin),
            source,
            version: null,
            status: origin.status ?? 'enabled',
            description: shown,
            details: { event, matcher, type, ...(command ? { command: shown } : {}) },
            removal: origin.owner
              ? removalFor(origin, source, '')
              : origin.scope === 'managed'
                ? removalFor(origin, source, '')
                : { method: 'manual', instructions: `Edit ${source} and remove this entry under "hooks" → "${event}". The app will not edit it.` },
          });
        }
      }
    }
  };

  const scanMcpServers = (servers: unknown, source: string, origin: Origin, statusOf: (name: string) => ToolStatus = () => origin.status ?? 'enabled') => {
    const map = asObject(servers);
    if (!map) return;
    for (const [name, raw] of Object.entries(map)) {
      const c = asObject(raw) ?? {};
      const command = asString(c.command);
      const url = asString(c.url);
      const args = Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === 'string') : [];
      const transport = asString(c.type) ?? (command ? 'stdio' : url ? 'http' : 'unknown');
      const details: Record<string, string> = { transport };
      if (command) details.command = clip(redactString([command, ...args].join(' ')));
      if (url) details.url = safeUrl(url);
      const env = asObject(c.env);
      if (env && Object.keys(env).length) details['env vars (values hidden)'] = Object.keys(env).join(', ');
      const headers = asObject(c.headers);
      if (headers && Object.keys(headers).length) details['headers (values hidden)'] = Object.keys(headers).join(', ');
      // Fingerprint for duplicate detection; built only from non-secret parts.
      details.fingerprint = `${transport}|${details.command ?? ''}|${details.url ?? ''}`;
      const cliScope = origin.scope === 'user' || origin.scope === 'project' || origin.scope === 'local' ? origin.scope : null;
      add({
        kind: 'mcp_server',
        name,
        invocation: null,
        ...originFields(origin),
        source,
        version: null,
        status: statusOf(name),
        description: details.command ?? details.url ?? null,
        details,
        removal:
          origin.owner || origin.scope === 'managed'
            ? removalFor(origin, source, '')
            : cliScope
              ? { method: 'mcp-cli', instructions: `Claude Code supports: claude mcp remove "${name}" -s ${cliScope}${origin.scope !== 'user' && origin.scopeDetail ? ` (run in ${origin.scopeDetail})` : ''}. The app will not run it.` }
              : { method: 'manual', instructions: `Edit ${source}. The app will not edit it.` },
      });
    }
  };

  const scanSettings = (file: string, origin: Origin) => {
    const settings = r.json(file);
    if (!settings) return;
    scanHooks(settings.hooks, file, origin);
    const enabled = asObject(settings.enabledPlugins);
    if (enabled) {
      for (const [id, value] of Object.entries(enabled)) {
        if (typeof value === 'boolean') enabledPlugins.push({ id, enabled: value, source: file });
      }
    }
  };

  const user: Origin = { scope: 'user', scopeDetail: null, provenance: 'user', owner: null, namespace: null };

  // 1. Organisation-managed policy.
  for (const dir of roots.managedDirs) {
    const managed: Origin = { scope: 'managed', scopeDetail: dir, provenance: 'organisation', owner: null, namespace: null };
    scanSettings(join(dir, 'managed-settings.json'), managed);
    scanMcpServers(r.json(join(dir, 'managed-mcp.json'))?.mcpServers, join(dir, 'managed-mcp.json'), managed);
  }

  // 2. User level.
  scanSettings(join(roots.configDir, 'settings.json'), user);
  scanSkills(join(roots.configDir, 'skills'), user);
  scanCommands(join(roots.configDir, 'commands'), user);
  scanAgents(join(roots.configDir, 'agents'), user);

  // ~/.claude.json holds account data too; only MCP keys are read from it.
  const userConfig = r.json(roots.userConfigFile);
  if (userConfig) {
    scanMcpServers(userConfig.mcpServers, roots.userConfigFile, user);
    const projects = asObject(userConfig.projects) ?? {};
    for (const [path, value] of Object.entries(projects)) {
      const p = asObject(value);
      if (!p) continue;
      scanMcpServers(p.mcpServers, roots.userConfigFile, { scope: 'local', scopeDetail: path, provenance: 'user', owner: null, namespace: null });
    }
  }
  const projectApprovals = (dir: string) => {
    const p = asObject(asObject(userConfig?.projects)?.[dir]);
    const list = (key: string) => (Array.isArray(p?.[key]) ? (p[key] as unknown[]).filter((v): v is string => typeof v === 'string') : []);
    return { enabled: list('enabledMcpjsonServers'), disabled: list('disabledMcpjsonServers') };
  };

  // 3. Projects: the ones passed in, plus folders Claude Code itself has recorded in ~/.claude.json.
  const known = Object.keys(asObject(userConfig?.projects) ?? {}).filter((p) => r.isDir(p));
  const projectDirs = [...new Set([...roots.projectDirs, ...known])].slice(0, MAX_PROJECTS);
  if (roots.projectDirs.length + known.length > MAX_PROJECTS) {
    r.issues.push({ path: roots.userConfigFile, problem: `Only the first ${MAX_PROJECTS} project folders were scanned.` });
  }
  for (const dir of projectDirs) {
    const project: Origin = { scope: 'project', scopeDetail: dir, provenance: 'user', owner: null, namespace: null };
    const claudeDir = join(dir, '.claude');
    scanSettings(join(claudeDir, 'settings.json'), project);
    scanSettings(join(claudeDir, 'settings.local.json'), { ...project, scope: 'local' });
    scanSkills(join(claudeDir, 'skills'), project);
    scanCommands(join(claudeDir, 'commands'), project);
    scanAgents(join(claudeDir, 'agents'), project);
    const approvals = projectApprovals(dir);
    // Project .mcp.json servers need the user's approval before Claude Code uses them.
    scanMcpServers(r.json(join(dir, '.mcp.json'))?.mcpServers, join(dir, '.mcp.json'), project, (name) =>
      approvals.disabled.includes(name) ? 'disabled' : approvals.enabled.includes(name) ? 'enabled' : 'unknown',
    );
  }

  // 4. Plugins and their marketplaces.
  const pluginsDir = join(roots.configDir, 'plugins');
  const marketplaces = r.json(join(pluginsDir, 'known_marketplaces.json'));
  for (const [name, value] of Object.entries(marketplaces ?? {})) {
    const m = asObject(value) ?? {};
    const src = asObject(m.source) ?? {};
    const where = asString(src.repo) ?? asString(src.url) ?? asString(src.path) ?? 'unknown';
    add({
      kind: 'marketplace',
      name,
      invocation: null,
      ...originFields(user),
      source: join(pluginsDir, 'known_marketplaces.json'),
      version: null,
      status: 'unknown',
      description: `Plugin marketplace from ${where.startsWith('http') ? safeUrl(where) : where}`,
      details: { type: asString(src.source) ?? 'unknown', location: where.startsWith('http') ? safeUrl(where) : where },
      removal: { method: 'plugin-manager', instructions: `Claude Code supports: claude plugin marketplace remove "${name}". The app will not run it.` },
    });
  }

  const installedFile = join(pluginsDir, 'installed_plugins.json');
  const installed = r.json(installedFile);
  const pluginMap = asObject(installed?.plugins) ?? {};
  for (const [id, value] of Object.entries(pluginMap)) {
    // Format version 2 lists one record per installation scope; version 1 has a single record.
    const records = (Array.isArray(value) ? value : [value]).map(asObject).filter((v): v is Record<string, unknown> => !!v);
    for (const rec of records) {
      const [pluginName, marketplace] = id.includes('@') ? [id.slice(0, id.lastIndexOf('@')), id.slice(id.lastIndexOf('@') + 1)] : [id, null];
      const installPath = asString(rec.installPath);
      const scope = asString(rec.scope);
      const projectPath = asString(rec.projectPath);
      const pluginScope: ToolScope = scope === 'user' || scope === 'project' || scope === 'local' || scope === 'managed' ? scope : scope ? 'unknown' : 'user';
      const manifest = installPath ? r.json(join(installPath, '.claude-plugin', 'plugin.json')) : null;
      const explicit = enabledPlugins.filter((e) => e.id === id);
      const status: ToolStatus = explicit.some((e) => e.enabled) ? 'enabled' : explicit.length ? 'disabled' : 'unknown';
      const details: Record<string, string> = { marketplace: marketplace ?? 'unknown', 'install path': installPath ?? 'unknown' };
      if (installPath && !r.isDir(installPath)) details['install path'] = `${installPath} (missing)`;
      if (asString(rec.gitCommitSha)) details.commit = asString(rec.gitCommitSha)!.slice(0, 12);
      if (asString(rec.installedAt)) details.installed = asString(rec.installedAt)!;
      add({
        kind: 'plugin',
        name: id,
        invocation: null,
        scope: pluginScope,
        scopeDetail: projectPath,
        provenance: 'user',
        owner: null,
        source: installedFile,
        version: asString(rec.version) ?? asString(manifest?.version) ?? null,
        status,
        description: asString(manifest?.description) ? clip(asString(manifest?.description)!) : null,
        details,
        removal: {
          method: 'plugin-manager',
          instructions: `Claude Code supports: claude plugin disable "${id}" (reversible) or claude plugin uninstall "${id}". The app will not run either.`,
        },
      });
      if (!installPath || !r.isDir(installPath)) continue;
      const origin: Origin = { scope: 'plugin', scopeDetail: id, provenance: 'plugin', owner: id, namespace: asString(manifest?.name) ?? pluginName, status };
      const pathsFrom = (key: string, fallback: string) => {
        const v = manifest?.[key];
        const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
        return [join(installPath, fallback), ...list.map((p) => join(installPath, p))];
      };
      for (const dir of pathsFrom('skills', 'skills')) scanSkills(dir, origin);
      for (const dir of pathsFrom('commands', 'commands')) scanCommands(dir, origin);
      for (const dir of pathsFrom('agents', 'agents')) scanAgents(dir, origin);
      const hooksFile = join(installPath, 'hooks', 'hooks.json');
      const hooksJson = r.json(hooksFile);
      if (hooksJson) scanHooks(hooksJson.hooks ?? hooksJson, hooksFile, origin);
      const mcpFile = join(installPath, '.mcp.json');
      const mcpJson = r.json(mcpFile);
      if (mcpJson) scanMcpServers(mcpJson.mcpServers ?? mcpJson, mcpFile, origin);
      if (asObject(manifest?.mcpServers)) scanMcpServers(manifest!.mcpServers, join(installPath, '.claude-plugin', 'plugin.json'), origin);
    }
  }

  // Duplicate paths can appear when a plugin manifest repeats a default folder.
  const seen = new Set<string>();
  const unique = entries.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  // The returned roots list every project folder that was actually scanned.
  return { roots: { ...roots, projectDirs }, entries: unique, issues: r.issues, references: { enabledPlugins } };
}

function originFields(o: { scope: ToolScope; scopeDetail: string | null; provenance: ToolEntry['provenance']; owner: string | null }) {
  return { scope: o.scope, scopeDetail: o.scopeDetail, provenance: o.provenance, owner: o.owner };
}

export const rootsExist = (roots: ScanRoots) => existsSync(roots.configDir) || existsSync(roots.userConfigFile);
