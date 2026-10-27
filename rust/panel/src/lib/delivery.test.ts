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
