import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import {
  DomainEventBus,
  DomainEvent,
} from "../../outbox/domain-event-bus.service";
import { EventTypes, PaymentSucceededPayload } from "../../outbox/event-types";

/**
 * Step C marketing decoupling — settlement commission crediting.
 *
 * Moved verbatim (logic-preserving) out of PaytrSettlementService (core) into a
 * marketing-owned consumer that reacts to `payment.succeeded.v1`. This is the
 * core → marketing inversion for business-event #2: payments no longer reads
 * `lead` or writes `commission`/`marketingNotification`; all of that now lives
 * here, inside the marketing bounded context.
 *
 * Delivery is at-least-once (in-process bus), so every credit path is
 * idempotent:
 *   - RENEWAL / UPSELL: dedupe on (sourcePaymentId, type) — pre-check + the
 *     partial-unique index as the race backstop.
 *   - SIGNUP: the original (tenantId, type='SIGNUP') Serializable guard, which
 *     also auto-creates the self-serve referral lead when none exists.
 */
@Injectable()
export class SettlementCommissionConsumer
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SettlementCommissionConsumer.name);

  // v3.0.1 round-4 audit fix — keep a stable handler ref so onModuleDestroy
  // can detach it from the in-process bus. Pre-fix the inline `(event) =>
  // this.handle(...)` was registered once but never removed; module-shutdown
  // (HMR, test teardown, Nest application close) leaked the listener,
  // double-firing handlers across hot reloads and growing the EventEmitter's
  // listener count past the default-10 warn threshold.
  private readonly paymentSucceededHandler = (event: DomainEvent<unknown>) =>
    this.handle(event as DomainEvent<PaymentSucceededPayload>);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventBus,
  ) {}

  onModuleInit(): void {
    this.bus.on(EventTypes.PaymentSucceeded, this.paymentSucceededHandler);
  }

  onModuleDestroy(): void {
    this.bus.off(EventTypes.PaymentSucceeded, this.paymentSucceededHandler);
  }

  private async handle(
    event: DomainEvent<PaymentSucceededPayload>,
  ): Promise<void> {
    const p = event.payload;
    switch (p.kind) {
      case "upsell":
      case "renewal":
        await this.creditLifetimeCommission(p);
        break;
      case "signup":
        await this.creditSignupCommissionForReferral(p);
        break;
      default:
        // Unknown kind — ignore rather than throw so a future producer adding
        // a kind doesn't break this consumer.
        break;
    }
  }

  /**
   * UPSELL / RENEWAL: credit the rep who originally converted this tenant.
   * Idempotent on (sourcePaymentId, type) so a replayed event never
   * double-credits the same payment.
   */
  private async creditLifetimeCommission(
    p: PaymentSucceededPayload,
  ): Promise<void> {
    const type = p.kind === "upsell" ? "UPSELL" : "RENEWAL";
    try {
      const existing = await this.prisma.commission.findFirst({
        where: { sourcePaymentId: p.paymentId, type },
        select: { id: true },
      });
      if (existing) return; // this payment already credited

      const lead = await this.prisma.lead.findFirst({
        where: { convertedTenantId: p.tenantId },
        select: { id: true, assignedToId: true },
      });
      if (!lead?.assignedToId) return;

      const amount = new Prisma.Decimal(p.amount)
        .mul(p.commissionRate)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      if (amount.lte(0)) return;

      await this.prisma.commission.create({
        data: {
          amount,
          type,
          status: "PENDING",
          period: this.periodOf(p.occurredAt),
          tenantId: p.tenantId,
          leadId: lead.id,
          marketingUserId: lead.assignedToId,
          sourcePaymentId: p.paymentId,
        },
      });
      this.logger.log(
        `${type} commission created for tenant=${p.tenantId} rep=${lead.assignedToId} amount=${amount}`,
      );
    } catch (err: any) {
      // The partial-unique on (sourcePaymentId, type) is the race backstop —
      // a concurrent delivery that won the insert lands here as P2002.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        return;
      }
      this.logger.error(
        `${type} commission credit failed for tenant=${p.tenantId}: ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Self-serve SIGNUP commission. Fires when a fresh activation carries a
   * resolved marketer referral. Idempotent on (tenantId, type='SIGNUP') via a
   * Serializable tx. When no Lead exists for this tenant yet we plant one with
   * source=REFERRAL + status=WON + convertedTenantId — the link the
   * RENEWAL/UPSELL paths read from, so lifetime commissions accrue without
   * extra wiring. When a Lead already exists (admin convert()ed first), the
   * admin's attribution wins.
   */
  private async creditSignupCommissionForReferral(
    p: PaymentSucceededPayload,
  ): Promise<void> {
    const marketerId = p.referredByMarketingUserId;
    if (!marketerId) return;

    try {
      const commissionAmount = new Prisma.Decimal(p.amount)
        .mul(p.commissionRate)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      if (commissionAmount.lte(0)) {
        this.logger.warn(
          `Skipping SIGNUP commission for tenant=${p.tenantId}: computed amount is zero`,
        );
        return;
      }
      const period = this.periodOf(p.occurredAt);

      let txOutcome: {
        credited: boolean;
        leadId?: string;
        marketerId?: string;
      } = {
        credited: false,
      };
      try {
        txOutcome = await this.prisma.$transaction(
          async (tx) => {
            const existingSignup = await tx.commission.findFirst({
              where: { tenantId: p.tenantId, type: "SIGNUP" },
              select: { id: true },
            });
            if (existingSignup) {
              this.logger.log(
                `SIGNUP commission already exists for tenant=${p.tenantId}; skipping referral credit`,
              );
              return { credited: false } as const;
            }

            const existingLead = await tx.lead.findUnique({
              where: { convertedTenantId: p.tenantId },
              select: { id: true, assignedToId: true },
            });

            let leadId: string;
            let resolvedMarketerId: string;
            if (existingLead) {
              // Admin already attributed this tenant — manual attribution wins.
              leadId = existingLead.id;
              resolvedMarketerId = existingLead.assignedToId ?? marketerId;
            } else {
              const lead = await tx.lead.create({
                data: {
                  businessName: p.tenantName,
                  contactPerson: p.tenantName,
                  businessType: "OTHER",
                  source: "REFERRAL",
                  status: "WON",
                  assignedToId: marketerId,
                  convertedTenantId: p.tenantId,
                  convertedAt: new Date(),
                  notes: p.referralCode
                    ? `Auto-created from self-serve checkout (ref code: ${p.referralCode})`
                    : "Auto-created from self-serve checkout referral",
                },
                select: { id: true },
              });
              leadId = lead.id;
              resolvedMarketerId = marketerId;
            }

            await tx.commission.create({
              data: {
                amount: commissionAmount,
                type: "SIGNUP",
                status: "PENDING",
                period,
                tenantId: p.tenantId,
                leadId,
                marketingUserId: resolvedMarketerId,
                sourcePaymentId: p.paymentId,
                notes: p.referralCode
                  ? `Self-serve checkout via referral code ${p.referralCode}`
                  : "Self-serve checkout referral",
              },
            });
            return {
              credited: true,
              leadId,
              marketerId: resolvedMarketerId,
            } as const;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (err: any) {
        // Postgres 40001 (serialization_failure) → another delivery won the
        // race; the SIGNUP row already exists. Treat as a dedup hit.
        if (
          err?.code === "P2034" ||
          err?.code === "40001" ||
          (err?.message ?? "").includes("could not serialize")
        ) {
          this.logger.log(
            `SIGNUP commission insert raced (serialization conflict) for tenant=${p.tenantId}; treating as already credited`,
          );
          return;
        }
        throw err;
      }

      if (!txOutcome.credited || !txOutcome.leadId || !txOutcome.marketerId) {
        return;
      }
      const { leadId, marketerId: creditedMarketerId } = txOutcome;

      // Notify the marketer via the in-app stream. Best effort — the
      // commission row is the source of truth.
      try {
        await this.prisma.marketingNotification.create({
          data: {
            userId: creditedMarketerId,
            type: "FOLLOW_UP_REMINDER",
            title: "Yeni referans kaydı",
            message: `${p.tenantName} kodunuzla abone oldu — komisyon: ${commissionAmount.toString()} TL (onay bekliyor)`,
            metadata: {
              tenantId: p.tenantId,
              leadId,
              commissionAmount: commissionAmount.toString(),
              referralCode: p.referralCode ?? null,
            },
          },
        });
      } catch (notifyErr: any) {
        this.logger.warn(
          `Failed to enqueue marketer notification for tenant=${p.tenantId}: ${notifyErr?.message ?? notifyErr}`,
        );
      }

      this.logger.log(
        `SIGNUP commission credited for tenant=${p.tenantId} marketer=${creditedMarketerId} amount=${commissionAmount}`,
      );
    } catch (err: any) {
      this.logger.error(
        `SIGNUP commission credit failed for tenant=${p.tenantId}: ${err?.message ?? err}`,
      );
    }
  }

  /** Accrual period `YYYY-MM` derived from the event's occurredAt (ISO-8601). */
  private periodOf(occurredAt: string): string {
    return occurredAt.slice(0, 7);
  }
}
