import { FormsService, FORM_BURST_LIMIT } from './forms.service';

/**
 * Public form submission: resolves the workspace from the FormDef, creates a
 * workspace-scoped lead (or de-dupes by email/phone), and emits LeadCreated +
 * FormSubmitted (workflow triggers).
 */
describe('FormsService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let outbox: { append: jest.Mock };
  let autoAssigner: { pickAssignee: jest.Mock };
  let affiliates: { attributeReferral: jest.Mock };
  let svc: FormsService;

  beforeEach(() => {
    prisma = {
      formDef: { findUnique: jest.fn().mockResolvedValue({ id: 'f1', workspaceId: WS, name: 'Contact', redirectUrl: null }) },
      lead: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'lead-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      leadActivity: { create: jest.fn().mockResolvedValue({}) },
      marketingUser: { findFirst: jest.fn().mockResolvedValue({ id: 'sys-1' }) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    outbox = { append: jest.fn().mockResolvedValue('evt') };
    autoAssigner = { pickAssignee: jest.fn().mockResolvedValue(null) };
    affiliates = { attributeReferral: jest.fn().mockResolvedValue(false) };
    const leadAttribution = { capture: jest.fn().mockResolvedValue(undefined) };
    const consentLedger = { record: jest.fn().mockResolvedValue(1) };
    svc = new FormsService(prisma as any, outbox as any, autoAssigner as any, affiliates as any, leadAttribution as any, consentLedger as any);
  });

  it('creates a workspace-scoped lead and emits LeadCreated + FormSubmitted', async () => {
    const res = await svc.submit('f1', { name: 'Ada', email: 'ada@x.com', phone: '5551112233' });
    expect(res.redirectUrl).toBeNull();
    expect(prisma.lead.create.mock.calls[0][0].data).toMatchObject({ workspaceId: WS, email: 'ada@x.com', source: 'WEBSITE' });
    const types = outbox.append.mock.calls.map((c) => c[0].type);
    expect(types).toContain('marketing.lead.created.v1');
    expect(types).toContain('marketing.form.submitted.v1');
  });

  it('emits FormSubmitted INSIDE the lead transaction (durable iff the lead commits)', async () => {
    await svc.submit('f1', { name: 'Ada', email: 'ada@x.com' });
    const formSubmitted = outbox.append.mock.calls.find((c) => c[0].type === 'marketing.form.submitted.v1');
    expect(formSubmitted).toBeDefined();
    // 2nd arg = the transaction client (same as LeadCreated), so the form.submitted
    // workflow trigger is durable iff the lead row is — not a best-effort emit
    // after commit that can 500 the visitor or silently drop the trigger.
    expect(formSubmitted![1]).toBe(prisma);
  });

  it('de-dupes onto an existing lead by email (no new lead)', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-9' });
    await svc.submit('f1', { name: 'Ada', email: 'ada@x.com' });
    expect(prisma.lead.create).not.toHaveBeenCalled();
    // still emits FormSubmitted for the existing lead
    expect(outbox.append.mock.calls.map((c) => c[0].type)).toContain('marketing.form.submitted.v1');
  });

  it('de-dupes by phone across ALL number spellings (variant-aware), not the exact one', async () => {
    await svc.submit('f1', { name: 'Ada', email: 'ada@x.com', phone: '0555 111 22 33' });
    const where = prisma.lead.findFirst.mock.calls[0][0].where;
    const phoneClause = where.OR.find((c: any) => c.phoneNormalized);
    expect(phoneClause.phoneNormalized).toEqual({
      in: expect.arrayContaining(['5551112233', '05551112233', '905551112233']),
    });
  });

  it('does NOT de-dupe onto a soft-deleted lead (a new inquiry must stay visible)', async () => {
    // A bulk-deleted (deletedAt) lead is hidden from the list; matching a new
    // form submission onto it would attach the inquiry to an invisible record.
    // The dedup read must exclude soft-deleted leads, just like merged ones.
    await svc.submit('f1', { name: 'Ada', email: 'ada@x.com', phone: '5551112233' });
    const where = prisma.lead.findFirst.mock.calls[0][0].where;
    expect(where.mergedIntoId).toBeNull();
    expect(where.deletedAt).toBeNull();
  });
});

/**
 * Reading the form the tenant actually built.
 *
 * `data.email` was the only source, but the builder derives the POST key from
 * the LABEL — "E-posta" becomes `e_posta` — so every Turkish form created a
 * lead with `email: null`, uncontactable and undeduplicatable. The field's
 * declared TYPE is the contract the builder already enforces, so that is what
 * is read; the literal keys stay first so every English form and the seeded
 * default behave byte-identically.
 */
