import { createHmac, randomBytes } from 'crypto';

/**
 * Iyzico Checkout-Form (IYZWSv2) crypto + request shapes (audit A7). Pure
 * functions so the load-bearing v2 signature can be unit-tested against
 * hand-computed fixtures without a Nest container or HTTP. Iyzico collects TRY
 * (and a few others) and prices are DECIMAL strings ("199.90"), not minor units.
 */

export const IYZICO_DEFAULT_BASE_URL = 'https://api.iyzipay.com';
export const IYZICO_SANDBOX_BASE_URL = 'https://sandbox-api.iyzipay.com';
export const IYZICO_INIT_PATH = '/payment/iyzipos/checkoutform/initialize/auth/ecom';
export const IYZICO_RETRIEVE_PATH = '/payment/iyzipos/checkoutform/auth/ecom/detail';

export interface IyzicoCreds {
  apiKey: string;
  secretKey: string;
}

/** Minor units (kuruş) → Iyzico decimal price string ("19900" → "199.90"). */
export function minorToPrice(minor: number): string {
  return (minor / 100).toFixed(2);
}

/**
 * IYZWSv2 Authorization header value, per Iyzico docs:
 *   signature = hex(HMAC-SHA256(secretKey, randomKey + uriPath + requestBody))
 *   payload   = "apiKey:<apiKey>&randomKey:<rnd>&signature:<sig>"
 *   header    = "IYZWSv2 " + base64(payload)
 * The randomKey also goes on the `x-iyzi-rnd` header.
 */
export function buildAuthHeader(
  creds: IyzicoCreds,
  uriPath: string,
  requestBody: string,
  randomKey: string,
): string {
  const signature = createHmac('sha256', creds.secretKey)
    .update(randomKey + uriPath + requestBody)
    .digest('hex');
  const payload = `apiKey:${creds.apiKey}&randomKey:${randomKey}&signature:${signature}`;
  return `IYZWSv2 ${Buffer.from(payload, 'utf8').toString('base64')}`;
}

export function newRandomKey(): string {
  return `${Date.now()}${randomBytes(6).toString('hex')}`;
}

/** Build the checkout-form initialize request body. */
export function buildInitializeBody(opts: {
  conversationId: string;
  price: string;
  currency: string;
  basketId: string;
  callbackUrl: string;
  buyer: { id: string; name: string; surname: string; email: string; ip: string };
  itemName: string;
}): string {
  const addr = {
    contactName: `${opts.buyer.name} ${opts.buyer.surname}`.trim() || 'N/A',
    city: 'N/A',
    country: 'Turkey',
    address: 'N/A',
  };
  return JSON.stringify({
    locale: 'tr',
    conversationId: opts.conversationId,
    price: opts.price,
    paidPrice: opts.price,
    currency: opts.currency,
    basketId: opts.basketId,
    paymentGroup: 'PRODUCT',
    callbackUrl: opts.callbackUrl,
    enabledInstallments: [1],
    buyer: {
      id: opts.buyer.id,
      name: opts.buyer.name || 'N/A',
      surname: opts.buyer.surname || 'N/A',
      email: opts.buyer.email,
      identityNumber: '11111111111',
      registrationAddress: addr.address,
      ip: opts.buyer.ip,
      city: addr.city,
      country: addr.country,
    },
    shippingAddress: addr,
    billingAddress: addr,
    basketItems: [
      { id: opts.basketId, name: opts.itemName, category1: 'Invoice', itemType: 'VIRTUAL', price: opts.price },
    ],
  });
}
