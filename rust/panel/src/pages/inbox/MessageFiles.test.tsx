import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt } from '@/test/render';
import { WS_ID } from '@/test/fixtures';
import { inboxAnswers } from '@/test/inbox';
import type { InboxAttachment } from '@/api/types';

const base = {
  conversation_id: 'conv-1',
  workspace_id: WS_ID,
  direction: 'inbound',
  author: 'customer',
  status: 'received',
  external_id: null,
  cost_minor: null,
};

function file(over: Partial<InboxAttachment>): InboxAttachment {
  return {
    index: 0,
    kind: 'image',
    file_id: 'file-1',
    filename: '',
    declared_mime: 'image/jpeg',
    mime: 'image/jpeg',
    size_bytes: 1200,
    width: 640,
    height: 480,
    state: 'stored',
    reason: null,
    skip_reason: null,
    ...over,
  };
}

function thread(items: unknown[]) {
  return {
    ...inboxAnswers,
    'GET /api/inbox/conversations/conv-1/messages': { items, next_cursor: null },
    'GET /api/inbox/messages/m-photo/media': {
      ...file({}),
      message_id: 'm-photo',
      url: 'https://files.example/files/file-1?signature=x',
      expires_at: '2026-10-23T10:10:00Z',
    },
    'GET /api/inbox/messages/m-doc/media': {
      ...file({ kind: 'document', filename: 'teklif.pdf', file_id: 'file-2' }),
      message_id: 'm-doc',
      url: 'https://files.example/files/file-2?purpose=attachment',
      expires_at: '2026-10-23T10:10:00Z',
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Files in the thread', () => {
  it('shows a customer photo small, in its place, and larger on click', async () => {
    const calls = mockFetch(
      thread([
        { ...base, id: 'm-photo', body: '[image]\nBu tarzda olsun', at: '2026-10-23T10:00:00Z', attachments: [file({})] },
      ]),
    );
    renderAt('/inbox/conv-1');
    const list = await screen.findByRole('list', { name: 'Mesajlar' });
    const photo = await within(list).findByRole('img', { name: 'Fotoğraf' });
    expect(photo).toHaveAttribute('src', 'https://files.example/files/file-1?signature=x');
    // The marker line is not shown; the caption is.
    expect(within(list).getByText('Bu tarzda olsun')).toBeInTheDocument();
    expect(within(list).queryByText(/\[image\]/)).not.toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/api/inbox/messages/m-photo/media')).toHaveLength(1);
    expect(calls.find((c) => c.path === '/api/inbox/messages/m-photo/media')?.search).toBe('?index=0');
    await userEvent.click(within(list).getByRole('button', { name: 'Fotoğrafı büyüt' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('img', { name: 'Fotoğraf' })).toHaveAttribute(
      'src',
      'https://files.example/files/file-1?signature=x',
    );
  });

  it('offers a document as a named download, asked for only on click', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const calls = mockFetch(
      thread([
        {
          ...base,
          id: 'm-doc',
          body: '[document: teklif.pdf]',
          at: '2026-10-23T10:00:00Z',
          attachments: [file({ kind: 'document', filename: 'teklif.pdf', file_id: 'file-2', mime: 'application/pdf' })],
        },
      ]),
    );
    renderAt('/inbox/conv-1');
    const button = await screen.findByRole('button', { name: 'teklif.pdf dosyasını indir' });
    expect(calls.some((c) => c.path === '/api/inbox/messages/m-doc/media')).toBe(false);
    await userEvent.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://files.example/files/file-2?purpose=attachment'));
  });

  it('says plainly why a file is not there instead of a broken picture', async () => {
    const calls = mockFetch(
      thread([
        {
          ...base,
          id: 'm-old',
          body: '[image]',
          at: '2026-10-23T10:00:00Z',
          attachments: [file({ state: 'failed', reason: 'expired', file_id: null })],
        },
        {
          ...base,
          id: 'm-new',
          body: '[image]',
          at: '2026-10-23T10:01:00Z',
          attachments: [file({ state: 'pending', file_id: null, mime: null })],
        },
      ]),
    );
    renderAt('/inbox/conv-1');
    expect(await screen.findByText('Dosya artık alınamıyor')).toBeInTheDocument();
    expect(screen.getByText('Dosya alınıyor…')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Fotoğraf' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.includes('/media'))).toBe(false);
  });

  it('leaves a message without files as it was', async () => {
    mockFetch(thread([{ ...base, id: 'm-text', body: '[image] yazdım', at: '2026-10-23T10:00:00Z', attachments: [] }]));
    renderAt('/inbox/conv-1');
    expect(await screen.findByText('[image] yazdım')).toBeInTheDocument();
  });
});
