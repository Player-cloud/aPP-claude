// Lessons from sources the person imports (M14: FR-LEARN-002, TOOL-LEARN-002, DEC-031).
//
//   transcript, notes or PDF (picked by the person) → copy in the app's data
//   folder → lessons the source supports, each cited to its passages, times or
//   pages → suggestions, kept apart as the model's own recommendations → the
//   person turns a suggestion into a proposed preference or an improvement idea,
//   dismisses it, or saves the lessons to the Vault inbox
//
// Reading a source changes nothing else: no preference, idea or note exists
// until the person asks for it, and a proposed preference still needs approval.

import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import { ModelCallError, ValidationError } from '../errors.ts';
import { guardedCall } from '../agents/guard.ts';
import type { CitedText, ModelAdapter, SourceDocument } from '../agents/model.ts';
import { Backlog, type Improvement } from '../iterate/backlog.ts';
import { redactString } from '../redact.ts';
import type { Workspace } from '../workspace.ts';
import { Preferences, type Preference } from './preferences.ts';
import { formatTime, readSource, segmentLine, type Segment, type SourceKind } from './sources.ts';
import type { VaultNote } from './vault.ts';

export type { Segment, SourceKind } from './sources.ts';

export interface LessonCitation {
  kind: 'page' | 'passage';
  /** Pages are 1-based, passages 0-based; `end` is exclusive. */
  start: number;
  end: number;
  /** The cited words. For passages they come from the app's own copy of the source. */
  quote: string;
  /** For a timed passage: where it starts and ends, in seconds. */
  from: number | null;
  to: number | null;
}

/** A claim the source supports. With no citation it is the model's reading and is marked so. */
export interface Lesson {
  n: number;
  text: string;
  citations: LessonCitation[];
}

export const SUGGESTION_KINDS = ['preference', 'improvement', 'other'] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

export interface SuggestionOutcome {
  action: 'preference' | 'improvement' | 'dismissed';
  /** The proposed preference or improvement idea it became. */
  ref: string | null;
  label: string | null;
  by: string;
  at: string;
}

/** The model's recommendation, never a claim from the source. */
export interface LessonSuggestion {
  n: number;
  kind: SuggestionKind;
  text: string;
  /** Lessons it builds on, by number. */
  buildsOn: number[];
  outcome: SuggestionOutcome | null;
}

export interface Extraction {
  number: number;
  /** "simulated" means no AI read the source. */
  model: string;
  at: string;
  costUsd: number;
  lessons: Lesson[];
  suggestions: LessonSuggestion[];
  /** Lines the model wrote outside a bullet, such as "nothing useful for software work". */
  note: string | null;
  /** Citations dropped because they pointed outside the source. */
  droppedCitations: number;
  vaultNoteId: string | null;
}

export interface LearningSource {
  id: string;
  /** Shown as SRC-<number>. */
  number: number;
  title: string;
  fileName: string;
  kind: SourceKind;
  size: number;
  sha256: string;
  pages: number | null;
  segments: Segment[];
  storedPath: string;
  projectId: string | null;
  status: 'active' | 'archived';
  /** Oldest first; the last one is shown. Earlier readings are kept. */
  extractions: Extraction[];
  createdAt: string;
  updatedAt: string;
}

export interface SourceImportResult {
  imported: LearningSource[];
  skipped: { file: string; reason: string }[];
}

const MAX_FILES = 20;
const MAX_LESSONS = 12;
const MAX_SUGGESTIONS = 6;
const TIMEOUT_MS = 180_000;

export class Lessons {
  private readonly ws: Workspace;
  private readonly model: ModelAdapter;

  constructor(ws: Workspace, model: ModelAdapter) {
    this.ws = ws;
    this.model = model;
  }

  /** Copies the files in. Files that are not a supported source are skipped with a reason. */
  importFiles(paths: string[], projectId: string | null): SourceImportResult {
    if (!Array.isArray(paths) || paths.length === 0) throw new ValidationError('Choose at least one file.');
    if (paths.length > MAX_FILES) throw new ValidationError(`Import at most ${MAX_FILES} files at a time.`);
    if (projectId) this.ws.getProject(projectId);
    mkdirSync(this.ws.paths.sources, { recursive: true });
    const result: SourceImportResult = { imported: [], skipped: [] };
    for (const path of paths) {
      try {
        result.imported.push(this.importOne(path, projectId));
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        result.skipped.push({ file: typeof path === 'string' ? basename(path) : String(path), reason: e.message });
      }
    }
    return result;
  }

