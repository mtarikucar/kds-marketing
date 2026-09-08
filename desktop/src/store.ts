import { app, safeStorage } from 'electron';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';

export interface StoredConfig {
  baseUrl: string;
  deviceId: string;
  serial: string;
  /** Never present on disk in the clear — see below. */
  apiKey?: string;
}

interface OnDisk {
  baseUrl: string;
  deviceId: string;
  serial: string;
  /** base64 of the OS-encrypted key, or absent. */
  apiKeyEnc?: string;
  /** True when this machine could not encrypt and the user was told. We store
   *  the FACT rather than the key: a plaintext key in a JSON file next to a
   *  tool that can drive somebody's WhatsApp is not a trade-off worth making
   *  silently. */
  apiKeyUnavailable?: boolean;
}

function file(): string {
  return join(app.getPath('userData'), 'jeeta-bridge.json');
}

/**
 * Where the API key lives.
 *
 * `safeStorage` hands encryption to the OS keychain — Keychain on macOS, DPAPI
 * on Windows, libsecret on Linux — so the ciphertext on disk is useless on
 * another machine and useless to another user account on this one. That
 * matters more here than in most desktop apps: this key is not a login, it is
 * standing permission to make a phone do things under the workspace's name.
 *
 * When the OS cannot encrypt (a Linux box with no keyring, which is common on
 * a fresh server-ish install) we do NOT fall back to plaintext. The app asks
 * for the key again each launch and says why. That is worse to use and better
 * to lose.
 */
export async function load(): Promise<StoredConfig & { keyMissing: boolean }> {
  let raw: OnDisk;
  try {
    raw = JSON.parse(await readFile(file(), 'utf8')) as OnDisk;
  } catch {
    return { baseUrl: '', deviceId: '', serial: '', keyMissing: true };
  }

  let apiKey: string | undefined;
  if (raw.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      apiKey = safeStorage.decryptString(Buffer.from(raw.apiKeyEnc, 'base64'));
    } catch {
      // A key encrypted by a different OS user or a reinstalled keychain. Not
      // an error to show as a crash — just a key we no longer have.
      apiKey = undefined;
    }
  }
  return {
    baseUrl: raw.baseUrl ?? '',
    deviceId: raw.deviceId ?? '',
    serial: raw.serial ?? '',
    apiKey,
    keyMissing: !apiKey,
  };
}

export async function save(cfg: StoredConfig): Promise<{ keyPersisted: boolean }> {
  const canEncrypt = safeStorage.isEncryptionAvailable();
  const out: OnDisk = {
    baseUrl: cfg.baseUrl,
    deviceId: cfg.deviceId,
    serial: cfg.serial,
    ...(cfg.apiKey && canEncrypt
      ? { apiKeyEnc: safeStorage.encryptString(cfg.apiKey).toString('base64') }
      : {}),
    ...(cfg.apiKey && !canEncrypt ? { apiKeyUnavailable: true } : {}),
  };
  await mkdir(dirname(file()), { recursive: true });
  // 0600: the file still holds a server address and a device id, and on a
  // shared machine those are enough to tell someone which phone to go looking
  // for.
  await writeFile(file(), JSON.stringify(out, null, 2), { mode: 0o600 });
  return { keyPersisted: Boolean(cfg.apiKey && canEncrypt) };
}
