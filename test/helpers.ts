import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tempHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'iap-test-'));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
