import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TelephonyConfigService } from '../telephony/telephony-config.service';
import { BalanceClient, BalanceResult } from '../../netgsm/balance/balance.client';
import { SmsV2Client } from '../../netgsm/sms/sms-v2.client';
import { netgsmWebhookUrl } from '../../netgsm/webhooks/netgsm-webhook.util';
import { netgsmMoCallbackUrl } from '../channels/netgsm-callback.util';
import { ChannelAdapterRegistry, ChannelRowLike } from '../channels/channel-adapter.registry';
import { R2StorageService } from '../../../common/storage/r2-storage.service';

export interface OnboardingItem {
  key: string;
  state: 'ok' | 'missing' | 'unknown';
  /**
   * Free text is either a real diagnostic value (NetGSM credit / rep count —
   * safe to render verbatim) or one of the fixed i18n-able keys below, never
   * hardcoded prose — NetgsmOnboardingCard resolves the latter via
   * `accounts.netgsm.detail.<key>`.
   */
  detail?: string;
  url?: string;
}

/** Live /balance probe budget — NetGSM being slow/down must never hang the
 *  Account Center page; past this we degrade to 'unknown' and move on. */
const BALANCE_PROBE_TIMEOUT_MS = 5_000;
const TIMEOUT_RESULT: BalanceResult = {
  ok: false, credsValid: null, code: null, credit: null, packages: [], message: 'timeout',
};

/**
 * NetGSM onboarding checklist — the manual portal steps a tenant must click
 * through (NetGSM exposes no provisioning API), each with a live check where
 * an API read exists. Rendered by NetgsmOnboardingCard in Account Center.
 */