  private importOne(path: string, projectId: string | null): LearningSource {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new ValidationError('Give the full path of the file.');
    let st;
    try {
      st = lstatSync(path);
    } catch {
      throw new ValidationError('The file does not exist.');
    }
    if (!st.isFile()) throw new ValidationError('Only regular files can be imported (not folders or links).');
    const fileName = basename(path).slice(0, 200);
    if (st.size > 40_000_000) throw new ValidationError('The file is too large to learn from.');
    const buf = readFileSync(path);
    const { kind, segments, pages } = readSource(fileName, buf);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const existing = this.ws.findLearningSourceByHash(sha256);
    if (existing) throw new ValidationError(`This file is already imported as SRC-${existing.number} "${existing.title}".`);
    const id = `src_${randomUUID()}`;
    const storedPath = join(this.ws.paths.sources, `${id}${kind === 'pdf' ? '.pdf' : '.txt'}`);
    // Write the bytes that were checked, so a file changed after the check cannot slip in.
    writeFileSync(storedPath, buf, { flag: 'wx' });
    return this.ws.createLearningSource({ id, title: titleFrom(fileName), fileName, kind, size: buf.length, sha256, pages, segments, storedPath, projectId });
  }

  list(filter: { archived?: boolean } = {}): LearningSource[] {
    return this.ws.listLearningSources({ archived: filter.archived === true });
  }

  /** Accepts an id or "SRC-<number>". */
  resolve(ref: string): LearningSource {
    const m = /^SRC-(\d+)$/i.exec(ref.trim());
    if (!m) return this.ws.getLearningSource(ref);
    const s = this.ws.listLearningSources({ archived: null }).find((x) => x.number === Number(m[1]));
    if (!s) throw new ValidationError(`There is no ${ref.toUpperCase()}.`);
    return s;
  }

  /**
   * Reads the source and records the lessons and suggestions it yields. This is
   * the only model call here, and it stores a reading; it changes nothing else.
   */
  async extract(ref: string): Promise<LearningSource> {
    const s = this.resolve(ref);
    if (s.status === 'archived') throw new ValidationError(`SRC-${s.number} is archived. Restore it first.`);
    const simulated = this.model.id === 'simulated' && !this.model.billable;
    const document: SourceDocument =
      s.kind === 'pdf'
        ? { title: s.title, kind: 'pdf', data: simulated ? '' : readFileSync(s.storedPath).toString('base64'), pages: s.pages }
        : { title: s.title, kind: 'passages', passages: s.segments.map(segmentLine) };
    const outcome = await guardedCall(
      this.ws,
      this.model,
      {
        purpose: 'lessons',
        taskTitle: `Read SRC-${s.number} "${s.title}"`,
        instructions: `Pull out the lessons from "${s.title}" (${s.kind === 'pdf' ? 'a PDF' : s.kind === 'transcript' ? 'a transcript; each passage starts with its time' : 'notes or a document'}).`,
        maxOutputTokens: 4_000,
        document,
      },
      { taskId: null, timeoutMs: TIMEOUT_MS },
    );
    if (!outcome.ok) throw new ModelCallError(outcome.status, `${outcome.failure} ${outcome.resolution}`);
    const cited = outcome.response.cited ?? [{ text: outcome.response.text, citations: [] }];
    const parsed = parseLessons(cited, s);
    const extraction: Extraction = { number: s.extractions.length + 1, model: this.model.id, at: this.ws.nowIso(), costUsd: outcome.response.costUsd, vaultNoteId: null, ...parsed };
    return this.ws.updateLearningSource(
      s.id,
      { extractions: [...s.extractions, extraction] },
      {
        type: 'source.read',
        payload: { number: s.number, reading: extraction.number, model: extraction.model, lessons: extraction.lessons.length, cited: extraction.lessons.filter((l) => l.citations.length).length, suggestions: extraction.suggestions.length, costUsd: extraction.costUsd },
      },
    );
  }

