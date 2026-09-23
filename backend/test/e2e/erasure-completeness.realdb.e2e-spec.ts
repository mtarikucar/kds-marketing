import { randomUUID } from 'node:crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { SuppressionService } from '../../src/modules/marketing/compliance/suppression.service';
import { MAIL_CLASSES } from '../../src/modules/marketing/channels/outbound/mail-class';
import {
  createRealDbTestApp,
  closeTestApp,
  realDbEnabled,
  signMarketingToken,
} from '../utils/test-app';

/**
 * Does "permanently delete this person" actually delete them — everywhere?
 *
 * `compliance.service.spec.ts` can only ever re-assert the table list its
 * author already remembered: `$transaction` is mocked to pass `prisma`
 * straight through, so every assertion is `expect(prisma.<table>.deleteMany)
 * .toHaveBeenCalledWith(...)` over the SAME hand-written list the
 * implementation walks. A PII table added next month is missed silently, and
 * `fulfillErasure` anonymises in place rather than deleting the Lead row — so
 * no `onDelete: Cascade` ever fires to catch it for free (`erasure-test`).
 *
 * This lane closes that hole by asking POSTGRES instead of asking the code.
 * One unique sentinel token is seeded into the subject everywhere it can
 * reach, the erasure is driven through the real MANAGER-gated HTTP route, and
 * then `information_schema` is walked at runtime: EVERY text / varchar / json /
 * jsonb / text[] column of EVERY base table is searched for the sentinel, and
 * it may survive only in {@link RETAINED_TABLES}.
 *
 * That inversion is the whole point. A NEW table defaults to "must be clean":
 * whoever adds one either scrubs it in `fulfillErasure` or has to come here and
 * justify the exemption in writing. Nothing is silent.
 *
 * Opt-in via E2E_REAL_DB=1 (`npm run test:e2e:realdb`); the database is
 * restored to its baseline in `afterAll`.
 */

const SEED = `erz-${randomUUID().slice(0, 8)}`;
/** The needle. Unique per run, so a neighbouring suite's rows can never be a
 *  false positive and this spec can scan the WHOLE database, not its own rows. */
const SENTINEL = `kvkk-${randomUUID()}`;

const SUBJECT_EMAIL = `${SENTINEL}@example.com`;
/** The lead that was merged INTO the subject — same human, second address. */
const MERGED_EMAIL = `merged-${SENTINEL}@example.com`;
const SUBJECT_PHONE = '+90 555 111 22 33';
const SUBJECT_PHONE_DIGITS = '905551112233';
/** The neighbour who merely unsubscribed. Deliberately sentinel-free: their
 *  row must survive the scan, and R3 must be able to put them BACK on the
 *  list, which an erasure tombstone would (correctly) make impossible. */
const NEIGHBOUR_EMAIL = `neighbour-${SEED}@example.com`;

/**
 * Where the sentinel is ALLOWED to survive — the RETAIN tier of
 * `fulfillErasure`'s own docstring, and nothing else.
 *
 * Turkish tax law mandates ~10-year retention of financial records and the
 * e-sign trail is the evidence that an agreement was consented to, so these
 * rows stay and simply come to reference an anonymised lead. Every entry is a
 * deliberate, named exemption:
 *
 *  - `invoices` / `estimates` — VUK 253 retention; the free-text `notes` is
 *    part of the document that must survive intact.
 *  - `documents` — the e-sign audit trail (`signerName` / `signerEmail` /
 *    `bodySnapshot`). Scrubbing it would destroy the proof of the signature it
 *    exists to hold.
 *  - `consent_records` — the ledger proving we were allowed to write at all. An
 *    erasure that deletes the consent proof deletes our own defence.
 *  - the membership / loyalty / commerce rows below, all named in the RETAIN
 *    tier, which keep pointing at the now-anonymised lead.
 *
 * DELIBERATELY ABSENT, although the docstring retains the ROW:
 *  `campaign_recipients`. The row is kept for campaign statistics, but its one
 *  free-text column (`error`, the provider's verbatim line) is scrubbed — so
 *  leaving the table OUT of this list is strictly stronger, and the scrub is
 *  what the test then proves.
 */
