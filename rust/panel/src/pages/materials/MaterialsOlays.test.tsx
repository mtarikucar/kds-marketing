import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delayed, mockFetch, renderAt } from '@/test/render';
import { material, materialsAnswers, olay, shoot } from '@/test/materials';

// Olaylar (spec §10): the list with "onay bekliyor" for a proposed olay and its confirmation, and
// an olay's detail with its materials, its çekim listesi items and where they were used.

const confirmed = olay('o1', { title: 'Kadıköy atölyesi', place: 'Kadıköy' });
const proposedA = olay('o2', { title: 'Kulüp siparişi', kind: 'order', status: 'proposed', confirmed: null });
const proposedB = olay('o3', { title: 'Okul atölyesi', status: 'proposed', confirmed: null, revision: 4 });
const answers = {
  ...materialsAnswers,
  'GET /api/studio/olays': [
    { olay: proposedA, materials: 2 },
    { olay: proposedB, materials: 0 },
    { olay: confirmed, materials: 5 },
  ],
};

describe('Materyaller · Olaylar', () => {
  it('marks a proposed olay "onay bekliyor" and confirms it at its revision', async () => {
    const calls = mockFetch({
      ...answers,
      'POST /api/studio/olays/o2/confirm': { ...proposedA, status: 'confirmed', revision: 2 },
    });
    renderAt('/studio?tab=materials&view=olays');
    const row = await screen.findByTestId('olay-o2');
    expect(within(row).getByText('Onay bekliyor')).toBeInTheDocument();
    expect(within(row).getByText('Sipariş / proje', { exact: false })).toBeInTheDocument();
    expect(within(row).getByText('2 materyal')).toBeInTheDocument();
    expect(within(screen.getByTestId('olay-o1')).queryByText('Onay bekliyor')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('olay-o1')).queryByRole('button', { name: 'Onayla' })).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Onayla' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/studio/olays/o2/confirm')?.body).toEqual({
        expected_revision: 1,
      }),
    );
    expect(calls.find((c) => c.path === '/api/studio/olays/o2/confirm')?.headers.get('X-Requested-With')).toBe(
      'jeeta-panel',
    );
  });

  it("keeps each row's confirmation pending to that row", async () => {
    mockFetch({
      ...answers,
      'POST /api/studio/olays/o2/confirm': delayed(500, { ...proposedA, status: 'confirmed' }),
    });
    renderAt('/studio?tab=materials&view=olays');
    const a = await screen.findByTestId('olay-o2');
    const b = screen.getByTestId('olay-o3');
    await userEvent.click(within(a).getByRole('button', { name: 'Onayla' }));
    await waitFor(() => expect(within(a).getByRole('button', { name: 'Onayla' })).toBeDisabled());
    expect(within(b).getByRole('button', { name: 'Onayla' })).toBeEnabled();
  });

  it("opens an olay's detail with its materials, requests and where they were used", async () => {
    const used = material('m1', {
      title: 'Boyama masası',
    });
    const calls = mockFetch({
      ...answers,
      'GET /api/studio/olays/o1': {
        olay: confirmed,
        materials: [
          {
            material: used,
            used_in: [
              {
                slot_id: 's9',
                piece_id: 'p9',
                revision: 1,
                role: 'anchor',
                slot_state: 'published',
                scheduled_at: '2026-10-20T09:00:00Z',
                publications: [
                  {
                    publication_id: 'pub1',
                    capability_id: 'c1',
                    external_id: 'ig-1',
                    url: 'https://instagram.test/p/1',
                    published_at: '2026-10-20T09:01:00Z',
                  },
                ],
              },
            ],
          },
          { material: material('m2', { share: null, mime: 'video/mp4' }), used_in: [] },
        ],
        shoot_requests: [shoot('r1', { text: '16 Kasım atölyesi için afiş yükle', reason: { kind: 'olay_upcoming', olay_id: 'o1' } })],
      },
      'POST /api/studio/shoot-requests/r1/resolve': shoot('r1', { status: 'done' }),
    });
    renderAt('/studio?tab=materials&view=olays');
    await userEvent.click(await within(await screen.findByTestId('olay-o1')).findByRole('button', { name: /Kadıköy atölyesi/ }));
    const detail = await screen.findByTestId('olay-detail');
    expect(await within(detail).findByRole('heading', { name: 'Kadıköy atölyesi' })).toBeInTheDocument();
    expect(within(detail).getByRole('heading', { name: 'Materyaller (2)' })).toBeInTheDocument();
    expect(within(detail).getByRole('img', { name: 'Boyama masası' })).toBeInTheDocument();
    expect(within(detail).getByRole('img', { name: 'Adsız video' })).toBeInTheDocument();
    expect(within(detail).getByText('Paylaşım izni yok')).toBeInTheDocument();
    expect(within(detail).getByText('16 Kasım atölyesi için afiş yükle')).toBeInTheDocument();
    expect(within(detail).getByRole('link', { name: /Yayınlanan gönderi/ })).toHaveAttribute(
      'href',
      'https://instagram.test/p/1',
    );
    await userEvent.click(within(detail).getByRole('button', { name: 'Yapıldı' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/studio/shoot-requests/r1/resolve')?.body).toEqual({
        status: 'done',
      }),
    );
  });

  it('lists the materials that wait for a person', async () => {
    const calls = mockFetch({
      ...answers,
      'GET /api/studio/materials': [material('m3', { title: 'Tepki videosu', share: null })],
    });
    renderAt('/studio?tab=materials&view=olays');
    await userEvent.click(await screen.findByRole('button', { name: 'İncelenmeyi bekleyen 1 materyal' }));
    expect(await screen.findByRole('img', { name: 'Tepki videosu' })).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/studio/materials' && c.search === '?state=needs_review')).toBe(true);
  });
});
