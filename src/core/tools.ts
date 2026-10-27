// A complete tool scan: inventory plus conflict findings (FR-TOOL-001/002).
// Read-only: produces a report and changes nothing in Claude Code's setup.

import { detectConflicts, NOT_CHECKED, type Finding, type Severity } from './conflicts.ts';
import { scanInventory, type ScanIssue, type ScanRoots, type ToolEntry, type ToolKind } from './inventory.ts';

export interface ToolScanSummary {
  entries: Partial<Record<ToolKind, number>>;
  findings: Partial<Record<Severity, number>>;
  issues: number;
}

export interface ToolScan {
  id: string;
  scannedAt: string;
  roots: ScanRoots;
  entries: ToolEntry[];
  issues: ScanIssue[];
  findings: Finding[];
  notChecked: string[];
  summary: ToolScanSummary;
}

const count = <T extends string>(items: T[]) =>
  items.reduce<Partial<Record<T, number>>>((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {});

export function runToolScan(roots: ScanRoots): Omit<ToolScan, 'id' | 'scannedAt'> {
  const inventory = scanInventory(roots);
  const findings = detectConflicts(inventory);
  return {
    roots: inventory.roots,
    entries: inventory.entries,
    issues: inventory.issues,
    findings,
    notChecked: NOT_CHECKED,
    summary: {
      entries: count(inventory.entries.map((e) => e.kind)),
      findings: count(findings.map((f) => f.severity)),
      issues: inventory.issues.length,
    },
  };
}
