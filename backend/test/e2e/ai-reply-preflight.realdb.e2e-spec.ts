import { randomUUID } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AnthropicService } from '../../src/modules/marketing/ai/anthropic.service';
import { AiCreditsService } from '../../src/modules/marketing/ai/ai-credits.service';
import { ConversationAiEngineService } from '../../src/modules/marketing/channels/conversation-ai-engine.service';
import { createRealDbTestApp, closeTestApp, realDbEnabled } from '../utils/test-app';

/**
 * The AI reply path, end to end, against a REAL database — with only the vendor
 * call faked.
 *
 * Four separate fixes landed on this path in the last day, each unit-tested on
 * its own and NONE of them ever executed together, because the account has no
 * credit and the AI has not answered a customer once since the feature shipped:
 *
 *   v2.257.0  the brand block never carried `offerings`, so the agent was told
 *             to quote prices it could not see
 *   v2.259.0  the do-not-invent instruction sat inside `if (kb.length)`, so it
 *             vanished on exactly the workspaces with no knowledge base
 *   v2.260.0  captureLeadFields fills only EMPTY fields, and web-chat ingress
 *             writes contactPerson 'Unknown' — so the customer's name, once
 *             given, was silently dropped
 *   v2.254.0  a send the channel REFUSED was counted as sent, keeping the
 *             credit and burning a daily slot
 *
 * Four green unit tests do not prove they compose. This drives the real
 * `reply()` against real Postgres and asserts on the system prompt the model
 * actually receives and the row the database actually ends up with.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('AI reply pre-flight — real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let engine: ConversationAiEngineService;
  let complete: jest.Mock;

  const workspaceId = randomUUID();
  const channelId = randomUUID();
  const agentId = randomUUID();
  const leadId = randomUUID();
  const conversationId = randomUUID();
  const identityId = randomUUID();

  beforeAll(async () => {
    complete = jest.fn();
    ({ app, prisma } = await createRealDbTestApp((builder) => {
      builder.overrideProvider(AnthropicService).useValue({
        isEnabled: () => true,
        complete,
      });
      // Billing is a separate concern with its own tests, and a bare test
      // workspace has no plan — reserve() throws AI_CREDITS_EXHAUSTED before the
      // model is ever reached. Stubbed so this spec measures what it is for:
      // whether the four reply-path fixes compose.
      builder.overrideProvider(AiCreditsService).useValue({
        reserve: jest.fn().mockResolvedValue(undefined),
        refund: jest.fn().mockResolvedValue(undefined),
      });
    }));
    engine = app.get(ConversationAiEngineService);

    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: `preflight-${workspaceId.slice(0, 8)}`,
        name: 'Preflight',
        productName: 'Preflight',
      } as never,
    });
    await prisma.brandProfile.create({
      data: {
        workspaceId,
        brandName: 'HummyTummy',
        description: 'Çekirdek ücretsiz.',
        status: 'ACTIVE',
        // The field that never reached the model before v2.257.0.
        offerings: [
          { name: 'Çekirdek', price: 'Ücretsiz', blurb: 'POS, KDS, QR menü' },
          { name: 'Ek Şube', price: '3.990₺/yıl' },
        ],
      } as never,
    });
    await prisma.agentProfile.create({
      data: {
        id: agentId,
        workspaceId,
        name: 'cs',
        persona: 'Sen HummyTummy asistanısın.',
        status: 'ACTIVE',
        language: 'tr',
        // Deliberately EMPTY, like the live workspace: this is the state in
        // which the do-not-invent line used to disappear.
        kbDocIds: [],
        captureFields: ['name', 'phone'],
      } as never,
    });
    await prisma.channel.create({
      data: {
        id: channelId,
        workspaceId,
        type: 'WEBCHAT',
        name: 'web',
        status: 'ACTIVE',
        agentProfileId: agentId,
      },
    });
    await prisma.lead.create({
      data: {
        id: leadId,
        workspaceId,
        businessName: 'Web chat contact',
        // The ingress placeholder that used to occupy the name slot.
        contactPerson: 'Unknown',
        businessType: 'CAFE',
        source: 'OTHER',
      },
    });
    // A conversation with no contact identity CANNOT be delivered to, and the
    // sender says so: `to` is null and the send is marked FAILED with "no
    // recipient identity". Every live web-chat thread carries one. Leaving it
    // out made the first draft of this spec fail — which is v2.254.0 doing its
    // job: it refused to count a send that never happened.
    await prisma.contactIdentity.create({
      data: {
        id: identityId,
        workspaceId,
        channelId,
        leadId,
        kind: 'WEBCHAT',
        value: `visitor-${conversationId.slice(0, 8)}`,
      },
    });
    await prisma.conversation.create({
      data: {
        id: conversationId,
        workspaceId,
        channelId,
        leadId,
        contactIdentityId: identityId,
        status: 'OPEN',
        lastInboundAt: new Date(),
        lastMessageAt: new Date(),
      },
    });
    await prisma.message.create({
      data: {
        workspaceId,
        conversationId,
        direction: 'INBOUND',
        authorType: 'CUSTOMER',
        body: 'Merhaba, ek şube modülü ne kadar? Ben Ayşe Yılmaz.',
        status: 'RECEIVED',
      } as never,
    });
  });

  afterAll(async () => {
    await prisma.message.deleteMany({ where: { workspaceId } });
    await prisma.conversation.deleteMany({ where: { workspaceId } });
    await prisma.contactIdentity.deleteMany({ where: { workspaceId } });
    await prisma.lead.deleteMany({ where: { workspaceId } });
    await prisma.channel.deleteMany({ where: { workspaceId } });
    await prisma.agentProfile.deleteMany({ where: { workspaceId } });
    await prisma.brandProfile.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await closeTestApp(app);
  });

  it('sends the model a prompt carrying BOTH the price list and the honesty rule', async () => {
    complete.mockReset();
    complete.mockResolvedValue({
      text: 'Ek Şube modülü yıllık 3.990₺.',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1 },
    });

    await (engine as never as { reply: (w: string, c: string) => Promise<void> }).reply(
      workspaceId,
      conversationId,
    );

    expect(complete).toHaveBeenCalled();
    const system = String(complete.mock.calls[0][0].system);

    // v2.257.0 — the agent can see what it is told to quote.
    expect(system).toContain('Ek Şube — 3.990₺/yıl');
    // v2.259.0 — and is told not to make one up, with no knowledge base here.
    expect(system).toMatch(/Never invent facts/);
    expect(system).toMatch(/prices/);
  });

  it('writes the real name over the ingress placeholder and delivers the reply', async () => {
    complete.mockReset();
    // First turn: the model captures the name. Second: it answers.
    complete
      .mockResolvedValueOnce({
        text: '',
        toolUses: [
          { id: 't1', name: 'capture_lead_fields', input: { name: 'Ayşe Yılmaz' } },
        ],
        stopReason: 'tool_use',
        usage: { input: 1, output: 1 },
      })
      .mockResolvedValue({
        text: 'Teşekkürler Ayşe Hanım.',
        toolUses: [],
        stopReason: 'end_turn',
        usage: { input: 1, output: 1 },
      });

    await (engine as never as { reply: (w: string, c: string) => Promise<void> }).reply(
      workspaceId,
      conversationId,
    );

    // v2.260.0 — 'Unknown' is not an empty string, and used to block this write
    // entirely. A mocked Prisma cannot show that; the row can.
    const lead = await prisma.lead.findFirst({ where: { id: leadId, workspaceId } });
    expect(lead!.contactPerson).toBe('Ayşe Yılmaz');

    // v2.254.0 — the reply is only "sent" if the channel took it. Web chat
    // cannot refuse, so this one must land as a real OUTBOUND row.
    const out = await prisma.message.findMany({
      where: { workspaceId, conversationId, direction: 'OUTBOUND' },
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out[out.length - 1].status).toBe('SENT');
  });
});
