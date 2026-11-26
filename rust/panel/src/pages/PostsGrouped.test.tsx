import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import type { Cover, PostRow, PostsOut, Sibling } from '@/api/postsPage';
import { mockFetch, renderAt, type FetchRoutes } from '@/test/render';
import { ago, ahead, detailOf, INSTAGRAM, postRow, postsAnswers, postsOut, setViewport, TIKTOK, wait } from '@/test/postsPage';

// One line per content, its versions inside it, and a panel that shows the post itself
// (owner's request 2026-11-26). Invented rows only.

const P = tr.postsPage;
const HOUR = 3600_000;
const table = () => screen.findByRole('region', { name: P.table.label });
const panel = () => screen.findByRole('complementary', { name: P.panel.label });
const lines = async () => within(within(await table()).getByRole('list')).getAllByRole('listitem').map((li) => li.querySelector('button')!);

const image = (id: string): Cover => ({ material_id: id, mime: 'image/jpeg', preview_url: `/files/${id}.jpg`, preview_expires_at: ahead(HOUR), ai_generated: false });
const video = (id: string): Cover => ({ material_id: id, mime: 'video/mp4', preview_url: `/files/${id}.mp4`, preview_expires_at: ahead(HOUR), ai_generated: false });
const sib = (r: PostRow): Sibling => ({ row_id: r.id, channel: r.channel, publish_at: r.publish_at, status: r.status });

/** The rows of one content, each with the others as its siblings, as the server builds them. */
function content(area: string, members: PostRow[]): PostRow[] {
  const placed = members.map((m) => ({ ...m, area_id: area }));
  return placed.map((m) => ({ ...m, siblings: placed.filter((o) => o.id !== m.id).map(sib) }));
}

const [failed, live] = content('area-a', [
  postRow('slot:a-tt', {
    title: 'Örnek içerik A',
    channel: TIKTOK,
    format: 'tiktok_video',
    status: 'failed',
    publish_at: ago(3 * HOUR),
    progress: { index: 6, state: 'problem' },
    waits: [wait('failed', { reason: 'rate_limited', kind: 'tiktok' })],
    actions: { redo: { project_id: 'area-a', package_revision: 1 }, acknowledge: { slot_id: 'a-tt', expected_revision: 2 } },
    cover: image('ma'),
  }),
  postRow('slot:a-ig', {
    title: 'Örnek içerik A',
    status: 'published',
    publish_at: ago(5 * HOUR),
    published_at: ago(5 * HOUR),
    url: 'https://instagram.example/p/a',
    progress: { index: 7, state: 'done' },
    cover: image('ma'),
  }),
]);
const [waiting, planned] = content('area-b', [
  postRow('slot:b-ig', {
    title: 'Örnek içerik B',
    status: 'waiting_you',
    progress: { index: 5, state: 'waiting_person' },
    waits: [wait('approval')],
    actions: { approve: { slot_id: 'b-ig', expected_revision: 3 }, cancel: { kind: 'post', slot_id: 'b-ig', expected_revision: 3 } },
  }),
  postRow('slot:b-tt', { title: 'Örnek içerik B', channel: TIKTOK, publish_at: ahead(30 * HOUR), actions: { cancel: { kind: 'post', slot_id: 'b-tt', expected_revision: 1 } } }),
]);
const alone = postRow('slot:c', { title: 'Örnek içerik C', area_id: 'area-c' });
// The server's order: what waits for the owner first; a group's rows need not be next to each other.
const list = [failed, waiting, alone, planned, live];

function open(path = '/posts', data: PostsOut = postsOut({ rows: list }), extra: FetchRoutes = {}, view: 'desk' | 'phone' = 'desk') {
  setViewport(view);
  const calls = mockFetch(postsAnswers(data, extra));
  return { calls, ...renderAt(path) };
}

