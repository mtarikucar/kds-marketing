import { expect, it } from 'vitest';
import { activateBilling, getBilling, reportPayment } from './billing';
import { billing, payment } from '@/test/billing';
import { mockFetch } from '@/test/render';

it('uses only the existing billing routes and exact bodies, with no secret query parameters',async()=>{
  const calls=mockFetch({'GET /api/billing':billing,'POST /api/billing/payments':payment,'POST /api/billing/activate':billing});
  expect(await getBilling()).toEqual(billing);
  const evidence={reference:billing.payment_reference,amount_minor:125000,paid_at:'2026-10-24T10:00:00Z',request_key:'retry-one'};
  expect(await reportPayment({...evidence,code:'drop-me'} as typeof evidence)).toEqual(payment);
  await activateBilling('ABCD1234');
  expect(calls.map(c=>[c.method,c.path,c.body])).toEqual([
    ['GET','/api/billing',undefined],['POST','/api/billing/payments',evidence],['POST','/api/billing/activate',{code:'ABCD1234'}],
  ]);
  expect(calls.every(c=>c.search==='')).toBe(true);
  expect(calls.slice(1).every(c=>c.headers.get('x-requested-with')==='jeeta-panel')).toBe(true);
});
