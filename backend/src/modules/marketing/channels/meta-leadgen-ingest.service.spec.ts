import { MetaLeadgenIngestService } from './meta-leadgen-ingest.service';
import { metaGraphFetch } from '../../../common/util/meta-graph.util';

jest.mock('../../../common/util/meta-graph.util', () => ({
  metaGraphFetch: jest.fn(),
}));
const mockGraph = metaGraphFetch as jest.Mock;

/**
 * Meta Lead Ads (Instant Form) ingestion: a `leadgen` webhook change → fetch the
 * full submission by leadgen_id with the Page token → create an ADS-source CRM
 * lead, idempotent on externalRef, attributed to the sourcing ad.
 */
describe('MetaLeadgenIngestService', () => {
  const WS = 'ws-1';
  const CHANNEL = { id: 'ch-1', workspaceId: WS, externalId: 'page-1' };
  const CONFIG: any = { secrets: { pageAccessToken: 'PAGE_TOKEN' } };
  let prisma: any;
  let outbox: { append: jest.Mock };
  let autoAssigner: { pickAssignee: jest.Mock };
  let leadAttribution: { capture: jest.Mock };
  let svc: MetaLeadgenIngestService;

  const fieldData = [
    { name: 'full_name', values: ['Ada Lovelace'] },
    { name: 'email', values: ['ada@x.com'] },
    { name: 'phone_number', values: ['5551112233'] },
  ];

  beforeEach(() => {
    prisma = {
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
    leadAttribution = { capture: jest.fn().mockResolvedValue(undefined) };
    mockGraph.mockReset().mockResolvedValue({
      ok: true,
      data: { field_data: fieldData, campaign_id: 'cmp-9', ad_id: 'ad-9' },
      error: null,
    });
    svc = new MetaLeadgenIngestService(
      prisma as any,
      outbox as any,
      autoAssigner as any,
      leadAttribution as any,
    );
  });

  it('fetches the submission and creates an ADS-source lead with externalRef + LeadCreated + attribution', async () => {
    await svc.ingest(CHANNEL, CONFIG, { leadgen_id: 'lg-100', campaign_id: 'cmp-1' });

    // Fetched /{leadgen_id} with the Page token.
    expect(mockGraph).toHaveBeenCalledTimes(1);
    expect(mockGraph.mock.calls[0][0]).toBe('/lg-100');
    expect(mockGraph.mock.calls[0][1]).toMatchObject({ accessToken: 'PAGE_TOKEN', method: 'GET' });

    const data = prisma.lead.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      workspaceId: WS,
      source: 'ADS',
      status: 'NEW',
      email: 'ada@x.com',
      phone: '5551112233',
      contactPerson: 'Ada Lovelace',
      externalRef: 'fbleadgen:lg-100',
    });

    const types = outbox.append.mock.calls.map((c) => c[0].type);
    expect(types).toContain('marketing.lead.created.v1');

    // Attribution ties the lead to the sourcing ad campaign (change value wins over graph body).
    expect(leadAttribution.capture).toHaveBeenCalledTimes(1);
    const [ws, leadId, , source] = leadAttribution.capture.mock.calls[0];
    expect(ws).toBe(WS);
    expect(leadId).toBe('lead-1');
    expect(source).toEqual({ sourceAdCampaignId: 'cmp-1' });
  });

  it('is idempotent: a redelivered leadgen with an already-ingested externalRef does not re-fetch or re-create', async () => {
    prisma.lead.findFirst.mockResolvedValueOnce({ id: 'lead-existing' }); // externalRef pre-check hit
    await svc.ingest(CHANNEL, CONFIG, { leadgen_id: 'lg-100' });
    expect(mockGraph).not.toHaveBeenCalled();
    expect(prisma.lead.create).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('swallows a P2002 create race (concurrent redelivery) without throwing', async () => {
    prisma.lead.create.mockRejectedValueOnce({ code: 'P2002' });
    await expect(svc.ingest(CHANNEL, CONFIG, { leadgen_id: 'lg-100' })).resolves.toBeUndefined();
    // No LeadCreated emitted for the losing race.
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('skips (no fetch, no create) when the channel has no Page token', async () => {
    await svc.ingest(CHANNEL, { secrets: {} } as any, { leadgen_id: 'lg-100' });
    expect(mockGraph).not.toHaveBeenCalled();
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('skips creation when the Graph fetch fails', async () => {
    mockGraph.mockResolvedValueOnce({ ok: false, status: 400, data: {}, error: { message: 'bad' } });
    await svc.ingest(CHANNEL, CONFIG, { leadgen_id: 'lg-100' });
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('flattens first_name + last_name into the contact name and maps phone_number', async () => {
    mockGraph.mockResolvedValueOnce({
      ok: true,
      error: null,
      data: {
        field_data: [
          { name: 'first_name', values: ['Grace'] },
          { name: 'last_name', values: ['Hopper'] },
          { name: 'phone_number', values: ['5559998877'] },
        ],
      },
    });
    await svc.ingest(CHANNEL, CONFIG, { leadgen_id: 'lg-200' });
    const data = prisma.lead.create.mock.calls[0][0].data;
    expect(data.contactPerson).toBe('Grace Hopper');
    expect(data.phone).toBe('5559998877');
  });

  it('de-dupes onto an existing lead by email without creating a duplicate', async () => {
    // externalRef pre-check misses, then the in-tx normalized-email dedup hits.
    prisma.lead.findFirst
      .mockResolvedValueOnce(null) // externalRef pre-check
      .mockResolvedValueOnce({ id: 'lead-dupe', status: 'NEW' }); // in-tx email dedup
    await svc.ingest(CHANNEL, CONFIG, { leadgen_id: 'lg-300' });
    expect(prisma.lead.create).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });
});
