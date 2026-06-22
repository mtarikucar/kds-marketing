import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InvoiceTextService } from './invoice-text.service';

const WS = 'ws-1';

function makeDeps() {
  const prisma: any = {
    invoice: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    lead: { findFirst: jest.fn() },
    channel: { findFirst: jest.fn() },
  };
  const config = { get: () => 'https://app.test' };
  const adapter = { send: jest.fn() };
  const registry = { has: jest.fn().mockReturnValue(true), get: jest.fn(() => adapter), resolveConfig: jest.fn(() => ({})) };
  const quota = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) };
  return { prisma, config, registry, quota, adapter };
}

describe('InvoiceTextService', () => {
  let d: ReturnType<typeof makeDeps>;
  let svc: InvoiceTextService;

  beforeEach(() => {
    d = makeDeps();
    svc = new InvoiceTextService(d.prisma as any, d.config as any, d.registry as any, d.quota as any);
  });

  const sentInvoice = { id: 'inv1', publicToken: 'in_tok', number: 'INV-1', leadId: 'l1', status: 'SENT', total: 5000, currency: 'TRY' };

  it('404s an unknown invoice', async () => {
    d.prisma.invoice.findFirst.mockResolvedValue(null);
    await expect(svc.sendByText(WS, 'inv1', 'SMS')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a paid/void invoice', async () => {
    d.prisma.invoice.findFirst.mockResolvedValue({ ...sentInvoice, status: 'PAID' });
    await expect(svc.sendByText(WS, 'inv1', 'SMS')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when the contact has no phone', async () => {
    d.prisma.invoice.findFirst.mockResolvedValue(sentInvoice);
    d.prisma.lead.findFirst.mockResolvedValue({ phone: null, whatsapp: null });
    await expect(svc.sendByText(WS, 'inv1', 'SMS')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sends the pay link via the channel + reserves quota (no refund on success)', async () => {
    d.prisma.invoice.findFirst.mockResolvedValue(sentInvoice);
    d.prisma.lead.findFirst.mockResolvedValue({ phone: '+90555', whatsapp: null });
    d.prisma.channel.findFirst.mockResolvedValue({ id: 'ch1', type: 'SMS' });
    d.adapter.send.mockResolvedValue({ status: 'SENT', externalMessageId: 'm1' });
    const res = await svc.sendByText(WS, 'inv1', 'SMS');
    expect(res).toMatchObject({ sent: true, channel: 'SMS' });
    expect(d.quota.reserve).toHaveBeenCalledWith(WS, 'SMS');
    expect(d.quota.refund).not.toHaveBeenCalled();
    const sendArg = d.adapter.send.mock.calls[0][0];
    expect(sendArg.to).toBe('+90555');
    expect(sendArg.text).toContain('https://app.test/api/public/i/in_tok');
  });

  it('refunds the reserved quota when the adapter returns FAILED', async () => {
    d.prisma.invoice.findFirst.mockResolvedValue(sentInvoice);
    d.prisma.lead.findFirst.mockResolvedValue({ phone: '+90555' });
    d.prisma.channel.findFirst.mockResolvedValue({ id: 'ch1', type: 'SMS' });
    d.adapter.send.mockResolvedValue({ status: 'FAILED', error: 'provider down' });
    await expect(svc.sendByText(WS, 'inv1', 'SMS')).rejects.toBeInstanceOf(BadRequestException);
    expect(d.quota.refund).toHaveBeenCalledWith(WS, 'SMS');
  });
});
