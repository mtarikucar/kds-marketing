import { metaWebhookCallbackUrl } from './meta-callback.util';

describe('metaWebhookCallbackUrl', () => {
  it('builds the static webhook path from PUBLIC_BASE_URL', () => {
    expect(metaWebhookCallbackUrl('https://app.example.com')).toBe(
      'https://app.example.com/api/public/channels/meta/webhook',
    );
  });

  it('strips a trailing slash on the base', () => {
    expect(metaWebhookCallbackUrl('https://app.example.com/')).toBe(
      'https://app.example.com/api/public/channels/meta/webhook',
    );
  });

  it('returns null when the base url is unset', () => {
    expect(metaWebhookCallbackUrl(undefined)).toBeNull();
    expect(metaWebhookCallbackUrl(null)).toBeNull();
    expect(metaWebhookCallbackUrl('')).toBeNull();
  });
});