describe('one line per content', () => {
  it('puts two platforms of one content on one line, one chip each with its own state and time', async () => {
    open();
    const found = await lines();
    expect(found).toHaveLength(3);
    const [a, b, c] = found;
    expect(within(a).getAllByText('Örnek içerik A')).toHaveLength(1);
    const chips = a.querySelectorAll('[data-version]');
    expect([...chips].map((chip) => chip.getAttribute('data-version'))).toEqual(['slot:a-tt', 'slot:a-ig']);
    expect(within(chips[0] as HTMLElement).getByText('TikTok')).toBeInTheDocument();
    expect(within(chips[0] as HTMLElement).getByText(P.status.failed)).toBeInTheDocument();
    expect(within(chips[1] as HTMLElement).getByText('Instagram')).toBeInTheDocument();
    expect(within(chips[1] as HTMLElement).getByText(P.status.published)).toBeInTheDocument();
    // B's rows were apart in the read; they stand where its first one stood.
    expect([...b.querySelectorAll('[data-version]')].map((chip) => chip.getAttribute('data-version'))).toEqual(['slot:b-ig', 'slot:b-tt']);
    expect(within(b).getByText(P.status.waiting_you)).toBeInTheDocument();
    expect(c.querySelectorAll('[data-version]')).toHaveLength(1);
    // A thumbnail on the left of the line.
    expect(a.querySelector('img')).toHaveAttribute('src', '/files/ma.jpg');
    // The dots are the line's first row's (A's failed TikTok post: six of eight), once per line.
    expect(within(a).getByRole('img', { name: 'Süreç: 8 adımın 6 tanesi bitti' })).toBeInTheDocument();
    expect(within(a).getAllByTestId('dots')).toHaveLength(1);
    expect(within(b).getByRole('img', { name: 'Süreç: 8 adımın 5 tanesi bitti' })).toBeInTheDocument();
  });

  it('keeps a version that needs the owner on the line, even when its sibling is fine', async () => {
    // The fine one comes first: the failed one is still said on the line.
    const [ok, broken] = content('area-z', [
      postRow('slot:z-ig', { title: 'Örnek içerik Z', status: 'published', published_at: ago(HOUR) }),
      postRow('slot:z-tt', { title: 'Örnek içerik Z', channel: TIKTOK, status: 'failed', waits: [wait('failed', { reason: 'auth', kind: 'tiktok' })] }),
    ]);
    open('/posts', postsOut({ rows: [ok, broken] }));
    const [line] = await lines();
    expect(within(line).getByText(P.status.failed)).toBeInTheDocument();
    expect(within(line).getByText(P.status.published)).toBeInTheDocument();
  });

  it('keeps the counts the server’s, of posts, while the lines are of contents', async () => {
    open('/posts', postsOut({ rows: list, counts: { all: 5, you: 2, stages: { onay: 1, yayin: 3, sonuc: 1 } } }));
    const chips = await screen.findByRole('group', { name: P.chips.label });
    expect(await within(chips).findByRole('button', { name: /Tümü\s*5/ })).toBeInTheDocument();
    expect(within(chips).getByRole('button', { name: /Seni bekleyen\s*2/ })).toBeInTheDocument();
    expect(await lines()).toHaveLength(3);
    // Five chips: one per post the count counts.
    expect((await table()).querySelectorAll('[data-version]')).toHaveLength(5);
  });

  it('under a filter shows only the versions the filter returned', async () => {
    open('/posts?f=you', postsOut({ rows: [failed, waiting], counts: { all: 5, you: 2, stages: {} } }));
    const found = await lines();
    expect(found).toHaveLength(2);
    expect([...found[0].querySelectorAll('[data-version]')].map((c) => c.getAttribute('data-version'))).toEqual(['slot:a-tt']);
  });

  it('opens the line’s first version, or the one the panel already shows', async () => {
    const user = userEvent.setup();
    const { router } = open('/posts?slot=c');
    await within(await panel()).findByRole('heading', { name: 'Örnek içerik C' });
    const [, b] = await lines();
    await user.click(b);
    await waitFor(() => expect(router.state.location.search).toBe('?slot=b-ig'));
    expect(router.state.historyAction).toBe('PUSH');
    expect(b).toHaveAttribute('aria-pressed', 'true');
  });

  it('works as cards on a phone, chips inside', async () => {
    open('/posts', postsOut({ rows: list }), {}, 'phone');
    const [a] = await lines();
    expect(a.querySelectorAll('[data-version]')).toHaveLength(2);
    expect(within(a).getByText(P.status.failed)).toBeInTheDocument();
  });
});

