// Conflict and duplication detection over a tool inventory (FR-TOOL-002, M4).
//
// Each finding separates evidence (what the files show) from inference (what
// that probably means for Claude Code's behaviour). Similar names alone never
// make a confirmed conflict, and nothing here recommends deleting anything
// automatically: recommendations prefer coexistence, then configuration,
// then disabling, then removal (FR-TOOL-003 ordering).

import { createHash } from 'node:crypto';
import type { Inventory, ToolEntry } from './inventory.ts';

export type Severity = 'informational' | 'potential' | 'confirmed' | 'release_blocking';
export type FindingCategory =
  | 'duplicate_invocation'
  | 'duplicate_agent'
  | 'similar_name'
  | 'duplicate_mcp_name'
  | 'duplicate_mcp_server'
  | 'duplicate_hook'
  | 'overlapping_hooks'
  | 'plugin_not_installed'
  | 'plugin_files_missing'
  | 'plugin_version_mismatch'
  | 'plugin_name_clash'
  | 'overlapping_memory'
  | 'invalid_config';

export interface Finding {
  id: string;
  severity: Severity;
  category: FindingCategory;
  title: string;
  /** Facts read from files. */
  evidence: string[];
  /** What we conclude from the evidence; null when the evidence is the whole story. */
  inference: string | null;
  recommendation: string;
  entryIds: string[];
}

/** Checks a read-only scan cannot do, reported so their absence is visible. */
export const NOT_CHECKED = [
  'Duplicate MCP tool names: servers are not started during a read-only scan, so the tools they expose are unknown.',
  'Broken workflow dependencies: no platform workflow depends on these tools yet (from M5).',
  'Release-blocking conflicts: these need a workflow that depends on a tool, so none can be raised yet.',
  'Skills and plugins the Claude desktop app supplies from its own data folder: only Claude Code\'s configuration folder and project folders are read.',
  'Hooks that a plugin registers from code (a hooks.json "modules" list): the scan does not run code, so they are not listed.',
];

/** Names of tools that save feedback, corrections or session notes (TOOL_REGISTRY §6). */
export const MEMORY_TOOLS = new Set(['feedback', 'reflect-mod', 'reflect', 'remember', 'wrap-up']);
const baseName = (e: ToolEntry) => (e.kind === 'plugin' && e.name.includes('@') ? e.name.slice(0, e.name.lastIndexOf('@')) : e.name).toLowerCase();

const SEVERITY_ORDER: Record<Severity, number> = { release_blocking: 0, confirmed: 1, potential: 2, informational: 3 };

const where = (e: ToolEntry) => {
  const scope = e.owner ? `plugin ${e.owner}` : e.scope === 'project' || e.scope === 'local' ? `${e.scope} (${e.scopeDetail})` : e.scope;
  return `${scope}: ${e.source}`;
};

/** Copies of one plugin installed in several scopes are the same tool, not a collision. */
const origins = (list: ToolEntry[]) => new Set(list.map((e) => e.owner ?? `${e.scope}|${e.source}`)).size;

function group<T>(items: T[], key: (item: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    map.set(k, [...(map.get(k) ?? []), item]);
  }
  return map;
}

