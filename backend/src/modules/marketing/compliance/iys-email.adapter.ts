import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { openSecret } from '../../../common/crypto/secret-box.helper';
import { isSingleAddress, normalizeAddress } from '../../../common/util/email-address';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { GATE_MATRIX, gateApplies } from '../channels/outbound/mail-class';
import { AccountRateBudgeter } from '../../netgsm/core/account-rate-budgeter';
import { IysClient, IysCreds } from '../../netgsm/iys/iys.client';
import {
  IYS_EPOSTA_BUDGET_BUCKET,
  IYS_EPOSTA_BUDGET_LIMIT,
  IYS_EPOSTA_BUDGET_WINDOW_MS,
  IYS_EPOSTA_MESSAGE_KEY,
  IysEmailCheck,
  IysEmailGap,
  IysEmailPort,
  IysEmailReadiness,
  IysEmailStatus,
  IysEmailVerdict,
} from './iys-email.port';

/**
 * How long an İYS `EPOSTA` answer may be believed.
 *
 * A live lookup per recipient is what the verifier ruled out (it drains the
 * account's İYS budget and starves the SMS preflight), so the answer is cached
 * on the lead. The number is a consent risk in one direction and a rate-limit
 * risk in the other: a day-old `ONAY` can mail someone who withdrew this
 * morning, and a five-minute TTL turns a 5 000-recipient campaign back into a
 * live lookup per recipient. A day is the balance — long enough that a campaign
 * tick re-running every few minutes spends nothing, short enough that a
 * withdrawal is honoured within one business day even with no webhook.
 */
export const IYS_EMAIL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** A cached value we are willing to act on. `UNKNOWN` is not an answer. */
const CACHEABLE: readonly IysEmailStatus[] = ['ONAY', 'RET', 'YOK'];

/** İYS's answers that mean "no permission to send commercial mail". */
const REFUSING: readonly IysEmailStatus[] = ['RET', 'YOK'];

/** Nothing to say, and nothing spent. A fresh object every time: a shared one
 *  would let any caller that edits its verdict change the next caller's. */
function silent(): IysEmailVerdict {
  return { status: 'UNKNOWN', refusal: null };
}

function inert(gap: IysEmailGap): IysEmailVerdict {
  return { status: 'UNKNOWN', refusal: null, gap };
}

/**
 * İYS `EPOSTA` — the adapter, inert until a workspace arms it.
 *
 * Reads its own contract in `iys-email.port.ts`. The four constraints it exists
 * to honour (PLAN §A3.5), each one a defect the verifier found in the naive
 * "just call İYS before every send" version:
 *
 * 1. **Its own budget bucket** (`${usercode}:iys:eposta`), never the shared
 *    `iys` one the SMS/voice preflights fail closed on.
 * 2. **Cached on the lead** (`leads.iysEmailStatus` / `iysEmailCheckedAt`), so
 *    a live lookup is spent only on a miss.
 * 3. **Workspace-level credentials** first, an ACTIVE SMS channel second — an
 *    email-only tenant has no NetGSM channel and must not be told to go and
 *    configure one.
 * 4. **Never globally fail-closed**: armed per workspace, default off, and an
 *    answer we could not get is `UNKNOWN`, which blocks nothing.
 */
@Injectable()
export class IysEmailAdapter implements IysEmailPort {
  private readonly logger = new Logger(IysEmailAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly budgeter: AccountRateBudgeter,
    private readonly client: IysClient,
  ) {}

  async check(input: IysEmailCheck): Promise<IysEmailVerdict> {
    // The matrix decides who is even asked (§A1). `iysEposta` is `'ticari'` on
    // BULK and `'never'` everywhere else, so an invoice or a password reset to
    // a RET address costs nothing and is never refused here.
    const gate = GATE_MATRIX[input.mailClass]?.iysEposta ?? 'never';
    if (!gateApplies(gate, { ticari: input.ticari })) return silent();

    // `undefined` means "the caller has not read it"; `null` means "read, and
    // there is nothing there" — the same distinction the gateway's own
    // workspace passthrough makes, and the reason a campaign tick costs no
    // extra workspace read per recipient.
    const settings =
      input.settings !== undefined ? input.settings : await this.workspaceSettings(input.workspaceId);
    if (!epostaArmed(settings)) return inert('NOT_ARMED');

    const address = normalizeAddress(input.address);
    if (!address || !isSingleAddress(address)) return inert('BAD_RECIPIENT');

    // The cache is read BEFORE the credentials are resolved, on purpose: an
    // answer İYS already gave us is a fact about the recipient's consent, not
    // about whether we can reach İYS this minute, and honouring it costs one
    // indexed read instead of a channel lookup per recipient.
    const cached = await this.cachedStatus(input.workspaceId, address);
    if (cached) return { status: cached, refusal: refusalFor(cached), cached: true };

    const resolved = await this.resolveCreds(input.workspaceId, settings);
    if (!resolved.creds) return inert(resolved.gap ?? 'NO_CREDENTIALS');

    if (
      !this.budgeter.tryTake(
        resolved.creds.usercode,
        IYS_EPOSTA_BUDGET_BUCKET,
        IYS_EPOSTA_BUDGET_LIMIT,
        IYS_EPOSTA_BUDGET_WINDOW_MS,
      )
    ) {
      // Armed and commercial: we may not send without an answer, but we must
      // not burn the recipient either. Deferring is what the SMS preflight does
      // with its own deferred bucket, and it is self-healing next tick.
      return { status: 'UNKNOWN', refusal: { reason: 'TRANSIENT', retriable: true }, gap: 'RATE_LIMITED' };
    }

    const result = await this.client.search(resolved.creds, address, 'EPOSTA');
    if (!result.ok || !result.status) {
      // A transport error and an `ok:true` we cannot classify are the same
      // thing: no answer. Neither is cached — a cached non-answer would keep
      // the mail deferred for a whole TTL after İYS came back.
      const verdict: IysEmailVerdict = {
        status: 'UNKNOWN',
        refusal: { reason: 'TRANSIENT', retriable: true },
        gap: 'UNREACHABLE',
      };
      if (result.message) verdict.refusal.error = result.message.slice(0, 300);
      return verdict;
    }

    await this.cacheStatus(input.workspaceId, address, result.status);
    return { status: result.status, refusal: refusalFor(result.status) };
  }

