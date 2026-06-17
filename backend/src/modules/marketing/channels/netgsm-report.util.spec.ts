import { parseNetgsmReport } from './netgsm-report.util';

/**
 * Tolerant parser for a NetGSM `/sms/report` response row. The EXACT wire shape
 * is a live-account open item (must be locked from a captured real response), so
 * this handles the plausible JSON shapes and returns null for anything it can't
 * confidently read — null is a safe no-op (the poller leaves the message SENT
 * and re-polls), never a wrong terminal status.
 */
describe('parseNetgsmReport', () => {
  it('reads a plain JSON object with durumcode', () => {
    expect(parseNetgsmReport({ durumcode: '1' })).toEqual({ durumcode: '1', hatakod: null });
  });

  it('reads a JSON array (first row) with the durum/hata aliases', () => {
    expect(parseNetgsmReport([{ durum: '2', hata: '7' }])).toEqual({
      durumcode: '2',
      hatakod: '7',
    });
  });

  it('reads a wrapped {report:[...]} / {data:[...]} envelope', () => {
    expect(parseNetgsmReport({ report: [{ status: '1' }] })).toEqual({
      durumcode: '1',
      hatakod: null,
    });
    expect(parseNetgsmReport({ data: [{ durumcode: '1' }] })).toEqual({
      durumcode: '1',
      hatakod: null,
    });
  });

  it('parses a JSON string body', () => {
    expect(parseNetgsmReport('{"durumcode":"1"}')).toEqual({ durumcode: '1', hatakod: null });
  });

  it('coerces numeric codes to strings', () => {
    expect(parseNetgsmReport({ durumcode: 1, hatakod: 0 })).toEqual({
      durumcode: '1',
      hatakod: '0',
    });
  });

  it('returns null for empty, non-JSON, or unrecognized bodies (safe no-op)', () => {
    expect(parseNetgsmReport('')).toBeNull();
    expect(parseNetgsmReport('OK 12345')).toBeNull(); // unknown text format
    expect(parseNetgsmReport({})).toBeNull();
    expect(parseNetgsmReport(null)).toBeNull();
    expect(parseNetgsmReport([])).toBeNull();
  });
});
