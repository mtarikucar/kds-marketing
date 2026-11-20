import { describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt } from '@/test/render';
import { material, materialsAnswers } from '@/test/materials';
import { tree } from '@/test/contentPage';

const source = material('source', {
  title: 'Kahve servisi',
  tags: {
    labels: ['kahve', 'servis'],
    product_groups: [],
    doors: [],
    content_types: [],
    quality: null,
    depicts: [],
  },
});
const intelligence = {
  status: 'pending',
  description: '',
  group_name: null,
  date_source: 'unknown',
  attempts: 0,
  analyzed_revision: null,
  last_error_code: null,
  analyzed_at: null,
  updated_at: '2026-11-09T10:00:00Z',
  manual_fields: [],
};
const detailAnswers = {
  ...materialsAnswers,
  'GET /api/content/tree': tree(),
  'GET /api/studio/materials/source': { material: source, used_in: [] },
  'GET /api/studio/materials/source/intelligence': { material: source, intelligence },
  'GET /api/studio/materials/source/preview': {
    url: '/sample-coffee.webp',
    expires_at: '2030-01-01T00:00:00Z',
  },
};
// A file opens in Paylaşımlar' Dosyalar drawer (design 2026-11-19 §2.9.1).
const open = () => renderAt('/posts?files=1&file=source');

describe('Material intelligence workflow', () => {
  it('explains agent waiting and saves only the metadata fields manually changed', async () => {
    const calls = mockFetch({
      ...detailAnswers,
      'PATCH /api/studio/materials/source/intelligence': { material: source, intelligence },
    });
    const user = userEvent.setup();
    open();
    expect(await screen.findByText('Ajan analizi bekleniyor')).toBeVisible();
    expect(screen.getByText(/İnceleme, bağlı ajan/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Analizi yeniden sıraya al' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Grup'), 'Kafe açılışı');
    await user.click(screen.getByRole('button', { name: 'Bilgileri kaydet' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        expected_revision: 2,
        group_name: 'Kafe açılışı',
      }),
    );
    expect(screen.getByRole('img', { name: 'Kahve servisi' })).toHaveAttribute('src', '/sample-coffee.webp');
  });

  it('retries a failed analysis at the material revision', async () => {
    const calls = mockFetch({
      ...detailAnswers,
      'GET /api/studio/materials/source/intelligence': {
        material: source,
        intelligence: { ...intelligence, status: 'failed' },
      },
      'POST /api/studio/materials/source/analysis/retry': { material: source, intelligence },
    });
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Analizi yeniden sıraya al' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ expected_revision: 2 }),
    );
  });

  it('queues an actual poster job with the original revision instead of claiming generation completed', async () => {
    const calls = mockFetch({
      ...detailAnswers,
      'GET /api/studio/material-productions': [],
      'POST /api/studio/material-productions': { id: 'job1', status: 'pending' },
    });
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByText('Bu dosyadan yeni görsel üret'));
    await user.selectOptions(screen.getByLabelText('Ne hazırlayalım?'), 'poster');
    await user.type(
      screen.getByLabelText('Nasıl bir sonuç istiyorsunuz?'),
      'Kahve atölyesi için sade bir afiş hazırla.',
    );
    await user.click(screen.getByRole('button', { name: 'Üretim isteğini gönder' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
        kind: 'poster',
        instructions: 'Kahve atölyesi için sade bir afiş hazırla.',
        sources: [{ material_id: 'source', expected_revision: 2 }],
      }),
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toHaveProperty('request_key');
    expect(screen.getByText(/asıl dosya korunur/)).toBeVisible();
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(1);
  });
});

it('renaming a material does not lock unknown quality or unchanged automatic labels', async () => {
  const calls = mockFetch({ ...detailAnswers, 'PATCH /api/studio/materials/source/tags': source });
  const user = userEvent.setup();
  open();
  await user.click(await screen.findByRole('button', { name: 'Etiketler ve kişiler' }));
  const title = screen.getByLabelText('Dosya adı');
  await user.clear(title);
  await user.type(title, 'Sabah kahvesi');
  await user.click(screen.getByRole('button', { name: 'Etiketleri kaydet' }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      expected_revision: 2,
      title: 'Sabah kahvesi',
    }),
  );
});

it('refreshes analyzed material details while preserving and flagging a conflicting open draft', async () => {
  mockFetch(detailAnswers);
  const user = userEvent.setup();
  const page = open();
  await screen.findByText('Ajan analizi bekleniyor');
  await user.click(screen.getByRole('button', { name: 'Etiketler ve kişiler' }));
  await user.type(screen.getByLabelText('Yeni etiket'), 'espresso');
  await user.click(screen.getByRole('button', { name: 'Ekle' }));
  const query = page.client
    .getQueryCache()
    .getAll()
    .find((q) => q.queryKey.includes('intelligence'))!;
  await act(async () => {
    page.client.setQueryData(query.queryKey, {
      material: {
        ...source,
        revision: 3,
        title: 'Ajanın güncel başlığı',
        tags: { ...source.tags, labels: ['kahve', 'latte'] },
      },
      intelligence: { ...intelligence, status: 'completed' },
    });
  });
  expect(await screen.findByRole('heading', { name: 'Ajanın güncel başlığı' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'espresso etiketini kaldır' })).toBeVisible();
  expect(screen.getByText(/Siz düzenlerken bu bilgiler güncellendi/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Etiketleri kaydet' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Taslağı bırak, güncel bilgileri yükle' }));
  expect(screen.queryByRole('button', { name: 'espresso etiketini kaldır' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'latte etiketini kaldır' })).toBeVisible();
});
