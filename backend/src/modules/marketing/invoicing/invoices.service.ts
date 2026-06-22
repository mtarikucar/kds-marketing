import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { sealSecret, openSecret, isSecretBoxConfigured } from '../../../common/crypto/secret-box.helper';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { TaxRatesService } from '../tax-rates/tax-rates.service';
import { WalletService } from '../wallet/wallet.service';
import { computeMoneyTotals, PricedItem, PG_INT_MAX } from './money.util';

/**
 * End-customer invoicing. The workspace bills ITS customers; payment runs
 * through the WORKSPACE's own PSP (its Stripe key or its IBAN), sealed with the
 * AES-256-GCM box — never the platform's billing PSP. `markPaid` emits
 * invoice.paid (a workflow trigger).
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly outbox: OutboxService,
    private readonly taxRates: TaxRatesService,
    private readonly wallet: WalletService,
  ) {}

  // ---- invoices ----
  list(workspaceId: string) {
    return this.prisma.invoice.findMany({
      where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 200,
      select: { id: true, number: true, total: true, currency: true, status: true, dueDate: true, leadId: true, createdAt: true },
    });
  }
  async get(workspaceId: string, id: string) {
    const inv = await this.prisma.invoice.findFirst({ where: { id, workspaceId } });
    if (!inv) throw new NotFoundException('Invoice not found');
    return inv;
  }
  async create(
    workspaceId: string,
    dto: {
      leadId?: string;
      items: PricedItem[];
      currency?: string;
      /** Coupon discount applied after tax (minor units). */
      discount?: number;
      notes?: string;
      dueDate?: string;
      // Set by the CustomerSubscription sweep so the invoice is born already
      // stamped — the (subscriptionId, subscriptionPeriodKey) partial-unique
      // index then enforces one-invoice-per-period AT INSERT (no orphan window).
      subscriptionId?: string;
      subscriptionPeriodKey?: string;
    },
  ) {
    // Re-snapshot each line's tax rate from the workspace's TaxRate rows, then
    // compute subtotal/taxTotal/total from those trusted snapshots.
    const items = await this.taxRates.resolveItemTaxes(
      workspaceId,
      (Array.isArray(dto.items) ? dto.items : []) as PricedItem[],
    );
    const totals = computeMoneyTotals(items);
    this.assertInRange(totals.total);
    // Coupon discount is applied AFTER tax and clamped to the gross total.
    const discount = Math.max(0, Math.min(Math.round(dto.discount ?? 0), totals.total));
    return this.prisma.invoice.create({
      data: {
        workspaceId,
        leadId: dto.leadId ?? null,
        number: `INV-${randomBytes(4).toString('hex').toUpperCase()}`,
        items: items as unknown as Prisma.InputJsonValue,
        currency: (dto.currency ?? 'TRY').toUpperCase(),
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        discount,
        total: totals.total - discount,
        notes: dto.notes ?? null,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        publicToken: `in_${randomBytes(18).toString('hex')}`,
        subscriptionId: dto.subscriptionId ?? null,
        subscriptionPeriodKey: dto.subscriptionPeriodKey ?? null,
      },
    });
  }
  async update(workspaceId: string, id: string, dto: any) {
    const existing = await this.prisma.invoice.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('Invoice not found');
    if (existing.status === 'PAID') throw new BadRequestException('A paid invoice cannot be edited');
    const data: any = {};
    if (dto.notes !== undefined) data.notes = dto.notes;
    if (dto.currency !== undefined) data.currency = String(dto.currency).toUpperCase();
    if (dto.dueDate !== undefined) data.dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
    if (dto.items !== undefined) {
      const items = await this.taxRates.resolveItemTaxes(workspaceId, dto.items as PricedItem[]);
      const totals = computeMoneyTotals(items);
      this.assertInRange(totals.total);
      // Re-apply the existing coupon discount (re-clamped to the new gross) so an
      // items edit can't silently revert a discounted invoice back to full price.
      const discount = Math.max(0, Math.min(existing.discount, totals.total));
      data.items = items as unknown as Prisma.InputJsonValue;
      data.subtotal = totals.subtotal;
      data.taxTotal = totals.taxTotal;
      data.discount = discount;
      data.total = totals.total - discount;
    }
    return this.prisma.invoice.update({ where: { id: existing.id }, data });
  }
  async send(workspaceId: string, id: string) {
    const inv = await this.prisma.invoice.findFirst({ where: { id, workspaceId }, select: { id: true, status: true } });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.status === 'PAID') throw new BadRequestException('Already paid');
    await this.prisma.invoice.update({ where: { id: inv.id }, data: { status: 'SENT' } });
    const updated = await this.prisma.invoice.findFirst({ where: { id, workspaceId }, select: { publicToken: true } });
    return { payUrl: `${this.base()}/api/public/i/${updated?.publicToken}` };
  }
  async markPaid(workspaceId: string, id: string, via = 'manual') {
    const inv = await this.prisma.invoice.findFirst({ where: { id, workspaceId } });
    if (!inv) throw new NotFoundException('Invoice not found');
    return this.settle(inv, via);
  }
  /**
   * Settle an invoice fully from the contact's wallet. The wallet debit (the
   * money movement) runs FIRST and is race-safe + insufficient-guarded; only on
   * a successful debit do we mark the invoice PAID. No partial payments: the
   * balance must cover the whole total.
   */
  async payWithWallet(workspaceId: string, id: string) {
    const inv = await this.prisma.invoice.findFirst({ where: { id, workspaceId } });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.status === 'PAID') return inv;
    if (inv.status === 'VOID') throw new BadRequestException('A void invoice cannot be paid');
    if (!inv.leadId) throw new BadRequestException('Invoice has no contact wallet to charge');
    if (inv.total <= 0) throw new BadRequestException('Nothing to pay');
    const leadId = inv.leadId;
    // Claim-then-charge, ALL in ONE transaction so the debit and the settle commit
    // together (a settle failure rolls back the debit — no drained-wallet money
    // loss) and concurrent calls can't double-debit: only the request whose
    // conditional flip (unpaid → PAID) matches a row proceeds to debit.
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.invoice.updateMany({
        where: { id: inv.id, workspaceId, status: { in: ['DRAFT', 'SENT'] } },
        data: { status: 'PAID', paidAt: new Date(), paidVia: 'wallet' },
      });
      if (claimed.count === 0) {
        // A concurrent payer / retry already settled it — do NOT debit again.
        return tx.invoice.findFirst({ where: { id: inv.id, workspaceId } });
      }
      await this.wallet.debit(workspaceId, leadId, inv.total, `Invoice ${inv.number}`, {
        reason: 'DEBIT',
        invoiceId: inv.id,
        tx,
      });
      await this.outbox.append(
        {
          type: MarketingEventTypes.InvoicePaid,
          idempotencyKey: `invoice-paid:${inv.id}`,
          payload: {
            workspaceId,
            invoiceId: inv.id,
            leadId,
            total: inv.total,
            currency: inv.currency,
            via: 'wallet',
            occurredAt: new Date().toISOString(),
          },
        },
        tx as any,
      );
      return tx.invoice.findFirst({ where: { id: inv.id, workspaceId } });
    });
  }

  async voidInvoice(workspaceId: string, id: string) {
    const inv = await this.prisma.invoice.findFirst({ where: { id, workspaceId }, select: { id: true } });
    if (!inv) throw new NotFoundException('Invoice not found');
    return this.prisma.invoice.update({ where: { id: inv.id }, data: { status: 'VOID' } });
  }

  // ---- PSP config ----
  async getPspConfig(workspaceId: string) {
    const cfg = await this.prisma.workspacePspConfig.findUnique({ where: { workspaceId } });
    if (!cfg) return { provider: 'MANUAL', configPublic: null, configuredSecrets: [] as string[] };
    let keys: string[] = [];
    if (cfg.configSealed && isSecretBoxConfigured()) {
      try { keys = Object.keys(JSON.parse(openSecret(cfg.configSealed))); } catch { keys = ['(unreadable)']; }
    }
    return { provider: cfg.provider, configPublic: cfg.configPublic ?? null, configuredSecrets: keys };
  }
  async setPspConfig(workspaceId: string, dto: { provider: string; secrets?: Record<string, string>; configPublic?: Record<string, unknown> }) {
    const data: any = { provider: dto.provider, configPublic: dto.configPublic ?? undefined };
    if (dto.secrets && Object.keys(dto.secrets).length) {
      if (!isSecretBoxConfigured()) throw new ServiceUnavailableException('MARKETING_SECRET_KEY not configured');
      data.configSealed = sealSecret(JSON.stringify(dto.secrets));
    }
    await this.prisma.workspacePspConfig.upsert({
      where: { workspaceId },
      create: { workspaceId, provider: dto.provider, configSealed: data.configSealed ?? null, configPublic: data.configPublic },
      update: data,
    });
    return this.getPspConfig(workspaceId);
  }

  // ---- public pay ----
  async publicInvoice(token: string) {
    const inv = await this.prisma.invoice.findUnique({
      where: { publicToken: token },
      select: { number: true, items: true, currency: true, subtotal: true, taxTotal: true, discount: true, total: true, notes: true, status: true, dueDate: true, workspaceId: true },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    const psp = await this.prisma.workspacePspConfig.findUnique({ where: { workspaceId: inv.workspaceId }, select: { provider: true, configPublic: true } });
    const { workspaceId, ...pub } = inv;
    // Legacy invoices predate the breakdown columns (both 0) — show subtotal=total.
    const subtotal = pub.subtotal || pub.total;
    return {
      ...pub,
      subtotal,
      taxTotal: pub.taxTotal,
      taxLines: computeMoneyTotals(pub.items as unknown as PricedItem[]).taxLines,
      provider: psp?.provider ?? 'MANUAL',
      payInstructions: psp?.configPublic ?? null,
    };
  }

  async pay(token: string): Promise<{ redirectUrl?: string; manual?: unknown }> {
    const inv = await this.prisma.invoice.findUnique({ where: { publicToken: token } });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.status === 'PAID') return { manual: { alreadyPaid: true } };
    const psp = await this.prisma.workspacePspConfig.findUnique({ where: { workspaceId: inv.workspaceId } });
    if (psp?.provider === 'STRIPE') {
      const secrets = this.openPsp(psp.configSealed);
      const key = secrets.secretKey;
      if (!key) throw new ServiceUnavailableException('Stripe is not configured for this workspace');
      const stripe = new Stripe(key);
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{ price_data: { currency: inv.currency.toLowerCase(), product_data: { name: `Invoice ${inv.number}` }, unit_amount: inv.total }, quantity: 1 }],
        success_url: `${this.base()}/api/public/i/${token}/return?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${this.base()}/api/public/i/${token}`,
      });
      return { redirectUrl: session.url ?? undefined };
    }
    // MANUAL: surface the workspace's bank details for an offline transfer.
    return { manual: psp?.configPublic ?? { note: 'Contact us to arrange payment.' } };
  }

  async stripeReturn(token: string, sessionId: string): Promise<{ paid: boolean }> {
    const inv = await this.prisma.invoice.findUnique({ where: { publicToken: token } });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.status === 'PAID') return { paid: true };
    const psp = await this.prisma.workspacePspConfig.findUnique({ where: { workspaceId: inv.workspaceId } });
    const key = this.openPsp(psp?.configSealed).secretKey;
    if (!key) return { paid: false };
    const session = await new Stripe(key).checkout.sessions.retrieve(sessionId);
    if (session.payment_status === 'paid') {
      await this.settle(inv, 'stripe');
      return { paid: true };
    }
    return { paid: false };
  }

  // ---- helpers ----
  private async settle(inv: { id: string; workspaceId: string; leadId: string | null; status: string; total: number; currency: string }, via: string) {
    if (inv.status === 'PAID') return inv;
    const updated = await this.prisma.invoice.update({ where: { id: inv.id }, data: { status: 'PAID', paidAt: new Date(), paidVia: via } });
    await this.outbox.append({
      type: MarketingEventTypes.InvoicePaid,
      idempotencyKey: `invoice-paid:${inv.id}`,
      payload: { workspaceId: inv.workspaceId, invoiceId: inv.id, leadId: inv.leadId, total: inv.total, currency: inv.currency, via, occurredAt: new Date().toISOString() },
    });
    return updated;
  }
  private openPsp(sealed: string | null): Record<string, string> {
    if (!sealed || !isSecretBoxConfigured()) return {};
    try { return JSON.parse(openSecret(sealed)); } catch { return {}; }
  }
  /** Reject a total that would overflow the int4 money columns (and mis-store). */
  private assertInRange(total: number): void {
    if (total > PG_INT_MAX) {
      throw new BadRequestException('Amount exceeds the maximum supported total');
    }
  }
  private base(): string {
    return this.config.get<string>('PUBLIC_BASE_URL') ?? '';
  }
}
