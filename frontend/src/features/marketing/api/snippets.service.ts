/**
 * snippets.service.ts — canned-response snippets (GHL parity). A snippet is
 * either SHARED (visible to the whole workspace) or PRIVATE (only its author).
 * The `/shortcut` is typed in the inbox composer to insert `body`.
 */

import marketingApi from './marketingApi';

export interface MessageSnippet {
  id: string;
  ownerId: string | null; // null = shared
  shortcut: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface SnippetPayload {
  shortcut: string;
  title: string;
  body: string;
  shared?: boolean;
}

export const listSnippets = (): Promise<MessageSnippet[]> =>
  marketingApi.get('/snippets').then((r) => r.data);

export const createSnippet = (payload: SnippetPayload): Promise<MessageSnippet> =>
  marketingApi.post('/snippets', payload).then((r) => r.data);

export const updateSnippet = (
  id: string,
  payload: Partial<Omit<SnippetPayload, 'shortcut'>>,
): Promise<MessageSnippet> => marketingApi.patch(`/snippets/${id}`, payload).then((r) => r.data);

export const deleteSnippet = (id: string): Promise<{ message: string }> =>
  marketingApi.delete(`/snippets/${id}`).then((r) => r.data);
