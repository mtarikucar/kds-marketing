import { PublicOrderFormController } from './public-order-form.controller';

/**
 * The buyer-facing page disables the "Continue to payment" button and shows '…'
 * before POSTing. It must be re-enabled on EVERY failure mode — including a
 * network error or a non-JSON gateway response — or a transient blip bricks
 * checkout. Regression guard for the missing fetch .catch.
 */
describe('PublicOrderFormController.page', () => {
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

  function makeCtrl() {
    const orderForms = {
      publicView: jest.fn().mockResolvedValue({
        name: 'Order',
        notes: null,
        currency: 'TRY',
        items: [{ description: 'Plan', qty: 1, unitPrice: 9900 }],
        total: 9900,
        collectPhone: true,
        phoneRequired: false,
      }),
    };
    return { ctrl: new PublicOrderFormController(orderForms as any), orderForms };
  }

  it('renders the resolved total and item rows', async () => {
    const { ctrl } = makeCtrl();
    const res = makeRes();
    await ctrl.page('of_token', res);
    expect(res._status).toBe(200);
    expect(res._html).toContain('99.00'); // 9900 minor → 99.00
    expect(res._html).toContain('Plan');
  });

  it('re-enables the submit button on a failed request (fetch has a .catch)', async () => {
    const { ctrl } = makeCtrl();
    const res = makeRes();
    await ctrl.page('of_token', res);
    // A transient failure must reset the button rather than leave it stuck on '…'.
    expect(res._html).toMatch(/\.catch\(/);
    // The recovery path re-enables the button.
    expect(res._html).toMatch(/go\.disabled\s*=\s*false/);
  });

  it('404s a missing/inactive form without throwing', async () => {
    const { ctrl, orderForms } = makeCtrl();
    orderForms.publicView.mockRejectedValueOnce(new Error('not found'));
    const res = makeRes();
    await ctrl.page('bad', res);
    expect(res._status).toBe(404);
  });
});
