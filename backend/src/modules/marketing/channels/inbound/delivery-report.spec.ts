import { parseContentType, rawMail } from './inbound-mail.types';
import { parseDeliveryReport, suppressibleRecipients } from './delivery-report';

const dsn = (text: string, extra: Record<string, unknown> = {}) =>
  rawMail({
    source: 'imap',
    itemKey: '1:2',
    contentType: parseContentType('multipart/report; report-type=delivery-status; boundary=x'),
    reportParts: [{ contentType: 'message/delivery-status', text }],
    ...extra,
  });

describe('parseDeliveryReport — RFC 3464, one field block per recipient', () => {
  it('reads a single hard bounce', () => {
    const report = parseDeliveryReport(
      dsn(
        [
          'Reporting-MTA: dns; mx.acme.com',
          '',
          'Final-Recipient: rfc822; Yok@Musteri.com.tr',
          'Action: failed',
          'Status: 5.1.1',
          'Diagnostic-Code: smtp; 550 5.1.1 <yok@musteri.com.tr>: Recipient address rejected',
          '',
        ].join('\r\n'),
      ),
    );
    expect(report.kind).toBe('DSN');
    expect(report.recipients).toEqual([
      {
        recipient: 'yok@musteri.com.tr',
        outcome: 'HARD_BOUNCE',
        status: '5.1.1',
        action: 'failed',
        diagnostic: 'smtp; 550 5.1.1 <yok@musteri.com.tr>: Recipient address rejected',
      },
    ]);
  });

  it('never suppresses on a 4.x.x — that is a full mailbox or greylisting', () => {
    const report = parseDeliveryReport(
      dsn(['Final-Recipient: rfc822; dolu@musteri.com.tr', 'Action: delayed', 'Status: 4.2.2'].join('\n')),
    );
    expect(report.recipients[0].outcome).toBe('SOFT_BOUNCE');
    expect(suppressibleRecipients(report)).toEqual([]);
  });

  it('suppresses ONLY the 5.x.x rows of a mixed multi-recipient report', () => {
    const report = parseDeliveryReport(
      dsn(
        [
          'Reporting-MTA: dns; mx.acme.com',
          '',
          'Final-Recipient: rfc822; dolu@musteri.com.tr',
          'Action: delayed',
          'Status: 4.2.2',
          '',
          'Final-Recipient: rfc822; yok@musteri.com.tr',
          'Action: failed',
          'Status: 5.1.1',
          '',
          'Final-Recipient: rfc822; tamam@musteri.com.tr',
          'Action: delivered',
          'Status: 2.0.0',
          '',
        ].join('\r\n'),
      ),
    );
    expect(report.recipients.map((r) => [r.recipient, r.outcome])).toEqual([
      ['dolu@musteri.com.tr', 'SOFT_BOUNCE'],
      ['yok@musteri.com.tr', 'HARD_BOUNCE'],
      ['tamam@musteri.com.tr', 'DELIVERED'],
    ]);
    expect(suppressibleRecipients(report)).toEqual([
      { address: 'yok@musteri.com.tr', reason: 'HARD_BOUNCE', status: '5.1.1', diagnostic: null },
    ]);
  });

  it('prefers Original-Recipient when the final one was rewritten by an alias', () => {
    const report = parseDeliveryReport(
      dsn(
        [
          'Original-Recipient: rfc822;musteri@acme.com',
          'Final-Recipient: rfc822; forwarded@mailbox.internal',
          'Action: failed',
          'Status: 5.1.1',
        ].join('\n'),
      ),
    );
    expect(report.recipients[0].recipient).toBe('musteri@acme.com');
  });

  it('unfolds a Diagnostic-Code that the server wrapped over two lines', () => {
    const report = parseDeliveryReport(
      dsn(
        [
          'Final-Recipient: rfc822; yok@musteri.com.tr',
          'Status: 5.1.1',
          'Diagnostic-Code: smtp; 550 5.1.1 user unknown;',
          '  please check the address and try again',
        ].join('\n'),
      ),
    );
    expect(report.recipients[0].diagnostic).toBe(
      'smtp; 550 5.1.1 user unknown; please check the address and try again',
    );
  });

  it('falls back to the enhanced code inside the diagnostic when Status is missing', () => {
    const report = parseDeliveryReport(
      dsn(
        [
          'Final-Recipient: rfc822; yok@musteri.com.tr',
          'Action: failed',
          'Diagnostic-Code: smtp; 550 5.1.1 Recipient address rejected',
        ].join('\n'),
      ),
    );
    expect(report.recipients[0].outcome).toBe('HARD_BOUNCE');
    expect(report.recipients[0].status).toBe('5.1.1');
  });

  it('reads the bare SMTP reply code at the head of the diagnostic', () => {
    const report = parseDeliveryReport(
      dsn(
        [
          'Final-Recipient: rfc822; yok@musteri.com.tr',
          'Action: failed',
          'Diagnostic-Code: smtp; 550 Requested action not taken',
        ].join('\n'),
      ),
    );
    expect(report.recipients[0]).toMatchObject({ outcome: 'HARD_BOUNCE', status: '5.0.0' });
  });

  it('does not read a three-digit number out of the middle of a sentence', () => {
    // "over its 500 MB quota" is not a permanent failure, and suppressing on it
    // would silently stop mail to a live customer.
    const report = parseDeliveryReport(
      dsn(
        [
          'Final-Recipient: rfc822; dolu@musteri.com.tr',
          'Action: failed',
          'Diagnostic-Code: smtp; mailbox is over its 500 MB quota',
        ].join('\n'),
      ),
    );
    expect(report.recipients[0].outcome).toBe('UNKNOWN');
    expect(suppressibleRecipients(report)).toEqual([]);
  });

  it('refuses to guess when neither a status nor a reply code is present', () => {
    const report = parseDeliveryReport(
      dsn(['Final-Recipient: rfc822; belirsiz@musteri.com.tr', 'Action: failed'].join('\n')),
    );
    expect(report.recipients[0].outcome).toBe('UNKNOWN');
    expect(suppressibleRecipients(report)).toEqual([]);
  });

  it('reads the report out of the smeared body text when no part was kept', () => {
    // mailparser folds message/delivery-status into `text` under default
    // options; the poller must not be forced to re-parse just to see it.
    const report = parseDeliveryReport(
      rawMail({
        source: 'imap',
        itemKey: '1:2',
        contentType: parseContentType('multipart/report; report-type=delivery-status'),
        text: [
          'This is the mail system at host mx.acme.com.',
          '',
          'Final-Recipient: rfc822; yok@musteri.com.tr',
          'Action: failed',
          'Status: 5.1.1',
          '',
        ].join('\n'),
      }),
    );
    expect(report.recipients.map((r) => r.recipient)).toEqual(['yok@musteri.com.tr']);
  });

  it('falls back to X-Failed-Recipients for the NDRs that carry no report part', () => {
    const report = parseDeliveryReport(
      rawMail({
        source: 'imap',
        itemKey: '1:2',
        headerLines: [
          { key: 'x-failed-recipients', line: 'X-Failed-Recipients: yok@musteri.com.tr, dolu@musteri.com.tr' },
        ],
        text: 'The following message to <yok@musteri.com.tr> was undeliverable.\n550 5.1.1 unknown',
      }),
    );
    expect(report.kind).toBe('DSN');
    expect(report.recipients.map((r) => r.recipient)).toEqual(['yok@musteri.com.tr', 'dolu@musteri.com.tr']);
    expect(report.recipients.every((r) => r.outcome === 'HARD_BOUNCE')).toBe(true);
  });
});

