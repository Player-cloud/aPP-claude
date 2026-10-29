import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SHOTS = join(ROOT, 'e2e', 'screenshots');

export function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'iap-e2e-'));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export async function launch(home: string, extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const electronPath = (await import('electron')).default as unknown as string;
  // Never scan the real machine's Claude Code setup from tests: point at an empty folder unless a test supplies one.
  const env = { ...process.env, IAP_HOME: home, CLAUDE_CONFIG_DIR: join(home, 'no-claude'), ...extraEnv } as Record<string, string>;
  delete env.NODE_OPTIONS; // Electron rejects some Node options (e.g. --use-openssl-ca)
  const app = await electron.launch({
    executablePath: electronPath,
    args: [ROOT, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('#main');
  return { app, page };
}

export interface ContrastFailure {
  text: string;
  ratio: number;
  needed: number;
}

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: RGB) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const over = (top: RGBA, under: RGB): RGB => [0, 1, 2].map((i) => top[i]! * top[3] + under[i]! * (1 - top[3])) as RGB;
const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

/**
 * Checks every visible piece of text against what is really behind it (M17 N,
 * DEC-034). Translucent layers are blended down to the sky, and the sky counts
 * as both the darkest and the lightest pixel under that text, read from a
 * capture of the window with the app hidden, so text must be readable wherever
 * it sits on the photo. Text on a gradient or an image it cannot work out is
 * skipped; disabled controls are exempt, as in WCAG 1.4.3.
 */
export async function contrastFailures(app: ElectronApplication, page: Page): Promise<{ failures: ContrastFailure[]; checked: number }> {
  await page.evaluate(() => document.body.style.setProperty('visibility', 'hidden'));
  // Two frames, so the capture never still holds the app's own pixels.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(250);
  const shot = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const img = await win.webContents.capturePage();
    const scale = img.getSize().width / win.getContentSize()[0]!;
    return { ...img.getSize(), scale, data: img.toBitmap().toString('base64') };
  });
  await page.evaluate(() => document.body.style.removeProperty('visibility'));
  await page.waitForTimeout(150);
  const px = Buffer.from(shot.data, 'base64'); // BGRA
  const skyUnder = (box: { x: number; y: number; w: number; h: number }): RGB[] => {
    let dark: [number, RGB] = [2, [0, 0, 0]];
    let light: [number, RGB] = [-1, [255, 255, 255]];
    const x0 = Math.max(0, Math.floor(box.x * shot.scale));
    const y0 = Math.max(0, Math.floor(box.y * shot.scale));
    const x1 = Math.min(shot.width, Math.ceil((box.x + box.w) * shot.scale));
    const y1 = Math.min(shot.height, Math.ceil((box.y + box.h) * shot.scale));
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const i = (y * shot.width + x) * 4;
        const rgb: RGB = [px[i + 2]!, px[i + 1]!, px[i]!];
        const l = luminance(rgb);
        if (l < dark[0]) dark = [l, rgb];
        if (l > light[0]) light = [l, rgb];
      }
    }
    return dark[0] > 1 ? [] : [dark[1], light[1]];
  };
  const texts = await page.evaluate(() => {
    const parse = (c: string): [number, number, number, number] | null => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return null;
      const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
    };
    const out: { text: string; box: { x: number; y: number; w: number; h: number }; fg: [number, number, number, number]; layers: [number, number, number, number][]; solid: boolean; needed: number }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !n.textContent?.trim()) continue;
      seen.add(el);
      if (el.closest('[aria-hidden="true"], svg, .rail-tip, .preview-shot, :disabled, [aria-disabled="true"]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) continue;
      const style = getComputedStyle(el);
      if (style.visibility !== 'visible') continue;
      const fg = parse(style.color);
      if (!fg) continue;
      const layers: [number, number, number, number][] = [];
      let opacity = 1;
      let unknown = false;
      let solid = false;
      // The sky is painted on the page itself, so the walk stops above it.
      for (let a: Element | null = el; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
        const s = getComputedStyle(a);
        opacity *= Number(s.opacity);
        if (s.backgroundImage !== 'none') {
          unknown = true;
          break;
        }
        const bg = parse(s.backgroundColor);
        if (bg && bg[3] > 0) {
          layers.push(bg);
          if (bg[3] >= 0.999) {
            solid = true;
            break;
          }
        }
      }
      if (unknown || opacity === 0) continue;
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      out.push({ text: n.textContent.trim().slice(0, 60), box: { x: r.x, y: r.y, w: r.width, h: r.height }, fg: [fg[0], fg[1], fg[2], fg[3] * opacity], layers, solid, needed: large ? 3 : 4.5 });
    }
    return out;
  });
  const failures: ContrastFailure[] = [];
  for (const t of texts) {
    const bases: RGB[] = t.solid ? [[0, 0, 0]] : skyUnder(t.box);
    let worst = Infinity;
    for (const base of bases) {
      let bg = base;
      for (const layer of t.layers.slice().reverse()) bg = over(layer, bg);
      worst = Math.min(worst, contrast(over(t.fg, bg), bg));
    }
    if (worst < t.needed) failures.push({ text: t.text, ratio: Math.round(worst * 100) / 100, needed: t.needed });
  }
  return { failures, checked: texts.length };
}
