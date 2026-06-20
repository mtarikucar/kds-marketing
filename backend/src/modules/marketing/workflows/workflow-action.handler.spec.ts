import { WorkflowActionHandler, WorkflowContext } from './workflow-action.handler';

/**
 * interpolate() feeds PLAIN-TEXT sinks only (sendPlainEmail text body, SMS /
 * WhatsApp / webchat). It must NOT HTML-escape — escaping there corrupts
 * legitimate content while adding no safety (the sink isn't HTML). The
 * whitelist token replace (resolveField, lead/trigger/context roots only) is
 * the injection-safe part and is exercised here implicitly.
 */
describe('WorkflowActionHandler.interpolate', () => {
  // interpolate() only touches ctx via resolveField, so the injected services
  // are irrelevant here — construct with nulls and reach the private method.
  const handler = new WorkflowActionHandler(
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any,
    null as any,
  );
  const interpolate = (tpl: string, ctx: WorkflowContext): string =>
    (handler as any).interpolate(tpl, ctx);

  const ctx: WorkflowContext = {
    workspaceId: 'ws-1',
    lead: { contactPerson: "Ben & Jerry's <VIP>" },
    trigger: {},
    context: {},
  };

  it('does NOT HTML-escape resolved values', () => {
    const out = interpolate('Hi {{lead.contactPerson}}', ctx);
    expect(out).toBe("Hi Ben & Jerry's <VIP>");
    // The old behavior would have produced &amp; / &lt; / &#39; — assert those
    // entities never appear.
    expect(out).not.toContain('&amp;');
    expect(out).not.toContain('&lt;');
    expect(out).not.toContain('&#39;');
  });

  it('replaces unknown / null tokens with empty string', () => {
    expect(interpolate('x={{lead.missing}}=y', ctx)).toBe('x==y');
  });

  it('only substitutes whitelisted {{...}} tokens, leaving other text intact', () => {
    expect(interpolate('literal {braces} & text', ctx)).toBe('literal {braces} & text');
  });
});

describe('WorkflowActionHandler tag actions', () => {
  const mkHandler = (tags: any) =>
    new WorkflowActionHandler(
      null as any, null as any, null as any, null as any,
      null as any, null as any, null as any, null as any,
      tags,
    );
  const ctx = (lead: any): WorkflowContext => ({
    workspaceId: 'ws-1',
    lead,
    trigger: {},
    context: {},
  });

  it('add_tag assigns the (interpolated) tag to the lead via TagsService', async () => {
    const tags = { assignToLead: jest.fn().mockResolvedValue([]) };
    const handler = mkHandler(tags);
    const res = await handler.execute(
      { type: 'add_tag', tag: 'VIP' } as any,
      ctx({ id: 'lead-1' }),
    );
    expect(tags.assignToLead).toHaveBeenCalledWith('ws-1', 'lead-1', ['VIP']);
    expect(res.output?.result).toContain('VIP');
  });

  it('add_tag is a no-op when the run has no lead', async () => {
    const tags = { assignToLead: jest.fn() };
    const handler = mkHandler(tags);
    const res = await handler.execute({ type: 'add_tag', tag: 'VIP' } as any, ctx(null));
    expect(tags.assignToLead).not.toHaveBeenCalled();
    expect(res.output?.result).toContain('skipped');
  });

  it('remove_tag unassigns only a tag actually on the lead (case-insensitive)', async () => {
    const tags = {
      getLeadTags: jest.fn().mockResolvedValue([{ id: 't-9', name: 'Vip' }]),
      unassignFromLead: jest.fn().mockResolvedValue({ removed: 1 }),
    };
    const handler = mkHandler(tags);
    const res = await handler.execute(
      { type: 'remove_tag', tag: 'vip' } as any,
      ctx({ id: 'lead-1' }),
    );
    expect(tags.unassignFromLead).toHaveBeenCalledWith('ws-1', 'lead-1', ['t-9']);
    expect(res.output?.result).toContain('Vip');
  });

  it('remove_tag never creates a tag when the lead does not carry it', async () => {
    const tags = {
      getLeadTags: jest.fn().mockResolvedValue([{ id: 't-1', name: 'Other' }]),
      unassignFromLead: jest.fn(),
    };
    const handler = mkHandler(tags);
    const res = await handler.execute(
      { type: 'remove_tag', tag: 'VIP' } as any,
      ctx({ id: 'lead-1' }),
    );
    expect(tags.unassignFromLead).not.toHaveBeenCalled();
    expect(res.output?.result).toContain('skipped');
  });
});
