// Where the Anthropic API key lives (DEC-006, FR-SEC-002). The key is
// encrypted with the operating system's credential protection (Windows DPAPI
// through Electron safeStorage) and kept in its own file, never in the
// database, logs or audit events. Nothing ever sends it back to the renderer.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface KeyStore {
  /** False when the OS offers no encryption; then no key can be stored. */
  available(): boolean;
  has(): boolean;
  get(): string | null;
  set(key: string): void;
  clear(): void;
}

/** The part of Electron's safeStorage used here (kept as an interface so this file has no Electron import). */
export interface Encryptor {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class EncryptedFileKeyStore implements KeyStore {
  private readonly file: string;
  private readonly crypto: Encryptor;

  constructor(file: string, crypto: Encryptor) {
    this.file = file;
    this.crypto = crypto;
  }

  available(): boolean {
    return this.crypto.isEncryptionAvailable();
  }

  has(): boolean {
    return existsSync(this.file);
  }

  get(): string | null {
    if (!this.has() || !this.available()) return null;
    try {
      return this.crypto.decryptString(readFileSync(this.file));
    } catch {
      // Encrypted for another Windows user or machine: treat as not set.
      return null;
    }
  }

  set(key: string): void {
    if (!this.available()) throw new Error('This computer offers no secure storage for the key.');
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, this.crypto.encryptString(key), { mode: 0o600 });
  }

  clear(): void {
    rmSync(this.file, { force: true });
  }
}

/** For tests and the CLI's environment-variable key: nothing touches the disk. */
export class MemoryKeyStore implements KeyStore {
  private key: string | null;
  constructor(key: string | null = null) {
    this.key = key;
  }
  available(): boolean {
    return true;
  }
  has(): boolean {
    return this.key !== null;
  }
  get(): string | null {
    return this.key;
  }
  set(key: string): void {
    this.key = key;
  }
  clear(): void {
    this.key = null;
  }
}
