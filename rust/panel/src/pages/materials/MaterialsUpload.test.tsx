import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { dayFrom, material, materialsAnswers, olay, repMe } from '@/test/materials';

// Yükle (spec §10): files are stored at once, then one form adds the batch with its olay, its
// mandatory share permission and optional tags.

/** A photo taken two days ago at noon, Istanbul. */
function photo(name = 'atolye.jpg') {
  return new File(['x'], name, {
    type: 'image/jpeg',
    lastModified: Date.parse(`${dayFrom(-2)}T12:00:00+03:00`),
  });
}

const recent = olay('o-new', { title: 'Yılbaşı hazırlığı', starts_on: dayFrom(5), ends_on: dayFrom(6) });
const workshop = olay('o-ws', {
  title: 'Kadıköy atölyesi',
  starts_on: dayFrom(-3),
  ends_on: dayFrom(-2),
  place: 'Kadıköy',
});
const answers = {
  ...materialsAnswers,
  // The server lists the newest first: the suggested olay is not the first of the list.
  'GET /api/studio/olays': [
    { olay: recent, materials: 0 },
    { olay: workshop, materials: 4 },
  ],
  'POST /api/studio/files': { id: 'file-1', mime: 'image/jpeg', filename: 'atolye.jpg' },
  'POST /api/studio/materials': {
    material: material('m1', { file_id: 'file-1', binding: { kind: 'olay', olay_id: 'o-ws' } }),
    olay_suggestions: [workshop],
  },
};

async function pickPhoto() {
  const user = userEvent.setup();
  renderAt('/studio?tab=materials&view=upload');
  const input = await screen.findByLabelText('Galeriden seç', { selector: 'input' });
  await user.upload(input, photo());
  await screen.findByText('Yüklendi');
  return user;
}