  /**
   * The person's decision on one suggestion of the latest reading. "preference"
   * proposes it (it still needs approval); "improvement" adds an idea to the backlog.
   */
  act(ref: string, suggestion: number, action: 'preference' | 'improvement' | 'dismiss', options: { scope?: unknown; projectId?: unknown } = {}): { source: LearningSource; preference?: Preference; improvement?: Improvement } {
    const s = this.resolve(ref);
    const reading = s.extractions[s.extractions.length - 1];
    if (!reading) throw new ValidationError(`SRC-${s.number} has not been read yet.`);
    const item = reading.suggestions.find((x) => x.n === suggestion);
    if (!item) throw new ValidationError(`There is no suggestion ${suggestion} in the latest reading of SRC-${s.number}.`);
    if (item.outcome) throw new ValidationError(`Suggestion ${suggestion} was already ${item.outcome.action === 'dismissed' ? 'dismissed' : `turned into ${item.outcome.label}`}.`);
    const from = `From suggestion ${item.n} of SRC-${s.number} "${s.title}" (${reading.model === 'simulated' ? 'simulated' : reading.model}, ${reading.at.slice(0, 10)})`;
    let preference: Preference | undefined;
    let improvement: Improvement | undefined;
    let outcome: SuggestionOutcome;
    if (action === 'preference') {
      preference = new Preferences(this.ws).propose({ text: item.text, scope: options.scope, projectId: options.projectId, source: { type: 'lesson', summary: from, ref: s.id, quote: item.text } });
      outcome = { action, ref: preference.id, label: `PREF-${preference.number}`, by: this.ws.actorName(), at: this.ws.nowIso() };
    } else if (action === 'improvement') {
      improvement = new Backlog(this.ws).feedback({ text: item.text, from });
      outcome = { action, ref: improvement.id, label: `IMP-${improvement.number}`, by: this.ws.actorName(), at: this.ws.nowIso() };
    } else if (action === 'dismiss') {
      outcome = { action: 'dismissed', ref: null, label: null, by: this.ws.actorName(), at: this.ws.nowIso() };
    } else {
      throw new ValidationError('Choose preference, improvement or dismiss.');
    }
    const extractions = s.extractions.map((e) => (e.number === reading.number ? { ...e, suggestions: e.suggestions.map((x) => (x.n === item.n ? { ...x, outcome } : x)) } : e));
    const source = this.ws.updateLearningSource(s.id, { extractions }, { type: 'source.suggestion_decided', payload: { number: s.number, reading: reading.number, suggestion: item.n, action: outcome.action, ref: outcome.label } });
    return { source, ...(preference ? { preference } : {}), ...(improvement ? { improvement } : {}) };
  }

  /** Saves the latest reading to the Vault inbox as a note, with lessons and suggestions apart. */
  saveToVault(ref: string): { source: LearningSource; note: VaultNote } {
    const s = this.resolve(ref);
    const reading = s.extractions[s.extractions.length - 1];
    if (!reading) throw new ValidationError(`SRC-${s.number} has not been read yet.`);
    if (reading.vaultNoteId) throw new ValidationError(`This reading is already in the Vault as NOTE-${this.ws.getVaultNote(reading.vaultNoteId).number}.`);
    const note = this.ws.createVaultNote({
      kind: 'lesson',
      title: `Lessons from ${s.title}`.slice(0, 200),
      body: renderLessons(s, reading),
      summary: null,
      projectId: s.projectId,
      source: { type: 'lesson', summary: `From SRC-${s.number}, reading ${reading.number}`, ref: s.id },
    });
    const extractions = s.extractions.map((e) => (e.number === reading.number ? { ...e, vaultNoteId: note.id } : e));
    return { source: this.ws.updateLearningSource(s.id, { extractions }, { type: 'source.saved_to_vault', payload: { number: s.number, reading: reading.number, noteId: note.id } }), note };
  }

  rename(ref: string, title: unknown): LearningSource {
    const s = this.resolve(ref);
    if (typeof title !== 'string' || !title.trim()) throw new ValidationError('Title is required.');
    if (title.trim().length > 200) throw new ValidationError('Title is longer than 200 characters.');
    return this.ws.updateLearningSource(s.id, { title: title.trim() }, { type: 'source.renamed', payload: { number: s.number } });
  }

  /** Hides a source. Its file and readings are kept. */
  archive(ref: string, archived = true): LearningSource {
    const s = this.resolve(ref);
    if ((s.status === 'archived') === archived) return s;
    return this.ws.updateLearningSource(s.id, { status: archived ? 'archived' : 'active' }, { type: archived ? 'source.archived' : 'source.restored', payload: { number: s.number } });
  }
}

/** "at 01:23–02:10", "passage 4" or "p. 3", for showing where a lesson comes from. */
export function citationLabel(c: LessonCitation): string {
  if (c.kind === 'page') return c.end - c.start > 1 ? `pp. ${c.start}–${c.end - 1}` : `p. ${c.start}`;
  if (c.from !== null) return c.to !== null && Math.floor(c.to) > Math.floor(c.from) ? `at ${formatTime(c.from)}–${formatTime(c.to)}` : `at ${formatTime(c.from)}`;
  return c.end - c.start > 1 ? `passages ${c.start + 1}–${c.end}` : `passage ${c.start + 1}`;
}

/** The reading as Markdown: cited lessons first, then the model's suggestions under their own heading. */
export function renderLessons(s: Pick<LearningSource, 'number' | 'title' | 'fileName'>, e: Extraction): string {
  const lessons = e.lessons.map((l) => {
    const where = l.citations.length ? l.citations.map((c) => `${citationLabel(c)}: “${c.quote.length > 200 ? `${c.quote.slice(0, 199)}…` : c.quote}”`).join('; ') : 'no passage cited; this is the model’s reading, check it';
    return `${l.n}. ${l.text}\n   _Source: ${where}_`;
  });
  const suggestions = e.suggestions.map((x) => `- [${x.kind}] ${x.text}${x.buildsOn.length ? ` (lessons ${x.buildsOn.join(', ')})` : ''}`);
  return [
    `# Lessons from ${s.title}`,
    '',
    `SRC-${s.number} · ${s.fileName} · read by ${e.model === 'simulated' ? 'the simulated model (no AI read it)' : e.model} on ${e.at.slice(0, 10)}`,
    '',
    '## What the source says',
    '',
    ...(lessons.length ? lessons : ['No lessons were found.']),
    ...(e.note ? ['', e.note] : []),
    '',
    '## Suggestions (the model’s recommendations, not from the source)',
    '',
    ...(suggestions.length ? suggestions : ['- None.']),
    '',
  ].join('\n');
}

