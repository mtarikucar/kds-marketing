import { Ga4ApiError, Ga4DataClient, foldTopN } from './ga4-data.client';

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const METRICS = ['sessions', 'totalUsers', 'newUsers', 'keyEvents', 'ecommercePurchases', 'purchaseRevenue'];

/** A runReport response in the Data API v1beta shape. */
function report(dims: string[], rows: Array<[string[], number[]]>, currency = 'TRY') {
  return {
    dimensionHeaders: dims.map((name) => ({ name })),
    metricHeaders: METRICS.map((name) => ({ name, type: name === 'purchaseRevenue' ? 'TYPE_CURRENCY' : 'TYPE_INTEGER' })),
    rows: rows.map(([d, m]) => ({ dimensionValues: d.map((value) => ({ value })), metricValues: m.map((v) => ({ value: String(v) })) })),
    rowCount: rows.length,
    metadata: { currencyCode: currency, timeZone: 'Europe/Istanbul' },
    kind: 'analyticsData#runReport',
  };
}

describe('Ga4DataClient.runReport (contract §6.3, B3)', () => {
  it('asks for the daily TOTAL with the six metrics over a relative window', async () => {
    const http = { fetch: jest.fn().mockResolvedValue(json(200, report(['date'], [[['20261019'], [120, 100, 80, 3, 2, 6998]]]))) };
    const out = await new Ga4DataClient(http as never).runReport('ya29', 'properties/123', {
      startDate: '3daysAgo',
      endDate: 'yesterday',
      dimension: 'TOTAL',
    });
    const [url, init] = http.fetch.mock.calls[0];
    expect(url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/123:runReport');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer ya29');
    const body = JSON.parse(init.body);
    expect(body.dateRanges).toEqual([{ startDate: '3daysAgo', endDate: 'yesterday' }]);
    expect(body.dimensions).toEqual([{ name: 'date' }]);
    expect(body.metrics.map((m: { name: string }) => m.name)).toEqual(METRICS);
    expect(out).toEqual({
      currency: 'TRY',
      rows: [
        { date: '2026-10-19', key: '', sessions: 120, totalUsers: 100, newUsers: 80, conversions: 3, purchaseCount: 2, purchaseValue: 6998 },
      ],
    });
  });

  it.each([
    ['SOURCE_MEDIUM', 'sessionSourceMedium', 'google / cpc'],
    ['CAMPAIGN', 'sessionCampaignName', 'ekim-hediye'],
  ] as const)('maps the %s report key from %s', async (dimension, gaDim, key) => {
    const http = { fetch: jest.fn().mockResolvedValue(json(200, report(['date', gaDim], [[['20261019', key], [5, 4, 3, 0, 0, 0]]]))) };
    const out = await new Ga4DataClient(http as never).runReport('t', 'properties/1', { startDate: '3daysAgo', endDate: 'yesterday', dimension });
    expect(JSON.parse(http.fetch.mock.calls[0][1].body).dimensions).toEqual([{ name: 'date' }, { name: gaDim }]);
    expect(out.rows[0]).toMatchObject({ date: '2026-10-19', key, sessions: 5 });
  });

  it('reads metrics by header name, not by position', async () => {
    const r = report(['date'], [[['20261019'], [1, 2, 3, 4, 5, 6.5]]]);
    r.metricHeaders.reverse();
    r.rows[0].metricValues.reverse();
    const http = { fetch: jest.fn().mockResolvedValue(json(200, r)) };
    const out = await new Ga4DataClient(http as never).runReport('t', 'properties/1', { startDate: '3daysAgo', endDate: 'yesterday', dimension: 'TOTAL' });
    expect(out.rows[0]).toMatchObject({ sessions: 1, totalUsers: 2, newUsers: 3, conversions: 4, purchaseCount: 5, purchaseValue: 6.5 });
  });

  it('returns no rows for an empty report', async () => {
    const r: any = report(['date'], []);
    delete r.rows;
    const http = { fetch: jest.fn().mockResolvedValue(json(200, r)) };
    expect((await new Ga4DataClient(http as never).runReport('t', 'properties/1', { startDate: '3daysAgo', endDate: 'yesterday', dimension: 'TOTAL' })).rows).toEqual([]);
  });

  it('throws Ga4ApiError with the HTTP status (the sync decides what a 401 means)', async () => {
    const http = { fetch: jest.fn().mockResolvedValue(json(401, { error: { status: 'UNAUTHENTICATED' } })) };
    const err = await new Ga4DataClient(http as never)
      .runReport('t', 'properties/1', { startDate: '3daysAgo', endDate: 'yesterday', dimension: 'TOTAL' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Ga4ApiError);
    expect(err.status).toBe(401);
    expect(err.message).toContain('UNAUTHENTICATED');
  });

  it('refuses a property id that is not properties/<digits> (no path injection into the URL)', async () => {
    const http = { fetch: jest.fn() };
    await expect(
      new Ga4DataClient(http as never).runReport('t', 'properties/1/../../x', { startDate: '3daysAgo', endDate: 'yesterday', dimension: 'TOTAL' }),
    ).rejects.toThrow(/property/i);
    expect(http.fetch).not.toHaveBeenCalled();
  });
});

describe('foldTopN — at most N keys per day, the rest summed into "(other)"', () => {
  const row = (date: string, key: string, sessions: number, purchaseValue = 0) => ({
    date,
    key,
    sessions,
    totalUsers: sessions,
    newUsers: 0,
    conversions: 1,
    purchaseCount: purchaseValue ? 1 : 0,
    purchaseValue,
  });

  it('keeps the top N by sessions per day and folds the rest', () => {
    const rows = [row('2026-10-19', 'a', 10), row('2026-10-19', 'b', 30), row('2026-10-19', 'c', 5, 100.25), row('2026-10-19', 'd', 1, 0.5), row('2026-10-20', 'a', 2)];
    const out = foldTopN(rows, 2);
    expect(out.filter((r) => r.date === '2026-10-19').map((r) => r.key)).toEqual(['b', 'a', '(other)']);
    expect(out.find((r) => r.key === '(other)')).toMatchObject({ sessions: 6, totalUsers: 6, conversions: 2, purchaseCount: 2, purchaseValue: 100.75 });
    expect(out.filter((r) => r.date === '2026-10-20').map((r) => r.key)).toEqual(['a']);
  });

  it('merges an existing "(other)" row from GA4 into the folded one instead of duplicating the key', () => {
    const out = foldTopN([row('2026-10-19', 'a', 10), row('2026-10-19', '(other)', 4), row('2026-10-19', 'b', 1)], 1);
    expect(out.map((r) => r.key)).toEqual(['a', '(other)']);
    expect(out[1].sessions).toBe(5);
  });
});
