import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SHOTS = join(ROOT, 'e2e', 'screenshots');

export function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'iap-e2e-'));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const electronPath = (await import('electron')).default as unknown as string;
  const env = { ...process.env, IAP_HOME: home } as Record<string, string>;
  delete env.NODE_OPTIONS; // Electron rejects some Node options (e.g. --use-openssl-ca)
  const app = await electron.launch({
    executablePath: electronPath,
    args: [ROOT, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('#main');
  return { app, page };
}
