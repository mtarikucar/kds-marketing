import { TelephonyCallbackController } from './telephony-callback.controller';
import { MarketingUserPayload } from '../types';

const USER = { id: 'rep-1', workspaceId: 'ws-1', role: 'REP' } as MarketingUserPayload;

function makeController() {
  const callback = { requestCallback: jest.fn() };
  const ctrl = new TelephonyCallbackController(callback as any);
  return { callback, ctrl };
}

describe('TelephonyCallbackController', () => {
  it('POST callback delegates the workspace + dto to the service', async () => {
    const { callback, ctrl } = makeController();
    callback.requestCallback.mockResolvedValue({ ok: true });
    const dto = { phone: '5551112233', redirectType: 'queue' as const, redirectMenu: '850-queue-vip' };

    const res = await ctrl.request(dto, USER);

    expect(callback.requestCallback).toHaveBeenCalledWith('ws-1', dto);
    expect(res).toEqual({ ok: true });
  });
});
