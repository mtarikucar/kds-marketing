import { parseWaStatuses, parseMessengerStatuses, rankMetaStatus } from './meta-status.util';

describe('rankMetaStatus', () => {
  it('orders SENT < DELIVERED < READ and unknown = 0', () => {
    expect(rankMetaStatus('SENT')).toBe(1);
    expect(rankMetaStatus('DELIVERED')).toBe(2);
    expect(rankMetaStatus('READ')).toBe(3);
    expect(rankMetaStatus('NONSENSE')).toBe(0);
  });
});

describe('parseWaStatuses', () => {
  const body = (statuses: unknown[]) => ({ entry: [{ changes: [{ value: { statuses } }] }] });

  it('maps delivered/read and ignores sent', () => {
    const out = parseWaStatuses(
      body([
        { id: 'wamid.1', status: 'sent' },
        { id: 'wamid.2', status: 'delivered' },
        { id: 'wamid.3', status: 'read' },
      ]),
    );
    expect(out).toEqual([
      { externalMessageId: 'wamid.2', status: 'DELIVERED' },
      { externalMessageId: 'wamid.3', status: 'READ' },
    ]);
  });

  it('maps failed with the first error title as the reason', () => {
    const out = parseWaStatuses(
      body([{ id: 'wamid.9', status: 'failed', errors: [{ code: 131, title: 'Re-engagement message' }] }]),
    );
    expect(out).toEqual([{ externalMessageId: 'wamid.9', status: 'FAILED', reason: 'Re-engagement message' }]);
  });

  it('skips entries without an id and tolerates an empty/garbage body', () => {
    expect(parseWaStatuses(body([{ status: 'delivered' }]))).toEqual([]);
    expect(parseWaStatuses({})).toEqual([]);
    expect(parseWaStatuses(null)).toEqual([]);
  });
});

describe('parseMessengerStatuses', () => {
  it('maps delivery.mids[] to DELIVERED per mid', () => {
    const body = { entry: [{ messaging: [{ delivery: { mids: ['m.1', 'm.2'], watermark: 123 } }] }] };
    expect(parseMessengerStatuses(body)).toEqual([
      { externalMessageId: 'm.1', status: 'DELIVERED' },
      { externalMessageId: 'm.2', status: 'DELIVERED' },
    ]);
  });

  it('ignores read watermarks (no per-message id) and empty bodies', () => {
    const body = { entry: [{ messaging: [{ read: { watermark: 999 } }] }] };
    expect(parseMessengerStatuses(body)).toEqual([]);
    expect(parseMessengerStatuses({})).toEqual([]);
  });
});
