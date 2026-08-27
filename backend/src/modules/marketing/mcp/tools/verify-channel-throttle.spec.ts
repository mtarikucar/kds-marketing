import { z } from 'zod';
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerChannelWriteTools } from './inbox.tools';

/**
 * `channels.verify` runs an adapter healthCheck, and those authenticate: the
 * email adapter opens a full SMTP login, the Meta and NetGSM adapters call their
 * APIs. Unlike verify_email_transport, the credentials are the WORKSPACE's — so
 * an agent asking "is this channel healthy?" in a loop hammers a customer's own
 * provider account, and the rate-limit or token flag lands on them.
 *
 * The panel's Verify button deliberately keeps going straight to the service,
 * so an operator who has just fixed a token still gets a fresh answer.
 */
describe('jeeta.verify_channel — one provider handshake per minute', () => {
  // The cache is module-scope on purpose — one handshake per process, not per
  // registry instance — so each case needs its own keys to be independent.
  let n = 0;
  const ws = () => `ws-${++n}`;
  const ctxFor = (workspaceId: string) =>
    ({ workspaceId, grantedScopes: ['reports.read'] }) as never;

  const build = (verify: jest.Mock) => {
    const registry = new McpToolRegistry();
    registerChannelWriteTools(registry, { channels: { verify } } as never);
    return registry.get('jeeta.verify_channel')!;
  };

  it('does not re-check the same channel inside the window', async () => {
    const verify = jest.fn().mockResolvedValue({ ok: true });
    const tool = build(verify);

    const ctx = ctxFor(ws());
    const first = (await tool.handler(ctx, { channelId: 'c1' })) as Record<string, unknown>;
    const second = (await tool.handler(ctx, { channelId: 'c1' })) as Record<string, unknown>;

    expect(verify).toHaveBeenCalledTimes(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    // Same answer, and it says when it was really taken.
    expect(second.ok).toBe(true);
    expect(second.checkedAt).toBe(first.checkedAt);
  });

  it('keeps channels separate — one being cached must not answer for another', async () => {
    const verify = jest.fn().mockResolvedValue({ ok: true });
    const tool = build(verify);

    const ctx = ctxFor(ws());
    await tool.handler(ctx, { channelId: 'c1' });
    await tool.handler(ctx, { channelId: 'c2' });

    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('keeps workspaces separate, so one tenant cannot read another’s check', async () => {
    const verify = jest.fn().mockResolvedValue({ ok: true });
    const tool = build(verify);

    const a = ws();
    const b = ws();
    await tool.handler(ctxFor(a), { channelId: 'c1' });
    await tool.handler(ctxFor(b), { channelId: 'c1' });

    expect(verify).toHaveBeenCalledTimes(2);
  });
});
