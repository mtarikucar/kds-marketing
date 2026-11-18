import { describe, expect, it } from 'vitest';
import { mockFetch } from '@/test/render';
import * as m from './materials';

describe('materials API', () => {
  it('calls every library route the panel uses, with its method and body', async () => {
    const expected = [
      ['GET', '/api/studio/olays'],
      ['POST', '/api/studio/olays'],
      ['PATCH', '/api/studio/olays/o1'],
      ['POST', '/api/studio/olays/o1/confirm'],
      ['GET', '/api/studio/materials'],
      ['GET', '/api/studio/materials/m1'],
      ['POST', '/api/studio/materials'],
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
      ['POST', '/api/studio/shoot-requests'],
      ['POST', '/api/studio/shoot-requests/r1/resolve'],
      ['POST', '/api/studio/slots/s1/material-check/release'],
    ];
    const calls = mockFetch(Object.fromEntries(expected.map(([a, b]) => [`${a} ${b}`, {}])));
    await m.olaysList('proposed');
    await m.olayCreate({ request_key: 'k', kind: 'workshop', title: 'A', starts_on: '2026-11-16', ends_on: '2026-11-16' });
    await m.olayUpdate('o1', 3, { place: null });
    await m.olayConfirm('o1', 3);
    await m.materialsList({ olay_id: 'o1', state: 'needs_review' });
    await m.materialGet('m1');
    await m.materialAdd({ request_key: 'k', file_id: 'f1', genel: true, origin: { kind: 'real' }, share: 'shareable' });
    // A person's upload from the content page names no folder: it waits unfiled for its analysis.
    await m.materialAdd({ request_key: 'k2', file_id: 'f2', origin: { kind: 'real' } });
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
    await m.materialPolicySet({ lead_days: 21, reuse_days: 14, recap_days: 30, ai_standalone: true });
    await m.shootRequest({ request_key: 'k', text: 'Afiş yükle' });
    await m.shootResolve('r1', 'dismissed');
    await m.materialCheckRelease('s1', 4, 'f'.repeat(64));
    expect(calls.map((c) => [c.method, c.path])).toEqual(expected);
    const body = (path: string, method = 'POST') =>
      calls.find((c) => c.path === path && c.method === method)?.body;
    expect(calls[0].search).toBe('?status=proposed');
    expect(body('/api/studio/olays/o1', 'PATCH')).toEqual({ place: null, expected_revision: 3 });
    expect(calls[4].search).toBe('?olay_id=o1&state=needs_review');
    expect(calls[7].body).toEqual({ request_key: 'k2', file_id: 'f2', origin: { kind: 'real' } });
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

  it('reads Istanbul days', () => {
    expect(m.istanbulDay(new Date('2026-11-15T22:30:00Z'))).toBe('2026-11-16');
  });
});

it('uses revision-checked intelligence and production routes', async () => {
  const calls = mockFetch({
    'GET /api/studio/material-intelligence': [],
    'GET /api/studio/materials/m1/intelligence': {},
    'PATCH /api/studio/materials/m1/intelligence': {},
    'POST /api/studio/materials/m1/analysis/retry': {},
    'GET /api/studio/materials/m1/preview': {},
    'GET /api/studio/material-productions': [],
    'POST /api/studio/material-productions': {},
  });
  await m.materialIntelligenceList();
  await m.materialIntelligence('m1');
  await m.materialMetadata('m1', 7, { group_name: null });
  await m.materialAnalysisRetry('m1', 7);
  await m.materialPreview('m1');
  await m.materialProductions('m1');
  await m.materialProductionRequest({ request_key: 'request-1', kind: 'crop', instructions: 'Square crop', sources: [{ material_id: 'm1', expected_revision: 7 }] });
  expect(calls[2].body).toEqual({ expected_revision: 7, group_name: null });
  expect(calls[3].body).toEqual({ expected_revision: 7 });
  expect(calls[5].search).toBe('?source_material_id=m1');
  expect(calls[6].body).toMatchObject({ sources: [{ material_id: 'm1', expected_revision: 7 }] });
  expect(calls.filter((c) => c.method !== 'GET').every((c) => c.headers.get('X-Requested-With') === 'jeeta-panel')).toBe(true);
});