describe('parseDeliveryReport — attributing the report to the mail we sent', () => {
  it('reads Original-Message-ID from the per-message block', () => {
    const report = parseDeliveryReport(
      dsn(
        [
          'Reporting-MTA: dns; mx.acme.com',
          'Original-Message-ID: <camp-1.rcpt-9@Jeetagrowth.COM>',
          '',
          'Final-Recipient: rfc822; yok@musteri.com.tr',
          'Status: 5.1.1',
        ].join('\n'),
      ),
    );
    expect(report.originalMessageId).toBe('camp-1.rcpt-9@jeetagrowth.com');
  });

  it('falls back to the Message-ID inside the returned rfc822 headers', () => {
    const report = parseDeliveryReport(
      dsn(['Final-Recipient: rfc822; yok@musteri.com.tr', 'Status: 5.1.1'].join('\n'), {
        reportParts: [
          { contentType: 'message/delivery-status', text: 'Final-Recipient: rfc822; yok@musteri.com.tr\nStatus: 5.1.1' },
          {
            contentType: 'message/rfc822-headers',
            text: ['From: admin@jeetagrowth.com', 'Message-ID: <camp-1.rcpt-9@jeetagrowth.com>', 'Subject: Teklif'].join(
              '\n',
            ),
          },
        ],
      }),
    );
    expect(report.originalMessageId).toBe('camp-1.rcpt-9@jeetagrowth.com');
  });

  it('accepts a miss — address-level suppression is what stops future sends', () => {
    const report = parseDeliveryReport(dsn('Final-Recipient: rfc822; yok@musteri.com.tr\nStatus: 5.1.1'));
    expect(report.originalMessageId).toBeNull();
    expect(suppressibleRecipients(report)).toHaveLength(1);
  });
});

