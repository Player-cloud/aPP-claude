// Where application data lives (FR-APP-001: documented storage locations).
// IAP_HOME overrides everything; otherwise follow each OS's convention.

import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_DIR_NAME = 'IterativePlatform';

export function resolveAppHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.IAP_HOME?.trim()) return env.IAP_HOME.trim();
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), APP_DIR_NAME);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_DIR_NAME);
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), APP_DIR_NAME);
}

export interface AppPaths {
  home: string;
  db: string;
  projects: string;
}

export function appPaths(home: string): AppPaths {
  return { home, db: join(home, 'iap.db'), projects: join(home, 'projects') };
}
