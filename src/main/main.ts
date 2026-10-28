// Electron main process. Owns the workspace and is the only process with
// filesystem and database access. The renderer talks to it through the narrow,
// validated IPC surface in service.ts (FR-SEC-001, FR-SEC-005).

import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAppHome } from '../core/paths.ts';
import { fixtureFetcher } from '../core/updates/updates.ts';
import { channel, IAP_METHODS } from '../shared/api.ts';
import { EncryptedFileKeyStore } from './keystore.ts';
import { serveReference } from './references.ts';
import { AppService } from './service.ts';

const RENDERER_HTML = join(__dirname, 'renderer', 'index.html');
const RENDERER_URL = pathToFileURL(RENDERER_HTML).href;

const home = resolveAppHome();

// M9: the Learning Studio shows its copies of reference files through this
// scheme (iap-ref://ref/<id>). Only ids the workspace knows are served, and only
// from the app's own references folder, so a page cannot read arbitrary files.
const REF_SCHEME = 'iap-ref';
protocol.registerSchemesAsPrivileged([{ scheme: REF_SCHEME, privileges: { standard: true, secure: true, stream: true } }]);

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
      // M6: check commands run with the person's rights, so they approve them in a native dialog the page cannot click.
      confirmChecks: async ({ title, commands, folder }) => {
        const options = {
          type: 'warning' as const,
          title: 'Run check commands?',
          message: `"${title}" will run these commands on your computer, with your permissions:`,
          detail: `${commands.map((c) => `  ${c}`).join('\n')}\n\nThey run in a separate copy (git worktree) of ${folder}: now, when the agent asks, and whenever the work is verified. Only approve commands you trust.`,
          buttons: ['Run these checks', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        };
        const parent = BrowserWindow.getFocusedWindow();
        const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
        return response === 0;
      },
      // Tests replace the claude executable with a stand-in (a JSON array: program and arguments).
      claudeCommand: process.env.IAP_CLAUDE_COMMAND ? (JSON.parse(process.env.IAP_CLAUDE_COMMAND) as string[]) : undefined,
      // Tests answer the update sources from a file instead of the network (M12).
      fetcher: process.env.IAP_UPDATE_FIXTURE ? fixtureFetcher(process.env.IAP_UPDATE_FIXTURE) : undefined,
      // M11: changes to the person's Claude Code setup are approved in a native dialog the page cannot click.
      confirmCleanup: async ({ title, lines }) => {
        const options = {
          type: 'warning' as const,
          title: 'Change your Claude Code setup?',
          message: title,
          detail: `${lines.join('\n')}\n\nOnly this exact change is made. The app scans again afterwards and records whether it worked.`,
          buttons: ['Make this change', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        };
        const parent = BrowserWindow.getFocusedWindow();
        const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
        return response === 0;
      },
      // M13: protected platform changes and database restores are approved in a native dialog the page cannot click.
      confirmAction: async ({ title, lines, button }) => {
        const options = {
          type: 'warning' as const,
          title: 'Approve this change?',
          message: title,
          detail: lines.join('\n'),
          buttons: [button, 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        };
        const parent = BrowserWindow.getFocusedWindow();
        const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
        return response === 0;
      },
      // M9: reference files come only from a native picker, never from a path the page supplies.
      pickFiles: async () => {
        const options = {
          title: 'Add design references',
          buttonLabel: 'Add to Learning Studio',
          properties: ['openFile' as const, 'multiSelections' as const],
          filters: [
            { name: 'Images and videos', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm'] },
            { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
            { name: 'Videos', extensions: ['mp4', 'mov', 'webm'] },
          ],
        };
        const parent = BrowserWindow.getFocusedWindow();
        const { canceled, filePaths } = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
        return canceled ? [] : filePaths;
      },
      // M14: lesson sources and the skill export folder come only from native dialogs, too.
      pickSources: async () => {
        const options = {
          title: 'Add sources to learn from',
          buttonLabel: 'Add',
          properties: ['openFile' as const, 'multiSelections' as const],
          filters: [
            { name: 'Transcripts, notes and PDFs', extensions: ['vtt', 'srt', 'txt', 'md', 'pdf'] },
            { name: 'Transcripts', extensions: ['vtt', 'srt', 'txt'] },
            { name: 'PDF', extensions: ['pdf'] },
          ],
        };
        const parent = BrowserWindow.getFocusedWindow();
        const { canceled, filePaths } = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
        return canceled ? [] : filePaths;
      },
      pickFolder: async ({ title, button }) => {
        const options = { title, buttonLabel: button, properties: ['openDirectory' as const, 'createDirectory' as const] };
        const parent = BrowserWindow.getFocusedWindow();
        const { canceled, filePaths } = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
        return canceled ? null : (filePaths[0] ?? null);
      },
    });
    protocol.handle(REF_SCHEME, (request) => {
      const url = new URL(request.url);
      const file = url.host === 'ref' ? service.referenceFile(url.pathname.slice(1)) : null;
      if (!file) return new Response('Not found', { status: 404 });
      try {
        return serveReference(file, request.headers.get('Range'));
      } catch {
        return new Response('Not found', { status: 404 });
      }
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
