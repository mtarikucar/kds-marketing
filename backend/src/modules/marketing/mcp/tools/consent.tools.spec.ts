import { McpToolRegistry } from '../mcp-tool-registry';
import { registerConsentTools } from './consent.tools';

/**
 * "Stop emailing me."
 *
 * A customer can say that mid-conversation, and the connector could READ it
 * without being able to obey it. Every send gate in this product reads the
 * lead's opt-out flag, and nothing an agent could call ever set one — so the
 * honest description of the loop was an agent that answers customers and
 * cannot honour the one instruction it is legally obliged to honour.
 */
describe('jeeta.record_consent', () => {
  const ctx = { workspaceId: 'ws-1' } as any;

  function setup() {
    const compliance = {
      recordConsent: jest.fn().mockResolvedValue({ id: 'c1' }),
      getConsents: jest.fn().mockResolvedValue([]),
    };
    const registry = new McpToolRegistry();
    registerConsentTools(registry, { compliance } as any);
    return { registry, compliance };
  }

  it('records a refusal on the channel it was said on', async () => {
    const { registry, compliance } = setup();
    await registry.get('jeeta.record_consent')!.handler(ctx, {
      leadId: 'l1',
      type: 'MARKETING_EMAIL',
      granted: false,
      source: 'email reply',
    });
    expect(compliance.recordConsent).toHaveBeenCalledWith(
      'ws-1',
      'l1',
      'MARKETING_EMAIL',
      false,
      { source: 'email reply' },
    );
  });

  it('goes through ComplianceService, never at the flag directly', async () => {
    // That service writes the ConsentRecord and flips the flag in ONE
    // transaction — a committed record whose flag never flipped is a contact
    // who keeps receiving campaigns despite an on-record opt-out. For SMS it
    // also mirrors to the operator blacklist and enqueues the İYS push.
    // Writing emailOptOut directly would skip every one of those.
    const { registry, compliance } = setup();
    await registry.get('jeeta.record_consent')!.handler(ctx, {
      leadId: 'l1',
      type: 'MARKETING_SMS',
      granted: false,
    });
    expect(compliance.recordConsent).toHaveBeenCalledTimes(1);
  });

  it('can restore consent as well as withdraw it', async () => {
    const { registry, compliance } = setup();
    await registry.get('jeeta.record_consent')!.handler(ctx, {
      leadId: 'l1',
      type: 'MARKETING_EMAIL',
      granted: true,
    });
    expect(compliance.recordConsent.mock.calls[0][3]).toBe(true);
  });

  it('records a provenance even when the caller gives none', async () => {
    // An opt-out with no provenance is hard to defend later, so the field is
    // never left empty — it says "mcp" rather than nothing.
    const { registry, compliance } = setup();
    await registry.get('jeeta.record_consent')!.handler(ctx, {
      leadId: 'l1',
      type: 'MARKETING_EMAIL',
      granted: false,
    });
    expect(compliance.recordConsent.mock.calls[0][4]).toEqual({ source: 'mcp' });
  });

  it('requires the caller to SAY which way, rather than defaulting', async () => {
    // A default here would guess at what a person said about being contacted.
    const { registry } = setup();
    const schema = registry.get('jeeta.record_consent')!.inputSchema;
    expect(schema.safeParse({ leadId: 'l1', type: 'MARKETING_EMAIL' }).success).toBe(false);
    expect(
      schema.safeParse({ leadId: 'l1', type: 'MARKETING_EMAIL', granted: false }).success,
    ).toBe(true);
  });

  it('covers every channel that has an opt-out flag, and nothing else', async () => {
    const { registry } = setup();
    const schema = registry.get('jeeta.record_consent')!.inputSchema;
    for (const type of ['MARKETING_EMAIL', 'MARKETING_SMS', 'MARKETING_WHATSAPP']) {
      expect(schema.safeParse({ leadId: 'l1', type, granted: false }).success).toBe(true);
    }
    expect(schema.safeParse({ leadId: 'l1', type: 'MARKETING_CARRIER_PIGEON', granted: false }).success).toBe(
      false,
    );
  });

  it('is NOT approval-gated, because a request to stop must not wait in a queue', async () => {
    // Stopping contact is the safe direction. A refusal that waits for a human
    // is a refusal being ignored for as long as the queue is.
    const { registry } = setup();
    const tool = registry.get('jeeta.record_consent')!;
    expect(tool.requiresApproval).toBe(false);
    expect(tool.risk).toBe('WRITE');
  });
});

describe('jeeta.get_consents', () => {
  it('reads what the contact has said, and writes nothing', async () => {
    const compliance = { recordConsent: jest.fn(), getConsents: jest.fn().mockResolvedValue([]) };
    const registry = new McpToolRegistry();
    registerConsentTools(registry, { compliance } as any);
    const tool = registry.get('jeeta.get_consents')!;
    await tool.handler({ workspaceId: 'ws-1' } as any, { leadId: 'l1' });
    expect(compliance.getConsents).toHaveBeenCalledWith('ws-1', 'l1');
    expect(tool.risk).toBe('READ');
  });
});
