import { expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { mockFetch, renderAt } from '@/test/render';
import { studioAnswers } from '@/test/studio';

it('opens the content module under its own title', async () => {
  mockFetch(studioAnswers);
  renderAt('/content');
  expect(await screen.findByRole('heading', { level: 1, name: 'İçerik oluşturma' })).toBeVisible();
});


it('does not fetch content data with only another module permission', async () => {
  const session = studioAnswers['GET /api/auth/me'];
  const calls = mockFetch({ ...studioAnswers, 'GET /api/auth/me': { ...session, memberships: [{ ...session.memberships[0], permissions: ['materials.work'] }] } });
  renderAt('/content');
  expect(await screen.findByRole('alert')).toHaveTextContent('Bu işlem için yetkiniz yok');
  expect(calls.some(c => c.path.startsWith('/api/studio/'))).toBe(false);
});

import userEvent from '@testing-library/user-event';
import { waitFor } from '@testing-library/react';

it('preserves a project bookmark and opens special days with the materials rules', async () => {
  const calls = mockFetch({ ...studioAnswers,
    'GET /api/studio/projects/p1': { project: { id: 'p1', title: 'Lansman', brief: 'Yeni ürün', revision: 1, archived: false, sources: [], requests: [], outputs: [], production_ids: [], invalidated_production_ids: [] }, materials: [], productions: [], publications: [] },
    'GET /api/studio/calendar': { year: 2026, entries: [], rows: [], policy: { lead_days: 21, reuse_days: 14, recap_days: 30, ai_standalone: true } },
  });
  const { router } = renderAt('/studio?tab=projects&project=p1');
  expect(await screen.findByRole('heading', { name: 'Lansman' })).toBeVisible();
  expect(router.state.location.pathname).toBe('/content');
  expect(router.state.location.search).toBe('?project=p1');
  await userEvent.click(screen.getByRole('tab', { name: 'Ayarlar' }));
  expect(await screen.findByTestId('materials-calendar')).toBeVisible();
  await waitFor(() => expect(calls.some(c => c.path === '/api/studio/calendar')).toBe(true));
  expect(await screen.findByText('Materyal kuralları')).toBeVisible();
});
