// Redaction at the storage boundary (FR-SEC-002). Applied to anything written
// to the workspace database so credentials never land in events or notes.
// This is a safety net, not a secrets store: real credentials will live in the
// OS credential store (DEC-006).

export const REDACTED = '[REDACTED]';

const SECRET_KEY = /(pass(word|wd)?|secret|token|api[-_]?key|authorization|credential|private[-_]?key|cookie)/i;

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic API keys
  /sk-[A-Za-z0-9]{20,}/g, // generic "sk-" provider keys
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g, // AWS access key IDs
  /xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

export function redact<T>(value: T): T {
  return redactValue(value, 0) as T;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 20) return REDACTED; // refuse pathological nesting rather than recurse forever
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) && inner != null && inner !== '' ? REDACTED : redactValue(inner, depth + 1);
    }
    return out;
  }
  return value;
}

const PRIVATE_KEY_START = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * Lines of one file that hold a known credential format, as "path:line".
 * The value itself is never returned (M7 ship-check, M8 assessment).
 */
export function credentialLines(path: string, text: string): string[] {
  const lines = text.split(/\r?\n/);
  const hits: string[] = [];
  // Private keys span lines, so look at the whole file for those.
  if (PRIVATE_KEY_START.test(text) && redactString(text) !== text) {
    hits.push(`${path}:${lines.findIndex((l) => PRIVATE_KEY_START.test(l)) + 1}`);
  }
  lines.forEach((line, i) => {
    if (redactString(line) !== line) hits.push(`${path}:${i + 1}`);
  });
  return [...new Set(hits)];
}