export function detectConflicts(inventory: Inventory): Finding[] {
  const findings: Finding[] = [];
  const add = (f: Omit<Finding, 'id'>) =>
    findings.push({ ...f, id: 'f_' + createHash('sha256').update(`${f.category}|${f.title}|${f.entryIds.join(',')}`).digest('hex').slice(0, 16) });
  const { entries } = inventory;

  // Skills and commands share the slash namespace: two of them on the same "/name" collide.
  for (const [invocation, list] of group(
    entries.filter((e) => e.kind === 'skill' || e.kind === 'command'),
    (e) => e.invocation?.toLowerCase() ?? null,
  )) {
    if (origins(list) < 2) continue;
    const scopes = new Set(list.map((e) => e.scope));
    add({
      severity: 'potential',
      category: 'duplicate_invocation',
      title: `${list.length} tools answer ${invocation}`,
      evidence: list.map((e) => `${e.kind} "${e.name}" in ${where(e)}`),
      inference:
        scopes.size > 1
          ? `Only one of them runs when you type ${invocation}. Claude Code picks by scope, so the others are hidden. This may be intended, for example a project version overriding your personal one.`
          : `Only one of them runs when you type ${invocation}, and which one is not obvious from the files.`,
      recommendation: 'If the override is intended, keep both. Otherwise rename one, or remove the one you no longer use.',
      entryIds: list.map((e) => e.id),
    });
  }

  for (const [name, list] of group(
    entries.filter((e) => e.kind === 'agent'),
    (e) => e.invocation?.toLowerCase() ?? null,
  )) {
    if (origins(list) < 2) continue;
    add({
      severity: 'potential',
      category: 'duplicate_agent',
      title: `${list.length} subagents are named "${name}"`,
      evidence: list.map((e) => `agent in ${where(e)}`),
      inference: 'Claude Code uses one definition by scope; the others are ignored.',
      recommendation: 'Keep the one you want and rename the other if you need both.',
      entryIds: list.map((e) => e.id),
    });
  }

  // A plugin's namespaced command next to a personal one with the same short name: different invocations, informational only.
  const shortName = (e: ToolEntry) => (e.kind === 'skill' || e.kind === 'command' ? e.name.toLowerCase() : null);
  for (const [name, list] of group(entries, shortName)) {
    const plugin = list.filter((e) => e.owner);
    const own = list.filter((e) => !e.owner);
    if (!plugin.length || !own.length) continue;
    add({
      severity: 'informational',
      category: 'similar_name',
      title: `"${name}" exists both on its own and inside a plugin`,
      evidence: list.map((e) => `${e.invocation} (${e.kind}) in ${where(e)}`),
      inference: 'They are called differently, so they do not collide. They may do overlapping jobs.',
      recommendation: 'No action needed. If they do the same job, you could keep just one.',
      entryIds: list.map((e) => e.id),
    });
  }

  // MCP servers: the same name in several scopes, and the same server under several names.
  const servers = entries.filter((e) => e.kind === 'mcp_server');
  for (const [name, list] of group(servers, (e) => e.name)) {
    const distinct = new Set(list.map((e) => `${e.scope}|${e.scopeDetail}|${e.owner}`));
    if (list.length < 2 || distinct.size < 2) continue;
    const same = new Set(list.map((e) => e.details.fingerprint)).size === 1;
    add({
      severity: same ? 'informational' : 'potential',
      category: 'duplicate_mcp_name',
      title: same ? `MCP server "${name}" is defined ${list.length} times with the same settings` : `MCP server "${name}" is defined ${list.length} times with different settings`,
      evidence: list.map((e) => `${where(e)} → ${e.description ?? e.details.transport}`),
      inference: same
        ? 'Claude Code connects once. The extra definitions are redundant.'
        : 'Claude Code uses one definition by scope (local, then project, then user), so the others are ignored. You may be connecting to a different server than you expect.',
      recommendation: same ? 'Optionally remove the redundant definitions.' : 'Decide which definition you want, then remove or rename the others.',
      entryIds: list.map((e) => e.id),
    });
  }
  for (const [fingerprint, list] of group(servers, (e) => (e.details.fingerprint && !e.details.fingerprint.endsWith('||') ? e.details.fingerprint : null))) {
    const names = new Set(list.map((e) => e.name));
    if (names.size < 2) continue;
    add({
      severity: 'potential',
      category: 'duplicate_mcp_server',
      title: `The same MCP server is registered as ${[...names].map((n) => `"${n}"`).join(' and ')}`,
      evidence: list.map((e) => `"${e.name}" in ${where(e)} → ${fingerprint.split('|').filter(Boolean).slice(1).join(' ')}`),
      inference: 'Its tools are likely to appear twice under different prefixes, which wastes context and can confuse tool choice.',
      recommendation: 'Keep one registration and remove the other.',
      entryIds: list.map((e) => e.id),
    });
  }

  // Hooks: identical commands on the same event and matcher run twice.
  const hooks = entries.filter((e) => e.kind === 'hook');
  for (const [key, list] of group(hooks, (e) => `${e.details.event}|${e.details.matcher}|${e.details.command ?? ''}`)) {
    if (origins(list) < 2 || !list[0]!.details.command) continue;
    add({
      severity: 'potential',
      category: 'duplicate_hook',
      title: `The same ${list[0]!.details.event} hook is configured ${list.length} times`,
      evidence: list.map((e) => `${where(e)} → ${e.details.command}`),
      inference: 'Claude Code runs every matching hook, so this command runs more than once per event.',
      recommendation: 'Remove one of the duplicate entries.',
      entryIds: list.map((e) => e.id),
    });
    void key;
  }
  for (const [key, list] of group(hooks, (e) => `${e.details.event}|${e.details.matcher}`)) {
    const sources = new Set(list.map((e) => e.owner ?? e.source));
    const commands = new Set(list.map((e) => e.details.command ?? e.id));
    if (sources.size < 2 || commands.size < 2) continue;
    const [event, matcher] = key.split('|');
    add({
      severity: 'informational',
      category: 'overlapping_hooks',
      title: `${list.length} ${event} hooks from ${sources.size} sources match "${matcher}"`,
      evidence: list.map((e) => `${where(e)} → ${e.description}`),
      inference:
        event === 'PreToolUse' || event === 'UserPromptSubmit' || event === 'Stop'
          ? 'All of them run. Any one of them can block or change the action, so they may interfere.'
          : 'All of them run. This is usually fine.',
      recommendation: 'Check that they do not undo each other. No change is needed if they are independent.',
      entryIds: list.map((e) => e.id),
    });
  }

  // Plugins.
  const plugins = entries.filter((e) => e.kind === 'plugin');
  const installedIds = new Set(plugins.map((e) => e.name));
  const marketplaces = new Set(entries.filter((e) => e.kind === 'marketplace').map((e) => e.name));
  for (const ref of inventory.references.enabledPlugins) {
    if (!ref.enabled || installedIds.has(ref.id)) continue;
    const market = ref.id.includes('@') ? ref.id.slice(ref.id.lastIndexOf('@') + 1) : null;
    if (market && !marketplaces.has(market)) {
      // Not in any known marketplace either: it may come with Claude Code itself (for example "@builtin"), which this scan cannot see.
      add({
        severity: 'potential',
        category: 'plugin_not_installed',
        title: `Plugin ${ref.id} is enabled, but the scan cannot find where it comes from`,
        evidence: [`"${ref.id}": true in ${ref.source}`, `No record for ${ref.id} in installed_plugins.json`, `"${market}" is not in known_marketplaces.json`],
        inference: `Claude Code may provide "${market}" plugins itself, outside the files this scan reads. If it does not, the plugin cannot load.`,
        recommendation: `If Claude Code reports ${ref.id} as missing, reinstall it or remove the entry from ${ref.source}. Otherwise no change is needed.`,
        entryIds: [],
      });
      continue;
    }
    add({
      severity: 'confirmed',
      category: 'plugin_not_installed',
      title: `Plugin ${ref.id} is enabled but not installed`,
      evidence: [`"${ref.id}": true in ${ref.source}`, `No record for ${ref.id} in installed_plugins.json`],
      inference: 'Claude Code cannot load it, so anything that relies on it is unavailable.',
      recommendation: `Reinstall it (claude plugin install "${ref.id}"), or remove the entry from ${ref.source}.`,
      entryIds: [],
    });
  }
  for (const p of plugins) {
    if (!p.details['install path']?.endsWith('(missing)') && p.details['install path'] !== 'unknown') continue;
    add({
      severity: 'confirmed',
      category: 'plugin_files_missing',
      title: `Plugin ${p.name} is recorded as installed but its files are missing`,
      evidence: [`install path: ${p.details['install path']}`, `recorded in ${p.source}`],
      inference: 'Claude Code cannot load its skills, commands, hooks or MCP servers.',
      recommendation: `Reinstall it (claude plugin install "${p.name}") or uninstall it to clean up the record.`,
      entryIds: [p.id],
    });
  }
  for (const [id, list] of group(plugins, (e) => e.name)) {
    const versions = new Set(list.map((e) => e.version ?? 'unknown'));
    if (list.length < 2 || versions.size < 2) continue;
    add({
      severity: 'potential',
      category: 'plugin_version_mismatch',
      title: `Plugin ${id} is installed at ${versions.size} different versions`,
      evidence: list.map((e) => `version ${e.version ?? 'unknown'} at ${e.scope}${e.scopeDetail ? ` (${e.scopeDetail})` : ''}`),
      inference: 'Different projects may behave differently with the same plugin.',
      recommendation: 'Update the older installation so they match, unless a project needs the older version.',
      entryIds: list.map((e) => e.id),
    });
  }
  for (const [name, list] of group(plugins, (e) => (e.name.includes('@') ? e.name.slice(0, e.name.lastIndexOf('@')) : e.name))) {
    const ids = new Set(list.map((e) => e.name));
    if (ids.size < 2) continue;
    add({
      severity: 'potential',
      category: 'plugin_name_clash',
      title: `Two marketplaces provide a plugin called "${name}"`,
      evidence: [...ids].map((id) => `${id} (${list.find((e) => e.name === id)!.status})`),
      inference: `Both use the "${name}:" prefix for their commands and skills, so they can shadow each other when both are enabled.`,
      recommendation: 'Enable only one of them.',
      entryIds: list.map((e) => e.id),
    });
  }

  // Memory and feedback tools (M14, C6): each keeps its own notes or rules, so several of them
  // learn the same thing in different places. Only enabled entries count; disabled ones do nothing.
  const memory = entries.filter((e) => e.status !== 'disabled' && (e.kind === 'skill' || e.kind === 'command' || e.kind === 'plugin') && MEMORY_TOOLS.has(baseName(e)));
  const memoryTools = new Set(memory.map(baseName));
  if (memory.length) {
    add({
      severity: memoryTools.size > 1 ? 'potential' : 'informational',
      category: 'overlapping_memory',
      title: memoryTools.size > 1 ? `${memoryTools.size} tools save feedback or memory: ${[...memoryTools].sort().join(', ')}` : `"${[...memoryTools][0]}" saves feedback or memory on its own`,
      evidence: memory.map((e) => `${e.kind} "${e.name}" in ${where(e)}`),
      inference:
        'Each keeps its own notes or rules, so the same lesson can be saved in several places and drift apart. The app keeps approved preferences and session notes itself (Preferences and the Vault), and does not need these tools.',
      recommendation: 'Choose one place for preferences and notes. If that is the app, disable the others with Resolve; nothing is changed without your approval.',
      entryIds: memory.map((e) => e.id),
    });
  }

  // Files Claude Code is likely to reject.
  for (const issue of inventory.issues) {
    if (!/Invalid JSON|Not a JSON object/.test(issue.problem)) continue;
    add({
      severity: 'confirmed',
      category: 'invalid_config',
      title: `Configuration file cannot be parsed`,
      evidence: [`${issue.path}: ${issue.problem}`],
      inference: 'Settings, hooks or servers defined in this file are probably not in effect.',
      recommendation: 'Fix the file (for example a missing comma or bracket). The app will not edit it.',
      entryIds: [],
    });
  }

  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.title.localeCompare(b.title));
}
