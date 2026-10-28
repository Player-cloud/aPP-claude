// UI audit for "Polish the UI" work (M9, FR-DESIGN-002/003, DEC-025). Before
// anything changes, the app reads the build's own worktree and records what the
// project already has: design tokens, components, styling approach, UI and
// animation libraries, breakpoints, themes and reduced-motion handling. The
// agent is told to work with these, and the review compares the change to them.
// Nothing is run; files are only read, and only tracked ones.

import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface UiAudit {
  /** Files that define design tokens (CSS custom properties, theme or token files, Tailwind config). */
  tokenFiles: string[];
  /** Number of CSS custom properties defined (`--name:`), across all style files. */
  tokenCount: number;
  /** A few of them, so the person and the agent can recognise the system. */
  tokenSample: string[];
  componentCount: number;
  componentDirs: string[];
  styling: string[];
  uiLibraries: string[];
  motionLibraries: string[];
  /** Media-query widths in use, in px, sorted. */
  breakpoints: number[];
  themes: string[];
  reducedMotion: { handled: boolean; files: string[] };
  /** Files that animate (transition, animation, @keyframes or a motion library). */
  motionFiles: string[];
  filesRead: number;
  notInspected: string[];
}

const MAX_FILE = 256 * 1024;
const MAX_FILES = 4_000;
const MAX_TOTAL = 24 * 1024 * 1024;

const STYLE = /\.(css|scss|sass|less|styl|pcss)$/i;
const COMPONENT = /\.(tsx|jsx|vue|svelte|astro)$/i;
const SCRIPT = /\.(tsx|jsx|ts|js|mjs|cjs|vue|svelte|astro)$/i;
const SKIP = /(^|\/)(node_modules|vendor|dist|build|out|coverage|\.next|\.nuxt)\//;
const TOKEN_FILE = /(^|\/)(tokens?|theme|themes|design-tokens|variables|colors?)\.(css|scss|less|ts|js|json|mjs)$|(^|\/)tailwind\.config\.[cm]?[jt]s$/i;

/** Libraries that set the look or the motion of an interface. Adding one is a decision the review asks about. */
export const UI_LIBRARIES = [
  'tailwindcss', 'bootstrap', '@mui/material', '@material-ui/core', 'antd', '@chakra-ui/react', '@mantine/core', 'styled-components', '@emotion/react',
  '@radix-ui/themes', 'semantic-ui-react', 'bulma', '@headlessui/react', 'daisyui', 'primereact', 'vuetify', 'element-plus', 'quasar', '@shadcn/ui',
];
export const MOTION_LIBRARIES = ['framer-motion', 'motion', 'gsap', 'animejs', '@react-spring/web', 'react-spring', 'lottie-web', 'lottie-react', '@formkit/auto-animate', 'popmotion', 'velocity-animate', 'react-transition-group', '@vueuse/motion'];

