# Inbox, people and calling audit

The review covers the Rust panel's `Inbox*`, `PeoplePage`, `CallsPage`, `CallsPolicy` and `CallDetail` surfaces. The earlier main-page refinement is extended here to the conditional forms, records, dialogs and request states that appear during work.

## Changes from the deeper review

- Consent history and contact restrictions now have separate headings. Records separate the channel, decision, source, effective time and synchronization state; restrictions place the reason beside the existing removal action. Empty history and restriction lists explain their state.
- Quote and appointment records separate amounts or locations from status and dates. Their expanded forms have explicit action headings. Empty lists have local guidance, and uncertain or refused delivery uses a warning treatment. These panels contain no decorative illustration.
- Commission statuses distinguish approval, payment and missing-payee conditions. Empty commission results refer to commissions and filters instead of saying that no conversations exist.
- Erasure, public-comment deletion and merge undo retain their exact typed phrases and API confirmation flags. The dialogs now offer an explicit cancel action, show the confirmation field within the warning context, clear an old mutation error when reopened, and prevent dismissal while a mutation is pending. The central dialog primitive restores focus to the entry control.
- Public-conversation approval reads now expose their loading and retry state. Item action failures occupy a full row. Merge-person lookup failures now expose a retry state rather than silently showing fallback names.
- Call-policy and call-outcome failures remain visible beside their form, in addition to the existing toast. Placing a call shows pending activity and disables cancellation until the request settles. The call log's horizontal scroll region can receive keyboard focus.
- Search misses in the inbox and People list offer a clear-search recovery action. An empty later People page retains a Previous action, so an exact 50-row final page cannot strand the user after Next. Empty task and note lists point to the forms below them.

No API modules, route contracts, role definitions or destructive confirmation phrases were changed. Existing form field labels and workflow actions remain available. The locale additions are limited to headings and state/recovery guidance.

## Repeatable browser review

The checked-in harness is [rust/panel/design-review/inbox.cjs](../../../../rust/panel/design-review/inbox.cjs). It uses the existing panel test fixtures plus invented review records, and intercepts every `/api/` request. Mutations in this review affect fixture data only.

From `rust/panel`, start a local Vite server, then run:

```sh
PANEL_URL=http://127.0.0.1:5180 node design-review/inbox.cjs
```

The default widths are 1440 × 1100 and 390 × 844, in English with reduced motion enabled. `REVIEW_CASE` accepts comma-separated case-name fragments, `REVIEW_WIDTHS` selects widths, `REVIEW_THEME=dark` selects dark mode, and `REVIEW_DIR` sets the output directory. Example:

```sh
PANEL_URL=http://127.0.0.1:5180 \
REVIEW_CASE=erase-guard,merges-and-guarded,public-moderation \
REVIEW_DIR=/tmp/inbox-confirmations \
node design-review/inbox.cjs
```

Each checkpoint records document horizontal overflow and dialog bounds/horizontal overflow, then saves a screenshot. The harness records browser runtime errors, any API request lacking a fixture, the named mutation requests that were observed, and case failures in `results.json`. Main-page captures reset document scroll before taking a full-page image; dialogs use viewport images. This avoids a stitched-image artifact in which an offscreen fixed skip link appeared midway down a long screenshot.

The named scenarios below are condition coverage, not a claim that every combination of channel, role, status, language and viewport has been tested. A passing request assertion confirms the synthetic endpoint was called; the existing component tests check the detailed request contracts. Overflow checks establish layout bounds, not automatic contrast or accessibility conformance.

## Interaction and state coverage

