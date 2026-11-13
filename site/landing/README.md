# Jeeta public landing page

Static, Turkish-first introduction to the Rust product for visitors who are not signed in. The English page has the same story, capabilities, qualifications and calls to action. All runtime assets are local. There is no browser JavaScript, build step, dependency install, analytics, form submission or API request.

## Files and preview

- `index.html`: Turkish, served at `/`.
- `en/index.html`: English, served at `/en/`.
- `assets/landing.css`: shared layout, local font declarations, system light/dark theme and reduced-motion/forced-colors rules.
- `assets/jeeta-mark.png`, `assets/jeeta-welcome-560.webp`: the existing brand mark and one welcome mascot.
- `assets/ibm-plex-sans-latin.woff2`, `assets/ibm-plex-sans-latin-ext.woff2`, `assets/IBM-Plex-Sans-OFL.txt`: the panel's fonts and their license.
- `assets/inbox-detail.png`, `assets/inbox-mobile-detail.png`: pixel-preserving crops of the repository's real panel captures.
- `preview.mjs`: optional local HTTP preview using only Node's standard library. It is not loaded by the page or needed in production.

From the repository root:

```sh
node site/landing/preview.mjs
```

Open `http://127.0.0.1:4173/` and `http://127.0.0.1:4173/en/`. Stop with Ctrl+C. Change the operating system/browser color preference to see the other theme. The navigation is always visible, including on phones; it needs no menu script. Language links are ordinary links. There is no saved theme or language preference.

For nginx, serve the two entry documents and their local assets from this directory. Leave `/login`, `/register`, `/privacy`, `/terms` and `/data-deletion` to the existing application. Those links intentionally return 404 in the standalone preview. Preserve the panel's own asset routing when adding these static files; do not replace its entire `/assets/` route. Canonical and alternate-language metadata use the requested production domain but cause no third-party asset requests. No nginx or authentication routing was changed, and nothing was deployed.

## Section order

1. **Introduction and the morning conversation.** Explain the workspace in one paragraph, then show one customer's comment and an agent's prepared reply awaiting approval. The approval choices are explanatory text, not pretend working buttons.
2. **Publishing and follow-up later that day.** Continue the same workshop's day: an uploaded photo becomes a planned post, then a quote needs follow-up. A real inbox capture shows correspondence alongside a task. The scenario is illustrative, not a customer testimonial or a measured service outcome.
3. **Accounts, agents and Jeeta's responsibilities.** Explain who prepares content, who executes delivery, and exactly where human approval applies. Advertising is described here without implying platform availability.
4. **Welcome and registration.** Use the brand mascot once where the visitor is welcomed. State that activation follows registration and requires payment verification and a code.
5. **Legal navigation.** Link to the three required application routes.

## Claim provenance

The source of truth is the current Rust implementation. The README contains historical milestone descriptions, so the newer sections and executable paths take precedence. No live provider or customer workspace was consulted.

