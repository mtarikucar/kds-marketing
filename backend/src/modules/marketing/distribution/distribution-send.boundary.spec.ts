import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { ContentDistributionService } from './content-distribution.service';
import { DistributionSendService } from './distribution-send.service';

/**
 * THE test of stage 4. If it goes, the feature's whole premise goes with it.
 *
 * The owner chose the shape and said why: automated mass DMs to accounts that
 * never asked to hear from us are what platform spam detection is built to
 * catch, and the price of being caught is a restricted account. So "the system
 * prepares, a person sends" has to be a property the code can be held to.
 *
 * This spec holds it three ways:
 *
 *   A. **Nobody else can dispatch.** A source scan: the set of files that can
 *      reach the send path is written down here, exactly. Adding an auto-send
 *      anywhere — a job handler, the planner, the promotion service, a new MCP
 *      tool — fails this list even if the new code is otherwise perfect.
 *   B. **Producing a plan sends nothing, and marks nothing as sent.** The whole
 *      planner is exercised with a sender present in its world; the assertions
 *      are that the sender was never touched and that every row written is
 *      DRAFT with no sent stamp.
 *   C. **The actor is a verified human.** Not a declared one: a made-up id, an
 *      empty id, and the SYSTEM sentinel that unattended MCP sessions resolve
 *      to are each refused, each with its own assertion.
 *
 * ## Mutation-verified, and here is what each mutation actually caught
 *
 * Three deliberate mutations were applied and run before this comment was
 * written. They are recorded because a guard nobody has broken on purpose is a
 * guard nobody knows the shape of:
 *
 *   1. The planner injects `DistributionSendService` and sends every draft it
 *      writes. → A's file scan named `content-distribution.service.ts`, A's
 *      constructor-arity check saw 2 instead of 1, and both of B's tests fell.
 *   2. The planner writes its drafts at `status: 'SENT'` with a `sentAt` — no
 *      sender involved at all, the "a downstream sweeper will pick these up"
 *      shape. → ONLY B's second test caught it. A saw nothing, because no file
 *      named a send path. This is why B asserts the ROWS and not merely the spy.
 *   3. `assertHumanActor` stops excluding the SYSTEM role. → ONLY C's sentinel
 *      test caught it, which is the whole reason that test names the role
 *      rather than testing "some actor is refused".
 *
 * Mutation 1 also found a hole in this file: B's `distributionDraft.findMany`
 * stub used to return `[]`, so an auto-send loop read back nothing and
 * dispatched nothing, and B passed while the code sent messages on its own. The
 * stub now returns what was written. A mock that answers "there is nothing
 * there" makes every assertion downstream of it vacuous.
 *
 * If you are changing this file to make a build pass, that is the signal to
 * stop and go and read the design decision instead.
 */

const SRC_ROOT = join(__dirname, '..', '..', '..');

/**
 * Every file allowed to name the send path, and why.
 *
 * "The send path" is `DistributionSendService` itself and
 * `OutboundConversationService` — the one service in this product that can open
 * a conversation with someone who has not written to us first. This is
 * DELIBERATELY a list rather than a rule: a rule invites an exception, and the
 * point is that adding a caller must be an edit somebody reviews.
 */
const ALLOWED_SEND_REFERENCES: Record<string, string> = {
  // The boundary itself.
  'modules/marketing/distribution/distribution-send.service.ts':
    'the one send path; it holds the human check',
  'modules/marketing/distribution/distribution-send.service.spec.ts': 'its unit spec',
  'modules/marketing/distribution/distribution-send.boundary.spec.ts': 'this file',
  // The human door: a REST route behind the auth guard, taking the actor from
  // the authenticated principal.
  'modules/marketing/controllers/marketing-content-distribution.controller.ts':
    'the human-gated REST route',
  'modules/marketing/controllers/marketing-content-distribution.controller.spec.ts':
    'its controller spec',
  // Nest wiring.
  'modules/marketing/marketing.module.ts': 'dependency injection wiring',

  // OutboundConversationService's own pre-existing callers, which predate this
  // feature and are listed so this scan measures the WHOLE send surface rather
  // than only the part stage 4 added.
  'modules/marketing/channels/outbound-conversation.service.ts': 'the service itself',
  'modules/marketing/channels/outbound-conversation.service.spec.ts': 'its unit spec',
  'modules/marketing/controllers/marketing-conversations.controller.ts':
    'the pre-existing human REST route (POST conversations/start)',
  'modules/marketing/mcp/tools/inbox.tools.ts':
    'jeeta.message_lead — requiresApproval: true, approvalKind SEND; a human approves each one',
};

const SEND_PATH_NAMES = ['DistributionSendService', 'OutboundConversationService'];

