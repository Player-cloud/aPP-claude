// The task canvas's frame (M18 part 3, DEC-036): wires from each column's
// card to the cards of the next column, zoom, a "show everything" fit that
// lays the four columns side by side, and a small overview that scrolls the
// canvas. The wires and the overview only describe the layout, so they are
// hidden from assistive technology; the zoom buttons are real controls.
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const ZOOMS = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25];
/** The width the four columns need side by side, at 100%. */
const WIDE = 1480;

function savedZoom(): number {
  try {
    const z = Number(localStorage.getItem('canvas-zoom'));
    return ZOOMS.includes(z) ? z : 1;
  } catch {
    return 1;
  }
}

type Wire = { d: string; live: boolean; from: [number, number]; to: [number, number] };
type Box = { x: number; y: number; w: number; h: number };

/** Wires between neighbouring columns, in the canvas's own (unzoomed) pixels. */
function measure(canvas: HTMLElement, live: boolean): { wires: Wire[]; boxes: Box[]; width: number; height: number } {
  const c = canvas.getBoundingClientRect();
  const scale = canvas.offsetWidth ? c.width / canvas.offsetWidth : 1;
  const rel = (el: Element): Box => {
    const r = el.getBoundingClientRect();
    return { x: (r.left - c.left) / scale, y: (r.top - c.top) / scale, w: r.width / scale, h: r.height / scale };
  };
  const cols = [...canvas.querySelectorAll<HTMLElement>(':scope > .canvas-col')].map((col) => ({
    col,
    box: rel(col),
    cards: [...col.querySelectorAll<HTMLElement>(':scope > .kcard, :scope > .report-head, :scope > .stat-row')],
  }));
  const wires: Wire[] = [];
  for (const s of cols) {
    const source = s.col.querySelector<HTMLElement>(':scope > [data-wire-from]') ?? s.cards[0];
    if (!source) continue;
    const right = cols.filter((t) => t.box.x > s.box.x + s.box.w - 1);
    if (!right.length) continue;
    const nearest = Math.min(...right.map((t) => t.box.x));
    const sb = rel(source);
    const x1 = sb.x + sb.w;
    const y1 = sb.y + Math.min(sb.h / 2, 28);
    for (const t of right.filter((t) => t.box.x === nearest)) {
      for (const card of t.cards.slice(0, 3)) {
        const tb = rel(card);
        const x2 = tb.x;
        const y2 = tb.y + Math.min(tb.h / 2, 22);
        const dx = Math.max(16, (x2 - x1) / 2);
        const isLive = live && (s.col.dataset.col === 'steps' || t.col.dataset.col === 'steps');
        wires.push({ d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, live: isLive, from: [x1, y1], to: [x2, y2] });
      }
    }
  }
  const boxes = cols.flatMap((col) => col.cards.map(rel));
  return { wires, boxes, width: canvas.offsetWidth, height: canvas.offsetHeight };
}

