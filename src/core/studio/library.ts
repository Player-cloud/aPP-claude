// Learning Studio: a library of design references (M9: FR-DESIGN-001, DEC-024).
//
//   import (files the person picked) → copy into the app's data folder after
//   checking what each file really is → tag, note, link to a project, search →
//   optional suggestion from the model (kind, tags, explanation) that the
//   person accepts or corrects
//
// A reference is guidance only: nothing here reads or changes a project's
// brief or specification. Files are copies, so the person's originals are
// never touched, and archiving hides a reference without deleting its file.

import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import { ModelCallError, ValidationError } from '../errors.ts';
import { guardedCall } from '../agents/guard.ts';
import type { ModelAdapter } from '../agents/model.ts';
import { redactString } from '../redact.ts';
import type { Workspace } from '../workspace.ts';
import { dimensions, EXTENSION, isImage, MAX_BYTES, sniff, type MediaType } from './media.ts';

export const REFERENCE_KINDS = ['screenshot', 'ui_design', 'animation', 'video', 'illustration', 'photo', 'other'] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export interface ReferenceSuggestion {
  kind: ReferenceKind;
  tags: string[];
  explanation: string;
  /** The model that made it; "simulated" means no AI looked at the file. */
  model: string;
  at: string;
  /** proposed → accepted as is, or corrected when the person changed what it said. */
  status: 'proposed' | 'accepted' | 'corrected';
}

export interface DesignReference {
  id: string;
  projectId: string | null;
  title: string;
  /** The original file name, for the person's recognition only. */
  fileName: string;
  mediaType: MediaType;
  size: number;
  sha256: string;
  width: number | null;
  height: number | null;
  kind: ReferenceKind;
  tags: string[];
  notes: string | null;
  explanation: string | null;
  suggestion: ReferenceSuggestion | null;
  /** The app's own copy. */
  storedPath: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceEdit {
  title?: string;
  kind?: string;
  tags?: string[];
  notes?: string | null;
  explanation?: string | null;
  projectId?: string | null;
}

export interface ImportResult {
  imported: DesignReference[];
  skipped: { file: string; reason: string }[];
}

const MAX_FILES = 50;
/** The Messages API refuses larger images. */
const MAX_IMAGE_FOR_MODEL = 5_000_000;
const MAX_TAGS = 12;
const TIMEOUT_MS = 90_000;

export class Studio {
  private readonly ws: Workspace;
  private readonly model: ModelAdapter;

  constructor(ws: Workspace, model: ModelAdapter) {
    this.ws = ws;
    this.model = model;
  }

  /** Copies the files into the library. Files that are not a supported image or video are skipped with a reason. */
  importFiles(paths: string[], projectId: string | null): ImportResult {
    if (!Array.isArray(paths) || paths.length === 0) throw new ValidationError('Choose at least one file.');
    if (paths.length > MAX_FILES) throw new ValidationError(`Import at most ${MAX_FILES} files at a time.`);
    if (projectId) this.ws.getProject(projectId);
    mkdirSync(this.ws.paths.references, { recursive: true });
    const result: ImportResult = { imported: [], skipped: [] };
    for (const path of paths) {
      const file = typeof path === 'string' ? basename(path) : String(path);
      try {
        result.imported.push(this.importOne(path, projectId));
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        result.skipped.push({ file, reason: e.message });
      }
    }
    return result;
  }

