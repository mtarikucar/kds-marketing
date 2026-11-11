import { describe, expect, it } from 'vitest';
import { mockFetch } from '@/test/render';
import * as m from './materials';
import { olay } from '@/test/materials';

describe('materials API', () => {
  it('calls every library route the panel uses, with its method and body', async () => {
    const expected = [
      ['GET', '/api/studio/olays'],
      ['GET', '/api/studio/olays/o1'],
      ['POST', '/api/studio/olays'],
      ['PATCH', '/api/studio/olays/o1'],
      ['POST', '/api/studio/olays/o1/confirm'],
      ['GET', '/api/studio/materials'],
      ['GET', '/api/studio/materials/m1'],
      ['POST', '/api/studio/materials'],
      ['PATCH', '/api/studio/materials/m1/tags'],
      ['PUT', '/api/studio/materials/m1/permission'],
      ['POST', '/api/studio/materials/m1/free'],
      ['POST', '/api/studio/materials/m1/bind'],
      ['POST', '/api/studio/materials/m1/delete'],
      ['GET', '/api/studio/slots/s1/materials'],
      ['GET', '/api/studio/calendar'],
      ['PUT', '/api/studio/calendar/ramazan_bayrami/2027'],
      ['PUT', '/api/studio/materials/policy'],
      ['GET', '/api/studio/shoot-requests'],
      ['POST', '/api/studio/shoot-requests'],
      ['POST', '/api/studio/shoot-requests/r1/resolve'],
      ['POST', '/api/studio/slots/s1/material-check/release'],
    ];
    const calls = mockFetch(Object.fromEntries(expected.map(([a, b]) => [`${a} ${b}`, {}])));
    await m.olaysList('proposed');
    await m.olayGet('o1');
    await m.olayCreate({ request_key: 'k', kind: 'workshop', title: 'A', starts_on: '2026-11-16', ends_on: '2026-11-16' });
    await m.olayUpdate('o1', 3, { place: null });
    await m.olayConfirm('o1', 3);
    await m.materialsList({ olay_id: 'o1', state: 'needs_review' });
    await m.materialGet('m1');
    await m.materialAdd({ request_key: 'k', file_id: 'f1', genel: true, origin: { kind: 'real' }, share: 'shareable' });
    await m.materialTag('m1', 2, { quality: null });
    await m.materialPermission('m1', 2, 'product_only');
    await m.materialFree('m1', 2, false);
    await m.materialBind('m1', 2, { kind: 'genel' });
    await m.materialDelete('m1', 2);
    await m.slotMaterials('s1');
    await m.calendarList(2027);
    await m.calendarSet({
      key: 'ramazan_bayrami',
      year: 2027,
      name: 'Ramazan Bayramı',
      kind: 'special_day',
      window_start: '2027-02-25',
      window_end: '2027-03-11',
      lead_days: null,
      enabled: true,
    });
    await m.materialPolicySet({ lead_days: 21, reuse_days: 14, recap_days: 30 });
    await m.shootList('all');
    await m.shootRequest({ request_key: 'k', text: 'Afiş yükle' });
    await m.shootResolve('r1', 'dismissed');
    await m.materialCheckRelease('s1', 4, 'f'.repeat(64));
    expect(calls.map((c) => [c.method, c.path])).toEqual(expected);
    const body = (path: string, method = 'POST') =>
      calls.find((c) => c.path === path && c.method === method)?.body;
    expect(calls[0].search).toBe('?status=proposed');
    expect(body('/api/studio/olays/o1', 'PATCH')).toEqual({ place: null, expected_revision: 3 });
    expect(calls[5].search).toBe('?olay_id=o1&state=needs_review');
    expect(body('/api/studio/materials/m1/tags', 'PATCH')).toEqual({ quality: null, expected_revision: 2 });
    expect(body('/api/studio/materials/m1/delete')).toEqual({ expected_revision: 2, confirm: true });
    // The path names the row; the body carries the rest (the server refuses a key twice).
    expect(body('/api/studio/calendar/ramazan_bayrami/2027', 'PUT')).toEqual({
      name: 'Ramazan Bayramı',
      kind: 'special_day',
      window_start: '2027-02-25',
      window_end: '2027-03-11',
      lead_days: null,
      enabled: true,
    });
    expect(body('/api/studio/shoot-requests/r1/resolve')).toEqual({ status: 'dismissed' });
    expect(body('/api/studio/slots/s1/material-check/release')).toEqual({
      expected_revision: 4,
      digest: 'f'.repeat(64),
    });
    expect(
      calls.filter((c) => c.method !== 'GET').every((c) => c.headers.get('X-Requested-With') === 'jeeta-panel'),
    ).toBe(true);
  });

  it('suggests olays as the server does: containing the day, nearest start first, then shorter', () => {
    const a = olay('a', { starts_on: '2026-11-01', ends_on: '2026-11-30' });
    const b = olay('b', { starts_on: '2026-11-10', ends_on: '2026-11-20' });
    const c = olay('c', { starts_on: '2026-11-10', ends_on: '2026-11-12' });
    const d = olay('d', { starts_on: '2026-11-13', ends_on: '2026-11-14' });
    expect(m.olaySuggestions([a, b, c, d] as unknown as m.Olay[], '2026-11-12').map((o) => o.id)).toEqual(['c', 'b', 'a']);
    expect(m.olaySuggestions([a, b] as unknown as m.Olay[], '2026-12-01')).toEqual([]);
  });

  it('reads Istanbul days and their Mondays', () => {
    expect(m.istanbulDay(new Date('2026-11-15T22:30:00Z'))).toBe('2026-11-16');
    expect(m.mondayOf('2026-11-16')).toBe('2026-11-16');
    expect(m.mondayOf('2026-11-22')).toBe('2026-11-16');
  });
});
