import { describe, expect, it } from 'vitest';
import { connectorHealth } from '@/test/fixtures';
import { healthView, renewalOf } from './connectors';

describe('who renews a connection', () => {
  it('names X and TikTok as renewing themselves, the WhatsApp Business app sign-in as a person’s, the rest as tried', () => {
    expect(renewalOf('tiktok')).toBe('self');
    expect(renewalOf('tiktok_ads')).toBe('self');
    expect(renewalOf('x')).toBe('self');
    expect(renewalOf('whatsapp_cloud', 'whatsapp_business_app')).toBe('person');
    expect(renewalOf('whatsapp_cloud')).toBe('tries');
    expect(renewalOf('instagram')).toBe('tries');
    expect(renewalOf('linkedin_member')).toBe('tries');
  });

  it('does not warn of a TikTok or X token’s end, which is renewed every hour', () => {
    const now = new Date('2026-11-19T10:00:00Z');
    const base = { ...connectorHealth[1], token_expires_at: '2026-11-20T07:24:46Z' };
    expect(healthView({ ...base, kind_key: 'tiktok', provider: 'tiktok' }, now).kind).toBe('ok');
    expect(healthView({ ...base, kind_key: 'x', provider: 'x', token_expires_at: '2026-11-19T09:00:00Z' }, now).kind).toBe('ok');
    expect(healthView({ ...base, kind_key: 'instagram', provider: 'meta' }, now)).toEqual({ kind: 'expiresSoon', at: '2026-11-20T07:24:46Z' });
    expect(healthView({ ...base, kind_key: 'tiktok', provider: 'tiktok', reconnect_required: true }, now).kind).toBe('reconnect');
  });
});
