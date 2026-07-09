import { TelephonyQueueController } from './telephony-queue.controller';
import { MarketingUserPayload } from '../types';

const USER = { id: 'rep-1', workspaceId: 'ws-1', role: 'REP' } as MarketingUserPayload;

function makeController() {
  const queues = { stats: jest.fn(), setPresence: jest.fn() };
  const ctrl = new TelephonyQueueController(queues as any);
  return { queues, ctrl };
}

describe('TelephonyQueueController', () => {
  it('GET queues/stats delegates to the service with the workspace (no queue filter)', async () => {
    const { queues, ctrl } = makeController();
    queues.stats.mockResolvedValue({ queues: [] });

    const res = await ctrl.stats(USER);

    expect(queues.stats).toHaveBeenCalledWith('ws-1', undefined);
    expect(res).toEqual({ queues: [] });
  });

  it('GET queues/stats forwards an optional `queue` query param', async () => {
    const { queues, ctrl } = makeController();
    queues.stats.mockResolvedValue({ queues: [] });

    await ctrl.stats(USER, '8508407303-queue-sales');

    expect(queues.stats).toHaveBeenCalledWith('ws-1', '8508407303-queue-sales');
  });

  it('POST agent/presence delegates the body through with workspace + the CALLING user id', async () => {
    const { queues, ctrl } = makeController();
    queues.setPresence.mockResolvedValue({ ok: true, state: 'break' });
    const dto = { state: 'break' as const, reason: 'Lunch' };

    const res = await ctrl.presence(dto, USER);

    expect(queues.setPresence).toHaveBeenCalledWith('ws-1', 'rep-1', dto);
    expect(res).toEqual({ ok: true, state: 'break' });
  });
});
