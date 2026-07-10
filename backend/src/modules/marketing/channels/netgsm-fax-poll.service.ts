import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { safeFetch } from '../../../common/util/safe-fetch';
import { R2StorageService } from '../../../common/storage/r2-storage.service';
import { EntitlementsService } from '../../billing/entitlements.service';
import { ChannelAdapterRegistry } from './channel-adapter.registry';
import { ConversationIngressService } from './conversation-ingress.service';
import { AccountRateBudgeter } from '../../netgsm/core/account-rate-budgeter';
import { FaxClient, FaxRow } from '../../netgsm/fax/fax.client';

/** The minimal Channel-row shape this poller reads (mirrors
 *  NetgsmVoicemailPollService's explicit `select`, which keeps `workspaceId` a
 *  query-arg literal for workspace-scoping.arch.spec.ts). */
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

const BUDGET_BUCKET = 'fax';
/** NetGSM's `/fax/receive` per-account cap is unconfirmed pending a live
 *  account (same "researched, not yet live-verified" status FaxClient's own
 *  docstring carries) — 2/min is the same conservative belt
 *  NetgsmVoicemailPollService uses for the sibling `/voicesms/receive` poll,
 *  far under any plausible limit for an hourly, one-call-per-account tick. */
const BUDGET_LIMIT = 2;
const BUDGET_WINDOW_MS = 60_000;
/** NetGSM's fax window is capped at ≤24h (mirrors voicemail), so an hourly
 *  cron MUST use a window ≤24h — 2h comfortably overlaps the hourly cadence
 *  with a 1h safety margin against a missed/delayed tick, without ever
 *  risking the 24h ceiling. */
const WINDOW_HOURS = 2;
/** R2 key prefix for a fax document's proxy-downloaded copy.
 *
 * Random-segment key (NOT purely deterministic from workspaceId + NetGSM's
 * record id) — same HIGH-2-style fix NetgsmVoicemailPollService applies to
 * its own recording key: the R2 bucket is public-read, so a key computable
 * from data already visible to a caller (workspaceId + this poller's own
 * `netgsm-fax:<id>` convention) would be a permanent, no-auth link once
 * ingested. The key is currently write-only (mirrors the voicemail poll's own
 * MEDIUM-1-deferred state — no playback/download proxy reads it back yet):
 * a future proxy route MUST persist and read back the actual stored key
 * rather than recomputing it from workspaceId+id, since recomputation is no
 * longer possible by design. */
const R2_KEY_PREFIX = 'netgsm-fax';

/**
 * Hourly, advisory-locked poll of NetGSM's inbound fax inbox (`/fax/receive`)
 * into the shared omnichannel inbox — NetGSM Phase 6 Task 2. There is no push
 * webhook for fax (unlike inbound SMS, which has one): this cron IS the
 * primary and only path, exactly like NetgsmVoicemailPollService is for
 * voicemail — the SAME shape for a different NetGSM endpoint and message kind.
 *
 * Channel attribution mirrors NetgsmVoicemailPollService EXACTLY: NetGSM's
 * fax response carries no per-channel identity, only a per-account (usercode)
 * scope (the same account also used for SMS/İYS/voice/balance/OTP, per
 * NetgsmCredentialsService's design), so channels are grouped by account and
 * an account backing more than one ACTIVE SMS channel is skipped (no
 * reliable per-tenant attribution — see NetgsmVoicemailPollService's
 * docstring for the full reasoning, which applies identically here).
 *
 * UNLIKE the voicemail/MO polls, this poller gates explicitly on TWO
 * entitlements before ever calling `fax.receive` (never just relying on the
 * SMS channel being ACTIVE the way those polls do): `fax` — a paid, narrowly
 * entitled OPERATOR-plan/add-on capability (see FEATURE_KEYS's `fax`
 * docstring) that an active SMS channel does NOT imply, since SMS channel
 * save/verify only requires the narrower `sms` key (see
 * ChannelsService.assertChannelFeature); and `conversationAi` — the inbox
 * itself, which that same SMS-channel gate also does NOT require. Skipping
 * the receive() call (and the rate-budget slot it would consume) for a
 * workspace lacking either avoids polling on behalf of a workspace that could
 * never see the result, and avoids ingesting a paid feature's document into
 * an inbox the workspace hasn't licensed.
 *
 * Per fax row: dedupe on `netgsm-fax:<id>` (namespaced distinctly from the
 * SMS poller's `netgsm-mo:<id>` and the voicemail poller's `netgsm-vm:<id>`)
 * checked BEFORE the expensive download step (so an already-ingested fax from
 * a prior, overlapping tick is never re-downloaded); then best-effort
 * proxy-download the document into R2
 * (`netgsm-fax/<workspaceId>/<id>-<random>.pdf`, mirroring
 * NetgsmVoicemailPollService's randomized-key ingest shape) when R2 is
 * configured. The Message body is the fixed literal `'Faks alındı'` — a fax
 * document has no STT-equivalent text preview. Ingestion reuses
 * NetgsmSmsAdapter.parseInbound for sender normalization (the SAME +90 E.164
 * normalization the SMS/voicemail poll paths use) via a synthetic SMS-shaped
 * row, then overrides the id/raw fields with the fax-specific ones — so a fax
 * lands through the exact same ConversationIngressService path as every other
 * channel, tagged `meta.raw.kind === 'FAX'` (Message has no separate
 * channel/type column of its own — see that model — so this is the minimal,
 * additive way to mark a fax-shaped inbound message without a schema change).
 * `meta.raw.documentUrl` carries NetGSM's own provider-tokenized link — the
 * SAME accepted fallback NetgsmVoicemailPollService's docstring documents for
 * `audioUrl` (a short-lived, provider-managed link, NOT our R2 bucket's
 * public URL, which is deliberately never put in `meta` here) — kept
 * consistent with that poller's choice for the identical KVKK reason (the R2
 * bucket is public-read, so a public R2 URL in `meta` would be a permanent,
 * no-auth link to a customer's document).
 */
