import { z } from 'zod';
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerCommerceTools, type CommerceToolDeps } from './commerce.tools';

/**
 * Faz 5 D5 — commerce (products, estimates, invoices, order forms).
 *
 * The wave's theme is money, so these specs care about three things above
 * argument plumbing: that the only tool which reaches a customer with a
 * payment demand is approval-gated, that the two entitlement-gated tools
 * refuse an unentitled workspace before touching a service, and that the
 * minor-vs-major currency unit split (products are decimal, estimate lines are
 * integer minor units) is stated in the schema descriptions a model reads.
 */

const WS = 'ws-1';

function build() {
  const deps = {
    products: { list: jest.fn(async () => ({ data: [] })), create: jest.fn(async () => ({ id: 'p1' })) },
    invoices: { list: jest.fn(async () => []) },
    invoiceText: { sendByText: jest.fn(async () => ({ sent: true })) },
    estimates: { create: jest.fn(async () => ({ id: 'e1' })) },
    orderForms: { list: jest.fn(async () => []) },
    entitlements: { getEffective: jest.fn(async () => ({ features: { invoicing: true } })) },
  };
  const registry = new McpToolRegistry();
  registerCommerceTools(registry, deps as unknown as CommerceToolDeps);
  return { registry, deps };
}

const ctx = { workspaceId: WS, grantedScopes: [] as string[] };

describe('commerce tools — registration', () => {
  it('registers exactly the six D5 commerce tools, all in the commerce domain', () => {
    const { registry } = build();
    const names = registry.list([
      'leads.read',
      'leads.write',
      'leads.manage',
      'settings.manage',
    ]).map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'jeeta.list_products',
        'jeeta.create_product',
        'jeeta.list_invoices',
        'jeeta.create_estimate',
        'jeeta.send_invoice',
        'jeeta.list_order_forms',
      ].sort(),
    );
    for (const name of names) expect(registry.get(name)!.domain).toBe('commerce');
  });

  /**
   * Scopes mirror the REST controllers rather than inventing a tier:
   * products are `leads.read`/`leads.manage` (MarketingProductsController),
   * estimates are `leads.write` (MarketingEstimatesController — REP-capable),
   * order forms are `leads.read`, and everything invoicing is `settings.manage`
   * because MarketingInvoicesController is MANAGER + settings.manage.
   */
  it('mirrors the REST permission of each surface', () => {
    const { registry } = build();
    expect(registry.get('jeeta.list_products')!.scopes).toEqual(['leads.read']);
    expect(registry.get('jeeta.create_product')!.scopes).toEqual(['leads.manage']);
    expect(registry.get('jeeta.list_order_forms')!.scopes).toEqual(['leads.read']);
    expect(registry.get('jeeta.create_estimate')!.scopes).toEqual(['leads.write']);
    expect(registry.get('jeeta.list_invoices')!.scopes).toEqual(['settings.manage']);
    expect(registry.get('jeeta.send_invoice')!.scopes).toEqual(['settings.manage']);
  });

  it('advertises only the products read; the rest are discovered through jeeta.find_tools', () => {
    const { registry } = build();
    expect(registry.get('jeeta.list_products')!.defer).toBeFalsy();
    for (const name of [
      'jeeta.create_product',
      'jeeta.list_invoices',
      'jeeta.create_estimate',
      'jeeta.send_invoice',
      'jeeta.list_order_forms',
    ]) {
      expect(registry.get(name)!.defer).toBe(true);
    }
  });
});

describe('commerce reads', () => {
  it('jeeta.list_products passes filters through and never a workspace', async () => {
    const { registry, deps } = build();
    await registry.get('jeeta.list_products')!.handler(ctx, { search: 'kurs', active: false, limit: 10 });
    expect(deps.products.list).toHaveBeenCalledWith(WS, {
      search: 'kurs',
      active: false,
      limit: 10,
    });
  });

  it('jeeta.list_invoices reads the workspace ledger', async () => {
    const { registry, deps } = build();
    await registry.get('jeeta.list_invoices')!.handler(ctx, {});
    expect(deps.invoices.list).toHaveBeenCalledWith(WS);
  });

  it('jeeta.list_order_forms reads the workspace order forms', async () => {
    const { registry, deps } = build();
    await registry.get('jeeta.list_order_forms')!.handler(ctx, {});
    expect(deps.orderForms.list).toHaveBeenCalledWith(WS);
  });
});

