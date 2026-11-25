import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import { me } from '@/test/fixtures';
import { knowledge } from '@/test/knowledge';
import { material, olay } from '@/test/materials';
import { mockFetch, renderAt, type FetchCall, type FetchRoutes } from '@/test/render';
import { postsAnswers, postsOut, setViewport } from '@/test/postsPage';
import { accountDetail, socialAccount, socialSettings, tiktokAccount } from '@/test/social';

// The three header drawers of Paylaşımlar (design 2026-11-19 §2.9, §8.3): Dosyalar (queue,
// categories, confirmation, the file editor), Hesaplar (the switch, the per-account approval only
// while Kurallar' switch is off, the read-only comment-reply line, Sayılar on demand) and Ayarlar
// (three sections, the brake).

const P = tr.postsPage;
const sent = (calls: FetchCall[], method: string, path: string) => calls.find((c) => c.method === method && c.path === path);

function open(path: string, extra: FetchRoutes = {}) {
  setViewport('desk');
  const calls = mockFetch(postsAnswers(postsOut(), extra));
  return { calls, ...renderAt(path) };
}

const tree = (olays: ReturnType<typeof olay>[]) => ({
  olays: olays.map((o) => ({ olay: o, files: 1, areas: 0, published: 0, waits: [] })),
  genel: { files: 2, areas: 0, published: 0, waits: [] },
  upcoming: [],
  analysis_queue: 1,
  areas: 0,
  waiting: { olay_confirmations: 1, shoot_requests: 0, content_approvals: 0, content_times: 0, problem_contents: 0 },
});
const intelligence = { status: 'pending', description: '', group_name: null, date_source: 'unknown', attempts: 0, analyzed_revision: null, last_error_code: null, analyzed_at: null, updated_at: '2026-11-19T09:00:00Z', manual_fields: [] };
const files: FetchRoutes = {
  'GET /api/content/tree': tree([olay('o1', { title: 'Kadıköy atölyesi', status: 'confirmed' }), olay('o2', { title: 'Yılbaşı pazarı', status: 'proposed' })]),
  'GET /api/content/analysis-queue': { items: [{ material: material('mq', { title: 'Yeni yükleme', binding: { kind: 'unfiled' } }), intelligence, unfiled: true, stage: 'waiting' }] },
  'GET /api/studio/materials': [material('m1', { title: 'Raf fotoğrafı', share: null }), material('m2', { title: 'Fırın önü' })],
  'GET /api/content/olays/o1': { olay: olay('o1', { title: 'Kadıköy atölyesi' }), contents: null, files: [{ material: material('m3', { title: 'Kadıköy masası' }), intelligence, used_in: [] }], needs: [] },
  'POST /api/studio/olays/o2/confirm': olay('o2', { status: 'confirmed' }),
  'GET /api/studio/olays': [],
};

