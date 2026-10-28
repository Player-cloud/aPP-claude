// Approved preferences (M14: FR-LEARN-001, TOOL-LEARN-004, DEC-030).
//
//   feedback, a wrap-up line or the person's own words → proposed wording →
//   the person edits and approves it → active (used as guidance) → edited or
//   removed by the person
//
// Nothing becomes a preference without the person's approval, and the app
// never combines two preferences by itself: a likely duplicate or conflict
// with an active preference is shown, and the person decides to keep both or
// to let the new one replace the old one. A preference is guidance for the
// work; it never changes approval rules, permissions, checks or gates.
// Preferences are never deleted: removing one keeps it in the history.

import { ValidationError } from '../errors.ts';
import type { Workspace } from '../workspace.ts';

export const PREFERENCE_SCOPES = ['global', 'project'] as const;
export type PreferenceScope = (typeof PREFERENCE_SCOPES)[number];
export type PreferenceStatus = 'proposed' | 'active' | 'rejected' | 'removed';

export interface PreferenceSource {
  /** person = typed as a preference; feedback = typed as feedback about the work; wrap_up = a line of a session summary. */
  type: 'person' | 'feedback' | 'wrap_up';
  summary: string;
  /** The record it came from, such as a Vault note. */
  ref: string | null;
  /** The words it was proposed from, unchanged. */
  quote: string | null;
}

export interface PreferenceMatch {
  id: string;
  number: number;
  text: string;
  scope: PreferenceScope;
  projectId: string | null;
  kind: 'duplicate' | 'conflict';
  /** Shared meaningful words, 0 to 1. */
  similarity: number;
  why: string;
}

/** What the person decided about a match when approving: keep both, or retire the old one. */
export interface Resolution {
  id: string;
  kind: PreferenceMatch['kind'];
  action: 'keep_both' | 'replace';
}

export interface Preference {
  id: string;
  /** Shown as PREF-<number>. */
  number: number;
  scope: PreferenceScope;
  projectId: string | null;
  text: string;
  /** The wording the app proposed, kept to show what the person changed. */
  proposedText: string;
  status: PreferenceStatus;
  source: PreferenceSource;
  resolutions: Resolution[];
  approver: string | null;
  approvedAt: string | null;
  /** Why it was rejected or removed. */
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PreferenceDetail {
  preference: Preference;
  /** Active preferences it may duplicate or contradict. */
  matches: PreferenceMatch[];
  projectName: string | null;
}

export interface ProposeInput {
  text: unknown;
  scope?: unknown;
  projectId?: unknown;
  source?: PreferenceSource;
}

const MAX_TEXT = 500;
const DUPLICATE_AT = 0.6;
const CONFLICT_AT = 0.4;

export class Preferences {
  private readonly ws: Workspace;

  constructor(ws: Workspace) {
    this.ws = ws;
  }

  list(filter: { status?: string; projectId?: string | null } = {}): Preference[] {
    if (filter.status !== undefined && !['proposed', 'active', 'rejected', 'removed'].includes(filter.status)) throw new ValidationError('Unknown status.');
    return this.ws.listPreferences(filter);
  }

  detail(id: string): PreferenceDetail {
    const p = this.resolve(id);
    return {
      preference: p,
      matches: p.status === 'proposed' || p.status === 'active' ? this.matches(p.text, p.scope, p.projectId, p.id) : [],
      projectName: p.projectId ? this.ws.getProject(p.projectId).name : null,
    };
  }

  /** Accepts an id or PREF-<number>. */
  resolve(ref: string): Preference {
    const m = /^PREF-(\d+)$/i.exec(ref.trim());
    if (m) {
      const p = this.ws.listPreferences({}).find((x) => x.number === Number(m[1]));
      if (!p) throw new ValidationError(`There is no ${ref.toUpperCase()}.`);
      return p;
    }
    return this.ws.getPreference(ref);
  }

  /** Records a proposal. The wording is a draft for the person to change; nothing is used until it is approved. */
  propose(input: ProposeInput): Preference {
    const raw = text(input.text, 'Preference', 4_000);
    const { scope, projectId } = this.scope(input.scope, input.projectId);
    const proposed = proposeWording(raw);
    if (!proposed) throw new ValidationError('Write what you would like, in a few words.');
    const source: PreferenceSource = input.source ?? { type: 'person', summary: `Typed by ${this.ws.actorName()}`, ref: null, quote: null };
    return this.ws.createPreference({ scope, projectId, text: proposed, proposedText: proposed, source: { ...source, quote: source.quote ?? (raw === proposed ? null : raw) } });
  }

