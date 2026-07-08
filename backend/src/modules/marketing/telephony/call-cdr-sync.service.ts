import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { NetgsmCdrClient, CdrRecord } from '../../netgsm/santral/netgsm-cdr.client';
import { TelephonyConfigService } from './telephony-config.service';

type Creds = { usercode: string; password: string };

/**
 * Auto-fills SalesCall result/duration/recording from NetGSM Netsantral CDR —
 * so reps no longer have to log "connected / no answer" by hand.
 *
 * Every few minutes (advisory-locked, single replica) it pulls recent CDR for
 * each workspace and correlates records to still-unresolved (INITIATED) calls by
 * destination number, setting status (duration>0 → CONNECTED else NO_ANSWER),
 * durationSec, recordingUrl and endedAt. Credentials are REUSED from the
 * workspace's ACTIVE NetGSM SMS channel (the same usercode/password the SMS DLR
 * poll uses) — no extra setup, no migration. Inert when a workspace has no SMS
 * channel creds. The CDR API only authenticates from the prod IP (allow-listed),
 * so this effectively runs in production only.
 */
@Injectable()
export class CallCdrSyncService {
  private readonly logger = new Logger(CallCdrSyncService.name);
  /** Look back this far for both CDR and unresolved calls. */
  private static readonly WINDOW_HOURS = 12;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly cdr: NetgsmCdrClient,
    private readonly telephony: TelephonyConfigService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'call-cdr-sync' })
  async syncDue(): Promise<void> {
    await withAdvisoryLock(this.prisma, 'telephony:cdr-sync', async () => {
      // Only workspaces that can possibly have CDR creds: an ACTIVE SMS channel
      // (getCreds reads its sealed usercode/password). This supersedes the old
      // `workspace.status === 'ACTIVE'` scan — that filter is dropped, not
      // preserved, because workspace-active-but-no-SMS-channel workspaces have
      // no creds to sync anyway. Saves a linear scan over every workspace each
      // 5-min tick.
      const channels = await this.prisma.channel.findMany({
        where: { type: 'SMS', status: 'ACTIVE' },
        select: { workspaceId: true },
        distinct: ['workspaceId'],
      });
      const workspaces = channels.map((c) => ({ id: c.workspaceId }));
      let updated = 0;
      for (const ws of workspaces) {
        try {
          updated += await this.syncWorkspace(ws.id);
        } catch (e: any) {
          this.logger.warn(`cdr sync failed for ws ${ws.id}: ${e?.message ?? e}`);
        }
      }
      if (updated > 0) this.logger.log(`call-cdr-sync: filled ${updated} call(s) from CDR`);
    }, this.logger);
  }

  /** Pull CDR + correlate to INITIATED calls for one workspace. Returns # updated. */
  async syncWorkspace(workspaceId: string): Promise<number> {
    const creds = await this.getCreds(workspaceId);
    if (!creds) return 0; // no SMS channel creds → inert

    const since = new Date(Date.now() - CallCdrSyncService.WINDOW_HOURS * 3_600_000);
    const calls = await this.prisma.salesCall.findMany({
      where: { workspaceId, status: 'INITIATED', startedAt: { gte: since } },
      select: { id: true, toPhone: true, startedAt: true },
      orderBy: { startedAt: 'asc' },
    });
    if (calls.length === 0) return 0;

    const records = await this.cdr.fetchCdr(creds, fmtTr(since), fmtTr(new Date(Date.now() + 3_600_000)));
    if (records.length === 0) return 0;

    // Index records by destination (last 10 digits); consume each once.
    const byDest = new Map<string, CdrRecord[]>();
    for (const r of records) {
      const key = last10(r.destination);
      if (!key) continue;
      (byDest.get(key) ?? byDest.set(key, []).get(key)!).push(r);
    }

    let updated = 0;
    for (const call of calls) {
      const bucket = byDest.get(last10(call.toPhone));
      if (!bucket || bucket.length === 0) continue;
      const rec = bucket.shift()!; // consume one match
      const connected = rec.duration > 0;
      await this.prisma.salesCall.update({
        where: { id: call.id },
        data: {
          status: connected ? 'CONNECTED' : 'NO_ANSWER',
          durationSec: rec.duration,
          ...(rec.recording ? { recordingUrl: rec.recording } : {}),
          endedAt: new Date(),
        },
      });
      updated++;
    }
    return updated;
  }

  /** Diagnostic: run a raw CDR fetch for this workspace (prod-only auth). */
  async testFetch(workspaceId: string, startdate?: string, stopdate?: string) {
    const creds = await this.getCreds(workspaceId);
    if (!creds) {
      throw new BadRequestException(
        'No NetGSM credentials found — configure telephony (account no + password) or an SMS channel first.',
      );
    }
    const from = startdate ?? fmtTr(new Date(Date.now() - 24 * 3_600_000));
    const to = stopdate ?? fmtTr(new Date(Date.now() + 3_600_000));
    const raw = await this.cdr.fetchRaw(creds, from, to);
    return { usercode: creds.usercode, window: { startdate: from, stopdate: to }, ...raw };
  }

  /**
   * NetGSM API creds for the CDR call. The api.netgsm.com.tr report API uses the
   * main account usercode/password — which is the SAME credential the telephony
   * config already stores for crmsntrl originate (account no + account password).
   * Prefer an ACTIVE SMS channel's creds if present; otherwise fall back to the
   * telephony config creds (so CDR works with zero extra setup once telephony is
   * configured — no SMS channel required).
   */
  private async getCreds(workspaceId: string): Promise<Creds | null> {
    const channels = await this.prisma.channel.findMany({
      where: { workspaceId, type: 'SMS', status: 'ACTIVE' },
    });
    for (const ch of channels) {
      const s = this.registry.resolveConfig(ch as any).secrets;
      if (s?.usercode && s?.password) return { usercode: s.usercode, password: s.password };
    }
    const tel = await this.telephony.resolveForWorkspace(workspaceId);
    if (tel?.username && tel?.password) return { usercode: tel.username, password: tel.password };
    return null;
  }
}

/** Last 10 digits of a phone number (TR numbers normalize cleanly this way). */
function last10(phone?: string): string {
  const d = (phone ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

/** Format a Date as NetGSM's ddMMyyyyHHmm in Turkey local time (UTC+3). */
function fmtTr(d: Date): string {
  const t = new Date(d.getTime() + 3 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(t.getUTCDate())}${p(t.getUTCMonth() + 1)}${t.getUTCFullYear()}${p(t.getUTCHours())}${p(t.getUTCMinutes())}`;
}
