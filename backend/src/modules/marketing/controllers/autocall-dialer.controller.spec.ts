import { AutocallDialerController } from './autocall-dialer.controller';
import { REQUIRES_FEATURE_KEY } from '../guards/feature.guard';

function makeController(overrides: { dialer?: any } = {}) {
  const dialer =
    overrides.dialer ??
    ({
      getActive: jest.fn().mockResolvedValue(null),
      start: jest.fn().mockResolvedValue({ sessionId: 'sess-1' }),
      stop: jest.fn().mockResolvedValue({ ok: true }),
    } as any);
  return { ctrl: new AutocallDialerController(dialer), dialer };
}

const USER = { id: 'u-1', workspaceId: 'ws-1', role: 'MANAGER' } as any;

describe('AutocallDialerController', () => {
  it('active() delegates to AutocallDialerService.getActive with the workspace id', async () => {
    const { ctrl, dialer } = makeController();
    await ctrl.active(USER);
    expect(dialer.getActive).toHaveBeenCalledWith('ws-1');
  });

  it('start() delegates to AutocallDialerService.start with workspace/user/role/dto', async () => {
    const { ctrl, dialer } = makeController();
    const dto = { queueName: 'sales-queue' } as any;
    await ctrl.start(dto, USER);
    expect(dialer.start).toHaveBeenCalledWith('ws-1', 'u-1', 'MANAGER', dto);
  });

  it('stop() delegates to AutocallDialerService.stop with workspace/sessionId/user', async () => {
    const { ctrl, dialer } = makeController();
    await ctrl.stop({ sessionId: 'sess-1' } as any, USER);
    expect(dialer.stop).toHaveBeenCalledWith('ws-1', 'sess-1', 'u-1');
  });

  /**
   * Final-review fix M4 (owner-confirm, aligned to the Phase-5 plan): the
   * parallel power dialer must gate on `voiceCampaigns` (SCALE+/add-on), NOT
   * the base `telephony` key every other Netsantral-surface controller uses
   * — otherwise a workspace entitled to `telephony` alone (inbound/basic
   * PBX) gets the paid parallel dialer for free. `FeatureGuard` reads this
   * class-level metadata via `Reflector.getAllAndOverride` at request time:
   * a workspace with `telephony` but not `voiceCampaigns` gets a 403 on
   * every route here (`active`/`start`/`stop`, none override it); a
   * workspace with `voiceCampaigns` is allowed through.
   */
  it('is gated on the voiceCampaigns feature (not telephony)', () => {
    expect(Reflect.getMetadata(REQUIRES_FEATURE_KEY, AutocallDialerController)).toBe('voiceCampaigns');
  });
});
