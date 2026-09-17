import { describe, it, expect } from 'vitest';
import { buildLeadPayload } from './CreateLeadPage';
import type { LeadFormValues } from '../../features/marketing/schemas';

const base: LeadFormValues = {
  businessName: '  Acme  ',
  contactPerson: '  Ada  ',
  businessType: 'RESTAURANT',
  source: 'PHONE',
  priority: 'MEDIUM',
  phone: '',
  whatsapp: '',
  email: '',
  address: '',
  city: '',
  region: '',
  notes: '',
  nextFollowUp: '',
};

describe('buildLeadPayload', () => {
  it('CREATE: omits every empty optional (no "" stored, no nulls)', () => {
    const p = buildLeadPayload(base, { isEdit: false });
    expect(p).toEqual({
      businessName: 'Acme',
      contactPerson: 'Ada',
      businessType: 'RESTAURANT',
      source: 'PHONE',
      priority: 'MEDIUM',
    });
    // no clearing nulls on create
    expect(Object.values(p)).not.toContain(null);
  });

  it('EDIT: sends explicit null for each emptied optional so it is actually cleared', () => {
    const p = buildLeadPayload({ ...base, phone: '' }, { isEdit: true });
    // every clearable text/date field present as null
    for (const k of ['phone', 'whatsapp', 'email', 'address', 'city', 'region', 'notes', 'nextFollowUp']) {
      expect(p[k]).toBeNull();
    }
  });

  it('EDIT: keeps and trims set values, still clears the emptied ones', () => {
    const p = buildLeadPayload(
      { ...base, phone: ' 0555 111 22 33 ', email: 'A@x.io', notes: '' },
      { isEdit: true },
    );
    expect(p.phone).toBe('0555 111 22 33');
    expect(p.email).toBe('A@x.io');
    expect(p.notes).toBeNull();
  });

  it('does not write or clear legacy sector fields on create or edit', () => {
    const legacy = { ...base, tableCount: '12', branchCount: '2', currentSystem: 'POS' };
    for (const isEdit of [false, true]) {
      const payload = buildLeadPayload(legacy, { isEdit });
      for (const key of ['tableCount', 'branchCount', 'currentSystem']) {
        expect(payload).not.toHaveProperty(key);
      }
    }
  });

  it('includes customFields only when provided', () => {
    expect(buildLeadPayload(base, { isEdit: false })).not.toHaveProperty('customFields');
    const withCf = buildLeadPayload(base, { isEdit: false, customFields: { color: 'red' } });
    expect(withCf.customFields).toEqual({ color: 'red' });
  });
});
