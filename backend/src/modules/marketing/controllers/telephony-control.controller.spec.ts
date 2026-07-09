import { TelephonyControlController } from './telephony-control.controller';
import { MarketingUserPayload } from '../types';

const USER = { id: 'rep-1', workspaceId: 'ws-1', role: 'REP' } as MarketingUserPayload;

function makeController() {
  const control = { hangup: jest.fn(), transfer: jest.fn(), mute: jest.fn() };
  const ctrl = new TelephonyControlController(control as any);
  return { control, ctrl };
}

describe('TelephonyControlController', () => {
  it('POST :id/hangup delegates to the service with workspace + user', async () => {
    const { control, ctrl } = makeController();
    control.hangup.mockResolvedValue({ ok: true });

    const res = await ctrl.hangup('call-1', USER);

    expect(control.hangup).toHaveBeenCalledWith('ws-1', 'call-1', USER);
    expect(res).toEqual({ ok: true });
  });

  it('POST :id/transfer delegates the body through to the service', async () => {
    const { control, ctrl } = makeController();
    control.transfer.mockResolvedValue({ ok: true });
    const dto = { targetDahili: '105', attended: true };

    const res = await ctrl.transfer('call-1', dto as any, USER);

    expect(control.transfer).toHaveBeenCalledWith('ws-1', 'call-1', USER, dto);
    expect(res).toEqual({ ok: true });
  });

  it('POST :id/mute delegates the body through to the service', async () => {
    const { control, ctrl } = makeController();
    control.mute.mockResolvedValue({ ok: true });
    const dto = { on: true };

    const res = await ctrl.mute('call-1', dto as any, USER);

    expect(control.mute).toHaveBeenCalledWith('ws-1', 'call-1', USER, dto);
    expect(res).toEqual({ ok: true });
  });
});
