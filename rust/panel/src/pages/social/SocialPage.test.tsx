import { expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import tr from '@/i18n/tr.json';
import en from '@/i18n/en.json';
import { socialAnswers as answers } from '@/test/social';

it('keeps Turkish and English social labels in parity', () => {
  expect(Object.keys(tr.socialAccounts).sort()).toEqual(Object.keys(en.socialAccounts).sort());
  expect(Object.keys(tr.socialAccounts.metrics).sort()).toEqual(Object.keys(en.socialAccounts.metrics).sort());
});

it('panel_actions_match_every_studio_tool', async () => {
  const api = await import('@/api/studio');
  const q = { from: '2026-10-01T00:00:00Z', until: '2026-11-01T00:00:00Z' };
  const expected = [
    ['GET', '/api/studio/overview'],
    ['GET', '/api/studio/ledger'],
    ['POST', '/api/studio/ledger/export'],
    ['GET', '/api/studio/pending'],
    ['GET', '/api/studio/slots/s1'],
    ['POST', '/api/studio/slots/s1/cancel'],
    ['POST', '/api/studio/brake'],
    ['POST', '/api/studio/approvals'],
    ['POST', '/api/studio/hypotheses/proposals'],
    ['POST', '/api/studio/trends'],
    ['POST', '/api/studio/judgments'],
    ['GET', '/api/studio/learned'],
    ['GET', '/api/studio/adsets'],
    ['POST', '/api/studio/adsets/bind'],
    ['POST', '/api/studio/budget-moves'],
    ['POST', '/api/studio/slots/s1/piece'],
    ['POST', '/api/studio/files'],
    ['GET', '/api/studio/slots/s1/tiktok'],
    ['POST', '/api/studio/slots/s1/tiktok'],
    ['GET', '/api/studio/slots/s1/tiktok/metrics'],
  ];
  const calls = mockFetch(Object.fromEntries(expected.map(([m, p]) => [`${m} ${p}`, {}])));
  await api.overview(q);
  await api.ledger(q);
  await api.ledgerExport(q);
  await api.pending();
  await api.slotGet('s1');
  await api.slotCancel('s1', 1, 'No longer needed');
  await api.brake(true, null, 2);
  await api.approve({ slot: 's1' }, 1);
  await api.hypothesisPropose({
    title: 'Title',
    segment_key: 'audience',
    angle: 'angle',
    channel: 'x',
    metric: 'clicks',
    prior_confidence: 0.5,
  });
  await api.trendRecord({
    hypothesis_id: 'h1',
    channel: 'x',
    summary: 'A trend',
    observed_at: q.from,
    request_key: 'trend',
  });
  await api.judgmentRecord({
    hypothesis_id: 'h1',
    evidence_ids: ['e1'],
    text: 'Result',
    request_key: 'judgment',
  });
  await api.learned(q);
  await api.adsetsList('c1');
  await api.adsetBind({
    hypothesis_id: 'h1',
    arm_id: 'a1',
    capability_id: 'c1',
    adset_id: 'set1',
    request_key: 'binding',
  });
  await api.budgetMove({
    binding_id: 'b1',
    daily_budget_minor: 100,
    currency: 'TRY',
    request_key: 'move',
  });
  await api.pieceSubmit('s1', {
    expected_revision: 1,
    request_key: 'piece',
    text: 'Hello',
    media: [],
    adaptations: {},
  });
  await api.fileUpload({
    filename: 'photo.png',
    mime: 'image/png',
    content: { kind: 'bytes_base64', data: 'eA==' },
    request_key: 'file',
  });
  await api.tiktokPosting('s1');
  const post = {
    mode: 'direct_post' as const,
    title: 'Merhaba',
    privacy_level: 'SELF_ONLY',
    allow_comment: false,
    allow_duet: false,
    allow_stitch: false,
    disclose_commercial: false,
    your_brand: false,
    branded_content: false,
  };
  await api.tiktokPost('s1', 3, post);
  await api.tiktokMetrics('s1');
  expect(calls.map((c) => [c.method, c.path])).toEqual(expected);
  expect(calls.at(-2)?.body).toEqual({ expected_revision: 3, post });
  expect(calls[2].body).toEqual({ filter: q });
  expect(
    calls.filter((c) => c.method !== 'GET').every((c) => c.headers.get('X-Requested-With') === 'jeeta-panel'),
  ).toBe(true);
});

it('does not fetch social data with only another module permission', async () => {
  const session = answers['GET /api/auth/me'];
  const calls = mockFetch({ ...answers, 'GET /api/auth/me': { ...session, memberships: [{ ...session.memberships[0], permissions: ['materials.work'] }] } });
  renderAt('/social');
  expect(await screen.findByRole('alert')).toHaveTextContent('Bu işlem için yetkiniz yok');
  expect(calls.some(c => c.path.startsWith('/api/studio/') || c.path.startsWith('/api/social/'))).toBe(false);
});

it('explains a module removed after navigation and links back to its installation', async () => {
  mockFetch({ ...answers, 'GET /api/social/accounts': withStatus(409, { code: 'MODULE_NOT_INSTALLED', message: 'removed', details: { module: 'social' } }) });
  renderAt('/social');
  expect(await screen.findByText(tr.errors.MODULE_NOT_INSTALLED)).toBeVisible();
  expect(screen.getByRole('link', { name: tr.gates.moduleLink })).toHaveAttribute('href', '/modules/social');
});
