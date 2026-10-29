// How a picture looks, read from its pixels (M18 part 8, DEC-036): its main
// colours and four readings between 0 and 1. Light is the average lightness,
// rich the average colour saturation, loud the spread of lightness (contrast),
// and dense how much detail there is (the average change between neighbouring
// pixels). These are measurements, not judgements; the Learning Studio shows
// them for a reference and averaged over the library.

export interface Look {
  /** Up to five main colours as #rrggbb, lightest first. */
  palette: string[];
  light: number;
  rich: number;
  loud: number;
  dense: number;
}

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
const luma = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
/** Between 0 and 1, to two places. */
const clamp = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;

/** Reads RGBA pixels (4 bytes each, as a canvas gives them). Transparent pixels are skipped. */
export function readLook(data: ArrayLike<number>, width: number, height: number): Look {
  const n = width * height;
  const lum = new Float32Array(n);
  const seen = new Uint8Array(n);
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let count = 0;
  let sumL = 0;
  let sumL2 = 0;
  let sumS = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i * 4]!;
    const g = data[i * 4 + 1]!;
    const b = data[i * 4 + 2]!;
    if (data[i * 4 + 3]! < 128) continue;
    seen[i] = 1;
    count++;
    const l = luma(r, g, b);
    lum[i] = l;
    sumL += l;
    sumL2 += l * l;
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const mid = (max + min) / 2;
    sumS += max === min ? 0 : (max - min) / (1 - Math.abs(2 * mid - 1));
    // 8 levels per channel: near colours share a bucket, which is then averaged.
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const bk = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bk.n++;
    bk.r += r;
    bk.g += g;
    bk.b += b;
    buckets.set(key, bk);
  }
  if (count === 0) return { palette: [], light: 0, rich: 0, loud: 0, dense: 0 };
  const mean = sumL / count;
  const sd = Math.sqrt(Math.max(0, sumL2 / count - mean * mean));
  let grad = 0;
  let pairs = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!seen[i]) continue;
      if (x + 1 < width && seen[i + 1]) (grad += Math.abs(lum[i]! - lum[i + 1]!), pairs++);
      if (y + 1 < height && seen[i + width]) (grad += Math.abs(lum[i]! - lum[i + width]!), pairs++);
    }
  }
  const colours = [...buckets.values()].sort((a, b) => b.n - a.n).map((bk) => ({ n: bk.n, r: bk.r / bk.n, g: bk.g / bk.n, b: bk.b / bk.n }));
  const picked: typeof colours = [];
  for (const c of colours) {
    if (picked.length === 5) break;
    // A colour that is less than 2% of the picture, or close to one already picked, is left out.
    if (c.n / count < 0.02 && picked.length > 0) break;
    if (picked.some((p) => Math.hypot(p.r - c.r, p.g - c.g, p.b - c.b) < 48)) continue;
    picked.push(c);
  }
  return {
    palette: picked.sort((a, b) => luma(b.r, b.g, b.b) - luma(a.r, a.g, a.b)).map((c) => hex(c.r, c.g, c.b)),
    light: clamp(mean),
    rich: clamp(sumS / count),
    // A lightness spread of 0.35 (strong black on white) reads as fully loud.
    loud: clamp(sd / 0.35),
    // An average step of 0.12 between neighbours reads as fully dense.
    dense: clamp(pairs ? grad / pairs / 0.12 : 0),
  };
}

/** The average of several looks; the palette is left out. */
export function averageLook(looks: Look[]): Omit<Look, 'palette'> | null {
  if (looks.length === 0) return null;
  const avg = (k: 'light' | 'rich' | 'loud' | 'dense') => looks.reduce((s, l) => s + l[k], 0) / looks.length;
  return { light: avg('light'), rich: avg('rich'), loud: avg('loud'), dense: avg('dense') };
}
