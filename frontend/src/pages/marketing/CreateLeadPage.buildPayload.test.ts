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
  tableCount: '',
  branchCount: '',
  currentSystem: '',
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
    for (const k of ['phone', 'whatsapp', 'email', 'address', 'city', 'region', 'currentSystem', 'notes', 'nextFollowUp']) {
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

  it('numeric optionals are only set when present and are NEVER sent as null (backend can not clear them)', () => {
    const created = buildLeadPayload({ ...base, tableCount: '12' }, { isEdit: false });
    expect(created.tableCount).toBe(12);
    const edited = buildLeadPayload({ ...base, tableCount: '' }, { isEdit: true });
    expect(edited).not.toHaveProperty('tableCount');
    expect(edited).not.toHaveProperty('branchCount');
  });

  it('includes customFields only when provided', () => {
    expect(buildLeadPayload(base, { isEdit: false })).not.toHaveProperty('customFields');
    const withCf = buildLeadPayload(base, { isEdit: false, customFields: { color: 'red' } });
    expect(withCf.customFields).toEqual({ color: 'red' });
  });
});
