import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAppHome } from '../src/core/paths.ts';

test('M1-AC9: IAP_HOME overrides the default location', () => {
  assert.equal(resolveAppHome({ IAP_HOME: '/data/iap' }, 'linux', '/home/u'), '/data/iap');
});

test('M1-AC9: per-OS defaults follow platform conventions', () => {
  assert.equal(resolveAppHome({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Roaming\\IterativePlatform');
  assert.equal(resolveAppHome({}, 'win32', 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Roaming\\IterativePlatform');
  assert.equal(resolveAppHome({}, 'darwin', '/Users/u'), '/Users/u/Library/Application Support/IterativePlatform');
  assert.equal(resolveAppHome({}, 'linux', '/home/u'), '/home/u/.local/share/IterativePlatform');
  assert.equal(resolveAppHome({ XDG_DATA_HOME: '/xdg' }, 'linux', '/home/u'), '/xdg/IterativePlatform');
});
