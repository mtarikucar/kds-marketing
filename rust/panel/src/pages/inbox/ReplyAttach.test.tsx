import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { WS_ID } from '@/test/fixtures';
import { inboxAnswers } from '@/test/inbox';

const material = {
  id: 'mat-1',
  workspace_id: WS_ID,
  file_id: 'file-9',
  mime: 'image/jpeg',
  title: 'Örnek kupa',
  origin: { kind: 'real' },
  binding: { kind: 'genel' },
  freed: null,
  share: { permission: 'shareable', by: 'user-1', at: '2026-10-23T10:00:00Z' },
  tags: {},
  tags_reviewed_by: null,
  people: [],
  captured_at: null,
  created_by: { kind: 'system', component: 'test' },
  revision: 1,
  created_at: '2026-10-23T10:00:00Z',
  erased_at: null,
};

function answers(extra: Record<string, unknown> = {}) {
  return {
    ...inboxAnswers,
    'GET /api/studio/materials': [material, { ...material, id: 'mat-2', share: { ...material.share, permission: 'not_shareable' } }],
    'GET /api/studio/materials/mat-1/preview': { url: 'https://files.example/files/file-9', expires_at: '2026-10-23T11:00:00Z' },
    'POST /api/inbox/conversations/conv-1/reply': { message_id: 'm-out', state: 'sent' },
    ...extra,
  };
}

describe('Attaching a photo to a reply', () => {
  it('sends a library photo with the typed text as its caption', async () => {
    const calls = mockFetch(answers());
    renderAt('/inbox/conv-1');
    const box = await screen.findByRole('textbox', { name: 'Yanıtınız' });
    await userEvent.click(screen.getByRole('button', { name: 'Fotoğraf ekle' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Kütüphaneden' }));
    const dialog = await screen.findByRole('dialog');
    // Only a photo that may be sent is offered.
    const choices = within(dialog).getAllByRole('button', { name: 'Örnek kupa' });
    expect(choices).toHaveLength(1);
    await userEvent.click(choices[0]!);
    await userEvent.type(box, 'Böyle olacak');
    await userEvent.click(screen.getByRole('button', { name: 'Yanıt gönder' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/reply'))).toBe(true));
    const sent = calls.find((c) => c.method === 'POST' && c.path.endsWith('/reply'))!;
    expect(sent.body).toMatchObject({ text: 'Böyle olacak', intent: 'reply', image: { material_id: 'mat-1' } });
  });

  it('shows why a photo was refused', async () => {
    mockFetch(
      answers({
        'POST /api/inbox/conversations/conv-1/reply': withStatus(422, {
          code: 'VALIDATION',
          message: 'the image cannot be sent',
          details: { field: 'image', reason: 'material_not_shareable' },
        }),
      }),
    );
    renderAt('/inbox/conv-1');
    await screen.findByRole('textbox', { name: 'Yanıtınız' });
    await userEvent.click(screen.getByRole('button', { name: 'Fotoğraf ekle' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Kütüphaneden' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Örnek kupa' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yanıt gönder' }));
    expect(await screen.findByText('Bu fotoğraf paylaşılamaz')).toBeInTheDocument();
  });
});
