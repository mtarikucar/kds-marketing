import { describe, expect, it } from 'vitest';
import i18n from '@/i18n/config';
import { person } from '@/test/inbox';
import { personName } from './people';

const t = i18n.t.bind(i18n);
const identity = (channel: string, value_display: string, active = true) => ({
  id: `identity-${channel}`,
  workspace_id: person.workspace_id,
  person_id: person.id,
  channel,
  value_normalized: value_display,
  value_display,
  active,
  first_seen_at: '2026-10-23T10:00:00Z',
});

describe('personName', () => {
  it('is the name when there is one', () => {
    expect(personName(t, { ...person, display_name: '  Deniz Örnek ' })).toBe('Deniz Örnek');
  });

  it('falls back to a phone number or e-mail address the person is known by', () => {
    const unnamed = { ...person, display_name: '' };
    expect(personName(t, unnamed, [identity('messenger', '27325092857145601'), identity('phone', '+90 532 123 45 67')])).toBe(
      '+90 532 123 45 67',
    );
    expect(personName(t, unnamed, [identity('email', 'ada@example.com', false)])).toBe('WhatsApp kişisi');
  });

  it('names an opaque contact by its channel and the end of its provider id', () => {
    const unnamed = { ...person, display_name: '', first_touch: { ...person.first_touch, source: { channel: 'messenger' } } };
    expect(personName(t, unnamed, [identity('instagram_dm', '3000000000000001')])).toBe('Instagram kişisi · …0001');
    expect(personName(t, unnamed)).toBe('Messenger kişisi');
  });

  it('never shows an id, whatever is missing', () => {
    const imported = { ...person, display_name: '', first_touch: { ...person.first_touch, source: 'import' as const } };
    expect(personName(t, imported)).toBe('Adsız kişi');
    expect(personName(t, { ...person, display_name: '', erased_at: '2026-10-24T00:00:00Z' })).toBe('Silinmiş kişi');
    expect(personName(t, undefined)).toBe('…');
  });
});
