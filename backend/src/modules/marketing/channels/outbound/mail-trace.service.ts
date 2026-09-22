import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { SystemSentinelService } from '../system-sentinel';
import { GATE_MATRIX, MailClass, gateApplies } from './mail-class';
import { MailReceipt } from './outbound-mail.types';

/**
 * The tenant-visible half of the ledger: one `LeadActivity` per mail, on the
 * lead's own timeline.
 *
 * Workflow, MCP and campaign mail used to leave no trace a human could see at
 * all (`automated-email-not-recorded`): a lead replied "can you do 10.000?" to
 * an automated quote and the thread held only the reply, so the rep — and the
 * AI — had no idea what had been sent. `MailLog` answers that for an operator;
 * this answers it for the person looking at the lead.
 *
 * It is written for the outcomes the class asks for, INCLUDING a refusal. "We
 * did not send this, because they unsubscribed" is the single most useful line
 * this timeline can carry, and it is the one that never existed.
 *
 * Three rules, each from a real failure:
 *
 * - **Never throws.** It runs AFTER the dispatch. A throw here would report a
 *   mail that already reached the customer as failed, and the workflow executor
 *   turns a thrown step into a whole-run FAILED (PLAN G2).
 * - **Never invents an author.** `LeadActivity.createdById` is NOT NULL with
 *   `onDelete: Restrict`; a workspace with no SYSTEM sentinel gets a `warn` and
 *   no row, not a fabricated id.
 * - **Never localises.** The timeline is tenant-facing and renders through the
 *   frontend dictionaries, so the machine codes travel in `metadata` and the
 *   only free text stored is the provider's own words (PLAN G8).
 */

export interface MailTraceInput {
  workspaceId: string;
  leadId?: string | null;
  mailClass: MailClass;
  subject: string;
  source: string;
  receipt: MailReceipt;
  /** CONVERSATIONAL: the `Message` row is the trace, so the matrix says no. */
  proactive?: boolean;
  aiAuthored?: boolean;
  ticari?: boolean;
}

/** `LeadActivity.title` is a display column, not a body. */
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 300;

function outcomeOf(receipt: MailReceipt): string {
  if (receipt.ok) return 'POSITIVE';
  // A refusal is policy working, not a delivery that went wrong — it must not
  // read on the timeline as a failed send.
  return receipt.outcome === 'REFUSED' ? 'NEUTRAL' : 'NEGATIVE';
}

@Injectable()
export class MailTraceService {
  private readonly logger = new Logger(MailTraceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sentinel: SystemSentinelService,
  ) {}

  /** Best-effort, after the send, outside any transaction. */
  async record(input: MailTraceInput): Promise<void> {
    const gate = GATE_MATRIX[input.mailClass]?.leadActivity;
    if (!gate) return;
    const wanted = gateApplies(gate, {
      proactive: input.proactive,
      aiAuthored: input.aiAuthored,
      ticari: input.ticari,
    });
    if (!wanted || !input.leadId) return;

    const createdById = await this.sentinel.resolve(input.workspaceId);
    if (!createdById) {
      this.logger.warn(
        `No SYSTEM user in workspace ${input.workspaceId} — mail trace skipped (lead=${input.leadId})`,
      );
      return;
    }

    const { receipt } = input;
    try {
      await this.prisma.leadActivity.create({
        data: {
          type: 'EMAIL',
          title: (input.subject || '').trim().slice(0, MAX_TITLE) || 'E-mail',
          description: receipt.error ? receipt.error.slice(0, MAX_DESCRIPTION) : null,
          outcome: outcomeOf(receipt),
          leadId: input.leadId,
          createdById,
          metadata: {
            kind: 'mail',
            mailClass: input.mailClass,
            source: input.source,
            outcome: receipt.outcome,
            transport: receipt.transport,
            ...(receipt.reason ? { reason: receipt.reason } : {}),
            ...(receipt.mailLogId ? { mailLogId: receipt.mailLogId } : {}),
            ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
            ...(receipt.userMessage ? { userMessage: receipt.userMessage } : {}),
          },
        },
      });
    } catch (e: any) {
      this.logger.warn(`mail trace failed (lead=${input.leadId}): ${e?.message ?? e}`);
    }
  }
}