const RETAINED_TABLES: ReadonlySet<string> = new Set([
  'invoices',
  'estimates',
  'documents',
  'consent_records',
  'commissions',
  'customer_wallets',
  'wallet_ledger_entries',
  'workspace_subscriptions',
  'customer_subscriptions',
  'coupon_redemptions',
  'points_ledger',
  'opportunities',
  'enrollments',
  'certificates',
  'tags',
  'lead_tags',
  'badges',
  'earned_badges',
  'communities',
  'community_members',
  'community_posts',
  'community_comments',
  'custom_object_links',
]);

interface SentinelHit {
  table: string;
  column: string;
}

/**
 * Every place in the database the sentinel is still readable.
 *
 * Columns are DISCOVERED, never listed: that is what makes the answer stay
 * true when the schema grows. `::text` covers jsonb/json and text[] alike, so
 * a payload that buried the address inside a blob is found too.
 */
async function scanForSentinel(prisma: PrismaService, needle: string): Promise<SentinelHit[]> {
  const columns = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND t.table_type = 'BASE TABLE'
       AND c.table_name <> '_prisma_migrations'
       AND (c.data_type IN ('text', 'character varying', 'json', 'jsonb')
            OR c.udt_name IN ('_text', '_varchar'))
     ORDER BY c.table_name, c.column_name
  `;

  const quote = (id: string) => `"${id.replace(/"/g, '""')}"`;
  const hits: SentinelHit[] = [];
  // One EXISTS per column, batched into a handful of round trips: each probe
  // stops at the first matching row, so the cost is a short scan of small
  // tables rather than a full read of the database.
  const BATCH = 120;
  for (let i = 0; i < columns.length; i += BATCH) {
    const chunk = columns.slice(i, i + BATCH);
    const sql = chunk
      .map(
        (c) =>
          `SELECT '${c.table_name}' AS t, '${c.column_name}' AS c` +
          ` WHERE EXISTS (SELECT 1 FROM ${quote(c.table_name)}` +
          ` WHERE ${quote(c.column_name)}::text LIKE $1)`,
      )
      .join(' UNION ALL ');
    const found = await prisma.$queryRawUnsafe<Array<{ t: string; c: string }>>(sql, `%${needle}%`);
    for (const row of found) hits.push({ table: row.t, column: row.c });
  }
  return hits;
}

