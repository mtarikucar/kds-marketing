/**
 * The reference dictionary. Every other locale is typed against these keys, so
 * a typo in a translation is a compile error rather than a raw `{{key}}` in a
 * customer's inbox, and `t()` falls back here when a locale has no line.
 *
 * Flat keys on purpose: the callers are a gateway, a cron and a public
 * controller, and a flat map is the one shape all three can index without
 * agreeing on a nesting convention.
 *
 * Values are PLAIN TEXT. The HTML footer wraps them in markup itself and
 * interpolates through `tHtml`, which escapes the variables — so a dictionary
 * that never carries markup cannot become an injection site.
 */
export const en = {
  // ── Bulk footer + the 6563 sender-identity block ──────────────────────────
  // Turkish law 6563 requires commercial mail to name the sender (trade name,
  // address, contact). It has no external dependency, so it ships with every
  // BULK send whether or not İYS is wired up.
  'footer.unsubscribe': 'Unsubscribe',
  'footer.unsubscribeText': 'Unsubscribe: {{url}}',
  'footer.whySending':
    'You are receiving this message because you are on the contact list of {{business}}.',
  'footer.sentTo': 'This message was sent to {{email}}.',
  'footer.commercialNotice': 'This is a commercial electronic message.',
  'footer.identity.heading': 'Sender',
  'footer.identity.tradeName': 'Trade name: {{value}}',
  'footer.identity.address': 'Address: {{value}}',
  'footer.identity.contact': 'Contact: {{value}}',

  // ── The unsubscribe pages ─────────────────────────────────────────────────
  // The GET is a confirm page and the POST is the act, because mail-security
  // scanners prefetch every link in an email.
  'unsubscribe.page.title': 'Unsubscribe',
  'unsubscribe.confirm.heading': 'Unsubscribe?',
  'unsubscribe.confirm.body': 'Click below to stop receiving these messages.',
  'unsubscribe.confirm.button': 'Unsubscribe',
  'unsubscribe.done.heading': 'You have been unsubscribed',
  'unsubscribe.done.body': 'You will no longer receive these messages.',
  'unsubscribe.expired.heading': 'Link expired',
  'unsubscribe.expired.body': 'This unsubscribe link is no longer valid.',

  // ── Booking lifecycle ─────────────────────────────────────────────────────
  'booking.received.subject': 'Booking received: {{calendar}}',
  'booking.received.body': 'Your booking request for {{when}} is pending approval.',
  'booking.confirmed.subject': 'Booking confirmed: {{calendar}}',
  'booking.confirmed.body': 'Your booking is confirmed for {{when}}.',
  'booking.cancelled.subject': 'Booking cancelled: {{calendar}}',
  'booking.cancelled.body': 'Your booking on {{when}} has been cancelled.',
  'booking.rescheduled.subject': 'Booking moved: {{calendar}}',
  'booking.rescheduled.body': 'Your booking has moved to {{when}}.',
  'booking.declined.subject': 'Booking request declined: {{calendar}}',
  'booking.declined.body': 'Your booking request for {{when}} was not approved.',
  'booking.reminder.subject': 'Reminder: your booking is soon',
  'booking.reminder.body': 'This is a reminder for your booking at {{when}}.',
  'booking.hostReminder.subject': 'Reminder: upcoming appointment with {{name}}',
  'booking.hostReminder.body': 'You have an appointment at {{when}}.',
  'booking.hostNew.subject': 'New booking: {{name}} — {{when}}',
  'booking.hostNew.body': '{{name}} booked {{calendar}} for {{when}}.',
  'booking.calendarLine': 'Calendar: {{calendar}}',
  'booking.joinLine': 'Join: {{url}}',
  'booking.manageLine': 'Manage or cancel your booking: {{url}}',
  'booking.fromBusiness': 'Sent by {{business}}.',

  // ── Quotes, invoices, receipts, e-sign ────────────────────────────────────
  'document.greeting': 'Hello {{name}},',
  'document.signoff': '{{business}}',
  'document.invoice.subject': 'Invoice {{number}} from {{business}}',
  'document.invoice.body': '{{business}} has sent you invoice {{number}}.',
  'document.invoice.amountLine': 'Amount due: {{amount}}',
  'document.invoice.dueLine': 'Due date: {{date}}',
  'document.invoice.payLine': 'View and pay: {{url}}',
  'document.quote.subject': 'Quote {{number}} from {{business}}',
  'document.quote.body': '{{business}} has prepared quote {{number}} for you.',
  'document.quote.totalLine': 'Total: {{amount}}',
  'document.quote.validUntilLine': 'Valid until: {{date}}',
  'document.quote.viewLine': 'View the quote: {{url}}',
  'document.receipt.subject': 'Receipt for invoice {{number}}',
  'document.receipt.body':
    'We received your payment of {{amount}} for invoice {{number}}. Thank you.',
  'document.esign.subject': 'Please sign: {{title}}',
  'document.esign.body': '{{business}} asks you to review and sign {{title}}.',
  'document.esign.signLine': 'Review and sign: {{url}}',
  'document.esign.signedSubject': 'Signed copy: {{title}}',
  'document.esign.signedBody': '{{title}} has been signed by all parties. A copy is attached.',

  // ── Team invite ───────────────────────────────────────────────────────────
  'invite.subject': '{{inviter}} invited you to {{workspace}}',
  'invite.body': '{{inviter}} invited you to join {{workspace}} on {{product}}.',
  'invite.ctaLine': 'Accept the invitation: {{url}}',
  'invite.expiryLine': 'This invitation expires on {{date}}.',

  // ── Daily digest (INTERNAL: our own users, never metered, never unsubbed
  //    through List-Unsubscribe — it has its own per-user opt-out) ───────────
  'digest.subject': '{{workspace}} — daily summary ({{date}})',
  'digest.heading': 'Here is what happened yesterday.',
  'digest.ctaLine': 'Open {{product}}: {{url}}',
  'digest.optOutLine': 'To stop receiving this daily summary: {{url}}',

  // ── Account and security mail (AUTH: platform identity only) ──────────────
  'auth.reset.subject': 'Reset your password',
  'auth.reset.body':
    'Use the link below to set a new password. It expires in {{minutes}} minutes and can be used once.',
  'auth.reset.ctaLine': 'Set a new password: {{url}}',
  'auth.reset.ignoreLine': 'If you did not ask for this, you can ignore this message.',
  'auth.verify.subject': 'Confirm your email address',
  'auth.verify.body':
    'Confirm this address to finish setting up your account. The link expires in {{minutes}} minutes.',
  'auth.verify.ctaLine': 'Confirm your address: {{url}}',

  // ── Why a send was refused or failed ──────────────────────────────────────
  // One line per `MailReason`. The gateway returns the machine code; this is
  // the only place it becomes words, so a refusal is never printed raw.
  'mail.reason.SUPPRESSED_OPT_OUT': 'The contact unsubscribed from marketing email.',
  'mail.reason.SUPPRESSED_BOUNCE': 'The address hard-bounced, so it is no longer mailed.',
  'mail.reason.SUPPRESSED_INVALID': 'The address is not deliverable.',
  'mail.reason.SUPPRESSED_COMPLAINT': 'The contact marked earlier mail as spam.',
  'mail.reason.SUPPRESSED_ERASED': 'The contact asked for their data to be erased.',
  'mail.reason.IYS_RET': 'IYS holds a rejection for this address.',
  'mail.reason.CONSENT_REQUIRED': 'Consent for marketing email has not been recorded.',
  'mail.reason.QUOTA_EXHAUSTED': 'The monthly message quota is used up.',
  'mail.reason.DAILY_CAP': "Today's sending limit for this workspace has been reached.",
  'mail.reason.QUIET_HOURS': 'It is outside the hours sending is allowed.',
  'mail.reason.WORKSPACE_INACTIVE': 'The workspace is not active.',
  'mail.reason.SENDING_PAUSED': 'Email sending is paused for this workspace.',
  'mail.reason.NO_RECIPIENT': 'There is no recipient address.',
  'mail.reason.BAD_RECIPIENT': 'The recipient is not a single valid address.',
  'mail.reason.NO_UNSUBSCRIBE':
    'Bulk email needs an unsubscribe link, and none could be built.',
  'mail.reason.MISSING_PUBLIC_BASE_URL':
    'PUBLIC_BASE_URL is not set, so the unsubscribe link cannot be built.',
  'mail.reason.NOT_CONFIGURED': 'No mailbox and no platform mailer is configured.',
  'mail.reason.TRANSIENT': 'The mail server refused it for now; it will be retried.',
  'mail.reason.SYSTEMIC': 'The mail server rejected the connection or the login.',
  'mail.reason.PERMANENT': 'The mail server rejected it permanently.',
};

/** Every key the mail copy defines. Translations are typed against this. */
export type MailCopyKey = keyof typeof en;
