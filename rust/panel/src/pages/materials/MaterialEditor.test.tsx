import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delayed, mockFetch, renderAt, withStatus } from '@/test/render';
import { material, materialsAnswers, olay, repMe } from '@/test/materials';

// Materyal (spec §10): tags (an agent's suggestion shown as such), permission, freeing, another
// olay and deletion, the consent decisions an owner or manager takes in person (D4).

const suggested = material('m1', {
  title: 'Diorama yakın çekim',
  tags_reviewed_by: null,
  created_by: { kind: 'agent', connection_id: 'a1', user_id: 'u1' },
  tags: { product_groups: ['diorama_tablo'], doors: [], content_types: ['bitmis_urun'], quality: 'publishable', depicts: [] },
  share: null,
});
const answers = {
  ...materialsAnswers,
  'GET /api/studio/olays': [
    { olay: olay('o1', { title: 'Kadıköy atölyesi' }), materials: 1 },
    { olay: olay('o2', { title: 'Moda atölyesi' }), materials: 0 },
  ],
  'GET /api/studio/materials/m1': { material: suggested, used_in: [] },
};
const open = () => renderAt('/studio?tab=materials&view=olays&material=m1');

describe('Materyaller · Materyal', () => {
  it('preserves a hidden draft after another section saves and submits it at the refreshed revision', async () => {
    const user = userEvent.setup();
    let latest = { ...suggested, tags: { ...suggested.tags, depicts: [] as string[] } };
    const calls = mockFetch({
      ...answers,
      get ['GET /api/studio/materials/m1']() { return { material: latest, used_in: [] }; },
      get ['PUT /api/studio/materials/m1/permission']() {
        latest = { ...suggested, revision: 3, share: { permission: 'not_shareable', at: '2026-11-05T10:00:00Z', by: 'u1' } };
        return latest;
      },
      get ['PATCH /api/studio/materials/m1/tags']() {
        latest = { ...latest, revision: 4, tags: { ...latest.tags, depicts: ['face'] } };
        return latest;
      },
    });
    open();
    const editor = await screen.findByTestId('material-editor');
    await user.click(await within(editor).findByRole('checkbox', { name: /Yüz/ }));
    await user.click(within(editor).getByRole('button', { name: 'İzin ve yerleşim' }));
    await user.click(within(editor).getByRole('radio', { name: 'Paylaşılamaz' }));
    await user.click(within(editor).getByRole('button', { name: 'İzni kaydet' }));
    await waitFor(() => expect(within(editor).getByRole('button', { name: 'İzni kaydet' })).toBeDisabled());
    expect(calls.find((call) => call.method === 'PUT')?.body).toMatchObject({ expected_revision: 2 });
    await user.click(within(editor).getByRole('button', { name: 'Etiketler ve kişiler' }));
    expect(within(editor).getByRole('checkbox', { name: /Yüz/ })).toBeChecked();
    await user.click(within(editor).getByRole('button', { name: 'Etiketleri onayla' }));
    await waitFor(() => expect(calls.find((call) => call.method === 'PATCH')?.body).toMatchObject({ expected_revision: 3, depicts: ['face'] }));
  });

  it('shows one task group at a time and preserves unsaved tags when changing groups', async () => {
    const calls = mockFetch({ ...answers, 'PATCH /api/studio/materials/m1/tags': suggested });
    const user = userEvent.setup();
    open();
    const editor = await screen.findByTestId('material-editor');
    await user.click(await within(editor).findByRole('checkbox', { name: /Yüz/ }));
    expect(within(editor).queryByRole('button', { name: 'İzni kaydet' })).not.toBeInTheDocument();
    await user.click(within(editor).getByRole('button', { name: 'İzin ve yerleşim' }));
    expect(within(editor).getByRole('button', { name: 'İzni kaydet' })).toBeVisible();
    expect(within(editor).queryByRole('button', { name: 'Etiketleri onayla' })).not.toBeInTheDocument();
    await user.click(within(editor).getByRole('button', { name: 'Kullanım geçmişi' }));
    expect(within(editor).getByRole('button', { name: 'Materyali sil' })).toBeVisible();
    expect(within(editor).queryByRole('radio', { name: 'Paylaşılamaz' })).not.toBeInTheDocument();
    await user.click(within(editor).getByRole('button', { name: 'Etiketler ve kişiler' }));
    expect(within(editor).getByRole('checkbox', { name: /Yüz/ })).toBeChecked();
    expect(calls.some((call) => call.method !== 'GET')).toBe(false);
    await user.click(within(editor).getByRole('button', { name: 'Etiketleri onayla' }));
    await waitFor(() => expect(calls.find((call) => call.method === 'PATCH')?.body).toMatchObject({ depicts: ['face'], expected_revision: 2 }));
  });

  it("shows an agent's tags as a suggestion and saving them confirms them", async () => {
    const calls = mockFetch({ ...answers, 'PATCH /api/studio/materials/m1/tags': suggested });
    open();
    const editor = await screen.findByTestId('material-editor');
    expect(await within(editor).findByText(/bir ajanın önerisi/)).toBeInTheDocument();
    expect(within(editor).getByRole('checkbox', { name: /Diorama tablo/ })).toBeChecked();
    expect(within(editor).getByRole('checkbox', { name: /Diorama tablo öneri/ })).toBeInTheDocument();
    await userEvent.click(within(editor).getByRole('checkbox', { name: /Yüz/ }));
    await userEvent.click(within(editor).getByRole('button', { name: 'Etiketleri onayla' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        expected_revision: 2,
        product_groups: ['diorama_tablo'],
        doors: [],
        content_types: ['bitmis_urun'],
        quality: 'publishable',
        depicts: ['face'],
      }),
    );
  });

  it('sets the permission, frees and rebinds at the current revision', async () => {
    const calls = mockFetch({
      ...answers,
      'PUT /api/studio/materials/m1/permission': suggested,
      'POST /api/studio/materials/m1/free': suggested,
      'POST /api/studio/materials/m1/bind': suggested,
    });
    open();
    const editor = await screen.findByTestId('material-editor');
    await userEvent.click(await within(editor).findByRole('button', { name: 'İzin ve yerleşim' }));
    await userEvent.click(within(editor).getByRole('radio', { name: 'Paylaşılamaz' }));
    await userEvent.click(within(editor).getByRole('button', { name: 'İzni kaydet' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/permission'))?.body).toEqual({
        expected_revision: 2,
        permission: 'not_shareable',
      }),
    );
    await userEvent.click(within(editor).getByRole('button', { name: 'Genel kullanılabilir yap' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/free'))?.body).toEqual({ expected_revision: 2, free: true }),
    );
    await userEvent.selectOptions(within(editor).getByLabelText('Olay'), 'o2');
    await userEvent.click(within(editor).getByRole('button', { name: 'Taşı' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/bind'))?.body).toEqual({
        expected_revision: 2,
        binding: { kind: 'olay', olay_id: 'o2' },
      }),
    );
  });

  it('deletes only after a confirmation that explains what KVKK keeps', async () => {
    const calls = mockFetch({
      ...answers,
      'POST /api/studio/materials/m1/delete': { ...suggested, erased_at: '2026-11-04T09:00:00Z' },
    });
    open();
    const editor = await screen.findByTestId('material-editor');
    await userEvent.click(await within(editor).findByRole('button', { name: 'Kullanım geçmişi' }));
    await userEvent.click(within(editor).getByRole('button', { name: 'Materyali sil' }));
    const dialog = await screen.findByRole('dialog', { name: 'Materyal silinsin mi?' });
    expect(within(dialog).getByText(/baytları\) silinir/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Kaydı, hangi içerikte kullanıldığının kanıtı olarak kalır/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith('/delete'))).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sil' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/delete'))?.body).toEqual({
        expected_revision: 2,
        confirm: true,
      }),
    );
  });

  it('keeps the consent decisions from a member who is no owner or manager', async () => {
    mockFetch({ ...answers, 'GET /api/auth/me': repMe });
    open();
    const editor = await screen.findByTestId('material-editor');
    await userEvent.click(await within(editor).findByRole('button', { name: 'İzin ve yerleşim' }));
    expect(
      within(editor).getByText('Paylaşım iznini yalnızca sahip veya yönetici değiştirebilir.'),
    ).toBeInTheDocument();
    expect(within(editor).queryByRole('button', { name: 'Genel kullanılabilir yap' })).not.toBeInTheDocument();
    expect(within(editor).queryByRole('button', { name: 'Taşı' })).not.toBeInTheDocument();
    await userEvent.click(within(editor).getByRole('button', { name: 'Kullanım geçmişi' }));
    expect(within(editor).queryByRole('button', { name: 'Materyali sil' })).not.toBeInTheDocument();
  });

  it('names where a material was used, with its published post', async () => {
    mockFetch({
      ...answers,
      'GET /api/studio/materials/m1': {
        material: { ...suggested, erased_at: '2026-11-01T09:00:00Z' },
        used_in: [
          {
            slot_id: 's1',
            piece_id: 'p1',
            revision: 2,
            role: 'support',
            slot_state: 'measured',
            scheduled_at: '2026-10-20T09:00:00Z',
            publications: [
              {
                publication_id: 'x',
                capability_id: 'c1',
                external_id: 'ig-9',
                url: null,
                published_at: '2026-10-20T09:01:00Z',
              },
            ],
          },
        ],
      },
    });
    open();
    const editor = await screen.findByTestId('material-editor');
    expect(await within(editor).findByText(/dosyası kaldırıldı/)).toBeInTheDocument();
    expect(within(editor).getByText(/Destek görseli/)).toBeInTheDocument();
    expect(within(editor).getByText(/gönderi ig-9/)).toBeInTheDocument();
    expect(within(editor).getByRole('button', { name: 'İçeriği aç' })).toBeInTheDocument();
  });
});


it('keeps the material location available during loading and retries a failed read in place', async () => {
  const user = userEvent.setup();
  mockFetch({ ...answers, 'GET /api/studio/materials/m1': delayed(200, { material: suggested, used_in: [] }) });
  const first = open();
  const editor = await screen.findByTestId('material-editor');
  expect(within(editor).getByRole('button', { name: 'Geri' })).toBeInTheDocument();
  expect(within(editor).getByRole('status')).toHaveTextContent('Yükleniyor');
  await within(editor).findByRole('button', { name: 'Etiketleri onayla' });
  first.unmount();

  mockFetch({ ...answers, 'GET /api/studio/materials/m1': withStatus(503, { code: 'INTERNAL', message: 'unavailable', details: {} }) });
  open();
  const retry = await screen.findByRole('button', { name: 'Yeniden dene' });
  mockFetch(answers);
  await user.click(retry);
  expect(await screen.findByRole('button', { name: 'Etiketleri onayla' })).toBeInTheDocument();
});
