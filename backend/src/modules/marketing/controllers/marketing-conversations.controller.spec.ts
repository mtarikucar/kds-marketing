import 'reflect-metadata';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { MarketingConversationsController } from './marketing-conversations.controller';

/**
 * The inbox list's query surface.
 *
 * `list()` is a pure pass-through, so the only thing that can be wrong with it
 * is the STRING inside `@Query(...)` — and that string is invisible to every
 * other test. The service spec calls `svc.list(ws, { leadId })` directly and
 * the real-DB e2e calls the service too, so a controller that read
 * `@Query('lead_id')` would leave both green while the lead detail page
 * silently received the entire workspace inbox: a wrong key is not an error,
 * it is `undefined`, and `undefined` means "no filter".
 *
 * So this reads the parameter metadata Nest itself will use at request time and
 * pins the wire names, mirroring the Reflect.getMetadata pattern in
 * marketing-users.controller.spec.ts (no DI, no HTTP).
 */
function queryKeys(method: string): string[] {
  const meta =
    Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      MarketingConversationsController,
      method,
    ) ?? {};
  return Object.entries(meta as Record<string, { data?: unknown }>)
    .filter(([k]) => k.startsWith(`${RouteParamtypes.QUERY}:`))
    .map(([, v]) => v.data as string)
    .sort();
}

describe('MarketingConversationsController.list — query surface', () => {
  it('accepts leadId on the wire, alongside the filters that were already there', () => {
    expect(queryKeys('list')).toEqual(['assignedToId', 'channelId', 'leadId', 'status']);
  });

  it('forwards every filter to the service under the workspace of the caller', async () => {
    const conversations = { list: jest.fn().mockResolvedValue([]) };
    const controller = new MarketingConversationsController(
      conversations as any,
      {} as any,
      {} as any,
    );

    await controller.list(
      { workspaceId: 'ws-1' } as any,
      'OPEN',
      'ch-1',
      'user-1',
      'lead-1',
    );

    expect(conversations.list).toHaveBeenCalledWith('ws-1', {
      status: 'OPEN',
      channelId: 'ch-1',
      assignedToId: 'user-1',
      leadId: 'lead-1',
    });
  });
});
