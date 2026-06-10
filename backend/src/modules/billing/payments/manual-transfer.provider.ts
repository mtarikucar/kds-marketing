import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentOrder } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  BillingPaymentProvider,
  CheckoutHandle,
  CheckoutContext,
} from './payment-provider.port';

/**
 * Bank-transfer (havale/EFT) path: no PSP involved. Checkout flips the
 * order to AWAITING_TRANSFER and hands the customer wire instructions with
 * a reference code; a platform operator approves the order in the console
 * once the money shows up (settlement does the actual activation).
 */
@Injectable()
export class ManualTransferProvider implements BillingPaymentProvider {
  readonly id = 'manual' as const;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  isConfigured(): boolean {
    return Boolean(
      this.configService.get<string>('BANK_IBAN') &&
        this.configService.get<string>('BANK_ACCOUNT_NAME'),
    );
  }

  supports(currency: string): boolean {
    return currency === 'TRY' || currency === 'USD';
  }

  async createCheckout(
    order: PaymentOrder,
    _ctx: CheckoutContext,
  ): Promise<CheckoutHandle> {
    // Short, human-typeable wire reference; full order id stays in the DB.
    const reference = `MKT-${order.id.replace(/-/g, '').slice(0, 10).toUpperCase()}`;

    await this.prisma.paymentOrder.update({
      where: { id: order.id },
      data: {
        status: 'AWAITING_TRANSFER',
        providerRef: reference,
        raw: { instructionsIssuedAt: new Date().toISOString() },
      },
    });

    const amountFormatted = `${order.amount.toFixed(2)} ${order.currency}`;
    return {
      kind: 'bank_transfer',
      instructions: {
        iban: this.configService.get<string>('BANK_IBAN')!,
        accountName: this.configService.get<string>('BANK_ACCOUNT_NAME')!,
        amountFormatted,
        reference,
      },
    };
  }
}