/**
 * Splits the answer into lessons and suggestions. The answer is untrusted:
 * citations outside the source are dropped, quotes of passages come from the
 * app's own copy, and anything after the limits is ignored.
 */
export function parseLessons(cited: CitedText[], s: Pick<LearningSource, 'segments' | 'pages' | 'kind'>): Pick<Extraction, 'lessons' | 'suggestions' | 'note' | 'droppedCitations'> {
  let text = '';
  const spans: { start: number; end: number; c: CitedText }[] = [];
  for (const c of cited) {
    spans.push({ start: text.length, end: text.length + c.text.length, c });
    text += c.text;
  }
  const lessons: Lesson[] = [];
  const suggestions: LessonSuggestion[] = [];
  const notes: string[] = [];
  let dropped = 0;
  let section: 'none' | 'lessons' | 'suggestions' = 'none';
  let offset = 0;
  for (const line of text.split('\n')) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#{1,4}\s*lessons\b/i.test(trimmed)) {
      section = 'lessons';
      continue;
    }
    if (/^#{1,4}\s*suggestions\b/i.test(trimmed)) {
      section = 'suggestions';
      continue;
    }
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(trimmed);
    if (section === 'lessons' && bullet && lessons.length < MAX_LESSONS) {
      const citations: LessonCitation[] = [];
      for (const sp of spans) {
        if (sp.end <= start || sp.start >= end) continue;
        for (const c of sp.c.citations) {
          const checked = checkCitation(c, s);
          if (!checked) dropped++;
          else if (!citations.some((x) => x.kind === checked.kind && x.start === checked.start && x.end === checked.end)) citations.push(checked);
        }
      }
      const t = clean(bullet[1]!);
      if (t) lessons.push({ n: lessons.length + 1, text: t, citations });
    } else if (section === 'suggestions' && bullet && suggestions.length < MAX_SUGGESTIONS) {
      let t = bullet[1]!.trim();
      const kind = /^\[(preference|improvement|other)\]\s*/i.exec(t);
      if (kind) t = t.slice(kind[0].length);
      const refs = /\s*\((?:from\s+)?lessons?\s+([\d,\s&and]+)\)\s*\.?\s*$/i.exec(t);
      const buildsOn = refs ? [...new Set((refs[1]!.match(/\d+/g) ?? []).map(Number))].filter((n) => n >= 1 && n <= lessons.length) : [];
      if (refs) t = `${t.slice(0, refs.index).trim()}`;
      t = clean(t);
      if (t) suggestions.push({ n: suggestions.length + 1, kind: (kind?.[1]?.toLowerCase() ?? 'other') as SuggestionKind, text: t, buildsOn, outcome: null });
    } else if (section !== 'suggestions' && !bullet && notes.length < 3) {
      notes.push(clean(trimmed));
    }
  }
  return { lessons, suggestions, note: notes.filter(Boolean).join(' ') || null, droppedCitations: dropped };
}

function checkCitation(c: CitedText['citations'][number], s: Pick<LearningSource, 'segments' | 'pages' | 'kind'>): LessonCitation | null {
  if (!Number.isInteger(c.start) || !Number.isInteger(c.end) || c.end <= c.start) return null;
  if (c.kind === 'passage') {
    if (s.kind === 'pdf' || c.start < 0 || c.end > s.segments.length) return null;
    const passages = s.segments.slice(c.start, c.end);
    return { kind: 'passage', start: c.start, end: c.end, quote: redactString(passages.map((p) => p.text).join(' ')).slice(0, 1_000), from: passages[0]!.start, to: passages[passages.length - 1]!.end };
  }
  if (s.kind !== 'pdf' || c.start < 1 || (s.pages !== null && c.end > s.pages + 1)) return null;
  return { kind: 'page', start: c.start, end: c.end, quote: redactString(String(c.quote ?? '').replace(/\s+/g, ' ').trim()).slice(0, 1_000), from: null, to: null };
}

function clean(t: string): string {
  return redactString(t.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()).slice(0, 600);
}

function titleFrom(fileName: string): string {
  const t = basename(fileName, extname(fileName)).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (t || 'Untitled source').slice(0, 200);
}
