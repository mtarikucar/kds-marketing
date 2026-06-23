import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, closeTestApp, TestApp } from '../utils/test-app';

/**
 * Epic 13 (PayTR PSP) — the public Bildirim/callback contract end to end (DB seam
 * mocked). PayTR retries until it receives the LITERAL body "OK" (HTTP 200), so a
 * wrong status/body silently breaks settlement. This pins: a valid signed
 * success callback settles + replies "OK"; a forged hash replies "FAIL" and never
 * settles; an amount mismatch ACKs ("OK") but does NOT settle.
 */
describe('Public PayTR invoice callback (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let sealSecret: (p: string) => string;
  let computeCallbackHash: (i: any) => string;

  const WS = 'ws-1';
  const INVOICE_ID = 'a1b2c3d4-0000-0000-0000-000000000000';
  const OID = `INV${INVOICE_ID.replace(/-/g, '')}`;
  const SECRETS = { merchantId: 'mid', merchantKey: 'mkey', merchantSalt: 'msalt' };

  beforeAll(async () => {
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
    sealSecret = require('../../src/common/crypto/secret-box.helper').sealSecret;
    computeCallbackHash = require('../../src/modules/billing/payments/paytr.provider').computeCallbackHash;
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  beforeEach(() => {
    jest.clearAllMocks();
    ctx.prisma.invoice.findUnique.mockResolvedValue({
      id: INVOICE_ID, workspaceId: WS, leadId: null, total: 19900, currency: 'TRY', status: 'SENT',
    } as never);
    ctx.prisma.workspacePspConfig.findUnique.mockResolvedValue({
      provider: 'PAYTR', configSealed: sealSecret(JSON.stringify(SECRETS)),
    } as never);
    (ctx.prisma.invoice.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (ctx.prisma.invoice.findFirst as jest.Mock).mockResolvedValue({ id: INVOICE_ID });
    (ctx.prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(ctx.prisma));
    (ctx.prisma.outboxEvent.findFirst as jest.Mock).mockResolvedValue(null);
    (ctx.prisma.outboxEvent.create as jest.Mock).mockResolvedValue({ id: 'evt-1' });
  });

  const hashFor = (totalAmount: string, status = 'success') =>
    computeCallbackHash({ merchantOid: OID, merchantSalt: SECRETS.merchantSalt, status, totalAmount, merchantKey: SECRETS.merchantKey });

  const post = (body: Record<string, string>) =>
    request(app.getHttpServer()).post('/api/public/i/paytr/callback').type('form').send(body);

  it('settles + replies the literal "OK" on a valid signed success callback', async () => {
    const res = await post({ merchant_oid: OID, status: 'success', total_amount: '19900', hash: hashFor('19900') });
    expect(res.status).toBe(200);
    expect(res.text).toBe('OK');
    expect(ctx.prisma.invoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PAID', paidVia: 'paytr' }) }),
    );
  });

  it('replies "FAIL" and does NOT settle on a forged hash', async () => {
    const res = await post({ merchant_oid: OID, status: 'success', total_amount: '19900', hash: 'forged' });
    expect(res.status).toBe(200);
    expect(res.text).toBe('FAIL');
    expect(ctx.prisma.invoice.updateMany).not.toHaveBeenCalled();
  });

  it('ACKs "OK" but does NOT settle when the verified amount mismatches the invoice', async () => {
    const res = await post({ merchant_oid: OID, status: 'success', total_amount: '10000', hash: hashFor('10000') });
    expect(res.status).toBe(200);
    expect(res.text).toBe('OK'); // ACK so PayTR stops retrying
    expect(ctx.prisma.invoice.updateMany).not.toHaveBeenCalled(); // but the invoice is not flipped
  });
});