  async readiness(workspaceId: string): Promise<IysEmailReadiness> {
    const settings = await this.workspaceSettings(workspaceId);
    if (!epostaArmed(settings)) {
      return { armed: false, configured: false, gap: 'NOT_ARMED', messageKey: IYS_EPOSTA_MESSAGE_KEY.NOT_ARMED };
    }
    const resolved = await this.resolveCreds(workspaceId, settings);
    if (!resolved.creds) {
      const gap = resolved.gap ?? 'NO_CREDENTIALS';
      return { armed: true, configured: false, gap, messageKey: IYS_EPOSTA_MESSAGE_KEY[gap] };
    }
    return { armed: true, configured: true, gap: null, messageKey: null };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** A switch we cannot read is an off switch: never a reason to stop mail. */
  private async workspaceSettings(workspaceId: string): Promise<unknown> {
    if (!workspaceId) return null;
    try {
      const ws = await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { settings: true },
      });
      return ws?.settings ?? null;
    } catch (e: any) {
      this.logger.warn(`İYS EPOSTA: workspace read failed (workspace=${workspaceId}): ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * The freshest usable answer any lead on this address carries.
   *
   * Keyed on the ADDRESS, not on one lead row, for the same reason suppression
   * is: the same person is on file twice more often than anyone expects, and
   * one of the two rows having been checked this morning is a real answer about
   * that human being.
   */
  private async cachedStatus(workspaceId: string, address: string): Promise<IysEmailStatus | null> {
    try {
      const lead = await this.prisma.lead.findFirst({
        where: { workspaceId, emailNormalized: address, iysEmailStatus: { in: [...CACHEABLE] } },
        orderBy: { iysEmailCheckedAt: 'desc' },
        select: { iysEmailStatus: true, iysEmailCheckedAt: true },
      });
      if (!lead?.iysEmailStatus || !lead.iysEmailCheckedAt) return null;
      // The column is a free-form string: a value this adapter did not write
      // (an older `UNKNOWN`, a hand-edited row) is not an answer to act on.
      if (!CACHEABLE.includes(lead.iysEmailStatus as IysEmailStatus)) return null;
      if (Date.now() - lead.iysEmailCheckedAt.getTime() > IYS_EMAIL_CACHE_TTL_MS) return null;
      return lead.iysEmailStatus as IysEmailStatus;
    } catch (e: any) {
      // A cache we cannot read costs a lookup, not a send.
      this.logger.warn(`İYS EPOSTA: cache read failed (workspace=${workspaceId}): ${e?.message ?? e}`);
      return null;
    }
  }

  /** Project the answer onto every lead sharing the address — same unit as the read. */
  private async cacheStatus(workspaceId: string, address: string, status: IysEmailStatus): Promise<void> {
    try {
      await this.prisma.lead.updateMany({
        // `address` is a normalized, single address by here, so this can never
        // degrade into `emailNormalized: null` and stamp every address-less
        // lead in the workspace (the guard `esp-feedback.service.ts` learned).
        where: { workspaceId, emailNormalized: address },
        data: { iysEmailStatus: status, iysEmailCheckedAt: new Date() },
      });
    } catch (e: any) {
      // The answer was still valid — failing the send because we could not
      // write a cache row would be a worse bug than looking it up again.
      this.logger.warn(`İYS EPOSTA: cache write failed (workspace=${workspaceId}): ${e?.message ?? e}`);
    }
  }

  /**
   * Workspace-level İYS config first (`Workspace.settings.iys`), the ACTIVE SMS
   * channel second.
   *
   * The usercode/password PAIR always comes from ONE source. Mixing a
   * workspace-level usercode with a channel's password would produce an auth
   * failure that looks like an İYS outage and takes a day to explain. The
   * brandCode is not a secret and may come from either — a tenant who typed
   * their marka kodu into the settings card should not have to type it onto the
   * SMS channel as well.
   */
  private async resolveCreds(
    workspaceId: string,
    settings: unknown,
  ): Promise<{ creds?: IysCreds; gap?: IysEmailGap }> {
    const cfg = this.workspaceIys(settings);
    const pair = cfg.usercode && cfg.password ? { usercode: cfg.usercode, password: cfg.password } : null;
    if (pair && cfg.brandCode) {
      return { creds: { ...pair, brandCode: cfg.brandCode } };
    }

    const channel = await this.smsChannelCreds(workspaceId);
    const resolvedPair = pair ?? (channel.usercode && channel.password
      ? { usercode: channel.usercode, password: channel.password }
      : null);
    if (!resolvedPair) return { gap: 'NO_CREDENTIALS' };

    const brandCode = cfg.brandCode ?? channel.brandCode;
    if (!brandCode) return { gap: 'NO_BRAND_CODE' };
    return { creds: { ...resolvedPair, brandCode } };
  }

  /**
   * `settings.iys` — the email-only tenant's credential home.
   *
   * The password is accepted ONLY as `passwordSealed`, the same AES-256-GCM
   * envelope the channels use. `Workspace.settings` is a platform-PATCHable
   * jsonb blob that several read paths echo back, so a plaintext password there
   * is a credential leak waiting for a settings endpoint to widen: a plain
   * `password` key is deliberately ignored rather than quietly honoured.
   */
  private workspaceIys(settings: unknown): { usercode?: string; password?: string; brandCode?: string } {
    const iys = pick(settings, 'iys');
    if (!iys) return {};
    const usercode = str(iys.usercode);
    const brandCode = str(iys.brandCode);
    const sealed = str(iys.passwordSealed);
    let password: string | undefined;
    if (sealed) {
      try {
        password = openSecret(sealed) || undefined;
      } catch (e: any) {
        // A locked box (rotated/absent MARKETING_SECRET_KEY) reads as "no
        // credentials", which is inert — never as a thrown request.
        this.logger.warn(`İYS EPOSTA: workspace credentials could not be opened: ${e?.message ?? e}`);
      }
    }
    return { usercode, password, brandCode };
  }

  /**
   * The second rung, and the same one `IysSyncService.resolveCreds` walks —
   * workspace settings first, an ACTIVE SMS channel second, in that order in
   * both files. They have to agree: this side decides whether a tenant is told
   * "İYS is configured", and that side decides whether the consent rows that
   * tenant produces can actually be sent, so a ladder that differed by one
   * rung would report a workspace ready while its queue DLQ'd every row.
   *
   * A workspace can hold more than one ACTIVE SMS channel, and one of them
   * lacking a brandCode is not a reason to declare the whole workspace
   * unconfigured.
   */
  private async smsChannelCreds(
    workspaceId: string,
  ): Promise<{ usercode?: string; password?: string; brandCode?: string }> {
    let channels: any[] = [];
    try {
      channels = await this.prisma.channel.findMany({
        where: { workspaceId, type: 'SMS', status: 'ACTIVE' },
      });
    } catch (e: any) {
      this.logger.warn(`İYS EPOSTA: channel read failed (workspace=${workspaceId}): ${e?.message ?? e}`);
      return {};
    }
    let fallback: { usercode: string; password: string } | null = null;
    for (const ch of channels) {
      const cfg = this.registry.resolveConfig(ch);
      const usercode = str(cfg.secrets?.usercode);
      const password = str(cfg.secrets?.password);
      if (!usercode || !password) continue;
      const brandCode = str(cfg.public?.brandCode);
      if (brandCode) return { usercode, password, brandCode };
      fallback ??= { usercode, password };
    }
    return fallback ?? {};
  }
}

/** `settings.email.iys.eposta` — absent means off, which is today's behaviour (G3). */
function epostaArmed(settings: unknown): boolean {
  const iys = pick(pick(settings, 'email'), 'iys');
  return iys?.eposta === true;
}

/** One tolerant step into a jsonb blob nobody validates on the way in. */
function pick(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const next = (value as Record<string, unknown>)[key];
  return next && typeof next === 'object' ? (next as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** `RET`/`YOK` refuse; everything else lets the mail go. */
function refusalFor(status: IysEmailStatus): IysEmailVerdict['refusal'] {
  // `YOK` — İYS holds no record at all — is treated exactly like `RET`, the
  // same call the SMS preflight makes ("İYS: izin yok (RET/kayıt yok)"): under
  // 6563 the absence of a consent record is the absence of permission, not a
  // permission we have not looked up yet.
  return REFUSING.includes(status) ? { reason: 'IYS_RET', retriable: false } : null;
}
