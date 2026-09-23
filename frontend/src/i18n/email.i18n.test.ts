import { describe, expect, it } from 'vitest';
import en from './locales/en/marketing.json';
import tr from './locales/tr/marketing.json';

/**
 * The string layer the email surfaces stand on, in BOTH shipped catalogues.
 *
 * ## Why a required list and not a scan of the screens
 *
 * `usedKeys.test.ts` reads `t('…')` out of a glob of files, which is the right
 * gate for a screen that already exists. Most of the keys asserted here are
 * consumed by screens being written in parallel with this catalogue — the
 * pre-launch sheet, the mailbox health card, the suppression chips — and a
 * glob-driven test would be green today only because the call sites are not
 * written yet, then red for whoever writes them first. A required list is the
 * other direction: the catalogue promises the keys, and the screens are free to
 * arrive in any order.
 *
 * ## Why the machine codes are duplicated here
 *
 * `MailReason`, `SuppressionReason`, `IysEmailGap` and the campaign/recipient
 * status strings are backend contracts that reach the browser as bare codes.
 * The frontend cannot import them (separate tsconfig, separate build), so the
 * lists below are a copy — and copying them is the point: adding a reason on
 * the server without copy for it reds this file, which is cheaper than shipping
 * `SUPPRESSED_COMPLAINT` to a Turkish customer.
 *
 * `IYS_EPOSTA_MESSAGE_KEY` (backend `compliance/iys-email.port.ts`) names its
 * frontend keys literally; those are asserted verbatim.
 */

type Json = Record<string, unknown>;

/** `backend/src/modules/marketing/channels/outbound/outbound-mail.types.ts`. */
const MAIL_REASONS = [
  'SUPPRESSED_OPT_OUT',
  'SUPPRESSED_BOUNCE',
  'SUPPRESSED_INVALID',
  'SUPPRESSED_COMPLAINT',
  'SUPPRESSED_ERASED',
  'IYS_RET',
  'CONSENT_REQUIRED',
  'QUOTA_EXHAUSTED',
  'DAILY_CAP',
  'QUIET_HOURS',
  'WORKSPACE_INACTIVE',
  'SENDING_PAUSED',
  'NO_RECIPIENT',
  'BAD_RECIPIENT',
  'NO_UNSUBSCRIBE',
  'MISSING_PUBLIC_BASE_URL',
  'NOT_CONFIGURED',
  'TRANSIENT',
  'SYSTEMIC',
  'PERMANENT',
] as const;

/** Same file: `MailOutcome` and `MailTransport`. */
const MAIL_OUTCOMES = ['SENT', 'REFUSED', 'FAILED_PERMANENT', 'FAILED_TRANSIENT', 'DEDUPED'] as const;
const MAIL_TRANSPORTS = ['MAILBOX_SMTP', 'MAILBOX_OAUTH', 'PLATFORM', 'NONE'] as const;

/** `channels/outbound/mail-class.ts`. */
const MAIL_CLASSES = ['AUTH', 'INTERNAL', 'TRANSACTIONAL', 'CONVERSATIONAL', 'BULK'] as const;

/** `compliance/suppression.service.ts`. */
const SUPPRESSION_REASONS = ['ERASURE', 'HARD_BOUNCE', 'INVALID', 'COMPLAINT', 'OPT_OUT', 'MANUAL'] as const;

/** `leads/email-hygiene.service.ts` — `EmailVerifyStatus`. */
const VERIFY_STATUSES = ['UNKNOWN', 'VALID', 'INVALID', 'RISKY'] as const;

