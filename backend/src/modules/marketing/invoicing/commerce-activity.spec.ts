import { commerceActivity } from './commerce-activity';
import { assignmentOf } from '../services/lead-stream.service';
import { salesCallIdOf } from '../telephony/call-activity';

/**
 * The mapper is pure, so these are real assertions against real code — the two
 * stream readers below are IMPORTED, not mocked, because the thing worth
 * proving is that a commerce row cannot be mistaken for an assignment or for a
 * call by the code that actually reads the timeline.
 */
describe('commerceActivity', () => {
  it('names the document and the address a quote was emailed to', () => {
    const row = commerceActivity({
      event: 'quote_sent',
      docId: 'est1',
      number: 'EST-7',
      totalMinor: 125050,
      currency: 'TRY',
      to: 'ayse@example.com',
      via: 'mailbox',
    });
    expect(row.title).toBe('Quote EST-7 emailed');
    expect(row.description).toContain('ayse@example.com');
    expect(row.description).toContain('1250.5 TRY');
  });

  it('reads money in MAJOR units even though the column stores minor', () => {
    // Invoice.total / Estimate.total are Int MINOR units. A row that said
    // "5000 TRY" for a ₺50 invoice would be a hundredfold lie on the one
    // surface a human reads to see what happened.
    const row = commerceActivity({
      event: 'invoice_paid',
      docId: 'inv1',
      number: 'INV-1042',
      totalMinor: 5000,
      currency: 'TRY',
      paidVia: 'STRIPE',
    });
    expect(row.title).toBe('Invoice INV-1042 paid');
    expect(row.description).toContain('50 TRY');
    expect(row.description).toContain('STRIPE');
  });

  it('says nothing about money when the document carries no total', () => {
    const row = commerceActivity({
      event: 'invoice_sent',
      docId: 'inv2',
      number: 'INV-2',
      totalMinor: 0,
      currency: 'TRY',
      to: 'x@y.test',
      via: 'platform',
    });
    expect(row.description).not.toContain('0 TRY');
    expect(row.description).toContain('x@y.test');
  });

  it('distinguishes the customer accepting from the customer declining', () => {
    const yes = commerceActivity({ event: 'quote_answered', docId: 'e1', number: 'EST-7', answer: 'ACCEPTED' });
    const no = commerceActivity({ event: 'quote_answered', docId: 'e1', number: 'EST-7', answer: 'DECLINED' });
    expect(yes.title).toBe('Quote EST-7 accepted by the customer');
    expect(no.title).toBe('Quote EST-7 declined by the customer');
  });

  it('is a COMMERCE row that the timeline readers refuse to misread', () => {
    const row = commerceActivity({
      event: 'invoice_paid',
      docId: 'inv1',
      number: 'INV-1',
      totalMinor: 1000,
      currency: 'TRY',
      paidVia: 'WALLET',
    });
    expect(row.type).toBe('COMMERCE');
    // Not an assignment: assignmentOf only reacts to kind:'assignment', so a
    // paid invoice can never render wearing an assignment badge.
    expect(assignmentOf(row.metadata)).toBeNull();
    // Not a call: salesCallIdOf must not find a recording to offer.
    expect(salesCallIdOf(row.metadata)).toBeNull();
    expect((row.metadata as Record<string, unknown>).kind).toBe('commerce');
    expect((row.metadata as Record<string, unknown>).event).toBe('invoice_paid');
    expect((row.metadata as Record<string, unknown>).docId).toBe('inv1');
  });
});

describe('commerceActivity — external store orders (commerce ingest)', () => {
  it('names a paid store order by its order number, with amount and method', () => {
    const row = commerceActivity({
      event: 'order_paid',
      docId: 'ord1',
      number: 'FIG-7K2M9QXA',
      totalMinor: 349900,
      currency: 'TRY',
      paidVia: 'card',
    });
    expect(row.type).toBe('COMMERCE');
    expect(row.title).toBe('Order FIG-7K2M9QXA paid');
    expect(row.description).toBe('3499 TRY · card');
    expect((row.metadata as Record<string, unknown>).event).toBe('order_paid');
    expect(assignmentOf(row.metadata)).toBeNull();
    expect(salesCallIdOf(row.metadata)).toBeNull();
  });

  it('states the cumulative refunded amount on a refund', () => {
    const row = commerceActivity({
      event: 'order_refunded',
      docId: 'ord1',
      number: 'FIG-7K2M9QXA',
      totalMinor: 100000,
      currency: 'TRY',
    });
    expect(row.title).toBe('Order FIG-7K2M9QXA refunded');
    expect(row.description).toBe('1000 TRY');
  });
});

