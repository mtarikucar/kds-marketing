import { NotFoundException } from '@nestjs/common';
import { mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../../../prisma/prisma.service';
import { AgencyService } from './agency.service';
import { SnapshotService, SnapshotPayload } from './snapshot.service';

/**
 * Epic D1 — agency config SNAPSHOTS unit specs (no database).
 *
 * Proves:
 *  - capture serializes the CONFIG types (custom-field defs, tags, segments,
 *    workflows, agent profiles, pages, forms, booking calendars, knowledge docs,
 *    review sources) into a portable payload, stripped of id/workspaceId/ts;
 *  - capture EXCLUDES customer data — a lead is never read and never lands in the
 *    payload (asserted by the absence of a lead read + no lead key in payload);
 *  - apply into a child stamps the TARGET workspaceId on every cloned config row;
 *  - apply authorizes via assertAgencyOwns FIRST (rejects a non-child target);
 *  - re-apply is idempotent (existing natural-key rows are skipped, not dup'd);
 *  - cross-agency isolation: get/apply 404 a snapshot owned by another agency.
 */

const AGENCY_A = 'agency-a';
const AGENCY_B = 'agency-b';
const LOCATION_A1 = 'loc-a1';

function makeSvc() {
  const prisma = mockDeep<PrismaService>();
  const agency = mockDeep<AgencyService>();
  // $transaction executes the callback against the mocked prisma as the tx.
  (prisma.$transaction as jest.Mock).mockImplementation(
    (fn: (tx: any) => Promise<any>) => fn(prisma),
  );
  const svc = new SnapshotService(prisma as any, agency as any);
  return { prisma, agency, svc };
}

/** Stub every config findMany to [] except those provided. */
function stubConfigReads(
  prisma: ReturnType<typeof makeSvc>['prisma'],
  over: Partial<Record<string, unknown[]>> = {},
) {
  const empty = (key: string) =>
    (prisma as any)[key].findMany.mockResolvedValue((over[key] ?? []) as never);
  empty('customFieldDef');
  empty('tag');
  empty('segment');
  empty('workflow');
  empty('agentProfile');
  empty('sitePage');
  empty('formDef');
  empty('bookingCalendar');
  empty('knowledgeDoc');
  empty('reviewSource');
}

describe('SnapshotService — capture', () => {
  it('serializes config types into a portable payload, stripped of id/workspaceId/timestamps', async () => {
    const { prisma, svc } = makeSvc();
    stubConfigReads(prisma, {
      customFieldDef: [
        {
          id: 'cf-1',
          workspaceId: AGENCY_A,
          entity: 'LEAD',
          key: 'city',
          label: 'City',
          type: 'TEXT',
          required: true,
          position: 0,
          archived: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      tag: [
        {
          id: 't-1',
          workspaceId: AGENCY_A,
          name: 'VIP',
          nameLower: 'vip',
          color: '#fff',
          createdAt: new Date(),
        },
      ],
      workflow: [
        {
          id: 'wf-1',
          workspaceId: AGENCY_A,
          name: 'Welcome',
          status: 'ACTIVE',
          trigger: { type: 'lead.created' },
          steps: [{ type: 'wait' }],
          version: 1,
          stats: { started: 99 },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    (prisma.snapshot.create as jest.Mock).mockImplementation((args: any) =>
      Promise.resolve({ id: 'snap-1', ...args.data }),
    );

    const snap = await svc.capture(AGENCY_A, { name: 'Base' });
    const payload = snap.payload as unknown as SnapshotPayload;

    // custom field def — portable shape, no id/workspaceId/timestamps.
    expect(payload.customFieldDefs).toHaveLength(1);
    const cf = payload.customFieldDefs[0];
    expect(cf).toMatchObject({ entity: 'LEAD', key: 'city', label: 'City', type: 'TEXT' });
    expect(cf).not.toHaveProperty('id');
    expect(cf).not.toHaveProperty('workspaceId');
    expect(cf).not.toHaveProperty('createdAt');
    expect(cf).not.toHaveProperty('updatedAt');

    // tag carried by nameLower.
    expect(payload.tags[0]).toMatchObject({ name: 'VIP', nameLower: 'vip', color: '#fff' });
    expect(payload.tags[0]).not.toHaveProperty('id');

    // workflow keeps trigger/steps but drops volatile stats.
    expect(payload.workflows[0]).toMatchObject({ name: 'Welcome', status: 'ACTIVE' });
    expect(payload.workflows[0]).toHaveProperty('trigger');
    expect(payload.workflows[0]).not.toHaveProperty('stats');

    // stored as the agency's row.
    expect((prisma.snapshot.create as jest.Mock).mock.calls[0][0].data.workspaceId).toBe(
      AGENCY_A,
    );
  });

  it('strips the sealed accessToken + source-local sync binding from a captured reviewSource (no cross-tenant credential leak)', async () => {
    const { prisma, svc } = makeSvc();
    stubConfigReads(prisma, {
      reviewSource: [
        {
          id: 'rs-1',
          workspaceId: AGENCY_A,
          type: 'GOOGLE',
          name: 'Main Branch',
          placeUrl: 'https://g.page/x',
          placeId: 'places/123',
          accessToken: 'sealed:super-secret-oauth-token',
          externalRef: 'accounts/9/locations/1',
          syncStatus: 'ACTIVE',
          lastSyncedAt: new Date(),
          lastError: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    (prisma.snapshot.create as jest.Mock).mockImplementation((args: any) =>
      Promise.resolve({ id: 'snap-1', ...args.data }),
    );

    const snap = await svc.capture(AGENCY_A, { name: 'Base' });
    const payload = snap.payload as unknown as SnapshotPayload;

    expect(payload.reviewSources).toHaveLength(1);
    const rs = payload.reviewSources[0];
    // The display config is portable...
    expect(rs).toMatchObject({ type: 'GOOGLE', name: 'Main Branch', placeUrl: 'https://g.page/x' });
    // ...but the SEALED credential and the source's provider binding / sync state
    // must NEVER cross into another workspace's clone.
    expect(rs).not.toHaveProperty('accessToken');
    expect(rs).not.toHaveProperty('placeId');
    expect(rs).not.toHaveProperty('externalRef');
    expect(rs).not.toHaveProperty('syncStatus');
    expect(rs).not.toHaveProperty('lastSyncedAt');
    expect(rs).not.toHaveProperty('lastError');
  });

  it('EXCLUDES customer data — never reads leads and no lead lands in the payload', async () => {
    const { prisma, svc } = makeSvc();
    stubConfigReads(prisma, {
      tag: [{ id: 't', workspaceId: AGENCY_A, name: 'X', nameLower: 'x', createdAt: new Date() }],
    });
    (prisma.snapshot.create as jest.Mock).mockImplementation((args: any) =>
      Promise.resolve({ id: 'snap-1', ...args.data }),
    );

    const snap = await svc.capture(AGENCY_A, { name: 'Base' });
    const payload = snap.payload as unknown as SnapshotPayload;

    // The lead delegate is NEVER touched by capture.
    expect(prisma.lead.findMany).not.toHaveBeenCalled();
    expect(prisma.conversation.findMany).not.toHaveBeenCalled();
    expect(prisma.leadOffer.findMany).not.toHaveBeenCalled();
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(prisma.marketingUser.findMany).not.toHaveBeenCalled();

    // No customer-data key exists in the payload at all.
    expect(payload).not.toHaveProperty('leads');
    expect(payload).not.toHaveProperty('conversations');
    expect(payload).not.toHaveProperty('users');
    expect(Object.keys(payload)).toEqual([
      'customFieldDefs',
      'tags',
      'segments',
      'workflows',
      'agentProfiles',
      'sitePages',
      'formDefs',
      'bookingCalendars',
      'knowledgeDocs',
      'reviewSources',
    ]);
  });

  it('rejects capturing from a source that is not the agency or its child', async () => {
    const { svc, agency } = makeSvc();
    (agency.assertAgencyOwns as jest.Mock).mockRejectedValue(
      new NotFoundException('Location not found in this agency'),
    );

    await expect(
      svc.capture(AGENCY_A, { name: 'X', sourceWorkspaceId: 'foreign-ws' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(agency.assertAgencyOwns).toHaveBeenCalledWith(AGENCY_A, 'foreign-ws');
  });
});

describe('SnapshotService — apply', () => {
  const snapshotRow = (payload: Partial<SnapshotPayload>) => ({
    id: 'snap-1',
    workspaceId: AGENCY_A,
    name: 'Base',
    description: null,
    payload: {
      customFieldDefs: [],
      tags: [],
      segments: [],
      workflows: [],
      agentProfiles: [],
      sitePages: [],
      formDefs: [],
      bookingCalendars: [],
      knowledgeDocs: [],
      reviewSources: [],
      ...payload,
    },
    createdAt: new Date(),
  });

  it('authorizes via assertAgencyOwns FIRST and clones config into the TARGET workspace', async () => {
    const { prisma, agency, svc } = makeSvc();
    (agency.assertAgencyOwns as jest.Mock).mockResolvedValue({ id: LOCATION_A1 });
    (prisma.snapshot.findFirst as jest.Mock).mockResolvedValue(
      snapshotRow({
        customFieldDefs: [{ entity: 'LEAD', key: 'city', label: 'City', type: 'TEXT' }],
        tags: [{ name: 'VIP', nameLower: 'vip' }],
      }) as never,
    );
    // Nothing exists in the target yet → everything is created.
    (prisma.customFieldDef.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.tag.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.customFieldDef.create as jest.Mock).mockResolvedValue({ id: 'new-cf' });
    (prisma.tag.create as jest.Mock).mockResolvedValue({ id: 'new-tag' });

    const res = await svc.apply('snap-1', LOCATION_A1, AGENCY_A);

    // assertAgencyOwns ran with the agency + target BEFORE any write.
    expect(agency.assertAgencyOwns).toHaveBeenCalledWith(AGENCY_A, LOCATION_A1);
    // The cloned rows are stamped with the TARGET workspaceId.
    const cfData = (prisma.customFieldDef.create as jest.Mock).mock.calls[0][0].data;
    expect(cfData.workspaceId).toBe(LOCATION_A1);
    expect(cfData.key).toBe('city');
    const tagData = (prisma.tag.create as jest.Mock).mock.calls[0][0].data;
    expect(tagData.workspaceId).toBe(LOCATION_A1);

    expect(res.summary.customFieldDefs).toEqual({ created: 1, skipped: 0 });
    expect(res.summary.tags).toEqual({ created: 1, skipped: 0 });
  });

  it('strips a poisoned reviewSource secret on apply (a snapshot captured before the guard cannot leak)', async () => {
    const { prisma, agency, svc } = makeSvc();
    (agency.assertAgencyOwns as jest.Mock).mockResolvedValue({ id: LOCATION_A1 });
    (prisma.snapshot.findFirst as jest.Mock).mockResolvedValue(
      snapshotRow({
        reviewSources: [
          {
            type: 'GOOGLE',
            name: 'Main',
            placeUrl: 'https://g.page/x',
            // a pre-guard payload still carries the sealed credential + binding
            accessToken: 'sealed:leaked-token',
            placeId: 'places/1',
            externalRef: 'accounts/9/locations/1',
            syncStatus: 'ACTIVE',
            lastSyncedAt: '2026-01-01T00:00:00Z',
            lastError: null,
          },
        ],
      }) as never,
    );
    (prisma.reviewSource.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.reviewSource.create as jest.Mock).mockResolvedValue({ id: 'new-rs' });

    await svc.apply('snap-1', LOCATION_A1, AGENCY_A);

    const data = (prisma.reviewSource.create as jest.Mock).mock.calls[0][0].data;
    expect(data).toMatchObject({
      type: 'GOOGLE',
      name: 'Main',
      placeUrl: 'https://g.page/x',
      workspaceId: LOCATION_A1,
    });
    for (const secret of ['accessToken', 'placeId', 'externalRef', 'syncStatus', 'lastSyncedAt', 'lastError']) {
      expect(data).not.toHaveProperty(secret);
    }
  });

  // `channels` holds workspace-LOCAL Channel ids that are never snapshotted, so a
  // cloned agent must start UNATTACHED — copying the source's ids would leave it
  // "attached" to channels that don't exist in the target (findActiveForChannel
  // never matches them) and show dangling ids in the editor.
  it('clears channels on a cloned agent profile (channel ids are workspace-local, not snapshotted)', async () => {
    const { prisma, agency, svc } = makeSvc();
    (agency.assertAgencyOwns as jest.Mock).mockResolvedValue({ id: LOCATION_A1 });
    (prisma.snapshot.findFirst as jest.Mock).mockResolvedValue(
      snapshotRow({
        agentProfiles: [
          { name: 'Sales bot', persona: 'helpful', channels: ['src-ch-1', 'src-ch-2'] },
        ],
      }) as never,
    );
    (prisma.agentProfile.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.agentProfile.create as jest.Mock).mockResolvedValue({ id: 'new-ag' });

    await svc.apply('snap-1', LOCATION_A1, AGENCY_A);

    const data = (prisma.agentProfile.create as jest.Mock).mock.calls[0][0].data;
    expect(data.workspaceId).toBe(LOCATION_A1);
    expect(data.name).toBe('Sales bot');
    expect(data.channels).toEqual([]);
  });

  it('rejects a target that is not the agency’s child (assertAgencyOwns throws) — no write', async () => {
    const { prisma, agency, svc } = makeSvc();
    (agency.assertAgencyOwns as jest.Mock).mockRejectedValue(
      new NotFoundException('Location not found in this agency'),
    );

    await expect(svc.apply('snap-1', LOCATION_A1, AGENCY_B)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.snapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.customFieldDef.create).not.toHaveBeenCalled();
  });

  it('is idempotent — re-apply skips natural-key rows that already exist (no dupes)', async () => {
    const { prisma, agency, svc } = makeSvc();
    (agency.assertAgencyOwns as jest.Mock).mockResolvedValue({ id: LOCATION_A1 });
    (prisma.snapshot.findFirst as jest.Mock).mockResolvedValue(
      snapshotRow({
        customFieldDefs: [{ entity: 'LEAD', key: 'city', label: 'City', type: 'TEXT' }],
        tags: [{ name: 'VIP', nameLower: 'vip' }],
      }) as never,
    );
    // The target ALREADY has these rows (second apply) → all skipped.
    (prisma.customFieldDef.findFirst as jest.Mock).mockResolvedValue({ id: 'existing-cf' });
    (prisma.tag.findFirst as jest.Mock).mockResolvedValue({ id: 'existing-tag' });

    const res = await svc.apply('snap-1', LOCATION_A1, AGENCY_A);

    expect(prisma.customFieldDef.create).not.toHaveBeenCalled();
    expect(prisma.tag.create).not.toHaveBeenCalled();
    expect(res.summary.customFieldDefs).toEqual({ created: 0, skipped: 1 });
    expect(res.summary.tags).toEqual({ created: 0, skipped: 1 });
  });

  it('cross-agency isolation — apply 404s a snapshot owned by another agency', async () => {
    const { prisma, agency, svc } = makeSvc();
    (agency.assertAgencyOwns as jest.Mock).mockResolvedValue({ id: LOCATION_A1 });
    // The snapshot belongs to AGENCY_A; AGENCY_B's scoped findFirst returns null.
    (prisma.snapshot.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(svc.apply('snap-1', LOCATION_A1, AGENCY_B)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const where = (prisma.snapshot.findFirst as jest.Mock).mock.calls[0][0].where;
    expect(where.workspaceId).toBe(AGENCY_B);
    expect(prisma.customFieldDef.create).not.toHaveBeenCalled();
  });
});

describe('SnapshotService — get / list (cross-agency isolation)', () => {
  it('get 404s a snapshot owned by another agency (scoped by workspaceId)', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.snapshot.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(svc.get(AGENCY_B, 'snap-1')).rejects.toBeInstanceOf(NotFoundException);
    const where = (prisma.snapshot.findFirst as jest.Mock).mock.calls[0][0].where;
    expect(where).toMatchObject({ id: 'snap-1', workspaceId: AGENCY_B });
  });

  it('list is scoped to the agency’s own snapshots', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.snapshot.findMany as jest.Mock).mockResolvedValue([
      { id: 'snap-1', name: 'Base', description: null, createdAt: new Date() },
    ] as never);

    const res = await svc.list(AGENCY_A);
    expect(res).toHaveLength(1);
    const where = (prisma.snapshot.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where).toEqual({ workspaceId: AGENCY_A });
  });
});
