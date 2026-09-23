import { ImportService } from './import.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  // processBatch now writes the lead + the row outcome in one $transaction;
  // run the callback against the same mock client.
  (prisma.$transaction as any).mockImplementation(async (fn: any) => fn(prisma));
  const customFields = { validateAndNormalize: jest.fn().mockResolvedValue({}) };
  const tags = { assignToLead: jest.fn().mockResolvedValue([]) };
  const scheduledJob = { schedule: jest.fn().mockResolvedValue('job-1') };
  const runner = { registerHandler: jest.fn() };
  const consentLedger = { record: jest.fn().mockResolvedValue(1) };
  const svc = new ImportService(
    prisma as any,
    customFields as any,
    tags as any,
    scheduledJob as any,
    runner as any,
    consentLedger as any,
  );
  return { prisma, customFields, tags, scheduledJob, runner, consentLedger, svc };
}

describe('ImportService.suggestMapping', () => {
  it('maps header synonyms to native fields and skips unknowns', () => {
    const { svc } = makeSvc();
    expect(svc.suggestMapping(['Company', 'E-Mail', 'Tags', 'Mystery'])).toEqual({
      Company: 'businessName',
      'E-Mail': 'email',
      Tags: 'tags',
      Mystery: '__skip',
    });
  });

  it('matches a Turkish header whatever case the export wrote it in', () => {
    // `'İ'.toLowerCase()` is `i` + U+0307 and `'I'.toLowerCase()` is a DOTTED
    // `i`, so a plain `toLowerCase()` never matched a Turkish-uppercase header
    // against the dotless-ı synonym key. A Turkish tenant's export is the
    // common case, not the exotic one.
    expect(svcOf().suggestMapping(['ABONELİKTEN ÇIKTI'])).toEqual({
      'ABONELİKTEN ÇIKTI': 'emailOptOut',
    });
    expect(svcOf().suggestMapping(['Abonelikten Çıktı'])).toEqual({
      'Abonelikten Çıktı': 'emailOptOut',
    });
  });

  it('still skips an unknown Turkish header rather than guessing', () => {
    expect(svcOf().suggestMapping(['Vergi Numarası'])).toEqual({ 'Vergi Numarası': '__skip' });
  });

  function svcOf() {
    return makeSvc().svc;
  }
});

describe('ImportService.upload', () => {
  it('parses, stores rows, and returns a suggested mapping', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.importJob.create as jest.Mock).mockResolvedValue({ id: 'imp-1' });
    (prisma.importJobRow.createMany as jest.Mock).mockResolvedValue({ count: 1 });

    const out = await svc.upload(WS, 'leads.csv', 'business,email\nAcme,a@x.com', 'u1');
    expect(out).toMatchObject({
      jobId: 'imp-1',
      headers: ['business', 'email'],
      suggestedMapping: { business: 'businessName', email: 'email' },
      total: 1,
    });
    expect(prisma.importJobRow.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [{ importJobId: 'imp-1', rowIndex: 0, raw: { business: 'Acme', email: 'a@x.com' } }],
      }),
    );
  });
});

describe('ImportService.commit', () => {
  it('sets RUNNING and enqueues an import.batch job', async () => {
    const { prisma, scheduledJob, svc } = makeSvc();
    prisma.importJob.findFirst.mockResolvedValue({ id: 'imp-1', workspaceId: WS, status: 'MAPPING' } as any);
    (prisma.importJob.update as jest.Mock).mockResolvedValue({});
    await svc.commit(WS, 'imp-1', { business: 'businessName' }, 'CREATE');
    expect((prisma.importJob.update as jest.Mock).mock.calls[0][0].data).toMatchObject({ status: 'RUNNING', dedupePolicy: 'CREATE' });
    expect(scheduledJob.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'import.batch', payload: { jobId: 'imp-1', offset: 0 } }),
    );
  });
});

