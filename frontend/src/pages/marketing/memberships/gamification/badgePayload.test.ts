import { describe, it, expect } from 'vitest';
import { buildBadgeBody, BadgeFormValues } from './badgePayload';

const base: BadgeFormValues = { key: 'k', name: 'Gold', ruleType: 'POINTS', threshold: '100', iconUrl: '' };

describe('buildBadgeBody', () => {
  it('EDIT with an emptied icon sends null so the old icon is CLEARED (not undefined)', () => {
    // The bug: `iconUrl || undefined` dropped the key from the PATCH, so the
    // backend undefined-skip kept the old icon — the field was un-clearable.
    const body = buildBadgeBody({ ...base, iconUrl: '   ' }, true);
    expect(body.iconUrl).toBeNull();
    expect('iconUrl' in body).toBe(true);
  });

  it('EDIT with a set icon sends the trimmed URL', () => {
    const body = buildBadgeBody({ ...base, iconUrl: '  https://cdn/x.png  ' }, true);
    expect(body.iconUrl).toBe('https://cdn/x.png');
  });

  it('CREATE with an emptied icon sends undefined (service defaults null)', () => {
    const body = buildBadgeBody({ ...base, iconUrl: '' }, false);
    expect(body.iconUrl).toBeUndefined();
  });

  it('coerces threshold and passes name/ruleType through', () => {
    const body = buildBadgeBody({ ...base, name: 'Pro', ruleType: 'LESSONS', threshold: 'abc' }, false);
    expect(body).toMatchObject({ name: 'Pro', ruleType: 'LESSONS', threshold: 0 });
  });
});