  /** Changes the wording or scope. An active preference is checked again, like an approval. */
  edit(id: string, input: { text?: unknown; scope?: unknown; projectId?: unknown; resolutions?: unknown }): Preference {
    const p = this.resolve(id);
    if (p.status !== 'proposed' && p.status !== 'active') throw new ValidationError(`PREF-${p.number} was ${p.status} and can no longer change.`);
    const next = input.text === undefined ? p.text : wording(text(input.text, 'Preference', MAX_TEXT));
    const scopeArg = input.scope ?? p.scope;
    const { scope, projectId } = this.scope(scopeArg, input.projectId !== undefined ? input.projectId : scopeArg === 'project' ? p.projectId : null);
    if (next === p.text && scope === p.scope && projectId === p.projectId) return p;
    if (p.status === 'proposed') {
      return this.ws.updatePreference(p.id, { text: next, scope, projectId }, { type: 'preference.edited', payload: { before: p.text, after: next, scope } });
    }
    const resolutions = this.settle(this.matches(next, scope, projectId, p.id), input.resolutions);
    return this.ws.inTransaction(() => {
      this.retire(resolutions, p.number);
      return this.ws.updatePreference(p.id, { text: next, scope, projectId, resolutions: [...p.resolutions, ...resolutions] }, { type: 'preference.edited', payload: { before: p.text, after: next, scope, resolutions } });
    });
  }

  /**
   * Makes a proposal active. Each likely duplicate or conflict needs the
   * person's decision; without one, nothing changes and the matches are named.
   */
  approve(id: string, rawResolutions?: unknown): Preference {
    const p = this.resolve(id);
    if (p.status !== 'proposed') throw new ValidationError(`PREF-${p.number} is ${p.status}; only a proposal can be approved.`);
    const resolutions = this.settle(this.matches(p.text, p.scope, p.projectId, p.id), rawResolutions);
    return this.ws.inTransaction(() => {
      this.retire(resolutions, p.number);
      return this.ws.updatePreference(
        p.id,
        { status: 'active', resolutions, approver: this.ws.actorName(), approvedAt: this.ws.nowIso() },
        { type: 'preference.approved', payload: { number: p.number, scope: p.scope, edited: p.text !== p.proposedText, resolutions } },
      );
    });
  }

  reject(id: string, reason: unknown): Preference {
    const p = this.resolve(id);
    if (p.status !== 'proposed') throw new ValidationError(`PREF-${p.number} is ${p.status}; only a proposal can be rejected.`);
    const why = text(reason ?? 'Not wanted', 'Reason', 500);
    return this.ws.updatePreference(p.id, { status: 'rejected', reason: why }, { type: 'preference.rejected', payload: { number: p.number, reason: why } });
  }

  /** Stops using an active preference. It stays in the history. */
  remove(id: string, reason: unknown): Preference {
    const p = this.resolve(id);
    if (p.status !== 'active') throw new ValidationError(`PREF-${p.number} is ${p.status}; only an active preference can be removed.`);
    const why = text(reason ?? 'Removed by the person', 'Reason', 500);
    return this.ws.updatePreference(p.id, { status: 'removed', reason: why }, { type: 'preference.removed', payload: { number: p.number, reason: why } });
  }

  /** The active preferences that apply to work in a project: global ones and the project's own. */
  forWork(projectId: string | null): Preference[] {
    return this.ws.listPreferences({ status: 'active' }).filter((p) => p.scope === 'global' || p.projectId === projectId);
  }

  /** Active preferences the text may duplicate or contradict, in scopes that overlap. */
  matches(candidate: string, scope: PreferenceScope, projectId: string | null, exceptId: string | null = null): PreferenceMatch[] {
    const a = analyse(candidate);
    const out: PreferenceMatch[] = [];
    for (const p of this.ws.listPreferences({ status: 'active' })) {
      if (p.id === exceptId) continue;
      // A project preference only meets global ones and those of the same project.
      if (scope === 'project' && p.scope === 'project' && p.projectId !== projectId) continue;
      const b = analyse(p.text);
      const similarity = a.normal === b.normal ? 1 : jaccard(a.words, b.words);
      const opposite = a.negative !== b.negative;
      const base = { id: p.id, number: p.number, text: p.text, scope: p.scope, projectId: p.projectId, similarity: Math.round(similarity * 100) / 100 };
      if (!opposite && similarity >= DUPLICATE_AT) out.push({ ...base, kind: 'duplicate', why: similarity === 1 ? 'Says the same thing.' : 'Uses mostly the same words.' });
      else if (opposite && similarity >= CONFLICT_AT) out.push({ ...base, kind: 'conflict', why: 'Uses the same words, but one says to do it and the other says not to.' });
    }
    return out.sort((x, y) => y.similarity - x.similarity);
  }

