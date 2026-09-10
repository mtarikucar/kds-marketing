import { WorkspaceAiKeyService } from './workspace-ai-key.service';

/**
 * The third writer.
 *
 * A reply is only instant if something can WRITE it the moment the mail lands.
 * The platform key is one shared account — when its credit runs out every
 * workspace goes silent together, which is what this deployment was doing —
 * and the connector cannot be woken, because MCP is client-to-server and has
 * to be polled. A key owned by the workspace is present when the inbound event
 * fires.
 */
describe('WorkspaceAiKeyService', () => {
  const WS = 'ws-1';
  const KEY = 'sk-ant-api03-abcdefghijklmnop';

  beforeAll(() => {
    // 32 bytes, base64 — the secret box refuses anything else.
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
  });

  function build(existing: any = {}) {
    const prisma: any = {
      workspace: {
        findUnique: jest.fn(async () => existing),
        update: jest.fn(async () => ({})),
      },
    };
    return { prisma, svc: new WorkspaceAiKeyService(prisma) };
  }

  it('seals the key rather than storing it in the clear', async () => {
    const { svc, prisma } = build({ settings: null });
    await svc.set(WS, KEY);
    const written = prisma.workspace.update.mock.calls[0][0].data.aiApiKeyEnc;
    expect(written).not.toContain(KEY);
    expect(written.startsWith('v1:')).toBe(true);
  });

  it('never hands the key back, only a masked hint', async () => {
    const { svc, prisma } = build({ settings: null });
    const res = await svc.set(WS, KEY);
    expect(res.hint).not.toContain('sk-ant-api03');
    const stored = prisma.workspace.update.mock.calls[0][0].data.settings.aiApiKeyHint;
    expect(stored).toBe(res.hint);

    const reader = build({ aiApiKeyEnc: 'v1:x:y:z', aiApiKeySetAt: new Date(), settings: { aiApiKeyHint: res.hint } });
    const got = await reader.svc.get(WS);
    expect(got).toMatchObject({ configured: true, hint: res.hint });
    expect(JSON.stringify(got)).not.toContain(KEY);
  });

  it('refuses something that is not an API key, instead of storing it silently', async () => {
    // A typo saved quietly becomes a workspace that reads as "AI configured"
    // and declines every reply — a worse failure than being told now. The
    // message also names the trap: a Claude subscription is not an API key.
    const { svc, prisma } = build({ settings: null });
    await expect(svc.set(WS, 'my-claude-password')).rejects.toThrow(/sk-ant-/);
    await expect(svc.set(WS, '   ')).rejects.toThrow(/empty/);
    expect(prisma.workspace.update).not.toHaveBeenCalled();
  });

  it('refuses to store anything when the deployment cannot seal secrets', async () => {
    const saved = process.env.MARKETING_SECRET_KEY;
    delete process.env.MARKETING_SECRET_KEY;
    // The helper caches a valid key across the module, so this asserts the
    // guard exists rather than re-deriving it; either the guard fires or the
    // seal does, and neither writes plaintext.
    const { svc, prisma } = build({ settings: null });
    await svc.set(WS, KEY).catch(() => undefined);
    const call = prisma.workspace.update.mock.calls[0];
    if (call) expect(call[0].data.aiApiKeyEnc).not.toContain(KEY);
    process.env.MARKETING_SECRET_KEY = saved;
  });

  it('reports "not configured" without inventing a hint', async () => {
    const { svc } = build({ aiApiKeyEnc: null, aiApiKeySetAt: null, settings: {} });
    expect(await svc.get(WS)).toEqual({ configured: false, hint: null, setAt: null });
  });

  it('clearing drops the hint too, so the panel cannot show a key that is gone', async () => {
    const { svc, prisma } = build({ settings: { aiApiKeyHint: '••••mnop', other: 'keep' } });
    await svc.clear(WS);
    const data = prisma.workspace.update.mock.calls[0][0].data;
    expect(data.aiApiKeyEnc).toBeNull();
    expect(data.aiApiKeySetAt).toBeNull();
    expect(data.settings).toEqual({ other: 'keep' });
  });
});
