import { EmailService } from './email.service';

/**
 * `transporter.verify()` is a real login. The MCP tool that calls it is READ and
 * needs no approval, so "is mail working?" asked in a loop is a login flood —
 * and a mailbox under a login flood answers 535, which is exactly the symptom
 * the tool exists to report. A diagnostic must not be able to cause the fault
 * it diagnoses.
 *
 * Observed live: back-to-back calls returned ok:true then 535. Whatever the
 * cause, an answer that alternates cannot tell anyone whether mail works.
 */
describe('EmailService.verifyTransport — one login per window', () => {
  const make = (verify: jest.Mock) => {
    const svc = Object.create(EmailService.prototype) as EmailService;
    (svc as unknown as { transporter: unknown }).transporter = { verify };
    return svc;
  };

  it('does not re-authenticate inside the window', async () => {
    const verify = jest.fn().mockResolvedValue(true);
    const svc = make(verify);
    let t = 1_000_000;
    const now = () => t;

    const first = await svc.verifyTransport(60_000, now);
    t += 30_000;
    const second = await svc.verifyTransport(60_000, now);

    // One login, two answers.
    expect(verify).toHaveBeenCalledTimes(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    // And the SAME answer — the alternation is what made this unusable.
    expect(second.ok).toBe(first.ok);
    expect(second.checkedAt).toBe(first.checkedAt);
  });

  it('authenticates again once the window has passed', async () => {
    const verify = jest.fn().mockResolvedValue(true);
    const svc = make(verify);
    let t = 1_000_000;
    const now = () => t;

    await svc.verifyTransport(60_000, now);
    t += 61_000;
    const fresh = await svc.verifyTransport(60_000, now);

    expect(verify).toHaveBeenCalledTimes(2);
    expect(fresh.cached).toBe(false);
  });

  it('caches a FAILURE too, so a broken mailbox is not retried per call', async () => {
    const verify = jest.fn().mockRejectedValue(new Error('535 Authentication Failed'));
    const svc = make(verify);
    let t = 1_000_000;
    const now = () => t;

    const first = await svc.verifyTransport(60_000, now);
    t += 10_000;
    const second = await svc.verifyTransport(60_000, now);

    // Retrying a rejected login every call is precisely what deepens a
    // provider-side block.
    expect(verify).toHaveBeenCalledTimes(1);
    expect(first.ok).toBe(false);
    expect(first.error).toContain('535');
    expect(second.cached).toBe(true);
    expect(second.error).toContain('535');
  });

  it('reports an unconfigured mailer without pretending to have checked', async () => {
    const svc = Object.create(EmailService.prototype) as EmailService;
    (svc as unknown as { transporter: unknown }).transporter = null;

    const r = await svc.verifyTransport();
    expect(r).toMatchObject({ ok: false, configured: false, cached: false });
  });
});