  private scope(rawScope: unknown, rawProject: unknown): { scope: PreferenceScope; projectId: string | null } {
    const scope = rawScope ?? (rawProject ? 'project' : 'global');
    if (!(PREFERENCE_SCOPES as readonly unknown[]).includes(scope)) throw new ValidationError('Scope must be global or project.');
    if (scope === 'global') {
      if (rawProject) throw new ValidationError('A global preference is not tied to a project.');
      return { scope, projectId: null };
    }
    if (typeof rawProject !== 'string' || !rawProject) throw new ValidationError('Choose the project this preference is for.');
    const project = this.ws.getProject(rawProject);
    return { scope: 'project', projectId: project.id };
  }

  /** Every match needs a decision; decisions for anything else are refused. */
  private settle(matches: PreferenceMatch[], raw: unknown): Resolution[] {
    const given = raw === undefined || raw === null ? [] : raw;
    if (!Array.isArray(given) || given.length > 50) throw new ValidationError('Resolutions must be a list.');
    const decided = new Map<string, Resolution['action']>();
    for (const r of given) {
      const o = r as Record<string, unknown>;
      if (!o || typeof o.id !== 'string' || (o.action !== 'keep_both' && o.action !== 'replace')) throw new ValidationError('Each resolution needs an id and keep_both or replace.');
      decided.set(o.id, o.action);
    }
    for (const id of decided.keys()) if (!matches.some((m) => m.id === id)) throw new ValidationError('A resolution names a preference that does not match this one.');
    const open = matches.filter((m) => !decided.has(m.id));
    if (open.length) {
      throw new ValidationError(
        `Decide first: ${open.map((m) => `PREF-${m.number} ${m.kind === 'conflict' ? 'may contradict' : 'may duplicate'} this ("${m.text.slice(0, 80)}")`).join('; ')}. Keep both, or let this one replace it.`,
      );
    }
    return matches.map((m) => ({ id: m.id, kind: m.kind, action: decided.get(m.id)! }));
  }

  private retire(resolutions: Resolution[], number: number): void {
    for (const r of resolutions) {
      if (r.action !== 'replace') continue;
      const old = this.ws.getPreference(r.id);
      if (old.status === 'active') this.ws.updatePreference(old.id, { status: 'removed', reason: `Replaced by PREF-${number}` }, { type: 'preference.removed', payload: { number: old.number, replacedBy: number } });
    }
  }
}

const POLITE = /^(?:please|pls|kindly|can you|could you|would you|i(?:'d| would) like (?:you )?to|i want (?:you )?to|i prefer (?:that )?(?:you )?|from now on,?|in (?:the )?future,?|next time,?|going forward,?|remember (?:that|to)?)\s+/i;

/** A first draft of the wording: the person's words without the request phrasing, as one sentence. */
export function proposeWording(raw: string): string {
  let t = raw.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4 && POLITE.test(t); i++) t = t.replace(POLITE, '');
  t = t.replace(/[\s,;:]+$/, '');
  if (!t) return '';
  return wording(t.length > MAX_TEXT - 1 ? `${t.slice(0, MAX_TEXT - 2).trimEnd()}…` : t);
}

function wording(t: string): string {
  const s = t.replace(/\s+/g, ' ').trim();
  const cap = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?…]["')\]]*$/.test(cap) ? cap : `${cap}.`;
}

const STOP = new Set(
  'the a an and or but if then than that this these those to of in on at for with by from as is are be been being it its into over under about up out so very just also always use using when while where which who what how all any each every some more most other such only own same can will should would could may might must do does did have has had i me my we our you your they them their he she his her one'.split(' '),
);
const NEGATIVE = /\b(?:never|don'?t|do not|does not|doesn'?t|avoid|no|not|stop|without|nothing|none|neither|nor)\b/;

function analyse(t: string): { normal: string; words: Set<string>; negative: boolean } {
  const lower = t.toLowerCase().replace(/[’']/g, "'");
  const tokens = lower.match(/[a-z0-9][a-z0-9'-]*/g) ?? [];
  const words = new Set(tokens.filter((w) => !STOP.has(w) && !NEGATIVE.test(w) && w.length > 2).map(stem));
  return { normal: tokens.join(' '), words, negative: NEGATIVE.test(lower) };
}

function stem(w: string): string {
  for (const suffix of ['ing', 'ed', 'es', 's']) if (w.length > suffix.length + 3 && w.endsWith(suffix)) return w.slice(0, -suffix.length);
  return w;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both);
}

function text(v: unknown, label: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new ValidationError(`${label} is required.`);
  const t = v.trim();
  if (t.length > max) throw new ValidationError(`${label} is longer than ${max} characters.`);
  return t;
}
