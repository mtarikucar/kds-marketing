import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TelephonyConfigService } from '../telephony/telephony-config.service';
import { BalanceClient, BalanceResult } from '../../netgsm/balance/balance.client';
import { netgsmWebhookUrl } from '../../netgsm/webhooks/netgsm-webhook.util';
import { netgsmMoCallbackUrl } from '../channels/netgsm-callback.util';

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
  ) {}

  async checklist(workspaceId: string): Promise<{ items: OnboardingItem[] }> {
    const base = process.env.PUBLIC_BASE_URL;
    const items: OnboardingItem[] = [];

    const sms = await this.prisma.channel.findFirst({
      where: { workspaceId, type: 'SMS', status: 'ACTIVE' },
      select: { id: true },
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

    return { items };
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
