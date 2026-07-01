import { PublicEstimateController } from './public-estimate.controller';

/**
 * The accept/decline page disables both buttons before POSTing. They must come
 * back on EVERY non-confirming outcome — a conflict (already resolved) or a
 * network/non-JSON failure — or the customer is stuck with no feedback and no
 * way to act. Regression guard for the missing fetch .catch + response-shape
 * check.
 */
describe('PublicEstimateController.page', () => {
  function makeRes() {
    const res: any = { _html: '', _status: 200 };
    res.status = (c: number) => {
      res._status = c;
      return res;
    };
    res.type = () => res;
    res.send = (h: string) => {
      res._html = h;
      return res;
    };
    return res;
  }

  function makeCtrl(view: any) {
    const estimates = { publicView: jest.fn().mockResolvedValue(view) };
    return { ctrl: new PublicEstimateController(estimates as any), estimates };
  }

  const OPEN_VIEW = {
    number: 'EST-1',
    items: [{ description: 'Plan', qty: 1, unitPrice: 9900 }],
    currency: 'TRY',
    total: 9900,
    notes: null,
    status: 'SENT',
    validUntil: null,
  };

  it('renders Accept/Decline and the total for an open estimate', async () => {
    const { ctrl } = makeCtrl(OPEN_VIEW);
    const res = makeRes();
    await ctrl.page('es_token', res);
    expect(res._html).toContain('id="ok"');
    expect(res._html).toContain('id="no"');
    expect(res._html).toContain('99.00');
  });

  it('re-enables both buttons on a failed/non-confirming submit', async () => {
    const { ctrl } = makeCtrl(OPEN_VIEW);
    const res = makeRes();
    await ctrl.page('es_token', res);
    // The fetch must have a .catch, and both the error branch and the catch
    // re-enable the buttons.
    expect(res._html).toMatch(/\.catch\(/);
    expect(res._html).toMatch(/ok\.disabled\s*=\s*false/);
    expect(res._html).toMatch(/no\.disabled\s*=\s*false/);
    // It must only declare success on a real ACCEPTED/DECLINED status.
    expect(res._html).toContain("d.status==='ACCEPTED'||d.status==='DECLINED'");
  });

  it('shows the resolved banner and no buttons once accepted', async () => {
    const { ctrl } = makeCtrl({ ...OPEN_VIEW, status: 'ACCEPTED' });
    const res = makeRes();
    await ctrl.page('es_token', res);
    expect(res._html).toContain('You accepted this estimate');
    expect(res._html).not.toContain('id="ok"');
  });

  it('renders validUntil as an ISO date (YYYY-MM-DD), not a JS Date toString', async () => {
    // publicView returns the Prisma row, so validUntil is a Date OBJECT (not an
    // ISO string). `String(date).slice(0,10)` yields "Wed Jul 15" (weekday+month,
    // no year) — a broken "Valid until" on the customer-facing page.
    const { ctrl } = makeCtrl({ ...OPEN_VIEW, validUntil: new Date('2026-07-15T00:00:00.000Z') });
    const res = makeRes();
    await ctrl.page('es_token', res);
    expect(res._html).toContain('Valid until 2026-07-15');
    expect(res._html).not.toMatch(/Valid until [A-Z][a-z]{2} [A-Z][a-z]{2} \d{2}/);
  });

  it('404s a missing estimate without throwing', async () => {
    const { ctrl, estimates } = makeCtrl(OPEN_VIEW);
    estimates.publicView.mockRejectedValueOnce(new Error('not found'));
    const res = makeRes();
    await ctrl.page('bad', res);
    expect(res._status).toBe(404);
  });
});