describe('parseDeliveryReport — ARF', () => {
  it('reports an abuse complaint as a COMPLAINT, never a hard bounce', () => {
    // Stamping emailBouncedAt for a spam complaint is what blocked another
    // tenant's INVOICES (`esp-complaint-crosstenant`).
    const report = parseDeliveryReport(
      rawMail({
        source: 'imap',
        itemKey: '1:2',
        contentType: parseContentType('multipart/report; report-type=feedback-report'),
        reportParts: [
          {
            contentType: 'message/feedback-report',
            text: [
              'Feedback-Type: abuse',
              'User-Agent: SomeISP/1.0',
              'Version: 1',
              'Original-Mail-From: admin@jeetagrowth.com',
              'Original-Rcpt-To: sikayetci@musteri.com.tr',
            ].join('\n'),
          },
        ],
      }),
    );
    expect(report.kind).toBe('ARF');
    expect(report.recipients[0]).toMatchObject({ recipient: 'sikayetci@musteri.com.tr', outcome: 'COMPLAINT' });
    expect(suppressibleRecipients(report)).toEqual([
      { address: 'sikayetci@musteri.com.tr', reason: 'COMPLAINT', status: null, diagnostic: null },
    ]);
  });

  it('never suppresses on Feedback-Type: not-spam', () => {
    const report = parseDeliveryReport(
      rawMail({
        source: 'imap',
        itemKey: '1:2',
        contentType: parseContentType('multipart/report; report-type=feedback-report'),
        reportParts: [
          {
            contentType: 'message/feedback-report',
            text: 'Feedback-Type: not-spam\nOriginal-Rcpt-To: kisi@musteri.com.tr',
          },
        ],
      }),
    );
    expect(suppressibleRecipients(report)).toEqual([]);
  });
});

describe('parseDeliveryReport — MDN', () => {
  it('reads a read receipt as a read receipt and suppresses nothing', () => {
    const report = parseDeliveryReport(
      rawMail({
        source: 'imap',
        itemKey: '1:2',
        contentType: parseContentType('multipart/report; report-type=disposition-notification'),
        reportParts: [
          {
            contentType: 'message/disposition-notification',
            text: [
              'Reporting-UA: outlook.office.com; Microsoft Outlook',
              'Final-Recipient: rfc822; patron@musteri.com.tr',
              'Original-Message-ID: <camp-1.rcpt-9@jeetagrowth.com>',
              'Disposition: automatic-action/MDN-sent-automatically; displayed',
            ].join('\n'),
          },
        ],
      }),
    );
    expect(report.kind).toBe('MDN');
    expect(report.recipients[0]).toMatchObject({ recipient: 'patron@musteri.com.tr', outcome: 'READ_RECEIPT' });
    expect(report.originalMessageId).toBe('camp-1.rcpt-9@jeetagrowth.com');
    expect(suppressibleRecipients(report)).toEqual([]);
  });
});

describe('parseDeliveryReport — nothing to read', () => {
  it('answers NONE for an ordinary customer reply', () => {
    const report = parseDeliveryReport(
      rawMail({ source: 'imap', itemKey: '1:2', text: 'Merhaba, fiyat listesi gönderebilir misiniz?' }),
    );
    expect(report).toEqual({ kind: 'NONE', originalMessageId: null, recipients: [] });
    expect(suppressibleRecipients(report)).toEqual([]);
  });

  it('never returns a recipient that is not a deliverable address', () => {
    const report = parseDeliveryReport(dsn('Final-Recipient: rfc822; <unknown>\nStatus: 5.1.1'));
    expect(report.recipients).toEqual([]);
  });

  it('de-duplicates an address a report names twice', () => {
    const report = parseDeliveryReport(
      dsn(
        [
          'Final-Recipient: rfc822; yok@musteri.com.tr',
          'Status: 5.1.1',
          '',
          'Final-Recipient: rfc822; Yok@Musteri.com.tr',
          'Status: 5.2.1',
        ].join('\n'),
      ),
    );
    expect(suppressibleRecipients(report)).toHaveLength(1);
  });
});
