import { TelephonyConfigController } from './telephony-config.controller';
import { MarketingUserPayload } from '../types';

const USER = { id: 'u1', workspaceId: 'ws-1', role: 'MANAGER' } as MarketingUserPayload;

function makeController() {
  const telephony = { verifyCreds: jest.fn() };
  const cdr = { testFetch: jest.fn() };
  const ctrl = new TelephonyConfigController(telephony as any, cdr as any);
  return { telephony, cdr, ctrl };
}

/**
 * POST /marketing/telephony/verify — composes a live /balance auth probe
 * (works from anywhere) with a best-effort CDR fetch (prod IP only). The CDR
 * leg must never throw past this endpoint — a non-prod environment or a
 * transient NetGSM error there is expected and gets reported inline instead.
 */
describe('TelephonyConfigController.verify', () => {
  it('runs both probes and returns them together when a config exists', async () => {
    const { telephony, cdr, ctrl } = makeController();
    telephony.verifyCreds.mockResolvedValue({ configured: true, balance: { ok: true, credsValid: true } });
    cdr.testFetch.mockResolvedValue({ httpStatus: 200, body: { ok: true } });

    const r = await ctrl.verify(USER);

    expect(telephony.verifyCreds).toHaveBeenCalledWith('ws-1');
    expect(cdr.testFetch).toHaveBeenCalledWith('ws-1');
    expect(r).toEqual({
      configured: true,
      balance: { ok: true, credsValid: true },
      cdr: { httpStatus: 200, body: { ok: true } },
    });
  });

  it('skips the CDR probe when there is no configured config', async () => {
    const { telephony, cdr, ctrl } = makeController();
    telephony.verifyCreds.mockResolvedValue({ configured: false, balance: null });

    const r = await ctrl.verify(USER);

    expect(cdr.testFetch).not.toHaveBeenCalled();
    expect(r).toEqual({ configured: false, balance: null, cdr: { skipped: 'no active config' } });
  });

  it('never throws past the endpoint when the CDR probe rejects (e.g. non-prod IP)', async () => {
    const { telephony, cdr, ctrl } = makeController();
    telephony.verifyCreds.mockResolvedValue({ configured: true, balance: { ok: true, credsValid: true } });
    cdr.testFetch.mockRejectedValue(new Error('IP not allow-listed'));

    const r = await ctrl.verify(USER);

    expect(r.cdr).toEqual({ error: 'IP not allow-listed' });
  });
});
