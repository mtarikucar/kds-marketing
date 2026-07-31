import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { EstimatesService } from '../../estimates/estimates.service';
import { InvoiceTextService } from '../../invoicing/invoice-text.service';
import { InvoicesService } from '../../invoicing/invoices.service';
import { OrderFormsService } from '../../order-forms/order-forms.service';
import { ProductsService } from '../../products/products.service';
import { assertFeature } from '../mcp-feature-gate';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface CommerceToolDeps {
  products: ProductsService;
  invoices: InvoicesService;
  /** The only path that actually DELIVERS an invoice — see `jeeta.send_invoice`. */
  invoiceText: InvoiceTextService;
  estimates: EstimatesService;
  orderForms: OrderFormsService;
  entitlements: EntitlementsService;
}

const CURRENCIES = ['TRY', 'USD', 'EUR'] as const;

/**
 * Faz 5 D5 — commerce: what the workspace sells, what it quotes, what it bills
 * and how a buyer checks out.
 *
 * ## Pricing, tax and PSP logic is inherited, never re-implemented
 *
 * Every write here goes through the service that owns the arithmetic:
 * `EstimatesService.create` re-resolves each line's tax through
 * `TaxRatesService.resolveItemTaxes` and totals through `computeMoneyTotals`,
 * and `InvoiceTextService.sendByText` reuses the campaign sender's
 * reserve→send→refund metering and the registry that owns channel-secret
 * decryption. No tool computes a total, a tax percentage or a payment URL
 * itself; a tool that did would drift from the panel the moment a rate changed.
 *
 * ## The minor/major unit split is real, and it is a money bug waiting to happen
 *
 * `Product.price` is `Decimal(12,2)` in MAJOR units (₺1 234,50), while
 * `Estimate.subtotal/taxTotal/total` and every estimate/invoice LINE
 * (`unitPrice`) are integer MINOR units (kuruş/cents). A model that copies a
 * product's price straight into an estimate line under-bills by 100×. Both
 * schemas therefore say which unit they are in, in the description a model
 * actually reads, and `commerce.tools.spec.ts` pins that they do.
 *
 * ## `jeeta.send_invoice` wraps text-to-pay, not `InvoicesService.send`
 *
 * This is the sharpest decision in the group. `InvoicesService.send()` — what
 * the panel's "Send / copy pay link" button calls — does not reach anybody: it
 * flips `status` to `SENT` and returns `payUrl` for a human to paste. There is
 * no email-an-invoice code anywhere in the invoicing module. Exposing that
 * under the name `send_invoice` would have produced a tool whose honest report
 * to the user ("I sent the invoice") is false: nothing left the building.
 *
 * `InvoiceTextService.sendByText` is the real delivery path — it messages the
 * contact the pay link over the workspace's own ACTIVE SMS or WhatsApp channel,
 * reserving and refunding the metered message exactly as a campaign send does,
 * and marks a DRAFT invoice SENT as a side effect. That is what this tool
 * calls, so "sent" means sent.
 *
 * ## There is no `jeeta.mark_invoice_paid`, `void_invoice` or `pay_with_wallet`
 *
 * Recording a payment that did not happen, voiding a live receivable and
 * debiting a customer's stored wallet balance are all acts with an accounting
 * consequence that no audit log can undo, and none of them is something an
 * agent can KNOW (only a human or a PSP callback knows the money arrived).
 * `InvoicesService.settle` is reached by the PSP callbacks alone, and it stays
 * that way. Likewise there is no `submit_order_form`: that is the buyer's
 * checkout, and the buyer is not the agent.
 */
