import { expect, it } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAt } from '@/test/render';
import { area, contentFetch, detail, pack, version } from '@/test/content';
import { material } from '@/test/materials';

it('orders open areas before completed pages and switches to the archive', async () => {
  const calls = contentFetch({ open: [area('later', { start_at: '2099-01-02T10:00:00Z' }), area('first', { requests: [{ id: 'r1', status: 'open', text: 'Çekim' }] })], done: [area('done', { packages: [pack] })], more: [area('older', { packages: [pack] })], archive: [area('archive', { archived: true })] });
  renderAt('/content');
  const list = await screen.findByRole('list', { name: 'Üretim hattı' });
  expect(within(list).getAllByRole('link').map(a => a.textContent)).toEqual(['Alan first', 'Alan later', 'Alan done']);
  expect(within(list).getByText('Ajan 1 çekim istedi').closest('li')).toHaveClass('bg-warning-subtle');
  await userEvent.click(screen.getByRole('button', { name: 'Daha fazla' }));
  expect(await screen.findByText('Alan older')).toBeVisible();
  expect(calls.some(c => c.search.includes('done_before=opaque-cursor'))).toBe(true);
  await userEvent.click(screen.getByLabelText('Arşivdekileri göster'));
  expect(await screen.findByText('Alan archive')).toBeVisible();
  expect(screen.queryByText('Alan first')).not.toBeInTheDocument();
});

it('opens an area with only a trimmed goal and the default start time', async () => {
  const calls = contentFetch({ answers: { 'POST /api/studio/projects': area('new'), 'GET /api/studio/projects/new': detail(area('new')) } });
  renderAt('/content');
  expect(await screen.findByText('İlk üretim alanınızı açın')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Üretim alanı aç' }));
  const dialog = screen.getByRole('dialog');
  expect((within(dialog).getByLabelText('Başlama saati') as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  await userEvent.type(within(dialog).getByLabelText('Hedef'), '  Kupaları tanıt  ');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Üretim alanı aç' }));
  expect(await screen.findByRole('heading', { name: 'Alan new' })).toBeVisible();
  const call = calls.find(c => c.method === 'POST' && c.path === '/api/studio/projects');
  expect(call?.body).toEqual({ request_key: expect.any(String), brief: 'Kupaları tanıt', start_at: expect.stringMatching(/Z$/) });
});

it('shows signed media, carousel pages, checks, steps and a required redo note', async () => {
  const project = area('ready', { packages: [{ ...pack, versions: [{ ...version, format: 'carousel', material_ids: ['m1', 'm2'] }, { ...version, id: 'v2', format: 'reel', material_ids: ['video'] }] }], progress: { step: 14, note: 'Son düzenleme', at: '' } });
  const materials = [material('m1', { title: 'İlk görsel' }), material('m2', { title: 'İkinci görsel' }), material('video', { title: 'Video', mime: 'video/mp4' })];
  const calls = contentFetch({ answers: { 'GET /api/studio/projects/ready': detail(project, materials), 'GET /api/studio/materials/m1/preview': { url: 'https://media.example/one.jpg' }, 'GET /api/studio/materials/m2/preview': { url: 'https://media.example/two.jpg' }, 'GET /api/studio/materials/video/preview': { url: 'https://media.example/video.mp4' }, 'POST /api/content/areas/ready/redo': detail(area('ready', { ...project, redo: { note: 'Daha açık renkler', by: 'u', at: '' } }), materials) } });
  renderAt('/content?area=ready');
  expect(await screen.findByRole('img', { name: 'İlk görsel' })).toHaveAttribute('src', 'https://media.example/one.jpg');
  await userEvent.click(screen.getByRole('button', { name: 'Sonraki görsel' }));
  expect(await screen.findByRole('img', { name: 'İkinci görsel' })).toHaveAttribute('src', 'https://media.example/two.jpg');
  expect(screen.getByText('Materyal izni ve doğruluk kontrolleri geçti')).toBeVisible();
  expect(screen.getByText(pack.summary)).toBeVisible();
  expect(screen.queryByRole('button', { name: /^Onayla$/ })).not.toBeInTheDocument();
  await userEvent.click(screen.getByText('Adımlar ve ara çıktılar'));
  const steps = screen.getByRole('list', { name: 'Üretim adımları' });
  expect(within(steps).getAllByRole('listitem')).toHaveLength(14);
  expect(within(steps).getByText('Paketle').closest('li')).toHaveAttribute('aria-current', 'step');
  await userEvent.click(screen.getByRole('tab', { name: /Reels/ }));
  await waitFor(() => expect(document.querySelector('video')).toHaveAttribute('src', 'https://media.example/video.mp4'));
  expect(document.querySelector('video')).toHaveAttribute('controls');
  await userEvent.click(screen.getByRole('button', { name: 'Olmamış' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('button', { name: 'Yeniden yap' })).toBeDisabled();
  await userEvent.type(within(dialog).getByLabelText('Ne değişsin?'), 'Daha açık renkler');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Yeniden yap' }));
  await waitFor(() => expect(calls.find(c => c.path === '/api/content/areas/ready/redo')?.body).toEqual({ package_revision: 1, note: 'Daha açık renkler' }));
  expect(await screen.findByText('Yeniden yapılıyor: “Daha açık renkler”')).toBeVisible();
});

it.each([
  ['future', { start_at: '2099-01-01T09:00:00Z' }, 'Saatini bekliyor'],
  ['old', { start_at: undefined, packages: undefined }, 'Sırada; ajan henüz almadı'],
  ['working', { state: { state: 'working', step: 9, note: '', starts_at: '' } }, 'Materyali üret ya da topla · 9 / 14'],
  ['held', { refused: 3 }, 'Ajan çözemedi; bakmanız gerekiyor'],
  ['redo', { redo: { note: 'Kısalt' } }, 'Yeniden yapılıyor: “Kısalt”'],
])('renders %s without a package', async (id, patch, sentence) => {
  contentFetch({ answers: { [`GET /api/studio/projects/${id}`]: detail(area(id, patch)) } });
  renderAt(`/content?area=${id}`);
  expect(await screen.findByText(sentence)).toBeVisible();
  expect(screen.queryByTestId('platform-frame')).not.toBeInTheDocument();
});

it('lets a person send a held area back with a note, or archive it', async () => {
  const held = area('stuck', { refused: 3, state: { state: 'held', step: 13, note: 'Son kontrol', starts_at: '2026-10-01T09:00:00Z' } });
  const calls = contentFetch({ answers: {
    'GET /api/studio/projects/stuck': detail(held),
    'POST /api/content/areas/stuck/redo': detail(area('stuck', { redo: { note: 'Tarih yazma', by: 'u', at: '' }, state: { state: 'queued', step: null, note: null, starts_at: '2026-10-01T09:00:00Z' } })),
    'PATCH /api/studio/projects/stuck': area('stuck', { archived: true, revision: 5 }),
  } });
  renderAt('/content?area=stuck');
  expect(await screen.findByText(/üç denemede de materyal izni ve doğruluk kontrollerinden geçiremedi/)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Not yazıp geri gönder' }));
  const dialog = screen.getByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Ne değişsin?'), 'Tarih yazma');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Yeniden yap' }));
  // No package was ever accepted: the note is about none.
  await waitFor(() => expect(calls.find(c => c.path === '/api/content/areas/stuck/redo')?.body).toEqual({ package_revision: null, note: 'Tarih yazma' }));
  expect(await screen.findByText('Yeniden yapılıyor: “Tarih yazma”')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Not yazıp geri gönder' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Arşivle' }));
  await waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ expected_revision: 4, archived: true }));
});