describe('ImportService.processBatch', () => {
  const baseJob = {
    id: 'imp-1',
    workspaceId: WS,
    status: 'RUNNING',
    mapping: { business: 'businessName', email: 'email' },
    errors: null,
  };

  it('creates leads under the CREATE policy and finishes when no rows remain', async () => {
    const { prisma, svc } = makeSvc();
    prisma.importJob.findUnique.mockResolvedValue({ ...baseJob, dedupePolicy: 'CREATE' } as any);
    prisma.importJobRow.findMany.mockResolvedValue([
      { id: 'r1', rowIndex: 0, raw: { business: 'Acme', email: 'a@x.com' } },
    ] as any);
    prisma.lead.findFirst.mockResolvedValue(null as any);
    (prisma.lead.create as jest.Mock).mockResolvedValue({ id: 'lead-1' });
    (prisma.importJobRow.update as jest.Mock).mockResolvedValue({});
    (prisma.importJob.update as jest.Mock).mockResolvedValue({});
    (prisma.importJobRow.count as jest.Mock).mockResolvedValue(0);

    await svc.processBatch('imp-1', 0);

    expect(prisma.lead.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ workspaceId: WS, businessName: 'Acme', source: 'IMPORT' }),
      }),
    );
    // counters incremented then job marked DONE
    const updates = (prisma.importJob.update as jest.Mock).mock.calls.map((c) => c[0].data);
    expect(updates.some((d) => d.created?.increment === 1)).toBe(true);
    expect(updates.some((d) => d.status === 'DONE')).toBe(true);
  });

  it('coerces source/priority/businessType to the API-enforced domain so imported leads stay editable', async () => {
    const { prisma, svc } = makeSvc();
    prisma.importJob.findUnique.mockResolvedValue({
      ...baseJob,
      dedupePolicy: 'CREATE',
      mapping: { business: 'businessName', src: 'source', prio: 'priority', type: 'businessType' },
    } as any);
    prisma.importJobRow.findMany.mockResolvedValue([
      // src 'facebook' is not a LeadSource → OTHER; prio 'urgent' → URGENT (case);
      // 'Cafe Restaurant' → the UPPER_SNAKE taxonomy key CAFE_RESTAURANT.
      { id: 'r1', rowIndex: 0, raw: { business: 'Acme', src: 'facebook', prio: 'urgent', type: 'Cafe Restaurant' } },
    ] as any);
    prisma.lead.findFirst.mockResolvedValue(null as any);
    (prisma.lead.create as jest.Mock).mockResolvedValue({ id: 'lead-1' });
    (prisma.importJobRow.update as jest.Mock).mockResolvedValue({});
    (prisma.importJob.update as jest.Mock).mockResolvedValue({});
    (prisma.importJobRow.count as jest.Mock).mockResolvedValue(0);

    await svc.processBatch('imp-1', 0);

    expect(prisma.lead.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'OTHER',
          priority: 'URGENT',
          businessType: 'CAFE_RESTAURANT',
        }),
      }),
    );
  });

  it('keeps a valid (case-insensitive) source/priority as its canonical enum value', async () => {
    const { prisma, svc } = makeSvc();
    prisma.importJob.findUnique.mockResolvedValue({
      ...baseJob,
      dedupePolicy: 'CREATE',
      mapping: { business: 'businessName', src: 'source', prio: 'priority' },
    } as any);
    prisma.importJobRow.findMany.mockResolvedValue([
      { id: 'r1', rowIndex: 0, raw: { business: 'Acme', src: 'instagram', prio: 'high' } },
    ] as any);
    prisma.lead.findFirst.mockResolvedValue(null as any);
    (prisma.lead.create as jest.Mock).mockResolvedValue({ id: 'lead-1' });
    (prisma.importJobRow.update as jest.Mock).mockResolvedValue({});
    (prisma.importJob.update as jest.Mock).mockResolvedValue({});
    (prisma.importJobRow.count as jest.Mock).mockResolvedValue(0);

    await svc.processBatch('imp-1', 0);

    expect(prisma.lead.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ source: 'INSTAGRAM', priority: 'HIGH' }),
      }),
    );
  });

  it('skips an existing lead under the SKIP policy (no create)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.importJob.findUnique.mockResolvedValue({ ...baseJob, dedupePolicy: 'SKIP' } as any);
    prisma.importJobRow.findMany.mockResolvedValue([
      { id: 'r1', rowIndex: 0, raw: { business: 'Acme', email: 'a@x.com' } },
    ] as any);
    prisma.lead.findFirst.mockResolvedValue({ id: 'existing-1', customFields: {} } as any);
    (prisma.importJobRow.update as jest.Mock).mockResolvedValue({});
    (prisma.importJob.update as jest.Mock).mockResolvedValue({});
    (prisma.importJobRow.count as jest.Mock).mockResolvedValue(0);

    await svc.processBatch('imp-1', 0);

    expect(prisma.lead.create).not.toHaveBeenCalled();
    expect(prisma.importJobRow.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'r1' }, data: expect.objectContaining({ status: 'SKIPPED' }) }),
    );
  });

  it('NEVER overwrites a converted (WON) customer under the UPDATE policy', async () => {
    const { prisma, svc } = makeSvc();
    prisma.importJob.findUnique.mockResolvedValue({ ...baseJob, dedupePolicy: 'UPDATE' } as any);
    prisma.importJobRow.findMany.mockResolvedValue([
      { id: 'r1', rowIndex: 0, raw: { business: 'Acme', email: 'a@x.com' } },
    ] as any);
    // The matched lead is a converted customer.
    prisma.lead.findFirst.mockResolvedValue({
      id: 'existing-1',
      customFields: {},
      status: 'WON',
      convertedTenantId: 'tenant-1',
    } as any);
    (prisma.importJobRow.update as jest.Mock).mockResolvedValue({});
    (prisma.importJob.update as jest.Mock).mockResolvedValue({});
    (prisma.importJobRow.count as jest.Mock).mockResolvedValue(0);

    await svc.processBatch('imp-1', 0);

    // The converted customer's record is left untouched; the row is skipped.
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(prisma.lead.create).not.toHaveBeenCalled();
    expect(prisma.importJobRow.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'r1' }, data: expect.objectContaining({ status: 'SKIPPED' }) }),
    );
  });

  it('CREATE policy ("Always create") creates a NEW lead even when the match is a converted customer', async () => {
    const { prisma, svc } = makeSvc();
    prisma.importJob.findUnique.mockResolvedValue({ ...baseJob, dedupePolicy: 'CREATE' } as any);
    prisma.importJobRow.findMany.mockResolvedValue([
      { id: 'r1', rowIndex: 0, raw: { business: 'Acme', email: 'a@x.com' } },
    ] as any);
    // Same email as a converted customer — the old guard silently SKIPPED this
    // row, contradicting the option's promise. The customer-protection guard
    // only applies to the UPDATE write path (never overwrite), not to creates.
    prisma.lead.findFirst.mockResolvedValue({
      id: 'existing-1',
      customFields: {},
      status: 'WON',
      convertedTenantId: 'tenant-1',
    } as any);
    (prisma.lead.create as jest.Mock).mockResolvedValue({ id: 'lead-2' });
    (prisma.importJobRow.update as jest.Mock).mockResolvedValue({});
    (prisma.importJob.update as jest.Mock).mockResolvedValue({});
    (prisma.importJobRow.count as jest.Mock).mockResolvedValue(0);

    await svc.processBatch('imp-1', 0);

    expect(prisma.lead.update).not.toHaveBeenCalled(); // still never overwrites the customer
    expect(prisma.lead.create).toHaveBeenCalled();
    expect(prisma.importJobRow.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'r1' }, data: expect.objectContaining({ status: 'DONE' }) }),
    );
  });

  it('selects the normalized identifiers its single-key-match preservation relies on', async () => {
    // The UPDATE path reads existing.emailNormalized / existing.phoneNormalized to
    // decide whether a row that matched on ONE key may overwrite the OTHER. Those
    // fields must be in the dedup lookup's `select` — at runtime Prisma returns
    // ONLY selected columns, so omitting them makes both read `undefined`, the
    // matched/keep flags collapse to false, and the conflicting identifier gets
    // clobbered (the exact corruption the preservation logic exists to prevent).
    const { prisma, svc } = makeSvc();
    prisma.importJob.findUnique.mockResolvedValue({ ...baseJob, dedupePolicy: 'UPDATE' } as any);
    prisma.importJobRow.findMany.mockResolvedValue([
      { id: 'r1', rowIndex: 0, raw: { business: 'Acme', email: 'a@x.com' } },
    ] as any);
    prisma.lead.findFirst.mockResolvedValue({
      id: 'existing-1',
      customFields: {},
      status: 'NEW',
      convertedTenantId: null,
      emailNormalized: 'a@x.com',
      phoneNormalized: '+905001112233',
    } as any);
    (prisma.lead.update as jest.Mock).mockResolvedValue({});
    (prisma.importJobRow.update as jest.Mock).mockResolvedValue({});
    (prisma.importJob.update as jest.Mock).mockResolvedValue({});
    (prisma.importJobRow.count as jest.Mock).mockResolvedValue(0);

    await svc.processBatch('imp-1', 0);

    const sel = (prisma.lead.findFirst as jest.Mock).mock.calls[0][0].select;
    expect(sel.emailNormalized).toBe(true);
    expect(sel.phoneNormalized).toBe(true);
  });

  it('dedup lookup matches a phone across ALL its spellings (variant-aware), not just the exact one', async () => {
    // A lead first stored via SMS ingress as "905001112233" must be found by an
    // import row that spells the same number "0500 111 22 33" — an exact-match
    // lookup silently misses it and creates a DUPLICATE. Mirrors the variant
    // resolution İYS/telephony/voice already use.
    const { prisma, svc } = makeSvc();
    prisma.importJob.findUnique.mockResolvedValue({
      ...baseJob, dedupePolicy: 'CREATE', mapping: { business: 'businessName', phone: 'phone' },
    } as any);
    prisma.importJobRow.findMany.mockResolvedValue([
      { id: 'r1', rowIndex: 0, raw: { business: 'Acme', phone: '0500 111 22 33' } },
    ] as any);
    prisma.lead.findFirst.mockResolvedValue(null as any);
    (prisma.lead.create as jest.Mock).mockResolvedValue({ id: 'lead-1' });
    (prisma.importJobRow.update as jest.Mock).mockResolvedValue({});
    (prisma.importJob.update as jest.Mock).mockResolvedValue({});
    (prisma.importJobRow.count as jest.Mock).mockResolvedValue(0);

    await svc.processBatch('imp-1', 0);

    const where = (prisma.lead.findFirst as jest.Mock).mock.calls[0][0].where;
    const phoneClause = where.OR.find((c: any) => c.phoneNormalized);
    expect(phoneClause.phoneNormalized).toEqual({
      in: expect.arrayContaining(['5001112233', '05001112233', '905001112233']),
    });
  });

  it('a phone-VARIANT match does not clobber a differing existing email (matchedPhone is variant-aware)', async () => {
    // The row spells the phone as the 0-prefixed variant of the existing lead's
    // 90-prefixed one, and carries a DIFFERENT email. This is a phone-only match,
    // so the existing email must be preserved — the same protection an exact
    // phone match already gets.
    const { prisma, svc } = makeSvc();
    prisma.importJob.findUnique.mockResolvedValue({
      ...baseJob, dedupePolicy: 'UPDATE', mapping: { business: 'businessName', phone: 'phone', email: 'email' },
    } as any);
    prisma.importJobRow.findMany.mockResolvedValue([
      { id: 'r1', rowIndex: 0, raw: { business: 'Acme', phone: '05001112233', email: 'new@x.com' } },
    ] as any);
    prisma.lead.findFirst.mockResolvedValue({
      id: 'existing-1', customFields: {}, status: 'NEW', convertedTenantId: null,
      emailNormalized: 'old@x.com', phoneNormalized: '905001112233',
    } as any);
    (prisma.lead.update as jest.Mock).mockResolvedValue({});
    (prisma.importJobRow.update as jest.Mock).mockResolvedValue({});
    (prisma.importJob.update as jest.Mock).mockResolvedValue({});
    (prisma.importJobRow.count as jest.Mock).mockResolvedValue(0);

    await svc.processBatch('imp-1', 0);

    const upd = (prisma.lead.update as jest.Mock).mock.calls[0][0].data;
    expect(upd.emailNormalized).toBeUndefined(); // existing (different) email preserved
    expect(upd.email).toBeUndefined(); // scalar email dropped too
  });

  it('excludes merged AND soft-deleted leads from the dedup lookup', async () => {
    // An import row must never match a hidden lead — matching a soft-deleted
    // (bulk-deleted) lead would update or skip the row against an invisible
    // record. A deleted contact in the CSV should become a fresh visible lead.
    const { prisma, svc } = makeSvc();
    prisma.importJob.findUnique.mockResolvedValue({ ...baseJob, dedupePolicy: 'UPDATE' } as any);
    prisma.importJobRow.findMany.mockResolvedValue([
      { id: 'r1', rowIndex: 0, raw: { business: 'Acme', email: 'a@x.com' } },
    ] as any);
    prisma.lead.findFirst.mockResolvedValue(null as any);
    (prisma.lead.create as jest.Mock).mockResolvedValue({ id: 'lead-1' });
    (prisma.importJobRow.update as jest.Mock).mockResolvedValue({});
    (prisma.importJob.update as jest.Mock).mockResolvedValue({});
    (prisma.importJobRow.count as jest.Mock).mockResolvedValue(0);

    await svc.processBatch('imp-1', 0);

    const where = (prisma.lead.findFirst as jest.Mock).mock.calls[0][0].where;
    expect(where.mergedIntoId).toBeNull();
    expect(where.deletedAt).toBeNull();
  });

  it('does nothing when the job is not RUNNING', async () => {
    const { prisma, svc } = makeSvc();
    prisma.importJob.findUnique.mockResolvedValue({ ...baseJob, status: 'DONE' } as any);
    await svc.processBatch('imp-1', 0);
    expect(prisma.importJobRow.findMany).not.toHaveBeenCalled();
  });
});

