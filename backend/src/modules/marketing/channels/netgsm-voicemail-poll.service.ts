import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { withAdvisoryLock } from '../../../common/scheduling/advisory-lock';
import { safeFetch } from '../../../common/util/safe-fetch';
import { R2StorageService } from '../../../common/storage/r2-storage.service';
import { SttService } from '../voice-ai/stt.service';
import { ChannelAdapterRegistry } from './channel-adapter.registry';
import { ConversationIngressService } from './conversation-ingress.service';
import { AccountRateBudgeter } from '../../netgsm/core/account-rate-budgeter';
import { VoicesmsClient, VoicemailRow } from '../../netgsm/voice/voicesms.client';

/** The minimal Channel-row shape this poller reads (mirrors NetgsmMoPollService's
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

const BUDGET_BUCKET = 'voicemail';
/** NetGSM documents `/voicesms/receive` at 2 req/min per account. */
const BUDGET_LIMIT = 2;
const BUDGET_WINDOW_MS = 60_000;
/** NetGSM's voicemail window is capped at ≤24h, so an hourly cron MUST use a
 *  window ≤24h — 2h (like the MO poll's inbox() window) comfortably overlaps
 *  the hourly cadence with a 1h safety margin against a missed/delayed tick,
 *  without ever risking the 24h ceiling. */
const WINDOW_HOURS = 2;
/** R2 key prefix for a voicemail's proxy-downloaded copy — deterministic from
 *  (workspaceId, NetGSM's own record id), so it never needs to be persisted
 *  anywhere separately (a future playback route can recompute it). */
const R2_KEY_PREFIX = 'netgsm-voicemail';

/**
 * Hourly, advisory-locked poll of NetGSM's voicemail (telesekreter) inbox
 * (`/voicesms/receive`) into the shared omnichannel inbox — NetGSM Phase 4
 * Task 6. There is no push webhook for voicemail (unlike inbound SMS, which
 * has one and this poller mirrors as a design for the DIFFERENT reason that
 * voicemail has no push path at all, not as a backup for one): this cron IS
 * the primary and only path.
 *
 * Channel attribution mirrors `NetgsmMoPollService` EXACTLY: NetGSM's
 * voicemail response carries no per-channel identity, only a per-account
 * (usercode) scope, so channels are grouped by account and an account backing
 * more than one ACTIVE SMS channel is skipped (no reliable per-tenant
 * attribution — see that service's docstring for the full reasoning, which
 * applies identically here). An account with NO ACTIVE SMS channel — e.g. a
 * workspace that has only configured Netsantral telephony, no SMS channel —
 * has no `Conversation.channelId` to attach an inbox thread to (that field is
 * a required, non-nullable reference to a real Channel row) and is therefore
 * NOT reachable by this poller yet; a future task could mint a dedicated
 * channel for telephony-only workspaces if that's wanted, but that's out of
 * scope here (the inbox already exists wherever an SMS channel does, which is
 * the common case since both features share the one NetGSM account).
 *
 * Per voicemail row: dedupe on `netgsm-vm:<id>` (namespaced distinctly from
 * the SMS poller's `netgsm-mo:<id>`) checked BEFORE the expensive download
 * step (so an already-ingested voicemail from a prior, overlapping tick is
 * never re-downloaded); then best-effort proxy-download the `sesdosya`
 * audio into R2 (`netgsm-voicemail/<workspaceId>/<id>.mp3`, mirroring
 * `RecordingIngestService`'s ingest shape) when R2 is configured, and
 * best-effort STT (`SttService`, already inert until STT_PROVIDER/STT_API_KEY
 * are set) for a text preview; the Message body is the STT preview when one
 * came back, else the literal `'Sesli mesaj'`. Ingestion reuses
 * `NetgsmSmsAdapter.parseInbound` for sender normalization (the SAME +90
 * E.164 normalization the SMS poller/webhook use) via a synthetic SMS-shaped
 * row, then overrides the id/raw fields with the voicemail-specific ones —
 * so a voicemail lands through the exact same `ConversationIngressService`
 * path as every other channel, tagged `meta.raw.kind === 'VOICEMAIL'` (Message
 * has no separate channel/type column of its own — see that model — so this
 * is the minimal, additive way to mark a voicemail-shaped inbound message
 * without a schema change). `meta.raw.audioUrl` carries NetGSM's own
 * provider-tokenized link — an accepted fallback the same way
 * `RecordingProxyController`'s docstring accepts it for call recordings (a
 * short-lived, provider-managed link, NOT our R2 bucket's public URL, which
 * is deliberately never put in `meta` here).
 */
