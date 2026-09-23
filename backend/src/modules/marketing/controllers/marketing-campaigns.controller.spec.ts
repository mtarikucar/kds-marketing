import { MarketingCampaignsController } from './marketing-campaigns.controller';
import { REQUIRES_FEATURE_KEY } from '../guards/feature.guard';
import { REQUIRE_PERMISSION_KEY } from '../roles/require-permission.decorator';

function makeController(overrides: { voiceAudio?: any; campaigns?: any; preview?: any } = {}) {
  const campaigns = overrides.campaigns ?? ({} as any);
  const link = { provisionFromBlast: jest.fn().mockResolvedValue({ socialCampaignId: 'sc-1' }) } as any;
  const voiceAudio = overrides.voiceAudio ?? ({} as any);
  const preview = overrides.preview ?? ({} as any);
  return new MarketingCampaignsController(campaigns, link, voiceAudio, preview);
}

describe('MarketingCampaignsController.createSocial', () => {
  it('provisions a social campaign from the blast using the caller id', async () => {
    const ctrl = makeController();
    const user = { id: 'u-7', workspaceId: 'ws-1' } as any;

    const out = await ctrl.createSocial(user, 'camp-1');

    expect(out).toEqual({ socialCampaignId: 'sc-1' });
  });
});

// NetGSM Phase 5 Task 4 — voice audio upload endpoint.
describe('MarketingCampaignsController.uploadVoiceAudio', () => {
  it('delegates to VoiceAudioUploadService.upload with the workspace + raw multer file', async () => {
    const voiceAudio = { upload: jest.fn().mockResolvedValue({ audioid: 'aid-1' }) };
    const ctrl = makeController({ voiceAudio });
    const user = { id: 'u-7', workspaceId: 'ws-1' } as any;
    const file = { originalname: 'x.wav', mimetype: 'audio/wav', buffer: Buffer.from('x'), size: 1 };

    const out = await ctrl.uploadVoiceAudio(file as any, user);

    expect(out).toEqual({ audioid: 'aid-1' });
    expect(voiceAudio.upload).toHaveBeenCalledWith('ws-1', file);
  });

  // Guard chain (brief requirement): gated on the `voiceCampaigns` FEATURE
  // (overriding the class's broader `campaigns` requirement) + the
  // `campaigns.send` PERMISSION — asserted via the same metadata keys
  // FeatureGuard/PermissionsGuard read at request time (Reflector.getAllAndOverride
  // checks the handler before the class, so this handler-level value wins).
  it('is guarded on the voiceCampaigns feature + campaigns.send permission', () => {
    const handler = MarketingCampaignsController.prototype.uploadVoiceAudio;
    expect(Reflect.getMetadata(REQUIRES_FEATURE_KEY, handler)).toBe('voiceCampaigns');
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)).toBe('campaigns.send');
  });
});

// prelaunch-safety + campaign-results-unreadable: what the console asks for
// before the irreversible part, and how it reads the results afterwards.
describe('MarketingCampaignsController — the pre-launch surface', () => {
  const user = { id: 'u-7', workspaceId: 'ws-1', email: 'owner@acme.test' } as any;

  it('previews the audience for the caller workspace only', async () => {
    const preview = { audience: jest.fn().mockResolvedValue({ matched: 12 }) };
    const ctrl = makeController({ preview });

    await expect(ctrl.audiencePreview(user, 'camp-1')).resolves.toEqual({ matched: 12 });
    expect(preview.audience).toHaveBeenCalledWith('ws-1', 'camp-1');
  });

  it('test-sends to the acting user, never to an address from the request', async () => {
    const preview = { testSend: jest.fn().mockResolvedValue({ ok: true }) };
    const ctrl = makeController({ preview });

    await ctrl.testSend(user, 'camp-1');

    expect(preview.testSend).toHaveBeenCalledWith('ws-1', 'camp-1', {
      id: 'u-7',
      email: 'owner@acme.test',
    });
  });

  // Sending a real mail is a `campaigns.send` action, not a read.
  it('gates the test send on the campaigns.send permission', () => {
    const handler = MarketingCampaignsController.prototype.testSend;
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)).toBe('campaigns.send');
  });

  it('passes the recipients paging through and never a workspace from the query', async () => {
    const campaigns = { recipients: jest.fn().mockResolvedValue({ rows: [], total: 0 }) };
    const ctrl = makeController({ campaigns });

    await ctrl.recipients(user, 'camp-1', 'FAILED', '50', '25');

    expect(campaigns.recipients).toHaveBeenCalledWith('ws-1', 'camp-1', {
      status: 'FAILED',
      skip: 50,
      take: 25,
    });
  });

  it('asks for the default page when no query is given', async () => {
    const campaigns = { recipients: jest.fn().mockResolvedValue({ rows: [], total: 0 }) };
    const ctrl = makeController({ campaigns });

    await ctrl.recipients(user, 'camp-1');

    expect(campaigns.recipients).toHaveBeenCalledWith('ws-1', 'camp-1', {});
  });
});
