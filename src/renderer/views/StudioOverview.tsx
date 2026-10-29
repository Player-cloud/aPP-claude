// The Learning Studio's overview (M18 part 8, DEC-036): what the library
// says about the person's taste, read from the pictures themselves (their
// lightness, colour, contrast and detail), the tags that keep coming back,
// collections made from those tags, and each picture's sampled palette.
// Every reading comes from the references' own pixels and tags.
import { useEffect, useState } from 'react';
import type { DesignReference } from '../../shared/api.ts';
import { averageLook, readLook, type Look } from '../../shared/look.ts';

const SIDE = 64;
const cache = new Map<string, Promise<Look | null>>();
const src = (r: DesignReference) => `iap-ref://ref/${r.id}`;

/** Reads a reference picture's pixels once; videos and pictures that fail to load have no look. */
function lookOf(r: DesignReference): Promise<Look | null> {
  if (!r.mediaType.startsWith('image/')) return Promise.resolve(null);
  const key = `${r.id}:${r.sha256}`;
  let p = cache.get(key);
  if (!p) {
    p = new Promise((ok) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const scale = Math.min(1, SIDE / Math.max(img.naturalWidth, img.naturalHeight));
          const w = Math.max(1, Math.round(img.naturalWidth * scale));
          const h = Math.max(1, Math.round(img.naturalHeight * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(img, 0, 0, w, h);
          ok(readLook(ctx.getImageData(0, 0, w, h).data, w, h));
        } catch {
          ok(null);
        }
      };
      img.onerror = () => ok(null);
      img.src = src(r);
    });
    cache.set(key, p);
  }
  return p;
}

export function useLooks(list: DesignReference[] | null): Map<string, Look> {
  const [looks, setLooks] = useState<Map<string, Look>>(new Map());
  const key = (list ?? []).map((r) => `${r.id}:${r.sha256}`).join(',');
  useEffect(() => {
    let live = true;
    void Promise.all((list ?? []).map(async (r) => [r.id, await lookOf(r)] as const)).then((pairs) => {
      if (live) setLooks(new Map(pairs.filter((p): p is readonly [string, Look] => p[1] !== null)));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return looks;
}

const AXES = [
  { k: 'loud', from: 'Calm', to: 'Loud', what: 'contrast' },
  { k: 'light', from: 'Dark', to: 'Light', what: 'lightness' },
  { k: 'dense', from: 'Airy', to: 'Dense', what: 'detail' },
  { k: 'rich', from: 'Plain', to: 'Rich', what: 'colour' },
] as const;

export function TasteCard({ looks }: { looks: Look[] }) {
  const avg = averageLook(looks);
  if (!avg) return null;
  return (
    <section className="kcard studio-card" aria-labelledby="taste-title">
      <h2 className="studio-card-title" id="taste-title">
        Your taste, read from {looks.length} {looks.length === 1 ? 'picture' : 'pictures'}
      </h2>
      <dl className="taste">
        {AXES.map((a) => (
          <div key={a.k} className="taste-row">
            <dt>{a.from}</dt>
            <dd>
              <span className="taste-track" role="img" aria-label={`${a.from} to ${a.to}: ${Math.round(avg[a.k] * 100)}% ${a.to.toLowerCase()}, from the pictures' ${a.what}`}>
                <i style={{ left: `${avg[a.k] * 100}%` }} />
              </span>
            </dd>
            <dt className="taste-to">{a.to}</dt>
          </div>
        ))}
      </dl>
      <p className="studio-card-foot">Measured from the pixels: lightness, colour, contrast and detail.</p>
    </section>
  );
}

export function MovesCard({ list, onTag }: { list: DesignReference[]; onTag: (tag: string) => void }) {
  const counts = new Map<string, number>();
  for (const r of list) for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const top = [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
  return (
    <section className="kcard studio-card" aria-labelledby="moves-title">
      <h2 className="studio-card-title" id="moves-title">
        Tags that keep coming back
      </h2>
      {top.length ? (
        <ul className="moves">
          {top.map(([t, n]) => (
            <li key={t}>
              <button type="button" className="move" onClick={() => onTag(t)}>
                #{t} <span className="move-n">{n}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="studio-card-foot">When two or more references share a tag, it shows here.</p>
      )}
    </section>
  );
}

/** A collection is a tag that two or more references share. */
export function Collections({ list, onTag }: { list: DesignReference[]; onTag: (tag: string) => void }) {
  const by = new Map<string, DesignReference[]>();
  for (const r of list) for (const t of r.tags) by.set(t, [...(by.get(t) ?? []), r]);
  const sets = [...by].filter(([, rs]) => rs.length >= 2).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, 6);
  if (sets.length === 0) return null;
  return (
    <section className="section" aria-labelledby="collections-title">
      <h2 className="section-title" id="collections-title">
        Collections <span className="count-pill">{sets.length}</span>
      </h2>
      <ul className="collections">
        {sets.map(([t, rs]) => (
          <li key={t}>
            <button type="button" className="collection" onClick={() => onTag(t)} aria-label={`Collection #${t}, ${rs.length} references`}>
              <span className="collection-stack" aria-hidden="true">
                {rs
                  .filter((r) => r.mediaType.startsWith('image/'))
                  .slice(0, 3)
                  .map((r, i) => (
                    <img key={r.id} src={src(r)} alt="" data-i={i} loading="lazy" />
                  ))}
              </span>
              <span className="collection-name">#{t}</span>
              <span className="collection-n">
                {rs.length} references
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Palette({ look }: { look: Look | undefined }) {
  if (!look || look.palette.length === 0) return null;
  return (
    <div className="palette-sample">
      <h3 className="ref-subhead">Sampled palette</h3>
      <ul className="swatches" aria-label="Main colours">
        {look.palette.map((c) => (
          <li key={c}>
            <span className="swatch" style={{ background: c }} aria-hidden="true" />
            <span className="mono">{c}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
