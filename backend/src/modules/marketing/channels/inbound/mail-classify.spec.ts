import { rawMail, parseAddressList, parseContentType } from './inbound-mail.types';
import { classifyMail } from './mail-classify';

/** A header-line list the way mailparser hands it over: ordered, raw. */
const lines = (...pairs: [string, string][]) =>
  pairs.map(([key, value]) => ({ key: key.toLowerCase(), line: `${key}: ${value}` }));

const mailFrom = (address: string, extra: Record<string, unknown> = {}) =>
  rawMail({ source: 'imap', itemKey: '1:2', from: parseAddressList(address), ...extra });

describe('classifyMail — a real person, or machinery', () => {
  it('calls an ordinary reply HUMAN', () => {
    const c = classifyMail(mailFrom('Tarık <tarik@musteri.com.tr>'));
    expect(c.kind).toBe('HUMAN');
    expect(c.reason).toBeNull();
  });

  it('classifies mail with NO headers at all by its sender alone', () => {
    // The webhook path often has no header map; the sender-based rules must
    // still fire there.
    expect(classifyMail(mailFrom('mailer-daemon@mail.example.com')).kind).toBe('DAEMON');
    expect(classifyMail(mailFrom('someone@musteri.com.tr')).kind).toBe('HUMAN');
  });

  it('answers DAEMON when the envelope carried no sender at all', () => {
    const c = classifyMail(rawMail({ source: 'imap', itemKey: '1:2' }));
    expect(c.kind).toBe('DAEMON');
    expect(c.reason).toBe('no-sender');
  });
});

describe('classifyMail — delivery reports', () => {
  it('reads report-type off the content-type PARAMS, which the old helper dropped', () => {
    const c = classifyMail(
      mailFrom('MAILER-DAEMON@mx.example.com', {
        contentType: parseContentType('multipart/report; report-type=delivery-status; boundary=x'),
      }),
    );
    expect(c.kind).toBe('BOUNCE_DSN');
    expect(c.reason).toBe('dsn');
  });

  it('an MDN is a read receipt, never a bounce and never customer text', () => {
    const c = classifyMail(
      mailFrom('patron@musteri.com.tr', {
        contentType: parseContentType('multipart/report; report-type=disposition-notification'),
      }),
    );
    expect(c.kind).toBe('MDN');
    expect(c.reason).toBe('mdn');
  });

  it('routes an ARF feedback report to the delivery-report lane', () => {
    const c = classifyMail(
      mailFrom('fbl@ispmail.example', {
        contentType: parseContentType('multipart/report; report-type=feedback-report'),
      }),
    );
    expect(c.kind).toBe('BOUNCE_DSN');
  });

  it('classifies the report BEFORE Auto-Submitted, or every DSN reads as an auto-reply', () => {
    const c = classifyMail(
      mailFrom('MAILER-DAEMON@mx.example.com', {
        contentType: parseContentType('multipart/report; report-type=delivery-status'),
        headerLines: lines(['Auto-Submitted', 'auto-replied']),
      }),
    );
    expect(c.kind).toBe('BOUNCE_DSN');
  });

  it('catches the non-multipart NDR that carries X-Failed-Recipients', () => {
    const c = classifyMail(
      mailFrom('postmaster@mx.example.com', {
        headerLines: lines(['X-Failed-Recipients', 'yok@musteri.com.tr']),
      }),
    );
    expect(c.kind).toBe('BOUNCE_DSN');
  });
});

