import { describe, expect, it } from 'vitest';
import { mockFetch } from '@/test/render';
import { listSpend, recordSpend, retireBudgetItem, updateBudgetItem } from './budget';
import {
  deleteGroup,
  listCapabilities,
  removeGroupMember,
  retireCapability,
  unlinkBudget,
  updateCapability,
  type CapabilityQuery,
} from './capabilities';
import { archiveVersion, listConsultation, recordEntry, writeSection } from './strategy';
import { getPending, setCheckinInterval } from './work';

const CAP = '0190a000-0000-7000-8000-000000000101';
const ITEM = '0190a000-0000-7000-8000-000000000060';
const GROUP = '0190a000-0000-7000-8000-000000000050';
const VERSION = '0190a000-0000-7000-8000-000000000041';

describe('api wrappers: query parameters', () => {
  it('lists capabilities with the four known filters only', async () => {
    const calls = mockFetch({ 'GET /api/capabilities': [] });
    await listCapabilities();
    await listCapabilities({ group: 'device' });
    await listCapabilities({ kind: 'phone', status: 'verified', group_id: GROUP });
    // A stray field (from a caller that is not type-checked) never reaches the server, which
    // refuses unknown parameters with 422.
    await listCapabilities({ group: 'ads', include: 'retired' } as unknown as CapabilityQuery);
    expect(calls.map((c) => c.search)).toEqual([
      '',
      '?group=device',
      `?kind=phone&status=verified&group_id=${GROUP}`,
      '?group=ads',
    ]);
  });

  it('pages the spend list with limit and both halves of the cursor only', async () => {
    const calls = mockFetch({ [`GET /api/budget/items/${ITEM}/spend`]: [] });
    await listSpend(ITEM);
    await listSpend(ITEM, {
      before_at: '2026-10-22T08:00:00Z',
      before_id: 'abc',
      page: 3,
    } as unknown as Parameters<typeof listSpend>[1]);
    expect(calls[0].search).toBe('?limit=50');
    expect(Object.fromEntries(new URLSearchParams(calls[1].search))).toEqual({
      limit: '50',
      before_at: '2026-10-22T08:00:00Z',
      before_id: 'abc',
    });
  });

  it('pages the consultation log the same way', async () => {
    const calls = mockFetch({ [`GET /api/strategy/versions/${VERSION}/consultation`]: [] });
    await listConsultation(VERSION, { limit: 3, before_at: '2026-10-22T09:00:00Z', before_id: 'e1' });
    expect(Object.fromEntries(new URLSearchParams(calls[0].search))).toEqual({
      limit: '3',
      before_at: '2026-10-22T09:00:00Z',
      before_id: 'e1',
    });
  });
});

describe('api wrappers: bodies and answers', () => {
  it('archives with the version and the confirmation, and answers as the MCP tool does', async () => {
    const calls = mockFetch({ 'POST /api/strategy/archive': { version_id: VERSION, archived: true } });
    await expect(archiveVersion({ version_id: VERSION, confirm: true })).resolves.toEqual({
      version_id: VERSION,
      archived: true,
    });
    expect(calls[0].body).toEqual({ version_id: VERSION, confirm: true });
    expect(calls[0].headers.get('x-requested-with')).toBe('jeeta-panel');
  });

  it('retires with an explicit confirmation', async () => {
    const calls = mockFetch({ [`POST /api/capabilities/${CAP}/retire`]: { capability: {}, effective_status: 'retired' } });
    await retireCapability(CAP);
    expect(calls[0].body).toEqual({ confirm: true });
  });

  it('reads the JSON answers of the DELETE routes', async () => {
    const capability = { capability: { id: CAP }, effective_status: 'declared' };
    const group = { group: { id: GROUP }, members: [] };
    mockFetch({
      [`DELETE /api/capabilities/${CAP}/budget-links/${ITEM}`]: capability,
      [`DELETE /api/capability-groups/${GROUP}/members/${CAP}`]: group,
      [`DELETE /api/capability-groups/${GROUP}`]: { group_id: GROUP, deleted: true },
    });
    await expect(unlinkBudget(CAP, ITEM)).resolves.toEqual(capability);
    await expect(removeGroupMember(GROUP, CAP)).resolves.toEqual(group);
    await expect(deleteGroup(GROUP)).resolves.toEqual({ group_id: GROUP, deleted: true });
  });

  it('writes a section as its bare value and leaves out an empty section key', async () => {
    const calls = mockFetch({
      'PUT /api/strategy/draft/sections/paid_enabled': {},
      'POST /api/strategy/consultation/entries': { id: 'e1' },
    });
    await writeSection('paid_enabled', true);
    await recordEntry({ kind: 'note', text: 'kısa not' });
    expect(calls[0].body).toBe(true);
    expect(calls[1].body).toEqual({ kind: 'note', text: 'kısa not' });
  });

  it('edits with only the fields given, never the ones an edit does not take', async () => {
    const calls = mockFetch({
      [`PATCH /api/capabilities/${CAP}`]: { capability: {}, effective_status: 'declared', verification_reset: false },
      [`PATCH /api/budget/items/${ITEM}`]: { item: {}, spent_in_period: 0, remaining: 0 },
    });
    await updateCapability(CAP, { name: 'Telefon' });
    await updateCapability(CAP, {
      description: '',
      external_id: 'SN-2',
      connector_public: { health: true },
    } as unknown as Parameters<typeof updateCapability>[1]);
    await updateBudgetItem(ITEM, { cap: 0 });
    await updateBudgetItem(ITEM, {
      name: 'Kasa',
      period: 'weekly',
      kind: 'cash',
    } as unknown as Parameters<typeof updateBudgetItem>[1]);
    expect(calls.map((c) => c.body)).toEqual([
      { name: 'Telefon' },
      { description: '', external_id: 'SN-2' },
      { cap: 0 },
      { name: 'Kasa', period: 'weekly' },
    ]);
  });

  it('retires a budget item with an explicit confirmation', async () => {
    const calls = mockFetch({ [`POST /api/budget/items/${ITEM}/retire`]: { item: {}, spent_in_period: 0, remaining: 0 } });
    await retireBudgetItem(ITEM);
    expect(calls[0].body).toEqual({ confirm: true });
  });

  it('records spend without an empty reference', async () => {
    const calls = mockFetch({ [`POST /api/budget/items/${ITEM}/spend`]: {} });
    await recordSpend(ITEM, { amount: 1250, reference: '' });
    expect(calls[0].body).toEqual({ amount: 1250 });
  });

  it('reads pending work and sets the check-in interval', async () => {
    const calls = mockFetch({
      'GET /api/work/pending': { strategy: 'missing', items: [], agent: {} },
      'PUT /api/work/checkin-interval': { last_seen_at: null, interval_minutes: 60, overdue: true },
    });
    await getPending();
    await setCheckinInterval(60);
    expect(calls[0].headers.get('x-requested-with')).toBeNull();
    expect(calls[1].body).toEqual({ minutes: 60 });
  });
});