describe('FormsService — resolving the contact fields', () => {
  const WS = 'ws-1';
  let prisma: any;
  let outbox: { append: jest.Mock };
  let consentLedger: { record: jest.Mock };
  let svc: FormsService;

  const setFields = (fields: unknown) =>
    prisma.formDef.findUnique.mockResolvedValue({ id: 'f1', workspaceId: WS, name: 'İletişim', redirectUrl: null, fields });

  beforeEach(() => {
    prisma = {
      formDef: { findUnique: jest.fn().mockResolvedValue({ id: 'f1', workspaceId: WS, name: 'Contact', redirectUrl: null }) },
      lead: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'lead-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      leadActivity: { create: jest.fn().mockResolvedValue({}) },
      marketingUser: { findFirst: jest.fn().mockResolvedValue({ id: 'sys-1' }) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    outbox = { append: jest.fn().mockResolvedValue('evt') };
    consentLedger = { record: jest.fn().mockResolvedValue(1) };
    svc = new FormsService(
      prisma as any,
      outbox as any,
      { pickAssignee: jest.fn().mockResolvedValue(null) } as any,
      { attributeReferral: jest.fn().mockResolvedValue(false) } as any,
      { capture: jest.fn().mockResolvedValue(undefined) } as any,
      consentLedger as any,
    );
  });

  const created = () => prisma.lead.create.mock.calls[0][0].data;

  it('reads the email from a label-derived key via the field TYPE', async () => {
    setFields([
      { name: 'ad_soyad', label: 'Ad Soyad', type: 'text' },
      { name: 'e_posta', label: 'E-posta', type: 'email' },
      { name: 'telefon', label: 'Telefon', type: 'tel' },
    ]);
    await svc.submit('f1', { ad_soyad: 'Ada Lovelace', e_posta: 'ada@x.com', telefon: '0555 111 22 33' });
    expect(created()).toMatchObject({
      email: 'ada@x.com',
      emailNormalized: 'ada@x.com',
      phone: '0555 111 22 33',
      phoneNormalized: '05551112233',
      contactPerson: 'Ada Lovelace',
    });
  });

  it('keeps the literal keys as the highest-priority source (existing forms unchanged)', async () => {
    setFields([{ name: 'other', label: 'Other', type: 'email' }]);
    await svc.submit('f1', { email: 'literal@x.com', other: 'typed@x.com' });
    expect(created().email).toBe('literal@x.com');
  });

  it('takes the FIRST declared field of the type, not whichever key enumerates first', async () => {
    // "E-posta" + "E-posta tekrar" must resolve deterministically.
    setFields([
      { name: 'e_posta', label: 'E-posta', type: 'email' },
      { name: 'e_posta_tekrar', label: 'E-posta tekrar', type: 'email' },
    ]);
    await svc.submit('f1', { e_posta_tekrar: 'second@x.com', e_posta: 'first@x.com' });
    expect(created().email).toBe('first@x.com');
  });

  it('falls back to a label synonym when the field carries no useful type', async () => {
    setFields([
      { name: 'eposta', label: 'E-Posta Adresiniz', type: 'text' },
      { name: 'gsm', label: 'GSM', type: 'text' },
      { name: 'isim', label: 'İsim', type: 'text' },
    ]);
    await svc.submit('f1', { eposta: 'ada@x.com', gsm: '5551112233', isim: 'Ada' });
    const d = created();
    expect(d.email).toBe('ada@x.com');
    expect(d.phone).toBe('5551112233');
    expect(d.contactPerson).toBe('Ada');
  });

  it('survives a FormDef with no fields array at all', async () => {
    // Stored rows predate the builder's schema; an unguarded .filter here would
    // 500 every submit on a legacy form.
    prisma.formDef.findUnique.mockResolvedValue({ id: 'f1', workspaceId: WS, name: 'Old', redirectUrl: null });
    await svc.submit('f1', { email: 'ada@x.com' });
    expect(created().email).toBe('ada@x.com');
    prisma.lead.create.mockClear();
    setFields('not-an-array');
    await svc.submit('f1', { email: 'ada@x.com' });
    expect(created().email).toBe('ada@x.com');
  });
});

/**
 * The form is not a mail relay.
 *
 * A visitor posting `email=v1,v2,…` used to have that whole string written to
 * `lead.email`, and the workflow that answers a form submission then handed it
 * to a transport — about 180 recipients of the visitor's choosing, from the
 * tenant's own mailbox, 20 times a minute. The address a stranger types is
 * accepted as ONE address or not at all.
 */
describe('FormsService — the public form cannot choose a recipient', () => {
  const WS = 'ws-1';
  let prisma: any;
  let outbox: { append: jest.Mock };
  let consentLedger: { record: jest.Mock };
  let svc: FormsService;

  beforeEach(() => {
    prisma = {
      formDef: { findUnique: jest.fn().mockResolvedValue({ id: 'f1', workspaceId: WS, name: 'Contact', redirectUrl: null }) },
      lead: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'lead-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      leadActivity: { create: jest.fn().mockResolvedValue({}) },
      marketingUser: { findFirst: jest.fn().mockResolvedValue({ id: 'sys-1' }) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    outbox = { append: jest.fn().mockResolvedValue('evt') };
    consentLedger = { record: jest.fn().mockResolvedValue(1) };
    svc = new FormsService(
      prisma as any,
      outbox as any,
      { pickAssignee: jest.fn().mockResolvedValue(null) } as any,
      { attributeReferral: jest.fn().mockResolvedValue(false) } as any,
      { capture: jest.fn().mockResolvedValue(undefined) } as any,
      consentLedger as any,
    );
  });

  const created = () => prisma.lead.create.mock.calls[0][0].data;

  it('refuses a visitor-supplied recipient LIST and keeps the raw value for repair', async () => {
    await svc.submit('f1', { name: 'Ada', email: 'a@x.com,b@y.com,c@z.com' });
    const d = created();
    expect(d.email).toBeUndefined();
    expect(d.emailNormalized).toBeUndefined();
    // Not a 400: a typo would then lose a real lead. The raw value stays in the
    // submission note so a rep can fix it by hand.
    const note = prisma.leadActivity.create.mock.calls[0][0].data.description;
    expect(note).toContain('a@x.com,b@y.com,c@z.com');
  });

  it('refuses a display-name form and a header break', async () => {
    await svc.submit('f1', { name: 'Ada', email: '"ceo@victim.com" <attacker@evil.com>' });
    expect(created().email).toBeUndefined();
    prisma.lead.create.mockClear();
    prisma.leadActivity.create.mockClear();
    await svc.submit('f1', { name: 'Ada', email: 'ada@x.com\r\nbcc: victim@y.com' });
    expect(created().email).toBeUndefined();
  });

  it('bounds the phone so a comma list cannot collapse into one 150-digit blob', async () => {
    await svc.submit('f1', { name: 'Ada', phone: Array.from({ length: 15 }, () => '5551112233').join(',') });
    const d = created();
    expect(d.phone).toBeUndefined();
    expect(d.phoneNormalized).toBeUndefined();
  });

  it('still accepts an ordinary international number', async () => {
    await svc.submit('f1', { name: 'Ada', phone: '+1 202 555 0143' });
    expect(created().phoneNormalized).toBe('12025550143');
  });

  it('classifies the address it did accept, so a throwaway domain is visible', async () => {
    await svc.submit('f1', { name: 'Ada', email: 'ada@mailinator.com' });
    expect(created().emailVerifiedStatus).toBe('RISKY');
  });

  it('stops a scripted burst from one visitor against one form', async () => {
    for (let i = 0; i < FORM_BURST_LIMIT; i++) {
      await svc.submit('f1', { name: `Ada ${i}`, email: `ada${i}@x.com` }, undefined, { ip: '203.0.113.9' });
    }
    expect(prisma.lead.create).toHaveBeenCalledTimes(FORM_BURST_LIMIT);
    prisma.lead.create.mockClear();
    outbox.append.mockClear();
    await svc.submit('f1', { name: 'over', email: 'over@x.com' }, undefined, { ip: '203.0.113.9' });
    // Nothing written and nothing emitted — and the visitor still sees the
    // normal thank-you, so a script learns nothing from the response.
    expect(prisma.lead.create).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
    // A different visitor is unaffected.
    await svc.submit('f1', { name: 'Bob', email: 'bob@x.com' }, undefined, { ip: '198.51.100.4' });
    expect(prisma.lead.create).toHaveBeenCalledTimes(1);
  });

  it('is inert when the caller has no IP to key on (today’s behaviour)', async () => {
    for (let i = 0; i < FORM_BURST_LIMIT + 10; i++) {
      await svc.submit('f1', { name: `Ada ${i}`, email: `ada${i}@x.com` });
    }
    expect(prisma.lead.create).toHaveBeenCalledTimes(FORM_BURST_LIMIT + 10);
  });
});

/**
 * Consent at source.
 *
 * A lead captured by a form carried no record of what the person agreed to, so
 * there was nothing to answer a KVKK/GDPR question with and nothing a
 * "require consent" audience rule could ever read. The checkbox the renderer
 * already draws is now recorded: what was ticked, from which address, against
 * which words.
 */
describe('FormsService — consent at source', () => {
  const WS = 'ws-1';
  let prisma: any;
  let consentLedger: { record: jest.Mock };
  let svc: FormsService;

  const setFields = (fields: unknown) =>
    prisma.formDef.findUnique.mockResolvedValue({ id: 'f1', workspaceId: WS, name: 'İletişim', redirectUrl: null, fields });

  beforeEach(() => {
    prisma = {
      formDef: { findUnique: jest.fn().mockResolvedValue({ id: 'f1', workspaceId: WS, name: 'Contact', redirectUrl: null }) },
      lead: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'lead-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      leadActivity: { create: jest.fn().mockResolvedValue({}) },
      marketingUser: { findFirst: jest.fn().mockResolvedValue({ id: 'sys-1' }) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    consentLedger = { record: jest.fn().mockResolvedValue(1) };
    svc = new FormsService(
      prisma as any,
      { append: jest.fn().mockResolvedValue('evt') } as any,
      { pickAssignee: jest.fn().mockResolvedValue(null) } as any,
      { attributeReferral: jest.fn().mockResolvedValue(false) } as any,
      { capture: jest.fn().mockResolvedValue(undefined) } as any,
      consentLedger as any,
    );
  });

  it('records a ticked consent box with the IP and a snapshot of the words shown', async () => {
    setFields([
      { name: 'e_posta', label: 'E-posta', type: 'email' },
      { name: 'izin', label: 'Kampanya e-postaları almak istiyorum', type: 'checkbox' },
    ]);
    await svc.submit('f1', { e_posta: 'ada@x.com', izin: 'yes' }, undefined, { ip: '203.0.113.9' });
    expect(consentLedger.record).toHaveBeenCalledTimes(1);
    const [entry, tx] = consentLedger.record.mock.calls[0];
    expect(entry).toMatchObject({
      workspaceId: WS,
      leadIds: ['lead-1'],
      type: 'MARKETING_EMAIL',
      granted: true,
      ipAddress: '203.0.113.9',
    });
    // The snapshot has to be the text the visitor actually read — a later edit
    // of the form must not rewrite what they agreed to.
    expect(entry.source).toContain('form:f1');
    expect(entry.source).toContain('Kampanya e-postaları almak istiyorum');
    // Same transaction as the lead: the record is as durable as the row.
    expect(tx).toBe(prisma);
  });

  it('records an UNTICKED box as a refusal rather than silence', async () => {
    setFields([
      { name: 'e_posta', label: 'E-posta', type: 'email' },
      { name: 'izin', label: 'Ticari elektronik ileti almak istiyorum', type: 'checkbox' },
    ]);
    // An unchecked checkbox is simply not posted.
    await svc.submit('f1', { e_posta: 'ada@x.com' });
    expect(consentLedger.record.mock.calls[0][0]).toMatchObject({ granted: false });
  });

  it('writes NOTHING when the form declares no consent field (existing tenants unchanged)', async () => {
    setFields([
      { name: 'e_posta', label: 'E-posta', type: 'email' },
      { name: 'kabul', label: 'Kullanım koşullarını kabul ediyorum', type: 'checkbox' },
    ]);
    await svc.submit('f1', { e_posta: 'ada@x.com', kabul: 'yes' });
    // A terms box is not marketing consent, and inventing a MARKETING_EMAIL
    // record from one would misstate what the person agreed to.
    expect(consentLedger.record).not.toHaveBeenCalled();
  });

  it('honours an explicit consent marker whatever the label says', async () => {
    setFields([
      { name: 'e_posta', label: 'E-posta', type: 'email' },
      { name: 'box', label: 'Tamam', type: 'checkbox', consent: true },
    ]);
    await svc.submit('f1', { e_posta: 'ada@x.com', box: 'yes' });
    expect(consentLedger.record.mock.calls[0][0]).toMatchObject({ granted: true });
  });

  it('records the consent against the lead a repeat visitor de-duped onto', async () => {
    setFields([
      { name: 'e_posta', label: 'E-posta', type: 'email' },
      { name: 'izin', label: 'E-posta izni', type: 'checkbox' },
    ]);
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-9', status: 'NEW' });
    await svc.submit('f1', { e_posta: 'ada@x.com', izin: 'yes' });
    expect(consentLedger.record.mock.calls[0][0].leadIds).toEqual(['lead-9']);
  });

  it('asks the ledger for nothing when there is no consent field, even with a ticked box', async () => {
    setFields([{ name: 'e_posta', label: 'E-posta', type: 'email' }]);
    await svc.submit('f1', { e_posta: 'ada@x.com', izin: 'yes' });
    expect(consentLedger.record).not.toHaveBeenCalled();
  });
});