/**
 * Source with COMMENTS REMOVED.
 *
 * The scan is about what the code can DO, not about what a docblock is allowed
 * to name. Without this, the planner's own docblock — which exists to explain
 * that it deliberately cannot dispatch — would register as a reference to the
 * send path and the whole guard would collapse into "never write this word".
 * That is the wrong incentive: it would push the explanation out of the file
 * that most needs it.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      walk(full, out);
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('A — nothing outside the written-down list can reach a send path', () => {
  it('names every file that mentions the send path, and nothing else', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const src = code(file);
      if (!SEND_PATH_NAMES.some((n) => src.includes(n))) continue;
      const rel = relative(SRC_ROOT, file).split(sep).join('/');
      if (!(rel in ALLOWED_SEND_REFERENCES)) offenders.push(rel);
    }
    // The hint rides INSIDE the compared object, because jest's expect takes no
    // message argument — and whoever sees this failure is exactly the person
    // who needs to be told what the decision in front of them is.
    const hint =
      'A new file can now reach a send path. That is either a second send path — which this feature must not have — or a deliberate caller, which needs a line in ALLOWED_SEND_REFERENCES saying WHO decides to send and how.';
    expect({ hint, offenders }).toEqual({ hint, offenders: [] });
  });

  /** The list is not allowed to rot into a graveyard of paths that no longer
   *  exist — a stale entry is a hole nobody notices. */
  it('has no stale entries', () => {
    const live = new Set(
      walk(SRC_ROOT)
        .filter((f) => SEND_PATH_NAMES.some((n) => code(f).includes(n)))
        .map((f) => relative(SRC_ROOT, f).split(sep).join('/')),
    );
    expect(Object.keys(ALLOWED_SEND_REFERENCES).filter((p) => !live.has(p))).toEqual([]);
  });

  /**
   * The composition service must not merely avoid CALLING the sender — it must
   * not be able to. This asserts the object graph, so a future `constructor(...,
   * private readonly send: DistributionSendService)` fails here as well as in
   * the scan above.
   */
  it('the planner cannot dispatch: it takes prisma and nothing else', () => {
    expect(ContentDistributionService.length).toBe(1);
    const src = code(join(__dirname, 'content-distribution.service.ts'));
    for (const name of SEND_PATH_NAMES) expect(src).not.toContain(name);
    expect(src).not.toContain('MessageSenderService');
  });
});

describe('B — producing a plan dispatches nothing', () => {
  /** Every read the planner makes, wired to a workspace where outreach is
   *  genuinely possible — so this test is exercising the path that COULD send,
   *  not a path that had nothing to send anyway. */
  function planningWorld() {
    const writes: Array<{ table: string; data: unknown }> = [];
    const prisma: any = {
      socialCampaignItem: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'item-1',
          workspaceId: 'ws-1',
          socialCampaignId: 'camp-1',
          contentConceptId: 'concept-1',
          socialPostId: 'post-1',
          status: 'PUBLISHED',
          topic: 'Strandbeest',
        }),
      },
      socialAccount: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'acc-1',
            network: 'INSTAGRAM',
            displayName: 'figurunica',
            enabled: true,
            lastError: null,
            tokenExpiresAt: null,
          },
        ]),
      },
      socialPost: { findFirst: jest.fn().mockResolvedValue({ content: 'caption' }) },
      socialPostTarget: { findMany: jest.fn().mockResolvedValue([]) },
      contentConcept: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ hook: 'Bunun motoru yok.', title: 'T', shotPlan: {} }),
      },
      channel: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'ch-1', type: 'EMAIL', status: 'ACTIVE', name: 'Mail' }]),
      },
      lead: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'lead-1',
            businessName: 'B',
            contactPerson: 'A',
            phone: null,
            whatsapp: null,
            email: 'a@example.com',
            emailOptOut: false,
            smsOptOut: false,
            waOptOut: false,
            emailVerifiedStatus: 'VALID',
            emailBouncedAt: null,
          },
        ]),
      },
      brandKit: { findUnique: jest.fn().mockResolvedValue({ defaultHashtags: ['#x'] }) },
      contentDistributionPlan: {
        findFirst: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'plan-1' }),
      },
      distributionDraft: {
        createMany: jest.fn().mockImplementation(({ data }: any) => {
          writes.push(...data.map((d: unknown) => ({ table: 'draft', data: d })));
          return Promise.resolve({ count: data.length });
        }),
        // Reads back what was WRITTEN, with ids, rather than an empty array.
        //
        // This line was `mockResolvedValue([])` and the mutation run caught it:
        // an auto-send loop bolted onto plan() would read the drafts it had just
        // created, get nothing back from the stub, and dispatch nothing — so the
        // spy stayed clean and this test passed while the code sent messages on
        // its own. A mock that answers "there is nothing there" makes any test
        // downstream of it vacuous.
        findMany: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(
              writes.map((w, i) => ({ id: `draft-${i}`, ...(w.data as object) })),
            ),
          ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      marketingUser: { findFirst: jest.fn().mockResolvedValue({ id: 'user-1', role: 'OWNER' }) },
    };
    return { prisma, writes };
  }

  it('never touches the send path while planning', async () => {
    const { prisma } = planningWorld();
    // The spy IS the assertion: if any code reachable from plan() ever grows a
    // dispatch, `start` records the call and this fails.
    const outbound = { start: jest.fn() };
    // Constructed so the sender exists in the test's world — the planner still
    // has no reference to it, which is the point.
    new DistributionSendService(prisma, outbound as never);

    await new ContentDistributionService(prisma).plan('ws-1', 'item-1', 'user-1');

    expect(outbound.start).not.toHaveBeenCalled();
  });

  it('writes drafts, and every one of them is DRAFT with no sent stamp', async () => {
    const { prisma, writes } = planningWorld();
    await new ContentDistributionService(prisma).plan('ws-1', 'item-1', 'user-1');

    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      const d = w.data as Record<string, unknown>;
      expect(d.status).toBe('DRAFT');
      expect(d.sentAt).toBeUndefined();
      expect(d.sentById).toBeUndefined();
      expect(d.conversationId).toBeUndefined();
    }
  });
});