export const ANIMATES = /\b(transition|animation)\s*:|@keyframes\b|\banimate\s*\(|\bmotion\.\w+|\b(gsap|anime)\s*\(|\buseSpring\b/;
export const REDUCED_MOTION = /prefers-reduced-motion|useReducedMotion|reducedMotion/;

export function auditUi(root: string, tracked: string[]): UiAudit {
  const audit: UiAudit = {
    tokenFiles: [],
    tokenCount: 0,
    tokenSample: [],
    componentCount: 0,
    componentDirs: [],
    styling: [],
    uiLibraries: [],
    motionLibraries: [],
    breakpoints: [],
    themes: [],
    reducedMotion: { handled: false, files: [] },
    motionFiles: [],
    filesRead: 0,
    notInspected: [],
  };
  const styling = new Set<string>();
  const dirs = new Map<string, number>();
  const widths = new Set<number>();
  const themes = new Set<string>();
  const tokens = new Set<string>();
  let total = 0;
  let skippedLarge = 0;

  const candidates = tracked.filter((p) => !SKIP.test(p) && (STYLE.test(p) || SCRIPT.test(p) || TOKEN_FILE.test(p) || /(^|\/)package\.json$/.test(p)));
  if (candidates.length > MAX_FILES) audit.notInspected.push(`${candidates.length - MAX_FILES} style and source files beyond the first ${MAX_FILES}`);

  for (const path of candidates.slice(0, MAX_FILES)) {
    let text: string;
    try {
      const full = join(root, path);
      const st = lstatSync(full);
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE || total + st.size > MAX_TOTAL) {
        skippedLarge++;
        continue;
      }
      text = readFileSync(full, 'utf8');
      total += st.size;
    } catch {
      continue;
    }
    audit.filesRead++;

    if (/(^|\/)package\.json$/.test(path)) {
      const deps = dependencyNames(text);
      for (const d of deps) {
        if (UI_LIBRARIES.includes(d)) audit.uiLibraries.push(d);
        if (MOTION_LIBRARIES.includes(d)) audit.motionLibraries.push(d);
      }
      if (deps.includes('tailwindcss')) styling.add('Tailwind');
      if (deps.includes('styled-components') || deps.includes('@emotion/react')) styling.add('CSS-in-JS');
      continue;
    }

    const defs = [...text.matchAll(/(?:^|[;{\s])(--[a-zA-Z][\w-]*)\s*:/g)].map((m) => m[1]!);
    for (const d of defs) tokens.add(d);
    if (TOKEN_FILE.test(path) || defs.length >= 8) audit.tokenFiles.push(path);

    if (STYLE.test(path)) {
      styling.add(/\.module\.(css|scss|sass|less)$/i.test(path) ? 'CSS modules' : /\.(scss|sass)$/i.test(path) ? 'Sass' : /\.less$/i.test(path) ? 'Less' : 'CSS');
    }
    if (COMPONENT.test(path) && /\b(export\s+(default\s+)?function\s+[A-Z]|export\s+const\s+[A-Z]\w*\s*[:=]|<template>|<script)/.test(text)) {
      audit.componentCount++;
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
      dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
    }
    for (const m of text.matchAll(/@media[^{]*?\((?:min|max)-width\s*:\s*(\d+(?:\.\d+)?)(px|em|rem)\)/g)) {
      const n = Number(m[1]);
      widths.add(Math.round(m[2] === 'px' ? n : n * 16));
    }
    if (/prefers-color-scheme\s*:\s*dark|data-theme|\.dark\b|theme\s*===?\s*['"]dark/.test(text)) themes.add('dark');
    if (/prefers-color-scheme\s*:\s*light|theme\s*===?\s*['"]light|data-theme=["']?light/.test(text)) themes.add('light');
    if (REDUCED_MOTION.test(text)) audit.reducedMotion.files.push(path);
    if ((STYLE.test(path) || SCRIPT.test(path)) && ANIMATES.test(text)) audit.motionFiles.push(path);
  }

  if (skippedLarge) audit.notInspected.push(`${skippedLarge} ${skippedLarge === 1 ? 'file' : 'files'} over ${MAX_FILE / 1024} KB or past the ${MAX_TOTAL / 1024 / 1024} MB total`);
  audit.notInspected.push('How the interface looks and behaves when it runs (nothing is run)');
  audit.tokenCount = tokens.size;
  audit.tokenSample = [...tokens].slice(0, 12);
  audit.componentDirs = [...dirs].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([d]) => d);
  audit.styling = [...styling].sort();
  audit.uiLibraries = [...new Set(audit.uiLibraries)].sort();
  audit.motionLibraries = [...new Set(audit.motionLibraries)].sort();
  audit.breakpoints = [...widths].sort((a, b) => a - b);
  audit.themes = [...themes].sort();
  audit.reducedMotion.handled = audit.reducedMotion.files.length > 0;
  audit.tokenFiles = audit.tokenFiles.slice(0, 20);
  audit.motionFiles = audit.motionFiles.slice(0, 20);
  audit.reducedMotion.files = audit.reducedMotion.files.slice(0, 20);
  return audit;
}

export function dependencyNames(packageJson: string): string[] {
  try {
    const pkg = JSON.parse(packageJson) as Record<string, unknown>;
    return ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((k) => (pkg[k] && typeof pkg[k] === 'object' ? Object.keys(pkg[k] as object) : []));
  } catch {
    return [];
  }
}

/** A short text version for the agent's instructions and the report. */
export function describeAudit(a: UiAudit): string[] {
  const none = (xs: unknown[], word = 'none found') => (xs.length ? xs.join(', ') : word);
  return [
    `Design tokens: ${a.tokenCount} CSS custom properties${a.tokenFiles.length ? ` (defined in ${a.tokenFiles.slice(0, 5).join(', ')})` : ''}${a.tokenSample.length ? `, e.g. ${a.tokenSample.slice(0, 6).join(', ')}` : ''}`,
    `Components: ${a.componentCount}${a.componentDirs.length ? ` in ${a.componentDirs.join(', ')}` : ''}`,
    `Styling: ${none(a.styling)}`,
    `UI libraries: ${none(a.uiLibraries)}; animation libraries: ${none(a.motionLibraries)}`,
    `Breakpoints: ${a.breakpoints.length ? a.breakpoints.map((b) => `${b}px`).join(', ') : 'none found'}; themes: ${none(a.themes, 'no theme switch found')}`,
    `Reduced motion: ${a.reducedMotion.handled ? `handled in ${a.reducedMotion.files.slice(0, 3).join(', ')}` : 'not handled anywhere'}; files that animate: ${a.motionFiles.length}`,
  ];
}
