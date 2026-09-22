import { MailClass } from '../channels/outbound/mail-class';

/**
 * The İYS `EPOSTA` seam — Turkish commercial email consent, as a port.
 *
 * Law 6563 and İYS (İleti Yönetim Sistemi) govern commercial electronic
 * messages sent to recipients in Turkey. SMS and voice have been checked
 * against İYS for a while; email never was, so `campaigns.service.ts` simply
 * coerces every EMAIL campaign to `BİLGİLENDİRME` (`tr-commercial-compliance`).
 *
 * This is a port rather than a service call for one reason: it has to be able
 * to be **absent**. Most workspaces will never have İYS `EPOSTA` credentials,
 * a non-Turkish tenant is not bound by the rule at all, and a gate that fails
 * closed for everyone the day it ships would stop commercial email for every
 * tenant on the platform. So the contract is:
 *
 * - Nothing is armed until a workspace sets `settings.email.iys.eposta = true`.
 * - Unarmed, unconfigured or unreachable answers `UNKNOWN`, and `UNKNOWN`
 *   never blocks a mail — it names what is missing so a surface can say so
 *   (PLAN §A3.5, G6: inert, never silently broken).
 * - Only a real `RET`/`YOK` from İYS refuses, and only for the class the gate
 *   matrix marks `ticari` (BULK). An invoice is not a commercial message.
 *
 * The 6563 sender-identity footer is deliberately NOT part of this port: it has
 * no external dependency, so the gateway emits it on every BULK send whether or
 * not İYS is wired up (`outbound-mail.service.ts`, `identityLines`).
 */

/** İYS's own answer, plus the one we give when we have not got one. */
export type IysEmailStatus = 'ONAY' | 'RET' | 'YOK' | 'UNKNOWN';

/**
 * Why there is no İYS answer. Every value is a machine code — a surface
 * renders it through `IYS_EPOSTA_MESSAGE_KEY`, and nothing prints it raw (G8).
 */
export type IysEmailGap =
  /** `settings.email.iys.eposta` is not `true`. The default, and today's behaviour. */
  | 'NOT_ARMED'
  /** Armed, but no İYS usercode/password pair resolves for this workspace. */
  | 'NO_CREDENTIALS'
  /** Armed with credentials, but no İYS marka kodu to build the auth header from. */
  | 'NO_BRAND_CODE'
  /** İYS could not be reached, or answered something unclassifiable. */
  | 'UNREACHABLE'
  /** This account's EPOSTA lookup budget is spent for the minute. */
  | 'RATE_LIMITED'
  /** Not an address İYS could hold a record against. */
  | 'BAD_RECIPIENT';

/**
 * What the gate does with the answer.
 *
 * `IYS_RET` is terminal: consent was refused, and retrying tomorrow will not
 * change that. `TRANSIENT` is the opposite — we never learned the answer, so
 * the mail is deferred rather than burned. Nothing here throws, and nothing
 * here is a failure (PLAN G2).
 */
export interface IysEmailRefusal {
  reason: 'IYS_RET' | 'TRANSIENT';
  retriable: boolean;
  /** İYS's own words, for an operator. Never shown to a recipient. */
  error?: string;
}

export interface IysEmailCheck {
  workspaceId: string;
  /** The address the mail is actually going to. */
  address: string;
  mailClass: MailClass;
  /** Commercial (TİCARİ) rather than BİLGİLENDİRME. */
  ticari?: boolean;
  /**
   * `Workspace.settings`, when the caller has already read it — the gateway
   * reads the row for its kill switches, and a bulk tick asking again once per
   * recipient would be a query per send. Absent (`undefined`) means "not read";
   * `null` is a real answer and is honoured as one.
   */
  settings?: unknown;
}

export interface IysEmailVerdict {
  status: IysEmailStatus;
  /** `null` means the gate says nothing — which is the answer in most tenants. */
  refusal: IysEmailRefusal | null;
  /** Set whenever `status` is `UNKNOWN`: what would have to change. */
  gap?: IysEmailGap;
  /** The answer came from the lead cache; no İYS lookup was spent. */
  cached?: boolean;
}

/** What a settings card or the campaign composer needs to render. */
export interface IysEmailReadiness {
  /** `settings.email.iys.eposta === true`. */
  armed: boolean;
  /** Armed AND a full credential set resolves. */
  configured: boolean;
  /** `null` once ready. */
  gap: IysEmailGap | null;
  /** The i18n key for `gap`, or `null` once ready. */
  messageKey: string | null;
}

export interface IysEmailPort {
  /** Never throws. Answers `UNKNOWN`/no refusal whenever it cannot know. */
  check(input: IysEmailCheck): Promise<IysEmailVerdict>;
  /** Cheap enough for a settings card: reads config, asks İYS nothing. */
  readiness(workspaceId: string): Promise<IysEmailReadiness>;
}

export const IYS_EMAIL_PORT = Symbol('IYS_EMAIL_PORT');

/**
 * EPOSTA gets its OWN `AccountRateBudgeter` bucket, so the composed key is
 * `${usercode}:iys:eposta`.
 *
 * This is the whole reason the adapter exists in the shape it does. The shared
 * `(usercode, 'iys')` bucket is 10 calls / 60 s and the SMS and voice TİCARİ
 * preflights spend from it (`campaign-sender.service.ts`,
 * `telephony-callback.service.ts`, `autocall-dialer.service.ts`), failing
 * CLOSED when it is empty. A 50-recipient email tick doing per-recipient
 * lookups would drain that bucket and visibly stall a concurrent TİCARİ SMS
 * campaign that has nothing to do with email.
 */
export const IYS_EPOSTA_BUDGET_BUCKET = 'iys:eposta';

/** İYS's documented per-account rate limit, applied per bucket. */
export const IYS_EPOSTA_BUDGET_LIMIT = 10;
export const IYS_EPOSTA_BUDGET_WINDOW_MS = 60_000;

/**
 * The frontend i18n keys a surface renders for each gap (namespace
 * `marketing.json`). They are listed here, next to the codes, so the UI and the
 * gate can never disagree about how many ways this can be un-ready.
 */
export const IYS_EPOSTA_MESSAGE_KEY: Record<IysEmailGap, string> = {
  NOT_ARMED: 'compliance.iysEposta.notArmed',
  NO_CREDENTIALS: 'compliance.iysEposta.noCredentials',
  NO_BRAND_CODE: 'compliance.iysEposta.noBrandCode',
  UNREACHABLE: 'compliance.iysEposta.unavailable',
  RATE_LIMITED: 'compliance.iysEposta.unavailable',
  BAD_RECIPIENT: 'compliance.iysEposta.badRecipient',
};