  private importOne(path: string, projectId: string | null): DesignReference {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new ValidationError('Give the full path of the file.');
    let st;
    try {
      st = lstatSync(path);
    } catch {
      throw new ValidationError('The file does not exist.');
    }
    if (!st.isFile()) throw new ValidationError('Only regular files can be imported (not folders or links).');
    if (st.size > MAX_BYTES.video) throw new ValidationError(`The file is larger than ${MAX_BYTES.video / 1_000_000} MB.`);
    const buf = readFileSync(path);
    const mediaType = sniff(buf.subarray(0, 64));
    if (!mediaType) throw new ValidationError('Not a supported image or video. Use PNG, JPEG, GIF, WebP, MP4, MOV or WebM (SVG is not accepted because it can contain scripts).');
    if (isImage(mediaType) && buf.length > MAX_BYTES.image) throw new ValidationError(`Images can be at most ${MAX_BYTES.image / 1_000_000} MB.`);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const existing = this.ws.findReferenceByHash(sha256);
    if (existing) throw new ValidationError(`This file is already in the library as "${existing.title}".`);

    const id = `ref_${randomUUID()}`;
    const storedPath = join(this.ws.paths.references, `${id}.${EXTENSION[mediaType]}`);
    // Write the bytes that were checked, so a file changed after the check cannot slip in.
    writeFileSync(storedPath, buf, { flag: 'wx' });
    const size = dimensions(buf, mediaType);
    const fileName = basename(path).slice(0, 200);
    return this.ws.createReference({
      id,
      projectId,
      title: titleFrom(fileName),
      fileName,
      mediaType,
      size: buf.length,
      sha256,
      width: size?.width ?? null,
      height: size?.height ?? null,
      kind: mediaType.startsWith('video/') ? 'video' : mediaType === 'image/gif' ? 'animation' : 'other',
      tags: [],
      notes: null,
      storedPath,
    });
  }

  detail(id: string): DesignReference {
    return this.ws.getReference(id);
  }

  /** Text search over title, file name, tags, notes and explanation, with optional project, tag and kind filters. */
  list(filter: { projectId?: string | null; query?: string; tag?: string; kind?: string; archived?: boolean } = {}): DesignReference[] {
    const q = (filter.query ?? '').trim().toLowerCase();
    const terms = q ? q.split(/\s+/) : [];
    return this.ws.listReferences({ projectId: filter.projectId, archived: filter.archived }).filter((r) => {
      if (filter.tag && !r.tags.includes(filter.tag)) return false;
      if (filter.kind && r.kind !== filter.kind) return false;
      const hay = [r.title, r.fileName, r.notes ?? '', r.explanation ?? '', ...r.tags].join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  /** The person's own changes. Changing what a suggestion said marks the suggestion as corrected. */
  update(id: string, input: ReferenceEdit): DesignReference {
    const r = this.ws.getReference(id);
    if (r.status === 'archived') throw new ValidationError('This reference is archived. Restore it first.');
    const patch: Parameters<Workspace['updateReference']>[1] = {};
    if (input.title !== undefined) patch.title = text('Title', input.title, 200, true)!;
    if (input.kind !== undefined) patch.kind = kind(input.kind);
    if (input.tags !== undefined) patch.tags = tags(input.tags);
    if (input.notes !== undefined) patch.notes = text('Notes', input.notes, 4_000);
    if (input.explanation !== undefined) patch.explanation = text('Explanation', input.explanation, 4_000);
    if (input.projectId !== undefined) {
      if (input.projectId !== null) this.ws.getProject(input.projectId);
      patch.projectId = input.projectId;
    }
    const changed = Object.keys(patch).filter((k) => JSON.stringify((patch as Record<string, unknown>)[k]) !== JSON.stringify((r as unknown as Record<string, unknown>)[k]));
    if (!changed.length) return r;
    const s = r.suggestion;
    const corrects =
      s &&
      s.status !== 'corrected' &&
      ((changed.includes('kind') && patch.kind !== s.kind) || (changed.includes('tags') && !sameSet(patch.tags!, s.tags)) || (changed.includes('explanation') && patch.explanation !== s.explanation));
    if (corrects) patch.suggestion = { ...s, status: 'corrected' };
    return this.ws.updateReference(id, patch, { type: patch.projectId !== undefined && changed.length === 1 ? 'reference.linked' : 'reference.updated', payload: { changed, ...(corrects ? { suggestionCorrected: true } : {}), ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}) } });
  }

  /** Asks the model for a kind, tags and an explanation. Nothing is applied until the person accepts or edits it. */
  async suggest(id: string): Promise<DesignReference> {
    const r = this.ws.getReference(id);
    if (r.status === 'archived') throw new ValidationError('This reference is archived. Restore it first.');
    const simulated = !this.model.billable && this.model.id === 'simulated';
    let image: { mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string } | undefined;
    if (!simulated) {
      if (!isImage(r.mediaType)) throw new ValidationError('Claude cannot watch videos in this version. Describe it in the notes instead.');
      if (r.size > MAX_IMAGE_FOR_MODEL) throw new ValidationError('This image is larger than 5 MB, which is more than Claude accepts. Import a smaller copy to get a suggestion.');
      image = { mediaType: r.mediaType as NonNullable<typeof image>['mediaType'], data: readFileSync(r.storedPath).toString('base64') };
    }
    const outcome = await guardedCall(
      this.ws,
      this.model,
      {
        purpose: 'classify',
        taskTitle: `Describe reference "${r.title}"`,
        instructions: JSON.stringify({ fileName: r.fileName, mediaType: r.mediaType, width: r.width, height: r.height }),
        maxOutputTokens: 800,
        image,
      },
      { taskId: null, timeoutMs: TIMEOUT_MS },
    );
    if (!outcome.ok) throw new ModelCallError(outcome.status, `${outcome.failure} ${outcome.resolution}`);
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(outcome.response.text) as Record<string, unknown>;
    } catch {
      throw new ModelCallError('failed', 'The suggestion was not valid JSON, so nothing was saved. Try again.');
    }
    // The answer is untrusted: anything off-list is dropped rather than stored.
    const suggestion: ReferenceSuggestion = {
      kind: (REFERENCE_KINDS as readonly string[]).includes(String(raw.kind)) ? (raw.kind as ReferenceKind) : 'other',
      tags: tags(Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [], true),
      explanation: redactString(String(raw.explanation ?? '')).slice(0, 1_500),
      model: this.model.id,
      at: new Date().toISOString(),
      status: 'proposed',
    };
    return this.ws.updateReference(id, { suggestion }, { type: 'reference.suggested', payload: { model: this.model.id, kind: suggestion.kind, tags: suggestion.tags, costUsd: outcome.response.costUsd } });
  }

