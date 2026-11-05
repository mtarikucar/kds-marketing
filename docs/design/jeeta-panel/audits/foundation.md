# Foundation browser audit

Scope: the modern Rust panel's public login/register/invite flows, tenant home,
workspace shell, onboarding and unmatched-route fallback. The source inventory
and broader product boundaries are in [coverage.md](coverage.md).

## Repeatable review

From the repository root, with the Rust panel Vite development server running:

```sh
JEETA_REVIEW_URL=http://localhost:5180 \
JEETA_REVIEW_OUTPUT=/tmp/jeeta-foundation-review \
node rust/panel/design-review/foundation.cjs
```

The script loads invented TypeScript fixtures from `src/test/fixtures.ts` and
`src/test/billing.ts`. One Chromium browser runs contexts sequentially. Every
request whose URL pathname starts with `/api/` receives a scripted response;
source modules such as `/src/api/auth.ts` continue loading normally. External
origins are blocked, and Vite's websocket is suppressed so a contributor's HMR
update cannot reset a running scenario. No backend mutation or provider action
is sent. The script reads no real account or service credentials.

Each case runs at 390px and 1440px, with 1000px viewport height, Turkish/light
by default. Eight representative cases additionally run in English/dark at both
widths. Screenshots include intermediate pending/error/dialog states as well as
the final state. `results.json` records cases, actual API calls, captures,
unexpected requests, page errors and measured document overflow.

Optional filters and axe checks:

```sh
JEETA_REVIEW_URL=http://localhost:5180 \
JEETA_REVIEW_OUTPUT=/tmp/jeeta-foundation-axe \
JEETA_REVIEW_AXE=1 \
JEETA_REVIEW_AXE_CASE='^(login-default-invalid-password|login-server-error-retry-success|invite-new-default|home-approved-empty|home-strategy-missing-populated|home-failure-retry-workspace|onboarding-active|shell-no-workspace|not-found)(-english-dark)?$' \
node rust/panel/design-review/foundation.cjs
```

`JEETA_REVIEW_CASE` optionally limits the executed cases by regular expression.
With `JEETA_REVIEW_AXE=1`, axe-core runs the `wcag2a`, `wcag2aa` and `wcag21aa`
rules, including browser-computed color contrast. `JEETA_REVIEW_AXE_CASE` limits
axe to named cases while retaining the complete functional matrix. Each axe
result records violations with DOM targets and failure details, incomplete
checks requiring manual review, and the number of passing rules. This is not a
claim of full WCAG conformance.

## Scenario inventory

| Area | Executed scenario families |
| --- | --- |
| Login | Initial form; required/email native invalidity without mutation; password show/hide and pressed/type state; held pending submission; 401 and 500 error; resubmission and successful return to home. |
| Registration | Required/email/minimum password invalidity without mutation; password toggle; held pending; 401, 409 conflict and 500 errors; resubmission and successful home navigation. |
| New-account invitation | Visitor session, required/minimum password invalidity, password toggle, pending acceptance; 401/conflict/forbidden/expired-token/inactive-workspace/not-found/server-error responses; sign-in recovery link on conflict; successful accepted state and home link after retry. |
| Signed-in invitation | Signed-in identity and accept action; held pending; 401/already-member/forbidden/expired-token/inactive-workspace/not-found/server-error responses; successful acceptance after retry, including mocked workspace switch. |
| Invite session | Delayed session read, failed session read, retry and recovered signed-in acceptance. |
| Home strategy/work | Missing strategy with populated queue; draft and gaps; submitted draft and approval dialog; approved strategy with empty work; recent, overdue and never-connected agent; restricted representative and suspended workspace. |
| Home interaction | Approval assumptions dialog open/Escape/focus return; agent interval edit, invalid value, disabled save, save error, retry success, persisted value and cancel. |
| Home queries | Delayed workspace and work reads; failed workspace/work reads, visible retry and recovery. |
| Workspace shell | Delayed/failed session and retry; no memberships; memberships without current workspace; choose/switch success; failed switch. |
| Onboarding | Pending payment, active, suspended and restricted fixtures; delayed workspace/billing; workspace failure and retry. |
| Fallback | Standalone unmatched-route page and home recovery link. |
| English/dark representatives | Login native-invalid/toggle, login error/retry, visitor invite, approved empty home, missing strategy/populated home, active onboarding, no workspace and fallback. |

