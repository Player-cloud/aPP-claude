// What a reference file really is (M9, FR-DESIGN-001). The type comes from the
// file's first bytes, never from its name, so a renamed file cannot pass as an
// image. Only formats the viewer can show safely are accepted; SVG is refused
// because it can carry scripts.

export type MediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'video/mp4' | 'video/quicktime' | 'video/webm';

export const EXTENSION: Record<MediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

export const MAX_BYTES = { image: 25_000_000, video: 150_000_000 };

export const isImage = (t: MediaType) => t.startsWith('image/');

/** The media type from the file's signature, or null when it is not a supported format. */
export function sniff(head: Buffer): MediaType | null {
  const at = (offset: number, ...bytes: number[]) => bytes.every((b, i) => head[offset + i] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (head.subarray(0, 6).toString('latin1') === 'GIF87a' || head.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') return head.subarray(8, 10).toString('latin1') === 'qt' ? 'video/quicktime' : 'video/mp4';
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return 'video/webm';
  return null;
}

/** Pixel size read from the image header, or null when it cannot be read. Videos are not decoded. */
export function dimensions(buf: Buffer, type: MediaType): { width: number; height: number } | null {
  try {
    if (type === 'image/png' && buf.length >= 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (type === 'image/gif' && buf.length >= 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (type === 'image/webp' && buf.length >= 30) {
      const chunk = buf.subarray(12, 16).toString('latin1');
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
    if (type === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1]!;
        // Start-of-frame markers carry the size; skip every other segment by its length.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch {
    return null;
  }
  return null;
}
