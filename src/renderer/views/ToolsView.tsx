// Tool inventory and conflict report (M4: FR-TOOL-001/002). Scanning is
// read-only. Resolving a tool (M11) starts with a dry run; nothing changes until
// the person approves the exact change in a native dialog.
import { useState } from 'react';
import type { Finding, Severity, ToolEntry, ToolKind, ToolScan } from '../../shared/api.ts';
import { Icon } from '../icons.tsx';
import { Alert, Badge, Empty, formatTime } from '../ui.tsx';
import { CleanupHistory, CleanupPanel } from './CleanupPanel.tsx';

export type ToolFilter = 'all' | 'findings' | ToolKind;

export const KIND_LABEL: Record<ToolKind, string> = {
  plugin: 'Plugins',
  marketplace: 'Marketplaces',
  skill: 'Skills',
  command: 'Commands',
  agent: 'Subagents',
  hook: 'Hooks',
  mcp_server: 'MCP servers',
};

const KIND_SINGULAR: Record<ToolKind, string> = {
  plugin: 'Plugin',
  marketplace: 'Marketplace',
  skill: 'Skill',
  command: 'Command',
  agent: 'Subagent',
  hook: 'Hook',
  mcp_server: 'MCP server',
};

const SEVERITY: Record<Severity, { label: string; tone: 'danger' | 'warn' | 'info' }> = {
  release_blocking: { label: 'Release-blocking', tone: 'danger' },
  confirmed: { label: 'Confirmed conflict', tone: 'danger' },
  potential: { label: 'Potential conflict', tone: 'warn' },
  informational: { label: 'Overlap', tone: 'info' },
};

const SCOPE_LABEL: Record<ToolEntry['scope'], string> = {
  managed: 'Organisation',
  user: 'Personal',
  project: 'Project',
  local: 'Project (local)',
  plugin: 'Plugin',
  unknown: 'Unknown',
};

