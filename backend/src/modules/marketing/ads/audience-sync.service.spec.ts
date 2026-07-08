import { createHash } from 'node:crypto';
import { AudienceSyncService } from './audience-sync.service';
import {
  createCustomAudience,
  addAudienceUsers,
  createLookalikeAudience,
} from './meta-ads-management.client';

jest.mock('./meta-ads-management.client', () => ({
  createCustomAudience: jest.fn(),
  addAudienceUsers: jest.fn(),
  createLookalikeAudience: jest.fn(),
}));
jest.mock('../../../common/crypto/secret-box.helper', () => ({
  openSecret: jest.fn((s: string) => s),
}));

const mockCreate = createCustomAudience as jest.Mock;
const mockUpload = addAudienceUsers as jest.Mock;
const mockLookalike = createLookalikeAudience as jest.Mock;

const hex = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');

describe('AudienceSyncService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let compiler: { compile: jest.Mock };
  let capabilities: { canSyncAudience: jest.Mock };
  let svc: AudienceSyncService;

  const account = { id: 'acc-1', workspaceId: WS, provider: 'META', externalAdId: 'act_123', accessToken: 'sealed' };
  const segment = { id: 'seg-1', workspaceId: WS, name: 'VIP', definition: {} };

  beforeEach(() => {
    prisma = {
      adAccount: { findFirst: jest.fn().mockResolvedValue(account), update: jest.fn().mockResolvedValue({}) },
      segment: { findFirst: jest.fn().mockResolvedValue(segment) },
      segmentAudienceSync: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      lead: {
        count: jest.fn().mockResolvedValue(3),
        findMany: jest.fn(),
      },
    };
    compiler = { compile: jest.fn().mockReturnValue({}) };
    capabilities = { canSyncAudience: jest.fn().mockReturnValue(true) };
    mockCreate.mockReset().mockResolvedValue({ ok: true, id: 'aud-9' });
    mockUpload.mockReset().mockResolvedValue({ ok: true, numReceived: 2, numInvalid: 0 });
    mockLookalike.mockReset().mockResolvedValue({ ok: true, id: 'lal-1' });
    svc = new AudienceSyncService(prisma as any, compiler as any, capabilities as any);
  });

  it('throws when Meta audience sync is not available (inert without creds)', async () => {
    capabilities.canSyncAudience.mockReturnValue(false);
    await expect(svc.syncSegment(WS, 'seg-1', 'acc-1')).rejects.toThrow(/not available/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('creates the audience, uploads hashed consenting members, excludes opt-outs, and persists SYNCED', async () => {
    prisma.lead.findMany.mockResolvedValueOnce([
      { emailNormalized: 'ada@x.com', phoneNormalized: '05551112233', emailOptOut: false, smsOptOut: false, emailVerifiedStatus: 'VALID' },
      { emailNormalized: 'opt@x.com', phoneNormalized: '05559998877', emailOptOut: true, smsOptOut: true, emailVerifiedStatus: 'VALID' }, // fully opted out → excluded
      { emailNormalized: 'bad@x.com', phoneNormalized: null, emailOptOut: false, smsOptOut: false, emailVerifiedStatus: 'INVALID' }, // invalid email, no phone → excluded
    ]);

    const res = await svc.syncSegment(WS, 'seg-1', 'acc-1', { includePhone: true });

    expect(mockCreate).toHaveBeenCalledWith('sealed', 'act_123', expect.objectContaining({ name: 'CRM: VIP' }));
    expect(mockUpload).toHaveBeenCalledTimes(1);
    const [, audienceId, schema, rows, session] = mockUpload.mock.calls[0];
    expect(audienceId).toBe('aud-9');
    expect(schema).toEqual(['EMAIL', 'PHONE']);
    // Only the consenting lead survives, hashed.
    expect(rows).toEqual([[hex('ada@x.com'), hex('905551112233')]]);
    expect(session).toMatchObject({ batch_seq: 1, last_batch_flag: true, estimated_num_total: 3 });

    expect(prisma.segmentAudienceSync.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ externalAudienceId: 'aud-9', status: 'SYNCED', lastCount: 1 }),
      }),
    );
    expect(res).toMatchObject({ audienceId: 'aud-9', uploaded: 1, status: 'SYNCED' });
  });

  it('reuses the existing Meta audience id on re-sync instead of creating a duplicate', async () => {
    prisma.segmentAudienceSync.findUnique.mockResolvedValue({ externalAudienceId: 'aud-existing', lookalikeAudienceId: null });
    prisma.lead.findMany.mockResolvedValueOnce([
      { emailNormalized: 'ada@x.com', phoneNormalized: null, emailOptOut: false, smsOptOut: false, emailVerifiedStatus: 'VALID' },
    ]);
    await svc.syncSegment(WS, 'seg-1', 'acc-1', { includePhone: false });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpload.mock.calls[0][1]).toBe('aud-existing');
    expect(mockUpload.mock.calls[0][2]).toEqual(['EMAIL']); // phone excluded
  });

  it('scopes the ad account to the workspace (multi-tenant guard)', async () => {
    prisma.lead.findMany.mockResolvedValueOnce([]);
    prisma.lead.count.mockResolvedValue(0);
    await svc.syncSegment(WS, 'seg-1', 'acc-1');
    expect(prisma.adAccount.findFirst).toHaveBeenCalledWith({ where: { id: 'acc-1', workspaceId: WS } });
    expect(prisma.segment.findFirst).toHaveBeenCalledWith({ where: { id: 'seg-1', workspaceId: WS } });
  });

  it('seeds a Lookalike best-effort after the upload when requested', async () => {
    prisma.lead.findMany.mockResolvedValueOnce([
      { emailNormalized: 'ada@x.com', phoneNormalized: null, emailOptOut: false, smsOptOut: false, emailVerifiedStatus: 'VALID' },
    ]);
    const res = await svc.syncSegment(WS, 'seg-1', 'acc-1', { createLookalike: true, country: 'tr', ratio: 0.03 });
    expect(mockLookalike).toHaveBeenCalledWith('sealed', 'act_123', expect.objectContaining({ seedAudienceId: 'aud-9', country: 'TR', ratio: 0.03 }));
    expect(res.lookalikeId).toBe('lal-1');
  });
});
