import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt, withStatus } from '@/test/render';
import { inboxAnswers, inboxMe } from '@/test/inbox';
import i18n from '@/i18n/config';

// TikTok's Content Sharing Guidelines (https://developers.tiktok.com/doc/content-sharing-guidelines):
// a TikTok piece waiting in Today is its posting screen, not a plain Approve button.

const h = {
  id: 'h1',
  title: 'Kısa hikâyeler',
  metric: 'engagement',
  prior_confidence: 0.4,
  derived_confidence: 0.7,
  channel: 'any',
  cadence: {},
  state: 'kept',
};
const chain = { workspace_id: 'w', born_version_id: 'v1', hypothesis_id: 'h1', arm_id: 'a1' };
const slot = {
  id: 's1',
  chain,
  capability_id: 'c1',
  scheduled_at: '2026-10-28T09:30:00Z',
  state: 'ready',
  revision: 3,
};
const overview = (awaiting: boolean) => ({
  strategy: { id: 'v1', number: 3 },
  goals: { objective: 'Daha çok yanıt', kpis: [] },
  hypotheses: [h],
  control: { revision: 2, brake_engaged: false, lanes: {} },
  lane_support: {
    organic: { visible: true, supported: true },
    paid: { visible: false, supported: false },
  },
  slots: [slot],
  today: {
    slots: [{ slot, overdue: false }],
    approvals: awaiting ? [{ slot: 's1' }] : [],
    budget_moves: [],
    blockers: awaiting
      ? [
          {
            target: { slot: 's1' },
            reason: 'human_approval_required',
            next_action: 'tiktok_posting_screen',
          },
        ]
      : [],
    paid_alerts: [],
  },
  learned: {
    hypotheses: [],
    arms: [
      {
        arm: {
          id: 'a1',
          key: { hypothesis_id: 'h1', lane: 'organic', channel: 'tiktok', content_type: 'video' },
          alpha: 2,
          beta: 3,
          weight: 0.4,
        },
        evidence: [],
      },
    ],
    lane_performance: [],
    spend_vs_cap: [],
    trends: [],
    judgments: [],
  },
  bindings: [],
});
const creator = {
  nickname: 'Jeeta Test',
  username: 'jeeta_test',
  avatar_url: 'https://p16.tiktokcdn.test/avatar.jpeg',
  privacy_level_options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
  comment_disabled: false,
  duet_disabled: true,
  stitch_disabled: false,
  max_video_post_duration_sec: 600,
  cannot_post: null,
};
const screenAnswer = (overrides: Record<string, unknown> = {}) => ({
  slot,
  creator,
  title: 'Bugünün menüsü #yemek',
  media: { kind: 'video', duration_ms: null },
  max_title_units: 2200,
  previews: [{ url: 'https://files.example.com/files/f1', mime: 'video/mp4' }],
  approval: null,
  ...overrides,
});
const detail = (attempts: unknown[] = []) => ({
  slot,
  piece: { text: 'Bugünün menüsü #yemek', media: [{ kind: 'file', id: 'f1' }], adaptations: {} },
  hypothesis: h,
  brand_rules: { identity: { voice: 'Sade' }, prohibitions: [] },
  learned: overview(true).learned.arms[0].arm,
  attempts,
  measurements: [],
});
const answers = (awaiting = true, extra: Record<string, unknown> = {}) => ({
  ...inboxAnswers,
  'GET /api/auth/me': {
    ...inboxMe,
    memberships: [
      {
        ...inboxMe.memberships[0],
        permissions: [...inboxMe.memberships[0].permissions, 'studio.work', 'studio.manage'],
      },
    ],
  },
  'GET /api/studio/overview': overview(awaiting),
  'GET /api/studio/ledger': { entries: [], next_before: null },
  'GET /api/work/pending': {
    items: [],
    agent: { overdue: false, interval_minutes: 60, last_seen_at: null },
    strategy: { approved: { number: 3 } },
  },
  'GET /api/capabilities': [
    {
      capability: { id: 'c1', name: 'Jeeta TikTok', kind_key: 'tiktok' },
      effective_status: 'verified',
    },
  ],
  'GET /api/studio/slots/s1': detail(),
  'GET /api/studio/slots/s1/tiktok': screenAnswer(),
  ...extra,
});