describe('ImportService — batch-job exhaustion flips the ImportJob FAILED', () => {
  it('the registered onExhausted hook marks a RUNNING import FAILED with a visible reason', async () => {
    const { prisma, runner, svc } = makeSvc();
    svc.onModuleInit();
    // registerHandler(kind, fn, onExhausted) — grab the hook.
    const onExhausted = (runner.registerHandler as jest.Mock).mock.calls[0][2];
    expect(typeof onExhausted).toBe('function');

    prisma.importJob.findUnique.mockResolvedValue({ status: 'RUNNING', errors: [{ row: 3, message: 'x' }] } as any);
    (prisma.importJob.update as jest.Mock).mockResolvedValue({});

    await onExhausted({ payload: { jobId: 'imp-1' } }, 'db blip');

    // Without this the wizard polled "Import running…" forever after a DLQ.
    const call = (prisma.importJob.update as jest.Mock).mock.calls[0][0];
    expect(call.where).toEqual({ id: 'imp-1' });
    expect(call.data.status).toBe('FAILED');
    expect(call.data.errors).toEqual([
      { row: 3, message: 'x' },
      { row: -1, message: expect.stringContaining('db blip') },
    ]);
  });

  it('is a no-op for an import that already finished (no resurrect-to-FAILED)', async () => {
    const { prisma, runner, svc } = makeSvc();
    svc.onModuleInit();
    const onExhausted = (runner.registerHandler as jest.Mock).mock.calls[0][2];
    prisma.importJob.findUnique.mockResolvedValue({ status: 'DONE', errors: null } as any);
    await onExhausted({ payload: { jobId: 'imp-1' } }, 'late failure');
    expect(prisma.importJob.update).not.toHaveBeenCalled();
  });
});