| Area | Conditions and actions exercised |
| --- | --- |
| Queues and person search | Populated queue, pagination, empty/populated approvals, no-match search and recovery, person without conversations, missing task link, read failure/loading/retry boundaries, denied inbox access. |
| Private conversation | Take over, hand back, close, send reply, snooze, unsnooze, mailbox subject, refused send and retry, empty messages, missing journey, lost/erased/merged composer fences. |
| Consent and restrictions | All four synchronization labels, explicit/withdrawn decisions, empty lists, representative view, selected-channel block, selected suppression removal, record failure then retry, commercial-message failure, consent-read recovery. |
| Erasure | Wrong/exact phrase gating, cancellation without an API call, cyclic Tab and reverse-Tab containment, focus return, conflict response, successful fixture erasure and navigation. |
| Quotes | Sent/accepted/expired record treatments, guarded acceptance, amount/currency/expiry/message form, unknown delivery, send error, empty active and terminal panels, read recovery. |
| Appointments | Booked/held/cancelled records, cancel and meeting-held actions, booking form, successful internal booking with refused notification, empty active and terminal panels. |
| Journey | Every event-form variant (`call_made`, `appointment_booked`, `meeting_held`, `quote_accepted`, `won`, `lost`, `snoozed`), task/note creation, populated timeline, open/done/cancelled task treatments, completion, former owner display, owner/note failures, lost reopening, won terminal state and read recovery. |
| Commissions | Pending/approved/no-payee/paid records, approve and mark-paid fixture transitions, rate failure, filtered-empty recovery guidance, representative restrictions and list-read recovery. |
| Merges | Suggested/applied records, keep-person selection, apply conflict, refusal, exact undo phrase, keyboard containment, cancellation/focus return, undo conflict, empty and denied states, merge and person-lookup read failures. |
| Public conversation | Every item answer/moderation treatment, post/product subjects, private reply availability and length bound, reply, hide/report/handled requests, exact deletion phrase/error/cancel, representative deletion restriction, held draft edit/error/discard and unedited approval, marketplace guidance, no owed items and pending-approval read failure. |
| Calls | All call states, human/agent mode rows, direction filter miss and show-all recovery, placing-purpose selection, known consent refusal, pending/successful placement, denied access, empty log and list-read recovery. |
| Call policy and detail | Grouped policy fields, changed greeting/timing and inline save failure, policy-read recovery, outcome selection/summary/error/success, empty flow after outcome, masked representative view, long summary, end cause, latency alert, script/line turns and detail-read recovery. |
| People | Populated and empty list, no-match search and recovery, first/last pagination controls, read failure/loading/retry. |

## Visual inspection

Screenshots were opened and inspected for the following representative states, in addition to the automated bounds checks:

- Mobile consent history/restrictions, including four synchronization treatments and both write forms.
- Mobile erasure conflict dialog and merge undo confirmation, including the visible confirmation field, safe cancellation and keyboard focus ring.
- Mobile quote records/form with unknown-delivery warning, and mobile call policy with a validation error beside Save.
- Desktop journey win form and commission list containing all four payment states.
- Dark mobile consent history/restrictions and dark desktop held-draft editing with its inline failure and outbound conversation bubbles.

The inspected states keep records readable, keep errors beside the relevant action, and keep the destructive confirmation and cancellation controls within the dialog. Nested queue/thread/journey regions intentionally scroll; the harness checks document and dialog horizontal bounds, not that a long region fits without vertical scrolling.

## Validation and evidence

The focused ten-suite run passed 68 tests with one worker after the state-layout changes. The later four-suite run passed 44 tests, including the new erasure cancellation/focus/stale-error regression, after the shared dialog fix. TypeScript checking passed. A focused regression for full People page → empty next page → Previous recovery was added after that run; its browser scenario passes at both widths. The root integration review owns the final full-panel suite.

Browser output directories for this session:

- `/tmp/jeeta-inbox-deep-final`: full light-theme pass at both widths.
- `/tmp/jeeta-inbox-deep-supplement`: updated keyboard-loop checks, corrected owner locator, terminal-won and merge-person error cases.
- `/tmp/jeeta-inbox-calls-pending-final`: call placement with a stable delayed fixture response.
- `/tmp/jeeta-inbox-last-branches`: final queue-badge, resolved-task, team/lost-reason failure and empty People-page recovery cases.
- `/tmp/jeeta-inbox-deep-dark`: selected expanded consent, quote, held-reply and policy-error cases in dark mode at both widths.

