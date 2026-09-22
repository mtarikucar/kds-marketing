import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DocumentEmailService } from './document-email.service';

const WS = 'ws-1';

function sent(over: Record<string, unknown> = {}) {
  return {
    outcome: 'SENT',
    ok: true,
    mailLogId: 'ml-1',
    messageId: 'mid-1',
    transport: 'MAILBOX_SMTP',
    retriable: false,
    ...over,
  };
}

function makeDeps() {
  const prisma: any = {
    invoice: {
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    estimate: {
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    document: { findFirst: jest.fn() },
    lead: { findFirst: jest.fn() },
    workspace: { findUnique: jest.fn() },
    workspaceMembership: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const config = { get: jest.fn().mockReturnValue('https://app.test') };
  const outbound = { send: jest.fn().mockResolvedValue(sent()) };
  const suppression = { check: jest.fn().mockResolvedValue({ suppressed: false }) };
  const trace = { record: jest.fn().mockResolvedValue(undefined) };
  return { prisma, config, outbound, suppression, trace };
}

const INVOICE = {
  id: 'inv1',
  publicToken: 'in_tok',
  number: 'INV-1042',
  leadId: 'l1',
  status: 'DRAFT',
  total: 125050,
  currency: 'TRY',
  notes: 'Ödeme 7 gün içinde yapılmalıdır.',
  dueDate: new Date('2026-10-15T00:00:00.000Z'),
};
const ESTIMATE = {
  id: 'est1',
  publicToken: 'es_tok',
  number: 'EST-7',
  leadId: 'l1',
  status: 'SENT',
  total: 50000,
  currency: 'TRY',
  notes: null,
  validUntil: null,
};
const DOCUMENT = {
  id: 'doc1',
  workspaceId: WS,
  publicToken: 'esign_tok',
  title: 'Hizmet Sözleşmesi',
  status: 'SENT',
  leadId: 'l1',
  signerEmail: null,
};
const REACHABLE = {
  id: 'l1',
  email: 'ayse@example.com',
  contactPerson: 'Ayşe Yılmaz',
  emailBouncedAt: null,
  emailVerifiedStatus: 'VALID',
};

describe('DocumentEmailService', () => {
  let d: ReturnType<typeof makeDeps>;
  let svc: DocumentEmailService;

  beforeEach(() => {
    d = makeDeps();
    svc = new DocumentEmailService(
      d.prisma as any,
      d.config as any,
      d.outbound as any,
      d.suppression as any,
      d.trace as any,
    );
    d.prisma.invoice.findFirst.mockResolvedValue(INVOICE);
    d.prisma.estimate.findFirst.mockResolvedValue(ESTIMATE);
    d.prisma.document.findFirst.mockResolvedValue(DOCUMENT);
    d.prisma.lead.findFirst.mockResolvedValue(REACHABLE);
    d.prisma.workspace.findUnique.mockResolvedValue({
      name: 'Kahve Dünyası',
      defaultLanguage: 'tr',
      settings: {},
    });
  });

  const lastMail = () => d.outbound.send.mock.calls[d.outbound.send.mock.calls.length - 1][0];

  describe('sendInvoice', () => {
    it('404s an unknown invoice', async () => {
      d.prisma.invoice.findFirst.mockResolvedValue(null);
      await expect(svc.sendInvoice(WS, 'inv1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to email a paid or void invoice', async () => {
      d.prisma.invoice.findFirst.mockResolvedValue({ ...INVOICE, status: 'PAID' });
      await expect(svc.sendInvoice(WS, 'inv1')).rejects.toBeInstanceOf(BadRequestException);
      d.prisma.invoice.findFirst.mockResolvedValue({ ...INVOICE, status: 'VOID' });
      await expect(svc.sendInvoice(WS, 'inv1')).rejects.toBeInstanceOf(BadRequestException);
      expect(d.outbound.send).not.toHaveBeenCalled();
    });

    it('refuses a document with no contact behind it', async () => {
      d.prisma.invoice.findFirst.mockResolvedValue({ ...INVOICE, leadId: null });
      await expect(svc.sendInvoice(WS, 'inv1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a hard-bounced or invalid address rather than burning the sending reputation', async () => {
      d.prisma.lead.findFirst.mockResolvedValue({ ...REACHABLE, emailBouncedAt: new Date() });
      await expect(svc.sendInvoice(WS, 'inv1')).rejects.toBeInstanceOf(BadRequestException);
      d.prisma.lead.findFirst.mockResolvedValue({
        ...REACHABLE,
        emailBouncedAt: null,
        emailVerifiedStatus: 'INVALID',
      });
      await expect(svc.sendInvoice(WS, 'inv1')).rejects.toBeInstanceOf(BadRequestException);
      expect(d.outbound.send).not.toHaveBeenCalled();
    });

    // The whole point of the TRANSACTIONAL class: unticking marketing mail is
    // not a refusal of the invoice for something the customer bought.
    it('still delivers the invoice to a customer who opted out of marketing mail', async () => {
      const res = await svc.sendInvoice(WS, 'inv1');
      expect(d.suppression.check).toHaveBeenCalledWith(
        WS,
        'ayse@example.com',
        'TRANSACTIONAL',
        expect.anything(),
      );
      expect(res).toMatchObject({ sent: true });
    });

    // In words, never as `mail.reason.SUPPRESSED_ERASURE`: the two vocabularies
    // differ by a letter and a hand-built key would print the key at a user.
    it('refuses an address the suppression ledger holds an erasure for', async () => {
      d.suppression.check.mockResolvedValue({ suppressed: true, reason: 'ERASURE' });
      await expect(svc.sendInvoice(WS, 'inv1')).rejects.toThrow(/silinmesini/i);
      await expect(svc.sendInvoice(WS, 'inv1')).rejects.not.toThrow(/mail\.reason/);
      expect(d.outbound.send).not.toHaveBeenCalled();
    });

    it('refuses to mail a dead link when PUBLIC_BASE_URL is unset — before anything is metered', async () => {
      d.config.get.mockReturnValue('');
      await expect(svc.sendInvoice(WS, 'inv1')).rejects.toBeInstanceOf(BadRequestException);
      expect(d.outbound.send).not.toHaveBeenCalled();
    });

    // `document-email-bare`: the mail used to be an English subject and a bare
    // link, which reads like invoice phishing from a brand the customer has
    // never heard of.
    it('names the business, the amount and the due date, in the workspace language', async () => {
      await svc.sendInvoice(WS, 'inv1');
      const mail = lastMail();
      expect(mail.mailClass).toBe('TRANSACTIONAL');
      expect(mail.to).toBe('ayse@example.com');
      expect(mail.leadId).toBe('l1');
      expect(mail.lang).toBe('tr');
      expect(mail.source).toBe('invoice:inv1');
      // Subject: brand + number, in Turkish.
      expect(mail.subject).toContain('Kahve Dünyası');
      expect(mail.subject).toContain('INV-1042');
      expect(mail.subject).toMatch(/fatura/i);
      // Body: who, how much, by when, the tenant's own note, and the link.
      expect(mail.text).toContain('Ayşe Yılmaz');
      expect(mail.text).toContain('1.250,50 TRY');
      expect(mail.text).toContain('15.10.2026');
      expect(mail.text).toContain('Ödeme 7 gün içinde yapılmalıdır.');
      expect(mail.text).toContain('https://app.test/api/public/i/in_tok');
      expect(mail.html).toContain('1.250,50 TRY');
      expect(mail.html).toContain('href="https://app.test/api/public/i/in_tok"');
    });

    it('escapes tenant-authored text in the HTML part', async () => {
      d.prisma.workspace.findUnique.mockResolvedValue({
        name: '<script>alert(1)</script>',
        defaultLanguage: 'en',
        settings: {},
      });
      await svc.sendInvoice(WS, 'inv1');
      expect(lastMail().html).not.toContain('<script>');
      expect(lastMail().html).toContain('&lt;script&gt;');
    });

    it('prefers the configured sending name over the raw workspace name', async () => {
      d.prisma.workspace.findUnique.mockResolvedValue({
        name: 'Legal Entity Ltd',
        defaultLanguage: 'en',
        settings: { emailFromName: 'Kahve Dünyası' },
      });
      await svc.sendInvoice(WS, 'inv1');
      expect(lastMail().subject).toContain('Kahve Dünyası');
    });

    it('is NOT deduped — a rep may legitimately send the same invoice twice', async () => {
      await svc.sendInvoice(WS, 'inv1');
      expect(lastMail().idempotencyKey).toBeUndefined();
    });

    it('reports the transport the gateway actually used', async () => {
      d.outbound.send.mockResolvedValue(sent({ transport: 'PLATFORM' }));
      await expect(svc.sendInvoice(WS, 'inv1')).resolves.toMatchObject({ via: 'platform' });
      d.outbound.send.mockResolvedValue(sent({ transport: 'MAILBOX_OAUTH' }));
      await expect(svc.sendInvoice(WS, 'inv1')).resolves.toMatchObject({ via: 'mailbox' });
    });

    // A refusal is not an exception inside the gateway (G2), but this caller is
    // a button a human just pressed: it has always answered with an error, and
    // the error now says why in words rather than in a machine code.
    it('turns a gateway refusal into a readable error and leaves the status alone', async () => {
      d.outbound.send.mockResolvedValue({
        outcome: 'REFUSED',
        ok: false,
        mailLogId: 'ml-2',
        messageId: null,
        transport: 'NONE',
        reason: 'QUOTA_EXHAUSTED',
        userMessage: { key: 'mail.reason.QUOTA_EXHAUSTED' },
        retriable: false,
      });
      await expect(svc.sendInvoice(WS, 'inv1')).rejects.toThrow(/kota/i);
      expect(d.prisma.invoice.updateMany).not.toHaveBeenCalled();
      expect(d.trace.record).not.toHaveBeenCalled();
    });

    it('surfaces the provider’s own words when the send failed', async () => {
      d.outbound.send.mockResolvedValue({
        outcome: 'FAILED_TRANSIENT',
        ok: false,
        mailLogId: 'ml-3',
        messageId: null,
        transport: 'MAILBOX_SMTP',
        reason: 'TRANSIENT',
        error: '451 4.3.0 try again later',
        retriable: true,
      });
      await expect(svc.sendInvoice(WS, 'inv1')).rejects.toThrow(/451 4\.3\.0 try again later/);
      expect(d.prisma.invoice.updateMany).not.toHaveBeenCalled();
    });

    it('flips DRAFT to SENT with a CONDITIONAL claim so a mid-send payment is never resurrected', async () => {
      await svc.sendInvoice(WS, 'inv1');
      expect(d.prisma.invoice.updateMany).toHaveBeenCalledWith({
        where: { id: 'inv1', workspaceId: WS, status: 'DRAFT' },
        data: { status: 'SENT' },
      });
      expect(d.prisma.invoice.update).not.toHaveBeenCalled();
    });

    it('leaves the send on the person, naming the transport that carried it', async () => {
      await svc.sendInvoice(WS, 'inv1', 'u1');
      const [ws, leadId, row, opts] = d.trace.record.mock.calls[0];
      expect(ws).toBe(WS);
      expect(leadId).toBe('l1');
      expect(row.title).toBe('Invoice INV-1042 emailed');
      expect((row.metadata as any).event).toBe('invoice_sent');
      expect((row.metadata as any).via).toBe('mailbox');
      expect(opts).toEqual({ actorId: 'u1' });
    });
  });

  describe('sendEstimate', () => {
    it('emails a quote, flips it SENT and traces it as a quote', async () => {
      const res = await svc.sendEstimate(WS, 'est1', 'u1');
      expect(res).toMatchObject({ sent: true, via: 'mailbox' });
      expect(lastMail().text).toContain('https://app.test/api/public/e/es_tok');
      expect(lastMail().text).toContain('500,00 TRY');
      expect(lastMail().source).toBe('estimate:est1');
      expect(d.prisma.estimate.updateMany).toHaveBeenCalledWith({
        where: { id: 'est1', workspaceId: WS, status: { in: ['DRAFT', 'SENT'] } },
        data: { status: 'SENT' },
      });
      expect(d.trace.record.mock.calls[0][2].title).toBe('Quote EST-7 emailed');
    });

    it('refuses to email a quote the customer already answered', async () => {
      d.prisma.estimate.findFirst.mockResolvedValue({ ...ESTIMATE, status: 'ACCEPTED' });
      await expect(svc.sendEstimate(WS, 'est1')).rejects.toBeInstanceOf(BadRequestException);
      expect(d.outbound.send).not.toHaveBeenCalled();
    });

    // `expired-quote-emailed`: the customer opens it, presses Accept and is
    // told "expired". The refusal names the day and the real recourse — the
    // quote cannot be edited once it is SENT, so "extend it" is not advice a
    // user can follow.
    it('refuses to email an expired quote, before anything is metered', async () => {
      d.prisma.estimate.findFirst.mockResolvedValue({
        ...ESTIMATE,
        validUntil: new Date('2020-05-04T00:00:00.000Z'),
      });
      await expect(svc.sendEstimate(WS, 'est1')).rejects.toThrow(/2020-05-04/);
      await expect(svc.sendEstimate(WS, 'est1')).rejects.toThrow(/new quote/i);
      expect(d.outbound.send).not.toHaveBeenCalled();
      expect(d.prisma.estimate.updateMany).not.toHaveBeenCalled();
    });

    it('still emails a quote on the last day it is valid', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-30T21:00:00.000Z'));
      try {
        d.prisma.estimate.findFirst.mockResolvedValue({
          ...ESTIMATE,
          validUntil: new Date('2026-09-30T00:00:00.000Z'),
        });
        await expect(svc.sendEstimate(WS, 'est1')).resolves.toMatchObject({ sent: true });
        expect(lastMail().text).toContain('30.09.2026');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('sendPaymentReceipt', () => {
    const PAID = {
      ...INVOICE,
      status: 'PAID',
      paidAt: new Date('2026-10-01T09:00:00.000Z'),
      paidVia: 'WALLET',
    };

    beforeEach(() => d.prisma.invoice.findFirst.mockResolvedValue(PAID));

    it('thanks the payer by name and says what was paid', async () => {
      const res = await svc.sendPaymentReceipt(WS, 'inv1');
      expect(res).toMatchObject({ sent: true, to: 'ayse@example.com' });
      const mail = lastMail();
      expect(mail.mailClass).toBe('TRANSACTIONAL');
      expect(mail.subject).toContain('INV-1042');
      expect(mail.text).toContain('1.250,50 TRY');
      expect(mail.source).toBe('invoice:inv1:receipt');
    });

    // The consumer's in-memory `seenEventIds` Set is empty after a restart, and
    // the outbox reclaims stale rows precisely then. A trace line written twice
    // is invisible; a receipt emailed twice is not — so the dedupe is the
    // gateway's durable ledger key, not the process's memory.
    it('carries a durable idempotency key so one payment mails one receipt', async () => {
      await svc.sendPaymentReceipt(WS, 'inv1');
      expect(lastMail().idempotencyKey).toBe('invoice:inv1:receipt');
    });

    it('reports a DEDUPED second attempt as not-sent rather than as a new receipt', async () => {
      d.outbound.send.mockResolvedValue(sent({ outcome: 'DEDUPED' }));
      await expect(svc.sendPaymentReceipt(WS, 'inv1')).resolves.toMatchObject({
        sent: false,
        deduped: true,
      });
    });

    // Every one of these is a NORMAL outcome on a payment path, not an error:
    // the money already moved.
    it('quietly skips an invoice with no contact, an unreachable address or a refusal', async () => {
      d.prisma.invoice.findFirst.mockResolvedValue({ ...PAID, leadId: null });
      await expect(svc.sendPaymentReceipt(WS, 'inv1')).resolves.toMatchObject({
        sent: false,
        skipped: 'no-contact',
      });
      expect(d.outbound.send).not.toHaveBeenCalled();

      d.prisma.invoice.findFirst.mockResolvedValue(PAID);
      d.prisma.lead.findFirst.mockResolvedValue({ ...REACHABLE, emailBouncedAt: new Date() });
      await expect(svc.sendPaymentReceipt(WS, 'inv1')).resolves.toMatchObject({
        sent: false,
        skipped: 'unreachable',
      });
      expect(d.outbound.send).not.toHaveBeenCalled();

      d.prisma.lead.findFirst.mockResolvedValue(REACHABLE);
      d.outbound.send.mockResolvedValue({
        outcome: 'FAILED_PERMANENT',
        ok: false,
        mailLogId: 'ml-9',
        messageId: null,
        transport: 'NONE',
        reason: 'NOT_CONFIGURED',
        retriable: false,
      });
      await expect(svc.sendPaymentReceipt(WS, 'inv1')).resolves.toMatchObject({
        sent: false,
        reason: 'NOT_CONFIGURED',
      });
    });

    it('never throws, whatever the database does', async () => {
      d.prisma.invoice.findFirst.mockRejectedValue(new Error('db down'));
      await expect(svc.sendPaymentReceipt(WS, 'inv1')).resolves.toMatchObject({ sent: false });
    });
  });

  describe('sendAgreement', () => {
    it('emails the signing link for a document that has one', async () => {
      const res = await svc.sendAgreement(WS, 'doc1');
      expect(res).toMatchObject({ sent: true, to: 'ayse@example.com' });
      const mail = lastMail();
      expect(mail.mailClass).toBe('TRANSACTIONAL');
      expect(mail.subject).toContain('Hizmet Sözleşmesi');
      expect(mail.text).toContain('https://app.test/api/public/d/esign_tok');
      expect(mail.source).toBe('document:doc1');
    });

    it('404s an unknown document and refuses one that was never sent', async () => {
      d.prisma.document.findFirst.mockResolvedValue(null);
      await expect(svc.sendAgreement(WS, 'doc1')).rejects.toBeInstanceOf(NotFoundException);
      d.prisma.document.findFirst.mockResolvedValue({ ...DOCUMENT, status: 'DRAFT', publicToken: null });
      await expect(svc.sendAgreement(WS, 'doc1')).rejects.toBeInstanceOf(BadRequestException);
      expect(d.outbound.send).not.toHaveBeenCalled();
    });

    it('refuses a signed or voided document', async () => {
      d.prisma.document.findFirst.mockResolvedValue({ ...DOCUMENT, status: 'SIGNED' });
      await expect(svc.sendAgreement(WS, 'doc1')).rejects.toBeInstanceOf(BadRequestException);
      d.prisma.document.findFirst.mockResolvedValue({ ...DOCUMENT, status: 'VOIDED' });
      await expect(svc.sendAgreement(WS, 'doc1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('sendSignedCopy', () => {
    const SIGNED = { ...DOCUMENT, status: 'SIGNED', signerEmail: 'imza@example.com' };

    beforeEach(() => {
      d.prisma.document.findFirst.mockResolvedValue(SIGNED);
      d.prisma.workspaceMembership.findFirst.mockResolvedValue({
        user: { email: 'patron@kahve.test' },
      });
    });

    it('sends the signer their copy and tells the workspace, on the INTERNAL lane', async () => {
      await svc.sendSignedCopy(WS, 'doc1');
      const [signer, owner] = d.outbound.send.mock.calls.map((c: any[]) => c[0]);
      expect(signer).toMatchObject({
        to: 'imza@example.com',
        mailClass: 'TRANSACTIONAL',
        idempotencyKey: 'document:doc1:signed',
      });
      expect(signer.text).toContain('https://app.test/api/public/d/esign_tok');
      // The owner is one of OUR users: no tenant Reply-To, no metering, no
      // suppression tombstone from the tenant's own list.
      expect(owner).toMatchObject({
        to: 'patron@kahve.test',
        mailClass: 'INTERNAL',
        idempotencyKey: 'document:doc1:signed-owner',
      });
      expect(owner.leadId ?? null).toBeNull();
    });

    it('falls back to the contact address when the signer typed none', async () => {
      d.prisma.document.findFirst.mockResolvedValue({ ...SIGNED, signerEmail: null });
      await svc.sendSignedCopy(WS, 'doc1');
      expect(d.outbound.send.mock.calls[0][0].to).toBe('ayse@example.com');
    });

    // It runs on the public signing endpoint, after the signature is already a
    // legal fact. Nothing here may turn into "Could not sign. Please try again."
    it('never throws, and still tells the workspace when the signer copy fails', async () => {
      d.outbound.send
        .mockRejectedValueOnce(new Error('smtp exploded'))
        .mockResolvedValueOnce(sent());
      await expect(svc.sendSignedCopy(WS, 'doc1')).resolves.toBeUndefined();
      expect(d.outbound.send).toHaveBeenCalledTimes(2);
    });

    it('does nothing for a document that is not signed', async () => {
      d.prisma.document.findFirst.mockResolvedValue({ ...SIGNED, status: 'SENT' });
      await svc.sendSignedCopy(WS, 'doc1');
      expect(d.outbound.send).not.toHaveBeenCalled();
    });
  });
});
