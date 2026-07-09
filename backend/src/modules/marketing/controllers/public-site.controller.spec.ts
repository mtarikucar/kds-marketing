import { PublicSiteController } from './public-site.controller';

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.type = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  return res;
}

const TARGET = { redirectMenu: '850-queue-vip', redirectType: 'queue' as const };

function makeController(overrides: { sites?: any } = {}) {
  const sites = overrides.sites ?? { resolvePublicCallbackTarget: jest.fn().mockResolvedValue(TARGET) };
  const forms = {};
  const booking = {};
  const config = { get: jest.fn().mockReturnValue('') };
  const callback = { requestCallback: jest.fn() };
  const ctrl = new PublicSiteController(sites as any, forms as any, booking as any, config as any, callback as any);
  return { ctrl, callback, sites };
}

describe('PublicSiteController — POST callback/:ws (Task 6 callback widget)', () => {
  it('delegates the workspace + phone + RESOLVED (not body-supplied) target to TelephonyCallbackService, renders a thank-you page on success', async () => {
    const { ctrl, callback, sites } = makeController();
    callback.requestCallback.mockResolvedValue({ ok: true });
    const res = makeRes();
    const dto = { phone: '5551112233' };

    await ctrl.requestCallback('ws-1', dto as any, res);

    expect(sites.resolvePublicCallbackTarget).toHaveBeenCalledWith('ws-1');
    expect(callback.requestCallback).toHaveBeenCalledWith('ws-1', {
      phone: '5551112233',
      redirectMenu: '850-queue-vip',
      redirectType: 'queue',
    });
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Teşekkürler'));
  });

  // Final-review fix M2 (layer 2 — target binding): a visitor cannot steer the
  // call by supplying redirectMenu/redirectType in the body; only `phone` is
  // read from the DTO, and the actual target always comes from
  // resolvePublicCallbackTarget's return value regardless of body contents.
  it('ignores a body-supplied redirectMenu/redirectType in favor of the tenant-configured one', async () => {
    const { ctrl, callback } = makeController();
    callback.requestCallback.mockResolvedValue({ ok: true });
    const res = makeRes();
    const tamperedDto = { phone: '5551112233', redirectMenu: 'attacker-chosen-ivr', redirectType: 'ivr' } as any;

    await ctrl.requestCallback('ws-1', tamperedDto, res);

    expect(callback.requestCallback).toHaveBeenCalledWith('ws-1', {
      phone: '5551112233',
      redirectMenu: '850-queue-vip',
      redirectType: 'queue',
    });
  });

  // Final-review fix M2 (layer 1 — opt-in gate): a workspace that hasn't
  // published a callback block anywhere must 404, and the compliance
  // service must never even be reached.
  it('404s and never calls TelephonyCallbackService when the workspace has no published callback block', async () => {
    const sites = { resolvePublicCallbackTarget: jest.fn().mockResolvedValue(null) };
    const { ctrl, callback } = makeController({ sites });
    const res = makeRes();

    await ctrl.requestCallback('ws-1', { phone: '5551112233' } as any, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(callback.requestCallback).not.toHaveBeenCalled();
  });

  it('renders a generic 400 error page (never leaks the underlying reason) when the service refuses', async () => {
    const { ctrl, callback } = makeController();
    callback.requestCallback.mockRejectedValue(new Error('İYS: bu numara için arama izni yok (RET/kayıt yok)'));
    const res = makeRes();

    await ctrl.requestCallback('ws-1', { phone: '5551112233' } as any, res);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.send.mock.calls[0][0] as string;
    expect(body).not.toContain('İYS');
    expect(body).not.toContain('RET');
  });
});
