import { describe, it, expect } from 'vitest';
import { campaignSchema } from './CampaignsPage';

const base = {
  name: 'Promo',
  channel: 'SMS',
  body: 'Hello there',
  bodyHtml: '',
  emailTemplateId: '',
  filters: [],
  iysMessageType: 'BILGILENDIRME',
  voiceMode: 'TTS',
  voiceMsg: 'read aloud',
  voiceAudioId: '',
  voiceKeys: [],
};

const bodyErrors = (r: ReturnType<typeof campaignSchema.safeParse>) =>
  r.success ? [] : r.error.issues.filter((i) => i.path[0] === 'body');

describe('campaignSchema — body requirement is channel-aware (finding #8)', () => {
  it('EMAIL with an attached HTML template but blank plain body is VALID (auto-derived)', () => {
    const r = campaignSchema.safeParse({
      ...base,
      channel: 'EMAIL',
      body: '',
      bodyHtml: '<p>Hello</p>',
    });
    expect(bodyErrors(r)).toHaveLength(0);
  });

  it('SMS with leftover EMAIL bodyHtml but a blank body is INVALID (the bug)', () => {
    // Previously the html fallback applied to every channel, so this passed the
    // form and then 400d on the backend (SMS never sends HTML).
    const r = campaignSchema.safeParse({
      ...base,
      channel: 'SMS',
      body: '',
      bodyHtml: '<p>leftover email html</p>',
    });
    expect(bodyErrors(r).length).toBeGreaterThan(0);
  });

  it('SMS with a real body is VALID', () => {
    const r = campaignSchema.safeParse({ ...base, channel: 'SMS', body: 'Flash sale today' });
    expect(bodyErrors(r)).toHaveLength(0);
  });
});