export function registerCommerceTools(registry: McpToolRegistry, deps: CommerceToolDeps): void {
  registry.register({
    name: 'jeeta.list_products',
    description:
      "List the workspace's product catalogue — what it sells, at what price, one-off or recurring, and which items are still active. Prices are in MAJOR currency units (a decimal, e.g. 1250.00 means ₺1 250,00). Use a product's price when quoting, but convert to minor units (multiply by 100) before putting it on an estimate line. Read-only.",
    domain: 'commerce',
    scopes: ['leads.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      search: z.string().max(120).optional().describe('Match product names containing this text.'),
      billingType: z
        .enum(['ONE_TIME', 'RECURRING'])
        .optional()
        .describe('Restrict to one-off or subscription products.'),
      active: z
        .boolean()
        .optional()
        .describe('true for sellable products only, false for archived ones. Omit for both.'),
      page: z.number().int().min(1).optional().describe('1-based page number (default 1).'),
      limit: z.number().int().min(1).max(100).optional().describe('Products per page (default 50, max 100).'),
    }),
    handler: async (ctx, args) =>
      deps.products.list(ctx.workspaceId, {
        ...(typeof args.search === 'string' ? { search: args.search } : {}),
        ...(typeof args.billingType === 'string' ? { billingType: args.billingType } : {}),
        ...(typeof args.active === 'boolean' ? { active: args.active } : {}),
        ...(typeof args.page === 'number' ? { page: args.page } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      } as never),
  });

  registry.register({
    name: 'jeeta.create_product',
    description:
      'Add an item to the product catalogue. Creating a product sells nothing and charges nobody — it only makes the item available to quote, invoice and put on an order form. The price is a DECIMAL in MAJOR currency units (1250.00 means ₺1 250,00), not cents. A RECURRING product bills on the interval given (monthly if omitted).',
    domain: 'commerce',
    // Deferred (spec §3): catalogue setup, not per-turn work.
    defer: true,
    // Mirrors `MarketingProductsController`: reads are leads.read, every
    // mutation is leads.manage.
    scopes: ['leads.manage'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      name: z.string().min(1).max(160).describe('Product name as the customer will see it.'),
      description: z.string().max(4000).optional().describe('What the customer gets.'),
      sku: z.string().max(80).optional().describe('Internal stock/reference code.'),
      price: z
        .number()
        .min(0)
        .optional()
        .describe('Unit price as a decimal in MAJOR currency units (e.g. 1250.00). Defaults to 0.'),
      currency: z.enum(CURRENCIES).optional().describe('Currency (default TRY).'),
      billingType: z
        .enum(['ONE_TIME', 'RECURRING'])
        .optional()
        .describe('ONE_TIME (default) or RECURRING for a subscription.'),
      interval: z
        .enum(['MONTH', 'YEAR'])
        .optional()
        .describe('Billing interval for a RECURRING product; ignored for ONE_TIME, and defaults to MONTH.'),
      taxRate: z.number().min(0).max(100).optional().describe('VAT/tax percentage, e.g. 20 for 20%.'),
      active: z.boolean().optional().describe('Whether the product is sellable (default true).'),
    }),
    // Projected field by field rather than spread: the raw `args` object is
    // whatever the caller sent, and it lands in a Prisma `create`. The MCP
    // transport strict-parses first, but the approval executor re-invokes with
    // a STORED payload, so this is the layer that must not trust it.
    handler: async (ctx, args) =>
      deps.products.create(ctx.workspaceId, {
        name: String(args.name ?? ''),
        ...(args.description !== undefined ? { description: String(args.description) } : {}),
        ...(args.sku !== undefined ? { sku: String(args.sku) } : {}),
        ...(typeof args.price === 'number' ? { price: args.price } : {}),
        ...(args.currency !== undefined ? { currency: String(args.currency) } : {}),
        ...(args.billingType !== undefined ? { billingType: String(args.billingType) } : {}),
        ...(args.interval !== undefined ? { interval: String(args.interval) } : {}),
        ...(typeof args.taxRate === 'number' ? { taxRate: args.taxRate } : {}),
        ...(typeof args.active === 'boolean' ? { active: args.active } : {}),
      } as never),
  });

  registry.register({
    name: 'jeeta.list_invoices',
    description:
      "List this workspace's most recent invoices to ITS OWN customers (number, total, currency, status, due date, linked contact). Totals are in MINOR currency units (kuruş/cents). This is not the workspace's own Jeeta subscription billing. Read-only.",
    domain: 'commerce',
    // Deferred (spec §3): `jeeta.list_products` is the commerce domain's
    // advertised read; the ledger is a follow-up question, and it is behind a
    // package feature most sessions will not have.
    defer: true,
    // MarketingInvoicesController is MANAGER + @RequiresFeature('invoicing'),
    // and every mutation on it is settings.manage. MCP has no role for an
    // API-key session, so the manager-tier scope carries the whole controller.
    scopes: ['settings.manage'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'invoicing');
      return deps.invoices.list(ctx.workspaceId);
    },
  });

  registry.register({
    name: 'jeeta.create_estimate',
    description:
      'Create a DRAFT quote/estimate for a contact. Nothing is sent and nobody is charged — the draft gets a number and a private link, and someone still has to send it. Line prices are integers in MINOR currency units (kuruş/cents): 250000 means ₺2 500,00. Attach a taxRateId per line to have the workspace tax rate applied; the server re-snapshots the rate itself, so any percentage you pass is ignored.',
    domain: 'commerce',
    // Deferred (spec §3).
    defer: true,
    // Mirrors `MarketingEstimatesController`: leads.write, REP-capable, and NOT
    // behind the `invoicing` feature (converting an accepted estimate into an
    // invoice is — but that verb is not exposed here).
    scopes: ['leads.write'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      leadId: z.string().max(64).optional().describe('Contact/lead this quote is for.'),
      items: z
        .array(
          z.object({
            description: z.string().min(1).max(300).describe('What this line is for.'),
            qty: z.number().int().min(0).max(1_000_000).describe('Quantity.'),
            unitPrice: z
              .number()
              .int()
              .min(0)
              .max(1_000_000)
              .describe('Price per unit in MINOR currency units (kuruş/cents), e.g. 250000 for ₺2 500,00.'),
            taxRateId: z.string().max(64).optional().describe('Workspace tax-rate id to apply to this line.'),
          }),
        )
        .min(1)
        .max(100)
        .describe('At least one line. An estimate with no lines quotes nothing.'),
      currency: z.enum(CURRENCIES).optional().describe('Currency (default TRY).'),
      notes: z.string().max(2000).optional().describe('Notes shown to the customer on the quote.'),
      validUntil: z
        .string()
        .max(40)
        .optional()
        .describe('ISO 8601 date after which the quote expires and can no longer be accepted.'),
    }),
    // Projected, not spread — see `jeeta.create_product`. Lines are rebuilt
    // field by field too, so no extra per-line key (a client-supplied tax
    // percentage, say) can ride into the items JSON the service snapshots.
    handler: async (ctx, args) =>
      deps.estimates.create(ctx.workspaceId, {
        ...(args.leadId !== undefined ? { leadId: String(args.leadId) } : {}),
        items: (Array.isArray(args.items) ? args.items : []).map((raw) => {
          const line = raw as Record<string, unknown>;
          return {
            description: String(line.description ?? ''),
            qty: Number(line.qty ?? 0),
            unitPrice: Number(line.unitPrice ?? 0),
            ...(line.taxRateId !== undefined ? { taxRateId: String(line.taxRateId) } : {}),
          };
        }),
        ...(args.currency !== undefined ? { currency: String(args.currency) } : {}),
        ...(args.notes !== undefined ? { notes: String(args.notes) } : {}),
        ...(args.validUntil !== undefined ? { validUntil: String(args.validUntil) } : {}),
      } as never),
  });

  registry.register({
    name: 'jeeta.send_invoice',
    description:
      "Text the customer their invoice's payment link over the workspace's SMS or WhatsApp channel. This reaches a real person and asks them for money, so it is queued for a human approval before anything is sent. It needs the invoice to have a contact with a phone number and an ACTIVE channel of that type; a DRAFT invoice is marked SENT once the message goes out. Already-paid and voided invoices are refused. It does NOT charge the card — the customer pays through the link.",
    domain: 'commerce',
    // Deferred (spec §3): a gated, occasional action.
    defer: true,
    scopes: ['settings.manage'],
    // WRITE, not SPEND: the money here moves INTO the workspace. SPEND is
    // reserved for actions whose POINT is to spend the workspace's own money
    // (ad budget, fal.ai, AI credits); the marginal carrier cost of one SMS is
    // the same incidental cost `jeeta.send_email` and `jeeta.click_to_dial`
    // carry, and those are WRITE/SEND too.
    risk: 'WRITE',
    requiresApproval: true,
    approvalKind: 'SEND',
    // Supersede key: a retried turn must not leave two live cards that each
    // text the same customer the same demand.
    resourceType: 'invoice',
    resourceIdFrom: (args) => (typeof args.invoiceId === 'string' ? args.invoiceId : undefined),
    inputSchema: z.object({
      invoiceId: z.string().min(1).describe('Invoice id, from jeeta.list_invoices.'),
      channel: z
        .enum(['SMS', 'WHATSAPP'])
        .describe('Which of the workspace\'s channels to send it over. There is no email delivery path.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'invoicing');
      return deps.invoiceText.sendByText(
        ctx.workspaceId,
        String(args.invoiceId ?? ''),
        args.channel as 'SMS' | 'WHATSAPP',
      );
    },
  });

  registry.register({
    name: 'jeeta.list_order_forms',
    description:
      "List the workspace's public order forms — the hosted checkout pages a buyer can pay through — with the product each sells, its currency, whether it is live, and its public token. The buyer-facing URL is /api/public/o/<publicToken>. Read-only.",
    domain: 'commerce',
    // Deferred (spec §3): a niche read, and the write half (creating a
    // checkout page) is deliberately not exposed at all.
    defer: true,
    scopes: ['leads.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => deps.orderForms.list(ctx.workspaceId),
  });
}
