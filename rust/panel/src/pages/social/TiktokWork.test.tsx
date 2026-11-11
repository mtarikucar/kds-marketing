import { expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { mockFetch, renderAt } from '@/test/render';
import { socialAnswers } from '@/test/social';

it('names the TikTok home work item and links directly to its posting form', async () => {
  mockFetch({ ...socialAnswers, 'GET /api/work/pending': { ...socialAnswers['GET /api/work/pending'], items: [{ kind: 'studio_approval', target: { slot: 's1' }, priority: 2, hint: 'private agent hint' }] } });
  renderAt('/');
  const text = await screen.findByText('TikTok paylaşımını tamamla');
  expect(within(text.closest('li')!).getByRole('link', { name: 'Aç' })).toHaveAttribute('href', '/social?tiktok=s1');
});