const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Erasure completeness — real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let suppression: SuppressionService;

  const workspaceId = randomUUID();
  const managerId = randomUUID();
  const repId = randomUUID();
  /** The subject: the named lead, plus two merged-away copies of the same human. */
  const subjectId = randomUUID();
  const mergedOnceId = randomUUID();
  const mergedTwiceId = randomUUID();
  /** A second person on the same tenant who must come through untouched. */
  const neighbourId = randomUUID();

  const importJobId = randomUUID();
  const triggerLinkId = randomUUID();
  const surveyId = randomUUID();
  const campaignId = randomUUID();
  const workflowRunId = randomUUID();
  const conversationId = randomUUID();
  const channelId = randomUUID();

  let erasureRequestId: string;

  const asManager = () =>
    `Bearer ${signMarketingToken({ sub: managerId, wsp: workspaceId, role: 'MANAGER' })}`;
  const asRep = () => `Bearer ${signMarketingToken({ sub: repId, wsp: workspaceId, role: 'REP' })}`;

  beforeAll(async () => {
    if (!realDbEnabled()) return;
    // Without a pepper the ContactSuppression table is SKIPPED entirely and the
    // verdict falls back to the lead flags — which the erasure is about to null.
    // The tombstone only exists when this is set (suppression.service `hash`).
    process.env.MARKETING_SECRET_KEY = Buffer.from(`erasure-e2e-pepper-${SEED}`).toString('base64');

    ({ app, prisma } = await createRealDbTestApp());
    suppression = app.get(SuppressionService);

    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: SEED,
        name: 'Erasure E2E',
        productName: 'Acme POS',
        status: 'ACTIVE',
      },
    });

    await prisma.marketingUser.createMany({
      data: [
        {
          id: managerId,
          workspaceId,
          // Sentinel-free on purpose: the AuditInterceptor stamps the ACTOR's
          // address onto every audit row, and a sentinel there would make the
          // scan red for the operator's data rather than the subject's.
          email: `manager-${SEED}@example.com`,
          password: 'seed-not-a-real-hash',
          firstName: 'Mine',
          lastName: 'Manager',
          role: 'MANAGER',
          status: 'ACTIVE',
        },
        {
          id: repId,
          workspaceId,
          email: `rep-${SEED}@example.com`,
          password: 'seed-not-a-real-hash',
          firstName: 'Remzi',
          lastName: 'Rep',
          role: 'REP',
          status: 'ACTIVE',
        },
      ],
    });
    await prisma.workspaceMembership.createMany({
      data: [
        { userId: managerId, workspaceId, role: 'MANAGER', status: 'ACTIVE' },
        { userId: repId, workspaceId, role: 'REP', status: 'ACTIVE' },
      ],
    });

    // ── the subject, as a two-hop merge chain ────────────────────────────────
    // A merge only stamps `mergedIntoId`; it never scrubs the row it folded
    // away. C→B→A is a legal pair of merges, so the subject's PII sits two hops
    // from the id the request names.
    await prisma.lead.createMany({
      data: [
        {
          id: subjectId,
          workspaceId,
          businessName: `${SENTINEL} Ltd`,
          contactPerson: `${SENTINEL} Kişi`,
          email: SUBJECT_EMAIL,
          emailNormalized: SUBJECT_EMAIL,
          phone: SUBJECT_PHONE,
          phoneNormalized: SUBJECT_PHONE_DIGITS,
          address: `${SENTINEL} Sokak 1`,
          city: 'İzmir',
          notes: `İletişim: ${SUBJECT_EMAIL}`,
          businessType: 'CAFE',
          source: 'WEBSITE',
        },
        {
          id: mergedOnceId,
          workspaceId,
          mergedIntoId: subjectId,
          businessName: `${SENTINEL} Şube`,
          contactPerson: `${SENTINEL} Kişi`,
          email: MERGED_EMAIL,
          emailNormalized: MERGED_EMAIL,
          businessType: 'CAFE',
          source: 'REFERRAL',
        },
        {
          id: mergedTwiceId,
          workspaceId,
          mergedIntoId: mergedOnceId,
          businessName: 'Eski Kayıt',
          contactPerson: `${SENTINEL} Kişi`,
          notes: `Eski not: ${SENTINEL}`,
          businessType: 'CAFE',
          source: 'PHONE',
        },
        {
          id: neighbourId,
          workspaceId,
          businessName: 'Komşu Kafe',
          contactPerson: 'Nazlı Neighbour',
          email: NEIGHBOUR_EMAIL,
          emailNormalized: NEIGHBOUR_EMAIL,
          businessType: 'CAFE',
          source: 'WEBSITE',
        },
      ],
    });

    // ── DELETE tier: pure communication / behavioural / identity data ────────
    await prisma.conversation.create({
      data: {
        id: conversationId,
        workspaceId,
        channelId,
        leadId: subjectId,
        subject: `Re: ${SENTINEL}`,
      },
    });
    await prisma.message.create({
      data: {
        workspaceId,
        conversationId,
        direction: 'INBOUND',
        authorType: 'CUSTOMER',
        body: `Merhaba, ben ${SENTINEL}. Bana ${SUBJECT_EMAIL} adresinden ulaşın.`,
      },
    });
    await prisma.leadActivity.create({
      data: {
        leadId: subjectId,
        createdById: managerId,
        type: 'EMAIL',
        title: `E-posta: ${SUBJECT_EMAIL}`,
        description: `Görüşme notu — ${SENTINEL}`,
      },
    });
    await prisma.contactIdentity.create({
      data: { workspaceId, channelId, kind: 'WA', value: `wa-${SENTINEL}`, leadId: subjectId },
    });
    await prisma.leadAttribution.create({
      data: {
        workspaceId,
        leadId: subjectId,
        landingUrl: `https://acme.test/?e=${SUBJECT_EMAIL}`,
        raw: { email: SUBJECT_EMAIL },
      },
    });
    await prisma.triggerLink.create({
      data: { id: triggerLinkId, workspaceId, name: 'Kampanya', slug: `lnk-${SEED}`, targetUrl: 'https://acme.test/x' },
    });
    await prisma.triggerLinkClick.create({
      data: { workspaceId, triggerLinkId, leadId: subjectId, userAgent: `UA ${SENTINEL}`, ip: '10.0.0.1' },
    });
    await prisma.survey.create({ data: { id: surveyId, workspaceId, name: 'Memnuniyet' } });
    await prisma.surveyResponse.create({
      data: { surveyId, workspaceId, leadId: subjectId, answers: { email: SUBJECT_EMAIL } },
    });
    await prisma.voiceCall.create({
      data: {
        workspaceId,
        channelId,
        leadId: subjectId,
        externalCallId: `call-${randomUUID()}`,
        fromNumber: SUBJECT_PHONE,
        toNumber: '+908500000000',
        lastGatherToken: SENTINEL,
      },
    });
    await prisma.salesCall.create({
      data: {
        workspaceId,
        leadId: subjectId,
        toPhone: SUBJECT_PHONE,
        providerId: 'netgsm-lite',
        notes: `Arama notu — ${SENTINEL}`,
      },
    });
    await prisma.workflowStepRun.create({
      data: {
        workspaceId,
        runId: workflowRunId,
        stepIndex: 0,
        stepType: 'send_email',
        status: 'DONE',
        output: { to: SUBJECT_EMAIL },
        error: `hata: ${SENTINEL}`,
      },
    });

    // ── SCRUB tier: rows that must SURVIVE, emptied of the subject's words ───
    // These four are the known holes the finding names by id: without them the
    // scan passes while the leftovers stay live.
    await prisma.distributionDraft.create({
      data: {
        workspaceId,
        planId: randomUUID(),
        campaignItemId: randomUUID(),
        leadId: subjectId,
        channelType: 'EMAIL',
        channelId,
        toAddress: SUBJECT_EMAIL,
        body: `Merhaba ${SENTINEL},`,
        error: `gönderilemedi: ${SENTINEL}`,
      },
    });
    await prisma.importJob.create({
      data: { id: importJobId, workspaceId, filename: 'leads.csv', status: 'DONE' },
    });
    await prisma.importJobRow.create({
      data: {
        importJobId,
        rowIndex: 0,
        raw: { email: SUBJECT_EMAIL, name: SENTINEL },
        status: 'DONE',
        leadId: subjectId,
        error: `çakışma: ${SENTINEL}`,
      },
    });
    await prisma.researchCandidate.create({
      data: {
        workspaceId,
        profileId: randomUUID(),
        // NO sentinel: `externalRef` is the dedupe key that stops the next
        // research run re-ingesting the person we are erasing, so it is kept on
        // purpose — seeding the needle here would red the scan on correct
        // behaviour.
        externalRef: `ref-${SEED}`,
        businessName: `${SENTINEL} Ltd`,
        businessType: 'CAFE',
        email: SUBJECT_EMAIL,
        phone: SUBJECT_PHONE,
        instagram: `@${SENTINEL}`,
        website: `https://${SENTINEL}.test`,
        painPoint: `POS yok — ${SENTINEL}`,
        evidence: SENTINEL,
        pitch: SENTINEL,
        leadId: subjectId,
      },
    });
    await prisma.workflowRun.create({
      data: {
        id: workflowRunId,
        workspaceId,
        workflowId: randomUUID(),
        leadId: subjectId,
        status: 'WAITING',
        cursor: {},
        context: { email: SUBJECT_EMAIL, name: SENTINEL },
        lastError: `hata: ${SENTINEL}`,
      },
    });
    await prisma.booking.create({
      data: {
        workspaceId,
        calendarId: randomUUID(),
        leadId: subjectId,
        startAt: new Date(),
        endAt: new Date(Date.now() + 3_600_000),
        name: `${SENTINEL} Kişi`,
        email: SUBJECT_EMAIL,
        phone: SUBJECT_PHONE,
        notes: `Randevu notu — ${SENTINEL}`,
        token: `bk-${randomUUID()}`,
      },
    });
    await prisma.campaign.create({
      data: { id: campaignId, workspaceId, name: 'Eylül', channel: 'EMAIL', body: 'Merhaba' },
    });
    await prisma.campaignRecipient.create({
      data: {
        workspaceId,
        campaignId,
        leadId: subjectId,
        token: `cr-${randomUUID()}`,
        status: 'FAILED',
        error: `550 unknown recipient ${SUBJECT_EMAIL}`,
      },
    });
    // A prior EXPORT snapshotted the subject's FULL PII into a durable Json
    // blob. An erasure that leaves it behind leaves a complete plaintext copy.
    await prisma.dataRequest.create({
      data: {
        workspaceId,
        leadId: subjectId,
        kind: 'EXPORT',
        status: 'COMPLETED',
        completedAt: new Date(),
        payload: { lead: { email: SUBJECT_EMAIL, contactPerson: SENTINEL } },
      },
    });

    // ── RETAIN tier: the rows that legally outlive the person ───────────────
    await prisma.estimate.create({
      data: {
        workspaceId,
        leadId: subjectId,
        number: `EST-${SEED}`,
        items: [],
        notes: `Teklif alıcısı: ${SUBJECT_EMAIL}`,
        publicToken: `et-${randomUUID()}`,
      },
    });
    await prisma.invoice.create({
      data: {
        workspaceId,
        leadId: subjectId,
        number: `INV-${SEED}`,
        items: [],
        notes: `Fatura alıcısı: ${SUBJECT_EMAIL}`,
        publicToken: `it-${randomUUID()}`,
      },
    });
    await prisma.document.create({
      data: {
        workspaceId,
        leadId: subjectId,
        title: 'Hizmet sözleşmesi',
        body: 'Taraflar…',
        status: 'SIGNED',
        signerName: `${SENTINEL} Kişi`,
        signerEmail: SUBJECT_EMAIL,
        signedAt: new Date(),
      },
    });
    await prisma.consentRecord.create({
      data: {
        workspaceId,
        leadId: subjectId,
        type: 'MARKETING_EMAIL',
        granted: true,
        source: `form:${SUBJECT_EMAIL}`,
      },
    });
  });

  afterAll(async () => {
    if (!realDbEnabled() || !prisma) return;
    const del = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* best-effort teardown — never let cleanup throw */
      }
    };
    try {
      await del(() => prisma.dataRequest.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.consentRecord.deleteMany({ where: { workspaceId } }));
      // The ERASURE tombstone outlives the lead row by design, so teardown has
      // to name it or this spec stops restoring its baseline.
      await del(() => prisma.contactSuppression.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.campaignRecipient.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.campaign.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.document.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.invoice.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.estimate.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.distributionDraft.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.researchCandidate.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.workflowStepRun.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.workflowRun.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.importJobRow.deleteMany({ where: { importJobId } }));
      await del(() => prisma.importJob.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.surveyResponse.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.survey.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.triggerLinkClick.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.triggerLink.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.booking.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.voiceCall.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.salesCall.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.message.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.conversation.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.contactIdentity.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.leadAttribution.deleteMany({ where: { workspaceId } }));
      // LeadActivity.createdById is Restrict onto MarketingUser, so the
      // activities have to go before the users. Deleting the leads cascades
      // them, which is why the leads come first.
      await del(() => prisma.lead.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.auditLog.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.workspaceMembership.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.marketingUser.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.workspace.deleteMany({ where: { id: workspaceId } }));
    } finally {
      delete process.env.MARKETING_SECRET_KEY;
      await closeTestApp(app);
    }
  });

  it('a REP cannot fulfil an erasure — the request stays PENDING', async () => {
    const raised = await request(app.getHttpServer())
      .post(`/api/marketing/compliance/leads/${subjectId}/erasure`)
      .set('Authorization', asManager());
    expect(raised.status).toBe(201);
    erasureRequestId = raised.body.id;
    expect(raised.body.status).toBe('PENDING');

    await request(app.getHttpServer())
      .post(`/api/marketing/compliance/requests/${erasureRequestId}/fulfill`)
      .set('Authorization', asRep())
      .expect(403);

    const row = await prisma.dataRequest.findFirst({ where: { id: erasureRequestId, workspaceId } });
    expect(row?.status).toBe('PENDING');
    // …and nothing was scrubbed on the way to the 403.
    const lead = await prisma.lead.findUnique({ where: { id: subjectId } });
    expect(lead?.email).toBe(SUBJECT_EMAIL);
  });

  it('the manager fulfils it, and the WHOLE merge chain is anonymised', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/marketing/compliance/requests/${erasureRequestId}/fulfill`)
      .set('Authorization', asManager());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'COMPLETED', leadId: subjectId });

    // Two hops from the id the request named, not one.
    for (const id of [subjectId, mergedOnceId, mergedTwiceId]) {
      const row = await prisma.lead.findUnique({ where: { id } });
      expect(row?.contactPerson).toBe('[Silinmiş]');
      expect(row?.businessName).toBe('[Silinmiş]');
      expect(row?.email).toBeNull();
      expect(row?.phone).toBeNull();
      expect(row?.emailNormalized).toBeNull();
      expect(row?.phoneNormalized).toBeNull();
      expect(row?.notes).toBeNull();
      expect(row?.deletedAt).not.toBeNull();
      expect(row?.emailOptOut).toBe(true);
    }

    // The neighbour is a different person and comes through untouched.
    const neighbour = await prisma.lead.findUnique({ where: { id: neighbourId } });
    expect(neighbour?.email).toBe(NEIGHBOUR_EMAIL);
    expect(neighbour?.deletedAt).toBeNull();
  });

  it('leaves an ERASURE tombstone for BOTH the address and the phone, readable by neither', async () => {
    const rows = await prisma.contactSuppression.findMany({ where: { workspaceId, reason: 'ERASURE' } });

    // Both addresses in the chain, plus the phone: a tombstone per identifier
    // the subject was reachable at, not one per lead row.
    expect(rows.filter((r) => r.kind === 'EMAIL')).toHaveLength(2);
    expect(rows.filter((r) => r.kind === 'PHONE')).toHaveLength(1);
    for (const row of rows) {
      expect(row.source).toBe(`erasure:${erasureRequestId}`);
      expect(row.liftedAt).toBeNull();
      // Hashed, not stored: the tombstone outlives the address WITHOUT being a
      // readable copy of the person we just erased.
      expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain(SUBJECT_PHONE_DIGITS);
  });

  it('refuses the erased address for every mail class except INTERNAL', async () => {
    // The lead row no longer carries the address, so ONLY the tombstone can
    // answer this — which is exactly the hole it was written to close.
    for (const mailClass of MAIL_CLASSES) {
      const verdict = await suppression.check(workspaceId, SUBJECT_EMAIL, mailClass, { proactive: true });
      if (mailClass === 'INTERNAL') {
        // The recipient of INTERNAL mail is one of OUR users, never a data
        // subject on a tenant's list, so a tenant tombstone does not speak
        // about them.
        expect(verdict).toEqual({ suppressed: false });
      } else {
        expect(verdict).toEqual({ suppressed: true, reason: 'ERASURE' });
      }
    }

    // The merged-away second address is covered too, and the neighbour is not.
    expect(await suppression.check(workspaceId, MERGED_EMAIL, 'BULK')).toEqual({
      suppressed: true,
      reason: 'ERASURE',
    });
    expect(await suppression.check(workspaceId, NEIGHBOUR_EMAIL, 'BULK')).toEqual({ suppressed: false });
  });

  it('scrubs the residual PII the anonymise-in-place path used to leave behind', async () => {
    // The DELETE tier really is gone…
    expect(await prisma.message.count({ where: { workspaceId, conversationId } })).toBe(0);
    expect(await prisma.conversation.count({ where: { workspaceId, leadId: subjectId } })).toBe(0);
    expect(await prisma.leadActivity.count({ where: { leadId: subjectId } })).toBe(0);
    expect(await prisma.contactIdentity.count({ where: { workspaceId, leadId: subjectId } })).toBe(0);
    expect(await prisma.leadAttribution.count({ where: { workspaceId, leadId: subjectId } })).toBe(0);
    expect(await prisma.triggerLinkClick.count({ where: { workspaceId, leadId: subjectId } })).toBe(0);
    expect(await prisma.surveyResponse.count({ where: { workspaceId, leadId: subjectId } })).toBe(0);
    expect(await prisma.voiceCall.count({ where: { workspaceId, leadId: subjectId } })).toBe(0);
    expect(await prisma.salesCall.count({ where: { workspaceId, leadId: subjectId } })).toBe(0);
    expect(await prisma.workflowStepRun.count({ where: { workspaceId, runId: workflowRunId } })).toBe(0);

    // …and the SCRUB tier survived, emptied. Each row is kept for a reason the
    // erasure must not break: the research dedupe key, the import's progress
    // count, the anti-restack unique, the campaign's own statistics, and the
    // WAITING run that still has to be stopped on resume.
    const run = await prisma.workflowRun.findUnique({ where: { id: workflowRunId } });
    expect(run).not.toBeNull();
    expect(run?.context).toEqual({});
    expect(run?.lastError).toBeNull();

    const draft = await prisma.distributionDraft.findFirst({ where: { workspaceId, leadId: subjectId } });
    expect(draft?.toAddress).toBe('[Silinmiş]');
    expect(draft?.body).toBe('');
    expect(draft?.status).toBe('DISMISSED');

    // The relation filter in `importJobRow.updateMany` (the row table has no
    // workspaceId of its own) is only ever executed by a real query engine —
    // a mocked spec accepts any `where` you hand it.
    const importRow = await prisma.importJobRow.findFirst({ where: { importJobId } });
    expect(importRow?.raw).toEqual({});
    expect(importRow?.error).toBeNull();

    const candidate = await prisma.researchCandidate.findFirst({ where: { workspaceId, leadId: subjectId } });
    expect(candidate?.externalRef).toBe(`ref-${SEED}`);
    expect(candidate?.email).toBeNull();
    expect(candidate?.businessName).toBe('[Silinmiş]');

    const booking = await prisma.booking.findFirst({ where: { workspaceId, leadId: subjectId } });
    expect(booking?.name).toBe('[Silinmiş]');
    expect(booking?.email).toBeNull();

    const recipient = await prisma.campaignRecipient.findFirst({ where: { workspaceId, leadId: subjectId } });
    expect(recipient?.error).toBeNull();

    // A prior EXPORT's plaintext snapshot is dropped; the audit row stays.
    const exported = await prisma.dataRequest.findFirst({
      where: { workspaceId, leadId: subjectId, kind: 'EXPORT' },
    });
    expect(exported?.payload).toBeNull();
    expect(exported?.kind).toBe('EXPORT');
  });

  it('the sentinel survives NOWHERE but the tables the law keeps', async () => {
    const hits = await scanForSentinel(prisma, SENTINEL);
    const leaked = hits.filter((h) => !RETAINED_TABLES.has(h.table));

    // Compared as `table.column` strings rather than as a count, so the failure
    // diff NAMES what was left behind — whoever added the column then knows
    // exactly what to scrub, or which exemption to come here and justify.
    expect(leaked.map((h) => `${h.table}.${h.column}`).sort()).toEqual([]);

    // …and the scan is not vacuously green: the retained rows DO still hold it,
    // which is what proves the needle was seeded and the search can find it.
    const retained = new Set(hits.map((h) => h.table));
    expect(retained.has('estimates')).toBe(true);
    expect(retained.has('invoices')).toBe(true);
    expect(retained.has('documents')).toBe(true);
    expect(retained.has('consent_records')).toBe(true);
  });

  it('a second fulfil is refused — the erasure cannot run twice', async () => {
    await request(app.getHttpServer())
      .post(`/api/marketing/compliance/requests/${erasureRequestId}/fulfill`)
      .set('Authorization', asManager())
      .expect(400);
  });

  it('re-consent restores an ordinary opt-out, but never lifts an erasure (R3)', async () => {
    const consent = (leadId: string, granted: boolean) =>
      request(app.getHttpServer())
        .post(`/api/marketing/compliance/leads/${leadId}/consent`)
        .set('Authorization', asManager())
        .send({ type: 'MARKETING_EMAIL', granted, source: 'e2e' });

    await consent(neighbourId, false).expect(201);
    expect(await suppression.check(workspaceId, NEIGHBOUR_EMAIL, 'BULK')).toEqual({
      suppressed: true,
      reason: 'OPT_OUT',
    });

    // Clearing the flag alone would leave a stale ContactSuppression row behind
    // and the neighbour permanently unmailable — the drift R3 exists to stop.
    await consent(neighbourId, true).expect(201);
    expect(await suppression.check(workspaceId, NEIGHBOUR_EMAIL, 'BULK')).toEqual({ suppressed: false });
    const lifted = await prisma.contactSuppression.findFirst({
      where: { workspaceId, kind: 'EMAIL', reason: 'OPT_OUT' },
    });
    expect(lifted?.liftedAt).not.toBeNull();

    // A tombstone is the one thing consent cannot undo. The route accepts the
    // write (it does not special-case a soft-deleted lead), but the erasure
    // nulled `emailNormalized`, so there is no address for the lift to walk —
    // and `SuppressionService.lift` refuses an ERASURE reason outright.
    await consent(subjectId, true).expect(201);
    const tombstones = await prisma.contactSuppression.findMany({
      where: { workspaceId, reason: 'ERASURE' },
    });
    expect(tombstones).toHaveLength(3);
    expect(tombstones.every((t) => t.liftedAt === null)).toBe(true);
    expect(await suppression.check(workspaceId, SUBJECT_EMAIL, 'BULK')).toEqual({
      suppressed: true,
      reason: 'ERASURE',
    });
  });
});
