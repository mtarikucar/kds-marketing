import { BadRequestException } from '@nestjs/common';
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerCampaignsTools } from './campaigns.tools';

const deps = () => ({
  campaigns: {
    list: jest.fn(),
    get: jest.fn(),
    performance: jest.fn(),
    launch: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
    cancel: jest.fn(),
  } as any,
});

describe('campaigns MCP tools', () => {
  it('registers jeeta.list_campaigns and jeeta.get_campaign_performance as ungated READs', () => {
    const registry = new McpToolRegistry();
    registerCampaignsTools(registry, deps());

    const list = registry.get('jeeta.list_campaigns')!;
    expect(list.risk).toBe('READ');
    expect(list.requiresApproval).toBe(false);
    expect(list.scopes).toEqual(['campaigns.read']);
    expect(list.inputSchema).toBeDefined();

    const perf = registry.get('jeeta.get_campaign_performance')!;
    expect(perf.risk).toBe('READ');
    expect(perf.requiresApproval).toBe(false);
    expect(perf.scopes).toEqual(['reports.read']);
    expect(perf.inputSchema).toBeDefined();
  });

  it('gates jeeta.set_campaign_status behind PUBLISH approval', () => {
    const registry = new McpToolRegistry();
    registerCampaignsTools(registry, deps());
    const tool = registry.get('jeeta.set_campaign_status')!;
    expect(tool.requiresApproval).toBe(true);
    expect(tool.approvalKind).toBe('PUBLISH');
    expect(tool.risk).toBe('WRITE');
    expect(tool.scopes).toEqual(['campaigns.send']);
    expect(tool.inputSchema).toBeDefined();
  });

  it('hides set_campaign_status from a read-only caller', () => {
    const registry = new McpToolRegistry();
    registerCampaignsTools(registry, deps());
    expect(registry.list(['campaigns.read', 'reports.read']).map((t) => t.name)).not.toContain(
      'jeeta.set_campaign_status',
    );
  });

  it('jeeta.list_campaigns forwards to CampaignsService.list', async () => {
    const registry = new McpToolRegistry();
    const list = jest.fn().mockResolvedValue([{ id: 'camp1' }]);
    registerCampaignsTools(registry, { campaigns: { ...deps().campaigns, list } as any });
    const out = await registry
      .get('jeeta.list_campaigns')!
      .handler({ workspaceId: 'ws1', grantedScopes: ['campaigns.read'] }, {});
    expect(list).toHaveBeenCalledWith('ws1');
    expect(out).toEqual([{ id: 'camp1' }]);
  });

  it('jeeta.get_campaign_performance forwards to CampaignsService.performance, not get()', async () => {
    const registry = new McpToolRegistry();
    const performance = jest.fn().mockResolvedValue({ id: 'camp1', stats: { sent: 10 } });
    const get = jest.fn();
    registerCampaignsTools(registry, { campaigns: { ...deps().campaigns, performance, get } as any });
    const out = await registry
      .get('jeeta.get_campaign_performance')!
      .handler({ workspaceId: 'ws1', grantedScopes: ['reports.read'] }, { campaignId: 'camp1' });
    expect(performance).toHaveBeenCalledWith('ws1', 'camp1');
    expect(get).not.toHaveBeenCalled();
    expect(out).toEqual({ id: 'camp1', stats: { sent: 10 } });
  });

  describe('jeeta.set_campaign_status dispatch', () => {
    it('PAUSED calls pause()', async () => {
      const registry = new McpToolRegistry();
      const pause = jest.fn().mockResolvedValue({ message: 'Campaign paused' });
      registerCampaignsTools(registry, { campaigns: { ...deps().campaigns, pause } as any });
      const out = await registry
        .get('jeeta.set_campaign_status')!
        .handler({ workspaceId: 'ws1', grantedScopes: ['campaigns.send'] }, { campaignId: 'camp1', status: 'PAUSED' });
      expect(pause).toHaveBeenCalledWith('ws1', 'camp1');
      expect(out).toEqual({ message: 'Campaign paused' });
    });

    it('CANCELLED calls cancel()', async () => {
      const registry = new McpToolRegistry();
      const cancel = jest.fn().mockResolvedValue({ message: 'Campaign cancelled' });
      registerCampaignsTools(registry, { campaigns: { ...deps().campaigns, cancel } as any });
      const out = await registry
        .get('jeeta.set_campaign_status')!
        .handler({ workspaceId: 'ws1', grantedScopes: ['campaigns.send'] }, { campaignId: 'camp1', status: 'CANCELLED' });
      expect(cancel).toHaveBeenCalledWith('ws1', 'camp1');
      expect(out).toEqual({ message: 'Campaign cancelled' });
    });

    it('SENDING on a DRAFT/SCHEDULED campaign calls launch()', async () => {
      const registry = new McpToolRegistry();
      const get = jest.fn().mockResolvedValue({ id: 'camp1', status: 'DRAFT' });
      const launch = jest.fn().mockResolvedValue({ message: 'Campaign launched' });
      const resume = jest.fn();
      registerCampaignsTools(registry, { campaigns: { ...deps().campaigns, get, launch, resume } as any });
      const out = await registry
        .get('jeeta.set_campaign_status')!
        .handler({ workspaceId: 'ws1', grantedScopes: ['campaigns.send'] }, { campaignId: 'camp1', status: 'SENDING' });
      expect(get).toHaveBeenCalledWith('ws1', 'camp1');
      expect(launch).toHaveBeenCalledWith('ws1', 'camp1');
      expect(resume).not.toHaveBeenCalled();
      expect(out).toEqual({ message: 'Campaign launched' });
    });

    it('SENDING on a PAUSED campaign calls resume()', async () => {
      const registry = new McpToolRegistry();
      const get = jest.fn().mockResolvedValue({ id: 'camp1', status: 'PAUSED' });
      const resume = jest.fn().mockResolvedValue({ message: 'Campaign resumed' });
      const launch = jest.fn();
      registerCampaignsTools(registry, { campaigns: { ...deps().campaigns, get, resume, launch } as any });
      const out = await registry
        .get('jeeta.set_campaign_status')!
        .handler({ workspaceId: 'ws1', grantedScopes: ['campaigns.send'] }, { campaignId: 'camp1', status: 'SENDING' });
      expect(get).toHaveBeenCalledWith('ws1', 'camp1');
      expect(resume).toHaveBeenCalledWith('ws1', 'camp1');
      expect(launch).not.toHaveBeenCalled();
      expect(out).toEqual({ message: 'Campaign resumed' });
    });

    it('an unrecognised status is rejected, not silently ignored', async () => {
      const registry = new McpToolRegistry();
      const { pause, cancel, launch, resume, get } = deps().campaigns;
      registerCampaignsTools(registry, { campaigns: { ...deps().campaigns, pause, cancel, launch, resume, get } as any });
      await expect(
        registry
          .get('jeeta.set_campaign_status')!
          .handler(
            { workspaceId: 'ws1', grantedScopes: ['campaigns.send'] },
            // Not one of the enum's three values — Zod validation is a
            // separate, pre-existing concern (not enforced on this handler
            // path); the handler's own dispatch must still refuse it rather
            // than falling through as a silent no-op.
            { campaignId: 'camp1', status: 'DELETED' },
          ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(pause).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    });
  });
});
