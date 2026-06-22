import { EmailHygieneService } from './email-hygiene.service';

const resolveMx = jest.fn();
jest.mock('dns', () => ({ promises: { resolveMx: (...a: any[]) => resolveMx(...a) } }));

describe('EmailHygieneService', () => {
  let svc: EmailHygieneService;
  beforeEach(() => {
    svc = new EmailHygieneService();
    resolveMx.mockReset();
  });

  it('returns UNKNOWN for an empty email', async () => {
    expect(await svc.verify('')).toBe('UNKNOWN');
    expect(await svc.verify(null)).toBe('UNKNOWN');
  });

  it('returns INVALID for bad syntax without hitting DNS', async () => {
    expect(await svc.verify('not-an-email')).toBe('INVALID');
    expect(await svc.verify('a@b')).toBe('INVALID');
    expect(resolveMx).not.toHaveBeenCalled();
  });

  it('returns RISKY for a known disposable domain', async () => {
    expect(await svc.verify('x@mailinator.com')).toBe('RISKY');
    expect(resolveMx).not.toHaveBeenCalled();
  });

  it('returns VALID when the domain has MX records', async () => {
    resolveMx.mockResolvedValue([{ exchange: 'mx.example.com', priority: 10 }]);
    expect(await svc.verify('user@example.com')).toBe('VALID');
    expect(resolveMx).toHaveBeenCalledWith('example.com');
  });

  it('returns INVALID when the domain resolves but has no MX', async () => {
    resolveMx.mockResolvedValue([]);
    expect(await svc.verify('user@no-mx.com')).toBe('INVALID');
  });

  it('returns INVALID when the domain does not exist (ENOTFOUND)', async () => {
    resolveMx.mockRejectedValue(Object.assign(new Error('nf'), { code: 'ENOTFOUND' }));
    expect(await svc.verify('user@nope.invalid')).toBe('INVALID');
  });

  it('returns UNKNOWN on a transient DNS error (never suppress on a blip)', async () => {
    resolveMx.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }));
    expect(await svc.verify('user@flaky.com')).toBe('UNKNOWN');
  });
});
