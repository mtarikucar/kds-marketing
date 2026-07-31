import { McpToolRegistry } from '../mcp-tool-registry';
import { registerCommerceTools } from './commerce.tools';
import { registerCourseTools } from './courses.tools';
import { registerReviewTools } from './reviews.tools';
import { registerSchedulingTools } from './scheduling.tools';

/**
 * Faz 5 D5 — the tenant boundary, asserted structurally over the WHOLE wave
 * (mirrors `d1-`/`d2-`/`d3-`/`d4-isolation.spec.ts`).
 *
 * D5 is the wave that touches MONEY and the workspace's public face. A leak
 * here is not a wrong list: it is our agent texting another tenant's customer a
 * demand for payment, taking a slot in a stranger's calendar and emailing their
 * client about it, enrolling somebody into a course they never bought, or
 * writing words that go out under another business's name on a review.
 *
 * Every tool handler is driven with a fixed caller workspace and a deliberately
 * hostile argument set naming a FOREIGN workspace id wherever the schema offers
 * a free-text field to smuggle one into. Every call the tool then makes into a
 * service must carry the CALLER's workspace as its first argument, and the
 * foreign id must appear nowhere.
 */

const CALLER_WS = 'ws-a';
const FOREIGN_WS = 'ws-b';
const SLOT = '2026-08-03T09:00:00.000Z';

interface Recorded {
  tool: string;
  service: string;
  method: string;
  args: unknown[];
}

function recorder() {
  const calls: Recorded[] = [];
  let current = '';
  const stub = (service: string, methods: string[], result: unknown) => {
    const obj: Record<string, unknown> = {};
    for (const m of methods) {
      obj[m] = jest.fn(async (...args: unknown[]) => {
        calls.push({ tool: current, service, method: m, args });
        return result;
      });
    }
    return obj as never;
  };
  return { calls, stub, setTool: (t: string) => (current = t) };
}

function buildRegistry() {
  const rec = recorder();
  // The entitlement gate is itself a workspace-scoped read: answering it from
  // another tenant's package would let a workspace borrow a module it never
  // bought — here, invoicing, the calendar, memberships or reviews.
  const entitlements = {
    getEffective: jest.fn(async (workspaceId: string) => {
      rec.calls.push({
        tool: 'entitlements',
        service: 'entitlements',
        method: 'getEffective',
        args: [workspaceId],
      });
      return { features: { invoicing: true, funnels: true, memberships: true, reviews: true } };
    }),
  };

  const registry = new McpToolRegistry();
  registerCommerceTools(registry, {
    products: rec.stub('products', ['list', 'create'], { data: [] }),
    invoices: rec.stub('invoices', ['list'], []),
    invoiceText: rec.stub('invoiceText', ['sendByText'], { sent: true }),
    estimates: rec.stub('estimates', ['create'], { id: 'e1' }),
    orderForms: rec.stub('orderForms', ['list'], []),
    entitlements: entitlements as never,
  });
  registerSchedulingTools(registry, {
    bookings: rec.stub('bookings', ['listBookings', 'availability', 'book'], { id: 'bk1' }),
    entitlements: entitlements as never,
  });
  registerCourseTools(registry, {
    courses: rec.stub('courses', ['list'], []),
    enrollments: rec.stub('enrollments', ['enroll'], { id: 'en1' }),
    entitlements: entitlements as never,
  });
  registerReviewTools(registry, {
    reviews: rec.stub('reviews', ['list', 'saveReply'], { id: 'r1' }),
    entitlements: entitlements as never,
  });
  return { registry, rec };
}

/**
 * Every D5 tool, with a foreign workspace id planted in every free-text field
 * the schema exposes. `jeeta.create_booking` is included here even though it is
 * registered in `scheduling.tools.ts` — it is D5's tool, and the wave's
 * isolation guarantee has to cover it.
 */
const D5_CALLS: Array<[string, Record<string, unknown>]> = [
  ['jeeta.list_products', { search: FOREIGN_WS }],
  ['jeeta.create_product', { name: FOREIGN_WS, sku: FOREIGN_WS, description: FOREIGN_WS, price: 10 }],
  ['jeeta.list_invoices', {}],
  [
    'jeeta.create_estimate',
    {
      leadId: FOREIGN_WS,
      items: [{ description: FOREIGN_WS, qty: 1, unitPrice: 1000, taxRateId: FOREIGN_WS }],
      notes: FOREIGN_WS,
    },
  ],
  ['jeeta.send_invoice', { invoiceId: FOREIGN_WS, channel: 'SMS' }],
  ['jeeta.list_order_forms', {}],
  [
    'jeeta.create_booking',
    { calendarId: FOREIGN_WS, start: SLOT, name: FOREIGN_WS, notes: FOREIGN_WS },
  ],
  ['jeeta.list_courses', {}],
  ['jeeta.enrol_lead', { courseId: FOREIGN_WS, leadId: FOREIGN_WS }],
  ['jeeta.list_reviews', {}],
  ['jeeta.reply_to_review', { reviewId: FOREIGN_WS, text: FOREIGN_WS }],
];

