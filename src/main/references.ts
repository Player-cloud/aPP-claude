// Serves the Learning Studio's copies of reference files to the renderer (M9).
// Kept free of Electron imports so it can be tested with plain Node.

import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';

/** Serves one reference file, honouring a single byte range so videos can seek. */
export function serveReference(file: { path: string; mediaType: string }, range: string | null): Response {
  const size = statSync(file.path).size;
  const headers: Record<string, string> = { 'Content-Type': file.mediaType, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    const body = Readable.toWeb(createReadStream(file.path, { start, end })) as ReadableStream;
    return new Response(body, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
  }
  return new Response(Readable.toWeb(createReadStream(file.path)) as ReadableStream, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}