describe('jeeta.create_estimate — a DRAFT, and nothing else', () => {
  it('creates the estimate with the caller workspace and passes items verbatim', async () => {
    const { registry, deps } = build();
    await registry.get('jeeta.create_estimate')!.handler(ctx, {
      leadId: 'l1',
      items: [{ description: 'Onboarding', qty: 1, unitPrice: 250000 }],
      currency: 'TRY',
      notes: 'valid two weeks',
    });
    expect(deps.estimates.create).toHaveBeenCalledWith(WS, {
      leadId: 'l1',
      items: [{ description: 'Onboarding', qty: 1, unitPrice: 250000 }],
      currency: 'TRY',
      notes: 'valid two weeks',
    });
  });

  /**
   * Creating a draft reaches nobody: `EstimatesService.create` writes a row
   * with status DRAFT and a public token nobody has been given. It is
   * deliberately ungated, exactly like `jeeta.draft_social_post`.
   */
  it('is an unattended write, not an approval card', () => {
    const { registry } = build();
    const tool = registry.get('jeeta.create_estimate')!;
    expect(tool.risk).toBe('WRITE');
    expect(tool.requiresApproval).toBe(false);
  });

  /**
   * The money-unit trap. `Estimate.subtotal/taxTotal/total` are integer MINOR
   * units (kuruş/cents) while `Product.price` is a decimal in major units. A
   * model that carries a product's `price` straight into an estimate line
   * would under-bill by 100x, so both schemas must say which they are.
   */
  it('says "minor units" on the estimate line price and not on the product price', () => {
    const { registry } = build();
    // Read it the way a model does: through the JSON Schema `tools/list` and
    // `jeeta.find_tools` advertise, not off the Zod internals.
    const estimate = JSON.stringify(z.toJSONSchema(registry.get('jeeta.create_estimate')!.inputSchema as never));
    const product = JSON.stringify(z.toJSONSchema(registry.get('jeeta.create_product')!.inputSchema as never));
    expect(estimate).toMatch(/minor currency units/i);
    expect(estimate).not.toMatch(/major currency units/i);
    expect(product).toMatch(/major currency units/i);
    expect(product).not.toMatch(/minor currency units/i);
  });

  it('rejects an empty item list before the service sees it', async () => {
    const { registry, deps } = build();
    const schema = registry.get('jeeta.create_estimate')!.inputSchema;
    expect(schema.safeParse({ items: [] }).success).toBe(false);
    expect(deps.estimates.create).not.toHaveBeenCalled();
  });
});

describe('jeeta.send_invoice — the one tool that asks a customer for money', () => {
  /**
   * Classification, pinned so it cannot be quietly demoted.
   *
   * `InvoicesService.send()` — the route the panel button calls — does NOT
   * reach anybody: it flips status to SENT and returns the pay link for a human
   * to copy. Exposing THAT under the name `send_invoice` would let an agent
   * report "invoice sent" when nothing left the building. This tool therefore
   * wraps `InvoiceTextService.sendByText`, the only path that actually delivers
   * the pay link to the customer (SMS/WhatsApp, through the same
   * reserve→send→refund metering the campaign sender uses).
   *
   * Because it does reach a real customer with a payment demand it is
   * `requiresApproval` with `approvalKind: 'SEND'` — the same treatment
   * `jeeta.send_message`, `jeeta.send_email` and `jeeta.click_to_dial` get. It
   * is NOT `SPEND`: money moves INTO the workspace here, and the marginal
   * carrier cost of one SMS is not what the SPEND class was created for (ad
   * budget, fal.ai generations, AI credits — the cost IS the point of the
   * action).
   */
  it('is SEND-gated, with the invoice as the supersede key', () => {
    const { registry } = build();
    const tool = registry.get('jeeta.send_invoice')!;
    expect(tool.risk).toBe('WRITE');
    expect(tool.requiresApproval).toBe(true);
    expect(tool.approvalKind).toBe('SEND');
    expect(tool.resourceType).toBe('invoice');
    expect(tool.resourceIdFrom!({ invoiceId: 'inv-9' })).toBe('inv-9');
  });

  it('delivers through the metered text-to-pay path, not the status flip', async () => {
    const { registry, deps } = build();
    await registry.get('jeeta.send_invoice')!.handler(ctx, { invoiceId: 'inv-9', channel: 'SMS' });
    expect(deps.invoiceText.sendByText).toHaveBeenCalledWith(WS, 'inv-9', 'SMS');
  });

  it('accepts only the two channels the service can actually deliver on', () => {
    const { registry } = build();
    const schema = registry.get('jeeta.send_invoice')!.inputSchema;
    expect(schema.safeParse({ invoiceId: 'i', channel: 'SMS' }).success).toBe(true);
    expect(schema.safeParse({ invoiceId: 'i', channel: 'WHATSAPP' }).success).toBe(true);
    expect(schema.safeParse({ invoiceId: 'i', channel: 'EMAIL' }).success).toBe(false);
  });
});

describe('commerce feature gate', () => {
  function unentitled() {
    const { registry, deps } = build();
    deps.entitlements.getEffective = jest.fn(async () => ({ features: {} })) as never;
    return { registry, deps };
  }

  it.each([
    ['jeeta.list_invoices', {}],
    ['jeeta.send_invoice', { invoiceId: 'i1', channel: 'SMS' }],
  ])('%s refuses cleanly without the invoicing feature', async (name, args) => {
    const { registry, deps } = unentitled();
    await expect(registry.get(name)!.handler(ctx, args)).rejects.toMatchObject({
      response: { code: 'FEATURE_NOT_IN_PACKAGE', feature: 'invoicing' },
    });
    expect(deps.invoices.list).not.toHaveBeenCalled();
    expect(deps.invoiceText.sendByText).not.toHaveBeenCalled();
  });

  /**
   * The mirror. Products, estimates and order forms are NOT behind
   * `@RequiresFeature` over REST, so gating them here would refuse a workspace
   * something it can do in the app — the opposite of the parity rule.
   */
  it.each([
    ['jeeta.list_products', {}],
    ['jeeta.list_order_forms', {}],
    ['jeeta.create_estimate', { items: [{ description: 'x', qty: 1, unitPrice: 1 }] }],
    ['jeeta.create_product', { name: 'Course' }],
  ])('%s stays reachable without any package feature (REST does not gate it either)', async (name, args) => {
    const { registry } = unentitled();
    await expect(registry.get(name)!.handler(ctx, args)).resolves.toBeDefined();
  });
});