async function postingScreen() {
  const card = await screen.findByTestId('today-s1');
  return within(card).findByRole('form', { name: "TikTok'ta paylaş" });
}

describe('TikTok posting screen', () => {
  it('reads_the_account_and_presets_nothing', async () => {
    const calls = mockFetch(answers());
    renderAt('/studio');
    const form = await postingScreen();
    // The account the post goes to, read fresh for the screen.
    expect(await within(form).findByText('Jeeta Test (@jeeta_test) hesabında paylaşılacak')).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/api/studio/slots/s1/tiktok')).toHaveLength(1);
    // A preview of the video, with nothing laid over it.
    const video = within(form).getByLabelText('Paylaşılacak video');
    expect(video).toHaveAttribute('src', 'https://files.example.com/files/f1');
    // The caption is the draft, editable.
    expect(within(form).getByLabelText('Açıklama')).toHaveValue('Bugünün menüsü #yemek');
    // Privacy: exactly the account's options, none chosen.
    const privacy = within(form).getByLabelText('Bu paylaşımı kimler görebilir');
    expect(privacy).toHaveValue('');
    expect(
      within(privacy)
        .getAllByRole('option')
        .filter((o) => o.getAttribute('value') !== '')
        .map((o) => o.textContent),
    ).toEqual(['Herkes', 'Arkadaşlar', 'Yalnızca ben']);
    // Interactions off; one the creator turned off is greyed out.
    for (const name of ['Yorum', 'Düet', 'Birleştirme (Stitch)']) {
      expect(within(form).getByRole('checkbox', { name })).not.toBeChecked();
    }
    expect(within(form).getByRole('checkbox', { name: 'Düet' })).toBeDisabled();
    expect(within(form).getByRole('checkbox', { name: 'Yorum' })).toBeEnabled();
    // The commercial content disclosure is off, its choices hidden.
    expect(within(form).getByRole('switch', { name: 'Ticari içeriği belirt' })).not.toBeChecked();
    expect(within(form).queryByRole('checkbox', { name: /Kendi markanız/ })).not.toBeInTheDocument();
    // The declaration above the button, with TikTok's link.
    expect(within(form).getByRole('link', { name: 'Müzik Kullanım Onayı' })).toHaveAttribute(
      'href',
      'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en',
    );
    expect(within(form).queryByRole('link', { name: 'Markalı İçerik Politikası' })).not.toBeInTheDocument();
    // No privacy chosen: nothing can be posted; no plain approve button either.
    expect(within(form).getByRole('button', { name: "TikTok'ta paylaş" })).toBeDisabled();
    expect(within(screen.getByTestId('today-s1')).queryByRole('button', { name: 'Onayla' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('posts_exactly_what_was_chosen_and_says_processing_takes_minutes', async () => {
    const calls = mockFetch(answers(true, { 'POST /api/studio/slots/s1/tiktok': { revision: 3 } }));
    renderAt('/studio');
    const user = userEvent.setup();
    const form = await postingScreen();
    const caption = await within(form).findByLabelText('Açıklama');
    await user.clear(caption);
    await user.type(caption, 'Yeni menü #lezzet');
    await user.selectOptions(within(form).getByLabelText('Bu paylaşımı kimler görebilir'), 'MUTUAL_FOLLOW_FRIENDS');
    await user.click(within(form).getByRole('checkbox', { name: 'Yorum' }));
    await user.click(within(form).getByRole('button', { name: "TikTok'ta paylaş" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.path === '/api/studio/slots/s1/tiktok')?.body).toEqual({
        expected_revision: 3,
        post: {
          title: 'Yeni menü #lezzet',
          privacy_level: 'MUTUAL_FOLLOW_FRIENDS',
          allow_comment: true,
          allow_duet: false,
          allow_stitch: false,
          disclose_commercial: false,
          your_brand: false,
          branded_content: false,
        },
      }),
    );
    expect(
      await screen.findByText(
        'Yayınlandıktan sonra paylaşımın işlenip TikTok profilinde görünmesi birkaç dakika sürebilir.',
      ),
    ).toBeInTheDocument();
  });

  it('commercial_content_needs_a_choice_and_branded_content_is_never_private', async () => {
    mockFetch(answers());
    renderAt('/studio');
    const user = userEvent.setup();
    const form = await postingScreen();
    const privacy = await within(form).findByLabelText('Bu paylaşımı kimler görebilir');
    await user.selectOptions(privacy, 'PUBLIC_TO_EVERYONE');
    const publish = within(form).getByRole('button', { name: "TikTok'ta paylaş" });
    expect(publish).toBeEnabled();
    await user.click(within(form).getByRole('switch', { name: 'Ticari içeriği belirt' }));
    // Turned on, it must say whom it promotes before anything is posted.
    expect(publish).toBeDisabled();
    const why =
      'İçeriğinizin sizi mi, üçüncü bir tarafı mı yoksa ikisini birden mi tanıttığını belirtmeniz gerekir.';
    expect(publish.closest('[title]')).toHaveAttribute('title', why);
    expect(within(form).getByText(why)).toBeInTheDocument();
    await user.click(within(form).getByRole('checkbox', { name: /Kendi markanız/ }));
    expect(publish).toBeEnabled();
    expect(within(form).getByText("Fotoğrafınız/videonuz 'Tanıtım içeriği' olarak etiketlenecek")).toBeInTheDocument();
    await user.click(within(form).getByRole('checkbox', { name: /Markalı içerik/ }));
    expect(within(form).getByText("Fotoğrafınız/videonuz 'Ücretli ortaklık' olarak etiketlenecek")).toBeInTheDocument();
    // Branded content: the declaration names its policy, and "Only me" cannot be chosen.
    expect(within(form).getByRole('link', { name: 'Markalı İçerik Politikası' })).toHaveAttribute(
      'href',
      'https://www.tiktok.com/legal/page/global/bc-policy/en',
    );
    const onlyMe = within(privacy).getByRole('option', { name: 'Yalnızca ben' });
    expect(onlyMe).toBeDisabled();
    expect(onlyMe).toHaveAttribute('title', "Markalı içeriğin görünürlüğü 'Yalnızca ben' olamaz.");
  });

  it('a_private_post_cannot_be_branded_content', async () => {
    mockFetch(answers());
    renderAt('/studio');
    const user = userEvent.setup();
    const form = await postingScreen();
    await user.selectOptions(await within(form).findByLabelText('Bu paylaşımı kimler görebilir'), 'SELF_ONLY');
    await user.click(within(form).getByRole('switch', { name: 'Ticari içeriği belirt' }));
    expect(within(form).getByRole('checkbox', { name: /Markalı içerik/ })).toBeDisabled();
    expect(within(form).getByText("Markalı içeriğin görünürlüğü 'Yalnızca ben' olamaz.")).toBeInTheDocument();
    expect(within(form).getByRole('checkbox', { name: /Kendi markanız/ })).toBeEnabled();
  });

  it('an_account_that_cannot_post_now_stops_the_attempt', async () => {
    mockFetch(
      answers(true, {
        'GET /api/studio/slots/s1/tiktok': screenAnswer({
          creator: { ...creator, cannot_post: 'spam_risk_too_many_posts' },
        }),
      }),
    );
    renderAt('/studio');
    const card = await screen.findByTestId('today-s1');
    expect(
      await within(card).findByText('Bu TikTok hesabı şu anda paylaşım yapamıyor. Daha sonra yeniden deneyin.'),
    ).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: "TikTok'ta paylaş" })).not.toBeInTheDocument();
  });

  it('a_video_longer_than_the_account_may_post_cannot_be_posted', async () => {
    mockFetch(answers());
    renderAt('/studio');
    const user = userEvent.setup();
    const form = await postingScreen();
    await user.selectOptions(await within(form).findByLabelText('Bu paylaşımı kimler görebilir'), 'SELF_ONLY');
    const video = within(form).getByLabelText('Paylaşılacak video');
    Object.defineProperty(video, 'duration', { configurable: true, value: 601.2 });
    fireEvent(video, new Event('loadedmetadata'));
    expect(
      await within(form).findByText('Bu video 602 sn; bu hesap en fazla 600 sn\'lik video paylaşabilir.'),
    ).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: "TikTok'ta paylaş" })).toBeDisabled();
  });

  it('photo_posts_offer_comments_only', async () => {
    mockFetch(
      answers(true, {
        'GET /api/studio/slots/s1/tiktok': screenAnswer({
          media: { kind: 'photos' },
          max_title_units: 4000,
          previews: [
            { url: 'https://files.example.com/files/p1', mime: 'image/png' },
            { url: 'https://files.example.com/files/p2', mime: 'image/png' },
          ],
        }),
      }),
    );
    renderAt('/studio');
    const form = await postingScreen();
    expect(await within(form).findByRole('img', { name: 'Paylaşılacak fotoğraf 2' })).toHaveAttribute(
      'src',
      'https://files.example.com/files/p2',
    );
    expect(within(form).getByRole('checkbox', { name: 'Yorum' })).toBeInTheDocument();
    expect(within(form).queryByRole('checkbox', { name: 'Düet' })).not.toBeInTheDocument();
    expect(within(form).queryByRole('checkbox', { name: 'Birleştirme (Stitch)' })).not.toBeInTheDocument();
  });

  it('a_refused_choice_is_explained', async () => {
    mockFetch(
      answers(true, {
        'POST /api/studio/slots/s1/tiktok': withStatus(422, {
          code: 'VALIDATION',
          message: 'refused',
          details: { field: 'post', reason: 'tiktok_privacy_not_offered' },
        }),
      }),
    );
    renderAt('/studio');
    const user = userEvent.setup();
    const form = await postingScreen();
    await user.selectOptions(await within(form).findByLabelText('Bu paylaşımı kimler görebilir'), 'PUBLIC_TO_EVERYONE');
    await user.click(within(form).getByRole('button', { name: "TikTok'ta paylaş" }));
    expect(
      await within(form).findByText('Bu hesap artık bu gizlilik seçeneğini sunmuyor. Yeniden seçin.'),
    ).toBeInTheDocument();
  });

  it('a_posted_piece_shows_its_status_while_tiktok_processes_it', async () => {
    mockFetch(
      answers(false, {
        'GET /api/studio/overview': {
          ...overview(false),
          today: {
            ...overview(false).today,
            blockers: [{ target: { slot: 's1' }, reason: 'publish_processing' }],
          },
        },
        'GET /api/studio/slots/s1': detail([
          {
            state: 'unknown',
            outcome: { status: 'observed', evidence: { external_id: 'v_pub_1', url: null } },
          },
        ]),
      }),
    );
    renderAt('/studio');
    const card = await screen.findByTestId('today-s1');
    expect(await within(card).findByText('Paylaşım durumu: TikTok paylaşımı işliyor…')).toBeInTheDocument();
    // Processing is not an uncertain outcome to review.
    expect(within(card).getByText('Sağlayıcı paylaşımı işliyor; görünmesi birkaç dakika sürebilir.')).toBeInTheDocument();
    expect(within(card).queryByText('Yayın sonucu belirsiz')).not.toBeInTheDocument();
    expect(
      within(card).getByText(
        'Yayınlandıktan sonra paylaşımın işlenip TikTok profilinde görünmesi birkaç dakika sürebilir.',
      ),
    ).toBeInTheDocument();
    expect(within(card).queryByRole('form', { name: "TikTok'ta paylaş" })).not.toBeInTheDocument();
  });

  it('speaks_english_with_tiktoks_own_words', async () => {
    await i18n.changeLanguage('en');
    try {
      mockFetch(answers());
      renderAt('/studio');
      const user = userEvent.setup();
      const card = await screen.findByTestId('today-s1');
      const form = await within(card).findByRole('form', { name: 'Post to TikTok' });
      await user.click(await within(form).findByRole('switch', { name: 'Disclose commercial content' }));
      expect(
        within(form).getByText('You need to indicate if your content promotes yourself, a third party, or both.'),
      ).toBeInTheDocument();
      expect(within(form).getByText(/By posting, you agree to TikTok's/)).toHaveTextContent(
        "By posting, you agree to TikTok's Music Usage Confirmation.",
      );
      await user.click(within(form).getByRole('checkbox', { name: /Branded content/ }));
      expect(within(form).getByText("Your photo/video will be labeled as 'Paid partnership'")).toBeInTheDocument();
      expect(within(form).getByText(/By posting, you agree to TikTok's/)).toHaveTextContent(
        "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation.",
      );
    } finally {
      await i18n.changeLanguage('tr');
    }
  });
});
