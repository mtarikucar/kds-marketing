import { describe, it, expect } from 'vitest';
import { buildResearchPayload } from './researchProfilePayload';
import type { ResearchProfileFormValues } from './ResearchProfileForm';

const base: ResearchProfileFormValues = {
  name: 'TR cafes',
  icpDescription: 'x'.repeat(40),
  productPitch: '',
  language: 'tr',
  country: '',
  cities: '',
  exclusions: '',
};

describe('buildResearchPayload', () => {
  it('EDIT clearing optional fields sends null (not undefined) so they CLEAR', () => {
    // The bug: `|| undefined` dropped the keys from the PATCH, so the backend
    // ...scalar spread left the OLD pitch/exclusions/geo in place — un-clearable.
    const body = buildResearchPayload({ ...base, productPitch: '  ', exclusions: '', country: '', cities: '' });
    expect(body.productPitch).toBeNull();
    expect(body.exclusions).toBeNull();
    expect(body.geo).toBeNull();
    // keys present so the backend actually writes the clear
    expect('productPitch' in body).toBe(true);
    expect('geo' in body).toBe(true);
  });

  it('builds geo from country + comma-split cities (trimmed, empties dropped)', () => {
    const body = buildResearchPayload({ ...base, country: 'TR', cities: 'Istanbul, Ankara ,, Izmir ' });
    expect(body.geo).toEqual({ country: 'TR', cities: ['Istanbul', 'Ankara', 'Izmir'] });
  });

  it('geo carries only the fields that are set (country only → no cities key)', () => {
    const body = buildResearchPayload({ ...base, country: 'TR', cities: '' });
    expect(body.geo).toEqual({ country: 'TR' });
  });

  it('passes name/icp/language through and trims a set pitch', () => {
    const body = buildResearchPayload({ ...base, productPitch: '  pitch here  ' });
    expect(body).toMatchObject({ name: 'TR cafes', language: 'tr', productPitch: 'pitch here' });
    expect(body.icpDescription).toHaveLength(40);
  });
});