export function CanvasFrame({ live, evidence, children, toolbarStart }: { live: boolean; evidence: boolean; children: ReactNode; toolbarStart?: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const [zoom, setZoomState] = useState(savedZoom);
  const [wide, setWide] = useState(false);
  const [layout, setLayout] = useState<{ wires: Wire[]; boxes: Box[]; width: number; height: number }>({ wires: [], boxes: [], width: 0, height: 0 });
  const [view, setView] = useState<{ top: number; height: number } | null>(null);

  const setZoom = (z: number) => {
    setZoomState(z);
    try {
      localStorage.setItem('canvas-zoom', String(z));
    } catch {
      // Remembering the zoom is a convenience only.
    }
  };

  const canvasEl = () => frame.current?.querySelector<HTMLElement>('.kiln-canvas') ?? null;
  const scroller = () => frame.current?.closest<HTMLElement>('.content') ?? null;

  const redraw = useCallback(() => {
    const canvas = canvasEl();
    if (canvas) setLayout(measure(canvas, live));
    const sc = scroller();
    if (canvas && sc) {
      const c = canvas.getBoundingClientRect();
      const s = sc.getBoundingClientRect();
      const scale = canvas.offsetWidth ? c.width / canvas.offsetWidth : 1;
      setView({ top: Math.max(0, (s.top - c.top) / scale), height: s.height / scale });
    }
  }, [live]);

  useLayoutEffect(() => {
    const canvas = canvasEl();
    if (!canvas) return;
    redraw();
    const ro = new ResizeObserver(() => redraw());
    ro.observe(canvas);
    for (const el of canvas.querySelectorAll('.kcard, .report-head')) ro.observe(el);
    const mo = new MutationObserver(() => {
      for (const el of canvas.querySelectorAll('.kcard, .report-head')) ro.observe(el);
      redraw();
    });
    mo.observe(canvas, { childList: true, subtree: true });
    const sc = scroller();
    sc?.addEventListener('scroll', redraw, { passive: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      sc?.removeEventListener('scroll', redraw);
    };
  }, [redraw, zoom, wide]);

  // Fit: the four columns side by side, zoomed so they fill the width.
  const fit = () => {
    const w = frame.current?.clientWidth ?? WIDE;
    const z = [...ZOOMS].reverse().find((x) => x * WIDE <= w) ?? ZOOMS[0]!;
    setWide(true);
    setZoom(Math.min(1, z));
  };
  const step = (dir: 1 | -1) => {
    const i = ZOOMS.indexOf(zoom);
    setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.indexOf(1) : i) + dir))]!);
  };

  const mmScale = layout.width ? 132 / layout.width : 0;
  const goTo = (y: number) => {
    const sc = scroller();
    const canvas = canvasEl();
    if (!sc || !canvas) return;
    const c = canvas.getBoundingClientRect();
    const s = sc.getBoundingClientRect();
    const scale = canvas.offsetWidth ? c.width / canvas.offsetWidth : 1;
    sc.scrollTo({ top: sc.scrollTop + (c.top - s.top) + (y - s.height / scale / 2) * scale, behavior: 'smooth' });
  };

  return (
    <div className="canvas-frame" ref={frame}>
      <div className="canvas-toolbar">
        {toolbarStart}
        <div className="canvas-tools">
          <div className="zoom-group" role="group" aria-label="Zoom">
            <button type="button" className="zoom-btn" aria-label="Zoom out" disabled={zoom <= ZOOMS[0]!} onClick={() => step(-1)}>
              −
            </button>
            <button type="button" className="zoom-btn zoom-level" aria-label={`Zoom ${Math.round(zoom * 100)}%, reset to 100%`} onClick={() => (setZoom(1), setWide(false))}>
              {Math.round(zoom * 100)}%
            </button>
            <button type="button" className="zoom-btn" aria-label="Zoom in" disabled={zoom >= ZOOMS[ZOOMS.length - 1]!} onClick={() => step(1)}>
              +
            </button>
            <button type="button" className="zoom-btn" aria-label="Show everything side by side" aria-pressed={wide} onClick={() => (wide ? (setWide(false), setZoom(1)) : fit())}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
              </svg>
            </button>
          </div>
          {layout.height > 0 && mmScale > 0 && (
            <div
              className="minimap"
              aria-hidden="true"
              style={{ height: Math.min(52, Math.max(32, layout.height * mmScale)) }}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const k = Math.min(52, Math.max(32, layout.height * mmScale)) / layout.height;
                goTo((e.clientY - r.top) / k);
              }}
            >
              {(() => {
                const k = Math.min(52, Math.max(32, layout.height * mmScale)) / layout.height;
                return (
                  <>
                    {layout.boxes.map((b, i) => (
                      <i key={i} style={{ left: b.x * mmScale, top: b.y * k, width: Math.max(2, b.w * mmScale), height: Math.max(2, b.h * k) }} />
                    ))}
                    {view && <b style={{ top: view.top * k, height: Math.min(layout.height, view.height) * k }} />}
                  </>
                );
              })()}
            </div>
          )}
        </div>
      </div>
      <div className="canvas-zoom" style={{ zoom }}>
        <div className="kiln-canvas" data-evidence={evidence ? 'yes' : 'no'} data-layout={wide ? 'wide' : undefined}>
          <svg className="wires" aria-hidden="true" width={layout.width} height={layout.height}>
            {layout.wires.map((w, i) => (
              <g key={i}>
                <path d={w.d} className={w.live ? 'live' : undefined} />
                <circle className="port" cx={w.from[0]} cy={w.from[1]} r={3} />
                <circle className="port" cx={w.to[0]} cy={w.to[1]} r={3} />
              </g>
            ))}
          </svg>
          {children}
        </div>
      </div>
    </div>
  );
}

