// Electron main process. Owns the workspace and is the only process with
// filesystem and database access. The renderer talks to it through the narrow,
// validated IPC surface in service.ts (FR-SEC-001, FR-SEC-005).

import { app, BrowserWindow, ipcMain, Menu, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAppHome } from '../core/paths.ts';
import { channel, IAP_METHODS } from '../shared/api.ts';
import { EncryptedFileKeyStore } from './keystore.ts';
import { AppService } from './service.ts';

const RENDERER_HTML = join(__dirname, 'renderer', 'index.html');
const RENDERER_URL = pathToFileURL(RENDERER_HTML).href;

const home = resolveAppHome();
const smokeTest = process.argv.includes('--smoke-test');

// `--smoke-test`: open the workspace, report health, exit. Used by CI to prove
// that an installed build launches and can read and write its data directory
// (FR-APP-001) without needing a display.
if (smokeTest) {
  app.whenReady().then(() => {
    let code = 1;
    let report: unknown;
    try {
      const service = new AppService(home, app.getVersion());
      const status = service.status();
      const health = service.handlers.health();
      report = { status, health, versions: { electron: process.versions.electron, node: process.versions.node } };
      code = status.state === 'ready' && health.ok && health.value.integrity === 'ok' ? 0 : 1;
      service.close();
    } catch (e) {
      report = { error: String(e) };
    }
    const json = JSON.stringify(report, null, 2);
    if (process.env.IAP_SMOKE_OUT) writeFileSync(process.env.IAP_SMOKE_OUT, json);
    else console.log(json);
    app.exit(code);
  });
} else if (!app.requestSingleInstanceLock()) {
  // A second instance would open the same SQLite file; focus the first instead.
  app.quit();
} else {
  let service: AppService;
  let win: BrowserWindow | null = null;

  const fromOurUi = (event: IpcMainInvokeEvent) => event.senderFrame?.url === RENDERER_URL;

  const createWindow = () => {
    win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 960,
      minHeight: 600,
      backgroundColor: '#0b1020',
      title: 'Iterative Platform',
      show: false,
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    win.once('ready-to-show', () => win?.show());
    // The UI is a local, single-page app: never navigate away or open windows.
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url);
      return { action: 'deny' };
    });
    void win.loadFile(RENDERER_HTML);
    win.on('closed', () => (win = null));
  };

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    // Installed builds get no default menu (and so no dev tools shortcut).
    if (app.isPackaged) Menu.setApplicationMenu(null);
    // No camera, microphone, notifications etc. until a feature needs them.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    service = new AppService(home, app.getVersion(), {
      keyStore: new EncryptedFileKeyStore(join(home, 'secrets', 'anthropic-api-key.bin'), {
        // On Linux without a keyring Electron falls back to a fixed password, which is not real protection.
        isEncryptionAvailable: () =>
          safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
        encryptString: (plain) => safeStorage.encryptString(plain),
        decryptString: (encrypted) => safeStorage.decryptString(encrypted),
      }),
    });
    for (const method of IAP_METHODS) {
      ipcMain.handle(channel(method), (event, ...args: unknown[]) => {
        if (!fromOurUi(event)) return { ok: false, error: { code: 'FORBIDDEN', message: 'Unknown caller.' } };
        return service.handlers[method](...args);
      });
    }
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    service?.close();
    if (process.platform !== 'darwin') app.quit();
  });
}