/** `prisma/schema.prisma` — `Campaign.status` / `CampaignRecipient.status`. */
const CAMPAIGN_STATUSES = ['DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'PAUSED', 'CANCELLED'] as const;
const RECIPIENT_STATUSES = ['PENDING', 'SENT', 'FAILED', 'SKIPPED', 'UNSUBSCRIBED'] as const;

/** `channels/inbound/inbound-policy.ts`. */
const INBOUND_POLICIES = ['ALL_SENDERS', 'REPLIES_AND_KNOWN'] as const;

/**
 * `mailbox-health.service.ts` writes these on the RECEIVE lane (`imap-target.ts`)
 * and on a dead consent token. The SEND lane carries a `MailReason`, which the
 * card renders through `mail.reason.*` — deliberately not copied a second time.
 */
const HEALTH_REASONS = ['OAUTH_REAUTH_REQUIRED', 'AUTH_FAILED', 'CONNECT_FAILED', 'UNKNOWN'] as const;

/** Verbatim from backend `IYS_EPOSTA_MESSAGE_KEY`. */
const IYS_MESSAGE_KEYS = [
  'compliance.iysEposta.notArmed',
  'compliance.iysEposta.noCredentials',
  'compliance.iysEposta.noBrandCode',
  'compliance.iysEposta.unavailable',
  'compliance.iysEposta.badRecipient',
] as const;

const REQUIRED: string[] = [
  // The gateway's receipt, rendered wherever a send is reported.
  ...MAIL_REASONS.map((r) => `mail.reason.${r}`),
  'mail.reason.UNKNOWN',
  ...MAIL_OUTCOMES.map((o) => `mail.outcome.${o}`),
  ...MAIL_TRANSPORTS.map((t) => `mail.transport.${t}`),
  ...MAIL_CLASSES.map((c) => `mail.class.${c}`),
  'mail.notSent',
  'mail.dailyCapReached',

  // Email templates (§C37 item 1).
  'email.title',
  'email.subtitle',
  'email.new',
  'email.edit',
  'email.hint',
  'email.name',
  'email.accent',
  'email.previewHint',
  'email.saved',
  'email.saveFailed',
  'email.deleteTitle',
  'email.deleteDesc',
  'email.deleteFailed',
  'email.emptyTitle',
  'email.emptyDesc',
  'email.headingText',
  'email.bodyText',
  'email.btnText',
  'email.alt',
  'email.column',
  'email.dividerHint',
  'email.emptyBlocks',
  'email.unknown',

  // Campaign composer + A/B dialog (§C37 item 2).
  'campaigns.abTitle',
  'campaigns.abHint',
  'campaigns.abEnable',
  'campaigns.abTestPct',
  'campaigns.abWinnerMode',
  'campaigns.abOpens',
  'campaigns.abClicks',
  'campaigns.abWinBy',
  'campaigns.abNeeds2',
  'campaigns.addVariant',
  'campaigns.weight',
  'campaigns.variantsSaved',
  'campaigns.variantsSaveFailed',
  'campaigns.abTest',
  'campaigns.aiCompose',
  'campaigns.bodyPlainFallback',
  'campaigns.bodyPlainFallbackHint',
  'campaigns.deleteTitle',
  'campaigns.deleteDesc',
  'campaigns.editTitle',
  'campaigns.emailTemplate',
  'campaigns.emptyTitle',
  'campaigns.formHint',
  'campaigns.htmlAttached',
  'campaigns.launchTitle',
  'campaigns.launchDesc',
  'campaigns.pause',
  'campaigns.resume',
  'campaigns.plainText',
  'campaigns.scheduleInPast',
  'campaigns.templateLoadFailed',
  'common.loadError',

  // Pre-launch sheet + readable results (§C38).
  ...CAMPAIGN_STATUSES.map((s) => `campaigns.status.${s}`),
  ...RECIPIENT_STATUSES.map((s) => `campaigns.recipientStatus.${s}`),
  'campaigns.prelaunch.title',
  'campaigns.prelaunch.desc',
  'campaigns.prelaunch.irreversible',
  'campaigns.prelaunch.audience',
  'campaigns.prelaunch.audienceLoading',
  'campaigns.prelaunch.audienceFailed',
  'campaigns.prelaunch.noRecipients',
  'campaigns.prelaunch.excluded',
  'campaigns.prelaunch.excludedOptedOut',
  'campaigns.prelaunch.excludedBounced',
  'campaigns.prelaunch.excludedInvalid',
  'campaigns.prelaunch.excludedSuppressed',
  'campaigns.prelaunch.excludedNoEmail',
  'campaigns.prelaunch.sender',
  'campaigns.prelaunch.senderPlatform',
  'campaigns.prelaunch.senderDegraded',
  'campaigns.prelaunch.testSend',
  'campaigns.prelaunch.testSendSent',
  'campaigns.prelaunch.testSendFailed',
  'campaigns.prelaunch.testSendHint',
  'campaigns.prelaunch.confirm',
  'campaigns.results.recipients',
  'campaigns.results.recipient',
  'campaigns.results.status',
  'campaigns.results.sentAt',
  'campaigns.results.opened',
  'campaigns.results.clicked',
  'campaigns.results.failureReason',
  'campaigns.results.empty',
  'campaigns.results.filterAll',
  'campaigns.results.noEmail',
  'campaigns.results.unnamed',
  'campaigns.results.total',
  'campaigns.results.loadMore',
  'campaigns.results.loadFailed',

  // Mailbox connect dialog (§C37 item 3) — TR was missing the IMAP overrides,
  // EN was missing the whole dialog.
  'accounts.email.title',
  'accounts.email.desc',
  'accounts.email.consentTitle',
  'accounts.email.consentDesc',
  'accounts.email.connectWith',
  'accounts.email.connected',
  'accounts.email.ownServer',
  'accounts.email.address',
  'accounts.email.addressHint',
  'accounts.email.passwordlessAvailable',
  'accounts.email.mailboxPassword',
  'accounts.email.recognised',
  'accounts.email.notRecognised',
  'accounts.email.smtpHost',
  'accounts.email.smtpPort',
  'accounts.email.smtpUser',
  'accounts.email.smtpUserHint',
  'accounts.email.smtpPass',
  'accounts.email.imapHost',
  'accounts.email.imapPort',
  'accounts.email.imapHint',
  'accounts.email.sending',
  'accounts.email.sendingHint',
  'accounts.email.sendingDone',
  'accounts.email.sendingSaved',
  'accounts.email.receiving',
  'accounts.email.receivingHint',
  'accounts.email.fromEmail',
  'accounts.email.inboundAddress',
  'accounts.email.webhookLabel',
  'accounts.email.inboundOff',
  'accounts.email.inboundOn',
  'accounts.email.inboundNoAddr',
  'accounts.email.testSmtp',
  'accounts.email.smtpOk',
  'accounts.email.smtpFailed',
  // §A5.1: what the tenant sees when there is no mailbox, or a dead one.
  'accounts.email.platformFallback',
  'accounts.email.reauthRequired',
  'accounts.email.reauthRequiredHint',
  'accounts.email.edit',
  'accounts.email.editSaved',
  'accounts.email.editFailed',
  'accounts.reauthRequired',

  // Sending domains (§C37 item 4) — the whole EN object was absent.
  'sendingDomains.title',
  'sendingDomains.subtitle',
  'sendingDomains.domain',
  'sendingDomains.fromName',
  'sendingDomains.add',
  'sendingDomains.added',
  'sendingDomains.addFailed',
  'sendingDomains.addRecords',
  'sendingDomains.copy',
  'sendingDomains.copied',
  'sendingDomains.empty',
  'sendingDomains.emptyHint',
  'sendingDomains.notYet',
  'sendingDomains.verify',
  'sendingDomains.verified',
  'sendingDomains.verifyFailed',
  'sendingDomains.deleteTitle',
  'sendingDomains.deleteDesc',
  'sendingDomains.deleteFailed',

  // Channels card (§C37 item 5, §A5.1, §A5.2).
  'channels.verified',
  'channels.verifyFailed',
  'channels.verifyFailCreds',
  'channels.verifyUnreachable',
  'channels.verifyHeaderNotApproved',
  'channels.verifySendOnly',
  'channels.notVerified',
  'channels.notVerifiedAction',
  'channels.delete',
  'channels.deleteTitle',
  'channels.deleteDesc',
  'channels.deleteFailed',
  'channels.emptyTitle',
  'channels.agentSaveFailed',
  'channels.connectInAccountCenter',
  'channels.moWebhookMissing',
  'channels.linkedinGranted',
  'channels.linkedinPending',
  'channels.iysDlqBacklog',
  'channels.iysDlqRetry',
  'channels.iysDlqRetried',
  'channels.iysDlqRetryFailed',
  'channels.reauthRequired',
  'channels.reconnect',
  'channels.health.title',
  'channels.health.line',
  'channels.health.sendOk',
  'channels.health.sendFail',
  'channels.health.receiveOk',
  'channels.health.receiveFail',
  'channels.health.lastOkAt',
  'channels.health.lastErrorAt',
  'channels.health.neverPolled',
  'channels.health.backoffUntil',
  ...HEALTH_REASONS.map((r) => `channels.health.reason.${r}`),
  'channels.inboundQuarantined',
  'channels.inboundRetry',
  'channels.inboundRetried',
  'channels.inboundRetryFailed',
  'channels.inboundUrl',
  'channels.inboundUrlHint',
  'channels.inboundPolicy.label',
  'channels.inboundPolicy.hint',
  ...INBOUND_POLICIES.map((p) => `channels.inboundPolicy.${p}`),
  ...INBOUND_POLICIES.map((p) => `channels.inboundPolicy.${p}_HINT`),

  // Opt-out visibility (§C39, §A5.1).
  'leads.suppression.title',
  'leads.suppression.optedOut',
  'leads.suppression.bounced',
  'leads.suppression.invalid',
  'leads.suppression.complained',
  'leads.suppression.erased',
  'leads.suppression.since',
  'leads.suppression.source',
  'leads.suppression.optOut',
  'leads.suppression.resubscribe',
  'leads.suppression.clearBounce',
  // An address marked INVALID that never bounced is not offered "clear the
  // bounce" — it is told what the lift really does to it.
  'leads.suppression.clearInvalid',
  'leads.suppression.clearInvalidHint',
  'leads.suppression.updated',
  'leads.suppression.updateFailed',
  'leads.suppression.none',
  'leads.suppression.history',
  'leads.suppression.historyEmpty',
  ...SUPPRESSION_REASONS.map((r) => `leads.suppression.reason.${r}`),
  ...VERIFY_STATUSES.map((s) => `leads.suppression.verifyStatus.${s}`),

  // İYS readiness — the keys the backend port names.
  ...IYS_MESSAGE_KEYS,
  'compliance.iysEposta.title',
  'compliance.iysEposta.configure',
  'compliance.iysEposta.ready',

  // Settings → E-posta sağlığı card (§A5, §A5.2).
  'settings.emailHealth.title',
  'settings.emailHealth.subtitle',
  'settings.emailHealth.sender',
  'settings.emailHealth.senderPlatform',
  'settings.emailHealth.senderMailbox',
  'settings.emailHealth.degraded',
  'settings.emailHealth.mailboxes',
  'settings.emailHealth.mailboxOk',
  'settings.emailHealth.mailboxDown',
  'settings.emailHealth.noMailbox',
  'settings.emailHealth.todaysSends',
  'settings.emailHealth.dailyCap',
  'settings.emailHealth.capReached',
  'settings.emailHealth.suppressed',
  'settings.emailHealth.bounceRate',
  'settings.emailHealth.complaintRate',
  'settings.emailHealth.failureRate',
  'settings.emailHealth.paused',
  'settings.emailHealth.pausedHint',
  'settings.emailHealth.inert',
  'settings.emailHealth.inertHint',
  'settings.emailHealth.inertNone',
  'settings.emailHealth.refresh',
  'settings.emailHealth.loadFailed',
  'settings.emailHealth.feature.SENDING_DOMAIN_ESP',
  'settings.emailHealth.feature.ESP_FEEDBACK_SECRET',
  'settings.emailHealth.feature.GOOGLE_MAIL',
  'settings.emailHealth.feature.MICROSOFT_MAIL',
  'settings.emailHealth.feature.EMAIL_INBOUND_SECRET',
  'settings.emailHealth.feature.EMAIL_DKIM',
  'settings.emailHealth.feature.MARKETING_SECRET_KEY',
  'settings.emailHealth.feature.LINK_BASE_URL',

  // The AI's own refusal, rendered in the thread.
  'inbox.aiDeclined',
];

/**
 * The namespaces this package fills end to end. Parity is asserted on the WHOLE
 * subtree, not only on the required list: a key added to one catalogue and
 * forgotten in the other is the exact failure mode this package exists to end
 * (an English `accounts.email` block served to a Turkish owner for a year).
 */
const PARITY_NAMESPACES = [
  'mail',
  'email',
  'campaigns',
  'channels',
  'accounts.email',
  'sendingDomains',
  'leads.suppression',
  'settings.emailHealth',
  'compliance',
  'inbox',
  'common',
];

function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Json | undefined)?.[k], obj);
}

