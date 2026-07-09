import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TelephonyConfigService } from '../telephony/telephony-config.service';
import { NetsantralClient, NetsantralCreds } from '../../netgsm/santral/netsantral.client';
import { AgentPresenceDto } from '../dto/telephony-queue.dto';

/**
 * Queue wallboard + agent presence (NetGSM Phase 4 Task 4) — read-only queue
 * stats (`queuestats`) for the whole workspace, and a self-service
 * available/break toggle that acts on the AUTHENTICATED rep's OWN extension
 * (`MarketingUser.dahili`), never someone else's — there is no "set another
 * rep's presence" surface, mirroring the self-service webphone config
 * endpoints rather than the manager-scoped in-call controls.
 *
 * NOTE (documented caveat, surfaced to the frontend too): only DYNAMIC queue
 * members are reliably reflected in `queuestats` and manageable via
 * agentlogin/agentlogoff/agentpause — members added as STATIC in the NetGSM
 * portal UI are read-only from this API. Queue names follow NetGSM's
 * `{santral}-queue-{name}` convention.
 */
@Injectable()
export class TelephonyQueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telephonyConfig: TelephonyConfigService,
    private readonly client: NetsantralClient,
  ) {}

  /** GET /marketing/telephony/queues/stats */
  async stats(workspaceId: string, queueName?: string) {
    const creds = await this.resolveCreds(workspaceId);
    const outcome = await this.client.queueStats(creds, queueName);
    if (!outcome.ok) {
      throw new BadRequestException(outcome.message ?? 'Netsantral rejected the queue-stats request.');
    }
    return { queues: outcome.queues ?? [] };
  }

  /**
   * POST /marketing/telephony/agent/presence — resolves the CALLER's own
   * dahili (never a param the client could point at someone else) and flips
   * it via agentLogin ('available') or agentPause ('break', with reason).
   */
  async setPresence(workspaceId: string, marketingUserId: string, dto: AgentPresenceDto) {
    const creds = await this.resolveCreds(workspaceId);
    const rep = await this.prisma.marketingUser.findFirst({
      where: { id: marketingUserId, workspaceId },
      select: { dahili: true },
    });
    if (!rep?.dahili) {
      throw new BadRequestException('Set your extension (dahili) before toggling agent presence.');
    }
    const outcome =
      dto.state === 'available'
        ? await this.client.agentLogin(creds, rep.dahili)
        : await this.client.agentPause(creds, rep.dahili, dto.reason);
    if (!outcome.ok) {
      throw new BadRequestException(outcome.message ?? 'Netsantral rejected the presence request.');
    }
    return { ok: true, state: dto.state };
  }

  private async resolveCreds(workspaceId: string): Promise<NetsantralCreds> {
    const creds = await this.telephonyConfig.resolveForWorkspace(workspaceId);
    if (!creds) {
      throw new ServiceUnavailableException('Netsantral is not configured for this workspace');
    }
    return creds;
  }
}
