import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { MCP_ATTRIBUTION_PRINCIPAL_ROLE } from '../mcp/mcp-principal.service';
import { OutboundConversationService } from '../channels/outbound-conversation.service';

/** Statuses a draft may be sent FROM.
 *
 *  FAILED is included so a transient provider error does not strand a message a
 *  human has already decided to send; SENT is not, which is what makes a
 *  double-click impossible. */
const SENDABLE = ['DRAFT', 'FAILED'] as const;

/**
 * İçerik üretim hattı, aşama 4 — THE SEND BOUNDARY.
 *
 * This file is the ONLY thing in the distribution feature that can put a
 * message on the wire, and `distribution-send.boundary.spec.ts` is the test
 * that fails if that stops being true. Read that spec before adding a caller.
 *
 * ## Why the boundary is a file and not a comment
 *
 * The owner chose the shape and gave the reason: automated mass DMs to
 * strangers are what platform spam detection is built to catch, and the cost of
 * getting it wrong is a restricted account, not a bad metric. "A human sends"
 * therefore has to be something the code can be held to, not an intention.
 *
 * Three mechanisms hold it:
 *
 * 1. **Composition has no sender.** `ContentDistributionService` — the thing
 *    that produces plans and drafts, and the thing an agent can reach — does
 *    not import this service and cannot dispatch anything. The boundary is
 *    between OBJECTS, not between two branches of one method.
 * 2. **The actor is VERIFIED, not declared.** `send` takes an actor id and
 *    looks it up: it must be an ACTIVE `MarketingUser` of THIS workspace, and
 *    it must not be the `SYSTEM` sentinel that MCP sessions resolve to. A
 *    caller cannot satisfy this by passing a string it made up, and an
 *    unattended agent cannot satisfy it at all — the sentinel is precisely the
 *    principal an unattended session gets.
 * 3. **There is no MCP tool for it.** Planning and listing are tools; sending
 *    is a REST route with `@CurrentMarketingUser()` behind the auth guard. A
 *    model can prepare the outreach and can read what it prepared; it has no
 *    verb that sends.
 *
 * ## Why it reuses OutboundConversationService rather than sending directly
 *
 * That service already owns the whole first-move problem: which channels a
 * platform permits a first message on, opt-out, email hygiene, the identity
 * collision check, thread reuse — and it hands off to `MessageSenderService`
 * for quota, the adapter call, the `Message` row and spend settlement. A second
 * send path would be a second place for every one of those rules to be
 * forgotten, and the opt-out rule is not one to have two versions of.
 *
 * ## The claim, and the trade it makes
 *
 * The row is claimed out of `DRAFT` in one conditional `updateMany` BEFORE the
 * dispatch, so two clicks cannot both win. A crash between the claim and the
 * dispatch therefore leaves a row that says SENT when nothing went out. That is
 * the deliberate direction to fail in: for a feature whose whole reason for
 * existing is not to look like a spam bot, a message that did not go is
 * recoverable and a message that went twice is not.
 */
@Injectable()
export class DistributionSendService {
  private readonly logger = new Logger(DistributionSendService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbound: OutboundConversationService,
  ) {}

  /**
   * Send ONE prepared draft, because ONE person said to.
   *
   * @param actorId the signed-in human. Verified against the database — see the
   *                class docblock for why this is a lookup and not a parameter
   *                the caller is trusted on.
   * @param text    optional replacement copy. A draft a human edited before
   *                sending is the normal case, so what actually goes out is
   *                stored back onto the row: the record has to be of what was
   *                SENT, not of what was proposed.
   */
  async send(
    workspaceId: string,
    draftId: string,
    actorId: string,
    text?: string,
  ): Promise<{ draftId: string; conversationId: string; to: string; channel: string }> {
    await this.assertHumanActor(workspaceId, actorId);

    const draft = await this.prisma.distributionDraft.findFirst({
      where: { id: draftId, workspaceId },
    });
    if (!draft) {
      throw new NotFoundException(
        `Draft ${draftId} does not exist in this workspace, so there is nothing to send.`,
      );
    }
    if (!(SENDABLE as readonly string[]).includes(draft.status)) {
      throw new BadRequestException(
        `This draft is ${draft.status}, so it cannot be sent. Only a ${SENDABLE.join(' or ')} draft can — a sent one is already out, and a dismissed one was a decision.`,
      );
    }

    const bodyToSend = (text ?? draft.body).trim();
    if (!bodyToSend) {
      throw new BadRequestException(
        'This draft has no text, so there is nothing to send. Edit it first.',
      );
    }

    // The claim. `count: 0` means another click already took it.
    const claimed = await this.prisma.distributionDraft.updateMany({
      where: { id: draftId, workspaceId, status: { in: [...SENDABLE] } },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        // Written together with the status, never apart: a SENT row with a null
        // sentById would be evidence of exactly the behaviour this stage exists
        // to make impossible.
        sentById: actorId,
        body: bodyToSend,
        error: null,
      },
    });
    if (!claimed.count) {
      throw new BadRequestException(
        'This draft was already claimed by another send. It is not sent twice.',
      );
    }

    try {
      const res = await this.outbound.start(workspaceId, {
        leadId: draft.leadId,
        channelId: draft.channelId,
        text: bodyToSend,
      });
      await this.prisma.distributionDraft.update({
        where: { id: draftId },
        data: { conversationId: res.conversationId },
      });
      return {
        draftId,
        conversationId: res.conversationId,
        to: res.to,
        channel: res.channel,
      };
    } catch (e) {
      // FAILED with the REASON on the row. A draft that could not be delivered
      // must not read as one nobody chose to send.
      const why = e instanceof Error ? e.message : String(e);
      this.logger.warn(`distribution draft ${draftId} could not be sent: ${why}`);
      await this.prisma.distributionDraft
        .update({
          where: { id: draftId },
          data: { status: 'FAILED', sentAt: null, error: why.slice(0, 500) },
        })
        .catch(() => undefined);
      throw e;
    }
  }

  /**
   * The gate that makes "a human sends" enforceable.
   *
   * The `SYSTEM` role is excluded by name and that exclusion is the load-bearing
   * line: it is the per-workspace sentinel `McpPrincipalService.resolve` hands
   * back when no person is behind a call, so an unattended agent that found a
   * way to reach this method would still be refused here. Every other write in
   * this feature falls back to that sentinel happily — because every other write
   * is inert.
   */
  private async assertHumanActor(workspaceId: string, actorId: string): Promise<void> {
    if (!actorId) {
      throw new ForbiddenException(
        'Sending a distribution draft requires a signed-in person. Nothing in this feature sends on its own.',
      );
    }
    const actor = await this.prisma.marketingUser.findFirst({
      where: { id: actorId, workspaceId, status: 'ACTIVE' },
      select: { id: true, role: true },
    });
    if (!actor) {
      throw new ForbiddenException(
        'Sending a distribution draft requires an active member of this workspace.',
      );
    }
    if (actor.role === MCP_ATTRIBUTION_PRINCIPAL_ROLE) {
      throw new ForbiddenException(
        'The workspace automation principal cannot send a distribution draft. Sending is a per-message decision a person makes — that is the whole design of this feature, not a permission that can be granted.',
      );
    }
  }
}