@Injectable()
export class NetgsmVoicemailPollService {
  private readonly logger = new Logger(NetgsmVoicemailPollService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly voicesms: VoicesmsClient,
    private readonly budgeter: AccountRateBudgeter,
    private readonly ingress: ConversationIngressService,
    private readonly r2: R2StorageService,
    private readonly stt: SttService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'netgsm-voicemail-poll' })
  async pollDue(): Promise<void> {
    await withAdvisoryLock(
      this.prisma,
      'netgsm-voicemail-poll',
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
          `netgsm-voicemail-poll: account ${account.usercode} backs ${account.channels.length} ACTIVE SMS channels — ` +
            'voicemail carries no per-channel identity, skipping this account to avoid cross-tenant mis-attribution',
        );
        continue;
      }
      const channel = account.channels[0];

      if (!this.budgeter.tryTake(account.usercode, BUDGET_BUCKET, BUDGET_LIMIT, BUDGET_WINDOW_MS)) {
        this.logger.warn(`netgsm-voicemail-poll: budget denied for account ${account.usercode} — skipping this tick`);
        continue;
      }

      let result;
      try {
        // NEVER call receiveVoicemails without both dates — see VoicesmsClient's
        // docstring for why there is no parameterless form to fall back to.
        result = await this.voicesms.receiveVoicemails({ usercode: account.usercode, password: account.password }, startdate, stopdate);
      } catch (e: any) {
        this.logger.warn(`netgsm-voicemail-poll: fetch failed for account ${account.usercode}: ${e?.message ?? e}`);
        continue;
      }
      if (!result.ok || result.voicemails.length === 0) continue;
      polled += result.voicemails.length;

      ingested += await this.ingestVoicemails(channel, adapter, result.voicemails);
    }

    return { polled, ingested };
  }

  /** Dedupes, downloads+stores, transcribes (best-effort) and ingests every
   *  polled voicemail row. Returns the count that were genuinely new. */
  private async ingestVoicemails(
    channel: ChannelRow,
    adapter: ReturnType<ChannelAdapterRegistry['get']>,
    rows: VoicemailRow[],
  ): Promise<number> {
    const config = this.registry.resolveConfig(channel);
    let ingestedCount = 0;

    for (const row of rows) {
      if (!row.id) {
        this.logger.warn('netgsm-voicemail-poll: voicemail row has no id — skipping (no reliable dedupe key)');
        continue;
      }
      // The WHOLE per-row pipeline (dedupe read, download, STT, ingest) is
      // guarded here — never just the ingress call — so a single row's DB
      // hiccup or unexpected exception can never abort the tick and skip
      // every account/row still queued behind it (mirrors
      // RecordingIngestService's per-item try/catch discipline).
      try {
        if (await this.ingestOneVoicemail(channel, config, adapter, row)) ingestedCount++;
      } catch (e: any) {
        this.logger.warn(
          `netgsm-voicemail-poll: processing failed for channel=${channel.id} voicemail=${row.id}: ${e?.message ?? e}`,
        );
      }
    }

    return ingestedCount;
  }

  /** Dedupe → download/STT (best-effort) → ingest for ONE voicemail row.
   *  Returns true iff it was genuinely newly ingested (not deduped). */
  private async ingestOneVoicemail(
    channel: ChannelRow,
    config: ReturnType<ChannelAdapterRegistry['resolveConfig']>,
    adapter: ReturnType<ChannelAdapterRegistry['get']>,
    row: VoicemailRow,
  ): Promise<boolean> {
    const externalMessageId = `netgsm-vm:${row.id}`;

    // Pre-check dedupe BEFORE the expensive download/STT work — an hourly
    // 2h-window tick overlaps the previous one by design, so most rows on
    // any given tick were already ingested last time.
    const existing = await this.prisma.message.findFirst({
      where: { externalMessageId, workspaceId: channel.workspaceId },
      select: { id: true },
    });
    if (existing) return false;

    const recordingStorageKey = await this.tryStoreRecording(channel.workspaceId, row);
    const sttPreview = await this.tryTranscribe(row);

    const bodyText = sttPreview || 'Sesli mesaj';
    // Reuse NetgsmSmsAdapter.parseInbound for the SAME +90 E.164 sender
    // normalization the SMS webhook/poller use, via a synthetic SMS-shaped
    // row; the id/raw fields below are overridden with the voicemail's own.
    const synthetic = { ceptel: row.from, mesaj: bodyText, gorevid: row.id };
    const parsed = adapter.parseInbound ? adapter.parseInbound(config, synthetic) : [];
    if (parsed.length === 0) {
      this.logger.warn(`netgsm-voicemail-poll: no resolvable sender for voicemail ${externalMessageId} — skipping`);
      return false;
    }

    const inbound = {
      ...parsed[0],
      externalMessageId,
      raw: {
        kind: 'VOICEMAIL',
        audioUrl: row.audioUrl ?? null,
        durationSec: row.durationSec ?? null,
        storedInR2: !!recordingStorageKey,
      },
    };

    const outcome = await this.ingress.ingest(
      { id: channel.id, workspaceId: channel.workspaceId, type: channel.type },
      inbound,
    );
    if (outcome && !outcome.deduped) {
      this.logger.log(
        `netgsm-voicemail-poll: ingested voicemail ${externalMessageId} into conversation=${outcome.conversationId} channel=${channel.id}`,
      );
      return true;
    }
    return false;
  }

  /** Best-effort proxy-download of the `sesdosya` audio into R2. Never throws;
   *  returns the stored key on success, null when R2 is unconfigured, there's
   *  no audio URL, or the download/upload failed for any reason (the provider
   *  URL is kept as the fallback either way — see the caller). */
  private async tryStoreRecording(workspaceId: string, row: VoicemailRow): Promise<string | null> {
    if (!row.audioUrl || !this.r2.isConfigured()) return null;
    try {
      const res = await safeFetch(row.audioUrl, { timeoutMs: 30_000 });
      if (!res.ok) {
        this.logger.warn(`netgsm-voicemail-poll: audio download failed for voicemail ${row.id}: HTTP ${res.status}`);
        return null;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0) {
        this.logger.warn(`netgsm-voicemail-poll: audio download empty for voicemail ${row.id}`);
        return null;
      }
      const key = `${R2_KEY_PREFIX}/${workspaceId}/${sanitizeKeySegment(row.id!)}.mp3`;
      await this.r2.uploadToKey(key, { mimetype: 'audio/mpeg', buffer, size: buffer.length });
      return key;
    } catch (e: any) {
      // row.audioUrl is a bearer-token link — never let it leak into a log
      // line via an interpolated error message (mirrors RecordingIngestService).
      const safeMsg = String(e?.message ?? 'unknown error').replace(/https?:\/\/\S+/gi, '***');
      this.logger.warn(`netgsm-voicemail-poll: audio ingest failed for voicemail ${row.id}: ${safeMsg}`);
      return null;
    }
  }

  /** Best-effort STT preview. `SttService.transcribeUrl` is already inert
   *  (resolves to null, no network call) until STT_PROVIDER/STT_API_KEY are
   *  set, and never throws — this wraps it defensively anyway so a future
   *  change to that contract can never take the poll tick down with it. */
  private async tryTranscribe(row: VoicemailRow): Promise<string | null> {
    if (!row.audioUrl) return null;
    try {
      const result = await this.stt.transcribeUrl(row.audioUrl);
      return result?.text?.trim() || null;
    } catch {
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
 *  is exact — mirrors `NetgsmMoPollService`'s private `fmtTr`, duplicated
 *  rather than imported because that helper is a private, file-scope function
 *  in an unrelated service. */
function fmtTr(d: Date): string {
  const t = new Date(d.getTime() + 3 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(t.getUTCDate())}${p(t.getUTCMonth() + 1)}${t.getUTCFullYear()}${p(t.getUTCHours())}${p(t.getUTCMinutes())}`;
}
