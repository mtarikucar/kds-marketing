import { PublicSiteController } from './public-site.controller';

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.type = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  return res;
}

function makeController() {
  const sites = {};
  const forms = {};
  const booking = {};
  const config = { get: jest.fn().mockReturnValue('') };
  const callback = { requestCallback: jest.fn() };
  const ctrl = new PublicSiteController(sites as any, forms as any, booking as any, config as any, callback as any);
  return { ctrl, callback };
}

describe('PublicSiteController — POST callback/:ws (Task 6 callback widget)', () => {
  it('delegates the workspace + dto to TelephonyCallbackService and renders a thank-you page on success', async () => {
    const { ctrl, callback } = makeController();
    callback.requestCallback.mockResolvedValue({ ok: true });
    const res = makeRes();
    const dto = { phone: '5551112233', redirectType: 'queue' as const, redirectMenu: '850-queue-vip' };

    await ctrl.requestCallback('ws-1', dto, res);

    expect(callback.requestCallback).toHaveBeenCalledWith('ws-1', dto);
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Teşekkürler'));
  });

  it('renders a generic 400 error page (never leaks the underlying reason) when the service refuses', async () => {
    const { ctrl, callback } = makeController();
    callback.requestCallback.mockRejectedValue(new Error('İYS: bu numara için arama izni yok (RET/kayıt yok)'));
    const res = makeRes();
    const dto = { phone: '5551112233', redirectType: 'queue' as const, redirectMenu: '850-queue-vip' };

    await ctrl.requestCallback('ws-1', dto, res);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.send.mock.calls[0][0] as string;
    expect(body).not.toContain('İYS');
    expect(body).not.toContain('RET');
  });
});
