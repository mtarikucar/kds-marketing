import { rawMail } from './inbound-mail.types';
import { assessAuth, authVerdict } from './mail-auth';

const ar = (...values: string[]) =>
  values.map((v) => ({ key: 'authentication-results', line: `Authentication-Results: ${v}` }));

const mail = (headerLines: { key: string; line: string }[], extra: Record<string, unknown> = {}) =>
  rawMail({ source: 'imap', itemKey: '1:2', headerLines, ...extra });

describe('authVerdict — three states, fail OPEN', () => {
  it('answers "unknown" when the mail carries no Authentication-Results at all', () => {
    // 'unknown' MUST behave exactly as today: lead created, fan-out fired, AI
    // free to answer. Anything else silently changes every SMTP mailbox that
    // has no authenticating border MTA.
    expect(authVerdict(mail([]))).toBe('unknown');
    expect(assessAuth(mail([])).source).toBe('none');
  });

  it('answers "pass" on a dmarc pass', () => {
    expect(authVerdict(mail(ar('mx.jeeta; spf=pass smtp.mailfrom=acme.com; dkim=pass header.d=acme.com; dmarc=pass header.from=acme.com')))).toBe('pass');
  });

  it('answers "fail" on an explicit dmarc=fail', () => {
    expect(authVerdict(mail(ar('mx.jeeta; spf=fail smtp.mailfrom=evil.com; dmarc=fail header.from=musteri.com.tr')))).toBe(
      'fail',
    );
  });

  it('answers "fail" when spf AND dkim both fail, with no dmarc line', () => {
    expect(authVerdict(mail(ar('mx.jeeta; spf=fail smtp.mailfrom=evil.com; dkim=fail header.d=evil.com')))).toBe('fail');
  });

  it('does NOT fail on spf=softfail alone', () => {
    // Forwarders and list relays legitimately produce softfail; treating it as
    // forged would mute real replies, which is the failure mode being removed.
    expect(authVerdict(mail(ar('mx.jeeta; spf=softfail smtp.mailfrom=acme.com')))).toBe('unknown');
    expect(authVerdict(mail(ar('mx.jeeta; spf=softfail; dkim=pass header.d=acme.com')))).toBe('pass');
  });

  it('does NOT fail on dkim=none alone, nor on spf=fail alone', () => {
    expect(authVerdict(mail(ar('mx.jeeta; dkim=none')))).toBe('unknown');
    expect(authVerdict(mail(ar('mx.jeeta; spf=fail smtp.mailfrom=acme.com')))).toBe('unknown');
    // A forward breaks SPF while DKIM survives — still not a forgery.
    expect(authVerdict(mail(ar('mx.jeeta; spf=fail; dkim=pass header.d=acme.com')))).toBe('pass');
  });

  it('treats several DKIM signatures as a pass when ANY of them verified', () => {
    expect(authVerdict(mail(ar('mx.jeeta; dkim=fail header.d=list.example; dkim=pass header.d=acme.com; spf=fail')))).toBe(
      'pass',
    );
  });
});

describe('authVerdict — only the FIRST header line is trusted', () => {
  it('cannot be flipped to pass by an injected duplicate below the genuine line', () => {
    // The border MTA PREPENDS its result, so the genuine line is first. A
    // `headers.get()` read would merge the attacker's copy into it — which is
    // exactly the bug this module exists to prevent.
    const verdict = authVerdict(
      mail(ar('mx.jeeta; dmarc=fail header.from=musteri.com.tr', 'mx.jeeta; dmarc=pass header.from=musteri.com.tr')),
    );
    expect(verdict).toBe('fail');
  });

  it('cannot be flipped to fail by an injected duplicate either', () => {
    const verdict = authVerdict(
      mail(ar('mx.jeeta; dmarc=pass header.from=musteri.com.tr', 'mx.jeeta; dmarc=fail header.from=musteri.com.tr')),
    );
    expect(verdict).toBe('pass');
  });

  it('ignores a forged result that the sender folded into the body of another header', () => {
    const verdict = authVerdict(
      mail([
        { key: 'subject', line: 'Subject: dmarc=pass' },
        ...ar('mx.jeeta; dmarc=fail header.from=musteri.com.tr'),
      ]),
    );
    expect(verdict).toBe('fail');
  });
});

describe('authVerdict — provider verdicts on the webhook path', () => {
  it('reads Mailgun/SendGrid fields when there is no Authentication-Results line', () => {
    expect(authVerdict(mail([], { providerAuth: { spf: 'Pass', dkim: 'Pass' } }))).toBe('pass');
    expect(authVerdict(mail([], { providerAuth: { spf: 'Fail', dkim: 'Fail' } }))).toBe('fail');
    expect(authVerdict(mail([], { providerAuth: { spf: 'SoftFail' } }))).toBe('unknown');
    expect(assessAuth(mail([], { providerAuth: { spf: 'Pass' } })).source).toBe('provider');
  });

  it('prefers the header line over the provider fields when both are present', () => {
    const v = authVerdict(mail(ar('mx.jeeta; dmarc=fail'), { providerAuth: { spf: 'Pass', dkim: 'Pass' } }));
    expect(v).toBe('fail');
  });

  it('reads a SendGrid dkim map rather than choking on it', () => {
    expect(authVerdict(mail([], { providerAuth: { dkim: '{@acme.com : pass}' } }))).toBe('pass');
  });
});

describe('assessAuth — the detail behind the badge', () => {
  it('reports each method it actually read', () => {
    const a = assessAuth(mail(ar('mx.jeeta; spf=pass smtp.mailfrom=acme.com; dkim=fail; dmarc=fail')));
    expect(a).toEqual({ verdict: 'fail', spf: 'pass', dkim: 'fail', dmarc: 'fail', source: 'headers' });
  });

  it('does not mistake a parameter that merely ends in a method name', () => {
    // `header.d=`, `smtp.mailfrom=` and friends sit right beside the verdicts.
    const a = assessAuth(mail(ar('mx.jeeta; dkim=pass header.d=acme.com header.i=@acme.com')));
    expect(a.dkim).toBe('pass');
    expect(a.dmarc).toBeNull();
    expect(a.verdict).toBe('pass');
  });
});
