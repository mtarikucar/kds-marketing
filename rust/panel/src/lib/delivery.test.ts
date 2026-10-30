import { describe, expect, it } from 'vitest';
import i18n from '@/i18n/config';
import tr from '@/i18n/tr.json';
import { deliveryText, failureText } from './delivery';

const t = i18n.t.bind(i18n);

describe('failureText', () => {
  it('explains the provider codes an owner can act on', () => {
    expect(
      failureText(t, 'permanent: meta: HTTP 400 OAuthException (#131030): Recipient phone number not in allowed list'),
    ).toBe(tr.failure.recipientNotAllowed);
    expect(failureText(t, 'permanent: meta: HTTP 400 (#131047): Re-engagement message')).toBe(tr.failure.windowClosed);
    expect(failureText(t, 'auth: meta: HTTP 400 OAuthException (#190/463): Session has expired')).toBe(
      tr.failure.reconnect,
    );
  });

  it('explains what X says about credits and duplicate posts', () => {
    expect(failureText(t, 'permanent: x: HTTP 402 CreditsDepleted: Your enrolled account has no credits')).toBe(
      tr.failure.xCredits,
    );
    expect(
      failureText(t, 'permission: x: HTTP 403 Forbidden: You are not allowed to create a Tweet with duplicate content.'),
    ).toBe(tr.failure.xDuplicate);
    // Another X refusal falls back to its kind.
    expect(failureText(t, 'permission: x: HTTP 403 Forbidden: client not enrolled')).toBe(tr.failure.permission);
  });

  it("explains TikTok's own codes, before the error kind", () => {
    const cases: [string, string][] = [
      [
        'permission: tiktok: HTTP 403 unaudited_client_can_only_post_to_private_accounts: Please review our integration guidelines',
        tr.failure.tiktokUnaudited,
      ],
      [
        'permission: tiktok: privacy level PUBLIC_TO_EVERYONE not available (app not audited or private account)',
        tr.failure.tiktokPrivacy,
      ],
      ['permission: tiktok: HTTP 400 privacy_level_option_mismatch: no', tr.failure.tiktokPrivacy],
      ['throttle: tiktok: HTTP 200 spam_risk_too_many_posts: cap', tr.failure.tiktokCap],
      ['throttle: tiktok: HTTP 403 spam_risk_too_many_pending_share: cap', tr.failure.tiktokCap],
      ['throttle: tiktok: HTTP 200 reached_active_user_cap: app cap', tr.failure.tiktokAppCap],
      ['permission: tiktok: HTTP 403 spam_risk_user_banned_from_posting: banned', tr.failure.tiktokBanned],
      ['permanent: tiktok: HTTP 403 url_ownership_unverified: verify', tr.failure.tiktokDomain],
      ['permanent: tiktok: publish failed: spam_risk_text', tr.failure.tiktokSpam],
      ['permanent: tiktok: publish failed: spam_risk', tr.failure.tiktokSpam],
      ['permanent: tiktok: publish failed: duration_check_failed', tr.failure.tiktokMedia],
      ['permanent: tiktok: publish failed: picture_size_check_failed', tr.failure.tiktokMedia],
    ];
    for (const [line, text] of cases) expect(failureText(t, line)).toBe(text);
    // The creator removed the app's access while it processed: reconnect, by the error kind.
    expect(failureText(t, 'auth: tiktok: publish failed: auth_removed')).toBe(tr.failure.reconnect);
    // Another TikTok code falls back to the kind, or TikTok's own words.
    expect(failureText(t, 'throttle: tiktok: HTTP 429 rate_limit_exceeded: slow')).toBe(tr.failure.throttled);
    expect(failureText(t, 'permanent: tiktok: publish failed: internal')).toBe('publish failed: internal');
    // A code is TikTok's only on a TikTok line.
    expect(failureText(t, 'permanent: x: spam_risk_text')).toBe('spam_risk_text');
  });

  it('explains an error kind or stable reason without a known code', () => {
    expect(failureText(t, 'auth: meta: the credential was refused')).toBe(tr.failure.reconnect);
    expect(failureText(t, 'throttle: x')).toBe(tr.failure.throttled);
    expect(failureText(t, 'send_configuration_invalid')).toBe(tr.failure.configuration);
  });

  it("falls back to the provider's own words", () => {
    expect(failureText(t, 'permanent: meta: HTTP 400 (#100): Invalid parameter')).toBe('HTTP 400 (#100): Invalid parameter');
    expect(failureText(t, 'permanent: media: VALIDATION file_too_large')).toBe('media: VALIDATION file_too_large');
    expect(failureText(t, 'mystery')).toBe('mystery');
  });
});

describe('deliveryText', () => {
  it('adds the explained reason to a failed or uncertain message, and nothing else changes', () => {
    expect(
      deliveryText(t, {
        status: 'failed',
        failure_reason: 'permanent: meta: HTTP 400 OAuthException (#131030): Recipient phone number not in allowed list',
      }),
    ).toBe(`Gönderilemedi: ${tr.failure.recipientNotAllowed}`);
    expect(deliveryText(t, { status: 'unknown', failure_reason: 'unknown: meta: lost acknowledgement' })).toBe(
      'Teslim durumu belirsiz; tekrar göndermeyin (lost acknowledgement).',
    );
    expect(deliveryText(t, { status: 'failed', failure_reason: null })).toBe(tr.inbox.delivery.failed);
    expect(deliveryText(t, { status: 'sent' })).toBe(tr.inbox.delivery.sent);
    expect(deliveryText(t, { status: { refused: { reason: 'IZIN_YOK' } } })).toBe('Gönderim reddedildi: IZIN_YOK');
  });
});
