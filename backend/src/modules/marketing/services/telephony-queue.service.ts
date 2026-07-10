import { Injectable, Logger, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TelephonyConfigService } from '../telephony/telephony-config.service';
import { NetsantralClient, NetsantralCreds } from '../../netgsm/santral/netsantral.client';
import { NetasistanClient } from '../../netgsm/netasistan/netasistan.client';
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
  private readonly logger = new Logger(TelephonyQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telephonyConfig: TelephonyConfigService,
    private readonly client: NetsantralClient,
    private readonly netasistan: NetasistanClient,
  ) {}

  /**
   * GET /marketing/telephony/queues/stats — a PASSIVE wallboard poll: it fires
   * on page entry (the calls page) and refetches every ~10s. It must degrade
   * gracefully and NEVER throw a user-facing error, because the global
   * query-error toast would then spam on every poll. Two failure modes both
   * resolve to an EMPTY wallboard (the widget renders its own "configure
   * Netsantral queues" empty state):
   *   1. the workspace hasn't configured Netsantral yet (no creds), and
   *   2. NetGSM rejects the read-only queuestats call — e.g. it answers with
   *      its own raw Turkish "Eksik yada yanlis parametre" when the account has
   *      no queue configured; that raw provider string must never surface as a
   *      toast on page entry.
   * Genuine rejections are logged server-side so ops can still see them.
   * (Contrast setPresence below — an explicit user action — which DOES surface
   * a rejection as an error, since the user is waiting on that click.)
   */
  async stats(workspaceId: string, queueName?: string) {
    const creds = await this.telephonyConfig.resolveForWorkspace(workspaceId);
    if (!creds) return { queues: [] };
    const outcome = await this.client.queueStats(creds, queueName);
    if (!outcome.ok) {
      this.logger.warn(
        `queuestats rejected for workspace ${workspaceId}: ${outcome.code ?? '-'} ${outcome.message ?? ''}`.trim(),
      );
      return { queues: [] };
    }
    return { queues: outcome.queues ?? [] };
  }

  /**
   * POST /marketing/telephony/agent/presence — resolves the CALLER's own
   * dahili (never a param the client could point at someone else) and flips
   * it via agentLogin ('available') or agentPause ('break', with reason).
   *
   * NetGSM Phase 6 Task 4: when this rep has ALSO opted into Netasistan
   * (`MarketingUser.netasistanOptIn`) AND the workspace has Netasistan
   * app-key/user-key configured, the SAME toggle additionally syncs presence
   * to Netasistan (self-service `setQueue` for 'available', `setBreak` for
   * 'break') — best-effort, see `syncNetasistan`: a Netasistan failure never
   * blocks or rolls back the santral outcome above, which remains the source
   * of truth this endpoint's result reflects.
   */
  async setPresence(workspaceId: string, marketingUserId: string, dto: AgentPresenceDto) {
    const creds = await this.resolveCreds(workspaceId);
    const rep = await this.prisma.marketingUser.findFirst({
      where: { id: marketingUserId, workspaceId },
      select: { dahili: true, netasistanOptIn: true },
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
    await this.syncNetasistan(workspaceId, rep.dahili, rep.netasistanOptIn, dto);
    return { ok: true, state: dto.state };
  }

  /**
   * Best-effort Netasistan mirror of the presence toggle just applied to the
   * santral above. Never throws — a Netasistan outage/misconfiguration must
   * NOT break the (already-succeeded) santral presence change; every failure
   * mode here is caught and logged, not surfaced to the caller.
   */
  private async syncNetasistan(
    workspaceId: string,
    dahili: string,
    netasistanOptIn: boolean,
    dto: AgentPresenceDto,
  ): Promise<void> {
    if (!netasistanOptIn) return;
    try {
      const netasistanCreds = await this.telephonyConfig.resolveNetasistanForWorkspace(workspaceId);
      if (!netasistanCreds) return; // opted in, but the workspace hasn't configured keys yet

      const auth = await this.netasistan.getToken(netasistanCreds.appKey, netasistanCreds.userKey);
      if (!auth.ok || !auth.token) {
        this.logger.warn(`Netasistan auth failed for workspace ${workspaceId}: ${auth.message}`);
        return;
      }

      // Best-effort re-use of the rep's Netsantral extension as the
      // Netasistan agent id — Netasistan may require a distinct agent
      // identifier of its own; that's an open item pending a live account
      // (same status as every other unconfirmed field/id in this program).
      const agentId = dahili;
      const result =
        dto.state === 'available'
          ? await this.netasistan.setQueue(auth.token, agentId, true)
          : await this.netasistan.setBreak(auth.token, agentId, dto.reason);
      if (!result.ok) {
        this.logger.warn(`Netasistan presence sync failed for workspace ${workspaceId}: ${result.message}`);
      }
    } catch (e: any) {
      this.logger.warn(`Netasistan presence sync threw for workspace ${workspaceId}: ${e?.message ?? e}`);
    }
  }

  private async resolveCreds(workspaceId: string): Promise<NetsantralCreds> {
    const creds = await this.telephonyConfig.resolveForWorkspace(workspaceId);
    if (!creds) {
      throw new ServiceUnavailableException('Netsantral is not configured for this workspace');
    }
    return creds;
  }
}
