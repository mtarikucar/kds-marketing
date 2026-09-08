import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChannelAdapterRegistry } from './channel-adapter.registry';
import { ResolvedChannelConfig } from './channel-adapter.interface';

export interface MailboxSendResult {
  ok: boolean;
  messageId: string | null;
  error?: string;
}

/**
 * "Send this as the workspace, from its own address" — the one place that
 * decides whether a workspace has a usable mailbox, and sends through it.
 *
 * It exists because the decision was made TWICE and the copies drifted. The
 * campaign sender learned to use a connected mailbox; the workflow engine kept
 * calling the platform mailer, so an automation's mail still left from the
 * platform address while the same workspace's campaigns left from its own. One
 * caller was fixed, its sibling was not, and nothing in the code connected
 * them. A shared owner is what stops the next caller from picking the wrong
 * default by accident.
 *
 * Callers FALL BACK when this returns null: no mailbox is a normal state, not
 * an error, and mail must still go out on the platform transport.
 */
@Injectable()
export class WorkspaceMailboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
  ) {}

  /**
   * The workspace's own mailbox, resolved for sending — or null to fall through
   * to the platform transport.
   *
   * Two conditions, both deliberate:
   *
   * `lastVerifiedAt: { not: null }` — ChannelsService.verify writes it ONLY on
   * `health.ok`, so this is a mailbox whose SMTP login has actually been
   * accepted. Sending through credentials nobody has proved is how you get a
   * run of `535 Authentication Failed` with the send already recorded.
   *
   * SMTP only — a consent-connected (OAuth) mailbox falls through on purpose.
   * `email-oauth.sender.ts` pins Microsoft to `contentType: 'Text'` and builds
   * Gmail's RFC822 with no HTML part, so routing rich mail there would silently
   * drop the HTML body. Plain text from the right address is worse than
   * formatted from the platform's.
   */
  async resolve(workspaceId: string): Promise<ResolvedChannelConfig | null> {
    const ch = await this.prisma.channel.findFirst({
      where: { workspaceId, type: 'EMAIL', status: 'ACTIVE', lastVerifiedAt: { not: null } },
    });
    if (!ch) return null;
    const resolved = this.registry.resolveConfig(ch);
    const s = (resolved.secrets ?? {}) as Record<string, string | undefined>;
    if (s.oauthProvider) return null;
    return s.smtpHost?.trim() && s.smtpUser?.trim() && s.smtpPass ? resolved : null;
  }

  /**
   * Send through the workspace's own mailbox, or return null when it has none —
   * which is the caller's signal to use the platform transport instead.
   *
   * `text` always rides along with `html`: multipart is what clients and spam
   * filters expect, and an HTML-only mail from a new sending identity is a
   * reputation problem by itself.
   */
  async send(input: {
    workspaceId: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<MailboxSendResult | null> {
    const config = await this.resolve(input.workspaceId);
    if (!config) return null;
    const r = await this.registry.get('EMAIL').send({
      config,
      to: input.to,
      text: input.text,
      subject: input.subject,
      html: input.html,
    });
    return {
      ok: r.status === 'SENT',
      messageId: r.externalMessageId,
      error: r.error,
    };
  }
}
