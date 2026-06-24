import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ConversationStreamService } from './conversation-stream.service';
import { StatusUpdate } from './channel-adapter.interface';
import { rankMetaStatus } from './meta-status.util';

/**
 * Applies provider delivery/read receipts to OUTBOUND messages — the receipt
 * analog of ConversationIngressService. Looks a Message up by its (unique)
 * externalMessageId, scopes to the workspace, advances status MONOTONICALLY
 * (an out-of-order READ-before-DELIVERED webhook never regresses), treats FAILED
 * as terminal (but never overwrites a confirmed DELIVERED/READ), and fans the
 * change out over SSE. Best-effort: a missing row or DB hiccup is swallowed, so
 * a flaky receipt can never break the fast-ACK webhook path.
 */
@Injectable()
export class MessageReceiptService {
  private readonly logger = new Logger(MessageReceiptService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: ConversationStreamService,
  ) {}

  async apply(workspaceId: string, updates: StatusUpdate[]): Promise<void> {
    for (const u of updates ?? []) {
      try {
        await this.applyOne(workspaceId, u);
      } catch (e: any) {
        this.logger.warn(
          `receipt apply failed (${u?.externalMessageId} → ${u?.status}): ${e?.message ?? e}`,
        );
      }
    }
  }

  private async applyOne(workspaceId: string, u: StatusUpdate): Promise<void> {
    if (!u?.externalMessageId) return;
    const msg = await this.prisma.message.findFirst({
      where: { externalMessageId: u.externalMessageId, workspaceId, direction: 'OUTBOUND' },
    });
    if (!msg) return; // unknown id (or an inbound message) → no-op

    if (u.status === 'FAILED') {
      // Never regress a confirmed delivery into FAILED; idempotent on FAILED.
      if (msg.status === 'DELIVERED' || msg.status === 'READ' || msg.status === 'FAILED') return;
      await this.prisma.message.update({
        where: { id: msg.id },
        data: { status: 'FAILED', error: String(u.reason ?? 'delivery failed').slice(0, 500) },
      });
    } else {
      // FAILED is terminal — never resurrect a failed message to DELIVERED/READ.
      // (rankMetaStatus('FAILED') is 0, so the rank guard alone would let a later
      // out-of-order DELIVERED/READ overwrite it.)
      if (msg.status === 'FAILED') return;
      // Monotonic DELIVERED/READ advance — never regress on an out-of-order webhook.
      if (rankMetaStatus(u.status) <= rankMetaStatus(msg.status)) return;
      await this.prisma.message.update({ where: { id: msg.id }, data: { status: u.status } });
    }

    // Live inbox tick. 'status' is NOT contact-safe, so the public widget skips it.
    this.stream.push(workspaceId, {
      kind: 'status',
      conversationId: msg.conversationId,
      payload: { messageId: msg.id, status: u.status, reason: u.reason ?? null },
    });
  }
}
