import { crc32, deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tempHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'iap-test-'));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** A real, viewable PNG of one colour (or a vertical gradient between two), made without any image library. */
export function solidPng(width: number, height: number, top: [number, number, number], bottom = top): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const f = height > 1 ? y / (height - 1) : 0;
    const rgb = top.map((c, i) => Math.round(c + (bottom[i]! - c) * f));
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
    rows.push(row);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/** The version the platform stand-in claims (M13 tests). */
export const PLATFORM_VERSION = '0.17.0';
const VERSION = PLATFORM_VERSION;
const BUGGY = 'export const sum = (a, b) => a - b;\n';

function gitIn(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
}

/** A small repository shaped like the app's: same package name, the scripts the mandatory checks call, a lockfile. */
export function platformRepo(root: string, name = 'iterative-platform'): string {
  const repo = join(root, 'source');
  for (const d of ['src', 'test', 'scripts']) mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, version: VERSION, private: true, type: 'module', scripts: { typecheck: 'node scripts/types.mjs', test: 'node test/sum.test.mjs', 'test:e2e': 'node test/flow.mjs' } }, null, 2));
  writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ name, version: VERSION, lockfileVersion: 3, requires: true, packages: { '': { name, version: VERSION } } }, null, 2));
  // No network: the stand-in has no dependencies, so nothing needs auditing or downloading.
  writeFileSync(join(repo, '.npmrc'), 'audit=false\nfund=false\nupdate-notifier=false\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'scripts', 'types.mjs'), "console.log('types ok');\n");
  writeFileSync(join(repo, 'src', 'sum.mjs'), BUGGY);
  writeFileSync(join(repo, 'test', 'sum.test.mjs'), "import assert from 'node:assert/strict';\nimport { sum } from '../src/sum.mjs';\nassert.equal(sum(2, 3), 5);\nconsole.log('# tests 1');\n");
  writeFileSync(join(repo, 'test', 'flow.mjs'), "import { sum } from '../src/sum.mjs';\nif (sum(1, 1) !== 2) { console.error('flow broken'); process.exit(1); }\nconsole.log('# tests 1');\n");
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

