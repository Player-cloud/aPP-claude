// The small part of Markdown that Claude's summaries use (v0.21.2): paragraphs,
// headings, bullet and numbered lists, **bold**, *italics*, `code` and links.
// It turns text into plain data, never HTML, so the renderer shows it with
// ordinary elements and nothing in a summary can run or load anything.

export type Inline = { kind: 'text' | 'strong' | 'em' | 'code'; text: string };

export type Block = { kind: 'p' | 'h'; lines: Inline[][] } | { kind: 'ul' | 'ol'; items: Inline[][] };

const INLINE = /`([^`\n]+)`|\*\*(.+?)\*\*|__(.+?)__|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])|(?<![\w_])_(?!\s)([^_\n]+?)_(?![\w_])|\[([^\]\n]+)\]\([^)\s]+\)/g;

/** Splits one line into plain, bold, italic and code runs. A link keeps only its text. */
export function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  const push = (kind: Inline['kind'], text: string) => {
    if (!text) return;
    const last = out.at(-1);
    if (last && last.kind === kind && kind === 'text') last.text += text;
    else out.push({ kind, text });
  };
  let at = 0;
  for (const m of line.matchAll(INLINE)) {
    push('text', line.slice(at, m.index));
    if (m[1] !== undefined) push('code', m[1]);
    else if (m[2] !== undefined || m[3] !== undefined) {
      // Bold may hold code or italics; keep the code, drop the inner marks.
      for (const part of parseInline(m[2] ?? m[3]!)) push(part.kind === 'code' ? 'code' : 'strong', part.text);
    } else if (m[4] !== undefined || m[5] !== undefined) push('em', m[4] ?? m[5]!);
    else push('text', m[6]!);
    at = m.index + m[0].length;
  }
  push('text', line.slice(at));
  return out;
}

const BULLET = /^\s*[-*•+]\s+(.*)$/;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*(?:[-*_]\s*){3,}$/;

/** Splits text into blocks. Lines in one paragraph stay separate lines, as Claude wrote them. */
export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  let fence: string[] | null = null;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(raw)) {
      if (fence) {
        blocks.push({ kind: 'p', lines: fence.map((l) => [{ kind: 'code', text: l }]) });
        fence = null;
      } else fence = [];
      continue;
    }
    if (fence) {
      fence.push(raw);
      continue;
    }
    const last = blocks.at(-1);
    if (!raw.trim() || RULE.test(raw)) {
      blocks.push({ kind: 'p', lines: [] });
      continue;
    }
    const h = HEADING.exec(raw);
    const b = BULLET.exec(raw);
    const n = NUMBER.exec(raw);
    if (h) blocks.push({ kind: 'h', lines: [parseInline(h[1]!)] });
    else if (b || n) {
      const kind = b ? 'ul' : 'ol';
      const item = parseInline((b ?? n)![1]!);
      if (last && last.kind === kind) last.items.push(item);
      else blocks.push({ kind, items: [item] });
    } else if (last && last.kind === 'p' && last.lines.length > 0) last.lines.push(parseInline(raw.trim()));
    else if (last && (last.kind === 'ul' || last.kind === 'ol') && /^\s{2,}\S/.test(raw)) {
      // An indented line carries on the list item above it.
      const item = last.items.at(-1)!;
      item.push({ kind: 'text', text: ' ' }, ...parseInline(raw.trim()));
    } else blocks.push({ kind: 'p', lines: [parseInline(raw.trim())] });
  }
  if (fence?.length) blocks.push({ kind: 'p', lines: fence.map((l) => [{ kind: 'code', text: l }]) });
  return blocks.filter((b) => ('items' in b ? b.items.length : b.lines.length) > 0);
}
