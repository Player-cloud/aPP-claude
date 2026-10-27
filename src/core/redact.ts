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
