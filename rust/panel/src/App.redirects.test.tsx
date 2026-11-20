import { expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import { mockFetch, renderAt } from '@/test/render';
import { studioAnswers } from '@/test/studio';

it.each([
  ['/studio?tab=materials&view=olays&olay=o1', '/content', '?olay=o1'],
  ['/studio?tab=projects&project=p1', '/content', '?content=p1'],
  ['/studio?tab=posts&view=week', '/social', '?tab=posts&view=week'],
  ['/studio?slot=s1', '/social', '?slot=s1'],
  ['/studio', '/social', ''],
  ['/team?member=u1', '/users', '?member=u1'],
  ['/roles?role=rep', '/users', '?role=rep'],
  ['/activity?filter=pending', '/', '?filter=pending'],
  ['/ledger?before=e1', '/', '?before=e1'],
  // The strategy page became Bilgi bankası (design 2026-11-19 §2.11): any query lands on it.
  ['/strategy', '/knowledge', ''],
  ['/strategy?version=v1#gaps', '/knowledge', ''],
])('redirects %s preserving its query and replacing history', async (from, path, search) => {
  mockFetch(studioAnswers);
  const { router } = renderAt(from);
  await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(`${path}${search}`));
  expect(router.state.historyAction).toBe('REPLACE');
});
