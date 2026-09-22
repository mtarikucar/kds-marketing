import {
  ALL_SENDERS,
  REPLIES_AND_KNOWN,
  readInboundPolicy,
  resolveSenderIdentity,
  shouldIngest,
} from './inbound-policy';

describe('readInboundPolicy — G3, existing rows keep today\'s behaviour', () => {
  it('answers ALL_SENDERS for a channel that has never heard of the knob', () => {
    // Every mailbox connected before this change ingested every human sender.
    // Defaulting the missing key to the SAFE value would silently stop a live
    // shared inbox from producing leads — the knob is new, the behaviour is not.
    expect(readInboundPolicy(undefined)).toBe(ALL_SENDERS);
    expect(readInboundPolicy(null)).toBe(ALL_SENDERS);
    expect(readInboundPolicy({})).toBe(ALL_SENDERS);
    expect(readInboundPolicy({ inboundPolicy: 'nonsense' })).toBe(ALL_SENDERS);
  });

  it('reads the stored choice when there is one', () => {
    expect(readInboundPolicy({ inboundPolicy: 'REPLIES_AND_KNOWN' })).toBe(REPLIES_AND_KNOWN);
    expect(readInboundPolicy({ inboundPolicy: 'ALL_SENDERS' })).toBe(ALL_SENDERS);
  });
});

describe('resolveSenderIdentity — the contact-form relay', () => {
  const own = ['info@business.com'];

  it('swaps in a CROSS-domain Reply-To and carries ITS display name', () => {
    // A WordPress form mails as wordpress@site.com and sets Reply-To to the
    // enquirer. Without the swap every enquiry piles onto one fake lead named
    // after the website — and the name sticks, because the AI's capture path
    // only ever fills EMPTY fields.
    const id = resolveSenderIdentity({
      from: { address: 'wordpress@site.com', name: 'Site Formu' },
      replyTo: { address: 'ayse@gmail.com', name: 'Ayşe Yılmaz' },
    });
    expect(id).toMatchObject({ address: 'ayse@gmail.com', name: 'Ayşe Yılmaz', overridden: true });
  });

  it('leaves a SAME-domain Reply-To alone', () => {
    // noreply@vendor.com → sales@vendor.com is a vendor newsletter's own
    // routing, not a submitter. Overriding here would admit exactly the mail
    // the daemon rules exist to skip.
    const id = resolveSenderIdentity({
      from: { address: 'noreply@vendor.com', name: 'Vendor' },
      replyTo: { address: 'sales@vendor.com', name: 'Vendor Sales' },
    });
    expect(id).toMatchObject({ address: 'noreply@vendor.com', overridden: false });
  });

  it('resolves BEFORE the own-address check, and re-checks the resolved one', () => {
    // Variant 3: the form mails FROM the mailbox itself. Resolving first is
    // what rescues it…
    const fromSelf = resolveSenderIdentity({
      from: { address: 'info@business.com', name: 'İletişim Formu' },
      replyTo: { address: 'ayse@gmail.com', name: 'Ayşe' },
      ownAddresses: own,
    });
    expect(fromSelf).toMatchObject({ address: 'ayse@gmail.com', own: false });

    // …and re-checking is what stops a form that left Reply-To on our own
    // address from starting a self-reply loop.
    const toSelf = resolveSenderIdentity({
      from: { address: 'wordpress@site.com', name: 'Site' },
      replyTo: { address: 'INFO@business.com', name: '' },
      ownAddresses: own,
    });
    expect(toSelf).toMatchObject({ address: 'info@business.com', own: true });
  });

  it('keeps the From when there is no usable Reply-To', () => {
    expect(resolveSenderIdentity({ from: { address: 'ada@x.com', name: 'Ada' } })).toMatchObject({
      address: 'ada@x.com',
      name: 'Ada',
      overridden: false,
    });
    expect(resolveSenderIdentity({ from: [], replyTo: [] }).address).toBe('');
  });
});

