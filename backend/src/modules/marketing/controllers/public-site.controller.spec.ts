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

/**
 * THE VISITOR'S IP HAS TO REACH THE FORM.
 *
 * `FormsService.submit` accepts it for two things it cannot do without it: the
 * per-(form, IP) burst cap that stops one script filling a tenant's CRM with
 * junk, and `ConsentRecord.ipAddress` — the evidence half of a consent record,
 * which a KVKK/GDPR audit asks for by name. Only the controller can see the socket,
 * so a controller that does not pass it leaves both correct-but-inert.
 */
describe('PublicSiteController — POST f/:formId passes the visitor context', () => {
  function withForms() {
    const forms = { submit: jest.fn().mockResolvedValue({ redirectUrl: null }) };
    const sites = { resolvePublicCallbackTarget: jest.fn() };
    const ctrl = new PublicSiteController(
      sites as any,
      forms as any,
      {} as any,
      { get: jest.fn().mockReturnValue('') } as any,
      { requestCallback: jest.fn() } as any,
    );
    return { ctrl, forms };
  }

  it('hands the IP to the form alongside the attribution signals', async () => {
    const { ctrl, forms } = withForms();
    const req: any = {
      ip: '203.0.113.9',
      headers: { referer: 'https://acme.test/lp?utm_source=x' },
      cookies: {},
    };

    await ctrl.submit('f1', { email: 'a@b.test' }, req, makeRes());

    expect(forms.submit.mock.calls[0][3]).toEqual({
      url: 'https://acme.test/lp?utm_source=x',
      referrer: 'https://acme.test/lp?utm_source=x',
      ip: '203.0.113.9',
    });
  });

  it('is explicitly null when the socket address is unknown, never undefined', async () => {
    // `undefined` would be spread away and the consent row would silently lose
    // the column, which is indistinguishable from "we never recorded one".
    const { ctrl, forms } = withForms();
    await ctrl.submit('f1', {}, { headers: {}, cookies: {} } as any, makeRes());
    expect(forms.submit.mock.calls[0][3]).toMatchObject({ ip: null });
  });
});

/**
 * THE MANAGE PAGE MUST SPEAK THE LANGUAGE THE MAIL DID.
 *
 * `booking.service.ts manageUrl()` puts `/api/public/book/manage/<token>` into
 * the customer's booking mail, and that mail is written through
 * `common/i18n/mail-copy` from `Workspace.defaultLanguage` — whose schema
 * default is `'en'`. So the schema-DEFAULT configuration sends "Manage or
 * cancel your booking" in English and lands the customer on this page. Every
 * word on it used to be a Turkish literal: a customer who never chose Turkish
 * could not tell which button cancels.
 *
 * The sibling unsubscribe pages (`campaign-tracking.controller.ts`) resolve the
 * language from the workspace whose mail the link came out of. This does the
 * same, from the workspace the token already resolves to.
 */
describe('PublicSiteController — GET book/manage/:token speaks the workspace language', () => {
  const BOOKING = {
    workspaceId: 'ws-1',
    calendarName: '',
    calendarSlug: 'demo',
    timezone: 'Europe/Istanbul',
    startAt: '2026-10-01T09:00:00.000Z',
    endAt: '2026-10-01T09:30:00.000Z',
    status: 'CONFIRMED',
    meetingUrl: 'https://meet.example/abc',
  };

  function withBooking(overrides: Record<string, unknown> = {}) {
    const booking = {
      publicByToken: jest.fn().mockResolvedValue({ ...BOOKING, ...overrides }),
    };
    const ctrl = new PublicSiteController(
      { resolvePublicCallbackTarget: jest.fn() } as any,
      {} as any,
      booking as any,
      { get: jest.fn().mockReturnValue('https://jeetagrowth.com') } as any,
      { requestCallback: jest.fn() } as any,
    );
    return { ctrl, booking };
  }

  /** Every recipient-facing Turkish word this page used to hardcode. */
  const TURKISH = [
    'Randevu bulunamadı',
    'Bu bağlantı artık geçerli değil',
    'Toplantıya katıl',
    'Bu randevu iptal edildi',
    'Yeni bir saat seç',
    'Randevuyu iptal et',
    'Saati değiştir',
    'Randevunuz iptal edildi',
    'İptal edilemedi',
  ];

  it('renders an English workspace in English, not Turkish', async () => {
    const { ctrl } = withBooking({ lang: 'en' });
    const res = makeRes();

    await ctrl.manageBooking('tok-1', res);

    const html = res.send.mock.calls[0][0] as string;
    for (const word of TURKISH) expect(html).not.toContain(word);
    expect(html).toContain('Cancel booking');
    expect(html).toContain('Change time');
    expect(html).toContain('Join meeting');
    expect(html).toContain('lang="en"');
  });

  it('still renders Turkish for a Turkish workspace', async () => {
    const { ctrl } = withBooking({ lang: 'tr' });
    const res = makeRes();

    await ctrl.manageBooking('tok-1', res);

    const html = res.send.mock.calls[0][0] as string;
    expect(html).toContain('Randevuyu iptal et');
    expect(html).toContain('Saati değiştir');
    expect(html).toContain('lang="tr"');
  });

  it('marks an Arabic page right-to-left, so the buttons are not mirrored text', async () => {
    const { ctrl } = withBooking({ lang: 'ar' });
    const res = makeRes();

    await ctrl.manageBooking('tok-1', res);

    const html = res.send.mock.calls[0][0] as string;
    expect(html).toContain('lang="ar"');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('إلغاء الموعد');
    // Latin-script locales must not pick up the attribute.
    const { ctrl: ru } = withBooking({ lang: 'ru' });
    const res2 = makeRes();
    await ru.manageBooking('tok-1', res2);
    expect(res2.send.mock.calls[0][0]).not.toContain('dir="rtl"');
    expect(res2.send.mock.calls[0][0]).toContain('Отменить запись');
  });

  it('says a cancelled booking is cancelled in the workspace language', async () => {
    const { ctrl } = withBooking({ lang: 'en', status: 'CANCELLED' });
    const res = makeRes();

    await ctrl.manageBooking('tok-1', res);

    const html = res.send.mock.calls[0][0] as string;
    expect(html).toContain('This booking has been cancelled');
    expect(html).toContain('Pick a new time');
    expect(html).not.toContain('Bu randevu iptal edildi');
  });

  it('writes the inline script messages in the workspace language too', async () => {
    const { ctrl } = withBooking({ lang: 'en' });
    const res = makeRes();

    await ctrl.manageBooking('tok-1', res);

    const html = res.send.mock.calls[0][0] as string;
    expect(html).toContain('Your booking has been cancelled');
    expect(html).toContain('We could not cancel that');
  });

  it('renders an unknown token in the default language, never a tenant one', async () => {
    // No booking means no workspace: resolving a language here would make the
    // page a token oracle. DEFAULT_MAIL_LANG is 'en', same as the unsubscribe
    // pages' own fallback.
    const booking = { publicByToken: jest.fn().mockRejectedValue(new Error('Booking not found')) };
    const ctrl = new PublicSiteController(
      { resolvePublicCallbackTarget: jest.fn() } as any,
      {} as any,
      booking as any,
      { get: jest.fn().mockReturnValue('https://jeetagrowth.com') } as any,
      { requestCallback: jest.fn() } as any,
    );
    const res = makeRes();

    await ctrl.manageBooking('nope', res);

    expect(res.status).toHaveBeenCalledWith(404);
    const html = res.send.mock.calls[0][0] as string;
    expect(html).toContain('Booking not found');
    expect(html).not.toContain('Randevu bulunamadı');
  });
});
