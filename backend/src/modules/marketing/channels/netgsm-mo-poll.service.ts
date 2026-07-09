import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { ChannelAdapterRegistry } from './channel-adapter.registry';
import { ConversationIngressService } from './conversation-ingress.service';
import { AccountRateBudgeter } from '../../netgsm/core/account-rate-budgeter';
import { SmsV2Client, SmsV2InboxMessage } from '../../netgsm/sms/sms-v2.client';

/** The minimal Channel-row shape this poller reads (mirrors NetgsmDlrPollService's
 *  explicit `select`, which keeps `workspaceId` a query-arg literal for
 *  workspace-scoping.arch.spec.ts). */
interface ChannelRow {
  id: string;
  workspaceId: string;
  type: string;
  externalId: string | null;
  configSealed: string | null;
  configPublic: unknown;
}

/** One NetGSM account (usercode) and the ACTIVE SMS channel(s) resolving to it. */
interface AccountGroup {
  usercode: string;
  password: string;
  channels: ChannelRow[];
}

const BUDGET_BUCKET = 'inbox';
/** Conservative — NetGSM's inbox endpoint has no documented per-account cap;
 *  2/min keeps an hourly poll (normally one call/account/tick) far under any
 *  plausible limit even if a tick is retried. */
const BUDGET_LIMIT = 2;
const BUDGET_WINDOW_MS = 60_000;
/** The MO poll is a BACKUP for the push webhook, not the primary path — a
 *  short lookback bounds how much has to be re-fetched/re-attributed if a
 *  tick is delayed, while comfortably overlapping the hourly cadence (2h
 *  window on an hourly cron leaves a 1h safety margin against a missed tick). */
const WINDOW_HOURS = 2;

/**
 * Backup poller for NetGSM inbound SMS (MO) replies. The primary path is the
 * push webhook (`NetgsmPublicController.mo`, "İnteraktif SMS → URL'ye
 * Yönlendir") — NetGSM does not retry a failed push and panel misconfiguration
 * (wrong/missing callback URL) silently drops replies with no error visible to
 * us. This hourly, advisory-locked cron re-fetches the last `WINDOW_HOURS`
 * from `SmsV2Client.inbox` (the date-ranged form ONLY — the parameterless form
 * marks messages seen server-side and would race the webhook, see Task 1's
 * client docstring) and ingests anything the webhook missed, through the exact
 * same `ConversationIngressService` path and `NetgsmSmsAdapter.parseInbound`
 * namespacing (`netgsm-mo:<id>`) the webhook uses — so a message picked up
 * here is byte-for-byte indistinguishable from one the webhook delivered, and
 * `ConversationIngressService.ingest`'s own `externalMessageId` dedup (not a
 * second hand-rolled check here) is what prevents a double-ingest of anything
 * the webhook already delivered.
 *
 * Channel attribution: NetGSM's inbox response carries NO channel identity
 * (unlike the webhook URL, which embeds the channel id) — it is scoped only to
 * the polled NetGSM account. Channels are grouped by account (usercode); an
 * account backing exactly one ACTIVE SMS channel (the overwhelmingly common
 * case — and the only shape the live push path can address anyway, since
 * NetGSM's panel accepts a single callback URL per account) attributes every
 * polled message to that channel. An account backing MORE than one channel
 * (agencies sharing one NetGSM contract, per NetgsmDlrPollService's
 * AccountGroup) is skipped with a warning: there is no reliable way to tell
 * which workspace a given reply belongs to, and guessing would risk ingesting
 * one tenant's customer reply into another tenant's inbox — a correctness
 * failure far worse than a missed poll tick.
 */
