/**
 * wallet.service.ts — customer store-credit wallet (GHL parity). Balance + ledger
 * are in minor units. Credit/debit are manager money actions.
 */

import marketingApi from './marketingApi';

export interface WalletLedgerEntry {
  id: string;
  delta: number;
  reason: string;
  invoiceId: string | null;
  note: string | null;
  createdAt: string;
}

export interface Wallet {
  leadId?: string;
  id?: string;
  balance: number;
  currency: string;
  ledger: WalletLedgerEntry[];
}

export const getWallet = (leadId: string): Promise<Wallet> =>
  marketingApi.get(`/contacts/${leadId}/wallet`).then((r) => r.data);

export const creditWallet = (leadId: string, amount: number, note?: string): Promise<unknown> =>
  marketingApi.post(`/contacts/${leadId}/wallet/credit`, { amount, note }).then((r) => r.data);

export const debitWallet = (leadId: string, amount: number, note?: string): Promise<unknown> =>
  marketingApi.post(`/contacts/${leadId}/wallet/debit`, { amount, note }).then((r) => r.data);