describe('shouldIngest', () => {
  const build = (over: Record<string, any> = {}) => ({
    message: { findFirst: jest.fn().mockResolvedValue(null) },
    mailLog: { findFirst: jest.fn().mockResolvedValue(null) },
    contactIdentity: { findFirst: jest.fn().mockResolvedValue(null) },
    lead: { findFirst: jest.fn().mockResolvedValue(null) },
    workspaceMembership: { findFirst: jest.fn().mockResolvedValue(null) },
    ...over,
  });

  const channel = (policy: string | null, extra: Record<string, unknown> = {}) => ({
    id: 'ch-1',
    workspaceId: 'ws-1',
    configPublic: policy ? { inboundPolicy: policy } : {},
    ownAddresses: ['info@business.com'],
    ...extra,
  });

  it('ALL_SENDERS ingests a stranger and asks the database nothing', async () => {
    const prisma = build();
    const d = await shouldIngest(prisma as any, channel('ALL_SENDERS'), { from: 'kimse@baska.com' });
    expect(d).toMatchObject({ ingest: true, reason: null });
    expect(prisma.lead.findFirst).not.toHaveBeenCalled();
    expect(prisma.message.findFirst).not.toHaveBeenCalled();
  });

  it('REPLIES_AND_KNOWN records a stranger instead of making them a lead', async () => {
    const prisma = build();
    const d = await shouldIngest(prisma as any, channel('REPLIES_AND_KNOWN'), {
      from: 'kimse@baska.com',
    });
    // Recorded, not dropped: the ledger row is what answers "where did my
    // customer's mail go?", and carries the one-click "make this a lead".
    expect(d).toMatchObject({ ingest: false, reason: 'policy-not-a-lead' });
    expect(d.detail).toBeTruthy();
  });

  it('ingests a reply to a message we sent, whichever spelling the id carries', async () => {
    const prisma = build({
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'msg-1' }) },
    });
    const d = await shouldIngest(prisma as any, channel('REPLIES_AND_KNOWN'), {
      from: 'kimse@baska.com',
      inReplyTo: '<abc@jeetagrowth.com>',
    });
    expect(d.ingest).toBe(true);
    // Outbound ids were persisted WITH brackets and inbound ones without, so
    // the lookup has to ask for both or it never matches anything.
    const where = prisma.message.findFirst.mock.calls[0][0].where;
    expect(where.workspaceId).toBe('ws-1');
    expect(where.externalMessageId.in).toEqual(
      expect.arrayContaining(['abc@jeetagrowth.com', '<abc@jeetagrowth.com>']),
    );
  });

  it('ingests a reply attributed only by the References chain', async () => {
    const prisma = build({
      mailLog: { findFirst: jest.fn().mockResolvedValue({ id: 'ml-1' }) },
    });
    const d = await shouldIngest(prisma as any, channel('REPLIES_AND_KNOWN'), {
      from: 'kimse@baska.com',
      references: ['<root@jeetagrowth.com>', '<second@jeetagrowth.com>'],
    });
    expect(d.ingest).toBe(true);
  });

  it('ingests someone already in the CRM', async () => {
    const prisma = build({
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-1' }) },
    });
    const d = await shouldIngest(prisma as any, channel('REPLIES_AND_KNOWN'), {
      from: 'Musteri@Acme.COM',
    });
    expect(d.ingest).toBe(true);
    // Matched on the normalised address, and never on a tombstoned record.
    expect(prisma.lead.findFirst.mock.calls[0][0].where).toMatchObject({
      workspaceId: 'ws-1',
      emailNormalized: 'musteri@acme.com',
      deletedAt: null,
      mergedIntoId: null,
    });
  });

  it('ingests someone who already writes to THIS channel', async () => {
    const prisma = build({
      contactIdentity: { findFirst: jest.fn().mockResolvedValue({ id: 'ci-1' }) },
    });
    const d = await shouldIngest(prisma as any, channel('REPLIES_AND_KNOWN'), { from: 'x@y.com' });
    expect(d.ingest).toBe(true);
  });

  it('does not make a lead out of a colleague on the mailbox own domain', async () => {
    // A rep answering a thread from their own mailbox is not the customer, and
    // filing their words as the customer's is worse than not filing them.
    const prisma = build({
      message: { findFirst: jest.fn().mockResolvedValue({ id: 'msg-1' }) },
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-1' }) },
    });
    const d = await shouldIngest(prisma as any, channel('REPLIES_AND_KNOWN'), {
      from: 'ahmet@business.com',
      inReplyTo: '<abc@jeetagrowth.com>',
    });
    expect(d).toMatchObject({ ingest: false, reason: 'policy-not-a-lead', detail: 'own-domain' });
  });

  it('suspends the own-domain rule for a FREEMAIL mailbox', async () => {
    // A tenant on info@gmail.com would otherwise lose every prospect who also
    // uses Gmail — which is most of them.
    const prisma = build({ lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-1' }) } });
    const d = await shouldIngest(
      prisma as any,
      channel('REPLIES_AND_KNOWN', { ownAddresses: ['info@gmail.com'] }),
      { from: 'musteri@gmail.com' },
    );
    expect(d.ingest).toBe(true);
  });

  it('does not make a lead out of a workspace member', async () => {
    const prisma = build({
      workspaceMembership: { findFirst: jest.fn().mockResolvedValue({ id: 'wm-1' }) },
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-1' }) },
    });
    const d = await shouldIngest(
      prisma as any,
      channel('REPLIES_AND_KNOWN', { ownAddresses: ['info@gmail.com'] }),
      { from: 'rep@gmail.com' },
    );
    expect(d).toMatchObject({ ingest: false, detail: 'workspace-member' });
    expect(prisma.workspaceMembership.findFirst.mock.calls[0][0].where).toMatchObject({
      workspaceId: 'ws-1',
      status: 'ACTIVE',
    });
  });

  it('never decides on an empty sender', async () => {
    const prisma = build();
    expect(await shouldIngest(prisma as any, channel('REPLIES_AND_KNOWN'), { from: '' })).toMatchObject({
      ingest: false,
      reason: 'no-sender',
    });
  });

  it('fails OPEN when the database is unreachable', async () => {
    // A policy decision is not worth losing a customer's mail over. The whole
    // pipeline's rule is that silence is the failure mode being removed.
    const prisma = build({
      contactIdentity: { findFirst: jest.fn().mockRejectedValue(new Error('P1001')) },
    });
    const d = await shouldIngest(prisma as any, channel('REPLIES_AND_KNOWN'), { from: 'a@b.com' });
    expect(d).toMatchObject({ ingest: true });
  });
});