@Injectable()
export class NetgsmMoPollService {
  private readonly logger = new Logger(NetgsmMoPollService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly smsV2: SmsV2Client,
    private readonly budgeter: AccountRateBudgeter,
    private readonly ingress: ConversationIngressService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'netgsm-mo-poll' })
  async pollDue(): Promise<void> {
    await withAdvisoryLock(
      this.prisma,
      'netgsm-mo-poll',
      async () => {
        await this.poll();
      },
      this.logger,
    );
  }

  async poll(): Promise<{ polled: number; ingested: number }> {
    const channels = await this.prisma.channel.findMany({
      where: { type: 'SMS', status: 'ACTIVE' },
      select: {
        id: true,
        workspaceId: true,
        type: true,
        externalId: true,
        configSealed: true,
        configPublic: true,
      },
    });
    if (channels.length === 0 || !this.registry.has('SMS')) {
      return { polled: 0, ingested: 0 };
    }
    const adapter = this.registry.get('SMS');

    // Window is computed ONCE per tick (not per account) — every account is
    // polled over the same [startdate, stopdate) so a slow tick can't silently
    // widen or narrow one account's coverage relative to another's.
    const now = new Date();
    const stopdate = fmtTr(now);
    const startdate = fmtTr(new Date(now.getTime() - WINDOW_HOURS * 3_600_000));

    let polled = 0;
    let ingested = 0;

    for (const account of this.buildAccountGroups(channels).values()) {
      if (account.channels.length !== 1) {
        this.logger.warn(
          `netgsm-mo-poll: account ${account.usercode} backs ${account.channels.length} ACTIVE SMS channels — ` +
            'inbox() carries no per-channel identity, skipping this account to avoid cross-tenant mis-attribution',
        );
        continue;
      }
      const channel = account.channels[0];

      if (!this.budgeter.tryTake(account.usercode, BUDGET_BUCKET, BUDGET_LIMIT, BUDGET_WINDOW_MS)) {
        this.logger.warn(`netgsm-mo-poll: budget denied for account ${account.usercode} — skipping this tick`);
        continue;
      }

      let result;
      try {
        // NEVER call inbox() without both dates — the parameterless form marks
        // every message seen and races the push webhook.
        result = await this.smsV2.inbox({ usercode: account.usercode, password: account.password }, startdate, stopdate);
      } catch (e: any) {
        this.logger.warn(`netgsm-mo-poll: inbox fetch failed for account ${account.usercode}: ${e?.message ?? e}`);
        continue;
      }
      if (!result.ok || result.messages.length === 0) continue;
      polled += result.messages.length;

      const recovered = await this.ingestMessages(channel, adapter, result.messages);
      ingested += recovered;

      if (recovered > 0) {
        this.logger.warn(
          `netgsm-mo-poll: recovered ${recovered} message(s) the push webhook missed for channel=${channel.id} account=${account.usercode}`,
        );
        await this.stampRecovery(channel.id);
      }
    }

    return { polled, ingested };
  }

  /** Parses + ingests every polled row through the SAME adapter.parseInbound
   *  (identical externalUserId normalization + `netgsm-mo:<id>` namespacing)
   *  and ConversationIngressService path the push webhook uses. Returns the
   *  count of messages that were genuinely missing (webhook-missed) — as
   *  opposed to ones `ingress.ingest` resolved as an existing row
   *  (`deduped: true`), which the webhook (or a previous poll tick) already
   *  delivered. */
  private async ingestMessages(
    channel: ChannelRow,
    adapter: ReturnType<ChannelAdapterRegistry['get']>,
    messages: SmsV2InboxMessage[],
  ): Promise<number> {
    const config = this.registry.resolveConfig(channel);
    let recovered = 0;
    for (const msg of messages) {
      const parsed = adapter.parseInbound ? adapter.parseInbound(config, msg) : [];
      for (const inbound of parsed) {
        // A row with no provider id (`inbound.externalMessageId === null`)
        // gets a digest-based dedupe key instead — see `digestId` docstring
        // for the residual collision risk this accepts.
        const externalMessageId = inbound.externalMessageId ?? this.digestId(msg);
        try {
          const outcome = await this.ingress.ingest(
            { id: channel.id, workspaceId: channel.workspaceId, type: channel.type },
            { ...inbound, externalMessageId },
          );
          if (outcome && !outcome.deduped) recovered++;
        } catch (e: any) {
          this.logger.warn(
            `netgsm-mo-poll: ingest failed for channel=${channel.id} externalMessageId=${externalMessageId}: ${e?.message ?? e}`,
          );
        }
      }
    }
    return recovered;
  }

  /** Fallback dedupe key for an inbox row NetGSM returned with no `id`:
   *  `netgsm-mo-digest:<sha256(no|msg|date)>`. Residual risk (accepted for a
   *  BACKUP path only): two genuinely distinct replies from the same sender,
   *  with byte-identical text, reported under the same `date` bucket, collapse
   *  onto the same key — the second is dropped as a false "duplicate". NetGSM
   *  virtually always supplies an id (`gorevid`) on real accounts, so this
   *  branch is expected to be rare in practice. */
  private digestId(msg: SmsV2InboxMessage): string {
    const hash = createHash('sha256')
      .update(`${msg.no} ${msg.msg} ${msg.date ?? ''}`)
      .digest('hex');
    return `netgsm-mo-digest:${hash}`;
  }

  /** Merge-write `configPublic.lastMoPollRecovery` — re-reads the row
   *  immediately before writing (rather than reusing the tick-start snapshot)
   *  and spreads the existing blob, mirroring NetgsmDlrPollService's
   *  `rollupCampaignStats` merge pattern, so a concurrent settings save (which
   *  replaces `configPublic` wholesale — see ChannelsService.update) loses at
   *  most this one field's staleness, never the reverse. */
  private async stampRecovery(channelId: string): Promise<void> {
    const fresh = await this.prisma.channel.findFirst({
      where: { id: channelId },
      select: { configPublic: true },
    });
    const pub =
      fresh?.configPublic && typeof fresh.configPublic === 'object'
        ? (fresh.configPublic as Record<string, unknown>)
        : {};
    await this.prisma.channel.update({
      where: { id: channelId },
      data: {
        configPublic: { ...pub, lastMoPollRecovery: new Date().toISOString() } as Prisma.InputJsonValue,
      },
    });
  }

  private buildAccountGroups(channels: ChannelRow[]): Map<string, AccountGroup> {
    const groups = new Map<string, AccountGroup>();
    for (const ch of channels) {
      const { secrets } = this.registry.resolveConfig(ch);
      if (!secrets.usercode || !secrets.password) continue;
      let group = groups.get(secrets.usercode);
      if (!group) {
        group = { usercode: secrets.usercode, password: secrets.password, channels: [] };
        groups.set(secrets.usercode, group);
      }
      group.channels.push(ch);
    }
    return groups;
  }
}

/** Format a Date as NetGSM's ddMMyyyyHHmm in Turkey local time. Turkey has
 *  observed a permanent UTC+3 offset (no DST) since 2016, so a fixed +3h shift
 *  is exact — mirrors `CallCdrSyncService`'s private `fmtTr`
 *  (telephony/call-cdr-sync.service.ts), duplicated rather than imported
 *  because that helper is a private, file-scope function in an unrelated
 *  service and this cron has no other dependency on the telephony module. */
function fmtTr(d: Date): string {
  const t = new Date(d.getTime() + 3 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(t.getUTCDate())}${p(t.getUTCMonth() + 1)}${t.getUTCFullYear()}${p(t.getUTCHours())}${p(t.getUTCMinutes())}`;
}