describe('the panel shows the post', () => {
  it('shows a picture first, as wide as the panel, and opens it full size', async () => {
    const user = userEvent.setup();
    open('/posts?slot=a-ig');
    const p = await panel();
    const media = await within(p).findByRole('region', { name: P.media.label });
    const img = within(media).getByRole('img', { name: 'Örnek içerik A' });
    expect(img).toHaveAttribute('src', '/files/ma.jpg');
    expect(img.className).toContain('w-full');
    // Media before the caption.
    const caption = await within(p).findByText(/Atölyemizde elde şekillendirildi/);
    expect(media.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(within(media).getByRole('button', { name: P.media.full }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('img', { name: 'Örnek içerik A' })).toHaveAttribute('src', '/files/ma.jpg');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await panel()).toBeInTheDocument();
  });

  it('shows every slide of a carousel, in order', async () => {
    const slides = [image('s1'), image('s2'), image('s3')];
    const row = postRow('slot:car', { title: 'Kaydırmalı örnek', format: 'carousel', media: { images: 3, video_seconds: null }, cover: slides[0] });
    open('/posts?slot=car', postsOut({ rows: [row] }), { 'GET /api/content/posts/slot%3Acar': detailOf(row, { materials: slides }) });
    const media = await within(await panel()).findByRole('region', { name: P.media.label });
    await waitFor(() => expect(media.querySelectorAll('[data-slide]')).toHaveLength(3));
    expect([...media.querySelectorAll('[data-slide] img')].map((i) => i.getAttribute('src'))).toEqual(['/files/s1.jpg', '/files/s2.jpg', '/files/s3.jpg']);
    expect(within(media).getByLabelText('1. görsel / 3')).toBeInTheDocument();
  });

  it('plays a video in place', async () => {
    const clip = video('v1');
    const row = postRow('slot:vid', { title: 'Video örnek', channel: TIKTOK, format: 'tiktok_video', media: { images: 0, video_seconds: 12 }, cover: clip });
    open('/posts?slot=vid', postsOut({ rows: [row] }), { 'GET /api/content/posts/slot%3Avid': detailOf(row, { materials: [clip] }) });
    const p = await panel();
    const player = await within(p).findByTestId('post-video');
    expect(player).toHaveAttribute('controls');
    expect(player.getAttribute('src')).toMatch(/^\/files\/v1\.mp4/);
  });

  it('gives each version a block with its platform, time, state and its own actions', async () => {
    open('/posts?slot=a-tt');
    const p = await panel();
    const versions = await within(p).findByRole('list', { name: P.panel.versions });
    const blocks = within(versions).getAllByRole('listitem');
    expect(blocks.map((b) => b.getAttribute('data-version'))).toEqual(['slot:a-tt', 'slot:a-ig']);
    const [tt, ig] = blocks;
    expect(tt).toHaveAttribute('aria-current', 'true');
    expect(within(tt).getByText('TikTok')).toBeInTheDocument();
    expect(within(tt).getByText('alfaatolye')).toBeInTheDocument();
    // The failure's reason and its remedies, as today.
    expect(within(tt).getByTestId('wait-sentence')).toHaveTextContent('platform geçici olarak almadı');
    expect(within(tt).getByRole('button', { name: P.actions.retry })).toBeInTheDocument();
    expect(within(tt).getByRole('button', { name: P.actions.dismiss })).toBeInTheDocument();
    // The published one: its link, no action the row does not carry.
    expect(within(ig).getByText('Instagram')).toBeInTheDocument();
    expect(within(ig).getByRole('link', { name: P.panel.openPost })).toHaveAttribute('href', 'https://instagram.example/p/a');
    expect(within(ig).queryByRole('button', { name: P.actions.retry })).not.toBeInTheDocument();
    expect(within(ig).queryByRole('button', { name: P.actions.cancel })).not.toBeInTheDocument();
  });

  it('keeps exactly the actions each row carries', async () => {
    open('/posts?slot=b-ig');
    const versions = await within(await panel()).findByRole('list', { name: P.panel.versions });
    const [ig, tt] = within(versions).getAllByRole('listitem');
    const names = (el: HTMLElement) => within(el).queryAllByRole('button').map((b) => b.textContent).filter((n) => n === P.actions.approve || n === P.actions.cancel || n === P.actions.redo);
    expect(names(ig)).toEqual([P.actions.approve, P.actions.cancel]);
    expect(names(tt)).toEqual([P.actions.cancel]);
  });

  it('shows another version in place, so Back closes the panel', async () => {
    const user = userEvent.setup();
    const { router } = open('/posts');
    const [a] = await lines();
    await user.click(a);
    await waitFor(() => expect(router.state.location.search).toBe('?slot=a-tt'));
    const versions = await within(await panel()).findByRole('list', { name: P.panel.versions });
    await user.click(within(versions).getAllByRole('listitem')[1].querySelector('button')!);
    await waitFor(() => expect(router.state.location.search).toBe('?slot=a-ig'));
    expect(router.state.historyAction).toBe('REPLACE');
    await waitFor(() => expect(within(versions).getAllByRole('listitem')[1]).toHaveAttribute('aria-current', 'true'));
    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('reads a version the list does not hold, and gives it its block', async () => {
    const extra = { 'GET /api/content/posts/slot%3Aa-ig': detailOf(live) };
    const { calls } = open('/posts?f=you&slot=a-tt', postsOut({ rows: [failed, waiting] }), extra);
    const versions = await within(await panel()).findByRole('list', { name: P.panel.versions });
    await waitFor(() => expect(within(versions).getAllByRole('listitem')[1]).toHaveTextContent(P.panel.openPost));
    expect(calls.some((c) => c.path === '/api/content/posts/slot%3Aa-ig' || c.path === '/api/content/posts/slot:a-ig')).toBe(true);
  });

  it('keeps the AI note and the category, short', async () => {
    const row = postRow('slot:ai', { title: 'Yapay görsel', ai_illustration: true, category: { olay_id: 'o1', title: 'Bir olay' } });
    open('/posts?slot=ai', postsOut({ rows: [row] }));
    const p = await panel();
    expect(await within(p).findByText(P.panel.ai)).toBeInTheDocument();
    expect(within(p).getByText('Gönderi · tek görsel · Bir olay')).toBeInTheDocument();
  });

  it('shows the post on a phone too, in the sheet', async () => {
    open('/posts?slot=a-ig', postsOut({ rows: list }), {}, 'phone');
    const sheet = await screen.findByRole('dialog', { name: P.panel.label });
    expect(await within(sheet).findByRole('region', { name: P.media.label })).toBeInTheDocument();
    expect(within(sheet).getAllByRole('listitem').filter((li) => li.hasAttribute('data-version'))).toHaveLength(2);
  });
});