Every successful case also checks visible images, page errors, unexpected API
requests and document width. The focused skip link must be visible and activate
the `main` focus target. The browser emulates reduced motion and the script
checks the rendered transition duration, not only the media-query flag.

## Findings and interpretation

The first pass found a real focus-return defect: dismissing the controlled Home
approval dialog with Escape left its opener unfocused at both widths. The shared
Dialog/Sheet implementation was subsequently updated by the root owner to retain
and restore the opener, while respecting explicit close-focus handling. The
repeat run retains this assertion so the result is reviewable.

Axe also requested manual review of an accessible label on the generic Home
count span. The root owner replaced it with an aria-hidden visible numeral and
a translated screen-reader count. The selected Home replay no longer produces
that incomplete check.

Initial fixture-run failures caused by Vite HMR remounts and by overly exact
loading-button/status-role selectors were harness issues. The harness now blocks
the HMR websocket and checks the implemented loading/status semantics. They are
not counted as product defects.

The synthetic workspace fixture exercises representative permission and billing
states. It does not prove real session-cookie issuance, invite delivery or expiry,
operator activation, provider connectivity, external agent scheduling, production
recovery or staging/yeni release behavior. Those remain operational checks.

## Execution record

Executed on 2026-11-05 against local Vite on port 5180:

- Primary matrix: **118/118 passed**. Focused replay: **36/36 passed**. The replay
  replaced overlapping cases after the shared fixes and added eight distinct
  invite cases, producing **126/126 distinct viewport/state cases**.
- **82 axe snapshots, zero reported WCAG violations.** Numeric browser contrast
  evidence in the replay contains 1,290 light-theme text comparisons, minimum
  **5.08:1**, and 361 dark-theme comparisons, minimum **6.09:1**. These counts
  include repeated nodes across states and widths, not unique UI elements.
- No document horizontal overflow, broken visible images, page errors or
  unexpected API requests in the final selected records.
- Password show/hide, native invalidity without API mutation, pending controls,
  error/resubmission, workspace switching, skip-link visibility/main focus and
  reduced-motion CSS checks passed. The approval dialog also passed six forward
  Tabs, Shift+Tab containment, Escape and focus return at both widths.

Two automated manual-review categories remain for the **open approval modal** at
both widths: `aria-hidden-focus` for Radix's focus guards/background, and a
`color-contrast` determination blocked by overlapping layers on its description.
The keyboard test confirms focus stays inside the modal; viewport screenshots
show the description unobscured. Its declared light-theme colors
`#606772` on `#ffffff` calculate to **5.71:1**. This color calculation supplements
the automated incomplete result; it does not turn that axe result into a pass.
No axe rule was disabled or suppressed.

Visually inspected selected screenshots: mobile login error, mobile visitor
invite, populated Home desktop in light/Turkish and dark/English, mobile approval
modal, mobile interval save error, active onboarding mobile, and dark/English
login with the browser's native invalid-email message. The modal and save-error
viewport captures were inspected separately from long-page captures: fixed
elements can appear misleadingly positioned in a stitched full-page image.
This does not claim a human inspection of every generated screenshot.

Machine-readable evidence: `/tmp/jeeta-foundation-final/results.json` (primary),
`/tmp/jeeta-foundation-replay/results.json` (replay), and
`/tmp/jeeta-foundation-final/combined-results.json` with
`/tmp/jeeta-foundation-final/summary.json` (deduplicated final evidence). Each
combined record identifies the directory holding its screenshots. These are local
review artifacts with synthetic values only; the checked-in harness regenerates
them without credentials or real backend mutations.
