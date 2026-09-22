import {
  MAX_INGEST_AGE_MS,
  MAX_SOURCE_BYTES,
  headerLineValue,
  headerLineValues,
  isOversize,
  isTooOldToIngest,
  parseAddressList,
  parseContentType,
  preferredRecipients,
  primaryAddress,
  primaryName,
  rawMail,
  rawMailFromParsed,
  synthesizeAttachmentBody,
  toAddressList,
} from './inbound-mail.types';

describe('parseAddressList', () => {
  it('reads the REAL mailbox out of a forged display name', () => {
    // `from-display-name-spoof`: the old first-`<>` regex answered
    // ceo@victim.com here, which attributed the attacker's mail to the
    // victim's lead — and, on the webhook, to the victim's TENANT.
    const list = parseAddressList('"<ceo@victim.com>" <attacker@evil.com>');
    expect(list).toEqual([{ address: 'attacker@evil.com', name: '<ceo@victim.com>' }]);
    expect(primaryAddress(list)).toBe('attacker@evil.com');
  });

  it('keeps the display name beside the address', () => {
    // Dropping the name is how every IMAP lead became "Channel contact".
    const list = parseAddressList('Hummy Tummy <admin@hummytummy.com>');
    expect(primaryAddress(list)).toBe('admin@hummytummy.com');
    expect(primaryName(list)).toBe('Hummy Tummy');
  });

  it('keeps EVERY mailbox of an RFC-legal multi-mailbox From', () => {
    // Rejecting these would drop real customer mail; the first one is the
    // identity, the rest are kept so a caller can log the ambiguity.
    const list = parseAddressList('Ali <ali@acme.com>, Ayse <ayse@acme.com>');
    expect(list.map((a) => a.address)).toEqual(['ali@acme.com', 'ayse@acme.com']);
    expect(primaryAddress(list)).toBe('ali@acme.com');
  });

  it('flattens a group and drops the empty group form', () => {
    expect(parseAddressList('undisclosed-recipients:;')).toEqual([]);
    expect(parseAddressList('Team:ali@acme.com,ayse@acme.com;').map((a) => a.address)).toEqual([
      'ali@acme.com',
      'ayse@acme.com',
    ]);
  });

  it('lowercases the address but never the display name', () => {
    const list = parseAddressList('Tarık <Tarik@Acme.COM>');
    expect(list[0]).toEqual({ address: 'tarik@acme.com', name: 'Tarık' });
  });

  it('drops mailboxes that are not deliverable addresses', () => {
    expect(parseAddressList('Mailer Daemon')).toEqual([]);
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList(null)).toEqual([]);
  });

  it('refuses a value carrying a header break', () => {
    expect(parseAddressList('a@b.com\r\nBcc: victim@c.com')).toEqual([]);
  });

  it('still reads a legitimately FOLDED header', () => {
    // RFC 5322 folding is a continuation line that starts with whitespace; a
    // break that does not is the injection attempt above.
    expect(parseAddressList('Hummy Tummy\r\n <admin@hummytummy.com>')).toEqual([
      { address: 'admin@hummytummy.com', name: 'Hummy Tummy' },
    ]);
  });
});

describe('toAddressList', () => {
  it('accepts what mailparser already parsed', () => {
    const parsed = { value: [{ address: 'Ali@Acme.com', name: 'Ali' }], text: 'Ali <Ali@Acme.com>' };
    expect(toAddressList(parsed)).toEqual([{ address: 'ali@acme.com', name: 'Ali' }]);
  });

  it('accepts the array form mailparser uses for To with several headers', () => {
    const parsed = [
      { value: [{ address: 'a@x.com', name: '' }] },
      { value: [{ address: 'b@x.com', name: 'B' }] },
    ];
    expect(toAddressList(parsed).map((a) => a.address)).toEqual(['a@x.com', 'b@x.com']);
  });

  it('falls back to parsing a raw string', () => {
    expect(toAddressList('Ali <ali@acme.com>')).toEqual([{ address: 'ali@acme.com', name: 'Ali' }]);
  });
});

describe('header access', () => {
  const mail = rawMail({
    source: 'imap',
    itemKey: '1:2',
    headerLines: [
      { key: 'authentication-results', line: 'Authentication-Results: mx.a; dmarc=fail' },
      { key: 'authentication-results', line: 'Authentication-Results: mx.b; dmarc=pass' },
      { key: 'subject', line: 'Subject: merhaba' },
    ],
  });

  it('returns only the FIRST line for a repeated header', () => {
    expect(headerLineValue(mail, 'Authentication-Results')).toBe('mx.a; dmarc=fail');
  });

  it('can still list every occurrence when a caller wants them', () => {
    expect(headerLineValues(mail, 'authentication-results')).toEqual([
      'mx.a; dmarc=fail',
      'mx.b; dmarc=pass',
    ]);
  });

  it('answers null for a header that is not there', () => {
    expect(headerLineValue(mail, 'x-autoreply')).toBeNull();
  });
});

