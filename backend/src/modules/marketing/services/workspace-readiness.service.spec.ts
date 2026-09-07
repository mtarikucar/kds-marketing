import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceReadinessService } from './workspace-readiness.service';
import { AI_CREDITS_METRIC, monthKey } from '../ai/ai-credits.service';

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
    aiWallet: null as { balance: number } | null,
    /**
     * The PLAN's monthly AI allowance. -1 is unlimited, 0 is a real "your plan
     * includes none", and `null` is "billing could not be reached" — three
     * different answers that this list must not collapse into each other.
     */
    aiCreditsMonthly: 0 as number | null,
    /**
     * This month's `ai.credits` UsageCounter value — the meter
     * `AiCreditsService.reserve` increments. `null` is the honest brand-new
     * shape: no row exists until the first AI action of the month.
     */
    aiCreditsUsed: null as number | null,
    counts: 0,
  };

  let entitlements: any;

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
      // Two counts share this model: ACTIVE ones, and every one regardless of
      // status. Keyed apart so a test can say "a draft exists and none is
      // armed", which is the state the item used to misread.
      workflow: {
        count: jest.fn(async (a: any) =>
          a?.where?.status === 'ACTIVE' ? count('workflow') : count('workflowAny'),
        ),
      },
      researchProfile: { count: counter('researchProfile') },
      socialAccount: {
        // THREE counts share this model, and telling them apart is the point of
        // the keys: "switched on" (bare), "already broken" (the OR-predicate),
        // and "about to expire and nothing is fixing it" (the AND-of-ORs, whose
        // two windows are the subject of a describe block below). The third is
        // the one this service used not to run at all.
        count: jest.fn(async (a: any) => {
          if (a?.where?.AND) return count('socialExpiring');
          if (a?.where?.OR) return count('socialBroken');
          return count('socialAccount');
        }),
      },
      sendingDomain: { count: counter('sendingDomain') },
      channel: {
        // THREE counts share this model now. The email pair is the point: one
        // asks "is a mailbox configured", the other "has one ever passed a
        // health check". Keyed apart so a test can say "configured but never
        // proved" — the state a row-exists check reads as fine while every
        // send 535s.
        count: jest.fn(async (a: any) => {
          if (a?.where?.type === 'SMS') return count('smsChannel');
          if (a?.where?.lastVerifiedAt) return count('provenMailbox');
          return count('mailbox');
        }),
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
      // The AI wallet is `AiCreditWallet`: one row per workspace, whole
      // credits. Mocking it under its REAL name is not cosmetic — this file
      // used to mock `customerWallet.findFirst` under the alias `aiWallet`,
      // and that alias is precisely why the service reading the wrong table
      // was invisible here for as long as it was.
      aiCreditWallet: { findUnique: jest.fn(async () => o.aiWallet) },
      // The per-LEAD store-credit wallet, present and stocked on purpose. It is
      // a different currency (TRY minor units) belonging to a different party,
      // and nothing on this list may read it. Left in the mock so that a
      // service that reaches for it again is caught by an assertion rather than
      // by a TypeError that reads like a broken test.
      customerWallet: { findFirst: jest.fn(async () => ({ balance: 99_000 })) },
      // The meter the engine actually charges against. A readiness list that
      // keeps its own tally of consumption would disagree with the thing that
      // does the refusing, silently — so the service reads THIS row, and this
      // mock is what proves it asked for the right metric and period.
      usageCounter: {
        findFirst: jest.fn(async () =>
          o.aiCreditsUsed === null ? null : { value: o.aiCreditsUsed },
        ),
      },
      growthWallet: { findUnique: jest.fn(async () => o.growthWallet) },
    };
    entitlements = {
      getEffective: jest.fn(async () => ({
        limits: { aiCreditsMonthly: o.aiCreditsMonthly },
      })),
    };
    svc = new WorkspaceReadinessService(prisma as any, entitlements as any);
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

    it('asks for the accounts whose token RAN OUT, not just the ones with an error string', async () => {
      // The failure that actually happens, and the one the first version of
      // this file could not see. A token expires: `tokenExpiresAt` passes,
      // nothing writes `lastError`, the row stays enabled. The old predicate
      // (`enabled: true, lastError: { not: null }`) read that as healthy while
      // every publish through the account failed.
      //
      // Asserted on the QUERY rather than a count, because a count mock proves
      // only that the service believed its own filter.
      build();
      await svc.get(WS);
      const broken = prisma.socialAccount.count.mock.calls
        .map((c: any[]) => c[0]?.where)
        .find((w: any) => w?.OR);
      expect(broken).toBeTruthy();
      expect(broken.OR).toEqual(
        expect.arrayContaining([
          { lastError: 'reauth_required' },
          { enabled: true, tokenExpiresAt: { lt: expect.any(Date) } },
        ]),
      );
    });

    it('does not report an account somebody retired on purpose', async () => {
      // `disconnected` and `mistagged_page_superseded` are both written by
      // deliberate acts — an owner disconnecting, and the Page-repair job. A
      // checklist that flags those forever is one people stop reading, so the
      // predicate names `reauth_required` rather than "any error string".
      build();
      await svc.get(WS);
      const broken = prisma.socialAccount.count.mock.calls
        .map((c: any[]) => c[0]?.where)
        .find((w: any) => w?.OR);
      expect(broken.OR).not.toContainEqual({ lastError: { not: null } });
    });
  });

  describe('the expiry warning, and the refresher it must not shout over', () => {
    /**
     * The predicate for "about to break and nothing is fixing it". Asserted on
     * the QUERY rather than a count, because a count mock proves only that the
     * service believed its own filter.
     */
    async function expiryWhere(): Promise<any> {
      build();
      await svc.get(WS);
      const w = prisma.socialAccount.count.mock.calls
        .map((c: any[]) => c[0]?.where)
        .find((x: any) => x?.AND);
      expect(w).toBeTruthy();
      return w;
    }

    /** The window arms, keyed by whether the refresher's cron can reach them. */
    async function arms(): Promise<{ selfHealing: any; unattended: any[] }> {
      const w = await expiryWhere();
      const or = w.AND.find((c: any) => c.OR?.some((a: any) => a.tokenExpiresAt)).OR;
      const selfHealing = or.find((a: any) => a.connectedVia === 'OAUTH');
      return { selfHealing, unattended: or.filter((a: any) => a !== selfHealing) };
    }

    const span = (a: any) => a.tokenExpiresAt.lte.getTime() - a.tokenExpiresAt.gt.getTime();
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;

    /**
     * The refresher's window, read from ITS OWN SOURCE rather than copied here.
     *
     * That is the whole point of this block: the two numbers are only safe in
     * relation to each other, so a future edit to `REFRESH_WINDOW_MS` has to
     * fail a test in THIS file. Copying the literal would have let them drift
     * apart in silence, which is exactly how the seven-day warning came to be
     * fired at the same moment the seven-day repair started.
     */
    function refresherWindowMs(): number {
      const src = fs.readFileSync(
        path.resolve(
          __dirname,
          '../social-planner/oauth/social-token-refresh.service.ts',
        ),
        'utf8',
      );
      const m = /REFRESH_WINDOW_MS\s*=\s*([0-9*\s]+);/.exec(src);
      expect(m).toBeTruthy();
      return m![1]
        .split('*')
        .map((p) => Number(p.trim()))
        .reduce((a, b) => a * b, 1);
    }

    it('warns BEFORE a token expires, not only after', async () => {
      // The state this list was blind to, and the most avoidable one on it. An
      // expiry is one of the few failures that announces itself in advance —
      // and an account cannot be reconnected retroactively, so by the time the
      // already-broken predicate sees it, the posts that did not go out have
      // not gone out.
      build({ counts: { socialAccount: 2, socialBroken: 0, socialExpiring: 1 } as any });
      const i = await item('social-accounts');
      expect(i.state).toBe('ATTENTION');
      // Reported apart from `broken`, because they are different sentences:
      // one account has stopped working and the other is still working today.
      expect(i.detail).toMatchObject({ connected: 2, broken: 0, expiringSoon: 1 });
    });

    it('stays WELL INSIDE the refresher’s window for accounts it can repair', async () => {
      // The defect this block exists for. `SocialTokenRefreshService` picks up
      // every OAUTH account that still has a refresh token once it is within
      // REFRESH_WINDOW_MS of expiry and retries EVERY HOUR, leaving the row
      // untouched on failure so the next tick tries again. A readiness warning
      // on the same window therefore lit up at the exact instant the repair
      // began and stayed lit for the whole week it worked — a permanent
      // ATTENTION on every short-lived-token account, which is how a signal
      // becomes noise a person learns to scroll past.
      const { selfHealing } = await arms();
      const refresher = refresherWindowMs();

      // The refresher's own due predicate, so this arm covers exactly the
      // accounts it will retry.
      expect(selfHealing).toMatchObject({
        connectedVia: 'OAUTH',
        refreshToken: { not: null },
      });

      expect(span(selfHealing)).toBeLessThan(refresher);
      // Not merely smaller — smaller by DAYS of hourly retries, so that by the
      // time a human is told, auto-refresh has had ~100+ attempts and failed
      // them all. Pinned as a relationship: change either number and this
      // fails.
      expect((refresher - span(selfHealing)) / HOUR).toBeGreaterThanOrEqual(96);
    });

    it('gives the full week to accounts the refresher never looks at', async () => {
      // The other half, and the reason this is two windows rather than one
      // smaller one. The due query filters `connectedVia: 'OAUTH'` and
      // `refreshToken: { not: null }` — so an account connected by hand, or one
      // whose provider handed back no refresh token, is NEVER picked up.
      // Nothing is retrying those. Only a human reconnect saves them, and 48
      // hours is not enough notice to ask a person for.
      const { unattended } = await arms();
      expect(unattended.length).toBeGreaterThan(0);
      for (const arm of unattended) {
        expect(span(arm)).toBe(7 * DAY);
      }
      // Between them the unattended arms cover the whole complement of the
      // refresher's due predicate: no refresh token, or not connected by OAuth.
      expect(unattended).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ refreshToken: null }),
          expect.objectContaining({ connectedVia: { not: 'OAUTH' } }),
        ]),
      );
    });

    it('still catches the account that motivated this, three days from expiry', async () => {
      // The real case this must not regress on, observed 2026-09-05 in the
      // hummytummy workspace via jeeta.list_social_accounts: a LinkedIn account
      // created 2026-07-10 and expiring 2026-09-08 whose `tokenExpiresAt` had
      // not moved although the refresher's window opened on 2026-09-01 — three
      // days of runway left, and the checklist still said READY.
      //
      // Expressed as an offset from the service's OWN clock reading rather than
      // a wall-clock date, so the test does not quietly stop meaning anything
      // the week after it was written.
      //
      // Which arm catches it depends on whether the row carries a refresh
      // token, and that cannot be read from here. Both answers are covered:
      // with no refresh token nothing was ever retrying it and the week-long
      // arm has it today; with one, the refresher has been failing hourly since
      // 09-01 and the 48h arm takes it on 09-06. It is reported before it dies
      // either way — which is the property that matters.
      const { selfHealing, unattended } = await arms();
      const now = selfHealing.tokenExpiresAt.gt.getTime();
      const threeDaysOut = now + 3 * DAY;

      for (const arm of unattended) {
        expect(arm.tokenExpiresAt.lte.getTime()).toBeGreaterThanOrEqual(threeDaysOut);
      }
      // And deliberately NOT yet by the self-healing arm: at three days out the
      // refresher is two days into retrying, and reporting it then is the noise
      // this split removes.
      expect(selfHealing.tokenExpiresAt.lte.getTime()).toBeLessThan(threeDaysOut);
      expect(selfHealing.tokenExpiresAt.lte.getTime()).toBeGreaterThan(now + DAY);
    });

    it('cannot describe one row as two problems', async () => {
      // An account stamped `reauth_required` whose token also expires inside
      // the window was counted in BOTH `broken` and `expiringSoon`, so `detail`
      // said "1 broken, 1 expiring soon" about a single row — two problems
      // where there is one. `detail` is not rendered by the panel, but it goes
      // verbatim to the MCP agent via jeeta.get_setup_readiness, which reads
      // and repeats those counts.
      //
      // Disjoint by construction now: the already-broken count takes
      // `tokenExpiresAt < now` (this one takes `> now`) plus
      // `lastError: 'reauth_required'` (excluded here). Written as an OR over
      // null because a NULL `lastError` is the ordinary case and must stay in
      // this count — the overwhelming majority of rows have no error at all.
      const w = await expiryWhere();
      const exclusion = w.AND.find((c: any) => c.OR?.every((a: any) => 'lastError' in a));
      expect(exclusion).toBeTruthy();
      expect(exclusion.OR).toEqual(
        expect.arrayContaining([{ lastError: null }, { lastError: { not: 'reauth_required' } }]),
      );
      const { selfHealing, unattended } = await arms();
      for (const arm of [selfHealing, ...unattended]) {
        expect(arm.tokenExpiresAt.gt).toEqual(expect.any(Date));
      }
    });

    it('leaves out the connections the owner switched off', async () => {
      const w = await expiryWhere();
      expect(w).toMatchObject({ workspaceId: WS, enabled: true });
    });
  });

  describe('automations, where a draft is not an absence', () => {
    it('says ATTENTION when one exists and none is armed', async () => {
      // Measured on the live workspace: a finished lead-routing workflow sat in
      // DRAFT while this line said MISSING. MISSING reads as "build one" — and
      // the fix was to switch on the one already there.
      build({ counts: { workflow: 0, workflowAny: 2 } as any });
      const i = await item('automations');
      expect(i.state).toBe('ATTENTION');
      expect(i.detail).toMatchObject({ active: 0, total: 2 });
    });

    it('says MISSING only when there is genuinely nothing', async () => {
      build({ counts: { workflow: 0, workflowAny: 0 } as any });
      expect((await item('automations')).state).toBe('MISSING');
    });

    it('says READY once one is running', async () => {
      build({ counts: { workflow: 1, workflowAny: 3 } as any });
      expect((await item('automations')).state).toBe('READY');
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

  describe('sending mail, where a configured mailbox is not a working one', () => {
    it('accepts a VERIFIED sending domain on its own', async () => {
      // The domain's verification IS the proof; there is no second check to
      // wait for. No mailbox needed.
      build({ counts: { sendingDomain: 1 } as any });
      expect((await item('email-sending')).state).toBe('READY');
    });

    it('accepts a mailbox that has PASSED a health check', async () => {
      build({ counts: { mailbox: 1, provenMailbox: 1 } as any });
      const i = await item('email-sending');
      expect(i.state).toBe('READY');
      expect(i.detail).toMatchObject({ mailboxes: 1, provenMailboxes: 1 });
    });

    it('calls a mailbox that has never passed one ATTENTION, not READY', async () => {
      // Measured live: a channel saved with the wrong password. The row
      // existed, so a two-state test said the reach was covered, while every
      // send died on `535 Authentication Failed`. Configured is not working.
      build({ counts: { mailbox: 1, provenMailbox: 0 } as any });
      const i = await item('email-sending');
      expect(i.state).toBe('ATTENTION');
      expect(i.detail).toMatchObject({ mailboxes: 1, provenMailboxes: 0, verifiedDomains: 0 });
    });

    it('still counts the domain when the mailbox is broken', async () => {
      // One good route is enough — a failing mailbox must not drag a workspace
      // that also has a verified domain down to ATTENTION.
      build({ counts: { mailbox: 1, provenMailbox: 0, sendingDomain: 1 } as any });
      expect((await item('email-sending')).state).toBe('READY');
    });

    it('asks for one when there is neither', async () => {
      build();
      expect((await item('email-sending')).state).toBe('MISSING');
    });

    it('narrows the proven count by lastVerifiedAt, not by pressing the button', async () => {
      // `ChannelsService.verify` writes `lastVerifiedAt` only when health.ok,
      // so this query is what separates "checked and worked" from "checked".
      build({ counts: { mailbox: 1, provenMailbox: 1 } as any });
      await svc.get(WS);
      const wheres = prisma.channel.count.mock.calls.map((c: any[]) => c[0].where);
      expect(wheres).toContainEqual(
        expect.objectContaining({ type: 'EMAIL', status: 'ACTIVE', lastVerifiedAt: { not: null } }),
      );
    });
  });

  describe('AI credits: "can an action run right now", not "is there a wallet"', () => {
    it('reads the workspace’s AI wallet, never a customer’s store credit', async () => {
      // The bug this file could not see, because it mocked the wrong table
      // under the right name. `CustomerWallet` is the per-LEAD store-credit
      // wallet — `leadId` is REQUIRED and the unique key is
      // `[workspaceId, leadId]` — so a `findFirst` with no `leadId` returns an
      // ARBITRARY customer's balance, in TRY minor units. That number decided
      // READY vs MISSING and went out verbatim in `detail` to the MCP agent
      // through `jeeta.get_setup_readiness`. A stocked customer wallet is in
      // the mock precisely so a reader of it would go on looking ready.
      build();
      expect((await item('ai-credits')).state).toBe('MISSING');
      expect(prisma.customerWallet.findFirst).not.toHaveBeenCalled();
      expect(prisma.aiCreditWallet.findUnique).toHaveBeenCalledWith({
        where: { workspaceId: WS },
        select: { balance: true },
      });
    });

    it('reads the SAME meter the engine charges against', async () => {
      // Not a parallel tally. `AiCreditsService.reserve` increments a
      // `UsageCounter` row under `ai.credits`, keyed by the UTC month — so this
      // list asks for that exact row. A second way of counting consumption
      // would disagree with the thing that actually refuses the work, and the
      // disagreement would be invisible from either side.
      build();
      await svc.get(WS);
      expect(prisma.usageCounter.findFirst).toHaveBeenCalledWith({
        where: { workspaceId: WS, metric: AI_CREDITS_METRIC, periodKey: monthKey() },
        select: { value: true },
      });
    });

    it('is READY on day 1 of a paying plan with an untouched allowance', async () => {
      // THE common case, and the one the previous version of this line got
      // wrong for every paying workspace. The seeded packages grant
      // 1500/2000/6000 credits a month; `reserve()` spends the ALLOWANCE FIRST
      // and only reaches for the prepaid wallet on the shortfall. So a
      // workspace on day 1 with nothing spent and an empty wallet can run AI
      // work all month — and was being told to go and buy credits.
      build({ aiWallet: null, aiCreditsMonthly: 1500, aiCreditsUsed: null });
      const i = await item('ai-credits');
      expect(i.state).toBe('READY');
      expect(i.detail).toMatchObject({
        fuel: 'monthly-allowance',
        monthlyAllowance: 1500,
        usedThisPeriod: 0,
        allowanceRemaining: 1500,
        balance: 0,
      });
    });

    it('is still READY part-way through the month, with the remainder shown', async () => {
      build({ aiWallet: null, aiCreditsMonthly: 1500, aiCreditsUsed: 1400 });
      const i = await item('ai-credits');
      expect(i.state).toBe('READY');
      expect(i.detail).toMatchObject({
        fuel: 'monthly-allowance',
        usedThisPeriod: 1400,
        allowanceRemaining: 100,
      });
    });

    it('asks for credits once the allowance is SPENT and no prepaid is left', async () => {
      // The case the old "positive allowance is not fuel" rule was reaching
      // for, and the only one it was right about. An exhausted allowance with
      // an empty wallet is a workspace whose next AI action throws
      // AI_CREDITS_EXHAUSTED — a real gap, and the one this item should report.
      build({ aiWallet: { balance: 0 }, aiCreditsMonthly: 1500, aiCreditsUsed: 1500 });
      const i = await item('ai-credits');
      expect(i.state).toBe('MISSING');
      expect(i.detail).toMatchObject({ fuel: 'none', allowanceRemaining: 0 });
    });

    it('is ready on a prepaid balance once the allowance is gone', async () => {
      // The overage path: prepaid credits are what `reserve()` spends on the
      // shortfall, so they are fuel even with the month's allowance used up.
      build({ aiWallet: { balance: 400 }, aiCreditsMonthly: 1500, aiCreditsUsed: 1500 });
      const i = await item('ai-credits');
      expect(i.state).toBe('READY');
      expect(i.detail).toMatchObject({ fuel: 'prepaid-wallet', balance: 400 });
    });

    it('is ready on a prepaid balance with a plan that includes NO allowance', async () => {
      // A real plan shape, not an error: `reserve()` at `limit === 0` spends
      // prepaid credits directly, because they are "the customer's MONEY and
      // were sold as non-expiring".
      build({ aiWallet: { balance: 400 }, aiCreditsMonthly: 0 });
      const i = await item('ai-credits');
      expect(i.state).toBe('READY');
      expect(i.detail).toMatchObject({ fuel: 'prepaid-wallet', monthlyAllowance: 0 });
    });

    it('is ready on an UNLIMITED plan with no wallet at all', async () => {
      // `AiCreditsService.reserve` reads the plan first and, at
      // `aiCreditsMonthly === -1`, bumps the counter and returns WITHOUT ever
      // consulting a wallet. So an unlimited workspace can never be short of
      // credits, and no top-up would change anything — telling its owner to buy
      // some is telling them to fix a thing that is not broken.
      build({ aiWallet: null, aiCreditsMonthly: -1, aiCreditsUsed: 90_000 });
      const i = await item('ai-credits');
      expect(i.state).toBe('READY');
      expect(i.detail).toMatchObject({
        fuel: 'unlimited',
        balance: 0,
        monthlyAllowance: -1,
        allowanceRemaining: -1,
      });
      expect(entitlements.getEffective).toHaveBeenCalledWith(WS);
    });

    it('says it could not read the plan, instead of reporting an allowance of 0', async () => {
      // A list that 500s says nothing about anything, so the read still fails
      // soft — but it must not fail into a number that looks like an answer.
      // `monthlyAllowance: 0` is a REAL plan shape, and it went out verbatim to
      // the MCP agent: "your plan includes no AI credits" is a different
      // instruction from "we could not ask", and the agent acts on it.
      build();
      entitlements.getEffective.mockRejectedValue(new Error('billing down'));
      const i = await item('ai-credits');
      expect(i.state).toBe('MISSING');
      expect(i.detail).toMatchObject({ fuel: 'unknown-plan-unreadable', planUnreadable: true });
      expect(i.detail).not.toHaveProperty('monthlyAllowance');
      expect(i.detail).not.toHaveProperty('allowanceRemaining');
    });

    it('is still READY on an unreadable plan when the wallet has credits', async () => {
      // The prepaid balance is true whatever billing says, so an unreachable
      // entitlements service must not manufacture a gap on top of its own
      // outage.
      build({ aiWallet: { balance: 400 } });
      entitlements.getEffective.mockRejectedValue(new Error('billing down'));
      const i = await item('ai-credits');
      expect(i.state).toBe('READY');
      expect(i.detail).toMatchObject({ fuel: 'prepaid-wallet', planUnreadable: true });
    });
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
      for (const id of ['brand-profile', 'automations', 'research', 'products']) {
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

    it('names NO tool where the catalogue has one whose CONTRACT cannot close the gap', async () => {
      // The mistake this file shipped with, and the reason it looked right:
      // each of these lines named a real, registered tool whose NAME matched
      // the gap, and every one refused the thing the line needs.
      //
      //  strategy         jeeta.synthesize_strategy    re-synthesizes an ACTIVE
      //                                                strategy; returns
      //                                                `no-active-strategy` in
      //                                                exactly the MISSING case
      //  active-campaign  jeeta.create_social_campaign creates a DRAFT; this
      //                                                line counts ACTIVE, and
      //                                                activation is withheld
      //                                                from MCP on purpose
      //  autonomy         jeeta.set_strategy_autonomy  refuses AUTONOMOUS, the
      //                                                only value that
      //                                                satisfies the line
      //
      // A wrong name here is worse than a null: the panel prints a robot beside
      // the row and the agent calls a tool that no-ops, so the gap survives a
      // fix that reported success.
      //
      // `strategy` has since left this list — not because the reasoning above
      // changed, but because a tool that CAN close it was built (see below).
      build();
      const r = await svc.get(WS);
      for (const id of ['active-campaign', 'autonomy']) {
        expect({ id, tool: r.items.find((i) => i.id === id)?.mcpTool }).toEqual({ id, tool: null });
      }
    });

    /**
     * The one gap on this list an agent closes by WRITING the missing thing
     * rather than by asking the platform to produce it.
     *
     * `jeeta.submit_strategy` takes a brief the connected Claude wrote itself
     * and persists it through the same writer synthesis uses, so the row this
     * item reads exists and is ACTIVE afterwards. It is ungated, spends no
     * credit and makes no model call — which is what makes it a fix for the
     * state this workspace was actually in: a dry platform Anthropic key, with
     * both the intake wizard and synthesis returning `ai-not-configured`.
     */
    it('names submit_strategy for the strategy gap — the tool that actually creates the row', async () => {
      build();
      const r = await svc.get(WS);
      const item = r.items.find((i) => i.id === 'strategy');
      expect({ state: item?.state, tool: item?.mcpTool }).toEqual({
        state: 'MISSING',
        tool: 'jeeta.submit_strategy',
      });
    });

    /**
     * …and only there. `submit_strategy` creates the workspace's FIRST strategy
     * and refuses any existing row, so promising it beside a row that exists is
     * the same wrong-promise failure this block is about — an agent sent to a
     * tool whose answer is "This workspace already has a strategy". The
     * ATTENTION case is the one that bites: the item is still a gap, so the
     * panel still prints the robot.
     *
     * The shape of the fix (a conditional field, not a constant) is pinned in
     * `readiness-tool-promises.spec.ts`; this pins the behaviour.
     */
    it('promises NO tool once a strategy row exists — submit refuses every one of those states', async () => {
      for (const status of ['DRAFT', 'ARCHIVED', 'ACTIVE']) {
        build({ strategy: { id: 's1', status, autonomyLevel: 'ASSISTED' } });
        const item = (await svc.get(WS)).items.find((i) => i.id === 'strategy');
        expect({ status, tool: item?.mcpTool }).toEqual({ status, tool: null });
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