describe('C — the actor is verified, not declared', () => {
  const DRAFT = {
    id: 'draft-1',
    workspaceId: 'ws-1',
    planId: 'plan-1',
    leadId: 'lead-1',
    channelId: 'ch-1',
    channelType: 'EMAIL',
    toAddress: 'a@example.com',
    body: 'Bunun motoru yok.',
    status: 'DRAFT',
  };

  function world(actor: unknown) {
    const prisma: any = {
      marketingUser: { findFirst: jest.fn().mockResolvedValue(actor) },
      distributionDraft: {
        findFirst: jest.fn().mockResolvedValue(DRAFT),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const outbound = {
      start: jest.fn().mockResolvedValue({
        conversationId: 'conv-1',
        to: 'a@example.com',
        channel: 'EMAIL',
      }),
    };
    return { svc: new DistributionSendService(prisma, outbound as never), prisma, outbound };
  }

  it('refuses an actor id that resolves to nobody', async () => {
    const { svc, outbound } = world(null);
    await expect(svc.send('ws-1', 'draft-1', 'made-up-id')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(outbound.start).not.toHaveBeenCalled();
  });

  it('refuses an empty actor id without even asking the database', async () => {
    const { svc, prisma, outbound } = world({ id: 'u', role: 'OWNER' });
    await expect(svc.send('ws-1', 'draft-1', '')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.marketingUser.findFirst).not.toHaveBeenCalled();
    expect(outbound.start).not.toHaveBeenCalled();
  });

  /**
   * The load-bearing one. `SYSTEM` is the per-workspace sentinel
   * `McpPrincipalService.resolve` hands back when no person is behind a call —
   * exactly what an unattended agent session gets. Every other write in this
   * feature accepts it happily, because every other write is inert.
   */
  it('refuses the SYSTEM sentinel an unattended MCP session resolves to', async () => {
    const { svc, outbound } = world({ id: 'sys-1', role: 'SYSTEM' });
    await expect(svc.send('ws-1', 'draft-1', 'sys-1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.send('ws-1', 'draft-1', 'sys-1')).rejects.toThrow(/person/i);
    expect(outbound.start).not.toHaveBeenCalled();
  });

  it('looks the actor up scoped to the workspace AND to being active', async () => {
    const { svc, prisma } = world({ id: 'u-1', role: 'OWNER' });
    await svc.send('ws-1', 'draft-1', 'u-1');
    expect(prisma.marketingUser.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u-1', workspaceId: 'ws-1', status: 'ACTIVE' },
      }),
    );
  });

  it('admits a real, active human — the harness is not just always-refuse', async () => {
    const { svc, outbound } = world({ id: 'u-1', role: 'MANAGER' });
    const res = await svc.send('ws-1', 'draft-1', 'u-1');
    expect(res.conversationId).toBe('conv-1');
    expect(outbound.start).toHaveBeenCalledWith('ws-1', {
      leadId: 'lead-1',
      channelId: 'ch-1',
      text: 'Bunun motoru yok.',
    });
  });

  it('stamps who sent it, together with the status, in one claim', async () => {
    const { svc, prisma } = world({ id: 'u-1', role: 'MANAGER' });
    await svc.send('ws-1', 'draft-1', 'u-1');
    const claim = prisma.distributionDraft.updateMany.mock.calls[0][0];
    expect(claim.where).toMatchObject({ id: 'draft-1', workspaceId: 'ws-1' });
    expect(claim.data).toMatchObject({ status: 'SENT', sentById: 'u-1' });
    expect(claim.data.sentAt).toBeInstanceOf(Date);
  });

  it('cannot send the same draft twice: a lost claim is refused, not re-dispatched', async () => {
    const { svc, prisma, outbound } = world({ id: 'u-1', role: 'MANAGER' });
    prisma.distributionDraft.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.send('ws-1', 'draft-1', 'u-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(outbound.start).not.toHaveBeenCalled();
  });
});
