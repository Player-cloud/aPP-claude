// Exposes exactly the IapApi methods to the renderer as `window.iap`.
// No Node or Electron objects cross the bridge, only plain data.

import { contextBridge, ipcRenderer } from 'electron';
import { channel, IAP_METHODS, type IapApi } from '../shared/api.ts';

const api = Object.fromEntries(
  IAP_METHODS.map((method) => [method, (...args: unknown[]) => ipcRenderer.invoke(channel(method), ...args)]),
) as unknown as IapApi;

contextBridge.exposeInMainWorld('iap', Object.freeze(api));
