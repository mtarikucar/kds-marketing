import { expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { mockFetch, renderAt } from '@/test/render';
import { studioAnswers } from '@/test/studio';

it('opens the materials module under its own title', async () => {
  mockFetch(studioAnswers);
  renderAt('/materials');
  expect(await screen.findByRole('heading', { level: 1, name: 'Materyal kütüphanesi' })).toBeVisible();
});


import { materialsAnswers, olay } from '@/test/materials';
import { waitFor } from '@testing-library/react';

it('preserves a bookmarked olay and leaves the calendar to Content', async () => {
  const event = olay('o1', { title: 'Eski bağlantıdaki olay' });
  mockFetch({ ...materialsAnswers, 'GET /api/studio/olays/o1': { olay: event, materials: [], shoot_requests: [] } });
  const { router } = renderAt('/studio?tab=materials&view=olays&olay=o1');
  await waitFor(() => expect(router.state.location.pathname).toBe('/materials'));
  expect(router.state.location.search).toBe('?view=olays&olay=o1');
  expect(await screen.findByText(event.title)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Takvim' })).not.toBeInTheDocument();
});


it('does not fetch materials data with only another module permission', async () => {
  const session = studioAnswers['GET /api/auth/me'];
  const calls = mockFetch({ ...studioAnswers, 'GET /api/auth/me': { ...session, memberships: [{ ...session.memberships[0], permissions: ['social.work'] }] } });
  renderAt('/materials');
  expect(await screen.findByRole('alert')).toHaveTextContent('Bu işlem için yetkiniz yok');
  expect(calls.some(c => c.path.startsWith('/api/studio/'))).toBe(false);
});
