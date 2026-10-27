// Thin wrapper over the preload bridge: unwraps Result<T> and throws a typed
// error so views can show the main process's message verbatim.

import type { ApiError, IapApi, Result } from '../shared/api.ts';

declare global {
  interface Window {
    iap: IapApi;
  }
}

export class CallError extends Error {
  readonly code: string;
  constructor(error: ApiError) {
    super(error.message);
    this.code = error.code;
  }
}

export async function call<T>(promise: Promise<Result<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new CallError(result.error);
  return result.value;
}

export const iap = (): IapApi => window.iap;