describe('parseContentType', () => {
  it('keeps the params the local header helper used to drop', () => {
    expect(parseContentType('multipart/report; report-type=delivery-status; boundary="=_a"')).toEqual({
      value: 'multipart/report',
      params: { 'report-type': 'delivery-status', boundary: '=_a' },
    });
  });

  it('handles an unquoted, upper-case value', () => {
    expect(parseContentType('TEXT/Plain; Charset=UTF-8')).toEqual({
      value: 'text/plain',
      params: { charset: 'UTF-8' },
    });
  });

  it('answers null for nothing', () => {
    expect(parseContentType('')).toBeNull();
    expect(parseContentType(null)).toBeNull();
  });
});

describe('preferredRecipients', () => {
  it('prefers what the SERVER proved over the header the sender wrote', () => {
    // Routing on the To header is the cross-tenant injection
    // (`from-display-name-spoof`, note 3).
    const mail = rawMail({
      source: 'webhook',
      itemKey: 'x',
      envelopeTo: ['Mailbox@TenantB.com'],
      to: [{ address: 'mailbox@tenanta.com', name: '' }],
    });
    expect(preferredRecipients(mail)).toEqual(['mailbox@tenantb.com']);
  });

  it('falls back to the To header only when there is no envelope', () => {
    const mail = rawMail({
      source: 'imap',
      itemKey: 'x',
      to: [{ address: 'mailbox@tenanta.com', name: '' }],
      cc: [{ address: 'cc@tenanta.com', name: '' }],
    });
    expect(preferredRecipients(mail)).toEqual(['mailbox@tenanta.com', 'cc@tenanta.com']);
  });
});

describe('size and age policy', () => {
  it('calls a mail oversize only above the source cap', () => {
    expect(isOversize(MAX_SOURCE_BYTES)).toBe(false);
    expect(isOversize(MAX_SOURCE_BYTES + 1)).toBe(true);
    // Unknown size is not a reason to drop anything.
    expect(isOversize(null)).toBe(false);
    expect(isOversize(undefined)).toBe(false);
  });

  it('skips a months-old mail only on the RESUME path', () => {
    const now = Date.UTC(2026, 8, 23);
    const old = new Date(now - MAX_INGEST_AGE_MS - 1);
    expect(isTooOldToIngest(old, { resuming: true, now })).toBe(true);
    // A first run is already bounded by the `since` search; bounding it twice
    // would drop the backlog a new mailbox is connected to read.
    expect(isTooOldToIngest(old, { resuming: false, now })).toBe(false);
  });

  it('ingests when the date is missing or unusable — fail open', () => {
    const now = Date.UTC(2026, 8, 23);
    expect(isTooOldToIngest(null, { resuming: true, now })).toBe(false);
    expect(isTooOldToIngest(new Date('nonsense'), { resuming: true, now })).toBe(false);
  });

  it('keeps a mail that is inside the window', () => {
    const now = Date.UTC(2026, 8, 23);
    expect(isTooOldToIngest(new Date(now - 60_000), { resuming: true, now })).toBe(false);
  });
});

describe('synthesizeAttachmentBody', () => {
  it('says out loud that the content was NOT read', () => {
    // The AI answers whatever is ingested, so an attachment-only mail must not
    // arrive as an empty message NOR as a confident-looking summary.
    const body = synthesizeAttachmentBody([
      { filename: 'sozlesme.pdf', contentType: 'application/pdf', sizeBytes: 90_000 },
      { filename: 'dekont.jpg', contentType: 'image/jpeg', sizeBytes: 40_000 },
    ]);
    expect(body).toBe('[2 dosya eklendi: sozlesme.pdf, dekont.jpg — içerik okunamadı]');
  });

  it('names an unnamed attachment rather than dropping it', () => {
    expect(synthesizeAttachmentBody([{ filename: null, contentType: 'application/pdf', sizeBytes: 1 }])).toBe(
      '[1 dosya eklendi: (adsız dosya) — içerik okunamadı]',
    );
  });

  it('answers null when there is nothing to describe', () => {
    expect(synthesizeAttachmentBody([])).toBeNull();
    expect(synthesizeAttachmentBody(null)).toBeNull();
  });
});