describe('Materyaller · Yükle', () => {
  it('searches a long event list without losing the selected event or its upload', async () => {
    const events = Array.from({ length: 9 }, (_, index) => ({
      olay: olay(`event-${index}`, { title: `Ürün çekimi ${index}`, place: index === 8 ? 'Beyoğlu' : 'Moda', starts_on: dayFrom(5), ends_on: dayFrom(6) }),
      materials: 0,
    }));
    const calls = mockFetch({ ...answers, 'GET /api/studio/olays': events });
    const user = await pickPhoto();
    const search = screen.getByRole('searchbox', { name: 'Olay adı veya yer ara' });
    await user.type(search, 'Beyoğlu');
    expect(screen.getByRole('radio', { name: /Ürün çekimi 8/ })).toBeVisible();
    expect(screen.queryByRole('radio', { name: /Ürün çekimi 0/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Ürün çekimi 8/ }));
    await user.clear(search);
    await user.type(search, 'bulunmayan');
    expect(screen.getByText('Seçili olay: Ürün çekimi 8')).toBeVisible();
    expect(screen.getByText(/Eşleşen olay yok/)).toHaveAttribute('role', 'status');
    expect(screen.getByRole('radio', { name: 'Yeni olay oluştur' })).toBeVisible();
    await user.click(screen.getByRole('radio', { name: 'Paylaşılabilir' }));
    await user.click(screen.getByRole('button', { name: '1 materyali ekle' }));
    await screen.findByText('1 materyal eklendi.');
    expect(calls.filter((call) => call.path === '/api/studio/files')).toHaveLength(1);
    expect(calls.find((call) => call.method === 'POST' && call.path === '/api/studio/materials')?.body).toMatchObject({ olay_id: 'event-8', file_id: 'file-1', share: 'shareable' });
  });

  it('stores each picked file at once with its own request key', async () => {
    const calls = mockFetch(answers);
    await pickPhoto();
    const upload = calls.find((c) => c.method === 'POST' && c.path === '/api/studio/files');
    expect(upload?.body).toMatchObject({
      filename: 'atolye.jpg',
      mime: 'image/jpeg',
      content: { kind: 'bytes_base64', data: 'eA==' },
    });
    expect((upload?.body as { request_key: string }).request_key).toMatch(/[0-9a-f-]{36}/);
    expect(screen.getByLabelText('Kamerayla çek', { selector: 'input' })).toHaveAttribute(
      'capture',
      'environment',
    );
    expect(screen.getByLabelText('Galeriden seç', { selector: 'input' })).toHaveAttribute(
      'accept',
      'image/*,video/mp4',
    );
  });

  it('shows the olay its capture day suggests first', async () => {
    mockFetch(answers);
    await pickPhoto();
    const suggested = await screen.findByRole('group', { name: 'Çekim tarihine göre önerilen' });
    expect(within(suggested).getByRole('radio', { name: /Kadıköy atölyesi/ })).toBeInTheDocument();
    expect(within(suggested).queryByRole('radio', { name: /Yılbaşı hazırlığı/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('radio')[0]).toHaveAccessibleName(/Kadıköy atölyesi/);
    expect(
      within(screen.getByRole('group', { name: 'Diğer olaylar' })).getByRole('radio', {
        name: /Yılbaşı hazırlığı/,
      }),
    ).toBeInTheDocument();
  });

  it('refuses to submit without a share permission, then adds with it', async () => {
    const calls = mockFetch(answers);
    const user = await pickPhoto();
    await user.click(await screen.findByRole('radio', { name: /Kadıköy atölyesi/ }));
    await user.click(screen.getByRole('button', { name: '1 materyali ekle' }));
    expect(await screen.findByText('Paylaşım iznini seçin.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/studio/materials')).toBe(false);

    await user.click(screen.getByRole('radio', { name: 'Sadece ürün (yüz ve isimler gizli)' }));
    await user.click(screen.getByText('Etiketler (isteğe bağlı)'));
    await user.click(screen.getByRole('checkbox', { name: 'Figür' }));
    await user.click(screen.getByRole('button', { name: '1 materyali ekle' }));
    await screen.findByText('1 materyal eklendi.');
    const files = calls.find((c) => c.path === '/api/studio/files')?.body as { request_key: string };
    const add = calls.find((c) => c.method === 'POST' && c.path === '/api/studio/materials');
    expect(add?.body).toMatchObject({
      request_key: `${files.request_key}:material`,
      file_id: 'file-1',
      olay_id: 'o-ws',
      origin: { kind: 'real' },
      share: 'product_only',
      product_groups: ['figur'],
    });
    expect((add?.body as Record<string, unknown>).genel).toBeUndefined();
  });

  it('creates a new olay inline once, then adds to it', async () => {
    const created = olay('o-created', { title: 'Moda sahnesi atölyesi' });
    const calls = mockFetch({
      ...answers,
      'POST /api/studio/olays': created,
      'POST /api/studio/materials': { material: material('m1'), olay_suggestions: [] },
    });
    const user = await pickPhoto();
    await user.click(await screen.findByRole('radio', { name: 'Yeni olay oluştur' }));
    await user.type(screen.getByLabelText('Başlık'), 'Moda sahnesi atölyesi');
    await user.click(screen.getByRole('radio', { name: 'Paylaşılabilir' }));
    await user.click(screen.getByRole('button', { name: '1 materyali ekle' }));
    await screen.findByText('1 materyal eklendi.');
    const create = calls.filter((c) => c.method === 'POST' && c.path === '/api/studio/olays');
    expect(create).toHaveLength(1);
    expect(create[0].body).toMatchObject({
      kind: 'workshop',
      title: 'Moda sahnesi atölyesi',
      starts_on: dayFrom(-2),
      ends_on: dayFrom(-2),
    });
    expect(calls.find((c) => c.path === '/api/studio/materials' && c.method === 'POST')?.body).toMatchObject({
      olay_id: 'o-created',
      share: 'shareable',
    });
  });

  it('offers genel to an owner and shows the server refusal plainly', async () => {
    mockFetch({
      ...answers,
      'POST /api/studio/materials': withStatus(403, {
        code: 'FORBIDDEN',
        message: 'owner or manager human required',
        details: { reason: 'owner_or_manager_human' },
      }),
    });
    const user = await pickPhoto();
    await user.click(await screen.findByRole('radio', { name: /Genel \(belirli bir olaya bağlı değil\)/ }));
    await user.click(screen.getByRole('radio', { name: 'Paylaşılabilir' }));
    await user.click(screen.getByRole('button', { name: '1 materyali ekle' }));
    expect(
      await screen.findByText('Bu kararı yalnızca sahip veya yönetici panelden verebilir.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Eklenemedi')).toBeInTheDocument();
  });

  it('gives a member who is no owner or manager neither genel nor the permission', async () => {
    const calls = mockFetch({
      ...answers,
      'GET /api/auth/me': repMe,
      'POST /api/studio/materials': { material: material('m1', { share: null }), olay_suggestions: [] },
    });
    const user = await pickPhoto();
    expect(screen.queryByRole('radio', { name: /Genel/ })).not.toBeInTheDocument();
    for (const r of screen.getAllByRole('radio', { name: /Paylaşıl|Sadece ürün/ })) {
      expect(r).toBeDisabled();
    }
    await user.click(screen.getByRole('radio', { name: /Kadıköy atölyesi/ }));
    await user.click(screen.getByRole('button', { name: '1 materyali ekle' }));
    await screen.findByText('1 materyal eklendi.');
    const body = calls.find((c) => c.path === '/api/studio/materials' && c.method === 'POST')?.body;
    expect((body as Record<string, unknown>).share).toBeUndefined();
  });

  it('names what the server suggests when the olay chosen is another, and moves it there', async () => {
    const calls = mockFetch({
      ...answers,
      'POST /api/studio/materials/m1/bind': material('m1', { revision: 3 }),
    });
    const user = await pickPhoto();
    await user.click(await screen.findByRole('radio', { name: /Yılbaşı hazırlığı/ }));
    await user.click(screen.getByRole('radio', { name: 'Paylaşılabilir' }));
    await user.click(screen.getByRole('button', { name: '1 materyali ekle' }));
    expect(
      await screen.findByText('Çekim tarihine göre bu materyal “Kadıköy atölyesi” olayına ait olabilir.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Bu olaya taşı' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/studio/materials/m1/bind')?.body).toEqual({
        expected_revision: 2,
        binding: { kind: 'olay', olay_id: 'o-ws' },
      }),
    );
  });

  it('refuses a file type the store does not take before sending it', async () => {
    const calls = mockFetch(answers);
    const user = userEvent.setup({ applyAccept: false });
    renderAt('/studio?tab=materials&view=upload');
    const input = await screen.findByLabelText('Galeriden seç', { selector: 'input' });
    await user.upload(input, new File(['x'], 'foto.heic', { type: 'image/heic' }));
    expect(await screen.findByText('Kabul edilmedi')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/studio/files')).toBe(false);
  });
});