describe('Faz 5 D5 — workspace isolation across the whole wave', () => {
  it.each(D5_CALLS)('%s passes the CALLER workspace to every service it touches', async (name, args) => {
    const { registry, rec } = buildRegistry();
    rec.setTool(name);
    await registry.get(name)!.handler({ workspaceId: CALLER_WS, grantedScopes: [] }, args);

    const made = rec.calls.filter((c) => c.tool === name || c.service === 'entitlements');
    expect(made.length).toBeGreaterThan(0); // the drive itself must not be a no-op
    for (const call of made) {
      expect(call.args[0]).toBe(CALLER_WS);
    }
  });

  it.each(D5_CALLS)('%s never lets a caller-supplied value become the workspace', async (name, args) => {
    const { registry, rec } = buildRegistry();
    rec.setTool(name);
    await registry.get(name)!.handler({ workspaceId: CALLER_WS, grantedScopes: [] }, args);
    for (const call of rec.calls) {
      expect(call.args[0]).not.toBe(FOREIGN_WS);
    }
  });

  it('exposes no D5 tool that accepts a workspaceId argument at all', () => {
    const { registry } = buildRegistry();
    for (const [name] of D5_CALLS) {
      const schema = registry.get(name)!.inputSchema as { parse: (v: unknown) => unknown };
      // Strict mode (applied centrally by the registry) turns an undeclared
      // argument into an error rather than a silently-dropped one, so this
      // proves the field is absent from the schema, not merely ignored.
      expect(() => schema.parse({ workspaceId: FOREIGN_WS })).toThrow();
    }
  });

  it('classifies every D5 tool, and puts SPEND/DESTRUCTIVE behind a mandatory approval', () => {
    const { registry } = buildRegistry();
    for (const [name] of D5_CALLS) {
      const tool = registry.get(name)!;
      expect(['READ', 'WRITE', 'SPEND', 'DESTRUCTIVE']).toContain(tool.risk);
      if (tool.risk === 'SPEND' || tool.risk === 'DESTRUCTIVE') {
        expect(tool.requiresApproval).toBe(true);
      }
      if (tool.risk === 'READ') expect(tool.requiresApproval).toBe(false);
    }
  });

  /**
   * The D5 invariant that matters most, pinned by NAME so a future refactor
   * cannot quietly demote one of these to an unattended write.
   *
   * Exactly three tools leave the building:
   *  - `send_invoice` texts a real customer a demand for payment;
   *  - `create_booking` emails an attendee a confirmation + calendar invite,
   *    mirrors the event into a connected Google/Outlook calendar and takes a
   *    slot out of a teammate's day;
   *  - `reply_to_review` writes the business's public voice and retires the
   *    review from the team's queue.
   *
   * None of the three is `SPEND`: no money leaves the workspace in any of them
   * (`send_invoice` asks for money to come IN), so they ride on `WRITE` and are
   * distinguished for the human by their approval kind — `SEND` for the two
   * that reach a named person, `PUBLISH` for the one aimed at an audience.
   */
  it('names every gated D5 tool explicitly (no silent reclassification)', () => {
    const { registry } = buildRegistry();
    const gated = D5_CALLS.map(([n]) => registry.get(n)!)
      .filter((t) => t.requiresApproval)
      .map((t) => `${t.name}:${t.risk}:${t.approvalKind}`)
      .sort();
    expect(gated).toEqual(
      [
        'jeeta.send_invoice:WRITE:SEND',
        'jeeta.create_booking:WRITE:SEND',
        'jeeta.reply_to_review:WRITE:PUBLISH',
      ].sort(),
    );
  });

  /**
   * The mirror: reading the catalogue, drafting a quote nobody has seen, adding
   * a product and enrolling a contact are all invisible outside the workspace.
   * Gating them would turn the approval queue into noise.
   */
  it('leaves reads, catalogue setup, draft quoting and enrolment unattended', () => {
    const { registry } = buildRegistry();
    const ungated = D5_CALLS.map(([n]) => registry.get(n)!)
      .filter((t) => !t.requiresApproval)
      .map((t) => t.name)
      .sort();
    expect(ungated).toEqual(
      [
        'jeeta.list_products',
        'jeeta.create_product',
        'jeeta.list_invoices',
        'jeeta.create_estimate',
        'jeeta.list_order_forms',
        'jeeta.list_courses',
        'jeeta.enrol_lead',
        'jeeta.list_reviews',
      ].sort(),
    );
  });

  /** Every D5 tool declares a domain, so progressive disclosure can place it. */
  it('gives every D5 tool a domain', () => {
    const { registry } = buildRegistry();
    for (const [name] of D5_CALLS) {
      expect(['commerce', 'scheduling', 'courses', 'reviews']).toContain(registry.get(name)!.domain);
    }
  });

  /**
   * Spec §7's never-tools, re-asserted at the wave that handles money.
   * D5 wraps the invoicing module, which also owns `markPaid`, `voidInvoice`,
   * `payWithWallet` and the PSP callbacks — recording a payment that never
   * arrived, cancelling a live receivable and debiting a customer's stored
   * balance. None of them is a tool, and none of them may become one by
   * accident: only a human or a PSP callback can know money moved.
   */
  it('exposes no tool that settles, voids or collects money', () => {
    const { registry } = buildRegistry();
    for (const name of registry.list([]).map((t) => t.name)) {
      expect(name).not.toMatch(/mark_.*paid|void_|refund|charge_|pay_with|settle|submit_order/);
    }
  });
});

