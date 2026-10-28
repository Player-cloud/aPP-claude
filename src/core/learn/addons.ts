// Reviews of the optional add-ons (M14: Phase 12, TOOL-DEV-001..006 and
// TOOL-LEARN-001/002/003/008/009/010, DEC-031).
//
// Each add-on is reviewed on its own for source, permissions, compatibility,
// cost and benefit, then included, excluded or deferred. "Include" is only
// possible for an add-on the latest tool scan found, once all five are
// reviewed. A decision is a record: the app never installs, enables, disables
// or removes an add-on, and no app workflow calls one, so the product works
// the same with every add-on off.

import { ValidationError } from '../errors.ts';
import type { ToolEntry } from '../inventory.ts';
import type { Workspace } from '../workspace.ts';

export const CRITERIA = ['source', 'permissions', 'compatibility', 'cost', 'benefit'] as const;
export type Criterion = (typeof CRITERIA)[number];
export const DECISIONS = ['include', 'exclude', 'defer'] as const;
export type AddonDecision = (typeof DECISIONS)[number];

export interface CriterionReview {
  status: 'ok' | 'concern' | 'unknown';
  note: string;
}

export interface Addon {
  key: string;
  /** The tool registry ID. */
  toolId: string;
  label: string;
  /** Names it can have in a tool scan, lowercase. */
  names: string[];
  purpose: string;
  /** What the registry says to look at before using it. */
  lookAt: string;
  /** The app's own feature that covers the same need, if any. */
  coveredBy: string | null;
}

export const ADDONS: Addon[] = [
  { key: 'wrap-up', toolId: 'TOOL-LEARN-010', label: 'wrap-up', names: ['wrap-up', 'wrapup'], purpose: 'Summarise a session and offer to save the summary.', lookAt: 'The summary should separate decisions, assumptions, blockers and next steps.', coveredBy: 'Preferences → Wrap-up builds the summary from the app’s records and saves it to the Vault only when you ask.' },
  { key: 'token-weather', toolId: 'TOOL-DEV-001', label: 'token-weather', names: ['token-weather'], purpose: 'Show context and token use.', lookAt: 'Which metrics it shows exactly, and whether it collects or sends any data.', coveredBy: null },
  { key: 'cache-tax', toolId: 'TOOL-DEV-002', label: 'cache-tax / keepwarm', names: ['cache-tax', 'keepwarm'], purpose: 'Warn about cold prompt-cache cost, and optionally keep the cache warm.', lookAt: 'Keeping the cache warm makes model requests and can raise cost; measure it before turning it on.', coveredBy: null },
  { key: 'you-should-know', toolId: 'TOOL-DEV-003', label: 'you-should-know', names: ['you-should-know'], purpose: 'A side agent that points out useful things during long tasks.', lookAt: 'Background work and its cost need a limit; avoid a second reviewer doing the same job.', coveredBy: null },
  { key: 'replay-theater', toolId: 'TOOL-DEV-004', label: 'replay-theater / replay', names: ['replay-theater', 'replay'], purpose: 'Step through the edits of an earlier turn.', lookAt: 'It adds to Git history; it does not replace it.', coveredBy: null },
  { key: 'filetree', toolId: 'TOOL-DEV-005', label: 'filetree', names: ['filetree'], purpose: 'Show the files Claude reads and edits.', lookAt: 'What file-system access it needs and what it can see.', coveredBy: null },
  { key: 'savvy-progress', toolId: 'TOOL-DEV-006', label: 'savvy-progress', names: ['savvy-progress'], purpose: 'Progress display for /savvy-flow.', lookAt: 'It depends on /savvy-flow, which the planning notes say is not installed; defer until that workflow is decided.', coveredBy: null },
  { key: 'reflect-mod', toolId: 'TOOL-LEARN-009', label: 'reflect-mod', names: ['reflect-mod', 'reflect'], purpose: 'Turn corrections into reusable global rules.', lookAt: 'It may duplicate feedback; a global rule should need approval.', coveredBy: 'Preferences: feedback about the work becomes a proposed preference that is used only after you approve it.' },
  { key: 'feedback', toolId: 'TOOL-LEARN-001', label: 'feedback', names: ['feedback'], purpose: 'Propose taste notes and save them only after approval.', lookAt: 'Global preferences must stay apart from one project’s decisions.', coveredBy: 'Preferences, with the "All work" or "One project" choice and a duplicate and conflict check.' },
  { key: 'remember', toolId: 'TOOL-LEARN-008', label: 'remember', names: ['remember'], purpose: 'Keep session notes or memory.', lookAt: 'How it overlaps the Vault and the wrap-up.', coveredBy: 'The Vault keeps notes and saved wrap-ups; a note is never a rule.' },
  { key: 'learn-from-video', toolId: 'TOOL-LEARN-002', label: 'learn-from-video', names: ['learn-from-video'], purpose: 'Cited lessons from videos, transcripts or PDFs.', lookAt: 'What the source says must stay apart from what is recommended.', coveredBy: 'Preferences → Lessons: cited lessons from transcripts and PDFs, with suggestions kept apart.' },
  { key: 'learner', toolId: 'TOOL-LEARN-003', label: 'learner / learn-skills', names: ['learner', 'learn-skills'], purpose: 'Spot repeated work and propose reusable skills.', lookAt: 'Existing skills must be checked to avoid duplicates.', coveredBy: 'Preferences → Skills: proposals from repeated work, checked against the tool scan, exported only as a file.' },
];