  /** Applies the suggestion as it is. Existing tags are kept. */
  acceptSuggestion(id: string): DesignReference {
    const r = this.ws.getReference(id);
    if (!r.suggestion || r.suggestion.status !== 'proposed') throw new ValidationError('There is no open suggestion to accept.');
    const s = r.suggestion;
    return this.ws.updateReference(
      id,
      { kind: s.kind, tags: tags([...r.tags, ...s.tags], true), explanation: s.explanation, suggestion: { ...s, status: 'accepted' } },
      { type: 'reference.suggestion_accepted', payload: { model: s.model } },
    );
  }

  archive(id: string, archived = true): DesignReference {
    const r = this.ws.getReference(id);
    if ((r.status === 'archived') === archived) return r;
    return this.ws.updateReference(id, { status: archived ? 'archived' : 'active' }, { type: archived ? 'reference.archived' : 'reference.restored', payload: {} });
  }

  /** Every tag in use, with how many active references carry it. */
  tagCounts(): { tag: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const r of this.ws.listReferences()) for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }
}

function titleFrom(fileName: string): string {
  const t = basename(fileName, extname(fileName)).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (t || 'Untitled reference').slice(0, 200);
}

function text(label: string, v: unknown, max: number, required = false): string | null {
  if (v === null && !required) return null;
  if (typeof v !== 'string') throw new ValidationError(`${label} must be text.`);
  const t = v.trim();
  if (required && !t) throw new ValidationError(`${label} is required.`);
  if (t.length > max) throw new ValidationError(`${label} is longer than ${max} characters.`);
  return t || null;
}

function kind(v: unknown): ReferenceKind {
  if (!(REFERENCE_KINDS as readonly unknown[]).includes(v)) throw new ValidationError(`Kind must be one of: ${REFERENCE_KINDS.join(', ')}.`);
  return v as ReferenceKind;
}

/** Lowercase words joined by hyphens. With `lenient`, bad tags are dropped instead of refused. */
function tags(v: unknown, lenient = false): string[] {
  if (!Array.isArray(v)) throw new ValidationError('Tags must be a list.');
  const out: string[] = [];
  for (const raw of v) {
    const t = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/\s+/g, '-') : '';
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(t)) {
      if (lenient) continue;
      throw new ValidationError(`"${String(raw).slice(0, 40)}" is not a tag. Use letters, digits and hyphens, at most 32 characters.`);
    }
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > MAX_TAGS) {
    if (lenient) return out.slice(0, MAX_TAGS);
    throw new ValidationError(`Use at most ${MAX_TAGS} tags.`);
  }
  return out;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