@Injectable()
export class NetgsmOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telephony: TelephonyConfigService,
    private readonly balance: BalanceClient,
    private readonly smsV2: SmsV2Client,
    private readonly registry: ChannelAdapterRegistry,
    private readonly r2: R2StorageService,
  ) {}

  async checklist(workspaceId: string): Promise<{ items: OnboardingItem[] }> {
    const base = process.env.PUBLIC_BASE_URL;
    const items: OnboardingItem[] = [];

    const sms = await this.prisma.channel.findFirst({
      where: { workspaceId, type: 'SMS', status: 'ACTIVE' },
      select: { id: true, workspaceId: true, type: true, externalId: true, configSealed: true, configPublic: true },
    });
    items.push({ key: 'smsChannel', state: sms ? 'ok' : 'missing' });
    items.push({
      key: 'moUrl',
      state: sms ? 'ok' : 'missing',
      url: sms ? netgsmMoCallbackUrl(base, sms.id) ?? undefined : undefined,
    });

    // Simplification: SMS and Netsantral currently share one NetGSM account,
    // so the live credential probe below (via TelephonyConfig) doubles as the
    // SMS creds check. `detail` always names which source was actually
    // probed — 'noSantralConfig' when there's nothing to probe with yet, or
    // 'viaSantralCreds' once the shared account is configured — so the UI
    // never implies a dedicated SMS-only check that doesn't exist.
    const cfg = await this.telephony.resolveForWorkspace(workspaceId);
    let smsCreds: OnboardingItem;
    if (!cfg) {
      smsCreds = { key: 'smsCredsLive', state: 'unknown', detail: 'noSantralConfig' };
    } else {
      const probe = await this.probeBalance(cfg.username, cfg.password);
      smsCreds = {
        key: 'smsCredsLive',
        state: probe.credsValid === true ? 'ok' : probe.credsValid === false ? 'missing' : 'unknown',
        detail: 'viaSantralCreds',
      };
    }
    items.push(smsCreds);

    // NetGSM SMS v2 Task 12 — whether the account's NetGSM OTP package is
    // provisioned can only be observed by actually sending an OTP (there is
    // no read-only probe), and NetGSM OTP is a paid, single-recipient surface
    // — burning a real send just to populate a checklist row would be both
    // wasteful and user-facing (an unwanted text). So this row is always
    // 'unknown' with a detail explaining what NetGSM error 60 means; the
    // settings card surfaces the SAME netgsmErrorMessage('60') text live the
    // first time an actual OTP send hits it.
    items.push({ key: 'otpPackage', state: 'unknown', detail: 'otpPackageHint' });

    items.push({ key: 'telephonyConfig', state: cfg ? 'ok' : 'missing' });
    items.push({ key: 'santralCredsLive', state: smsCreds.state, detail: smsCreds.detail });

    // NetGSM Phase 4 Task 1/2 — call-recording storage. `recordCalls` is a
    // KVKK-relevant toggle (recording a call requires announcing it to the
    // caller), so the detail hint always names that requirement regardless
    // of state — an operator flipping the toggle on should see it right
    // away, not only once something is actually broken. 'ok' only once BOTH
    // the toggle is on AND R2StorageService has its env vars (the
    // recording-ingest sweep has somewhere to put the downloaded file);
    // 'missing' names the real gap (recording is on but nothing will be
    // stored); 'unknown' while the toggle itself is off — nothing to check.
    const recordCallsOn = cfg?.recordCalls === true;
    items.push({
      key: 'recordingStorage',
      state: !recordCallsOn ? 'unknown' : this.r2.isConfigured() ? 'ok' : 'missing',
      detail: 'recordingStorageKvkkHint',
    });

    // NetGSM Phase 4 Task 2/7 — like eventsWebhookReceiving, NetGSM/the
    // recording-ingest sweep never confirms back that a recording actually
    // landed, so the only live signal is: has ANY SalesCall in this
    // workspace actually gotten a recordingStorageKey stamped in the last 7
    // days. Degrades to 'unknown' (never 'missing') — silence could equally
    // mean "recording just turned on, no calls yet" or "no calls this week".
    const recentRecordingsCount = await this.prisma.salesCall.count({
      where: {
        workspaceId,
        recordingStorageKey: { not: null },
        endedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
    });
    items.push({
      key: 'recordingsReceiving',
      state: recentRecordingsCount > 0 ? 'ok' : 'unknown',
      detail: recentRecordingsCount > 0 ? undefined : 'recordingsReceivingHint',
    });

    // NetGSM SMS v2 Task 13 — whether the ACTIVE SMS channel's configured
    // msgheader (sealed onto the channel row, NOT the shared Netsantral creds
    // probed above) is actually İYS-approved on the account. Live-checked via
    // the same SmsV2Client.msgheaders() endpoint NetgsmSmsAdapter.healthCheck
    // already probes (see netgsm-sms.adapter.ts) — this row just surfaces the
    // same signal on the onboarding checklist instead of only after a manual
    // "Verify" click in channel settings.
    items.push(await this.checkSenderHeader(sms));

    const dahiliCount = await this.prisma.marketingUser.count({
      where: { workspaceId, dahili: { not: null } },
    });
    items.push({ key: 'repsWithDahili', state: dahiliCount > 0 ? 'ok' : 'missing', detail: String(dahiliCount) });

    items.push({
      key: 'eventsWebhookUrl',
      state: 'unknown',
      url: netgsmWebhookUrl(base, workspaceId, 'events') ?? undefined,
      detail: 'eventsWebhookHint',
    });

    // NetGSM Phase 3 Task 7 — NetGSM never confirms whether it actually
    // POSTs to eventsWebhookUrl above (no provisioning read-back), so this
    // is the only live signal that the URL was pasted into Netsantral's
    // panel correctly: has ANY events-purpose webhook actually landed for
    // this workspace in the last 7 days. Degrades to 'unknown' (never
    // 'missing') rather than a false negative — silence could equally mean
    // "not registered yet" or "registered, but nobody called this week".
    const recentEventsCount = await this.prisma.netgsmWebhookEvent.count({
      where: {
        workspaceId,
        purpose: 'events',
        receivedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
    });
    items.push({
      key: 'eventsWebhookReceiving',
      state: recentEventsCount > 0 ? 'ok' : 'unknown',
      detail: recentEventsCount > 0 ? undefined : 'eventsWebhookReceivingHint',
    });

    // NetGSM Phase 2 Task 4 — İYS push-back webhook. Unlike eventsWebhookUrl
    // (always 'unknown' — there's no live signal NetGSM actually pushes to
    // it), THIS row has a real signal: ChannelsService.registerIysWebhook
    // stamps `configPublic.iysWebhookRegistered` on the SMS channel only
    // after NetGSM confirms the registration succeeded, so 'ok'/'missing'
    // reflects reality rather than "we tried".
    items.push({
      key: 'iysWebhook',
      state: (sms?.configPublic as Record<string, unknown> | null)?.iysWebhookRegistered ? 'ok' : 'missing',
      url: netgsmWebhookUrl(base, workspaceId, 'iys') ?? undefined,
    });

    // NetGSM Phase 2 Task 6 — İYS is bundled free with the `campaigns`
    // feature (owner decision, no separate feature key/tripwire). This row
    // mirrors ChannelsService.registerIysWebhook's own brandCode requirement:
    // without a brandCode on the ACTIVE SMS channel's configPublic, neither
    // the auto-push queue (IysSyncService.resolveCreds) nor webhook
    // registration can proceed, so it's the first thing an operator fixes.
    const brandCodeRaw = (sms?.configPublic as Record<string, unknown> | null)?.brandCode;
    const hasBrandCode = typeof brandCodeRaw === 'string' && brandCodeRaw.trim().length > 0;
    items.push({ key: 'iysBrandCode', state: hasBrandCode ? 'ok' : 'missing' });

    // NetGSM Phase 2 Task 3 — whether the auto-push queue has ever actually
    // gotten a consent change confirmed by İYS. Unlike iysBrandCode/iysWebhook
    // (both pure configuration), the ABSENCE of a CONFIRMED/SENT job doesn't
    // prove anything is broken — it may just mean no consent change has
    // happened yet for this workspace — so this degrades to 'unknown' rather
    // than a false 'missing' (mirrors eventsWebhookUrl's always-'unknown').
    const firstSync = await this.prisma.iysSyncJob.findFirst({
      where: { workspaceId, status: { in: ['CONFIRMED', 'SENT'] } },
      select: { id: true },
    });
    items.push({ key: 'iysFirstSync', state: firstSync ? 'ok' : 'unknown' });

    // NetGSM Phase 5 Task 7 — Voice SMS + Otomatik Arama (autocall) are BOTH
    // separate paid add-ons on top of the base NetGSM account, and (like
    // otpPackage above) there is no read-only probe for either — only a real
    // voicesms/send or autocallservice call reveals whether they're active,
    // and NetGSM answers the same generic no-package error (code 60,
    // netgsm-error.map.ts) either way. So this row is always 'unknown' with a
    // detail naming both add-ons and error 60 — activating them is a portal
    // step (NetGSM sales/panel), not something this app can do or verify.
    items.push({ key: 'voicePackage', state: 'unknown', detail: 'voicePackageHint' });

    // NetGSM Phase 5 Task 3 — voice-campaign report webhook. Like
    // eventsWebhookUrl above, NetGSM never confirms back that it actually
    // POSTs to this URL (no provisioning read-back), so it's always
    // 'unknown' with the URL to paste into `voicesms/send`'s own `url` field
    // (campaign-sender.service.ts mints it automatically per VOICE send —
    // this row is a read-only reference/diagnostic, not a manual paste step).
    items.push({
      key: 'voiceReportWebhook',
      state: 'unknown',
      url: netgsmWebhookUrl(base, workspaceId, 'voice-report') ?? undefined,
      detail: 'voiceReportWebhookHint',
    });

    // NetGSM Phase 5 Task 7 — the autocall parallel dialer (autocall.client.ts)
    // REQUIRES a Netsantral queue with logged-in agents to have anywhere to
    // connect an answered call to (see autocall.client.ts's own doc comment);
    // that queue/agent-login state lives entirely in NetGSM's Netsantral
    // portal, so there is nothing to read back here either — always
    // 'unknown' with a detail pointing at the portal-only setup step.
    items.push({ key: 'autocallQueue', state: 'unknown', detail: 'autocallQueueHint' });

    // NetGSM Phase 6 Task 1 — fax (send/receive) reuses the workspace's
    // ACTIVE SMS channel creds (FaxSendService.resolveCreds, mirrors
    // voicePackage/otpPackage) — there's no separate "fax channel" row, and a
    // fax-enabled NetGSM number is a portal-only, paid prerequisite NetGSM
    // never reports back on. Always 'unknown' with a detail naming the
    // portal step; degrades the same way voicePackage/otpPackage do.
    items.push({ key: 'faxNumber', state: 'unknown', detail: 'faxNumberHint' });

    // NetGSM Phase 6 Task 3 — WhatsApp OTP is an alternate delivery
    // transport for the existing smsOtp flow (SmsOtpService.deliverCode),
    // gated on a paid OTP-WhatsApp package + Meta template approval that
    // NetGSM exposes no read-only probe for (same reasoning as otpPackage
    // above — sending a real WhatsApp OTP just to populate this row would be
    // an unwanted, user-facing send). Always 'unknown'; the detail explains
    // that OTP silently falls back to SMS until the package is active.
    items.push({ key: 'whatsappOtpPackage', state: 'unknown', detail: 'whatsappOtpPackageHint' });

    // NetGSM Phase 6 Task 4 — Netasistan is a SEPARATE auth realm (app-key +
    // user-key -> its own 1h bearer, sealed independently of the santral
    // creds on TelephonyConfig.netasistanConfigSealed) that TelephonyQueueService's
    // presence sync reads via resolveNetasistanForWorkspace. Unlike that
    // resolver (which unseals the actual keys), this row only needs to know
    // WHETHER both are saved — read via TelephonyConfigService.get()'s own
    // masked `netasistanConfigured` boolean (never unseal here). 'ok' once
    // both keys are configured; 'unknown' (never 'missing' — it's an
    // opt-in add-on, not a required step) otherwise, with a hint that
    // configuring it syncs agent break/queue presence.
    const telephonyMasked = await this.telephony.get(workspaceId);
    items.push({
      key: 'netasistanKeys',
      state: telephonyMasked?.netasistanConfigured ? 'ok' : 'unknown',
      detail: telephonyMasked?.netasistanConfigured ? undefined : 'netasistanKeysHint',
    });

    return { items };
  }

  /** `senderHeaders` row: resolves the ACTIVE SMS channel's own sealed creds +
   *  configured msgheader (never the shared Netsantral creds — this is the
   *  actual SMS-send credential path), fetches the account's İYS-approved
   *  header list live, and compares. No channel / no sealed creds / the
   *  header-list endpoint being unavailable all degrade to 'unknown' rather
   *  than a false 'missing' — mirrors probeBalance's "never hang or lie about
   *  an outage" rule. */
  private async checkSenderHeader(sms: ChannelRowLike | null): Promise<OnboardingItem> {
    if (!sms) {
      return { key: 'senderHeaders', state: 'unknown', detail: 'headersUnavailable' };
    }
    const { secrets } = this.registry.resolveConfig(sms);
    const { usercode, password, msgheader } = secrets;
    if (!usercode || !password || !msgheader) {
      return { key: 'senderHeaders', state: 'unknown', detail: 'headersUnavailable' };
    }
    const headersResult = await this.smsV2.msgheaders({ usercode, password });
    if (!headersResult.ok) {
      return { key: 'senderHeaders', state: 'unknown', detail: 'headersUnavailable' };
    }
    if (headersResult.headers.includes(msgheader)) {
      return { key: 'senderHeaders', state: 'ok', detail: String(headersResult.headers.length) };
    }
    return { key: 'senderHeaders', state: 'missing', detail: msgheader };
  }

  /** Bounds the /balance probe to BALANCE_PROBE_TIMEOUT_MS so a NetGSM outage
   *  degrades this item to 'unknown' instead of hanging the checklist request. */
  private async probeBalance(usercode: string, password: string): Promise<BalanceResult> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<BalanceResult>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT_RESULT), BALANCE_PROBE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.balance.fetchBalance({ usercode, password }), timeout]);
    } catch {
      return TIMEOUT_RESULT;
    } finally {
      clearTimeout(timer!);
    }
  }
}
