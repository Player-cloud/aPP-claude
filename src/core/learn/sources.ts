// What a learning source is, and its text split into citable passages (M14:
// FR-LEARN-002, DEC-031). The type comes from the file's content, never from
// its name alone: a PDF must start with "%PDF-", and text must be valid UTF-8.
// Videos are refused, because no model call here can watch one; the person
// imports the video's transcript instead.

import { ValidationError } from '../errors.ts';

export type SourceKind = 'transcript' | 'text' | 'pdf';

/** One citable passage. Times are seconds from the start, when the source has them. */
export interface Segment {
  text: string;
  start: number | null;
  end: number | null;
}

export const SOURCE_LIMITS = {
  /** The Messages API refuses larger PDFs. */
  pdfBytes: 32_000_000,
  pdfPages: 100,
  textBytes: 2_000_000,
  segments: 1_500,
  segmentChars: 700,
};

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|wmv)$/i;
const TEXT_EXT = /\.(vtt|srt|txt|md|markdown)$/i;

/** Decides the kind from the file name and bytes, and splits text into passages. */
export function readSource(fileName: string, buf: Buffer): { kind: SourceKind; segments: Segment[]; pages: number | null } {
  if (VIDEO_EXT.test(fileName)) throw new ValidationError('Claude cannot watch videos here. Import the video’s transcript instead (.vtt or .srt, or a .txt with timestamps).');
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    if (buf.length > SOURCE_LIMITS.pdfBytes) throw new ValidationError(`PDFs can be at most ${SOURCE_LIMITS.pdfBytes / 1_000_000} MB.`);
    const pages = countPdfPages(buf);
    if (pages !== null && pages > SOURCE_LIMITS.pdfPages) throw new ValidationError(`This PDF has ${pages} pages; at most ${SOURCE_LIMITS.pdfPages} can be read at once. Split it first.`);
    return { kind: 'pdf', segments: [], pages };
  }
  if (!TEXT_EXT.test(fileName)) throw new ValidationError('Not a supported source. Use a transcript (.vtt, .srt, .txt), a text or Markdown file (.md), or a PDF.');
  if (buf.length > SOURCE_LIMITS.textBytes) throw new ValidationError(`Text sources can be at most ${SOURCE_LIMITS.textBytes / 1_000_000} MB.`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  } catch {
    throw new ValidationError('The file is not readable text (UTF-8).');
  }
  if (text.includes('\u0000')) throw new ValidationError('The file is not readable text.');
  const cues = /^WEBVTT/.test(text) ? parseCues(text, 'vtt') : /\.srt$/i.test(fileName) || /^\d+\n\d{1,2}:\d{2}:\d{2},\d{3} -->/.test(text.trimStart()) ? parseCues(text, 'srt') : parseTimestampedLines(text);
  const segments = cues ? merge(cues) : paragraphs(text);
  if (!segments.length) throw new ValidationError('The file has no text to learn from.');
  if (segments.length > SOURCE_LIMITS.segments) throw new ValidationError(`The source is too long (${segments.length} passages, at most ${SOURCE_LIMITS.segments}). Split it first.`);
  return { kind: cues ? 'transcript' : 'text', segments, pages: null };
}

/** "1:02:03" or "02:03" for a time in seconds. */
export function formatTime(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/** A passage as the model sees it, with its time first so a citation keeps it. */
export function segmentLine(s: Segment): string {
  return s.start === null ? s.text : `[${formatTime(s.start)}] ${s.text}`;
}

const CUE_TIME = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{3})/;

function parseCues(text: string, format: 'vtt' | 'srt'): Segment[] | null {
  const out: Segment[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const at = lines.findIndex((l) => CUE_TIME.test(l));
    if (at < 0) continue;
    const m = CUE_TIME.exec(lines[at]!)!;
    const start = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
    const end = Number(m[5] ?? 0) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000;
    // Markup such as <v Speaker> or <i> is dropped; only the words are kept.
    const words = lines
      .slice(at + 1)
      .join(' ')
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (words) out.push({ text: words, start, end });
  }
  if (format === 'vtt' || out.length) return out;
  return null;
}

const LINE_TIME = /^\[?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]?\s*[-–:]?\s+(.*)$/;

/** Plain text where most lines start with a time, as many tools export transcripts. */
function parseTimestampedLines(text: string): Segment[] | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const timed = lines.map((l) => LINE_TIME.exec(l));
  if (lines.length < 2 || timed.filter(Boolean).length < lines.length * 0.6) return null;
  const out: Segment[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = timed[i];
    if (m) {
      out.push({ text: m[4]!.trim(), start: Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]), end: null });
    } else if (out.length) {
      out[out.length - 1]!.text += ` ${lines[i]}`;
    }
  }
  for (let i = 0; i < out.length; i++) out[i]!.end = out[i + 1]?.start ?? out[i]!.start;
  return out.filter((s) => s.text);
}

/** Short cues are joined into passages of a few sentences, so citations point at a readable span. */
function merge(cues: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const c of cues) {
    const last = out[out.length - 1];
    const fits = last !== undefined && last.text.length + c.text.length + 1 <= SOURCE_LIMITS.segmentChars;
    // Join while the sentence goes on, or while the passage is still short.
    if (fits && (last.text.length < 240 || !/[.!?]["')\]]?$/.test(last.text))) {
      last.text += ` ${c.text}`;
      last.end = c.end;
    } else {
      out.push({ ...c });
    }
  }
  return out;
}

function paragraphs(text: string): Segment[] {
  const out: Segment[] = [];
  for (const p of text.split(/\n\s*\n/)) {
    let t = p.replace(/\s+/g, ' ').trim();
    while (t.length > SOURCE_LIMITS.segmentChars) {
      const cut = t.lastIndexOf('. ', SOURCE_LIMITS.segmentChars);
      const at = cut > SOURCE_LIMITS.segmentChars / 3 ? cut + 1 : SOURCE_LIMITS.segmentChars;
      out.push({ text: t.slice(0, at).trim(), start: null, end: null });
      t = t.slice(at).trim();
    }
    if (t) out.push({ text: t, start: null, end: null });
  }
  return out;
}

/**
 * Page count from the page objects in the file. Null when it cannot be told
 * (pages inside compressed object streams), so callers assume the maximum.
 */
export function countPdfPages(buf: Buffer): number | null {
  const n = buf.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  return n > 0 ? n : null;
}
