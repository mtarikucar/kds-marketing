import { WorkspaceReadinessService } from './workspace-readiness.service';

/**
 * WHAT THE ENGINE IS STILL MISSING.
 *
 * Every item on this list is something measured, in this codebase, to stop
 * something else working — not something that would merely be nice. The tests
 * that matter are therefore about the states rather than the count: a thing
 * that EXISTS but is not working is the case a two-state checklist gets wrong,
 * and it is the case that costs money while looking fine.
 */
describe('workspace readiness', () => {
  const WS = 'ws-1';
  let prisma: any;
  let svc: WorkspaceReadinessService;

  /** Everything absent, which is a brand-new workspace. */
  const EMPTY = {
    workspaceRow: null as { mcpWriteMode: string } | null,
    brandProfile: null,
    strategy: null,
    psp: null,
    growthWallet: null,
    aiWallet: null,
    counts: 0,
  };

  function build(over: Partial<typeof EMPTY> & { counts?: number | Record<string, number> } = {}) {
    const o = { ...EMPTY, ...over };
    const count = (model: string) =>
      typeof o.counts === 'number' ? o.counts : ((o.counts as any)[model] ?? 0);

    const counter = (model: string) => jest.fn(async () => count(model));
    prisma = {
      mcpOAuthToken: { count: counter('mcpOAuthToken') },
      apiKey: { count: counter('apiKey') },
      workspace: { findUnique: jest.fn(async () => o.workspaceRow) },
      brandProfile: { findFirst: jest.fn(async () => o.brandProfile) },
      knowledgeDoc: { count: counter('knowledgeDoc') },
      marketingStrategy: { findFirst: jest.fn(async () => o.strategy) },
      workflow: { count: counter('workflow') },
      researchProfile: { count: counter('researchProfile') },
      socialAccount: {
        count: jest.fn(async (a: any) =>
          a?.where?.lastError ? count('socialBroken') : count('socialAccount'),
        ),
      },
      sendingDomain: { count: counter('sendingDomain') },
      channel: {
        count: jest.fn(async (a: any) =>
          a?.where?.type === 'SMS' ? count('smsChannel') : count('mailbox'),
        ),
      },
      product: { count: counter('product') },
      taxRate: { count: counter('taxRate') },
      orderForm: { count: counter('orderForm') },
      workspacePspConfig: { findUnique: jest.fn(async () => o.psp) },
      pipeline: { count: counter('pipeline') },
      sitePage: { count: counter('sitePage') },
      emailTemplate: { count: counter('emailTemplate') },
      socialCampaign: { count: counter('socialCampaign') },
      contentConcept: { count: counter('contentConcept') },
      customerWallet: { findFirst: jest.fn(async () => o.aiWallet) },
      growthWallet: { findUnique: jest.fn(async () => o.growthWallet) },
    };
    svc = new WorkspaceReadinessService(prisma as any);
  }

  const item = async (id: string) => {
    const r = await svc.get(WS);
    return r.items.find((i) => i.id === id)!;
  };

  it('reports a brand-new workspace as ready for nothing', async () => {
    build();
    const r = await svc.get(WS);
    expect(r.ready).toBe(0);
    expect(r.total).toBeGreaterThan(15);
    expect(r.items.every((i) => i.state !== 'READY')).toBe(true);
  });

  describe('the Claude connector, which the rest of the list depends on', () => {
    it('is FIRST, because every gap below promises a tool nothing can call yet', async () => {
      build();
      const r = await svc.get(WS);
      expect(r.items[0].id).toBe('claude-connector');
    });

    it('is missing when no live token and no key exist', async () => {
      build();
      expect((await item('claude-connector')).state).toBe('MISSING');
    });

    it('counts a connector the console would call connected', async () => {
      // The console's own definition: a token neither revoked nor expired.
      build({ counts: { mcpOAuthToken: 1 } as any, workspaceRow: { mcpWriteMode: 'AUTONOMOUS' } });
      expect((await item('claude-connector')).state).toBe('READY');
      const where = prisma.mcpOAuthToken.count.mock.calls[0][0].where;
      expect(where).toMatchObject({ revokedAt: null });
      expect(where.expiresAt).toMatchObject({ gt: expect.any(Date) });
    });

    it('counts an API key too, which is the other way in', async () => {
      build({ counts: { apiKey: 1 } as any, workspaceRow: { mcpWriteMode: 'AUTONOMOUS' } });
      expect((await item('claude-connector')).state).toBe('READY');
    });

    it('calls a connector in APPROVAL mode attention, not ready', async () => {
      // Measured: under approval the Jeeta-keyed data tools do not queue, they
      // are unusable — the result goes to the approver's HTTP response and
      // never to the agent's turn. The lane runs and silently does less, which
      // is the exact state this list exists to make visible.
      build({ counts: { mcpOAuthToken: 1 } as any, workspaceRow: { mcpWriteMode: 'APPROVAL' } });
      const i = await item('claude-connector');
      expect(i.state).toBe('ATTENTION');
      expect(i.detail).toMatchObject({ writeMode: 'APPROVAL' });
    });

    it('fails towards APPROVAL when the mode cannot be read', async () => {
      // Showing a warning that might not apply costs a sentence; hiding one
      // that does is indistinguishable from a lane working properly.
      build({ counts: { mcpOAuthToken: 1 } as any, workspaceRow: null });
      expect((await item('claude-connector')).state).toBe('ATTENTION');
    });

    it('offers no tool, because nothing can connect itself', async () => {
      build();
      expect((await item('claude-connector')).mcpTool).toBeNull();
      expect((await item('claude-connector')).to).toBe('/settings/api-keys?tab=connector');
    });
  });

  describe('the state a two-state checklist gets wrong', () => {
    it('calls a DRAFT strategy attention, not missing', async () => {
      // The work was done and never activated — which reads as "I have a
      // strategy" from everywhere except the machinery that will not run on it.
      build({ strategy: { id: 's1', status: 'DRAFT', autonomyLevel: 'ASSISTED' } });
      expect((await item('strategy')).state).toBe('ATTENTION');
    });

    it('calls a connected-but-erroring social account attention, not ready', async () => {
      // The most expensive state in the product: everything published through
      // it is dropped, quietly, while the page still says "connected".
      build({ counts: { socialAccount: 2, socialBroken: 1 } as any });
      const i = await item('social-accounts');
      expect(i.state).toBe('ATTENTION');
      expect(i.detail).toMatchObject({ connected: 2, broken: 1 });
    });

    it('calls a healthy account ready', async () => {
      build({ counts: { socialAccount: 2, socialBroken: 0 } as any });
      expect((await item('social-accounts')).state).toBe('READY');
    });
  });

  describe('a brand profile is not "a row exists"', () => {
    it('is missing while intake has only written a name', async () => {
      // Intake writes the row first and fills it in as it learns, so a
      // half-finished one is present and useless to anything that has to write
      // in this voice.
      build({ brandProfile: { id: 'b1', description: 'x', voiceGuide: null, icpDescription: null } });
      expect((await item('brand-profile')).state).toBe('MISSING');
    });

    it('is ready once it says what the business does, who for, and how it sounds', async () => {
      build({ brandProfile: { id: 'b1', description: 'x', voiceGuide: 'y', icpDescription: 'z' } });
      expect((await item('brand-profile')).state).toBe('READY');
    });
  });

  it('counts an ACTIVE campaign, because a concept has nowhere to go without one', async () => {
    // The gap most likely to be missed and the one that stops the most: a
    // content concept is promoted INTO a campaign item, so with none active the
    // whole production line produces nothing and says nothing.
    build();
    expect((await item('active-campaign')).state).toBe('MISSING');
    build({ counts: { socialCampaign: 1 } as any });
    expect((await item('active-campaign')).state).toBe('READY');
  });

  it('treats a manual bank transfer as a real payment method', async () => {
    // MANUAL is a choice, not an absence. What is not ready is having none at
    // all, which mints invoices nobody can pay.
    build({ psp: { provider: 'MANUAL' } });
    expect((await item('payment-provider')).state).toBe('READY');
  });

  it('accepts either route to sending mail', async () => {
    // Your own mailbox for replies, or a verified domain for campaign volume.
    build({ counts: { mailbox: 1 } as any });
    expect((await item('email-sending')).state).toBe('READY');
    build({ counts: { sendingDomain: 1 } as any });
    expect((await item('email-sending')).state).toBe('READY');
  });

  it('does not call an empty growth wallet ready', async () => {
    // Autopilot refuses on its first line with an empty wallet; nothing else
    // here stops as much for as small a reason.
    build({ growthWallet: { balance: 0 } });
    expect((await item('growth-wallet')).state).toBe('MISSING');
    build({ growthWallet: { balance: 250 } });
    expect((await item('growth-wallet')).state).toBe('READY');
  });

  describe('what the agent may and may not do', () => {
    it('names a tool for every gap it can close itself', async () => {
      build();
      const r = await svc.get(WS);
      for (const id of ['brand-profile', 'strategy', 'automations', 'research', 'products']) {
        expect({ id, tool: r.items.find((i) => i.id === id)?.mcpTool })
          .toEqual({ id, tool: expect.stringMatching(/^jeeta\./) });
      }
    });

    it('names NO tool for the ones that would hand it money or credentials', async () => {
      // A payment provider's secret key belongs to the person who holds it, and
      // a wallet top-up is a purchase. A null here is a decision, not a gap in
      // the tool catalogue.
      build();
      const r = await svc.get(WS);
      for (const id of ['payment-provider', 'growth-wallet', 'ai-credits', 'social-accounts']) {
        expect({ id, tool: r.items.find((i) => i.id === id)?.mcpTool }).toEqual({ id, tool: null });
      }
    });
  });

  it('puts arming the autopilot last, after everything it depends on', async () => {
    // Arming a machine that is missing its inputs is how an autopilot spends
    // money on work nobody can use.
    build();
    const r = await svc.get(WS);
    expect(r.items[r.items.length - 1].id).toBe('autonomy');
  });

  it('reads every item from the workspace it was asked about', async () => {
    build();
    await svc.get(WS);
    for (const [model, api] of Object.entries(prisma)) {
      for (const fn of Object.values(api as Record<string, jest.Mock>)) {
        for (const call of fn.mock.calls) {
          const where = call[0]?.where ?? {};
          // The Workspace row is the one table addressed by its own primary
          // key, because that key IS the workspace id. Every other read here
          // has to carry `workspaceId`, and the tenancy fitness test reads this
          // service's source for exactly that.
          const scoped = model === 'workspace' ? where.id === WS : where.workspaceId === WS;
          expect({ model, scoped }).toEqual({ model, scoped: true });
        }
      }
    }
  });
});
