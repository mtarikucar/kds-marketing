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

// prelaunch-safety: the subject is what a recipient sees before they open the
// mail, and the sender's "Update" fallback was never meant to ship. EMAIL only
// — SMS/WHATSAPP/VOICE do not even render a subject field.
describe('campaignSchema — an EMAIL campaign needs a subject', () => {
  const subjectErrors = (r: ReturnType<typeof campaignSchema.safeParse>) =>
    r.success ? [] : r.error.issues.filter((i) => i.path[0] === 'subject');

  it('EMAIL with a blank subject is INVALID', () => {
    expect(subjectErrors(campaignSchema.safeParse({ ...base, channel: 'EMAIL', subject: '   ' })).length)
      .toBeGreaterThan(0);
  });

  it('EMAIL with a subject is VALID', () => {
    expect(subjectErrors(campaignSchema.safeParse({ ...base, channel: 'EMAIL', subject: 'Bahar indirimi' })))
      .toHaveLength(0);
  });

  it('SMS without a subject is VALID (the field is not even rendered)', () => {
    expect(subjectErrors(campaignSchema.safeParse({ ...base, channel: 'SMS', subject: '' }))).toHaveLength(0);
  });
});

// A rule with a field but no value was silently dropped at submit, so an
// operator who typed nothing in "status = …" mailed the whole list.
describe('campaignSchema — an incomplete audience rule', () => {
  const filterErrors = (r: ReturnType<typeof campaignSchema.safeParse>) =>
    r.success ? [] : r.error.issues.filter((i) => i.path[0] === 'filters');

  it('a rule with no value is INVALID', () => {
    const r = campaignSchema.safeParse({ ...base, filters: [{ field: 'status', op: 'eq', value: '' }] });
    expect(filterErrors(r).length).toBeGreaterThan(0);
  });

  it('a rule with no field is INVALID', () => {
    const r = campaignSchema.safeParse({ ...base, filters: [{ field: '', op: 'eq', value: 'NEW' }] });
    expect(filterErrors(r).length).toBeGreaterThan(0);
  });

  it('a complete rule is VALID', () => {
    const r = campaignSchema.safeParse({ ...base, filters: [{ field: 'status', op: 'eq', value: 'NEW' }] });
    expect(filterErrors(r)).toHaveLength(0);
  });

  // `exists` carries a boolean-as-string, which is a real value.
  it('an exists rule with "false" is VALID', () => {
    const r = campaignSchema.safeParse({ ...base, filters: [{ field: 'city', op: 'exists', value: 'false' }] });
    expect(filterErrors(r)).toHaveLength(0);
  });
});
