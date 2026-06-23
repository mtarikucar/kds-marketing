import { createHmac } from 'crypto';
import { minorToPrice, buildAuthHeader, buildInitializeBody, IYZICO_INIT_PATH } from './iyzico.provider';

describe('iyzico.provider (IYZWSv2 crypto + shapes)', () => {
  it('minorToPrice converts kuruş to an Iyzico decimal string', () => {
    expect(minorToPrice(19990)).toBe('199.90');
    expect(minorToPrice(19900)).toBe('199.00');
    expect(minorToPrice(5)).toBe('0.05');
  });

  it('buildAuthHeader matches the documented IYZWSv2 signature', () => {
    const creds = { apiKey: 'api-key', secretKey: 'secret-key' };
    const body = '{"a":1}';
    const rnd = 'RND123';
    const header = buildAuthHeader(creds, IYZICO_INIT_PATH, body, rnd);
    expect(header.startsWith('IYZWSv2 ')).toBe(true);
    const decoded = Buffer.from(header.slice('IYZWSv2 '.length), 'base64').toString('utf8');
    const expectedSig = createHmac('sha256', 'secret-key').update(rnd + IYZICO_INIT_PATH + body).digest('hex');
    expect(decoded).toBe(`apiKey:api-key&randomKey:${rnd}&signature:${expectedSig}`);
  });

  it('buildInitializeBody carries the price, ids, callback + basket', () => {
    const body = JSON.parse(buildInitializeBody({
      conversationId: 'inv-1', price: '199.90', currency: 'TRY', basketId: 'inv-1',
      callbackUrl: 'https://x/cb', buyer: { id: 'l1', name: 'Jane', surname: 'Doe', email: 'j@x.com', ip: '1.2.3.4' }, itemName: 'Invoice INV-1',
    }));
    expect(body.price).toBe('199.90');
    expect(body.paidPrice).toBe('199.90');
    expect(body.conversationId).toBe('inv-1');
    expect(body.callbackUrl).toBe('https://x/cb');
    expect(body.basketItems[0]).toMatchObject({ name: 'Invoice INV-1', price: '199.90' });
    expect(body.buyer.email).toBe('j@x.com');
  });
});
