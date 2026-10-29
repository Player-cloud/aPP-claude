import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInline, parseMarkdown } from '../src/shared/markdown.ts';

test('v0.21.2: bold, italics, code and links in a summary become runs, not literal marks', () => {
  assert.deepEqual(parseInline('**The page:** `index.html` shows a *Welcome* banner'), [
    { kind: 'strong', text: 'The page:' },
    { kind: 'text', text: ' ' },
    { kind: 'code', text: 'index.html' },
    { kind: 'text', text: ' shows a ' },
    { kind: 'em', text: 'Welcome' },
    { kind: 'text', text: ' banner' },
  ]);
  assert.deepEqual(parseInline('**Run `npm test`**'), [
    { kind: 'strong', text: 'Run ' },
    { kind: 'code', text: 'npm test' },
  ]);
  assert.deepEqual(parseInline('See [the docs](https://example.com) now'), [{ kind: 'text', text: 'See the docs now' }]);
  assert.deepEqual(parseInline('2 * 3 * 4 and snake_case_name stay as written'), [{ kind: 'text', text: '2 * 3 * 4 and snake_case_name stay as written' }]);
  assert.deepEqual(parseInline('<script>alert(1)</script>'), [{ kind: 'text', text: '<script>alert(1)</script>' }]);
});

test('v0.21.2: a summary splits into paragraphs that keep their lines, headings and lists', () => {
  const blocks = parseMarkdown('Added the page.\n\n**Tests:** passed\n**Unresolved:** none\n\n## Notes\n- one\n- two\n  carried on\n1. first\n2) second\n\n---\n```\nnpm test\n```');
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['p', 'p', 'h', 'ul', 'ol', 'p'],
  );
  const [, lines, , list, numbered, fence] = blocks;
  assert.equal(lines!.kind === 'p' && lines!.lines.length, 2);
  assert.deepEqual(list!.kind === 'ul' && list!.items[1], [
    { kind: 'text', text: 'two' },
    { kind: 'text', text: ' ' },
    { kind: 'text', text: 'carried on' },
  ]);
  assert.equal(numbered!.kind === 'ol' && numbered!.items.length, 2);
  assert.deepEqual(fence, { kind: 'p', lines: [[{ kind: 'code', text: 'npm test' }]] });
  assert.deepEqual(parseMarkdown('\n\n'), []);
});
