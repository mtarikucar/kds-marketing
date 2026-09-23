import { EmailHygieneService, classifyEmailSyntax } from './email-hygiene.service';

const resolveMx = jest.fn();
jest.mock('dns', () => ({ promises: { resolveMx: (...a: any[]) => resolveMx(...a) } }));
jest.mock('../../../common/util/safe-fetch', () => ({ safeFetch: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { safeFetch } = require('../../../common/util/safe-fetch');
const safeFetchMock = safeFetch as jest.Mock;

describe('EmailHygieneService', () => {
  let svc: EmailHygieneService;
  beforeEach(() => {
    svc = new EmailHygieneService();
    resolveMx.mockReset();
    safeFetchMock.mockReset();
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

  it('treats an RFC 7505 null MX ("." exchange) as INVALID, not as a working domain', async () => {
    // A domain that publishes `0 .` is explicitly saying "I accept no mail".
    // The old length-only check read that single record as "has MX" → VALID,
    // so every address at a null-MX domain entered campaign audiences.
    resolveMx.mockResolvedValue([{ exchange: '.', priority: 0 }]);
    expect(await svc.verify('user@null-mx.com')).toBe('INVALID');
    resolveMx.mockResolvedValue([{ exchange: '', priority: 0 }]);
    expect(await svc.verify('user@null-mx.com')).toBe('INVALID');
  });

  it('returns INVALID for a multi-address / display-name value without hitting DNS', async () => {
    // The shared single-address rule, not a second local regex: a list or a
    // display-name form is one lead row that would deliver to someone else.
    expect(await svc.verify('info@x.com, satis@x.com')).toBe('INVALID');
    expect(await svc.verify('info@x.com;satis@x.com')).toBe('INVALID');
    expect(await svc.verify('"Ada" <ada@x.com>')).toBe('INVALID');
    expect(resolveMx).not.toHaveBeenCalled();
  });

  it('returns INVALID when the domain does not exist (ENOTFOUND)', async () => {
    resolveMx.mockRejectedValue(Object.assign(new Error('nf'), { code: 'ENOTFOUND' }));
    expect(await svc.verify('user@nope.invalid')).toBe('INVALID');
  });

  it('returns UNKNOWN on a transient DNS error (never suppress on a blip)', async () => {
    resolveMx.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }));
    expect(await svc.verify('user@flaky.com')).toBe('UNKNOWN');
  });

  describe('tier-2 mailbox verification (env-gated)', () => {
    const saved = { url: process.env.EMAIL_VERIFY_API_URL, key: process.env.EMAIL_VERIFY_API_KEY };
    afterEach(() => {
      saved.url === undefined ? delete process.env.EMAIL_VERIFY_API_URL : (process.env.EMAIL_VERIFY_API_URL = saved.url);
      saved.key === undefined ? delete process.env.EMAIL_VERIFY_API_KEY : (process.env.EMAIL_VERIFY_API_KEY = saved.key);
    });
    const enable = () => {
      process.env.EMAIL_VERIFY_API_URL = 'https://verify.example/check';
      process.env.EMAIL_VERIFY_API_KEY = 'k';
    };

    it('is inert (no external call) when unconfigured', async () => {
      delete process.env.EMAIL_VERIFY_API_URL;
      resolveMx.mockResolvedValue([{ exchange: 'mx', priority: 10 }]);
      expect(await svc.verify('user@example.com')).toBe('VALID');
      expect(safeFetchMock).not.toHaveBeenCalled();
    });

    it('overrides a tier-1 VALID with the provider verdict (undeliverable → INVALID)', async () => {
      enable();
      resolveMx.mockResolvedValue([{ exchange: 'mx', priority: 10 }]); // tier-1 would say VALID
      safeFetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'undeliverable' }) });
      expect(await svc.verify('ghost@example.com')).toBe('INVALID');
      expect(safeFetchMock).toHaveBeenCalled();
    });

    it('maps catch-all/role/disposable → RISKY', async () => {
      enable();
      resolveMx.mockResolvedValue([{ exchange: 'mx', priority: 10 }]);
      safeFetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'catch-all' }) });
      expect(await svc.verify('info@example.com')).toBe('RISKY');
    });

    it('falls back to tier-1 when the provider call fails', async () => {
      enable();
      resolveMx.mockResolvedValue([{ exchange: 'mx', priority: 10 }]);
      safeFetchMock.mockRejectedValue(new Error('provider down'));
      expect(await svc.verify('user@example.com')).toBe('VALID');
    });

    it('does NOT spend a paid lookup on an already-INVALID (no MX) address', async () => {
      enable();
      resolveMx.mockResolvedValue([]); // tier-1 INVALID
      expect(await svc.verify('user@no-mx.com')).toBe('INVALID');
      expect(safeFetchMock).not.toHaveBeenCalled();
    });
  });
});

/**
 * The I/O-free half of hygiene: the verdict a write path can afford to take
 * inline. `verify()` does a DNS round trip, so the import loop (inside a
 * transaction) and the public form submit cannot call it — but they CAN refuse
 * a value that is not an address at all, and that is what catches the garbage.
 */
describe('classifyEmailSyntax', () => {
  it('is UNKNOWN for a missing address — absence is not a verdict', () => {
    expect(classifyEmailSyntax('')).toBe('UNKNOWN');
    expect(classifyEmailSyntax(null)).toBe('UNKNOWN');
    expect(classifyEmailSyntax(undefined)).toBe('UNKNOWN');
  });

  it('is INVALID for everything that is not exactly one address', () => {
    expect(classifyEmailSyntax('not-an-email')).toBe('INVALID');
    expect(classifyEmailSyntax('a@b')).toBe('INVALID');
    expect(classifyEmailSyntax('info@x.com, satis@x.com')).toBe('INVALID');
    expect(classifyEmailSyntax('info[at]x.com')).toBe('INVALID');
    expect(classifyEmailSyntax('ada@x.com\r\nbcc: victim@y.com')).toBe('INVALID');
    expect(classifyEmailSyntax(`${'a'.repeat(250)}@x.com`)).toBe('INVALID');
  });

  it('is RISKY for a throwaway domain', () => {
    expect(classifyEmailSyntax('x@mailinator.com')).toBe('RISKY');
    expect(classifyEmailSyntax('X@Mailinator.com')).toBe('RISKY');
  });

  it('is UNKNOWN — never VALID — for a well-formed address, because syntax proves nothing', () => {
    // Only an MX lookup (or tier-2) may say VALID. A syntax pass that claimed
    // VALID would let a dead domain into an audience the send-time gate trusts.
    expect(classifyEmailSyntax('user@example.com')).toBe('UNKNOWN');
  });
});