function FindingItem({ finding, entries, onResolve }: { finding: Finding; entries: ToolEntry[]; onResolve: (e: ToolEntry, f: Finding) => void }) {
  const s = SEVERITY[finding.severity];
  return (
    <details className="finding" open={finding.severity !== 'informational'}>
      <summary>
        <Badge tone={s.tone}>{s.label}</Badge>
        <span className="finding-title">{finding.title}</span>
      </summary>
      <div className="finding-body">
        <h4>Evidence</h4>
        <ul className="evidence">
          {finding.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
        {finding.inference && (
          <>
            <h4>What it probably means</h4>
            <p>{finding.inference}</p>
          </>
        )}
        <h4>Suggested</h4>
        <p>{finding.recommendation}</p>
        <h4>Resolve</h4>
        <div className="btn-row">
          {finding.entryIds
            .map((id) => entries.find((e) => e.id === id))
            .filter((e): e is ToolEntry => !!e)
            .map((e) => (
              <button key={e.id} type="button" className="btn" onClick={() => onResolve(e, finding)}>
                {e.invocation ?? e.name} · {SCOPE_LABEL[e.scope]}
                {e.owner ? ` (${e.owner})` : ''}
              </button>
            ))}
        </div>
      </div>
    </details>
  );
}

function EntryRow({ entry, onResolve }: { entry: ToolEntry; onResolve: (e: ToolEntry) => void }) {
  return (
    <tr>
      <td>
        <details className="entry">
          <summary>
            <span className="entry-name">{entry.invocation ?? entry.name}</span>
            {entry.description && <span className="subtle entry-desc">{entry.description}</span>}
          </summary>
          <dl className="kv">
            {entry.invocation && entry.invocation !== entry.name && (
              <>
                <dt>Name</dt>
                <dd>{entry.name}</dd>
              </>
            )}
            {Object.entries(entry.details)
              .filter(([k]) => k !== 'fingerprint')
              .map(([k, v]) => (
                <div key={k} className="kv-row">
                  <dt>{k[0]!.toUpperCase() + k.slice(1)}</dt>
                  <dd className={k === 'command' || k.includes('path') ? 'mono' : undefined}>{v}</dd>
                </div>
              ))}
            <dt>File</dt>
            <dd className="mono">{entry.source}</dd>
            <dt>Removal</dt>
            <dd>{entry.removal.instructions}</dd>
          </dl>
          <button type="button" className="btn" onClick={() => onResolve(entry)}>
            Resolve or remove…
          </button>
        </details>
      </td>
      <td>{KIND_SINGULAR[entry.kind]}</td>
      <td>
        {SCOPE_LABEL[entry.scope]}
        {entry.owner && <div className="subtle">{entry.owner}</div>}
        {!entry.owner && entry.scopeDetail && (entry.scope === 'project' || entry.scope === 'local') && <div className="subtle mono">{entry.scopeDetail}</div>}
      </td>
      <td className={entry.version ? undefined : 'subtle'}>{entry.version ?? 'Unknown'}</td>
      <td>
        <Badge tone={entry.status === 'enabled' ? 'ok' : 'neutral'}>{entry.status === 'enabled' ? 'Enabled' : entry.status === 'disabled' ? 'Disabled' : 'Unknown'}</Badge>
      </td>
    </tr>
  );
}

export function ToolsView({
  scan,
  error,
  filter,
  onScan,
  onRefresh,
}: {
  scan: ToolScan | null | undefined;
  error: string | null;
  filter: ToolFilter;
  onScan: () => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [scanning, setScanning] = useState(false);
  const [resolving, setResolving] = useState<{ entry: ToolEntry; finding: Finding | null } | null>(null);
  const [changes, setChanges] = useState(0);
  const changed = () => {
    setChanges((n) => n + 1);
    void onRefresh();
  };
  const run = async () => {
    setScanning(true);
    try {
      await onScan();
    } finally {
      setScanning(false);
    }
  };

  const scanButton = (
    <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={scanning}>
      <Icon name="search" size={16} /> {scanning ? 'Scanning…' : scan ? 'Scan again' : 'Scan now'}
    </button>
  );

  const attention = scan ? scan.findings.filter((f) => f.severity !== 'informational').length : 0;
  const n = (k: ToolKind) => scan?.summary.entries[k] ?? 0;
  const entries = scan && filter !== 'findings' ? scan.entries.filter((e) => filter === 'all' || e.kind === filter) : [];

  return (
    <>
      <p className="eyebrow">Iterative Layer</p>
      <div className="page-head">
        <div>
          <h1 className="page-title">Tools</h1>
          <p className="page-lede">
            An inventory of your Claude Code setup: plugins, skills, commands, subagents, hooks and MCP servers. Scanning only reads files. To resolve a
            conflict, the app shows a dry run first and changes nothing until you approve the exact change.
          </p>
        </div>
        {scan && scanButton}
      </div>

      {error && <Alert tone="danger" title="The scan failed">{error}</Alert>}
      {scan === undefined && !error && <p className="loading">Loading the last scan…</p>}
      {scan === null && (
        <div className="card">
          <Empty title="No scan yet" action={scanButton}>
            The scan reads your Claude Code configuration folder, your global config file and the project folders Claude Code has recorded. Secrets in
            those files are never shown or stored.
          </Empty>
        </div>
      )}

      {scan && (
        <>
          <p className="subtle scan-meta">
            Last scan {formatTime(scan.scannedAt)} · {scan.roots.projectDirs.length} project folder{scan.roots.projectDirs.length === 1 ? '' : 's'} included
          </p>
          <ul className="stat-row" aria-label="Summary">
            <li className="stat" data-tone={attention ? 'warn' : 'ok'}>
              <span className="stat-value">{attention}</span>
              <span className="stat-label">Need a look</span>
            </li>
            <li className="stat">
              <span className="stat-value">{n('plugin')}</span>
              <span className="stat-label">Plugins</span>
            </li>
            <li className="stat">
              <span className="stat-value">{n('skill') + n('command')}</span>
              <span className="stat-label">Skills & commands</span>
            </li>
            <li className="stat">
              <span className="stat-value">{n('mcp_server')}</span>
              <span className="stat-label">MCP servers</span>
            </li>
            <li className="stat">
              <span className="stat-value">{n('hook')}</span>
              <span className="stat-label">Hooks</span>
            </li>
          </ul>

          {resolving && (
            <CleanupPanel key={`${resolving.entry.id}:${resolving.finding?.id ?? ''}`} entry={resolving.entry} finding={resolving.finding} onDone={changed} onClose={() => setResolving(null)} />
          )}

          {(filter === 'all' || filter === 'findings') && (
            <section className="card" aria-labelledby="findings-title">
              <h2 className="card-title" id="findings-title">
                Findings <span className="count-pill">{scan.findings.length}</span>
              </h2>
              {scan.findings.length === 0 ? (
                <p className="muted">No conflicts or overlaps found.</p>
              ) : (
                <div className="findings">
                  {scan.findings.map((f) => (
                    <FindingItem key={f.id} finding={f} entries={scan.entries} onResolve={(entry, finding) => setResolving({ entry, finding })} />
                  ))}
                </div>
              )}
              <h3 className="subhead">Not checked</h3>
              <ul className="muted small-list">
                {scan.notChecked.map((t) => (
                  <li key={t}>{t}</li>
                ))}
                {scan.issues
                  .filter((i) => !/Invalid JSON|Not a JSON object/.test(i.problem))
                  .map((i) => (
                    <li key={i.path + i.problem}>
                      <span className="mono">{i.path}</span>: {i.problem}
                    </li>
                  ))}
              </ul>
            </section>
          )}

          {filter !== 'findings' && (
            <section className="card" aria-labelledby="inventory-title">
              <h2 className="card-title" id="inventory-title">
                {filter === 'all' ? 'Inventory' : KIND_LABEL[filter]} <span className="count-pill">{entries.length}</span>
              </h2>
              {entries.length === 0 ? (
                <p className="muted">Nothing of this kind was found.</p>
              ) : (
                <div className="table-wrap">
                  <table className="table" aria-label="Inventory">
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Kind</th>
                        <th scope="col">Scope</th>
                        <th scope="col">Version</th>
                        <th scope="col">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((e) => (
                        <EntryRow key={e.id} entry={e} onResolve={(entry) => setResolving({ entry, finding: null })} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="subtle">Status and version say "Unknown" when the files do not record them. Nothing is guessed.</p>
            </section>
          )}
          <CleanupHistory refreshKey={`${changes}`} onChanged={changed} />
        </>
      )}
    </>
  );
}
