import { CopilotController } from './copilot.controller';
import { MarketingUserPayload } from '../types';

const USER = { id: 'u1', workspaceId: 'ws-1', role: 'REP' } as MarketingUserPayload;

function makeController(result: any = { suggestions: ['a'], summary: 's' }) {
  const service = { suggest: jest.fn().mockResolvedValue(result) };
  const ctrl = new CopilotController(service as any);
  return { service, ctrl };
}

describe('CopilotController', () => {
  it('POST suggest passes workspaceId + agentProfileId + transcript through', async () => {
    const { service, ctrl } = makeController();
    const r = await ctrl.suggest({ agentProfileId: 'agent-1', transcript: 'Customer: hi' }, USER);

    expect(service.suggest).toHaveBeenCalledWith('ws-1', 'agent-1', 'Customer: hi');
    expect(r).toEqual({ suggestions: ['a'], summary: 's' });
  });

  it('tolerates a missing agentProfileId (passes null)', async () => {
    const { service, ctrl } = makeController();
    await ctrl.suggest({ transcript: 'Customer: hi' }, USER);
    expect(service.suggest).toHaveBeenCalledWith('ws-1', null, 'Customer: hi');
  });
});