describe('classifyMail — auto-replies and lists (lifted verbatim from skipReason)', () => {
  it('treats any Auto-Submitted but "no" as generated', () => {
    expect(classifyMail(mailFrom('a@b.com', { headerLines: lines(['Auto-Submitted', 'auto-replied']) })).kind).toBe(
      'AUTO_REPLY',
    );
    expect(classifyMail(mailFrom('a@b.com', { headerLines: lines(['Auto-Submitted', 'no']) })).kind).toBe('HUMAN');
  });

  it('treats a bulk Precedence as a list and auto_reply as an auto-reply', () => {
    expect(classifyMail(mailFrom('a@b.com', { headerLines: lines(['Precedence', 'bulk']) })).kind).toBe('LIST');
    expect(classifyMail(mailFrom('a@b.com', { headerLines: lines(['Precedence', 'auto_reply']) })).kind).toBe(
      'AUTO_REPLY',
    );
    // A word inside another word is not a Precedence value.
    expect(classifyMail(mailFrom('a@b.com', { headerLines: lines(['Precedence', 'bulking'])})).kind).toBe('HUMAN');
  });

  it('honours the mailparser List-* fold hint AS WELL AS the raw lines', () => {
    // mailparser folds every RFC 2369 List-* header into one `list` key, so the
    // IMAP caller can only answer `headers.has('list')`. A shared classifier
    // that read raw lines alone would silently drop mailing-list filtering on
    // the one path that gets it right today.
    expect(classifyMail(mailFrom('news@list.example', { hasListHeaders: true })).kind).toBe('LIST');
    expect(
      classifyMail(mailFrom('news@list.example', { headerLines: lines(['List-Unsubscribe', '<mailto:x@y>']) })).kind,
    ).toBe('LIST');
    expect(classifyMail(mailFrom('news@list.example', { headerLines: lines(['List-Id', '<x.y>']) })).kind).toBe('LIST');
  });

  it('does not mistake an unrelated header that merely starts with "list"', () => {
    expect(classifyMail(mailFrom('a@b.com', { headerLines: lines(['X-Listing', 'yes']) })).kind).toBe('HUMAN');
  });

  it('catches the vendor auto-responder headers', () => {
    expect(classifyMail(mailFrom('a@b.com', { headerLines: lines(['X-Autoreply', 'yes']) })).kind).toBe('AUTO_REPLY');
    expect(classifyMail(mailFrom('a@b.com', { headerLines: lines(['X-Autorespond', 'on']) })).kind).toBe('AUTO_REPLY');
  });
});

describe('classifyMail — senders that do not hold conversations', () => {
  it('keeps the existing unattended set as EXACT matches', () => {
    expect(classifyMail(mailFrom('notifications@acme.com')).kind).toBe('DAEMON');
    expect(classifyMail(mailFrom('no-reply@acme.com')).kind).toBe('DAEMON');
    // Prefix-matching these would swallow real people: `notification-team@` is
    // a mailbox a human may well answer from.
    expect(classifyMail(mailFrom('notification-team@acme.com')).kind).toBe('HUMAN');
    expect(classifyMail(mailFrom('no-reply-service@acme.com')).kind).toBe('HUMAN');
  });

  it('catches the VERP shapes an exact-match set never could', () => {
    expect(classifyMail(mailFrom('bounces+abc123@mg.acme.com')).kind).toBe('DAEMON');
    expect(classifyMail(mailFrom('bounce-42-user=acme.com@sender.net')).kind).toBe('DAEMON');
    expect(classifyMail(mailFrom('mailer-daemon-xyz@mx.example.com')).kind).toBe('DAEMON');
    expect(
      classifyMail(mailFrom('MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@acme.onmicrosoft.com')).kind,
    ).toBe('DAEMON');
  });

  it('does not turn an ordinary local part that merely begins with "bounce" into a daemon', () => {
    // The VERP pattern requires a separator, so a real person named Bouncer is
    // still a person.
    expect(classifyMail(mailFrom('bouncer@acme.com')).kind).toBe('HUMAN');
  });

  it('names the platform digest for what it is', () => {
    const c = classifyMail(mailFrom('admin@jeetagrowth.com'), { platformFrom: 'admin@jeetagrowth.com' });
    expect(c.kind).toBe('PLATFORM_OWN');
    expect(c.reason).toBe('platform-own');
  });

  it('names the mailbox reading its OWN sent mail an echo', () => {
    const c = classifyMail(mailFrom('info@acme.com'), { ownAddresses: ['Info@Acme.com'] });
    expect(c.kind).toBe('OWN_ECHO');
    expect(c.reason).toBe('own-echo');
  });

  it('checks the echo before the daemon rules, so our own no-reply is an echo', () => {
    const c = classifyMail(mailFrom('no-reply@acme.com'), { ownAddresses: ['no-reply@acme.com'] });
    expect(c.kind).toBe('OWN_ECHO');
  });
});

describe('classifyMail — the ledger needs both a code and a sentence', () => {
  it('carries a stable reason code and a human detail', () => {
    const c = classifyMail(mailFrom('a@b.com', { headerLines: lines(['Auto-Submitted', 'auto-replied']) }));
    expect(c.reason).toBe('auto-reply');
    expect(c.detail).toBe('Auto-Submitted: auto-replied');
  });
});
