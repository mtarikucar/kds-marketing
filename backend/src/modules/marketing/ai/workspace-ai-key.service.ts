import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  isSecretBoxConfigured,
  maskSecret,
  sealSecret,
} from '../../../common/crypto/secret-box.helper';

/**
 * The workspace's own model key — the third writer, and the only instant one.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * A customer's reply is only instant if something can WRITE it the moment
 * their mail lands. Until now there were two writers and each had a wait built
 * into it:
 *
 *  - The PLATFORM key. One shared account, so when its credit runs out every
 *    workspace goes silent at the same moment — which is exactly what this
 *    deployment has been doing: `scheduled_jobs.lastError` carries "Your credit
 *    balance is too low to access the Anthropic API" as recently as yesterday.
 *  - The CONNECTOR. MCP is client-to-server and has no `sampling`, so nothing
 *    on the server can wake it. It has to be polled, which turns "instant"
 *    into "however often someone remembers to poll".
 *
 * A key that belongs to the workspace is simply present when the inbound event
 * fires. No queue, no poll, no shared balance to run dry — and no platform
 * credits charged, because the customer is paying the vendor directly.
 *
 * ── WHY THERE IS NO MCP TOOL FOR THIS ───────────────────────────────────────
 *
 * Setting the key is deliberately panel/REST only. An MCP tool would carry the
 * secret as a tool argument, which means through a model's context and into
 * whatever transcript that model keeps. A credential should reach the server
 * from the person who owns it, over one hop. `get()` masks, and nothing ever
 * returns the key again — losing it costs one rotation, and that is the right
 * trade.
 */
@Injectable()
export class WorkspaceAiKeyService {
  private readonly logger = new Logger(WorkspaceAiKeyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** What the panel may show: whether a key is set, when, and its last chars. */
  async get(workspaceId: string): Promise<{
    configured: boolean;
    hint: string | null;
    setAt: Date | null;
  }> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { aiApiKeyEnc: true, aiApiKeySetAt: true, settings: true },
    });
    if (!ws?.aiApiKeyEnc) return { configured: false, hint: null, setAt: null };
    // The hint is stored beside the key at write time — masking requires the
    // plaintext, and opening a sealed secret to render a label would mean
    // decrypting on a read path that has no business holding the key.
    const hint = ((ws.settings as Record<string, unknown> | null)?.aiApiKeyHint as string) ?? null;
    return { configured: true, hint, setAt: ws.aiApiKeySetAt };
  }

  /**
   * Store a key. Sealed at rest with the same box as PSP and channel
   * credentials.
   *
   * Rejected rather than stored when it does not look like an Anthropic key:
   * a typo saved silently becomes a workspace that has "configured AI" and
   * declines every reply, which is a worse failure than being told now.
   */
  async set(workspaceId: string, apiKey: string): Promise<{ configured: true; hint: string }> {
    const key = apiKey.trim();
    if (!key) throw new BadRequestException('API key is empty');
    if (!key.startsWith('sk-ant-')) {
      throw new BadRequestException(
        'That does not look like an Anthropic API key (expected it to start with "sk-ant-"). ' +
          'A Claude subscription is not an API key — create one at console.anthropic.com.',
      );
    }
    if (!isSecretBoxConfigured()) {
      throw new BadRequestException(
        'This deployment cannot store secrets (MARKETING_SECRET_KEY is not set), so a key here ' +
          'would have to be written in the clear. Refusing.',
      );
    }

    const hint = maskSecret(key);
    const existing = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { settings: true },
    });
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        aiApiKeyEnc: sealSecret(key),
        aiApiKeySetAt: new Date(),
        settings: {
          ...((existing?.settings as Record<string, unknown> | null) ?? {}),
          aiApiKeyHint: hint,
        },
      },
    });
    // No key material in the log line, now or ever.
    this.logger.log(`workspace ${workspaceId} now answers on its own AI key (${hint})`);
    return { configured: true, hint };
  }

  /**
   * Remove it. The workspace falls back to whatever `aiExecution` says, which
   * means back to the platform key or the connector queue — so this is a
   * decision to accept the wait again, not a no-op.
   */
  async clear(workspaceId: string): Promise<{ configured: false }> {
    const existing = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { settings: true },
    });
    const settings = { ...((existing?.settings as Record<string, unknown> | null) ?? {}) };
    delete settings.aiApiKeyHint;
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { aiApiKeyEnc: null, aiApiKeySetAt: null, settings: settings as never },
    });
    this.logger.log(`workspace ${workspaceId} cleared its own AI key — back to the platform lane`);
    return { configured: false };
  }
}