The first exploratory mobile pass is not the final evidence set. It exposed two harness issues: navigation before Vite's initial module load completed, and exact matching against a select's wrapping label. The full pass also exposed a fixture timing race when a successful call response closed the dialog before its pending-state assertion. The current harness uses a longer navigation timeout, scopes the owner select directly, and asserts pending controls before screenshotting a deliberately delayed response.



## Final recorded browser results

The accepted results contain **126 passing viewport/theme executions** and **272 screenshots**: 59 light-theme scenarios at both widths and four selected dark-theme scenarios at both widths. All accepted executions recorded zero browser runtime errors, zero API requests without fixtures, and no document/dialog horizontal overflow at their captured checkpoints. Corrected supplemental executions replace the earlier harness-only failures described above.

The merged session result file is `/tmp/jeeta-inbox-verified-results.json`. Screenshot files are in the evidence directories above, named `{width}-{case}-{checkpoint}.png`.

| Case | Captured checkpoints | Widths | Theme | Result |
| --- | --- | --- | --- | --- |
| `appointments-forms-and-actions` | appointment-states, booking-notification-refused | 390, 1440 | light | Passed |
| `approvals-populated` | approval-link | 390, 1440 | light | Passed |
| `call-detail-summary-latency-rep` | summary-latency-script-line | 390, 1440 | light | Passed |
| `call-outcome-and-errors` | outcome-error, outcome-recorded-empty-flow | 390, 1440 | light | Passed |
| `call-policy-error` | policy-save-error | 390, 1440 | dark | Passed |
| `call-policy-error` | policy-save-error | 390, 1440 | light | Passed |
| `calls-filter-and-place-refusal` | direction-empty, place-call-refusal | 390, 1440 | light | Passed |
| `calls-states-and-success` | all-call-states, call-placing | 390, 1440 | light | Passed |
| `commissions-rep` | read-only-payments | 390, 1440 | light | Passed |
| `commissions-transitions-and-rate` | all-payment-states, rate-error, filtered-empty | 390, 1440 | light | Passed |
| `consent-empty-read-only` | empty-consent-rep | 390, 1440 | light | Passed |
| `consent-history-and-errors` | records-and-restrictions, consent-error, commercial-send-error | 390, 1440 | dark | Passed |
| `consent-history-and-errors` | records-and-restrictions, consent-error, commercial-send-error | 390, 1440 | light | Passed |
| `empty-calls` | initial-empty | 390, 1440 | light | Passed |
| `empty-merges` | initial-empty | 390, 1440 | light | Passed |
| `empty-people` | initial-empty | 390, 1440 | light | Passed |
| `erase-guard-and-error` | confirmed-dialog, erasure-error | 390, 1440 | light | Passed |
| `journey-event-forms` | event-call_made, event-appointment_booked, event-meeting_held, event-quote_accepted, event-won, event-lost, event-snoozed | 390, 1440 | light | Passed |
| `journey-records-owner-and-errors` | timeline-and-tasks, owner-error, note-error | 390, 1440 | light | Passed |
| `journey-terminal-empty-offers` | terminal-empty-offers | 390, 1440 | light | Passed |
| `journey-won-and-empty-quote-forms` | won-terminal, open-empty-offer-forms | 390, 1440 | light | Passed |
| `merge-person-read-error` | merge-person-error | 390, 1440 | light | Passed |
| `merges-and-guarded-undo` | merge-states, merge-conflict, confirmed-dialog, undo-error | 390, 1440 | light | Passed |
| `people-empty-next-page` | empty-next-page | 390, 1440 | light | Passed |
| `people-pagination` | last-people-page | 390, 1440 | light | Passed |
| `people-search-and-recovery` | people-list, people-no-match | 390, 1440 | light | Passed |
| `permission-calls` | permission-guidance | 390, 1440 | light | Passed |
| `permission-commissions` | permission-guidance | 390, 1440 | light | Passed |
| `permission-inbox` | permission-guidance | 390, 1440 | light | Passed |
| `permission-merges` | permission-guidance | 390, 1440 | light | Passed |
| `public-held-approval-and-permission` | rep-held-expired-deadline, approval-read-error | 390, 1440 | light | Passed |
| `public-held-edit-and-errors` | held-edit-error | 390, 1440 | dark | Passed |
| `public-held-edit-and-errors` | held-edit-error | 390, 1440 | light | Passed |
| `public-marketplace-product-and-empty` | marketplace-product-guidance, no-owed-items | 390, 1440 | light | Passed |
| `public-moderation-and-delete` | confirmed-dialog, delete-error | 390, 1440 | light | Passed |
| `public-states-and-reply` | public-items, moderation-states, private-length-limit | 390, 1440 | light | Passed |
| `queues-search-approvals` | queues, approvals-empty, search-empty | 390, 1440 | light | Passed |
| `quotes-forms-and-delivery` | quote-states, quote-unknown-delivery, quote-send-error | 390, 1440 | dark | Passed |
| `quotes-forms-and-delivery` | quote-states, quote-unknown-delivery, quote-send-error | 390, 1440 | light | Passed |
| `read-boundary-approvals` | read-error, retry-loading, read-recovered | 390, 1440 | light | Passed |
| `read-boundary-call-detail` | read-error, retry-loading, read-recovered | 390, 1440 | light | Passed |
| `read-boundary-calls` | read-error, retry-loading, read-recovered | 390, 1440 | light | Passed |
| `read-boundary-commissions` | read-error, retry-loading, read-recovered | 390, 1440 | light | Passed |
| `read-boundary-consents` | read-error, retry-loading, read-recovered | 390, 1440 | light | Passed |
| `read-boundary-context` | read-error, retry-loading, read-recovered | 390, 1440 | light | Passed |
| `read-boundary-journey` | read-error, retry-loading, read-recovered | 390, 1440 | light | Passed |
| `read-boundary-merges` | read-error, retry-loading, read-recovered | 390, 1440 | light | Passed |
| `read-boundary-messages` | read-error, retry-loading, read-recovered | 390, 1440 | light | Passed |
| `read-boundary-people` | read-error, retry-loading, read-recovered | 390, 1440 | light | Passed |
| `read-boundary-person` | read-error, retry-loading, read-recovered | 390, 1440 | light | Passed |
| `read-boundary-policy` | read-error, retry-loading, read-recovered | 390, 1440 | light | Passed |
| `read-boundary-queue` | read-error, retry-loading, read-recovered | 390, 1440 | light | Passed |
| `read-boundary-quotes` | read-error, retry-loading, read-recovered | 390, 1440 | light | Passed |
| `read-boundary-tasks` | read-error, retry-loading, read-recovered | 390, 1440 | light | Passed |
| `read-boundary-thread` | read-error, retry-loading, read-recovered | 390, 1440 | light | Passed |
| `remaining-queue-and-task-branches` | surface-badges-and-deadlines, resolved-task-journey, team-read-error, lost-reasons-read-error | 390, 1440 | light | Passed |
| `task-person-and-pagination` | missing-task, person-no-conversation, queue-next-page | 390, 1440 | light | Passed |
| `thread-controls` | controls-after-success | 390, 1440 | light | Passed |
| `thread-fence-erased` | disabled-composer | 390, 1440 | light | Passed |
| `thread-fence-lost` | disabled-composer | 390, 1440 | light | Passed |
| `thread-fence-merged` | disabled-composer | 390, 1440 | light | Passed |
| `thread-mailbox-refusal` | reply-refused | 390, 1440 | light | Passed |
| `thread-snoozed-empty` | empty-thread-no-journey | 390, 1440 | light | Passed |