@Injectable()
export class NetgsmFaxPollService {
  private readonly logger = new Logger(NetgsmFaxPollService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly fax: FaxClient,
    private readonly budgeter: AccountRateBudgeter,
    private readonly ingress: ConversationIngressService,
    private readonly r2: R2StorageService,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'netgsm-fax-poll' })
  async pollDue(): Promise<void> {
    await withAdvisoryLock(
      this.prisma,
      'netgsm-fax-poll',
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

    // Window computed ONCE per tick — every account polled over the same
    // [startdate, stopdate) window, never wider than NetGSM's ≤24h ceiling.
    const now = new Date();
    const stopdate = fmtTr(now);
    const startdate = fmtTr(new Date(now.getTime() - WINDOW_HOURS * 3_600_000));

    let polled = 0;
    let ingested = 0;

    for (const account of this.buildAccountGroups(channels).values()) {
      if (account.channels.length !== 1) {
        this.logger.warn(
          `netgsm-fax-poll: account ${account.usercode} backs ${account.channels.length} ACTIVE SMS channels — ` +
            'fax carries no per-channel identity, skipping this account to avoid cross-tenant mis-attribution',
        );
        continue;
      }
      const channel = account.channels[0];

      if (!(await this.isFaxEntitled(channel.workspaceId))) {
        this.logger.warn(
          `netgsm-fax-poll: workspace ${channel.workspaceId} lacks the fax/conversationAi entitlement — ` +
            `skipping account ${account.usercode}`,
        );
        continue;
      }

      if (!this.budgeter.tryTake(account.usercode, BUDGET_BUCKET, BUDGET_LIMIT, BUDGET_WINDOW_MS)) {
        this.logger.warn(`netgsm-fax-poll: budget denied for account ${account.usercode} — skipping this tick`);
        continue;
      }

      let result;
      try {
        // NEVER call receive() without both dates — see FaxClient's docstring
        // for why there is no parameterless form to fall back to.
        result = await this.fax.receive({ usercode: account.usercode, password: account.password }, startdate, stopdate);
      } catch (e: any) {
        this.logger.warn(`netgsm-fax-poll: fetch failed for account ${account.usercode}: ${e?.message ?? e}`);
        continue;
      }
      if (!result.ok || result.rows.length === 0) continue;
      polled += result.rows.length;

      ingested += await this.ingestFaxes(channel, adapter, result.rows);
    }

    return { polled, ingested };
  }

  /** True iff the workspace is entitled to BOTH `fax` (the paid capability
   *  itself) and `conversationAi` (the inbox this poller writes into) — see
   *  the class docstring for why an active SMS channel doesn't already imply
   *  either. */
  private async isFaxEntitled(workspaceId: string): Promise<boolean> {
    const effective = await this.entitlements.getEffective(workspaceId);
    return !!effective.features.fax && !!effective.features.conversationAi;
  }

  /** Dedupes, downloads+stores, and ingests every polled fax row. Returns the
   *  count that were genuinely new. */
  private async ingestFaxes(
    channel: ChannelRow,
    adapter: ReturnType<ChannelAdapterRegistry['get']>,
    rows: FaxRow[],
  ): Promise<number> {
    const config = this.registry.resolveConfig(channel);
    let ingestedCount = 0;

    for (const row of rows) {
      if (!row.id) {
        this.logger.warn('netgsm-fax-poll: fax row has no id — skipping (no reliable dedupe key)');
        continue;
      }
      // The WHOLE per-row pipeline (dedupe read, download, ingest) is guarded
      // here — never just the ingress call — so a single row's DB hiccup or
      // unexpected exception can never abort the tick and skip every
      // account/row still queued behind it (mirrors
      // NetgsmVoicemailPollService's per-item try/catch discipline).
      try {
        if (await this.ingestOneFax(channel, config, adapter, row)) ingestedCount++;
      } catch (e: any) {
        this.logger.warn(
          `netgsm-fax-poll: processing failed for channel=${channel.id} fax=${row.id}: ${e?.message ?? e}`,
        );
      }
    }

    return ingestedCount;
  }

  /** Dedupe → download (best-effort) → ingest for ONE fax row. Returns true
   *  iff it was genuinely newly ingested (not deduped). */
  private async ingestOneFax(
    channel: ChannelRow,
    config: ReturnType<ChannelAdapterRegistry['resolveConfig']>,
    adapter: ReturnType<ChannelAdapterRegistry['get']>,
    row: FaxRow,
  ): Promise<boolean> {
    const externalMessageId = `netgsm-fax:${row.id}`;

    // Pre-check dedupe BEFORE the expensive download step — an hourly
    // 2h-window tick overlaps the previous one by design, so most rows on
    // any given tick were already ingested last time.
    const existing = await this.prisma.message.findFirst({
      where: { externalMessageId, workspaceId: channel.workspaceId },
      select: { id: true },
    });
    if (existing) return false;

    const documentStorageKey = await this.tryStoreDocument(channel.workspaceId, row);

    // Reuse NetgsmSmsAdapter.parseInbound for the SAME +90 E.164 sender
    // normalization the SMS/voicemail poll paths use, via a synthetic
    // SMS-shaped row; the id/raw fields below are overridden with the fax's
    // own.
    const synthetic = { ceptel: row.from, mesaj: 'Faks alındı', gorevid: row.id };
    const parsed = adapter.parseInbound ? adapter.parseInbound(config, synthetic) : [];
    if (parsed.length === 0) {
      this.logger.warn(`netgsm-fax-poll: no resolvable sender for fax ${externalMessageId} — skipping`);
      return false;
    }

    const inbound = {
      ...parsed[0],
      externalMessageId,
      raw: {
        kind: 'FAX',
        documentUrl: row.documentUrl ?? null,
        storedInR2: !!documentStorageKey,
      },
    };

    const outcome = await this.ingress.ingest(
      { id: channel.id, workspaceId: channel.workspaceId, type: channel.type },
      inbound,
    );
    if (outcome && !outcome.deduped) {
      this.logger.log(
        `netgsm-fax-poll: ingested fax ${externalMessageId} into conversation=${outcome.conversationId} channel=${channel.id}`,
      );
      return true;
    }
    return false;
  }

  /** Best-effort proxy-download of the fax document into R2. Never throws;
   *  returns the stored key on success, null when R2 is unconfigured, there's
   *  no document URL, or the download/upload failed for any reason (the
   *  provider URL is kept as the fallback either way — see the caller). */
  private async tryStoreDocument(workspaceId: string, row: FaxRow): Promise<string | null> {
    if (!row.documentUrl || !this.r2.isConfigured()) return null;
    try {
      const res = await safeFetch(row.documentUrl, { timeoutMs: 30_000 });
      if (!res.ok) {
        this.logger.warn(`netgsm-fax-poll: document download failed for fax ${row.id}: HTTP ${res.status}`);
        return null;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0) {
        this.logger.warn(`netgsm-fax-poll: document download empty for fax ${row.id}`);
        return null;
      }
      const key = `${R2_KEY_PREFIX}/${workspaceId}/${sanitizeKeySegment(row.id!)}-${randomUUID()}.pdf`;
      await this.r2.uploadToKey(key, { mimetype: 'application/pdf', buffer, size: buffer.length });
      return key;
    } catch (e: any) {
      // row.documentUrl is a bearer-token link — never let it leak into a log
      // line via an interpolated error message (mirrors
      // NetgsmVoicemailPollService).
      const safeMsg = String(e?.message ?? 'unknown error').replace(/https?:\/\/\S+/gi, '***');
      this.logger.warn(`netgsm-fax-poll: document ingest failed for fax ${row.id}: ${safeMsg}`);
      return null;
    }
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

/** Strip anything but `[a-zA-Z0-9_-]` from a provider-supplied id before it
 *  becomes an R2 key segment — defensive hygiene against a stray `/` or other
 *  key-mangling character in an upstream field we don't control. */
function sanitizeKeySegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Format a Date as NetGSM's ddMMyyyyHHmm in Turkey local time. Turkey has
 *  observed a permanent UTC+3 offset (no DST) since 2016, so a fixed +3h shift
 *  is exact — mirrors NetgsmVoicemailPollService's private `fmtTr`, duplicated
 *  rather than imported because that helper is a private, file-scope function
 *  in an unrelated service. */
function fmtTr(d: Date): string {
  const t = new Date(d.getTime() + 3 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(t.getUTCDate())}${p(t.getUTCMonth() + 1)}${t.getUTCFullYear()}${p(t.getUTCHours())}${p(t.getUTCMinutes())}`;
}