/**
 * Hygiene on the import path.
 *
 * A CSV is where the dead addresses come from — typo'd, pasted two-to-a-cell,
 * exported from a system that wrote "yok". Until now every one of those rows
 * landed with `emailVerifiedStatus: 'UNKNOWN'`, which `buildAudienceWhere`
 * admits, so the whole list went out and the bounces burned the shared sender.
 *
 * The verdict taken here is SYNTAX ONLY, on purpose: `verify()` does a DNS
 * round trip with a 2.5 s timeout and the lead write below sits inside
 * `prisma.$transaction`, so a per-row lookup would hold a pooled connection for
 * the length of the lookup and turn a 5k-row import into hours. The MX half
 * belongs to a background sweep over `UNKNOWN`.
 */
describe('ImportService — email hygiene at the write', () => {
  const baseJob = {
    id: 'imp-1',
    workspaceId: WS,
    status: 'RUNNING',
    mapping: { business: 'businessName', email: 'email' },
    errors: null,
    dedupePolicy: 'CREATE',
  };

  function arrange(raw: Record<string, string>, over: Record<string, unknown> = {}) {
    const ctx = makeSvc();
    ctx.prisma.importJob.findUnique.mockResolvedValue({ ...baseJob, ...over } as any);
    ctx.prisma.importJobRow.findMany.mockResolvedValue([{ id: 'r1', rowIndex: 0, raw }] as any);
    ctx.prisma.lead.findFirst.mockResolvedValue(null as any);
    (ctx.prisma.lead.create as jest.Mock).mockResolvedValue({ id: 'lead-1' });
    (ctx.prisma.lead.update as jest.Mock).mockResolvedValue({});
    (ctx.prisma.importJobRow.update as jest.Mock).mockResolvedValue({});
    (ctx.prisma.importJob.update as jest.Mock).mockResolvedValue({});
    (ctx.prisma.importJobRow.count as jest.Mock).mockResolvedValue(0);
    return ctx;
  }

  it('stamps an unusable imported address INVALID, so the send gate refuses it', async () => {
    const { prisma, svc } = arrange({ business: 'Acme', email: 'a@x.com, b@y.com' });
    await svc.processBatch('imp-1', 0);
    const data = (prisma.lead.create as jest.Mock).mock.calls[0][0].data;
    expect(data.emailVerifiedStatus).toBe('INVALID');
    // The raw value is KEPT so a rep can repair it in the UI — the INVALID
    // verdict (SuppressionService reads it) is what stops the send, and the
    // gateway's single-recipient guard is the backstop if anything tries.
    expect(data.email).toBe('a@x.com, b@y.com');
  });

  it('stamps a typo-d address INVALID too', async () => {
    const { prisma, svc } = arrange({ business: 'Acme', email: 'ada@ x.com' });
    await svc.processBatch('imp-1', 0);
    expect((prisma.lead.create as jest.Mock).mock.calls[0][0].data.emailVerifiedStatus).toBe('INVALID');
  });

  it('leaves a well-formed address UNKNOWN — syntax never claims deliverable', async () => {
    const { prisma, svc } = arrange({ business: 'Acme', email: 'ada@x.com' });
    await svc.processBatch('imp-1', 0);
    expect((prisma.lead.create as jest.Mock).mock.calls[0][0].data.emailVerifiedStatus).toBe('UNKNOWN');
  });

  it('never blocks on DNS: an import row costs no network call', async () => {
    const { prisma, svc } = arrange({ business: 'Acme', email: 'ada@x.com' });
    await svc.processBatch('imp-1', 0);
    // The transaction callback ran to completion synchronously against the mock;
    // a `verify()` call here would have needed dns/resolveMx, which is not mocked
    // in this suite at all.
    expect(prisma.lead.create).toHaveBeenCalled();
  });

  it('re-verdicts only when the UPDATE actually writes a DIFFERENT address', async () => {
    const { prisma, svc } = arrange(
      { business: 'Acme', email: 'broken@ x.com' },
      { dedupePolicy: 'UPDATE', mapping: { business: 'businessName', email: 'email', phone: 'phone' } },
    );
    prisma.lead.findFirst.mockResolvedValue({
      id: 'existing-1', customFields: {}, status: 'NEW', convertedTenantId: null,
      emailNormalized: 'good@x.com', phoneNormalized: null,
    } as any);
    await svc.processBatch('imp-1', 0);
    expect((prisma.lead.update as jest.Mock).mock.calls[0][0].data.emailVerifiedStatus).toBe('INVALID');
  });

  it('does NOT re-verdict an unchanged address (a VALID lead stays VALID)', async () => {
    const { prisma, svc } = arrange(
      { business: 'Acme', email: 'Good@X.com' },
      { dedupePolicy: 'UPDATE' },
    );
    prisma.lead.findFirst.mockResolvedValue({
      id: 'existing-1', customFields: {}, status: 'NEW', convertedTenantId: null,
      emailNormalized: 'good@x.com', phoneNormalized: null,
    } as any);
    await svc.processBatch('imp-1', 0);
    // Writing the syntax verdict here would downgrade an MX-proven VALID to
    // UNKNOWN on every re-import of the same list.
    expect((prisma.lead.update as jest.Mock).mock.calls[0][0].data.emailVerifiedStatus).toBeUndefined();
  });

  it('does NOT re-verdict an address the single-key-match rule preserved', async () => {
    const { prisma, svc } = arrange(
      { business: 'Acme', phone: '05001112233', email: 'junk@ x.com' },
      { dedupePolicy: 'UPDATE', mapping: { business: 'businessName', phone: 'phone', email: 'email' } },
    );
    prisma.lead.findFirst.mockResolvedValue({
      id: 'existing-1', customFields: {}, status: 'NEW', convertedTenantId: null,
      emailNormalized: 'old@x.com', phoneNormalized: '905001112233',
    } as any);
    await svc.processBatch('imp-1', 0);
    const data = (prisma.lead.update as jest.Mock).mock.calls[0][0].data;
    expect(data.email).toBeUndefined(); // preserved
    expect(data.emailVerifiedStatus).toBeUndefined(); // so its verdict is too
  });
});

