import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactString, REDACTED } from '../src/core/redact.ts';

test('M1-AC8: secret-looking keys are redacted at any depth', () => {
  const out = redact({ user: 'jo', apiKey: 'abc', nested: { password: 'p', list: [{ token: 't' }] }, empty: { secret: '' } });
  assert.deepEqual(out, {
    user: 'jo',
    apiKey: REDACTED,
    nested: { password: REDACTED, list: [{ token: REDACTED }] },
    empty: { secret: '' },
  });
});

test('M1-AC8: known credential formats are redacted inside free text', () => {
  const samples = [
    'sk-ant-api03-abcdefghijklmnopqrstuv',
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
    'github_pat_11ABCDEFG0123456789_abcdef',
    'AKIAABCDEFGHIJKLMNOP',
    'Bearer abcdefghijklmnopqrstuvwxyz.123',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
  ];
  for (const secret of samples) {
    const text = redactString(`before ${secret} after`);
    assert.ok(!text.includes(secret), `leaked: ${secret}`);
    assert.match(text, /^before \[REDACTED\] after$/);
  }
});

test('ordinary text is left alone', () => {
  assert.equal(redactString('Build the token budget view for tasks'), 'Build the token budget view for tasks');
});