describe('Dosyalar', () => {
  it('shows the library, the queue and what waits for a permission', async () => {
    const user = userEvent.setup();
    const { router } = open('/posts?files=1', files);
    const drawer = await screen.findByRole('dialog', { name: P.files.title });
    expect(await within(drawer).findByText('Raf fotoğrafı')).toBeInTheDocument();
    expect(within(drawer).getByText('Fırın önü')).toBeInTheDocument();
    expect(within(drawer).getByText(P.files.state.unshared)).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: /İzin bekleyen/ }));
    expect(within(drawer).queryByText('Fırın önü')).not.toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: /İnceleniyor/ }));
    await waitFor(() => expect(router.state.location.search).toBe('?files=1&queue=1'));
    expect(await within(drawer).findByText('Yeni yükleme')).toBeInTheDocument();
    expect(within(drawer).getByText(P.files.state.waiting)).toBeInTheDocument();
  });

  it('shows a file the server drew with a role and frame this panel does not know', async () => {
    const later = { renderer: 'jeeta-later', role: 'some_new_role', variant: 'v1', frame: 'some_new_frame', sources: ['m1'] };
    const { router } = open('/posts?files=1', {
      ...files,
      'GET /api/studio/materials': [material('m1', { title: 'Raf fotoğrafı' }), material('m9', { title: 'Yeni bir çizim', composition: later })],
      'GET /api/studio/materials/m9': { material: material('m9', { title: 'Yeni bir çizim', composition: later }), used_in: [] },
    });
    const drawer = await screen.findByRole('dialog', { name: P.files.title });
    const user = userEvent.setup();
    await user.click(await within(drawer).findByRole('button', { name: /Yeni bir çizim/ }));
    await waitFor(() => expect(router.state.location.search).toBe('?files=1&file=m9'));
    expect(await screen.findByTestId('material-editor')).toBeInTheDocument();
  });

  it('narrows to a category and confirms a proposed one', async () => {
    const user = userEvent.setup();
    const { calls, router } = open('/posts?files=1', files);
    const drawer = await screen.findByRole('dialog', { name: P.files.title });
    const block = await within(drawer).findByRole('region', { name: P.files.proposed });
    expect(within(block).getByText(/^Yılbaşı pazarı · /)).toBeInTheDocument();
    await user.click(within(block).getByRole('button', { name: tr.materials.olay.confirm }));
    await waitFor(() => expect(sent(calls, 'POST', '/api/studio/olays/o2/confirm')).toBeDefined());
    await user.selectOptions(within(drawer).getByLabelText(/Kategori/), 'o1');
    await waitFor(() => expect(router.state.location.search).toBe('?files=1&category=o1'));
    expect(await within(drawer).findByText('Kadıköy masası')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: P.files.edit })).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: P.files.addCategory }));
    expect(await screen.findByRole('dialog', { name: tr.materials.olay.new })).toBeInTheDocument();
  });

  it('opens a file in the library’s editor and goes back to the grid', async () => {
    const user = userEvent.setup();
    const { router } = open('/posts?files=1', { ...files, 'GET /api/studio/materials/m2': { material: material('m2', { title: 'Fırın önü' }), used_in: [] } });
    const drawer = await screen.findByRole('dialog', { name: P.files.title });
    await user.click(await within(drawer).findByRole('button', { name: /Fırın önü/ }));
    await waitFor(() => expect(router.state.location.search).toBe('?files=1&file=m2'));
    expect(await screen.findByTestId('material-editor')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: P.files.title }));
    await waitFor(() => expect(router.state.location.search).toBe('?files=1'));
  });
});

const accounts: FetchRoutes = {
  'GET /api/social/accounts': [socialAccount, tiktokAccount],
  'GET /api/social/accounts/ig1': accountDetail,
  'GET /api/studio/posts': { posts: [], settings: socialSettings },
  'GET /api/capabilities': [{ capability: { id: 'ig1', kind_key: 'instagram', name: '@atolye', policy: { active_hours: null, daily_ops_cap: null, spend_cap_minor: null, requires_human_approval: true, verify_max_age_days: 30 } }, effective_status: 'verified' }],
  'POST /api/knowledge/post-approval': { rules: knowledge.rules },
  'POST /api/social/accounts/ig1/pause': { ...socialSettings, revision: 8 },
};