it('shows why an area is held and lets a person accept what only the text holds', async () => {
  const refusal = { at: '2026-11-01T10:00:00Z', by: 'agent1', summary: 'Tek gönderi', versions: [{ ...version, text: 'Atölye günümüzden bir kare' }],
    findings: [{ index: 0, findings: [{ kind: 'text', code: 'names_other_olay', material_id: null, olay_id: 'o1', matched: 'atolye' }] }] };
  const held = area('texty', { refused: 3, refusal, state: { state: 'held', step: 13, note: 'Son kontrol', starts_at: '2026-10-01T09:00:00Z' } });
  const accepted = area('texty', { revision: 5, packages: [{ ...pack, versions: refusal.versions, released: { by: 'u', at: '2026-11-01T11:00:00Z', findings: refusal.findings } }], state: { state: 'done', step: 13, note: 'Son kontrol', starts_at: '2026-10-01T09:00:00Z' } });
  const calls = contentFetch({ answers: {
    'GET /api/studio/projects/texty': detail(held, [material('m1', { title: 'Görsel' })]),
    'GET /api/studio/materials/m1/preview': { url: 'https://media.example/one.jpg' },
    'POST /api/content/areas/texty/delivery/accept': detail(accepted, [material('m1', { title: 'Görsel' })]),
  } });
  renderAt('/content?area=texty');
  expect(await screen.findByText('Son teslimde tutulan sürümler')).toBeVisible();
  expect(screen.getByText('Atölye günümüzden bir kare')).toBeVisible();
  expect(screen.getByText(/Metin başka bir olayın adını, yerini veya müşterisini anıyor\. \(“atolye”\)/)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Yine de kabul et' }));
  await waitFor(() => expect(calls.find(c => c.path === '/api/content/areas/texty/delivery/accept')?.body).toEqual({ expected_revision: 4 }));
  expect(await screen.findByText('Metin denetimindeki bulguyu bir kişi kabul etti')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Yine de kabul et' })).not.toBeInTheDocument();
});

it('offers no acceptance when the material holds the delivery', async () => {
  const refusal = { at: '2026-11-01T10:00:00Z', by: 'agent1', summary: 'Tek gönderi', versions: [version],
    findings: [{ index: 0, findings: [{ kind: 'material', code: 'share_unset', material_id: 'm1' }] }] };
  contentFetch({ answers: { 'GET /api/studio/projects/hard': detail(area('hard', { refused: 3, refusal, state: { state: 'held', step: 13, note: '', starts_at: '2026-10-01T09:00:00Z' } })) } });
  renderAt('/content?area=hard');
  expect(await screen.findByText('Paylaşım izni verilmedi.')).toBeVisible();
  expect(screen.getByText(/Bu içerik kabul edilemez/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Yine de kabul et' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Not yazıp geri gönder' })).toBeVisible();
});

it('names a version by its format alone when no account was chosen', async () => {
  const project = area('plain', { packages: [{ ...pack, versions: [{ ...version, tags: [] }, { ...version, id: 'v2', capability_id: 'account1', format: 'story' }] }] });
  contentFetch({ answers: {
    'GET /api/studio/projects/plain': detail(project, [material('m1', { title: 'Görsel' })]),
    'GET /api/capabilities': [{ capability: { id: 'account1', name: 'Atölye hesabı', kind_key: 'instagram', status: 'verified' } }],
    'GET /api/studio/materials/m1/preview': { url: 'https://media.example/one.jpg' },
  } });
  renderAt('/content?area=plain');
  expect(await screen.findByRole('tab', { name: 'Gönderi · 1' })).toBeVisible();
  expect(await screen.findByRole('tab', { name: 'Atölye hesabı · Hikâye · 2' })).toBeVisible();
});

it('submits optional account and format hints without extra opening fields', async () => {
  const calls = contentFetch({ answers: {
    'GET /api/capabilities': [{ capability: { id: 'account1', name: 'Atölye hesabı', kind_key: 'instagram', status: 'verified' } }],
    'POST /api/studio/projects': area('new'), 'GET /api/studio/projects/new': detail(area('new')),
  } });
  renderAt('/content');
  await userEvent.click(await screen.findByRole('button', { name: 'Üretim alanı aç' }));
  const dialog = screen.getByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Hedef'), 'Yeni seri');
  await userEvent.click(within(dialog).getByText('Platform ve biçim (isteğe bağlı)'));
  await userEvent.selectOptions(within(dialog).getByLabelText('Platform'), 'account1');
  await userEvent.selectOptions(within(dialog).getByLabelText('Biçim'), 'story');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Üretim alanı aç' }));
  await waitFor(() => expect(calls.find(c => c.method === 'POST')?.body).toEqual({ request_key: expect.any(String), brief: 'Yeni seri', start_at: expect.stringMatching(/Z$/), capability_ids: ['account1'], formats: ['story'] }));
});

it('keeps material requests actionable using the current project revision', async () => {
  const request = { id: 'r1', text: 'Kupayı gün ışığında çekin', status: 'open', material_ids: [], created_at: '', resolved_at: null };
  const project = area('capture', { requests: [request] });
  const calls = contentFetch({ answers: {
    'GET /api/studio/projects/capture': detail(project, [material('m1', { title: 'Gün ışığında kupa' })]),
    'PATCH /api/studio/projects/capture/requests/r1': { ...project, revision: 5, requests: [{ ...request, status: 'done', material_ids: ['m1'] }] },
  } });
  renderAt('/content?area=capture');
  expect(await screen.findByText('Ajan 1 çekim istedi')).toBeVisible();
  await userEvent.click(screen.getByText('Çekim talepleri'));
  expect(screen.getByText(request.text)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Gelen materyali seç' }));
  await userEvent.click(screen.getByLabelText('Gün ışığında kupa'));
  await userEvent.click(screen.getByRole('button', { name: 'Teslimatı tamamla' }));
  await waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ expected_revision: 4, status: 'done', material_ids: ['m1'] }));
});

it('keeps earlier sources, productions and scheduled outputs visible without a package', async () => {
  contentFetch({ answers: { 'GET /api/studio/projects/legacy': {
    ...detail(area('legacy', { packages: undefined, start_at: undefined, sources: [{ material_id: 'm1', revision: 2 }], outputs: [{ id: 'o1', title: 'Önceki gönderi', format: 'feed_post', slot_id: 'slot1', target_at: null, capability_id: null }], production_ids: ['job1'] }), [material('m1', { title: 'Eski kaynak' })]),
    productions: [{ id: 'job1', status: 'completed', output_material_id: 'm1', instructions: 'Önceki görsel düzenlemesi' }],
  } } });
  renderAt('/content?project=legacy');
  expect(await screen.findByText('Sırada; ajan henüz almadı')).toBeVisible();
  await userEvent.click(screen.getByText('Önceki çalışmalar ve kaynaklar'));
  expect(screen.getByText('Eski kaynak')).toBeVisible();
  expect(screen.getByText('Önceki görsel düzenlemesi')).toBeVisible();
  expect(screen.getByRole('link', { name: /Önceki gönderi/ })).toHaveAttribute('href', '/social?slot=slot1');
});
