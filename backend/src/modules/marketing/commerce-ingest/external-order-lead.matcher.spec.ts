import { matchOrderLead, toAttributionInput } from './external-order-lead.matcher';

const WS = 'ws-1';

function build(found: { id: string; emailNormalized: string | null } | null = null) {
  const tx = {
    lead: {
      findFirst: jest.fn().mockResolvedValue(found),
      create: jest.fn().mockResolvedValue({ id: 'lead-new' }),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const attribution = { capture: jest.fn().mockResolvedValue(undefined) };
  const outbox = { append: jest.fn().mockResolvedValue(undefined) };
  return { tx, attribution, outbox, deps: { attribution, outbox } as never };
}

const ATTR = {
  utmSource: 'instagram',
  utmMedium: 'paid_social',
  utmCampaign: 'ekim-hediye',
  utmContent: null,
  utmTerm: null,
  fbclid: 'IwAR0abc',
  gclid: null,
  ttclid: null,
  landingUrl: 'https://shop.example/?utm_source=instagram',
  referrer: 'https://l.instagram.com/',
};

describe('external order → lead matching (contract §4)', () => {
  it('opens no lead for an anonymous order, and for a customer with neither email nor phone', async () => {
    for (const customer of [undefined, { name: 'Only A Name' }]) {
      const { tx, deps, attribution } = build();
      const out = await matchOrderLead(tx as never, WS, { customer, attribution: ATTR }, deps);
      expect(out).toEqual({ leadId: null, leadMatched: 'none', created: false });
      expect(tx.lead.findFirst).not.toHaveBeenCalled();
      expect(tx.lead.create).not.toHaveBeenCalled();
      expect(attribution.capture).not.toHaveBeenCalled();
    }
  });

  it('matches an existing lead by email with the standard query, and leaves its source alone', async () => {
    const { tx, deps } = build({ id: 'lead-1', emailNormalized: 'ayse@example.com' });
    const out = await matchOrderLead(
      tx as never,
      WS,
      { customer: { email: '  Ayse@Example.com ', phone: '+905321234567', name: 'Ayşe' } },
      deps,
    );
    expect(out).toEqual({ leadId: 'lead-1', leadMatched: 'email', created: false });
    const where = tx.lead.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ workspaceId: WS, mergedIntoId: null, deletedAt: null });
    expect(where.OR).toEqual([
      { emailNormalized: 'ayse@example.com' },
      { phoneNormalized: { in: ['5321234567', '05321234567', '905321234567'] } },
    ]);
    expect(tx.lead.findFirst.mock.calls[0][0].orderBy).toEqual({ createdAt: 'asc' });
    expect(tx.lead.create).not.toHaveBeenCalled();
    expect(tx.lead.update).not.toHaveBeenCalled();
    expect(tx.lead.updateMany).not.toHaveBeenCalled();
  });

  it.each(['0532 123 45 67', '905321234567', '+90 532 123 45 67'])(
    'matches by phone alone across spellings (%s)',
    async (phone) => {
      const { tx, deps } = build({ id: 'lead-2', emailNormalized: null });
      const out = await matchOrderLead(tx as never, WS, { customer: { phone } }, deps);
      expect(out).toEqual({ leadId: 'lead-2', leadMatched: 'phone', created: false });
      expect(tx.lead.findFirst.mock.calls[0][0].where.OR).toEqual([
        { phoneNormalized: { in: ['5321234567', '05321234567', '905321234567'] } },
      ]);
    },
  );

  it('reports phone when the lead it found carries a different email', async () => {
    const { tx, deps } = build({ id: 'lead-3', emailNormalized: 'old@example.com' });
    const out = await matchOrderLead(
      tx as never,
      WS,
      { customer: { email: 'new@example.com', phone: '05321234567' } },
      deps,
    );
    expect(out.leadMatched).toBe('phone');
  });

  it('creates a COMMERCE lead when nobody matches, announces it, and records attribution in the same tx', async () => {
    const { tx, deps, outbox, attribution } = build(null);
    const out = await matchOrderLead(
      tx as never,
      WS,
      { customer: { email: 'Ayse@Example.com', phone: '0532 123 45 67', name: 'Ayşe Yılmaz' }, attribution: ATTR },
      deps,
    );
    expect(out).toEqual({ leadId: 'lead-new', leadMatched: 'created', created: true });
    const data = tx.lead.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      workspaceId: WS,
      source: 'COMMERCE',
      status: 'NEW',
      businessType: 'OTHER',
      businessName: 'Ayşe Yılmaz',
      contactPerson: 'Ayşe Yılmaz',
      email: 'Ayse@Example.com',
      emailNormalized: 'ayse@example.com',
      phone: '+905321234567',
      phoneNormalized: '905321234567',
    });
    // externalRef left empty on purpose: the next order is found by contact.
    expect(data.externalRef).toBeUndefined();
    expect(outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'marketing.lead.created.v1',
        idempotencyKey: 'lead-created:lead-new',
        payload: expect.objectContaining({ workspaceId: WS, leadId: 'lead-new', source: 'COMMERCE' }),
      }),
      tx,
    );
    expect(attribution.capture).toHaveBeenCalledWith(WS, 'lead-new', toAttributionInput(ATTR), {}, tx);
  });

  it('names a nameless new lead after its email, then its phone', async () => {
    const a = build(null);
    await matchOrderLead(a.tx as never, WS, { customer: { email: 'x@y.test' } }, a.deps);
    expect(a.tx.lead.create.mock.calls[0][0].data.businessName).toBe('x@y.test');
    const b = build(null);
    await matchOrderLead(b.tx as never, WS, { customer: { phone: '05321234567' } }, b.deps);
    expect(b.tx.lead.create.mock.calls[0][0].data.businessName).toBe('+905321234567');
  });

  it('offers attribution to an EXISTING lead too (capture itself keeps first touch)', async () => {
    const { tx, deps, attribution } = build({ id: 'lead-1', emailNormalized: 'a@b.test' });
    await matchOrderLead(tx as never, WS, { customer: { email: 'a@b.test' }, attribution: ATTR }, deps);
    expect(attribution.capture).toHaveBeenCalledWith(WS, 'lead-1', toAttributionInput(ATTR), {}, tx);
  });

  it('maps the payload attribution onto the capture input the form path uses', () => {
    expect(toAttributionInput(ATTR)).toEqual({
      url: 'https://shop.example/?utm_source=instagram',
      referrer: 'https://l.instagram.com/',
      fields: {
        utm_source: 'instagram',
        utm_medium: 'paid_social',
        utm_campaign: 'ekim-hediye',
        utm_content: null,
        utm_term: null,
        fbclid: 'IwAR0abc',
        gclid: null,
        ttclid: null,
      },
    });
    expect(toAttributionInput({}).url).toBeUndefined();
  });
});
