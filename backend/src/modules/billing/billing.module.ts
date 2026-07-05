import { Module } from '@nestjs/common';
import { EntitlementsService } from './entitlements.service';
import { BillingService } from './billing.service';
import { BillingSettlementService } from './billing-settlement.service';
import { BillingSchedulerService } from './billing-scheduler.service';
import { ManualTransferProvider } from './payments/manual-transfer.provider';
import { PaytrProvider } from './payments/paytr.provider';
import { StripeProvider } from './payments/stripe.provider';
import { BillingWebhooksController } from './payments/webhooks.controller';
import { BILLING_PAYMENT_PROVIDERS } from './payments/payment-provider.port';
// Growth-wallet top-up settlement (spec D2). Deliberately ALSO registered in
// the marketing module: the service is stateless + prisma-only, so per-module
// instances are the accepted pattern here (avoids a circular module import).
import { GrowthWalletService } from '../marketing/wallet/growth-wallet.service';

/**
 * Billing bounded context: packages → entitlements (the one source every
 * gate reads), checkout via three provider adapters, shared idempotent
 * settlement, lifecycle crons. Marketing/Platform modules import this and
 * mount their own guarded controllers; only the webhook surface lives here
 * (it authenticates by provider signature, not user token).
 */
@Module({
  controllers: [BillingWebhooksController],
  providers: [
    EntitlementsService,
    BillingService,
    BillingSettlementService,
    BillingSchedulerService,
    GrowthWalletService,
    ManualTransferProvider,
    PaytrProvider,
    StripeProvider,
    {
      provide: BILLING_PAYMENT_PROVIDERS,
      inject: [ManualTransferProvider, PaytrProvider, StripeProvider],
      useFactory: (
        manual: ManualTransferProvider,
        paytr: PaytrProvider,
        stripe: StripeProvider,
      ) => [manual, paytr, stripe],
    },
  ],
  exports: [EntitlementsService, BillingService, BillingSettlementService],
})
export class BillingModule {}
