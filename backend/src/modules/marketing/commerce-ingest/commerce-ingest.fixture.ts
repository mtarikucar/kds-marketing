/**
 * The contract's test vector (docs/superpowers/specs/2026-10-21-commerce-ingest-contracts.md
 * §1.2 / §1.4). The printer side signs the same bytes with the same key and
 * must get the same signature; change nothing here without changing both.
 *
 * The secret is the PUBLISHED example from the contract, not a real key.
 */
export const VECTOR_SECRET = 'whsec_3f9a1c7e5b2d4f60a8e1c9b7d5f3a1e2';
export const VECTOR_TIMESTAMP = '1792574043';
export const VECTOR_SIGNATURE = '7d5da73ac398d5bfa4407e58d27580f3e6a4f2954d1f06f4100f35f532c502a8';
/** 818 bytes of UTF-8, one line, no trailing newline. */
export const VECTOR_BODY =
  '{"version":1,"eventId":"figurunica:order.paid:FIG-7K2M9QXA","event":"order.paid","occurredAt":"2026-10-21T09:14:03.000Z","order":{"externalId":"FIG-7K2M9QXA","groupRef":null,"createdAt":"2026-10-21T09:02:11.000Z","currency":"TRY","amountMinor":349900,"refundedMinor":0,"paymentMethod":"card","items":[{"sku":"custom-figure-15cm","name":"Kişiye özel figür 15 cm","qty":1,"unitMinor":349900}]},"customer":{"email":"ayse@example.com","phone":"+905321234567","name":"Ayşe Yılmaz"},"attribution":{"utmSource":"instagram","utmMedium":"paid_social","utmCampaign":"ekim-hediye","utmContent":null,"utmTerm":null,"fbclid":"IwAR0abc","gclid":null,"ttclid":null,"landingUrl":"https://figurunica.com/?utm_source=instagram&utm_medium=paid_social&utm_campaign=ekim-hediye&fbclid=IwAR0abc","referrer":"https://l.instagram.com/"}}';
