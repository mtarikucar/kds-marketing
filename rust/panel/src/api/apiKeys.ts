import { request, seg } from './client';
import type { KeyOut, KeySummary, Permission } from './types';

/** `GET /api/api-keys`: active and revoked keys, never their plaintext. */
export function listKeys(): Promise<KeySummary[]> {
  return request('GET', '/api/api-keys');
}

/** `POST /api/api-keys`: the answer holds the key's plaintext, shown once. */
export function createKey(input: { name: string; scopes: Permission[] }): Promise<KeyOut> {
  return request('POST', '/api/api-keys', { body: input });
}

/** `DELETE /api/api-keys/{key_id}`. */
export function revokeKey(keyId: string): Promise<void> {
  return request('DELETE', `/api/api-keys/${seg(keyId)}`);
}