| Page claim or example | Repository evidence and boundary |
| --- | --- |
| A business connects its accounts and its own agents to a workspace | [Rust README: connecting an agent](../../rust/README.md#bir-ajanı-mcpye-bağlama), **Kabiliyetler** and **Bağlayıcılar**. Agent credentials carry workspace permissions. The page names only account categories, not a promised list of approved providers. |
| The connected agent prepares text, content and advertising plans; Jeeta does not supply a built-in generator | [Rust README](../../rust/README.md), **Üretim alanı ve içerik paketi**, especially lines 498–501 and 557–560: the agent does the work with its own tools; Jeeta calls no model or media service. **Reklam yönetimi** says the agent submits a plan and Jeeta validates and builds it. |
| A comment can have an agent draft held for human approval | [replies.rs](../../rust/crates/jt_app/src/usecases/inbox/replies.rs), `held = cap.policy.requires_human_approval && !matches!(ctx.actor, Actor::Human { .. })`, inside the public-item branch. [inbox_public_reply.rs](../../rust/crates/jt_app/tests/inbox_public_reply.rs), `agent_reply_is_held_when_capability_requires_approval` and `held_rows_are_never_claimed_or_recovered`. This is why the illustrated incoming message is a **comment**, not an ordinary email or DM. |
| The owner can approve, edit and approve, or discard that draft | [InboxPublic.tsx](../../rust/panel/src/pages/InboxPublic.tsx), `HeldCard`; [Rust README](../../rust/README.md), **Comments: the five `inbox.public` rows**. `approve` is human-only. Labels come from `inbox.public.held` in [tr.json](../../rust/panel/src/i18n/tr.json) and [en.json](../../rust/panel/src/i18n/en.json). The sample words about cups and delivery dates are written for this page and explicitly marked illustrative. |
| An uploaded photo can be used by the agent for content | [Rust README](../../rust/README.md), **Growth Studio materials library and olay-driven publishing**, **M3 Task 5 — tenant files and agent content**, and the current **Üretim alanı ve içerik paketi** section. Uploading a file does not itself generate or publish anything. The example presumes an active workspace, installed modules, an approved strategy and working connections. |
| The agent plans the account and time; Jeeta sends a scheduled post when conditions allow | [Rust README](../../rust/README.md), **Sosyal medya yönetimi**, `social.version_schedule`, **Sıradaki paylaşım ne bekliyor**, **Duraklatma**, and **Onay (S18, B35)**. [ApprovalSlot.tsx](../../rust/panel/src/pages/social/ApprovalSlot.tsx) and `socialAccounts.approvalHelp` in both locale files establish the connection-specific approval flow. The text expressly conditions delivery on the sending checks. |
| Tasks, notes and the stage of a customer relationship stay with the record | [Rust README](../../rust/README.md), **Gelen kutusu çekirdeği (M2a)**: `tasks_create`, `tasks_list`, `notes_add`, `events.report`, `context`. [InboxJourneyPanel.tsx](../../rust/panel/src/pages/InboxJourneyPanel.tsx). Creating a follow-up task is supported; the page does not claim a follow-up email is automatically sent. |
| Jeeta keeps the work record, checks rules and executes delivery | [Rust README](../../rust/README.md), **Gelen kutusu çekirdeği (M2a)** (`reply`, durable outbox and send fencing), **M3 Task 6 — fenced publication and recovery**, and current social/advertising sections. The page does not say Jeeta never contacts anyone. |
| Human approval is not universal | [replies.rs](../../rust/crates/jt_app/src/usecases/inbox/replies.rs), the public-item-only hold branch; [Rust README](../../rust/README.md), **Onay (S18, B35)** and migration `0038_lane_approval_to_connections`. A connection's approval setting is not a blanket promise for all email, DM or phone operations. |
| An agent's new advertising campaign proposal needs approval, but a human-opened campaign does not need a second proposal approval | [Rust README](../../rust/README.md), **Reklam yönetimi**, `ads.campaign_propose`, `ads.campaign_approve`, `ads.campaign_open`. No ad platform, spend result or campaign success is promised. |
| Registration creates a workspace; activation requires payment verification and a code | [Rust README](../../rust/README.md), **Kayıt**, **M4 Task 2**, **M4 Task 3**, **M4 Task 4**, and **M4 Task 7**. A new workspace starts in `pending_payment`; registration does not make it ready to send. No price, free tier or activation turnaround is asserted. |
| Product vocabulary | `modulePages`, `nav`, `home`, `publicIntro`, `socialAccounts`, and `inbox.public.held` in [tr.json](../../rust/panel/src/i18n/tr.json) / [en.json](../../rust/panel/src/i18n/en.json). Current module names replace the older screenshot's “Büyüme stüdyosu” terminology. |
| Captures use demonstration data, not customer records | [Panel design README](../../docs/design/jeeta-panel/README.md) explicitly identifies the disposable local workspace / synthetic fixtures and their limits. Crops also remove the synthetic person's name, email, workspace header and obsolete navigation. The English page identifies the unchanged screenshot as Turkish. |

## Corrections to the initial product summary

“Jeeta itself generates nothing” is accurate for content creation: the connected agent produces the content. “Jeeta contacts nobody without the owner's approval” is **not** a universal property of the current code. Comment replies and social posts can wait on a connection's `requires_human_approval` setting; social connections are not universally approval-enabled by default. Ordinary email/DM replies do not pass through the comment-specific hold branch. The README's **Phones for agents** section also explicitly says device actions have no approval gate.

The scenario therefore uses a comment reply and a social account with human approval explicitly enabled. The responsibilities section repeats the scope in plain language. Advertising proposals and registration/activation each have their own rules and are described separately. Content packages themselves do not wait for a person's approval; the page never claims they do.

## Visual and asset provenance

Direction comes from [the panel README](../../docs/design/jeeta-panel/README.md), [Unslop report](../../docs/design/jeeta-panel/unslop.md), [brand assets](../../docs/design/jeeta-panel/brand-assets.md), [LoginPage.tsx](../../rust/panel/src/pages/LoginPage.tsx), and [index.css](../../rust/panel/src/index.css). The Unslop report credits Damir Sokolovsky's CC BY 4.0 work; this page follows the repository's documented adaptation.

Graphite surfaces, navy ink, IBM Plex Sans at 400/500, fine rules and a single orange pending-reply marker carry that direction onto the public page. The orange text is darkened in light mode for contrast. The logo's and mascot's original brand colors are retained. The mascot is used only in the welcome section. No new illustration or logo was generated.

| Landing asset | Source and treatment |
| --- | --- |
| `jeeta-mark.png` | Exact copy of `rust/panel/public/brand/jeeta-mark.png`. |
| `jeeta-welcome-560.webp` | Exact copy of `rust/panel/public/brand/jeeta-welcome-560.webp`. |
| Both `.woff2` files | Exact copies from `rust/panel/public/fonts/`. SIL OFL copied from `docs/operations/licenses/IBM-Plex-Sans-OFL.txt`. |
| `inbox-detail.png` | `docs/design/jeeta-panel/inbox.png`: rectangle `x=512, y=379, width=896, height=620`. |
| `inbox-mobile-detail.png` | `docs/design/jeeta-panel/inbox-mobile.png`: rectangle `x=16, y=754, width=358, height=494`. |

Captures were cropped with native image tools, without resampling, recoloring, relabeling or generated pixels. The desktop crop shows the correspondence and follow-up task; the mobile crop prioritizes readable correspondence. The full desktop detail remains available through a normal enlargement link. These supplied captures are light-theme evidence and stay light within the dark page rather than being inverted to imitate another capture.

## Deliberately left out

The old [landing components](../../frontend/src/pages/landing/) and [Turkish marketing copy](../../frontend/src/i18n/locales/tr/marketing.json) were reviewed as historical context. Their structure and promises were not reused.

Omitted: built-in image generation, sales packages/checkout, forms/funnels, courses/memberships, drag-and-drop automations, an AI receptionist promise, affiliation/white-label features, free-start claims, prices, setup-time claims, compliance certification claims, social proof, customer logos, testimonials, growth results, statistics and provider availability promises. “Content package” in today's Rust internals is not the old purchasable package.

No named Instagram, Facebook, WhatsApp, ad or telephony integration is advertised as currently approved/connected in production. Implementation support is not evidence of production authorization. The page also does not claim every module comes installed in a new workspace. No fabricated dark or English panel capture was made. The illustrative draft is explicitly labeled and uses plain HTML so it can be read, selected and translated.

## Verification (2026-11-13)

Performed with the locally installed headless Chrome through its DevTools protocol, using the optional preview server. No new browser dependencies were installed.

- Opened and captured Turkish and English at **390px and 1440px**, each in **light and dark**: eight combinations. Reviewed the rendered layouts, including the real capture and welcome section.
- Browser JavaScript was disabled for those runs. Both languages, all content, anchors, images and theme styling remained available. Each page has one `h1`, one `main`, semantic navigation, a skip link and no script element.
- Checked additional widths **360, 600, 768, 1024 and 1920px** in both languages for horizontal overflow; none found. All required images decoded, and browser font inspection confirmed the embedded IBM Plex Sans, including Turkish text.
- Checked actual rendered text colors against their inherited solid backgrounds: lowest measured contrast **5.09:1 in light**, **6.51:1 in dark**, above 4.5:1. This measures the page's HTML text, not every pixel in the historical screenshot. The screenshot has descriptive alternative text and a full-size link.
- Keyboard Tab reached the visible skip link first, with an outline. Navigation and calls to action are native anchors with visible focus styling. No modal or hidden mobile menu needs focus management.
- The browser made no external asset requests. All referenced site resources loaded from localhost. Reduced motion was emulated; the page has no animations or transitions to suppress.
- Checked route/asset references and fragment targets. Application and legal destinations were checked as link targets, not exercised against a live backend.
- Only `site/landing/` was changed. No panel/backend build or test run was necessary for these isolated static files. No commit, push or deployment was performed.

Size: approximately **220 KB uncompressed** (219,808 bytes) for the Turkish document, stylesheet, both font subsets, logo and mascot, excluding captures (English is smaller). The desktop capture adds about **40 KB**, or the mobile crop about **13 KB**. Even a separate uncached favicon fetch of the logo leaves the page comfortably below the requested 600 KB budget. The OFL, preview helper and README are not fetched by the page.

Limits: no Safari/Firefox, real-device or screen-reader session; no live provider delivery, sign-in, registration, activation or nginx routing test. Chrome emitted unassociated `Other / ERR_CACHE_MISS` protocol events during capture/font inspection; no page URL was attached, and the separately observed page resources and image decodes succeeded. This is not a claim of a full accessibility audit. QA profiles and temporary screenshots are not part of the deliverable.

With more time: obtain current, anonymized Turkish/English and light/dark captures of the actual held-comment and scheduled-post screens, then replace the illustrative reply with that evidence; validate the deployed route split and keyboard/screen-reader experience in more browsers.


## How it is served on jeetagrowth.com

The panel owns `/assets/`, so the page cannot be dropped at the web root as it is. On the host the
files live in their own directory and nginx serves them under `/landing/`:

- `/` shows `index.html` to a visitor who has no panel session cookie (`jt_session`); a signed-in
  visitor gets the panel as before.
- `/en/` shows `en/index.html`.
- `/landing/assets/…` serves the assets. In the deployed copy the asset references are rewritten
  from `assets/…` and `../assets/…` to `/landing/assets/…`; nothing else differs from this
  directory. The source here keeps relative references so that the local preview works.

The page is static: publishing it restarts nothing and changes no panel route other than `/`
for visitors without a session.