/** What the scan shows about an entry, kept with the review as evidence. */
export interface ScanFact {
  entryId: string;
  name: string;
  kind: ToolEntry['kind'];
  scope: ToolEntry['scope'];
  status: ToolEntry['status'];
  source: string;
  owner: string | null;
  version: string | null;
  provenance: ToolEntry['provenance'];
}

export interface AddonReview {
  id: string;
  /** Shown as REV-<number>. */
  number: number;
  addonKey: string;
  criteria: Record<Criterion, CriterionReview>;
  decision: AddonDecision;
  reason: string;
  scanId: string | null;
  found: ScanFact[];
  reviewer: string;
  createdAt: string;
}

export interface AddonStatus {
  addon: Addon;
  /** Entries of the latest scan that match it. */
  found: ScanFact[];
  /** The latest decision, if any; earlier ones stay in `history`. */
  review: AddonReview | null;
  history: AddonReview[];
}

export interface AddonsOverview {
  scanId: string | null;
  scannedAt: string | null;
  addons: AddonStatus[];
  /** The app never loads, calls or changes an add-on. */
  independent: true;
}

export class Addons {
  private readonly ws: Workspace;

  constructor(ws: Workspace) {
    this.ws = ws;
  }

  overview(): AddonsOverview {
    const scan = this.ws.latestToolScan();
    const reviews = this.ws.listAddonReviews();
    return {
      scanId: scan?.id ?? null,
      scannedAt: scan?.scannedAt ?? null,
      addons: ADDONS.map((addon) => {
        const history = reviews.filter((r) => r.addonKey === addon.key);
        return { addon, found: matches(addon, scan?.entries ?? []), review: history[0] ?? null, history };
      }),
      independent: true,
    };
  }

  /**
   * Records a review and its decision. It changes nothing in Claude Code:
   * "include" means the person reviewed it and may keep using it alongside the app.
   */
  review(key: unknown, input: { criteria?: unknown; decision?: unknown; reason?: unknown }): AddonReview {
    const addon = ADDONS.find((a) => a.key === key);
    if (!addon) throw new ValidationError(`Unknown add-on. Choose one of: ${ADDONS.map((a) => a.key).join(', ')}.`);
    if (!(DECISIONS as readonly unknown[]).includes(input.decision)) throw new ValidationError('Choose include, exclude or defer.');
    const decision = input.decision as AddonDecision;
    const raw = input.criteria && typeof input.criteria === 'object' ? (input.criteria as Record<string, unknown>) : {};
    const criteria = Object.fromEntries(CRITERIA.map((c) => [c, criterion(raw[c], c)])) as Record<Criterion, CriterionReview>;
    if (typeof input.reason !== 'string' || !input.reason.trim()) throw new ValidationError('Say why, in a sentence.');
    const reason = input.reason.replace(/\s+/g, ' ').trim();
    if (reason.length > 600) throw new ValidationError('The reason is longer than 600 characters.');
    const scan = this.ws.latestToolScan();
    const found = matches(addon, scan?.entries ?? []);
    if (decision === 'include') {
      if (!scan) throw new ValidationError('Scan your tools first: an add-on can be included only when the scan finds it.');
      if (!found.length) throw new ValidationError(`The latest tool scan did not find ${addon.label}, so it cannot be included. Exclude or defer it, or scan again after installing it yourself.`);
      const open = CRITERIA.filter((c) => criteria[c].status === 'unknown' || !criteria[c].note);
      if (open.length) throw new ValidationError(`Review ${open.join(', ')} first: an add-on is included only after source, permissions, compatibility, cost and benefit have each been reviewed.`);
    }
    return this.ws.createAddonReview({ addonKey: addon.key, criteria, decision, reason, scanId: scan?.id ?? null, found });
  }
}

function matches(addon: Addon, entries: ToolEntry[]): ScanFact[] {
  return entries
    .filter((e) => {
      // A plugin is named "name@marketplace"; a plugin's skill or command "plugin:name".
      const name = e.name.toLowerCase().replace(/^\//, '');
      const short = (e.kind === 'plugin' ? name.split('@')[0] : name.split(/[:/]/).pop()) ?? name;
      return addon.names.includes(short);
    })
    .map((e) => ({ entryId: e.id, name: e.name, kind: e.kind, scope: e.scope, status: e.status, source: e.source, owner: e.owner, version: e.version, provenance: e.provenance }));
}

function criterion(v: unknown, name: Criterion): CriterionReview {
  if (v === undefined || v === null) return { status: 'unknown', note: '' };
  if (typeof v !== 'object') throw new ValidationError(`The ${name} review must have a status and a note.`);
  const r = v as Record<string, unknown>;
  const status = r.status ?? 'unknown';
  if (status !== 'ok' && status !== 'concern' && status !== 'unknown') throw new ValidationError(`The ${name} status must be ok, concern or unknown.`);
  const note = typeof r.note === 'string' ? r.note.replace(/\s+/g, ' ').trim() : '';
  if (note.length > 600) throw new ValidationError(`The ${name} note is longer than 600 characters.`);
  if (status !== 'unknown' && !note) throw new ValidationError(`Write what you found for ${name}.`);
  return { status, note };
}
