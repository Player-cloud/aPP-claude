// Where application data lives (FR-APP-001: documented storage locations).
// IAP_HOME overrides everything; otherwise follow each OS's convention.

import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

export const APP_DIR_NAME = 'IterativePlatform';

export function resolveAppHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.IAP_HOME?.trim()) return env.IAP_HOME.trim();
  // Join with the target platform's separator, not the host's.
  if (platform === 'win32') return win32.join(env.APPDATA ?? win32.join(home, 'AppData', 'Roaming'), APP_DIR_NAME);
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', APP_DIR_NAME);
  return posix.join(env.XDG_DATA_HOME ?? posix.join(home, '.local', 'share'), APP_DIR_NAME);
}

export interface AppPaths {
  home: string;
  db: string;
  projects: string;
  /** One git worktree per build (M6). */
  worktrees: string;
  /** Copies of Learning Studio references (M9). */
  references: string;
}

export function appPaths(home: string): AppPaths {
  return { home, db: join(home, 'iap.db'), projects: join(home, 'projects'), worktrees: join(home, 'worktrees'), references: join(home, 'references') };
}
