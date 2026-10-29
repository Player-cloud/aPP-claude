// Light syntax colouring for diff lines (M16): keywords, strings, numbers and
// comments, one line at a time. It only colours; it never changes the text.
import type { ReactNode } from 'react';

type Lang = 'c' | 'py' | 'sh' | 'css' | 'markup' | 'plain';

const EXT: Record<string, Lang> = {
  ts: 'c', tsx: 'c', js: 'c', jsx: 'c', mjs: 'c', cjs: 'c', json: 'c', java: 'c', cs: 'c', go: 'c', rs: 'c', c: 'c', h: 'c', cpp: 'c', kt: 'c', swift: 'c', php: 'c',
  py: 'py', rb: 'py', yml: 'sh', yaml: 'sh', toml: 'sh', sh: 'sh', ps1: 'sh', env: 'sh',
  css: 'css', scss: 'css', less: 'css',
  html: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', svelte: 'markup', md: 'plain', txt: 'plain',
};

const KEYWORDS: Record<Lang, Set<string>> = {
  c: new Set('const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of interface type enum public private protected static readonly void null undefined true false this super yield fn let mut pub struct impl use match package func'.split(' ')),
  py: new Set('def return if elif else for while in not and or import from as class try except finally raise with lambda None True False pass yield async await self end do then module require'.split(' ')),
  sh: new Set('if then else fi for do done case esac function export echo true false null'.split(' ')),
  css: new Set('important media supports keyframes root'.split(' ')),
  markup: new Set<string>(),
  plain: new Set<string>(),
};

export function langOf(path: string): Lang {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  return EXT[ext] ?? 'plain';
}

const TOKEN = /(\/\/.*$|#.*$|\/\*.*?(?:\*\/|$)|<!--.*?(?:-->|$)|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?|\b\d[\d_.]*\b|<\/?[A-Za-z][\w-]*|[A-Za-z_$][\w$-]*)/g;

/** The line's code (without its +/- marker) as coloured spans. */
export function highlight(code: string, lang: Lang): ReactNode[] {
  if (lang === 'plain' || code.length > 2_000) return [code];
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of code.matchAll(TOKEN)) {
    const t = m[0];
    const at = m.index ?? 0;
    let cls: string | null = null;
    if (t.startsWith('//') || t.startsWith('/*')) cls = lang === 'c' || lang === 'css' ? 'hl-c' : null;
    else if (t.startsWith('#')) cls = lang === 'py' || lang === 'sh' ? 'hl-c' : null;
    else if (t.startsWith('<!--')) cls = lang === 'markup' ? 'hl-c' : null;
    else if (t[0] === '"' || t[0] === "'" || t[0] === '`') cls = 'hl-s';
    else if (/^\d/.test(t)) cls = 'hl-n';
    else if (t[0] === '<') cls = lang === 'markup' || lang === 'c' ? 'hl-t' : null;
    else if (KEYWORDS[lang].has(t)) cls = 'hl-k';
    if (!cls) continue;
    if (at > last) out.push(code.slice(last, at));
    out.push(
      <span key={i++} className={cls}>
        {t}
      </span>,
    );
    last = at + t.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}
