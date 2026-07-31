import { McpBrokerService } from '../mcp-broker.service';
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerCommerceTools } from './commerce.tools';
import { registerReviewTools } from './reviews.tools';
import { registerSchedulingTools } from './scheduling.tools';

/**
 * Faz 5 D5 — the approval gate proved on the REAL commerce/reputation tools
 * through the REAL broker (mirrors `d2-`/`d4-approval-gate.spec.ts`).
 *
 * `mcp-broker.destructive.spec.ts` pins the RULE; this pins the WIRING. The
 * point is not that the broker works — it is that these three specific tools
 * are registered so the broker's rule actually catches them, and that the
 * ungated ones are not accidentally clogging the queue.
 *
 * ## The honest caveat this file exists to record
 *
 * D5's three gated tools are all `WRITE`/`SEND`+`PUBLISH`, NOT `SPEND` — no
 * money leaves the workspace in any of them. So under `AUTONOMOUS` all three
 * DO run inline: an autonomous workspace's agent can text a customer an invoice
 * demand, book them an appointment and write the business's review replies with
 * nobody in the loop. That is the documented meaning of AUTONOMOUS ("stop
 * making me click approve on every send/publish"), and it is pinned below in
 * both directions so nobody has to guess which it is.
 */

const SLOT = '2026-08-03T09:00:00.000Z';
const SCOPES = ['leads.read', 'leads.write', 'leads.manage', 'tasks.read', 'settings.manage'];

const APPROVAL = {
  workspaceId: 'ws1',
  grantedScopes: SCOPES,
  agentRunId: 'run-1',
  requireAudit: true,
  writeMode: 'APPROVAL' as const,
};
const AUTONOMOUS = { ...APPROVAL, writeMode: 'AUTONOMOUS' as const };

function build() {
  const registry = new McpToolRegistry();
  const entitlements = {
    getEffective: jest
      .fn()
      .mockResolvedValue({ features: { invoicing: true, funnels: true, reviews: true } }),
  };
  const invoiceText = { sendByText: jest.fn().mockResolvedValue({ sent: true }) };
  const bookings = {
    listBookings: jest.fn().mockResolvedValue([]),
    availability: jest.fn().mockResolvedValue([]),
    book: jest.fn().mockResolvedValue({ id: 'bk1' }),
  };
  const reviews = {
    list: jest.fn().mockResolvedValue([]),
    saveReply: jest.fn().mockResolvedValue({ id: 'r1', status: 'REPLIED' }),
  };
  const products = { list: jest.fn().mockResolvedValue({ data: [] }), create: jest.fn().mockResolvedValue({}) };
  const estimates = { create: jest.fn().mockResolvedValue({ id: 'e1' }) };

  registerCommerceTools(registry, {
    products,
    invoices: { list: jest.fn().mockResolvedValue([]) },
    invoiceText,
    estimates,
    orderForms: { list: jest.fn().mockResolvedValue([]) },
    entitlements,
  } as never);
  registerSchedulingTools(registry, { bookings, entitlements } as never);
  registerReviewTools(registry, { reviews, entitlements } as never);

  const enqueue = jest.fn().mockResolvedValue({ id: 'appr-1' });
  const supersedePending = jest.fn().mockResolvedValue(undefined);
  const broker = new McpBrokerService(
    registry,
    { enqueue, supersedePending } as never,
    { recordTool: jest.fn() } as never,
  );
  return { broker, invoiceText, bookings, reviews, estimates, products, enqueue, supersedePending };
}

