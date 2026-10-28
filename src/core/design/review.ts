// Review of "Polish the UI" work (M9, FR-DESIGN-002/003, DEC-025), on top of
// the build review. These checks read only the lines the change adds and
// compare them with the audit taken before it started. They point at things
// for the person to judge; they cannot tell whether the result looks good, and
// one risk always says what was not checked automatically.

import type { ChangedFile } from '../build/git.ts';
import { addedLines, type Risk } from '../build/review.ts';
import { ANIMATES, MOTION_LIBRARIES, REDUCED_MOTION, UI_LIBRARIES, type UiAudit } from './audit.ts';

const STYLE_OR_MARKUP = /\.(css|scss|sass|less|styl|pcss|tsx|jsx|vue|svelte|astro|html)$/i;
const COLOR = /#[0-9a-fA-F]{3,8}\b|\b(rgb|rgba|hsl|hsla)\(\s*\d/;
const LAYOUT_TRANSITION = /transition(-property)?\s*:[^;]*\b(all|width|height|top|left|right|bottom|margin[\w-]*|padding[\w-]*)\b/;
const LAYOUT_KEYFRAME = /^\s*(width|height|top|left|right|bottom|margin[\w-]*|padding[\w-]*)\s*:/;

export function reviewUi(input: { files: ChangedFile[]; patch: string; audit: UiAudit | null; motion: boolean }): Risk[] {
  const risks: Risk[] = [];
  if (!input.files.length) return risks;
  const added = addedLines(input.patch);
  const audit = input.audit;
  const all = [...added.values()].flat();

  // Libraries: a new look or motion framework is a decision, not a polish step.
  for (const [path, lines] of added) {
    if (!/(^|\/)package\.json$/.test(path)) continue;
    for (const line of lines) {
      const name = /^\s*"([^"]+)"\s*:\s*"/.exec(line)?.[1];
      if (!name) continue;
      const ui = UI_LIBRARIES.includes(name) && !audit?.uiLibraries.includes(name);
      const motion = MOTION_LIBRARIES.includes(name) && !audit?.motionLibraries.includes(name);
      if (ui || motion) {
        risks.push({ kind: 'new_ui_library', detail: `${path} adds ${name}, a new ${motion ? 'animation' : 'UI'} library. Say why the project's existing ${motion ? 'CSS motion' : 'styles'} were not enough.` });
      }
    }
  }

  // Raw colours where the project has tokens.
  if (audit && audit.tokenCount > 0) {
    const tokenFiles = new Set(audit.tokenFiles);
    const hits: string[] = [];
    for (const [path, lines] of added) {
      if (!STYLE_OR_MARKUP.test(path) || tokenFiles.has(path)) continue;
      for (const line of lines) if (COLOR.test(line) && !/^\s*--[\w-]+\s*:/.test(line)) hits.push(`${path}: ${line.trim().slice(0, 100)}`);
    }
    if (hits.length) {
      risks.push({ kind: 'off_token_value', detail: `${hits.length} added ${hits.length === 1 ? 'line uses' : 'lines use'} a raw colour although the project has ${audit.tokenCount} design tokens, e.g. ${hits[0]}` });
    }
  }

  // Accessibility patterns that are easy to spot in a diff.
  for (const [path, lines] of added) {
    if (!STYLE_OR_MARKUP.test(path)) continue;
    const text = lines.join('\n');
    for (const line of lines) {
      if (/<img\b/i.test(line) && !/\balt\s*=/.test(line)) risks.push({ kind: 'accessibility', detail: `${path}: an image without alt text: ${line.trim().slice(0, 100)}` });
      if (/<(div|span)\b[^>]*\bonClick\s*=/.test(line) && !/\brole\s*=/.test(line)) risks.push({ kind: 'accessibility', detail: `${path}: a clickable ${/<div/.test(line) ? 'div' : 'span'} without a role, which keyboards and screen readers miss; use a button.` });
      if (/tab[iI]ndex\s*=\s*\{?\s*["']?[1-9]/.test(line)) risks.push({ kind: 'accessibility', detail: `${path}: a positive tabindex changes the keyboard order: ${line.trim().slice(0, 100)}` });
    }
    if (/outline\s*:\s*(none|0)\b/.test(text) && !/:focus-visible|focus-visible/.test(text)) {
      risks.push({ kind: 'accessibility', detail: `${path} removes the focus outline without adding a :focus-visible style, so keyboard focus may become invisible.` });
    }
  }

  // Motion (FR-DESIGN-003).
  const animates = all.some((l) => ANIMATES.test(l));
  if (animates && !audit?.reducedMotion.handled && !all.some((l) => REDUCED_MOTION.test(l))) {
    risks.push({ kind: 'motion_reduced', detail: 'The change adds animation, but nothing in the project or the change respects prefers-reduced-motion.' });
  }
  for (const [path, lines] of added) {
    const hit = lines.find((l) => LAYOUT_TRANSITION.test(l)) ?? (lines.some((l) => /@keyframes/.test(l)) ? lines.find((l) => LAYOUT_KEYFRAME.test(l)) : undefined);
    if (hit) risks.push({ kind: 'motion_performance', detail: `${path} animates a layout property, which is slow to render; prefer transform and opacity: ${hit.trim().slice(0, 100)}` });
  }

  risks.push({
    kind: 'manual_check',
    detail: `Not checked automatically: how the screens look at 1024, 1280 and 1920 px, in each theme, with loading, error and empty states, and along the main user journeys.${input.motion ? ' For motion, also its purpose, timing and easing, exit behaviour, and how it looks with reduced motion on.' : ''} Check them and say what you saw in the note.`,
  });
  return risks;
}