/** The catalogue stores a few keys FLAT with dots in the name, and i18next
 *  resolves both shapes, so a nested miss is not yet a miss. */
function resolves(catalogue: Json, key: string): boolean {
  const nested = get(catalogue, key);
  if (typeof nested === 'string' && nested.length > 0) return true;
  const flat = catalogue[key];
  return typeof flat === 'string' && flat.length > 0;
}

function flatten(value: unknown, prefix: string): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return prefix ? [prefix] : [];
  return Object.entries(value as Json).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
}

describe('email i18n — every key the email surfaces need exists in tr and en', () => {
  it('the required list is not accidentally empty', () => {
    expect(REQUIRED.length).toBeGreaterThan(250);
    expect(new Set(REQUIRED).size).toBe(REQUIRED.length);
  });

  for (const [name, catalogue] of [
    ['tr', tr as Json],
    ['en', en as Json],
  ] as const) {
    it(`${name} defines every required email key`, () => {
      const missing = REQUIRED.filter((k) => !resolves(catalogue, k));
      expect({ locale: name, missing }).toEqual({ locale: name, missing: [] });
    });
  }

  for (const ns of PARITY_NAMESPACES) {
    it(`${ns} has the same key set in tr and en`, () => {
      const trKeys = flatten(get(tr, ns), ns);
      const enKeys = flatten(get(en, ns), ns);
      expect(trKeys.length).toBeGreaterThan(0);
      const trSet = new Set(trKeys);
      const enSet = new Set(enKeys);
      expect({ missingInEn: enKeys.length ? trKeys.filter((k) => !enSet.has(k)) : trKeys }).toEqual({
        missingInEn: [],
      });
      expect({ missingInTr: enKeys.filter((k) => !trSet.has(k)) }).toEqual({ missingInTr: [] });
    });
  }

  it('no required key is an empty string in either catalogue', () => {
    const blank = REQUIRED.filter((k) => {
      const v = (get(tr, k) ?? (tr as Json)[k]) as unknown;
      const w = (get(en, k) ?? (en as Json)[k]) as unknown;
      return v === '' || w === '';
    });
    expect(blank).toEqual([]);
  });

  it('tr is genuinely Turkish, not an English copy, on the reason codes', () => {
    // The cheapest guard against "mirrored EN into TR to make the test green".
    const same = MAIL_REASONS.map((r) => `mail.reason.${r}`).filter(
      (k) => get(tr, k) === get(en, k),
    );
    expect(same).toEqual([]);
  });
});