describe('Faz 5 D5 — APPROVAL mode queues the three customer-facing tools', () => {
  it('jeeta.send_invoice queues instead of texting the customer', async () => {
    const { broker, invoiceText, enqueue } = build();
    const res = await broker.invoke(APPROVAL, 'jeeta.send_invoice', { invoiceId: 'inv-1', channel: 'SMS' });
    expect(res.status).toBe('PENDING_APPROVAL');
    expect(invoiceText.sendByText).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({ kind: 'SEND', resourceType: 'invoice', resourceId: 'inv-1' }),
    );
  });

  it('jeeta.create_booking queues instead of taking the slot and emailing the attendee', async () => {
    const { broker, bookings, enqueue } = build();
    const res = await broker.invoke(APPROVAL, 'jeeta.create_booking', {
      calendarId: 'cal-1',
      start: SLOT,
      name: 'Ada',
    });
    expect(res.status).toBe('PENDING_APPROVAL');
    expect(bookings.book).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({
        kind: 'SEND',
        resourceType: 'booking_slot',
        resourceId: `cal-1@${SLOT}`,
      }),
    );
  });

  it('jeeta.reply_to_review queues instead of writing in the business\'s name', async () => {
    const { broker, reviews, enqueue } = build();
    const res = await broker.invoke(APPROVAL, 'jeeta.reply_to_review', {
      reviewId: 'r-1',
      text: 'Sorry about that — refund on its way.',
    });
    expect(res.status).toBe('PENDING_APPROVAL');
    expect(reviews.saveReply).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({ kind: 'PUBLISH', resourceType: 'review', resourceId: 'r-1' }),
    );
  });

  /**
   * A retried turn must not leave two live cards that each text the same
   * customer, claim the same slot, or propose different words for one review.
   */
  it('supersedes a stale pending card for the same target before enqueueing', async () => {
    const { broker, supersedePending } = build();
    await broker.invoke(APPROVAL, 'jeeta.send_invoice', { invoiceId: 'inv-1', channel: 'SMS' });
    await broker.invoke(APPROVAL, 'jeeta.reply_to_review', { reviewId: 'r-1', text: 'hi' });
    expect(supersedePending).toHaveBeenCalledWith('ws1', 'SEND', 'invoice', 'inv-1');
    expect(supersedePending).toHaveBeenCalledWith('ws1', 'PUBLISH', 'review', 'r-1');
  });

  /** The mirror: internal work must never become an approval card. */
  it.each([
    ['jeeta.list_products', {}],
    ['jeeta.create_product', { name: 'Starter plan' }],
    ['jeeta.create_estimate', { items: [{ description: 'Setup', qty: 1, unitPrice: 100000 }] }],
    ['jeeta.list_bookings', {}],
  ])('%s runs inline in APPROVAL mode', async (name, args) => {
    const { broker, enqueue } = build();
    const res = await broker.invoke(APPROVAL, name, args);
    expect(res.status).toBe('OK');
    expect(enqueue).not.toHaveBeenCalled();
  });
});

/**
 * The other direction, recorded rather than implied. None of D5's gated tools
 * is `SPEND`, so `ALWAYS_APPROVED_RISKS` does not catch them and AUTONOMOUS
 * genuinely runs all three inline. Anyone reading "money and public speech are
 * approval-gated" should be able to find, in one place, exactly what AUTONOMOUS
 * turns off.
 */
describe('Faz 5 D5 — what AUTONOMOUS actually lets through', () => {
  it.each([
    ['jeeta.send_invoice', { invoiceId: 'inv-1', channel: 'SMS' }],
    ['jeeta.create_booking', { calendarId: 'cal-1', start: SLOT, name: 'Ada' }],
    ['jeeta.reply_to_review', { reviewId: 'r-1', text: 'thanks' }],
  ])('%s runs inline under AUTONOMOUS — it is SEND/PUBLISH, not SPEND', async (name, args) => {
    const { broker, enqueue } = build();
    const res = await broker.invoke(AUTONOMOUS, name, args);
    expect(res.status).toBe('OK');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('and the reason is the risk class, which is asserted here so it cannot drift', () => {
    const registry = new McpToolRegistry();
    registerCommerceTools(registry, {
      products: {},
      invoices: {},
      invoiceText: {},
      estimates: {},
      orderForms: {},
      entitlements: {},
    } as never);
    registerSchedulingTools(registry, { bookings: {}, entitlements: {} } as never);
    registerReviewTools(registry, { reviews: {}, entitlements: {} } as never);
    for (const name of ['jeeta.send_invoice', 'jeeta.create_booking', 'jeeta.reply_to_review']) {
      expect(registry.get(name)!.risk).toBe('WRITE');
    }
  });
});
