import {
  Injectable,
  Logger,
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
import {
  PAYTR_DEFAULT_BASE_URL,
  buildIframeTokenSignature,
  encodeUserBasket,
  verifyCallbackHash,
} from '../../billing/payments/paytr.provider';

/**
 * End-customer invoicing. The workspace bills ITS customers; payment runs
 * through the WORKSPACE's own PSP (its Stripe key or its IBAN), sealed with the
 * AES-256-GCM box — never the platform's billing PSP. `markPaid` emits
 * invoice.paid (a workflow trigger).
 */
@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);
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

  async pay(token: string, buyerIp = '0.0.0.0'): Promise<{ redirectUrl?: string; manual?: unknown }> {
    const inv = await this.prisma.invoice.findUnique({ where: { publicToken: token } });
    if (!inv) throw new NotFoundException('Invoice not found');
    if (inv.status === 'PAID') return { manual: { alreadyPaid: true } };
    // A cancelled invoice is never payable through ANY provider — refuse before we
    // ever mint a Stripe session / PayTR token for an order that can't settle.
    if (inv.status === 'VOID') return { manual: { voided: true } };
    const psp = await this.prisma.workspacePspConfig.findUnique({ where: { workspaceId: inv.workspaceId } });
    // PayTR (Epic 13, inert until a workspace stores PayTR merchant creds). TRY
    // only — PayTR's "199$ collected as 199TL" footgun is avoided by refusing a
    // non-TRY invoice. Reuses the battle-tested billing PayTR crypto helpers; the
    // per-ws merchant creds come from the sealed PSP config (never the platform env).
    if (psp?.provider === 'PAYTR') {
      const redirectUrl = await this.payViaPaytr(inv, psp.configSealed, buyerIp);
      return { redirectUrl };
    }
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

  // ---- PayTR (Epic 13, inert) ----

  /** PayTR merchant_oid for an invoice — alphanumeric (PayTR rejects dashes). */
  private static invoiceOid(invoiceId: string): string {
    return `INV${invoiceId.replace(/-/g, '')}`;
  }
  /** Reverse the OID back to the invoice uuid (deterministic dash positions). */
  private static oidToInvoiceId(oid: string): string | null {
    if (!oid?.startsWith('INV')) return null;
    const h = oid.slice(3);
    if (!/^[0-9a-f]{32}$/i.test(h)) return null;
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  /** Build a PayTR get-token request and return the hosted-iframe redirect URL. */
  private async payViaPaytr(
    inv: { id: string; workspaceId: string; leadId: string | null; total: number; currency: string; number: string; publicToken: string },
    configSealed: string | null,
    buyerIp: string,
  ): Promise<string> {
    if (inv.currency !== 'TRY') {
      throw new BadRequestException('PayTR collects TRY only — this invoice is in ' + inv.currency);
    }
    const secrets = this.openPsp(configSealed);
    const merchantId = secrets.merchantId;
    const merchantKey = secrets.merchantKey;
    const merchantSalt = secrets.merchantSalt;
    if (!merchantId || !merchantKey || !merchantSalt) {
      throw new ServiceUnavailableException('PayTR is not configured for this workspace');
    }
    const lead = inv.leadId
      ? await this.prisma.lead.findFirst({ where: { id: inv.leadId, workspaceId: inv.workspaceId }, select: { email: true, contactPerson: true, phone: true } })
      : null;
    const email = lead?.email || 'noreply@example.com';
    const testMode = (this.config.get<string>('PAYTR_TEST_MODE') === '0') ? '0' : '1';
    const paymentAmount = String(inv.total); // already minor units (kuruş)
    const userBasketBase64 = encodeUserBasket([[`Invoice ${inv.number}`, (inv.total / 100).toFixed(2), 1]]);
    const merchantOid = InvoicesService.invoiceOid(inv.id);
    const paytrToken = buildIframeTokenSignature(
      { merchantId, userIp: buyerIp, merchantOid, email, paymentAmount, userBasketBase64, noInstallment: '0', maxInstallment: '0', currency: 'TL', testMode },
      { merchantKey, merchantSalt },
    );
    const returnUrl = `${this.base()}/api/public/i/${inv.publicToken}`; // public pay page (renders "✓ Paid" once settled); inv.id would 404 (route looks up by token)
    const form = new URLSearchParams({
      merchant_id: merchantId, user_ip: buyerIp, merchant_oid: merchantOid, email,
      payment_amount: paymentAmount, paytr_token: paytrToken, user_basket: userBasketBase64,
      debug_on: testMode === '1' ? '1' : '0', no_installment: '0', max_installment: '0',
      user_name: lead?.contactPerson || email, user_address: 'N/A', user_phone: lead?.phone || 'N/A',
      merchant_ok_url: returnUrl, merchant_fail_url: returnUrl, timeout_limit: '30', currency: 'TL', test_mode: testMode,
    });
    const base = (this.config.get<string>('PAYTR_BASE_URL') ?? PAYTR_DEFAULT_BASE_URL).replace(/\/+$/, '');
    let res: Response;
    try {
      res = await fetch(`${base}/odeme/api/get-token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(), signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ServiceUnavailableException('PayTR is currently unreachable');
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || body?.status !== 'success' || !body?.token) {
      throw new ServiceUnavailableException(String(body?.reason ?? body?.err_msg ?? 'PayTR rejected the payment'));
    }
    return `${base}/odeme/guvenli/${body.token}`;
  }

  /**
   * PayTR callback ("Bildirim URL"): verify the signed notification against the
   * invoice's workspace PSP creds and settle on success. Returns whether to reply
   * the literal "OK" PayTR expects (anything else makes PayTR retry).
   */
  async paytrCallback(body: { merchant_oid?: string; status?: string; total_amount?: string; hash?: string }): Promise<boolean> {
    const oid = body?.merchant_oid ?? '';
    const invoiceId = InvoicesService.oidToInvoiceId(oid);
    if (!invoiceId || !body?.hash || !body?.status || body?.total_amount == null) return false;
    const inv = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) return false;
    const psp = await this.prisma.workspacePspConfig.findUnique({ where: { workspaceId: inv.workspaceId } });
    if (psp?.provider !== 'PAYTR') return false;
    const secrets = this.openPsp(psp.configSealed);
    if (!secrets.merchantKey || !secrets.merchantSalt) return false;
    const ok = verifyCallbackHash({
      merchantOid: oid, merchantSalt: secrets.merchantSalt, status: body.status,
      totalAmount: String(body.total_amount), merchantKey: secrets.merchantKey, providedHash: body.hash,
    });
    if (!ok) return false; // forged / wrong workspace — ignore (still ACK so PayTR stops)
    if (body.status === 'success') {
      // Amount-tamper guard: the signed hash covers the amount PayTR REPORTS, not
      // that it equals what we billed (inv.total). A verified-but-mismatched amount
      // — partial/installment capture, kuruş/currency drift, or a callback replayed
      // from a smaller order under the same merchant salt — must NOT flip the invoice
      // to fully PAID (the "199$ collected as 199 TL" footgun). Both are kuruş.
      const paidKurus = Number.parseInt(String(body.total_amount), 10);
      if (!Number.isFinite(paidKurus) || paidKurus !== inv.total) {
        this.logger.warn(
          `PayTR callback amount mismatch for invoice ${inv.id}: collected ${body.total_amount} vs billed ${inv.total} — verified hash but NOT settling`,
        );
        return true; // verified → ACK so PayTR stops retrying, but do NOT settle
      }
      await this.settle(inv, 'paytr');
    }
    return true; // verified → ACK with "OK"
  }

  // ---- helpers ----
  /**
   * Settle an invoice to PAID and emit invoice.paid EXACTLY ONCE. The flip is a
   * CONDITIONAL claim (status IN DRAFT/SENT) inside a tx, mirroring payWithWallet:
   * a VOID or already-PAID invoice matches 0 rows (so a PSP callback can never
   * settle a cancelled invoice — even if a token was minted just before the void),
   * and concurrent PSP callback retries race on the row write-lock so only the
   * winner appends the outbox event (no double invoice.paid).
   */
  private async settle(inv: { id: string; workspaceId: string; leadId: string | null; status: string; total: number; currency: string }, via: string) {
    if (inv.status === 'PAID') return inv;
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.invoice.updateMany({
        where: { id: inv.id, workspaceId: inv.workspaceId, status: { in: ['DRAFT', 'SENT'] } },
        data: { status: 'PAID', paidAt: new Date(), paidVia: via },
      });
      if (claimed.count === 0) {
        // VOID / already-PAID / a concurrent retry won the claim — do NOT re-emit.
        return tx.invoice.findFirst({ where: { id: inv.id, workspaceId: inv.workspaceId } });
      }
      await this.outbox.append(
        {
          type: MarketingEventTypes.InvoicePaid,
          idempotencyKey: `invoice-paid:${inv.id}`,
          payload: { workspaceId: inv.workspaceId, invoiceId: inv.id, leadId: inv.leadId, total: inv.total, currency: inv.currency, via, occurredAt: new Date().toISOString() },
        },
        tx as any,
      );
      return tx.invoice.findFirst({ where: { id: inv.id, workspaceId: inv.workspaceId } });
    });
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