/**
 * An opt-out column in the CSV.
 *
 * Every CRM export carries one, and there was no way to map it: re-importing a
 * list you had already scrubbed silently un-suppressed nobody (the flag was
 * never written) and re-mailed everyone who had unsubscribed elsewhere.
 *
 * The direction is one-way by design. A blank or falsey cell means "this export
 * did not say", never "this person consented" — a symmetric mapping would let
 * one sloppy CSV clear every opt-out in the workspace.
 */
describe('ImportService — opt-out columns', () => {
  const baseJob = {
    id: 'imp-1',
    workspaceId: WS,
    status: 'RUNNING',
    mapping: { business: 'businessName', email: 'email', unsub: 'emailOptOut' },
    errors: null,
    dedupePolicy: 'CREATE',
  };

  function arrange(raw: Record<string, string>, over: Record<string, unknown> = {}) {
    const ctx = makeSvc();
    ctx.prisma.importJob.findUnique.mockResolvedValue({ ...baseJob, ...over } as any);
    ctx.prisma.importJobRow.findMany.mockResolvedValue([{ id: 'r1', rowIndex: 0, raw }] as any);
    ctx.prisma.lead.findFirst.mockResolvedValue(null as any);
    (ctx.prisma.lead.create as jest.Mock).mockResolvedValue({ id: 'lead-1' });
    (ctx.prisma.lead.update as jest.Mock).mockResolvedValue({});
    (ctx.prisma.importJobRow.update as jest.Mock).mockResolvedValue({});
    (ctx.prisma.importJob.update as jest.Mock).mockResolvedValue({});
    (ctx.prisma.importJobRow.count as jest.Mock).mockResolvedValue(0);
    return ctx;
  }

  it('suggests the opt-out columns from the headers a real export uses', () => {
    const { svc } = makeSvc();
    expect(svc.suggestMapping(['Unsubscribed', 'SMS Opt Out', 'Abonelikten çıktı'])).toEqual({
      Unsubscribed: 'emailOptOut',
      'SMS Opt Out': 'smsOptOut',
      'Abonelikten çıktı': 'emailOptOut',
    });
  });

  it('never suggests a Turkish CONSENT column as an opt-out column', () => {
    // "E-posta izni" / "SMS izni" mean PERMISSION, not refusal: a truthy
    // "Evet" is the customer agreeing. Read as an opt-out it inverts the
    // whole file — every consenting contact suppressed, every refusing one
    // left mailable — and the importer only ever writes `true`, so a
    // corrected re-import cannot undo it.
    // Every spelling an export actually writes, because the folding is the
    // whole risk: a variant that slips through is the same inverted file.
    const { svc } = makeSvc();
    expect(
      svc.suggestMapping([
        'E-posta izni',
        'E-Posta Izni',
        'e-posta izni',
        'E-POSTA İZNİ',
        'Eposta izni',
        'SMS izni',
        'SMS İzni',
        'İzin',
      ]),
    ).toEqual({
      'E-posta izni': '__skip',
      'E-Posta Izni': '__skip',
      'e-posta izni': '__skip',
      'E-POSTA İZNİ': '__skip',
      'Eposta izni': '__skip',
      'SMS izni': '__skip',
      'SMS İzni': '__skip',
      'İzin': '__skip',
    });
  });

  it('sets emailOptOut for a truthy cell and records the withdrawal in the consent ledger', async () => {
    const { prisma, consentLedger, svc } = arrange({ business: 'Acme', email: 'a@x.com', unsub: 'yes' });
    await svc.processBatch('imp-1', 0);
    expect((prisma.lead.create as jest.Mock).mock.calls[0][0].data.emailOptOut).toBe(true);
    // The repo rule: an opt-out flag is never flipped without a dated record
    // behind it. The ledger write is the audit half — side-effect free, so one
    // CSV cannot enqueue an İYS job per row.
    expect(consentLedger.record).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        leadIds: ['lead-1'],
        type: 'MARKETING_EMAIL',
        granted: false,
        source: 'import:imp-1',
      }),
    );
  });

  it('accepts the spellings an export actually contains', async () => {
    for (const cell of ['TRUE', '1', 'Evet', 'unsubscribed', 'x', 'opted out']) {
      const { prisma, svc } = arrange({ business: 'Acme', email: 'a@x.com', unsub: cell });
      await svc.processBatch('imp-1', 0);
      expect((prisma.lead.create as jest.Mock).mock.calls[0][0].data.emailOptOut).toBe(true);
    }
  });

  it('a falsey or unrecognised cell writes NOTHING — it never clears an existing opt-out', async () => {
    for (const cell of ['', 'no', 'FALSE', '0', 'hayır', 'maybe']) {
      const { prisma, consentLedger, svc } = arrange(
        { business: 'Acme', email: 'a@x.com', unsub: cell },
        { dedupePolicy: 'UPDATE' },
      );
      prisma.lead.findFirst.mockResolvedValue({
        id: 'existing-1', customFields: {}, status: 'NEW', convertedTenantId: null,
        emailNormalized: 'a@x.com', phoneNormalized: null,
      } as any);
      await svc.processBatch('imp-1', 0);
      const data = (prisma.lead.update as jest.Mock).mock.calls[0][0].data;
      expect('emailOptOut' in data).toBe(false);
      expect(consentLedger.record).not.toHaveBeenCalled();
    }
  });

  it('maps the SMS and WhatsApp columns to their own consent types', async () => {
    const { prisma, consentLedger, svc } = arrange(
      { business: 'Acme', sms: 'yes', wa: 'yes' },
      { mapping: { business: 'businessName', sms: 'smsOptOut', wa: 'waOptOut' } },
    );
    await svc.processBatch('imp-1', 0);
    const data = (prisma.lead.create as jest.Mock).mock.calls[0][0].data;
    expect(data.smsOptOut).toBe(true);
    expect(data.waOptOut).toBe(true);
    const types = consentLedger.record.mock.calls.map((c: any[]) => c[0].type);
    expect(types).toEqual(expect.arrayContaining(['MARKETING_SMS', 'MARKETING_WHATSAPP']));
  });

  it('records consent AFTER the row commits, and a ledger failure never fails the row', async () => {
    const { prisma, consentLedger, svc } = arrange({ business: 'Acme', email: 'a@x.com', unsub: 'yes' });
    consentLedger.record.mockRejectedValue(new Error('ledger down'));
    await svc.processBatch('imp-1', 0);
    // The lead is in and the row is DONE — the audit row is best-effort, the
    // flag on the lead is the part that actually suppresses.
    expect(prisma.importJobRow.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DONE' }) }),
    );
    expect(consentLedger.record).toHaveBeenCalled();
  });

  it('writes no ledger row for a lead that was skipped (no lead to attach it to)', async () => {
    const { prisma, consentLedger, svc } = arrange(
      { business: 'Acme', email: 'a@x.com', unsub: 'yes' },
      { dedupePolicy: 'SKIP' },
    );
    prisma.lead.findFirst.mockResolvedValue({ id: 'existing-1', customFields: {} } as any);
    await svc.processBatch('imp-1', 0);
    expect(consentLedger.record).not.toHaveBeenCalled();
  });
});