/**
 * The module gate, per lane. Three of D5's four surfaces sit behind a package
 * feature; products, estimates and order forms deliberately do not, because
 * REST does not gate them either (see commerce.tools.spec.ts).
 */
describe('Faz 5 D5 — the module gate refuses an unentitled workspace', () => {
  function unentitledRegistry() {
    const entitlements = { getEffective: jest.fn(async () => ({ features: {} })) };
    const noop = new Proxy({}, { get: () => jest.fn(async () => ({})) }) as never;
    const registry = new McpToolRegistry();
    registerCommerceTools(registry, {
      products: noop,
      invoices: noop,
      invoiceText: noop,
      estimates: noop,
      orderForms: noop,
      entitlements: entitlements as never,
    });
    registerSchedulingTools(registry, { bookings: noop, entitlements: entitlements as never });
    registerCourseTools(registry, {
      courses: noop,
      enrollments: noop,
      entitlements: entitlements as never,
    });
    registerReviewTools(registry, { reviews: noop, entitlements: entitlements as never });
    return registry;
  }

  const GATED: Array<[string, string, Record<string, unknown>]> = [
    ['jeeta.list_invoices', 'invoicing', {}],
    ['jeeta.send_invoice', 'invoicing', { invoiceId: 'i1', channel: 'SMS' }],
    ['jeeta.list_bookings', 'funnels', {}],
    ['jeeta.get_booking_availability', 'funnels', { calendarId: 'c1', from: 'a', to: 'b' }],
    ['jeeta.create_booking', 'funnels', { calendarId: 'c1', start: SLOT, name: 'A' }],
    ['jeeta.list_courses', 'memberships', {}],
    ['jeeta.enrol_lead', 'memberships', { courseId: 'c1', leadId: 'l1' }],
    ['jeeta.list_reviews', 'reviews', {}],
    ['jeeta.reply_to_review', 'reviews', { reviewId: 'r1', text: 'hi' }],
  ];

  it.each(GATED)('%s refuses cleanly without the "%s" feature', async (name, feature, args) => {
    const registry = unentitledRegistry();
    await expect(
      registry.get(name)!.handler({ workspaceId: CALLER_WS, grantedScopes: [] }, args),
    ).rejects.toMatchObject({ response: { code: 'FEATURE_NOT_IN_PACKAGE', feature } });
  });

  it.each([
    ['jeeta.list_products', {}],
    ['jeeta.create_product', { name: 'x' }],
    ['jeeta.list_order_forms', {}],
    ['jeeta.create_estimate', { items: [{ description: 'x', qty: 1, unitPrice: 1 }] }],
  ])('%s is NOT gated, because REST does not gate it either', async (name, args) => {
    const registry = unentitledRegistry();
    await expect(
      registry.get(name)!.handler({ workspaceId: CALLER_WS, grantedScopes: [] }, args),
    ).resolves.toBeDefined();
  });
});
