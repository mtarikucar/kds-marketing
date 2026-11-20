import { expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import { mockFetch, renderAt } from '@/test/render';
import { studioAnswers } from '@/test/studio';
import { postsAnswers } from '@/test/postsPage';

// Every old address lands where it now lives, with its query mapped and the obsolete history
// entry replaced (design 2026-11-19 §2.11's whole table).
it.each([
  ['/content', '/posts', ''],
  ['/content?view=all', '/posts', ''],
  ['/content?view=queue', '/posts', '?files=1&queue=1'],
  ['/content?view=queue&file=m1', '/posts', '?files=1&queue=1&file=m1'],
  ['/content?olay=o1', '/posts', '?files=1&category=o1'],
  ['/content?olay=genel', '/posts', '?files=1&category=genel'],
  ['/content?day=ramazan_bayrami:2027', '/posts', '?settings=1&section=days&day=ramazan_bayrami%3A2027'],
  ['/content?content=a1', '/posts', '?content=a1'],
  ['/content?area=a1', '/posts', '?content=a1'],
  ['/content?project=a1', '/posts', '?content=a1'],
  ['/content?file=m1', '/posts', '?files=1&file=m1'],
  ['/content?settings=1', '/posts', '?settings=1&section=days'],
  ['/content?settings=1&year=2027', '/posts', '?settings=1&section=days&year=2027'],
  ['/content?tab=calendar', '/posts', '?settings=1&section=days'],
  ['/content?tab=settings', '/posts', '?settings=1&section=days'],
  ['/content?olay=o1#eksikler', '/posts', '?f=you'],
  ['/social', '/posts', ''],
  ['/social?view=all', '/posts', ''],
  ['/social?account=c1', '/posts', '?accounts=1&account=c1'],
  ['/social?account=c1&days=7', '/posts', '?accounts=1&account=c1&days=7'],
  ['/social?slot=s1', '/posts', '?slot=s1'],
  ['/social?version=v1', '/posts', '?version=v1'],
  ['/social?tiktok=s1', '/posts', '?slot=s1&tiktok=s1'],
  ['/social?filter=approvals', '/posts', '?f=you'],
  ['/social?filter=tiktok', '/posts', '?f=you'],
  ['/social?filter=failed', '/posts', '?f=you'],
  ['/social?filter=blocked', '/posts', '?f=you'],
  ['/social?filter=times', '/posts', '?f=onay'],
  ['/social?settings=1', '/posts', '?settings=1&section=rules'],
  ['/social?tab=settings', '/posts', '?settings=1&section=rules'],
  ['/social?section=settings', '/posts', '?settings=1&section=rules'],
  ['/social?tab=posts&view=settings', '/posts', '?settings=1&section=rules'],
  ['/social?tab=packages#version-v1', '/posts', '?version=v1'],
  ['/social?tab=packages', '/posts', '?f=onay'],
  ['/studio?tab=materials', '/posts', '?files=1'],
  ['/studio?tab=materials&view=olays&olay=o1', '/posts', '?files=1&category=o1'],
  ['/studio?tab=materials&olay=o1&material=m1', '/posts', '?files=1&category=o1&file=m1'],
  ['/studio?tab=materials&olay=review', '/posts', '?files=1'],
  ['/studio?tab=projects&project=p1', '/posts', '?content=p1'],
  ['/studio?tab=posts&view=week', '/posts', ''],
  ['/studio?slot=s1', '/posts', '?slot=s1'],
  ['/studio', '/posts', ''],
  ['/materials?olay=o1&material=m1', '/posts', '?files=1&category=o1&file=m1'],
  ['/materials?olay=review', '/posts', '?files=1'],
  ['/team?member=u1', '/users', '?member=u1'],
  ['/roles?role=rep', '/users', '?role=rep'],
  ['/activity?filter=pending', '/', '?filter=pending'],
  ['/ledger?before=e1', '/', '?before=e1'],
  // The strategy page became Bilgi bankası (design 2026-11-19 §2.11): any query lands on it.
  ['/strategy', '/knowledge', ''],
  ['/strategy?version=v1#gaps', '/knowledge', ''],
])('redirects %s preserving its query and replacing history', async (from, path, search) => {
  mockFetch({ ...postsAnswers(), ...studioAnswers });
  const { router } = renderAt(from);
  await waitFor(() => expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(`${path}${search}`));
  expect(router.state.historyAction).toBe('REPLACE');
});
