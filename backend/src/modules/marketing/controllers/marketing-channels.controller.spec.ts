import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { MarketingChannelsController } from './marketing-channels.controller';
import { REQUIRE_PERMISSION_KEY } from '../roles/require-permission.decorator';

/**
 * `no-email-observability` — the two tenant-facing ops routes.
 *
 * Guards are pinned off the prototype the way marketing-approvals.controller
 * .spec.ts does (no DI, no HTTP harness), and the workspace is asserted to come
 * ONLY from the authenticated caller — a `workspaceId` a client could pass is
 * the whole class of cross-tenant bug these routes would otherwise open.
 */

function makeController(over: { channels?: any; mailOps?: any; items?: any } = {}) {
  const channels = over.channels ?? ({} as any);
  const mailOps = over.mailOps ?? { health: jest.fn() };
  const items = over.items ?? { retry: jest.fn(), listForChannel: jest.fn(), get: jest.fn() };
  return {
    channels,
    mailOps,
    items,
    ctrl: new MarketingChannelsController(channels, mailOps, items),
  };
}

const ACTOR = { id: 'u-1', workspaceId: 'ws-1' } as any;

describe('MarketingChannelsController — email health', () => {
  it('answers for the caller workspace only', async () => {
    const mailOps = { health: jest.fn().mockResolvedValue({ workspaceId: 'ws-1', inert: [] }) };
    const { ctrl } = makeController({ mailOps });

    await expect(ctrl.emailHealth(ACTOR)).resolves.toMatchObject({ workspaceId: 'ws-1' });
    expect(mailOps.health).toHaveBeenCalledWith('ws-1');
  });

  it('is guarded on settings.manage', () => {
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSION_KEY, MarketingChannelsController.prototype.emailHealth),
    ).toBe('settings.manage');
  });

  // `@Get(':id')` would swallow `email/health` if it were declared first —
  // the same trap `whatsapp/embedded-signup/config` is placed above.
  it('is declared before the :id route so the static path is not captured', () => {
    const order = Object.getOwnPropertyNames(MarketingChannelsController.prototype);
    expect(order.indexOf('emailHealth')).toBeLessThan(order.indexOf('get'));
    expect(
      Reflect.getMetadata(PATH_METADATA, MarketingChannelsController.prototype.emailHealth),
    ).toBe('email/health');
  });
});

describe('MarketingChannelsController — retrying a quarantined inbound item', () => {
  it('re-arms the item and reports the queued job', async () => {
    const items = {
      get: jest.fn().mockResolvedValue({ id: 'it-1', channelId: 'ch-1' }),
      retry: jest.fn().mockResolvedValue({ ok: true, jobId: 'job-9' }),
      listForChannel: jest.fn(),
    };
    const { ctrl } = makeController({ items });

    await expect(ctrl.retryInboundItem(ACTOR, 'ch-1', 'it-1')).resolves.toEqual({
      ok: true,
      jobId: 'job-9',
    });
    expect(items.retry).toHaveBeenCalledWith('ws-1', 'it-1');
  });

  // The ledger is workspace-scoped already, so this is not an isolation hole —
  // it is a 404 for a URL that does not describe anything, which is what stops
  // a stale card silently retrying a different mailbox's backlog.
  it('refuses an item that does not belong to the channel in the path', async () => {
    const items = {
      get: jest.fn().mockResolvedValue({ id: 'it-1', channelId: 'ch-OTHER' }),
      retry: jest.fn(),
      listForChannel: jest.fn(),
    };
    const { ctrl } = makeController({ items });

    await expect(ctrl.retryInboundItem(ACTOR, 'ch-1', 'it-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(items.retry).not.toHaveBeenCalled();
  });

  it('404s an item this workspace cannot see', async () => {
    const items = { get: jest.fn().mockResolvedValue(null), retry: jest.fn(), listForChannel: jest.fn() };
    const { ctrl } = makeController({ items });
    await expect(ctrl.retryInboundItem(ACTOR, 'ch-1', 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('turns a refusal into a 404 rather than a silent ok', async () => {
    const items = {
      get: jest.fn().mockResolvedValue({ id: 'it-1', channelId: 'ch-1' }),
      retry: jest.fn().mockResolvedValue({ ok: false, reason: 'no-replayer' }),
      listForChannel: jest.fn(),
    };
    const { ctrl } = makeController({ items });
    await expect(ctrl.retryInboundItem(ACTOR, 'ch-1', 'it-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lists one mailbox ledger for the card, scoped to the caller', async () => {
    const items = {
      get: jest.fn(),
      retry: jest.fn(),
      listForChannel: jest.fn().mockResolvedValue([{ id: 'it-1', state: 'QUARANTINED' }]),
    };
    const { ctrl } = makeController({ items });

    await expect(ctrl.listInboundItems(ACTOR, 'ch-1', 'QUARANTINED')).resolves.toEqual([
      { id: 'it-1', state: 'QUARANTINED' },
    ]);
    expect(items.listForChannel).toHaveBeenCalledWith('ws-1', 'ch-1', { state: 'QUARANTINED' });
  });

  it('ignores a state the ledger does not have instead of querying for it', async () => {
    const items = { get: jest.fn(), retry: jest.fn(), listForChannel: jest.fn().mockResolvedValue([]) };
    const { ctrl } = makeController({ items });

    await ctrl.listInboundItems(ACTOR, 'ch-1', 'DROP TABLE');
    expect(items.listForChannel).toHaveBeenCalledWith('ws-1', 'ch-1', {});
  });

  it('guards both routes on settings.manage', () => {
    for (const handler of [
      MarketingChannelsController.prototype.retryInboundItem,
      MarketingChannelsController.prototype.listInboundItems,
    ]) {
      expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)).toBe('settings.manage');
    }
  });
});