describe('rawMail', () => {
  it('fills every field so three callers cannot disagree on the shape', () => {
    const mail = rawMail({ source: 'webhook', itemKey: 'evt-1' });
    expect(mail).toEqual({
      source: 'webhook',
      itemKey: 'evt-1',
      from: [],
      replyTo: [],
      to: [],
      cc: [],
      envelopeTo: [],
      subject: null,
      messageId: null,
      inReplyTo: null,
      references: [],
      headerLines: [],
      contentType: null,
      hasListHeaders: false,
      internalDate: null,
      sizeBytes: null,
      text: null,
      html: null,
      strippedText: null,
      attachments: [],
      reportParts: [],
      providerAuth: null,
      bodyTruncated: false,
    });
  });

  it('normalizes the Message-ID to the ONE spelling both sides look up', () => {
    const mail = rawMail({ source: 'imap', itemKey: '1:2', messageId: '<ABC@Mail.Example.COM>' });
    expect(mail.messageId).toBe('ABC@mail.example.com');
  });
});

describe('rawMailFromParsed', () => {
  const headers = (entries: Record<string, unknown>) => ({
    get: (name: string) => entries[name.toLowerCase()],
    has: (name: string) => name.toLowerCase() in entries,
  });

  it('takes the receive time from the ENVELOPE, never from the Date: header', () => {
    // `parsed.date` is the sender's clock. The age bound reads internalDate,
    // so letting the header in would let a skewed clock drop real mail.
    const internalDate = new Date('2026-09-20T10:00:00Z');
    const mail = rawMailFromParsed(
      { date: new Date('2019-01-01T00:00:00Z') } as never,
      { source: 'imap', itemKey: '42:7', internalDate, sizeBytes: 2048 },
    );
    expect(mail.internalDate).toBe(internalDate);
    expect(mail.sizeBytes).toBe(2048);
    expect(mail.itemKey).toBe('42:7');
  });

  it('keeps the content-type PARAMS mailparser already structured', () => {
    const mail = rawMailFromParsed(
      { headers: headers({ 'content-type': { value: 'multipart/report', params: { 'report-type': 'delivery-status' } } }) },
      { source: 'imap', itemKey: '1:2' },
    );
    expect(mail.contentType).toEqual({
      value: 'multipart/report',
      params: { 'report-type': 'delivery-status' },
    });
  });

  it('carries the mailparser List-* fold hint through', () => {
    // mailparser folds every RFC 2369 List-* header into one `list` key, so
    // `headers.has('list-unsubscribe')` alone answers false.
    const folded = rawMailFromParsed({ headers: headers({ list: {} }) }, { source: 'imap', itemKey: '1:2' });
    expect(folded.hasListHeaders).toBe(true);
    const plain = rawMailFromParsed({ headers: headers({}) }, { source: 'imap', itemKey: '1:2' });
    expect(plain.hasListHeaders).toBe(false);
  });

  it('splits report sub-parts away from real attachments', () => {
    const mail = rawMailFromParsed(
      {
        attachments: [
          { contentType: 'message/delivery-status', content: Buffer.from('Status: 5.1.1') },
          { contentType: 'application/pdf', filename: 'teklif.pdf', size: 900 },
        ],
      },
      { source: 'imap', itemKey: '1:2' },
    );
    expect(mail.reportParts).toEqual([{ contentType: 'message/delivery-status', text: 'Status: 5.1.1' }]);
    expect(mail.attachments).toEqual([
      { filename: 'teklif.pdf', contentType: 'application/pdf', sizeBytes: 900 },
    ]);
  });

  it('reads the structured identities rather than re-parsing a display name', () => {
    const mail = rawMailFromParsed(
      {
        from: { value: [{ address: 'attacker@evil.com', name: '<ceo@victim.com>' }] },
        replyTo: { value: [{ address: 'forms@relay.example', name: 'Web Formu' }] },
        to: { value: [{ address: 'info@acme.com', name: '' }] },
        references: '<a@x.com> <b@x.com>',
        html: false,
      },
      { source: 'imap', itemKey: '1:2' },
    );
    expect(mail.from).toEqual([{ address: 'attacker@evil.com', name: '<ceo@victim.com>' }]);
    expect(mail.replyTo[0].address).toBe('forms@relay.example');
    expect(mail.to[0].address).toBe('info@acme.com');
    // One header legitimately carries the whole chain as a single string.
    expect(mail.references).toEqual(['a@x.com', 'b@x.com']);
    expect(mail.html).toBeNull();
  });
});
