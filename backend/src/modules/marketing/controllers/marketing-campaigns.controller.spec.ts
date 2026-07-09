import { MarketingCampaignsController } from './marketing-campaigns.controller';
import { REQUIRES_FEATURE_KEY } from '../guards/feature.guard';
import { REQUIRE_PERMISSION_KEY } from '../roles/require-permission.decorator';

function makeController(overrides: { voiceAudio?: any } = {}) {
  const campaigns = {} as any;
  const link = { provisionFromBlast: jest.fn().mockResolvedValue({ socialCampaignId: 'sc-1' }) } as any;
  const voiceAudio = overrides.voiceAudio ?? ({} as any);
  return new MarketingCampaignsController(campaigns, link, voiceAudio);
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
