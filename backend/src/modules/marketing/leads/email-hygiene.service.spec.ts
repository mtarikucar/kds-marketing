import { EmailHygieneService, classifyEmailSyntax } from './email-hygiene.service';

const resolveMx = jest.fn();
const resolve4 = jest.fn();
const resolve6 = jest.fn();
jest.mock('dns', () => ({
  promises: {
    resolveMx: (...a: any[]) => resolveMx(...a),
    resolve4: (...a: any[]) => resolve4(...a),
    resolve6: (...a: any[]) => resolve6(...a),
  },
}));
jest.mock('../../../common/util/safe-fetch', () => ({ safeFetch: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { safeFetch } = require('../../../common/util/safe-fetch');
const safeFetchMock = safeFetch as jest.Mock;

/** A resolver error exactly as `dns.promises` raises it: an Error with a c-ares `code`. */
const dnsError = (code: string) => Object.assign(new Error(`query ${code}`), { code });
/** A lookup that never answers — the shape of a dead resolver or a dropped UDP packet. */
const never = () => new Promise<never>(() => undefined);

describe('EmailHygieneService', () => {
  let svc: EmailHygieneService;
  beforeEach(() => {
    svc = new EmailHygieneService();
    resolveMx.mockReset();
    resolve4.mockReset();
    resolve6.mockReset();
    // An A/AAAA lookup a test did not stub is a resolver that told us nothing —
    // never a definitive "no records", so it can never be what makes INVALID.
    resolve4.mockRejectedValue(dnsError('ETIMEOUT'));
    resolve6.mockRejectedValue(dnsError('ETIMEOUT'));
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

  it('treats a domain with no MX but an A record as deliverable (RFC 5321 implicit MX), not INVALID', async () => {
    // RFC 5321 §5.1: with no MX, the domain's own address IS the mail host.
    // `resolveMx` raises ENODATA for exactly this, and reading that as INVALID
    // suppressed a real customer's address on every send path.
    resolveMx.mockRejectedValue(dnsError('ENODATA'));
    resolve4.mockResolvedValue(['203.0.113.7']);
    resolve6.mockRejectedValue(dnsError('ENODATA'));
    expect(await svc.verify('user@no-mx.com')).toBe('VALID');
    expect(resolve4).toHaveBeenCalledWith('no-mx.com');
  });

  it('treats a domain with no MX but an AAAA record as deliverable, and an empty MX list like ENODATA', async () => {
    resolveMx.mockResolvedValue([]);
    resolve4.mockRejectedValue(dnsError('ENODATA'));
    resolve6.mockResolvedValue(['2001:db8::25']);
    expect(await svc.verify('user@v6-only.com')).toBe('VALID');
  });

  it('is INVALID only when the domain exists with no MX and DEFINITIVELY no A and no AAAA', async () => {
    // RFC 5321 §5.1: "the implicit MX is unusable" MUST be reported as an error.
    // Every one of the three answers is an authoritative "no such record" —
    // there is no mail route to this domain, not merely one we failed to find.
    resolveMx.mockRejectedValue(dnsError('ENODATA'));
    resolve4.mockRejectedValue(dnsError('ENODATA'));
    resolve6.mockResolvedValue([]);
    expect(await svc.verify('user@parked.com')).toBe('INVALID');
  });

  it.each(['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED', 'EREFUSED'])(
    'is UNKNOWN when MX is ENODATA but the address lookup fails with %s — an unanswered fallback proves nothing',
    async (code) => {
      resolveMx.mockRejectedValue(dnsError('ENODATA'));
      resolve4.mockRejectedValue(dnsError(code));
      resolve6.mockRejectedValue(dnsError('ENODATA'));
      expect(await svc.verify('user@half-answered.com')).toBe('UNKNOWN');
      resolve4.mockRejectedValue(dnsError('ENODATA'));
      resolve6.mockRejectedValue(dnsError(code));
      expect(await svc.verify('user@half-answered.com')).toBe('UNKNOWN');
    },
  );

  it('is UNKNOWN — not INVALID — for MX records that are neither usable nor a null MX', async () => {
    // A malformed answer is not the domain saying "no mail"; only `0 .` is.
    resolveMx.mockResolvedValue([{ priority: 10 }]);
    expect(await svc.verify('user@odd-answer.com')).toBe('UNKNOWN');
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

  /**
   * INVALID suppresses the address on EVERY send path (campaigns, 1:1 mail,
   * documents, audience sync) and — through the address-level union in
   * SuppressionService — on every other lead that shares it. So only an answer
   * that PROVES the domain takes no mail may produce it: NXDOMAIN, a null MX,
   * or an existing domain with no MX/A/AAAA at all. Anything the resolver
   * failed to answer is UNKNOWN, which every send path still mails.
   */
  describe('a resolver that fails to answer can never make an address INVALID', () => {
    it.each([
      'ETIMEOUT', // c-ares gave up
      'ESERVFAIL', // upstream/DNSSEC failure
      'ECONNREFUSED', // no resolver listening (a CI box / container with no DNS)
      'EREFUSED', // resolver refused the query
      'EAI_AGAIN', // getaddrinfo-style "try again"
      'ECANCELLED', // resolver torn down mid-query (shutdown)
      'EBADRESP', // garbled reply
      'ECONNRESET',
      'EBADNAME', // a name the resolver would not even send
      'ENOTINITIALIZED',
    ])('%s on the MX lookup is UNKNOWN', async (code) => {
      resolveMx.mockRejectedValue(dnsError(code));
      expect(await svc.verify('user@real-customer.com.tr')).toBe('UNKNOWN');
    });

    it('an error with no code at all is UNKNOWN', async () => {
      resolveMx.mockRejectedValue(new Error('socket hang up'));
      expect(await svc.verify('user@real-customer.com.tr')).toBe('UNKNOWN');
    });

    it('a resolver that throws synchronously is UNKNOWN, not a rejected lead create', async () => {
      resolveMx.mockImplementation(() => {
        throw new TypeError('resolver exploded');
      });
      await expect(svc.verify('user@real-customer.com.tr')).resolves.toBe('UNKNOWN');
    });
  });

  /**
   * `verify()` sits on the request path of lead create/edit, so a resolver that
   * never answers (a CI runner with no DNS, a dropped packet) must cost at most
   * the tier-1 budget — and the implicit-MX fallback shares that budget rather
   * than getting a fresh one.
   */
  describe('the DNS verdict is bounded in time', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('a hung MX lookup settles UNKNOWN at the 2.5 s budget', async () => {
      resolveMx.mockImplementation(never);
      let settled: string | undefined;
      void svc.verify('user@black-hole.com').then((v) => (settled = v));
      await jest.advanceTimersByTimeAsync(2499);
      expect(settled).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toBe('UNKNOWN');
    });

    it('a slow ENODATA followed by hung A/AAAA lookups still settles UNKNOWN by 2.5 s in total', async () => {
      resolveMx.mockImplementation(
        () => new Promise((_, reject) => setTimeout(() => reject(dnsError('ENODATA')), 2000)),
      );
      resolve4.mockImplementation(never);
      resolve6.mockImplementation(never);
      let settled: string | undefined;
      void svc.verify('user@slow-zone.com').then((v) => (settled = v));
      await jest.advanceTimersByTimeAsync(2000);
      expect(resolve4).toHaveBeenCalled();
      expect(settled).toBeUndefined();
      await jest.advanceTimersByTimeAsync(500);
      expect(settled).toBe('UNKNOWN');
    });

    it('leaves no timer armed once a fast answer wins the race', async () => {
      resolveMx.mockResolvedValue([{ exchange: 'mx.fast.com', priority: 10 }]);
      expect(await svc.verify('user@fast.com')).toBe('VALID');
      expect(jest.getTimerCount()).toBe(0);
    });
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

    it('does NOT spend a paid lookup on an already-INVALID (null MX / NXDOMAIN) address', async () => {
      enable();
      resolveMx.mockResolvedValue([{ exchange: '', priority: 0 }]); // tier-1 INVALID (RFC 7505)
      expect(await svc.verify('user@null-mx.com')).toBe('INVALID');
      resolveMx.mockRejectedValue(dnsError('ENOTFOUND')); // tier-1 INVALID (NXDOMAIN)
      expect(await svc.verify('user@nope.com')).toBe('INVALID');
      expect(safeFetchMock).not.toHaveBeenCalled();
    });

    describe('the provider call is bounded end to end, not just its fetch()', () => {
      beforeEach(() => jest.useFakeTimers());
      afterEach(() => jest.useRealTimers());

      it('a provider that never answers costs at most 4 s and keeps the tier-1 verdict', async () => {
        // safeFetch's own timer arms AFTER its SSRF hostname lookup and is
        // cleared once headers arrive, so neither a hung lookup nor a stalled
        // body is covered by it — the cap has to sit around the whole call.
        enable();
        resolveMx.mockResolvedValue([{ exchange: 'mx', priority: 10 }]);
        safeFetchMock.mockImplementation(never);
        let settled: string | undefined;
        void svc.verify('user@example.com').then((v) => (settled = v));
        await jest.advanceTimersByTimeAsync(3999);
        expect(settled).toBeUndefined();
        await jest.advanceTimersByTimeAsync(1);
        expect(settled).toBe('VALID');
      });

      it('a provider that sends headers and then stalls the body is capped the same way', async () => {
        enable();
        resolveMx.mockRejectedValue(dnsError('ETIMEOUT'));
        safeFetchMock.mockResolvedValue({ ok: true, json: never });
        let settled: string | undefined;
        void svc.verify('user@example.com').then((v) => (settled = v));
        await jest.advanceTimersByTimeAsync(2500 + 4000);
        expect(settled).toBe('UNKNOWN');
        expect(jest.getTimerCount()).toBe(0);
      });
    });

    it('still asks the provider about an implicit-MX domain — tier-1 did not rule it out', async () => {
      enable();
      resolveMx.mockRejectedValue(dnsError('ENODATA'));
      resolve4.mockResolvedValue(['203.0.113.7']);
      safeFetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'valid' }) });
      expect(await svc.verify('user@no-mx.com')).toBe('VALID');
      expect(safeFetchMock).toHaveBeenCalled();
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