describe('Hesaplar', () => {
  it('lists every account with its switch, approval and the read-only comment-reply line', async () => {
    const user = userEvent.setup();
    const { calls } = open('/posts?accounts=1', accounts);
    const sheet = await screen.findByRole('dialog', { name: P.accounts.title });
    const ig = (await within(sheet).findByRole('heading', { name: '@atolye' })).closest('li')!;
    // The status word, and the switch of the same name.
    expect(within(ig).getAllByText(P.accounts.status.on)).toHaveLength(2);
    expect(await within(ig).findByText(P.accounts.replies)).toBeInTheDocument();
    const tt = within(sheet).getByRole('heading', { name: '@atolye.video' }).closest('li')!;
    expect(within(tt).getByText(P.accounts.tiktok)).toBeInTheDocument();
    expect(within(tt).getByText(P.accounts.status.paused)).toBeInTheDocument();
    // The posting switch, at the posting settings' revision.
    const toggle = await within(ig).findByRole('switch', { name: `@atolye · ${P.accounts.switch}` });
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);
    await waitFor(() => expect(sent(calls, 'POST', '/api/social/accounts/ig1/pause')?.body).toEqual({ paused: true, expected_revision: 7 }));
    // The knowledge base's list, never the capability's flag.
    await user.click(within(ig).getByRole('switch', { name: `@atolye · ${P.accounts.approval}` }));
    await waitFor(() => expect(sent(calls, 'POST', '/api/knowledge/post-approval')?.body).toEqual({ capability_id: 'ig1', required: true, expected_revision: knowledge.rules.revision }));
    expect(calls.some((c) => c.path.startsWith('/api/capabilities/') && c.method !== 'GET')).toBe(false);
  });

  it('says every post waits for approval while Kurallar’ switch is on', async () => {
    open('/posts?accounts=1', { ...accounts, 'GET /api/knowledge': { ...knowledge, rules: { ...knowledge.rules, post_approval: true } } });
    const sheet = await screen.findByRole('dialog', { name: P.accounts.title });
    const ig = (await within(sheet).findByRole('heading', { name: '@atolye' })).closest('li')!;
    expect(await within(ig).findByText(P.accounts.rulesAll)).toBeInTheDocument();
    expect(within(ig).queryByRole('switch', { name: `@atolye · ${P.accounts.approval}` })).not.toBeInTheDocument();
  });

  it('reads an account’s numbers only when they are opened', async () => {
    const user = userEvent.setup();
    const { calls, router } = open('/posts?accounts=1', accounts);
    const sheet = await screen.findByRole('dialog', { name: P.accounts.title });
    const ig = (await within(sheet).findByRole('heading', { name: '@atolye' })).closest('li')!;
    expect(calls.some((c) => c.path === '/api/social/accounts/ig1')).toBe(false);
    await user.click(within(ig).getByRole('button', { name: P.accounts.numbers }));
    await waitFor(() => expect(router.state.location.search).toBe('?accounts=1&account=ig1'));
    expect(await within(ig).findByTestId('metric-followers')).toBeInTheDocument();
    await user.click(within(ig).getByRole('button', { name: '7 gün' }));
    await waitFor(() => expect(router.state.location.search).toBe('?accounts=1&account=ig1&days=7'));
  });
});

describe('Ayarlar', () => {
  it('holds the three sections and stops all posting', async () => {
    const user = userEvent.setup();
    const now = new Date().toISOString().slice(0, 4);
    const { calls } = open('/posts?settings=1&section=files', {
      'GET /api/studio/posts': { posts: [], settings: socialSettings },
      'GET /api/studio/calendar': { year: Number(now), entries: [], rows: [], policy: { lead_days: 21, reuse_days: 14, recap_days: 30, ai_standalone: false } },
      'GET /api/studio/overview': { control: { revision: 3, brake_engaged: false, lanes: {} } },
      'POST /api/studio/brake': { revision: 4, brake_engaged: true, lanes: {} },
    });
    const dialog = await screen.findByRole('dialog', { name: P.settings.title });
    expect(within(dialog).getByRole('heading', { name: P.settings.rules })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: P.settings.days })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: P.settings.files })).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    const brake = within(dialog).getByRole('switch', { name: P.settings.brake });
    await waitFor(() => expect(brake).toBeEnabled());
    await user.click(brake);
    await waitFor(() => expect(sent(calls, 'POST', '/api/studio/brake')?.body).toEqual({ engaged: true, lane: 'organic', expected_revision: 3 }));
  });

  it('leaves the posting rules out for a content member', async () => {
    mockFetch(postsAnswers(postsOut(), {
      'GET /api/auth/me': { ...me, memberships: [{ ...me.memberships[0], permissions: ['content.work', 'content.manage'] }] },
      'GET /api/studio/calendar': { year: 2026, entries: [], rows: [], policy: { lead_days: 21, reuse_days: 14, recap_days: 30, ai_standalone: false } },
    }));
    setViewport('desk');
    renderAt('/posts?settings=1');
    const dialog = await screen.findByRole('dialog', { name: P.settings.title });
    expect(within(dialog).queryByRole('heading', { name: P.settings.rules })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: P.settings.days })).toBeInTheDocument();
  });
});
