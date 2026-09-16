import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DocumentEmailService } from './document-email.service';

const WS = 'ws-1';

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
    lead: { findFirst: jest.fn() },
  };
  const config = { get: jest.fn().mockReturnValue('https://app.test') };
  const mailbox = { send: jest.fn() };
  const email = {
    isConfigured: jest.fn().mockReturnValue(true),
    sendPlainEmail: jest.fn().mockResolvedValue(true),
    consumeLastPlainSendError: jest.fn().mockReturnValue(null),
  };
  const quota = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) };
  const trace = { record: jest.fn().mockResolvedValue(undefined) };
  return { prisma, config, mailbox, email, quota, trace };
}

const INVOICE = {
  id: 'inv1',
  publicToken: 'in_tok',
  number: 'INV-1042',
  leadId: 'l1',
  status: 'DRAFT',
  total: 5000,
  currency: 'TRY',
};
const ESTIMATE = {
  id: 'est1',
  publicToken: 'es_tok',
  number: 'EST-7',
  leadId: 'l1',
  status: 'DRAFT',
  total: 125050,
  currency: 'TRY',
};
const REACHABLE = { email: 'ayse@example.com', emailBouncedAt: null, emailVerifiedStatus: 'VALID' };

describe('DocumentEmailService', () => {
  let d: ReturnType<typeof makeDeps>;
  let svc: DocumentEmailService;

  beforeEach(() => {
    d = makeDeps();
    svc = new DocumentEmailService(
      d.prisma as any,
      d.config as any,
      d.mailbox as any,
      d.email as any,
      d.quota as any,
      d.trace as any,
    );
    d.prisma.invoice.findFirst.mockResolvedValue(INVOICE);
    d.prisma.estimate.findFirst.mockResolvedValue(ESTIMATE);
    d.prisma.lead.findFirst.mockResolvedValue(REACHABLE);
    d.mailbox.send.mockResolvedValue({ ok: true, messageId: 'm1' });
  });

  it('404s an unknown invoice', async () => {
    d.prisma.invoice.findFirst.mockResolvedValue(null);
    await expect(svc.sendInvoice(WS, 'inv1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to email a paid or void invoice', async () => {
    d.prisma.invoice.findFirst.mockResolvedValue({ ...INVOICE, status: 'PAID' });
    await expect(svc.sendInvoice(WS, 'inv1')).rejects.toBeInstanceOf(BadRequestException);
    d.prisma.invoice.findFirst.mockResolvedValue({ ...INVOICE, status: 'VOID' });
    await expect(svc.sendInvoice(WS, 'inv1')).rejects.toBeInstanceOf(BadRequestException);
    expect(d.mailbox.send).not.toHaveBeenCalled();
  });

  it('refuses a document with no contact behind it', async () => {
    d.prisma.invoice.findFirst.mockResolvedValue({ ...INVOICE, leadId: null });
    await expect(svc.sendInvoice(WS, 'inv1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a hard-bounced or invalid address rather than burning the sending reputation', async () => {
    d.prisma.lead.findFirst.mockResolvedValue({ ...REACHABLE, emailBouncedAt: new Date() });
    await expect(svc.sendInvoice(WS, 'inv1')).rejects.toBeInstanceOf(BadRequestException);
    d.prisma.lead.findFirst.mockResolvedValue({ ...REACHABLE, emailBouncedAt: null, emailVerifiedStatus: 'INVALID' });
    await expect(svc.sendInvoice(WS, 'inv1')).rejects.toBeInstanceOf(BadRequestException);
    expect(d.mailbox.send).not.toHaveBeenCalled();
  });

  it('refuses to mail a dead link when PUBLIC_BASE_URL is unset', async () => {
    d.config.get.mockReturnValue('');
    await expect(svc.sendInvoice(WS, 'inv1')).rejects.toBeInstanceOf(BadRequestException);
    expect(d.mailbox.send).not.toHaveBeenCalled();
    expect(d.quota.reserve).not.toHaveBeenCalled();
  });

  it('sends the pay link through the workspace mailbox and meters it once', async () => {
    const res = await svc.sendInvoice(WS, 'inv1');
    expect(res).toMatchObject({ sent: true, to: 'ayse@example.com', via: 'mailbox' });
    const arg = d.mailbox.send.mock.calls[0][0];
    expect(arg.to).toBe('ayse@example.com');
    expect(arg.subject).toContain('INV-1042');
    expect(arg.text).toContain('https://app.test/api/public/i/in_tok');
    expect(d.quota.reserve).toHaveBeenCalledWith(WS, 'EMAIL');
    expect(d.quota.refund).not.toHaveBeenCalled();
    expect(d.email.sendPlainEmail).not.toHaveBeenCalled();
  });

  it('falls through to the platform transport when the workspace has no mailbox', async () => {
    d.mailbox.send.mockResolvedValue(null);
    const res = await svc.sendInvoice(WS, 'inv1');
    expect(res).toMatchObject({ sent: true, via: 'platform' });
    const [to, subject, body] = d.email.sendPlainEmail.mock.calls[0];
    expect(to).toBe('ayse@example.com');
    expect(subject).toContain('INV-1042');
    expect(body).toContain('https://app.test/api/public/i/in_tok');
  });

  it('refuses rather than claiming a delivery the platform cannot make', async () => {
    // EmailService.sendPlainEmail returns TRUE with no transporter ([EMAIL MOCK]).
    // A caller that must not claim a delivery asks isConfigured() first.
    d.mailbox.send.mockResolvedValue(null);
    d.email.isConfigured.mockReturnValue(false);
    await expect(svc.sendInvoice(WS, 'inv1')).rejects.toBeInstanceOf(BadRequestException);
    expect(d.email.sendPlainEmail).not.toHaveBeenCalled();
    expect(d.quota.refund).toHaveBeenCalledWith(WS, 'EMAIL');
  });

  it('refunds the metered message when the mailbox send fails', async () => {
    d.mailbox.send.mockResolvedValue({ ok: false, messageId: null, error: '535 auth failed' });
    await expect(svc.sendInvoice(WS, 'inv1')).rejects.toThrow(/535 auth failed/);
    expect(d.quota.refund).toHaveBeenCalledWith(WS, 'EMAIL');
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

  it('emails a quote, flips it SENT and traces it as a quote', async () => {
    const res = await svc.sendEstimate(WS, 'est1', 'u1');
    expect(res).toMatchObject({ sent: true, via: 'mailbox' });
    expect(d.mailbox.send.mock.calls[0][0].text).toContain('https://app.test/api/public/e/es_tok');
    expect(d.prisma.estimate.updateMany).toHaveBeenCalledWith({
      where: { id: 'est1', workspaceId: WS, status: { in: ['DRAFT', 'SENT'] } },
      data: { status: 'SENT' },
    });
    expect(d.trace.record.mock.calls[0][2].title).toBe('Quote EST-7 emailed');
  });

  it('refuses to email a quote the customer already answered', async () => {
    d.prisma.estimate.findFirst.mockResolvedValue({ ...ESTIMATE, status: 'ACCEPTED' });
    await expect(svc.sendEstimate(WS, 'est1')).rejects.toBeInstanceOf(BadRequestException);
    expect(d.mailbox.send).not.toHaveBeenCalled();
  });
});
