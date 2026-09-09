import { McpToolRegistry } from '../mcp-tool-registry';
import { registerOfferTools } from './offers.tools';

/**
 * The step the funnel is built around.
 *
 * `ALLOWED_TRANSITIONS` reaches WON through OFFER_SENT → WAITING, and the
 * connector could LIST offers without being able to make one — so an agent
 * could hold a whole sales conversation, learn exactly what the customer
 * needed, and then stop at the one step that closes it.
 */
describe('offer tools', () => {
  function setup() {
    const offers = {
      create: jest.fn().mockResolvedValue({ id: 'o1', status: 'DRAFT' }),
      markSent: jest.fn().mockResolvedValue({ id: 'o1', status: 'SENT' }),
      markAccepted: jest.fn().mockResolvedValue({ id: 'o1', status: 'ACCEPTED' }),
      markRejected: jest.fn().mockResolvedValue({ id: 'o1', status: 'REJECTED' }),
    };
    const principals = { resolve: jest.fn().mockResolvedValue({ id: 'svc-1', role: 'MANAGER' }) };
    const registry = new McpToolRegistry();
    registerOfferTools(registry, { offers, principals } as any);
    return { registry, offers, principals };
  }

  it('drafts an offer for the lead the agent names', async () => {
    const { registry, offers } = setup();
    await registry.get('jeeta.create_offer')!.handler({ workspaceId: 'ws-1', userId: 'u-1' } as any, {
      leadId: 'l1',
      planId: 'plan-a',
      discount: 10,
      notes: 'Agreed on the annual plan',
    });
    expect(offers.create).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ leadId: 'l1', planId: 'plan-a', discount: 10 }),
      'u-1',
      'MANAGER',
    );
  });

  it('falls back to the service principal on an API-key session', async () => {
    // Row visibility follows the caller — a REP only ever touches their own
    // offers — and an API-key session has no user, so the declared service
    // principal stands in. Passing an empty actor would hand a REP-scoped
    // guard nothing to compare against.
    const { registry, offers, principals } = setup();
    await registry.get('jeeta.create_offer')!.handler({ workspaceId: 'ws-1' } as any, { leadId: 'l1' });
    expect(principals.resolve).toHaveBeenCalled();
    expect(offers.create.mock.calls[0][2]).toBe('svc-1');
    expect(offers.create.mock.calls[0][3]).toBe('MANAGER');
  });

  it('records delivery and lets the SERVICE advance the lead, not a second call', async () => {
    // markSent moves the lead to OFFER_SENT in the SAME transaction, with a
    // compound WHERE re-asserting the lead is still open. A tool that flipped
    // the offer and then called set_lead_status separately would lose exactly
    // that guarantee — a convert() racing alongside could be reverted
    // WON → OFFER_SENT.
    const { registry, offers } = setup();
    await registry
      .get('jeeta.mark_offer_sent')!
      .handler({ workspaceId: 'ws-1', userId: 'u-1' } as any, { offerId: 'o1' });
    expect(offers.markSent).toHaveBeenCalledWith('ws-1', 'o1', 'u-1', 'MANAGER');
  });

  it('says plainly that marking sent does not email anything', async () => {
    // There is no mailer anywhere on markSent's path. A tool named send_offer
    // whose description let a model infer delivery would produce an agent that
    // tells a customer "I've sent it over" when nothing left the building.
    const { registry } = setup();
    const tool = registry.get('jeeta.mark_offer_sent')!;
    expect(tool.name).not.toContain('send_offer');
    expect(tool.description).toMatch(/does NOT email/);
    expect(tool.description).toMatch(/AFTER the customer actually has it/);
  });

  it('records acceptance without claiming the lead is WON', async () => {
    // markAccepted moves the lead to WAITING — "accepted, awaiting
    // provisioning". WON + tenant provisioning stays in convert(), which is a
    // heavier step a person still runs.
    const { registry, offers } = setup();
    const tool = registry.get('jeeta.mark_offer_accepted')!;
    await tool.handler({ workspaceId: 'ws-1', userId: 'u-1' } as any, { offerId: 'o1' });
    expect(offers.markAccepted).toHaveBeenCalledWith('ws-1', 'o1', 'u-1', 'MANAGER');
    expect(tool.description).toMatch(/WAITING/);
    expect(tool.description).toMatch(/not provision anything/);
  });

  it('does not let a rejected price close the lead by itself', async () => {
    // The service deliberately leaves the lead where it is on rejection: a
    // refused price is often where the real negotiation starts. The tool must
    // not imply otherwise.
    const { registry, offers } = setup();
    const tool = registry.get('jeeta.mark_offer_rejected')!;
    await tool.handler({ workspaceId: 'ws-1', userId: 'u-1' } as any, { offerId: 'o1' });
    expect(offers.markRejected).toHaveBeenCalledWith('ws-1', 'o1', 'u-1', 'MANAGER');
    expect(tool.description).toMatch(/does NOT close/i);
  });

  it('treats discount as a percentage and refuses a 200% one', async () => {
    const { registry } = setup();
    const schema = registry.get('jeeta.create_offer')!.inputSchema;
    expect(schema.safeParse({ leadId: 'l1', discount: 15 }).success).toBe(true);
    expect(schema.safeParse({ leadId: 'l1', discount: 200 }).success).toBe(false);
    expect(schema.safeParse({ leadId: 'l1', discount: -5 }).success).toBe(false);
  });

  it('needs a lead, and nothing else, to draft', async () => {
    // Everything but WHO it is for is optional: a quote often starts as a
    // price and a note before the plan is settled.
    const { registry } = setup();
    const schema = registry.get('jeeta.create_offer')!.inputSchema;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ leadId: 'l1' }).success).toBe(true);
  });

  it('is not approval-gated, because none of it reaches a customer', async () => {
    // Every one of these writes a row about something that already happened.
    // The gate that matters sits on the message that actually carries the
    // quote.
    const { registry } = setup();
    for (const name of [
      'jeeta.create_offer',
      'jeeta.mark_offer_sent',
      'jeeta.mark_offer_accepted',
      'jeeta.mark_offer_rejected',
    ]) {
      const tool = registry.get(name)!;
      expect(tool.requiresApproval).toBe(false);
      expect(tool.risk).toBe('WRITE');
      expect(tool.scopes).toEqual(['leads.write']);
    }
  });
});
