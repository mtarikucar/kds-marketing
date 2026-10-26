export const billing = {
  workspace_status: 'pending_payment' as const, entitlement: null, payment: null,
  price_minor: 125000, price_currency: 'TRY', bank_instructions: 'Sentetik Banka · TR00 1234',
  payment_reference: 'JEETA-SYNTHETIC-REFERENCE',
};
export const entitlement = {
  id: 'grant-1', source: 'paid' as const, payment_id: 'payment-1',
  confirmed_at: '2026-10-24T10:00:00Z', activated_at: null, revoked_at: null,
};
export const payment = {
  id: 'payment-1', amount_minor: 125000, currency: 'TRY',
  paid_at: '2026-10-24T09:00:00Z', reported_at: '2026-10-24T10:00:00Z', confirmed: false,
};
