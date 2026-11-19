# Paylaşımlar and Bilgi bankası — design

Date: 2026-11-19. Status: design complete, every open point decided by the lead (§9), revised after
three adversarial reviews (data, agents, owner; Appendix A); nothing waits for the owner. Base:
`origin/design/jeeta-refinement` at `803cab98`, schema 45. Evidence: the eight-reader code map of
that commit (`jeeta-design/map.json`, cited below as **A0–A6** for its areas and **A*n*.*m***
for touchpoint *m* of area *n*), the approved mockups F (`MerkezTablo.dc.html`, Paylaşımlar) and H
(`BilgiBankasi.dc.html`, Bilgi bankası), and the live strategy of the owner's workspace
(`strategy-v5.json`, version 5, approved 2026-11-19). Builds on: the flow dead-ends note
(`2026-11-19-akis-tikanmalari-design.md`, "design 2026-11-19", rules **R1–R3**, decisions **F1–F6**),
the olay root (`2026-11-18-icerik-olay-koku-design.md`, **O1–O17**), the content module
(`2026-11-10-uc-modul-ve-panel-iskeleti-design.md`), the materials library
(`2026-11-03-studio-materials-design.md`) and the agent wake (PR #417, `usecases/wake.rs`).

Lead decisions **K1–K7** and **P1–P4** (given with the task) are adopted; where this note departs from
one it says so in §9 with the evidence.

## 0. In one page

- **Paylaşımlar** (`/posts`) replaces `/content` and `/social`: one composer ("Ne paylaşalım?", free
  text and files, no platform picker), chips (Tümü, Seni bekleyen, then only the stages that hold
  rows), one table whose row is one post, and a right panel without tabs or step list. Everything
  else those pages offered moves behind three header buttons: **Dosyalar**, **Hesaplar**, **Ayarlar**.
  The server gets one read built for it (`content.posts`, `content.post_get`) and one composer write
  (`content.post_request`), plus four small writes for what had no endpoint (`content.files_add`,
  `content.special_day_skip`, `content.version_cancel`, `content.post_dismiss`).
- **Bilgi bankası** (`/knowledge`) replaces `/strategy`: free cards, a short **Kurallar** box,
  **Hedefler**, a note composer ("Ajanlara bir şey anlat"), the agents' proposals, and a read-only
  "Neler işe yarıyor". The owner's edits apply at once; there is no draft, submit or approval.
- **The frame** stays: `strategy_versions` and `strategy_hypotheses` remain the internal, append-only
  execution frame every Studio, research and outreach row points at (K1). The owner never sees it.
  It is applied **by the system** from what agents derive from the cards (`jeeta.strategy.frame_apply`),
  from the owner's Kurallar (the ad budget and paid-message caps) and, for a brand-new workspace, from
  the first card text the owner writes (bootstrap). Only structural changes make a version; reworded
  text never does. The gate predicate is unchanged: "an approved frame exists" (K3).
- **Kurallar are the knowledge base's own numbers**: the ad cap, the paid-message limit and post
  approval (a workspace switch plus a per-account list) live in `knowledge_settings`; agents can lower
  spend but never raise a cap, and nothing an account's stored flag says lowers post approval.
- Every connected account is used: frames carry `channels = [any]` and topics (hypotheses) on `any`
  (K6). Standing research tasks survive a frame change when their ICP entry is unchanged (K5).

## 1. Goals, non-goals and the owner's words

### 1.1 What the owner said

Paylaşımlar:

- "İçerik ve Sosyal tek sayfa olsun: Paylaşımlar." A table: görsel, paylaşım metninin ilk satırı,
  kanal, 8 adımlık küçük ilerleme, durum, yayın zamanı.
- Chips: "Tümü", "Seni bekleyen", then only the stages that currently hold something.
- A row opens a right panel **without tabs and without the process/step list** (the owner removed
  them): görsel, başlık, kanal ve zaman, durum, eylemler (Onayla / TikTok'ta tamamla / Düzenleme iste /
  İptal), the post text, details (Kanal, Tarih, Biçim, Kategori), and a note when the image is an AI
  illustration.
- One composer, "Ne paylaşalım?": free text and optional files, **no platform picker** ("platform
  sayısı çok artabilir; platformu ajan seçsin; istersem metne 'sadece TikTok' yazarım").
- Special days with no photo: one line each, "Fotoğraf ekle / Bu yıl geç".
- Hates: several tabs, big forms, lots of text, internal concepts (olay, paket, sürüm, durak), waiting
  on a clock for work just asked for, dead ends found late.

Bilgi bankası:

- The strategy becomes "Bilgi bankası": free cards agents read; the owner adds any card. Seeds: Biz
  kimiz, Ürünler ve fiyat, Ses tonu, Müşterilerimiz, Paylaşım fikirleri, Kimi arıyoruz, Hesaplar ve
  kanallar, Referanslar.
- A short **Kurallar** box agents never cross: yasaklar, reklam bütçesi sınırı, "her paylaşım onayıma
  gelsin".
- **Hedefler**.
- A composer "Ajanlara bir şey anlat" (text, file or link) that an agent files into the right card.
- "Ajanın önerileri": the owner adds or skips.
- "Değişikliklerim hemen geçerli olsun; taslak/gönder/onayla yok. Platformlar stratejinin parçası değil:
  bağlı her hesap kullanılır. Hipotez, ICP yapısı, sıklık, sürüm görmem." Learned results may stay as
  a read-only section.
- "Sen yap ne gerekiyorsa, araştır, tüm durumları; olması gereken neyse onu yap."

### 1.2 Goals

| # | Goal | Measured by |
|---|---|---|
| G1 | The owner works posts on one page with one table and one panel. | `/content` and `/social` redirect to `/posts`; no capability of theirs is lost (§2.12). |
| G2 | The owner asks for a post in one line and never names a platform. | `content.post_request` takes text and files only; the agent chooses accounts; a person's request posts on any connected account (§3.5). |
| G3 | What stands in the way is said when the owner asks (R1), and work goes on by itself when it clears (R2). | Composer stops (§2.8), row waits each with one action (§2.6), every wait derived from facts. |
| G4 | The owner keeps knowledge, rules and goals as plain text that applies at once. | Card, rules and goal writes take effect in the same transaction for every agent read (§4). |
| G5 | The engine keeps running on an internal frame the owner never sees. | Frames applied by the system; FKs untouched; learning ids stable (§4.10). |
| G6 | No owner-facing internal word: olay, paket, sürüm, durak, hipotez, strateji onayı, ICP. | Re-worded reused copy and a render test over every code the pages can show (§8.5). |
| G7 | Agents outside the repo keep working through the change. | Compatibility projection of `jeeta.strategy.get` (§5.4); old tools removed only after the routines move (§7.4). |

### 1.3 Non-goals

- No change to how a post is approved, sent, measured or learned (Studio chain, publisher, TikTok
  posting screen, measurements, arms); only which rule says a post needs approval moves into the
  knowledge base (D1).
- No server enforcement of free-text prohibitions (they cannot be machine-checked); they stay
  instructions every agent reads, the final look stays the owner's (D6).
- No change to the inbox's own gates (design 2026-11-19 §6 O1–O2 stay open as they were).
- No new permission (D16), no new module id (the `strategy` module keeps its id; only its name and
  page change).
- No redesign of the TikTok posting screen (TikTok's Content Sharing Guidelines UX, kept as is).

### 1.4 Words

The owner reads only the left column. The server keeps its names.

| Owner (panel) | Internal |
|---|---|
| Paylaşım | a planned post (slot) of a content version, or a version waiting for a time |
| İçerik (only in "Düzenleme iste" texts) | production area |
| Kategori | olay (or Genel) |
| Konu (only in "Neler işe yarıyor") | hypothesis ("topic" in agent texts) |
| Bilgi bankası, kart | knowledge base, knowledge card |
| Kurallar | prohibitions + ad cap + paid-message limit + post approval (switch and account list) |
| Ajanın önerisi | knowledge proposal |
| (never shown) | strategy version, frame, consultation, ICP, rubric, cadence, package, step |

## 2. Paylaşımlar (panel)

### 2.1 Route, menu, who sees it

- Route `/posts`, element `<ModuleGate moduleId={['content', 'social', 'materials']}><PostsPage /></ModuleGate>`.
  The gate opens when **any** of the three is installed; it checks the capability requirements of
  the installed modules together and locks only when none of them is ready. The library
  (`materials`) has no requirement and comes with content, social and ads, so in practice the page
  opens whenever one of them is installed; a social module without an account opens the page and
  the Hesaplar sheet says "Hesap bağla".
- Menu: one entry **Paylaşımlar** (icon `Megaphone`), path `/posts`, replacing the content entry
  (`t('content.title')`) and the social entry. `BUILTIN_PATHS`: `content`, `social`, `materials` →
  `/posts`; `CONTENT_PAGE_MODULES` becomes `POSTS_PAGE_MODULES = ['content', 'social', 'materials']`;
  the entry is listed once and locked only when none of them is ready (existing reduce in `Shell.tsx`).
  Visible to a member holding any of `content.work`, `content.manage`, `social.work`,
  `social.manage`, `materials.work` (`moduleVisibleTo` gets a per-page rule instead of per-module).
- The core menu item "Strateji" becomes **Bilgi bankası** (icon `BookOpen`), path `/knowledge` (§4.11).

### 2.2 Page anatomy and copy

Desk layout (≥ 1024 px), top to bottom, as mockup F:

1. **Header.** Title `Paylaşımlar`; subtitle `Hazırlanan, seni bekleyen ve yayında olan her şey.`
   On the right three buttons: `Dosyalar` (icon `Images`), `Hesaplar` (icon `AtSign`) and an icon
   button with `aria-label="Ayarlar"` (icon `Settings`). Each is shown only to who may open what it
   opens (§2.10).
2. **Agent line** (one line, under the subtitle, from the merged `AgentWakeLine`, §2.9.4). While
   posting is stopped (the organic brake, §2.9.3), a red line sits under it, above the composer:
   `Tüm paylaşımlar durduruldu.` with `Sürdür` (`studio.brake` off; shown to a viewer holding
   `social.manage`; others read `Yöneticin sürdürene kadar hiçbir paylaşım çıkmaz.`).
3. **Composer** (§2.8): label `Ne paylaşalım?`, input placeholder
   `Örn. Yılbaşı için şirketlere toplu hediye figürü, sadece TikTok'ta`, button `Dosya` (paperclip),
   primary button `Gönder`.
4. **Special-day lines** (§2.7.5): at most three, each
   `{Gün} ({gün ay}) için fotoğrafın yok` with `Fotoğraf ekle` and the quiet button `Bu yıl geç`; a
   fourth and more fold into `{n} özel gün daha` (opens Ayarlar at "Özel günler").
5. **Chips** (`role="group" aria-label="Süz"`): `Tümü {n}`, `Seni bekleyen {n}` (amber while above
   0), then one chip per stage that holds at least one row, in stage order, labelled
   `Hazırlık`, `Fikir`, `Metin`, `Görsel`, `Uyarlama`, `Onay`, `Yayın`, `Sonuç` (D7). Counts come from
   the server (`counts`), never from the loaded page.
6. **Table** (`aria-label="Paylaşımlar tablosu"`) beside the **detail panel**
   (`aria-label="Seçili paylaşım"`, width 340–400 px). Columns: `Paylaşım`, `Kanal`, `Süreç`, `Durum`,
   `Yayın`.
   - *Paylaşım*: 48 px thumbnail (video: first frame with its length, design 2026-11-19 P3; no
     material: a neutral icon of the format), the title (one line, ellipsis) and a sub-line
     `{Kategori} · {Biçim}` (e.g. `Genel · Video 8 sn`).
   - *Kanal*: a badge with the platform's name (`TikTok`, `Instagram`, `Facebook`, `X`, `LinkedIn`,
     `YouTube`, `Pinterest`, `Google`), `{Platform} · {hesap}` when two connected accounts share the
     platform (`ChannelRef.label`); `—` with `title="Ajan seçecek"` while no account is chosen.
   - *Süreç*: eight dots (§2.5), `aria-label="Süreç: 8 adımın {n} tanesi bitti"`.
   - *Durum*: a pill with the status word (§2.4).
   - *Yayın*: the publish time as `Cmt 21 Kas 19:00`, `Yarın 15:00`, `Bugün 09:30`; published rows
     the time it went out; `—` when none.
   - Clicking a row selects it (`aria-pressed`), writes it into the address (§2.11) and fills the
     panel. The first row of the current filter is selected when the address names none.
7. Under the table: `Daha fazla göster` while the server has a next page (§3.2.6).

Formats (`Biçim`): `story` → `Hikâye`, `feed_post` → `Gönderi`, `carousel` → `Kaydırmalı`,
`reel` → `Reels`, `tiktok_video` → `Video`; with what the materials say: `Video · 8 sn`,
`Kaydırmalı · 2 görsel`, `Gönderi · tek görsel`.

### 2.3 What a row is

P1: a row is **one post**. Four kinds, all from `content.posts` (§3.2):

| Kind | What it is | Title | Becomes |
|---|---|---|---|
| `content` | a content (area) with no finished current package yet: queued, being made, held, waiting for a capture or for its files | the area's title (from the owner's request text, `goal_title`, 60 chars) | one `version` or `post` row per platform version once delivered |
| `version` | a version of the finished current package with no planned post yet | first line of its caption | a `post` row once it has a time |
| `post` | a planned post (slot): of a version, or of no content at all (an agent's own `posts_propose`, a weekly quota slot) | first line of the caption that goes out (version caption, else the slot's piece text); before a piece exists `{Biçim} · {Kanal}` | stays, through published |
| `need` | an open request of the çekim listesi (a photo or video the system needs) | the request's own sentence | disappears when a file of it is usable (§3.7.1) or it is dismissed |

Not rows: retired posts that never went out (cancelled, replaced, replanned: they are history),
archived contents (D14), olays awaiting confirmation (they live in Dosyalar, D8).

### 2.4 Row statuses

The pill word, its tone, and when. One status per row, first matching line wins.

| Status | Pill | Tone | When |
|---|---|---|---|
| `failed` | `Paylaşılamadı` | red | a post that will not go out: its one attempt failed or was refused, or it passed its grace unsent (`PublicationFact.failed`); it waits for the owner until they act on it or choose `Bırak` (§2.6) |
| `tiktok_draft` | `TikTok'ta taslak` | amber | sent to the creator's TikTok drafts (the slot's TikTok choice was a draft, `studio.tiktok_metrics`' `draft`): it carries the wait `tiktok_draft` until `Tamamladım` or for 7 days; then it is `published` with the pill `TikTok'a gönderildi` (green; no measurement is expected, so its progress is done) |
| `waiting_you` | `Seni bekliyor` | amber | the row has at least one wait (§2.6) |
| `paused` | `Durduruldu` | grey | an unsent post or a version while the organic brake is on (`PostsOut.brake`); not counted in `Seni bekleyen`: the page's red line says it once |
| `revising` | `Düzenleniyor` | violet | its content has a "Düzenleme iste" standing (`RedoRequest`) and no newer package yet |
| `preparing` | `Hazırlanıyor` | violet | a `content` row with no wait |
| `scheduling` | `Zamanlanıyor` | violet | a `version` row an account can take; the agent gives it its time |
| `scheduled` | `Planlandı` | violet | a `post` with a time, not out, nothing waiting |
| `published` | `Yayında` | green | went out (`published_at` set) |

The panel's status line under the title is more precise than the pill: the first wait's own
status (`Onayını bekliyor`, `TikTok'ta tamamlanacak`, …, §2.6), else the sub-state of `preparing`:

| Sub-state | Panel line |
|---|---|
| an agent holds the claim | `Ajan üzerinde çalışıyor · {aşama}` |
| queued, an agent can take it and has a wake address | `Sırada · ajan şimdi başlıyor` |
| queued, an agent can take it, no wake address | `Sırada · ajan bir sonraki çalışmasında başlar ({saat})` (its next expected check-in, `wake::interval_of`) |
| queued, the next expected check-in already passed | `Sırada · ajan {saat} bekleniyordu, gecikti` with the quiet action `Şimdi çalıştır` (`agents.wake_now`, when an address exists) |
| start time in the future (a special day's content) | `{gün ay} günü hazırlanmaya başlanır` |
| its files wait for analysis (a person's upload, §3.4.4) | `Dosyaların inceleniyor` |

### 2.5 Mini progress: the eight stages

The dots are the content pipeline's eight stages (`content/pipeline.rs` `STAGES`). A row carries
`progress {index 0..=7, state}`: every dot before `index` is done (green), the dot at `index` is
current (violet ring), waits for the owner (amber ring) or is stuck (red ring), the ones after are
todo (grey). `index = 7` with `state = done` means everything is done (all green).

| Row | index | state |
|---|---|---|
| `content`, queued, no step reported | 0 Hazırlık | current |
| `content`, step *n* reported | the stage spanning *n* (1–3 → 0, 4–6 → 1, 7–8 → 2, 9–10 → 3, 11–14 → 4) | current |
| `content`, waiting for a capture or for its files' permission | 3 Görsel | waiting_person |
| `content`, held after three refusals | 4 Uyarlama | problem |
| `version`, an account can take it | 5 Onay | current |
| `version`, no account can take it (blocked) | 5 Onay | problem |
| `post`, waiting for approval or the TikTok screen | 5 Onay | waiting_person |
| `post`, scheduled, not out, no wait | 6 Yayın | current |
| `post`, waiting for something else of the owner's (hold, files) | 6 Yayın | waiting_person |
| `post`, failed | 6 Yayın | problem |
| `post`, `tiktok_draft` with its wait | 6 Yayın | waiting_person |
| `post` or `version`, `paused` | its index as without the brake | current |
| `post`, out, measurements still to come | 7 Sonuç | current |
| `post`, out and measured (or retired after its measurements), or a TikTok draft acknowledged or 7 days old | 7 Sonuç | done |
| `need` | 3 Görsel | waiting_person |

A row's **stage chip** is its `index` stage (a fully done row is under `Sonuç`). The rules are the
pipeline's own (`post_states`, design 2026-11-18 O11) applied to one post instead of a whole area.

### 2.6 Waits: why a row waits for the owner, and its one action

A wait is derived from the facts on every read (R2): it goes the moment its cause does. Each has
one primary action, sometimes one quiet secondary; the panel shows the sentence above the actions.
`{Kanal}` is the platform name, `{hesap}` the account's name.

| Code | Status line | Sentence | Primary action → call | Secondary |
|---|---|---|---|---|
| `approval` | `Onayını bekliyor` | `Yayından önce onayını bekliyor.` | `Onayla` → `studio.approve` | — |
| `posting_screen` | `TikTok'ta tamamlanacak` | `TikTok'un paylaşım ekranını sen tamamlarsın.` | `TikTok'ta tamamla` → opens the unchanged TikTok posting dialog (`studio.tiktok_posting`, `studio.tiktok_post`) | — |
| `capture` | `Fotoğraf bekliyor` | `Ajan bunun için bir fotoğraf ya da video istiyor: “{istek}”` | `Dosya ekle` → `content.files_add` (target `capture`) | `Gerek yok` → `studio.project_request_update` status `dismissed` |
| `files_permission` | `İzin bekliyor` | sensitive: `Dosyanda {yüz / isim / çocuk / logo / kurum adı} görünüyor; paylaşılması için izin ver.`; not checked (analysis failed, no materials agent, or an analysis without `sensitive_checked`): `Dosyalarının paylaşılabilir olduğunu onayla.` | `İzin ver` → `studio.material_permission` (`shareable`) for each such file | `Bu dosya olmadan devam et` → `studio.project_materials` (remove); on a need or a special day: `Başka fotoğraf ekle` → `content.files_add` |
| `files_quality` | `Dosya uygun değil` | `Ajan bu dosyayı paylaşmaya uygun bulmadı: {neden}.` | `Yine de kullan` → `studio.material_intelligence_update` (quality `publishable`) | `Bu dosya olmadan devam et` |
| `delivery_held` | `Takıldı` | `Ajan bunu üç kez hazırladı ama kontrolden geçemedi: {ilk bulgu}.` | `Düzenleme iste` → `content.area_redo` | `Yine de kabul et` → `content.delivery_accept` (only when the server says it is releasable) |
| `check_hold` | `Bekletiliyor` | `Paylaşım saatinde bir kontrol durdurdu: {neden}.` | `Düzenleme iste` | `Yine de paylaş` → `studio.material_check_release` (only for caption findings, as `MaterialHold` did) |
| `failed` | `Paylaşılamadı` | `{Kanal} bu paylaşımı almadı: {neden}.` | by its reason: `auth` or `permission` while the account still cannot post → `Yeniden bağla` (`/connect?capability={id}`); `validation` or `refused` → `Düzenleme iste`; anything else (`rate_limited`, unreachable, `missed_grace`, or an `auth` failure whose account works again) → `Tekrar hazırlat` (§2.7.1's dialog, prefilled) | `Bırak` → `content.post_dismiss` (the row stays `Paylaşılamadı`, no longer waits) |
| `tiktok_draft` | `TikTok'ta taslak` | `TikTok'taki taslaklarına gönderildi; paylaşımı TikTok uygulamasında sen yaparsın.` | `Tamamladım` → `content.post_dismiss` | — |
| `no_account` | `Hesap yok` | `Paylaşacak bağlı bir hesap yok.` | `Hesap bağla` → opens Hesaplar at "Hesap bağla" | — |
| `no_account_for_platform` | `Hesap yok` | `{Platform} hesabın bağlı değil.` | `Hesap bağla` | `Düzenleme iste` |
| `account_unavailable` | `Bağlantı koptu` | `{hesap} bağlantısı şu an çalışmıyor.` | `Yeniden bağla` → `/connect?capability={id}` | — |
| `account_paused` | `Hesap durdu` | `{hesap} hesabında paylaşım durduruldu.` | `Sürdür` → `social.account_pause` (`paused: false`) | — |
| `media` | `Dosya uymuyor` | `{Kanal} bu dosyayı bu biçimde almıyor (örneğin TikTok yalnızca video alır).` | `Düzenleme iste` | — |
| `material_removed` | `Dosya silindi` | `Bu paylaşımdaki bir dosya silindi.` | `Düzenleme iste` | — |
| `knowledge_empty` | `Bilgi bankası boş` | `Ajanlar seni henüz tanımıyor: Bilgi bankası boş.` | `Bilgi bankasına git` → `/knowledge` | — |
| `no_agent` | `Ajan yok` | `Bu işi yapacak bağlı bir ajan yok.` | `Ajan bağla` → `/agents` | — |
| `pick_time` | `Zaman bekliyor` | `Zamanını seçecek bir ajan yok.` | `Zaman seç` → `social.version_schedule` (a person's time, existing `ScheduleControl` with `suggestTimes`) | — |
| `need_photo` | `Fotoğraf bekliyor` | `{istek cümlesi}` | `Fotoğraf ekle` → `content.files_add` (target `need`) | `Gerek yok` → `studio.shoot_resolve` (`dismissed`) |

Reasons in words:

- `{neden}` of `failed` from `RedactedPublishError`: `auth` → `bağlantının izni bitti`,
  `permission` → `hesabın paylaşım izni yok`, `rate_limited` → `platform geçici olarak almadı`,
  `validation` / `refused` → `platform içeriği kabul etmedi`, anything else → `platforma ulaşılamadı`;
  `missed_grace` → `zamanı geçti`. An `auth` or `permission` failure on an account that works again
  says `{Kanal} bu paylaşımı almadı: bağlantı yenilendi, yeniden hazırlatabilirsin.`
- `{neden}` of `check_hold`, `delivery_held`, `files_quality`: the first finding's Turkish copy in
  the owner's words (`materials.finding.*` re-worded, §8.5: never olay, materyal, strateji), never
  the code. A `check_hold` whose finding is `sensitive_needs_human` or `share_unset` is shown as the
  `files_permission` wait of that file instead (a face found after the share was set by rule,
  §3.4.4).
- Which server reason gives which wait: §3.2.4.

Counted in `Seni bekleyen`: every row with a wait. A `failed` post of no content has no action (nothing
the owner does sends it): it is `Paylaşılamadı` without a wait, never counted, and it leaves the
default view seven days after it failed (it stays reachable under `Yayın`). A content's failed post
waits until the owner takes one of its actions or `Bırak`; after `Bırak` it behaves as a failed post
of no content. While the organic brake is on, no row gets a wait for it: the page's red line and the
`paused` status say it once.

### 2.7 Detail panel

No tabs, no step list. Top to bottom (mockup F):

1. 92 px image (the cover; a video shows its first frame and a play mark), beside: title (17 px,
   two lines max), `{Kanal} · {zaman}` and the status pill.
2. Wait sentence when the row waits (§2.6), amber box.
3. **Actions**, one row of buttons, only those the server says this viewer may take
   (`actions`, §3.2.3), in this order: the wait's primary action (filled), `Onayla` or
   `TikTok'ta tamamla` when not already the primary, `Düzenleme iste`, `İptal`; the wait's
   secondary action (`Bırak`, `Gerek yok`, `Yine de kabul et`, …) as a text button under them. No
   action: no button row. `paused` rows show the sentence `Tüm paylaşımlar durduruldu; sürdürünce
   zamanında çıkar.` with `Sürdür` (the page's brake action).
4. The post text, whole (the caption that goes out; before delivery, the owner's request text with
   the label `İsteğin`).
5. Details: `Kanal` (`{Kanal} · {hesap}`), `Tarih` (planned time, or `Yayınlandı · {zaman}` with the
   link `Paylaşımı aç` when the platform gave one), `Biçim`, `Kategori` (the olay's title, or
   `Genel`).
6. When a material of the post is AI-made (`origin = ai_generated`): the info box
   `Görsel yapay zekâ ile üretildi; gerçek bir sipariş değil.`
7. When the content has other posts: one line `Aynı içerikten: {Kanal} · {zaman}, …` (links that
   select them). Nothing more.

#### 2.7.1 "Düzenleme iste"

Dialog title `Ne değişsin?`; textarea (required, 1–2000 characters) placeholder
`Örn. Daha kısa olsun, fiyat yazma`; consequence line built from the server's `siblings`:
- unsent siblings: `Bu içerikten {n} paylaşım daha var ({Kanal} · {zaman}, …); onlar da yeniden hazırlanır.`
- published siblings: `Yayınlanmış paylaşımlar yerinde kalır.`
Buttons `Gönder`, `Vazgeç`. Calls `content.area_redo {project_id, package_revision, note}`. Success
toast `Ajana iletildi.` The row turns `Düzenleniyor`; its unsent posts are withdrawn by the server as
today. `Tekrar hazırlat` (a failed post) opens this same dialog with the text prefilled
`Paylaşım gönderilemedi; aynısını yeniden hazırla.` (editable) and the same consequence line, so the
owner sees which other posts of the content are taken back before sending.

#### 2.7.2 "İptal"

Dialog title `İptal edilsin mi?`, body by target (`actions.cancel.kind`):
- `post`: `{Kanal} · {zaman} paylaşımı çıkmayacak. Aynı içerikten diğer paylaşımlar yerinde kalır.`
  → `studio.slot_cancel {slot_id, expected_revision, reason}`.
- `version`: `Bu paylaşım hiç planlanmayacak.` → `content.version_cancel` (§3.7.3).
- `content`: `Bu içerik hazırlanmayacak.` → `studio.project_update {archived: true, expected_revision}`;
  the toast `İptal edildi.` carries `Geri al` for 10 s (`archived: false`).
Optional input `Neden? (isteğe bağlı)`; an empty reason is sent as `Sahibi iptal etti`. Buttons
`İptal et` (destructive), `Vazgeç`.

#### 2.7.3 "Onayla" and "TikTok'ta tamamla"

`Onayla` calls `studio.approve {target: {slot}, expected_revision}` at once; toast
`Onaylandı. {zaman} paylaşılacak.` `TikTok'ta tamamla` opens the existing dialog
(`TiktokDialog`/`StudioTiktok`, unchanged) and writes `tiktok={slot_id}` into the address.

#### 2.7.4 Revisions and conflicts

The read gives every revision an action needs (§3.2.3). A `CONFLICT` answer (the post changed since
it was read) refetches the row and says `Bu paylaşım bu arada değişti; son hâlini gösteriyorum.`

#### 2.7.5 Special-day lines

From `content.posts.days` (§3.2.5): a calendar day of the current or next season whose preparation
has started or starts within 14 days, whose window has not ended, and which has no usable file yet.
`Fotoğraf ekle` opens the file picker and calls `content.files_add` with target
`special_day {key, year}` (§3.7.1). The line then follows its files (`SpecialDayLine.files.state`)
until one is usable, and disappears then (R2; the day's content appears as a row):

| State | Line | Action |
|---|---|---|
| no file | `{Gün} ({gün ay}) için fotoğrafın yok` | `Fotoğraf ekle`, quiet `Bu yıl geç` |
| analysing | `{Gün}: fotoğrafın inceleniyor.` | — |
| needs_permission (a face, a name, a child, a logo or a company name found) | `{Gün}: fotoğrafında {yüz / isim / çocuk / logo / kurum adı} var; paylaşılması için izin ver.` | `İzin ver` (`studio.material_permission`), quiet `Başka fotoğraf ekle` |
| unchecked (analysis failed, no materials agent, or not checked for people) | `{Gün}: fotoğrafının paylaşılabilir olduğunu onayla.` | `İzin ver`, quiet `Başka fotoğraf ekle` |
| quality | `{Gün}: ajan bu fotoğrafı paylaşmaya uygun bulmadı.` | `Yine de kullan`, quiet `Başka fotoğraf ekle` |

`Bu yıl geç` calls `content.special_day_skip {key, year}` (§3.7.2); toast
`Bu yıl {Gün} için paylaşım yapılmayacak.` with `Geri al` (calls `studio.calendar_set` with
`enabled: true`).

### 2.8 Composer "Ne paylaşalım?"

- Text 1–2000 characters, files 0–10 (JPEG, PNG, WebP, GIF up to 25 MB; MP4 up to 200 MB). `Dosya`
  opens the picker; dropping files anywhere on the page attaches them to the composer (not to the
  library: that is Dosyalar). Attached files show as chips (`{ad} ×`) with upload progress; a failed
  upload shows `Yüklenemedi · Tekrar dene`.
- `Gönder` uploads the files (`studio.file_upload`, one by one, the existing tray logic of
  `uploads.tsx`) and then calls `content.post_request {request_key, text, file_ids}`. Enter sends;
  Shift+Enter is a new line (the input grows to three lines).
- **Before sending (R1)** the composer shows, under itself, every stop the server already knows
  (`content.posts.composer.stops`, §3.2.5), one line each with its action, always; sending stays
  possible (D20):

| Stop | Line | Action |
|---|---|---|
| `knowledge_empty` | `Ajanlar seni henüz tanımıyor. Önce Bilgi bankasına birkaç satır yaz; isteğin o zaman başlar.` | `Bilgi bankasına git` |
| `braked` | `Tüm paylaşımlar durduruldu; isteğin hazırlanır ama sürdürene kadar çıkmaz.` | `Sürdür` |
| `no_account` | `Paylaşacak bağlı bir hesap yok; içerik hazırlanır ama bir hesap bağlayana kadar çıkmaz.` | `Hesap bağla` |
| `no_content_agent` | `İçerik hazırlayacak bağlı bir ajan yok.` | `Ajan bağla` |
| `agent_sleeps` | `Ajanın çağrı adresi yok; bir sonraki çalışmasında ({saat}) başlar.` | `Çağrı adresi ekle` (→ `/agents`) |
| `agent_late` | `Ajan {saat} bekleniyordu, gecikti.` | `Şimdi çalıştır` |

- **Advice** (`approval`, `posting_screen`, `video_only`) is one quiet line, shown only while the
  input has focus or text, its parts joined by ` · `: `Onayına gelir` (the approval switch is on),
  `TikTok'u sen tamamlarsın` (a TikTok account is connected), `Hesapların yalnızca video alıyor;
  video eklemezsen ajan görselden video yapar` (every postable account takes only video).
- **A platform named in the text** (R1): the panel matches platform names in the typed text
  (case-insensitive, with Turkish suffixes: `tiktok`, `instagram`/`insta`, `facebook`/`face`,
  `linkedin`, `x`/`twitter` as a whole word, `youtube`, `pinterest`, `google`) against
  `composer.connected` (`[{kind, name}]`); one not connected shows, as the user types,
  `{Platform} hesabın bağlı değil; bu istek oraya çıkamaz.` with `Hesap bağla`.

- **After sending**: the input clears, the new `content` row appears first and selected, toast
  `İsteğin alındı.` plus `Ajan şimdi başlıyor.` when an agent was woken, else
  `Ajan {saat} civarı başlar.`; the stops of the answer (§3.4) show in the panel as the row's waits.
- Hidden when the workspace has no content module (`İçerik modülü kurulu değil` line with
  `Modül ekle` → `/modules/content`) or the viewer lacks `content.manage`. The `Dosya` button is
  hidden without `materials.work`.

### 2.9 Header drawers

#### 2.9.1 Dosyalar

A right drawer (full screen on a phone), the file library and its analysis queue (what
`ContentTree`'s "Analiz sırası", `QueueView`, `FileDrawer`, `OlayView`'s files and Eksikler gave):

- Title `Dosyalar`, button `Yükle` (library upload: unfiled, into analysis, as today), the
  materials agent line (`AgentWakeLine` `materials`).
- Chips `Tümü`, `İnceleniyor {n}` (the analysis queue), `İzin bekleyen {n}` (share unset), and a
  select `Kategori: Tümü / Genel / {olay title}…` (olays, newest first) with `Kategori ekle`
  (`studio.olay_create`) and, for the chosen one, `Düzenle` (`OlayForms`, unchanged).
- When agents proposed categories: a block `Onay bekleyen kategoriler` with one line each
  `{title} · {tarihler}` and `Onayla` (`studio.olay_confirm`). Not counted in Seni bekleyen (D8).
- A grid of files (thumbnail, title, a small state word: `Sırada`, `İnceleniyor`,
  `Yerini seç` (needs filing), `İncelenemedi · Tekrar dene`, `İzin bekliyor`); a file opens the
  existing `MaterialEditor` (`?file=`), whose "Olay" field is labelled `Kategori` and whose
  used-in links go to `/posts?slot=`.

#### 2.9.2 Hesaplar

A right sheet (full screen on a phone), what `AccountRail` and `AccountHeader` gave:

- Title `Hesaplar`, button `Hesap bağla` (→ `/connect`).
- One block per social account (`social.accounts_list`): name, platform badge, status
  (`Paylaşım açık` / `Durduruldu` / `Bağlantı kullanılamıyor`), switch `Paylaşım açık`
  (`social.account_pause`, `social.manage`), the stops of `social::ready` without strategy codes
  (§3.10), and, collapsed, `Sayılar`: the account's metrics, sparklines and totals with the period
  select `7 / 30 / 90 gün` and the strays at the platform (`social.account_get`, read only when
  opened — never one read per account on page load).
- Per account approval: while the Kurallar switch is on, the read-only line
  `Her paylaşım onayına gelir (Kurallar)`; while it is off, a switch
  `Bu hesaptaki paylaşımlar onayıma gelsin` writing the account into or out of the knowledge base's
  list (`strategy.post_approval_set`, §4.6.5; turning it off needs owner or manager). It never writes
  the capability's stored flag, which keeps holding that account's comment replies as today
  (`Yorum yanıtları onayına gelir` is shown read-only when that flag is set, with `Değiştir` opening
  the capability's policy dialog). TikTok always reads `Her paylaşım TikTok ekranını bekler`.

#### 2.9.3 Ayarlar

One dialog, no tabs: three headed sections in one scroll, with anchors (`section=rules|days|files`):

1. `Paylaşım kuralları`: the existing `SettingsDialog` body (caps, quiet hours, zone, per-format
   lead and grace, floor, debounce, horizon, provider scheduling), plus at its end the switch
   `Tüm paylaşımları durdur` (`studio.brake`, organic lane, `social.manage`) — the owner's one stop
   now that the strategy has no archive (D10). While it is on, the page shows its red line and every
   unsent row reads `Durduruldu` (§2.2, §2.4); releasing it wakes the social agent
   (`posting_resumed`), so versions waiting for a time get one again without a clock (R2).
2. `Özel günler`: the existing `MaterialsCalendar` per year.
3. `Dosya kullanımı`: the materials policy (lead, reuse, recap, AI visual alone).

#### 2.9.4 The agent line

One line under the subtitle, from `agents.wakes` for the needs `content`, `social`, `materials`:
the need that has work waiting and whose agent is not running wins; it reads as `AgentWakeLine`
does today (`Ajan çalışıyor`, `Ajan {zaman} önce çalıştı · sıradaki çalışma {saat}`, with
`Şimdi çalıştır`). With nothing waiting: `Ajan {zaman} önce çalıştı.`

### 2.10 States

| State | What shows |
|---|---|
| Loading | composer enabled; chips as three grey pills; five skeleton rows; the panel's skeleton |
| Error | `Paylaşımlar yüklenemedi.` with `Yeniden dene` (`QueryState`); a failed preview shows the format icon |
| Empty, knowledge base empty | `Henüz paylaşım yok. Ajanların seni tanıması için önce Bilgi bankasını doldur.` + `Bilgi bankasına git` |
| Empty | `Henüz paylaşım yok. Ne paylaşmak istediğini yukarıya yaz; gerisini ajan hazırlar.` |
| Posting stopped (organic brake) | the red line of §2.2 above the composer; unsent rows `Durduruldu`; the composer stop `braked` |
| Filter matches nothing (`Seni bekleyen`) | `Seni bekleyen bir şey yok.` + `Tümünü göster` |
| Filter matches nothing (stage) | `Bu aşamada paylaşım yok.` (mockup F). A stage chip whose count drops to 0 while chosen disappears and the filter falls back to `Tümü` (address updated with `replace`) |
| Row named in the address but not on the loaded page | read with `content.post_get` and shown in the panel; the table keeps its page |
| Row gone (cancelled, archived) | panel: `Bu paylaşım artık listede değil.` + `Kapat` |
| Many rows | 50 a page, `Daha fazla göster` (cursor); counts are the server's |
| 640–1023 px | table full width; the panel opens as an overlay sheet from the right (max 420 px) with `Kapat` |
| < 640 px (phone) | cards instead of the table: 56 px thumbnail, title on two lines, `{Kanal} · {Yayın}`, the pill and the dots under it; chips scroll horizontally; the panel is a full-screen sheet with `‹ Paylaşımlar`; the composer stacks (input, then `Dosya` and `Gönder` icons) |

Permission variants (the server computes `actions`; the panel never guesses):

| Viewer | Sees | May |
|---|---|---|
| owner / manager | everything | everything |
| `content.*` only (no `social.*`) | every row; Hesaplar hidden; `Paylaşım kuralları` hidden in Ayarlar | composer (`content.manage`), `Düzenleme iste` and `Tekrar hazırlat`, content and version `İptal` (`content.manage`), post `İptal` (`content.manage`, D13), `Bırak` / `Tamamladım`; not `Onayla`, not `TikTok'ta tamamla`, not the brake's `Sürdür` |
| `social.*` only (no `content.*`) | every row; no composer (it is absent, not disabled) | `Onayla` / `TikTok'ta tamamla` (`social.manage`, owner or manager in person), post `İptal` (`social.manage`), `Zaman seç`, `Sürdür` (an account, and all posting), `Bırak` / `Tamamladım`, Hesaplar' per-account approval; not `Düzenleme iste`, not `Tekrar hazırlat` |
| `materials.work` only | every row; Dosyalar | no row action; Dosyalar actions as today |
| `content.work` without `content.manage` (a read-only content member) | every row | none: the panel shows no button row |
| none of the five permissions | no menu entry; the address answers `Bu sayfayı görmek için yetkin yok.` | — |

### 2.11 Addresses

`/posts` with:

| Param | Meaning |
|---|---|
| `f` | filter: `you`, or a stage key `hazirlik`, `fikir`, `metin`, `gorsel`, `paket`, `onay`, `yayin`, `sonuc`; absent: Tümü |
| `slot`, `version`, `content`, `need` | the selected row (one of them); `content` names an area: its `content` row, else its first waiting post, else its next post, else its last published one |
| `tiktok` | the TikTok posting dialog over the selected post |
| `files=1` (+ `queue=1`, `category={olay id or genel}`, `file={material id}`) | the Dosyalar drawer, its queue chip, its category, an open file |
| `accounts=1` (+ `account={capability id}`, `days=7\|30\|90`) | the Hesaplar sheet, one account open |
| `settings=1` (+ `section=rules\|days\|files`, `year`, `day={key}:{year}`) | Ayarlar at a section |

A change of selection is a new history entry; filter changes `replace`.

Legacy addresses (one `Navigate replace`, query mapped; `LegacyRedirect.tsx`, `App.redirects.test.tsx`):

| Old | New |
|---|---|
| `/content` | `/posts` |
| `/content?view=all` | `/posts` |
| `/content?view=queue[&file=m]` | `/posts?files=1&queue=1[&file=m]` |
| `/content?olay=o` (also `genel`) | `/posts?files=1&category=o` |
| `/content?day=k:y` | `/posts?settings=1&section=days&day=k:y` |
| `/content?content=a` (also legacy `area=`, `project=`) | `/posts?content=a` |
| `/content?file=m` | `/posts?files=1&file=m` |
| `/content?settings=1[&year=y]` (also `tab=calendar\|settings`) | `/posts?settings=1&section=days[&year=y]` |
| `/content…#eksikler` | `/posts?f=you` |
| `/social` | `/posts` |
| `/social?view=all` | `/posts` |
| `/social?account=c[&days=n]` | `/posts?accounts=1&account=c[&days=n]` |
| `/social?slot=s` | `/posts?slot=s` |
| `/social?version=v` | `/posts?version=v` |
| `/social?tiktok=s` | `/posts?slot=s&tiktok=s` |
| `/social?filter=approvals\|tiktok\|failed\|blocked` | `/posts?f=you` |
| `/social?filter=times` | `/posts?f=onay` |
| `/social?settings=1` (also `tab=settings`, `section=settings`, `tab=posts&view=settings`) | `/posts?settings=1&section=rules` |
| `/social?tab=packages#version-v` | `/posts?version=v` |
| `/social?tab=packages` | `/posts?f=onay` |
| `/studio?tab=materials[&olay=o][&material=m]` | `/posts?files=1[&category=o][&file=m]` (`olay=review` dropped) |
| `/studio?tab=projects…`, `/studio?tab=posts`, `/studio` | `/posts` (`content`, `slot` kept) |
| `/materials?olay=o&material=m` | `/posts?files=1&category=o&file=m` |
| `/strategy` (any query) | `/knowledge` |

The server answers every non-asset path with `index.html` (`static_files.rs`), so no server route
changes; no server text links to `/content` or `/social` (A3 fact).

### 2.12 Capability table

Everything `/content` and `/social` offer at `803cab98` (A3 facts and touchpoints) and where it
goes.

| # | Today | Where | New home |
|---|---|---|---|
| 1 | Production line (`RootView`): open, done (paged), archived reads, grouped by olay | /content | the table (`content.posts`); grouping removed, olay is the `Kategori` sub-line and detail field |
| 2 | Five static filter chips (all/working/waiting/done/archived) | /content | `Tümü`, `Seni bekleyen`, dynamic stage chips; archived not listed (D14) |
| 3 | Olay tree (Şimdi / Sürekli (Genel) / Yaklaşan / Geçmiş) | /content | removed from the page; Dosyalar's category select |
| 4 | Olay folder: edit, confirm, contents, files, needs-review, no-share warning | /content | edit/create in Dosyalar (`Kategori ekle`, `Düzenle`); confirm in `Onay bekleyen kategoriler`; files in the grid; no-share in `İzin bekleyen` |
| 5 | Eksikler: çekim listesi done/dismiss, material request dismiss, AddShoot in Genel | /content | `need` rows (`Fotoğraf ekle` / `Gerek yok`); a content's capture is its `capture` wait; AddShoot dropped (the composer and the notes ask instead) |
| 6 | Special day view (phase, help, shoot request link, create olay prefilled) | /content | special-day lines (`Fotoğraf ekle` creates the confirmed olay, §3.7.1), Ayarlar › Özel günler |
| 7 | Analysis queue (stages, file into olay or Genel, erase, retry, agent line) | /content | Dosyalar › `İnceleniyor` with the same actions and the materials agent line |
| 8 | File drawer (`MaterialEditor`): analysis, productions, tags, people, share, genel, bind, used-in, delete | /content | Dosyalar › file, unchanged; used-in links → `/posts?slot=` |
| 9 | Settings dialog: special-days calendar, materials policy | /content | Ayarlar › Özel günler, Dosya kullanımı |
| 10 | Page-wide drag-and-drop upload with tray | /content | drop on the page attaches to the composer; Dosyalar › `Yükle` for the library |
| 11 | "Open a content" dialog with platform and format pickers | /content | composer, no pickers (P3) |
| 12 | Row's 8-stage track and exception bar with links to /social | /content | mini dots; the exception becomes the row's wait with its in-page action |
| 13 | Content detail: 14 steps, versions in phone frames, redo, accept-held, archive/restore, stop list, capture requests, sources, history, cancel | /content | panel (no steps, D-owner); redo = `Düzenleme iste`; accept-held = `Yine de kabul et`; archive = content `İptal` with `Geri al`; stops = waits; capture = `capture` wait; sources: files come from the composer or `Dosya ekle`; legacy history dropped |
| 14 | "Sizi bekleyenler" strip (olay confirmations, shoot requests, approvals, times, problems) | both | `Seni bekleyen` chip; olay confirmations to Dosyalar (D8); times only when no agent can (`pick_time`) |
| 15 | Module status lines, strategy rows, agent wake line + "Şimdi çalıştır" | both | the one agent line (§2.9.4); strategy rows replaced by `knowledge_empty` (§4.12) |
| 16 | Account rail (paused, locked, next post, waiting dot) | /social | Hesaplar sheet |
| 17 | Account header: metrics, sparklines, period, totals, strays, pause, stops | /social | Hesaplar › account › `Sayılar`, the pause switch, its stops |
| 18 | Timeline sections: waiting, Sırada, Yayınlananlar | /social | the table's statuses and ordering (§3.2.6) |
| 19 | Approve, cancel, failed actions, post detail with text and phone frame | /social | panel actions and text |
| 20 | TikTok posting dialog (`?tiktok=`), status, counters, draft mode, cancel of a failed post | /social | unchanged dialog over `/posts`; `tiktok=` kept |
| 21 | Redo from a post (needs `package_revision`) | /social | `Düzenleme iste` (the read carries the revision) |
| 22 | "Düzenleniyor" group (`useRevisingCount`) | /social | `revising` status |
| 23 | Versions waiting for a time: a person's time (`ScheduleControl`, `suggestTimes`) | /social | `version` rows; `pick_time` wait, and `Zamanı ben seçeyim` (quiet link in the panel of any `scheduling` row, `social.work`) |
| 24 | Blocked reasons with fix links (/strategy, /connect, paused, content) | /social | waits §2.6 (no strategy link exists any more) |
| 25 | Posting rules dialog | /social | Ayarlar › Paylaşım kuralları |
| 26 | Connect button | /social | Hesaplar › `Hesap bağla` |
| 27 | Stop list with approve_strategy / prepare_strategy (also on the OAuth callback page) | /social, /oauth | Hesaplar and the OAuth callback keep `StopList` without the strategy codes (§3.10) |
| 28 | Open an item no list holds (`MissingContent`, `MissingPost`) | both | `content.post_get` (§3.3) |
| 29 | Held post shown with a reason and no action; unrouted `MaterialHold` | /social | `check_hold` wait with `Yine de paylaş` (wires `MaterialHold`'s release) |
| 30 | Unrouted `StudioProjects`, `ProjectPublications`, `ProjectProduction` | tests only | deleted with their test harnesses |
| 31 | New-olay button | /content | Dosyalar › `Kategori ekle` |
| 32 | Home work items and agenda links into /content and /social | home | retargeted (§2.13) |
| 33 | Account period `days=7\|30\|90` | /social | Hesaplar `days` |
| 34 | Badge `Her paylaşım TikTok ekranını bekler` | /social | Hesaplar, per TikTok account |
| 35 | Agent wake line of the analysis queue | /content | Dosyalar header |

### 2.13 Links into the page

| Where | Today | New |
|---|---|---|
| `lib/workItems.ts` | `studio_slot`, `studio_approval` → `/social?slot=` | `/posts?slot=` |
|  | TikTok waiting → `/social?tiktok=` | `/posts?slot=s&tiktok=s` |
|  | `studio_shoot_request` → `/content` | `/posts?need={shoot_request_id}` |
|  | `studio_post_request` → `/social?tab=posts` | `/posts` |
|  | `content_area`, `content_material_request`, `content_area_held` → `/content?content=` | `/posts?content=` |
|  | `studio_material_analysis` → `/content?view=queue&file=` | `/posts?files=1&queue=1&file=` |
|  | `studio_material_production` → `/content` | `/posts?files=1` |
|  | `consult_strategy`, `approve_strategy` → `/strategy` | removed; `knowledge_*` → `/knowledge` (§5.2) |
| `pages/home/agenda.ts` | `/social?slot=` | `/posts?slot=` |
| `FileDrawer`, `MaterialEditor` used-in | `/social?slot=` | `/posts?slot=` |
| `AreaHistory`, `ProjectShared`, `ProjectMaterials`, `MaterialHold` | `/content?file=` | deleted, or `/posts?files=1&file=` for what stays |
| `Revision` (revising) | `/content?content=` | in-page |
| `VersionRow` fix | `/content?view=all&content=` | in-page |
| `StudioShared` `StudioError` | `STRATEGY_REQUIRED` → `/strategy` | → `/knowledge` with the `knowledge_empty` words |

## 3. Paylaşımlar (server)

### 3.1 Catalog rows

All new rows are `panel_only` (a person's page; agents keep their own reads) and `Exempt` from the
strategy gate, so the page works before any frame exists. Module gating: the reads and the file
writes are added to the shared list the library page reads use (`gate.rs` `LIBRARY_PAGE_READS`,
renamed `SHARED_PAGE_USE_CASES`, gated by `materials`, which comes with content, social and ads), so a
social-only workspace has the page; the composer and the version cancel are the `content` module's.

| Use case | Route | Risk | Module | Permission (any of) | Person in person |
|---|---|---|---|---|---|
| `content.posts` | `GET /api/content/posts` | Read | materials | `content.work`, `content.manage`, `social.work`, `social.manage`, `materials.work` | no |
| `content.post_get` | `GET /api/content/posts/{row_id}` | Read | materials | same | no |
| `content.post_request` | `POST /api/content/post-requests` | Write | content | `content.manage` (+ `materials.work` when `file_ids` is not empty) | yes |
| `content.files_add` | `POST /api/content/files` | Write | materials | `materials.work`; target `capture` also `content.work` or `content.manage` | yes, owner or manager (`library::decider`) |
| `content.special_day_skip` | `POST /api/content/special-days/{key}/{year}/skip` | Write | materials | `content.work`, `materials.work` | yes, owner or manager (`human_approver`) |
| `content.version_cancel` | `POST /api/content/areas/{project_id}/versions/{version_id}/cancel` | Write | content | `content.manage`, `social.manage` | yes |
| `content.post_dismiss` | `POST /api/content/posts/{slot_id}/dismiss` | Write | materials | `content.manage`, `social.manage` | yes |

Changed rows: `studio.posting_policy_set` becomes `Exempt` (the posting policy is not the strategy;
A1.25, D12). `studio.slot_cancel`'s permission for a **person** becomes `social.manage` or
`content.manage` (an agent keeps `social.work`; D13), matching what the panel offered.

### 3.2 `content.posts`

#### 3.2.1 Input

```rust
#[derive(Deserialize)] #[serde(deny_unknown_fields)]
pub struct PostsQuery {
    /// `you`, or a stage key (`hazirlik` … `sonuc`); absent: every row.
    #[serde(default)] pub filter: Option<String>,
    /// Opaque, from `next_cursor`.
    #[serde(default)] pub cursor: Option<String>,
    /// 1..=100, 50 unless given.
    #[serde(default)] pub limit: Option<u32>,
}
```
An unknown filter is `VALIDATION {field: "filter"}`; a cursor of another filter or a foreign one is
`VALIDATION {field: "cursor"}`.

#### 3.2.2 Output

```rust
pub struct PostsOut {
    pub rows: Vec<PostRow>,
    pub next_cursor: Option<String>,
    pub counts: PostCounts,               // over every row, whatever the filter and the page
    pub days: Vec<SpecialDayLine>,        // at most 3
    pub days_more: u32,
    pub composer: ComposerState,          // {allowed, files_allowed, stops, advice, connected: [{kind, name}]}
    pub knowledge_empty: bool,
    /// The organic brake: `Some` while posting is stopped (`studio_control().read_control()`), with
    /// the control revision `studio.brake` needs and whether this caller may release it.
    pub brake: Option<BrakeState>,        // {revision, can_resume}
    #[serde(with = "rfc3339")] pub as_of: OffsetDateTime,
}
pub struct PostCounts { pub all: u32, pub you: u32, pub stages: BTreeMap<StageKey, u32> }

pub struct PostRow {
    /// `slot:{uuid}` | `version:{uuid}` | `content:{uuid}` | `need:{uuid}`.
    pub id: String,
    pub kind: RowKind,                    // post | version | content | need
    pub area_id: Option<Uuid>,
    pub version_id: Option<Uuid>,
    pub slot_id: Option<SlotId>,
    pub shoot_request_id: Option<ShootRequestId>,
    /// At most 80 characters: the first non-empty line of the caption (`schedule::caption`,
    /// `accounts::first_line`, moved to `content::posts::first_line`); before delivery the area's
    /// title; for a need, its sentence.
    pub title: String,
    pub cover: Option<Cover>,
    pub channel: Option<ChannelRef>,      // None while no account is chosen
    pub format: Option<PostFormat>,
    pub media: Option<MediaSummary>,      // {images: u8, video_seconds: Option<u32>}
    pub category: Category,               // {olay_id: Option<OlayId>, title: String} ("Genel")
    pub publish_at: Option<OffsetDateTime>,
    pub published_at: Option<OffsetDateTime>,
    pub url: Option<String>,
    pub status: RowStatus,                // failed | tiktok_draft | waiting_you | paused | revising | preparing | scheduling | scheduled | published
    pub sub_state: Option<SubState>,      // §2.4: claimed{stage} | queued{wakes_now, next_at, late} | starts{at} | files_analysing
    pub progress: Progress,               // {index: u8 0..=7, state: StageState}
    pub waits: Vec<Wait>,                 // §2.6, first is the one shown
    pub actions: RowActions,              // only what this caller may do now
    pub ai_illustration: bool,
    pub siblings: Vec<Sibling>,           // other rows of the same area: {row_id, channel, publish_at, status}
}
pub struct Cover {
    pub material_id: MaterialId, pub mime: String,
    /// Short-lived signed URL; only for a caller holding `materials.work` (else None: the panel
    /// shows the format icon).
    pub preview_url: Option<String>, pub preview_expires_at: Option<OffsetDateTime>,
    pub ai_generated: bool,
}
pub struct ChannelRef {
    pub capability_id: CapabilityId, pub kind: String, pub name: String,
    /// `{Platform}`, or `{Platform} · {name}` when two connected accounts share the platform.
    pub label: String,
}
pub struct Wait {
    pub code: WaitCode,                   // the codes of §2.6
    #[serde(with = "rfc3339")] pub since: OffsetDateTime,
    /// What the sentence needs: account name, platform kind, request text, finding code, error.
    pub facts: serde_json::Value,
}
pub struct RowActions {
    pub approve: Option<SlotRef>,             // {slot_id, expected_revision}
    pub tiktok: Option<SlotRef>,
    pub redo: Option<RedoRef>,                // {project_id, package_revision: Option<u32>}
    pub cancel: Option<CancelRef>,            // post{slot_id, expected_revision} | version{project_id, version_id, package_revision} | content{project_id, expected_revision}
    pub pick_time: Option<PickRef>,           // {project_id, version_id, accounts: Vec<CapabilityId>}
    pub release_check: Option<SlotRef>,
    pub accept_held: Option<AreaRef>,         // {project_id, expected_revision}
    pub permit_files: Vec<MaterialRef>,       // {material_id, expected_revision}
    pub add_files: Option<FilesTarget>,       // capture{project_id, request_id} | need{shoot_request_id} | special_day{key, year}
    pub dismiss: Option<DismissRef>,          // capture request or need
    pub resume_account: Option<AccountRef>,   // {capability_id, expected_revision}
    pub reconnect: Option<CapabilityId>,      // failed on auth/permission, or account_unavailable
    pub acknowledge: Option<SlotRef>,         // `Bırak` on a failed post, `Tamamladım` on a TikTok draft
    pub connect: bool,                        // no_account, no_account_for_platform
}
```

#### 3.2.3 Actions and the revisions they carry

| Action | Given when | Revision it carries | Permission and role checked by the read (as the write will) |
|---|---|---|---|
| `approve` | a ready, never-attempted post waits for a plain approval | slot `revision` | `social.manage` or `ads.manage`, owner or manager, a person (`studio.approve`) |
| `tiktok` | a TikTok post waits for its posting screen | slot `revision` | `social.manage`, owner or manager, a person |
| `redo` | the row belongs to an area (not archived) | `PackageSummary.revision`, `None` before any package | `content.manage`, a person |
| `cancel` post | planned or ready, never sent | slot `revision` | person: `social.manage` or `content.manage` (D13) |
| `cancel` version | a version of the current package with no slot, not cancelled | package `revision` | `content.manage` or `social.manage` |
| `cancel` content | a `content` row | area `revision` | `content.manage` |
| `pick_time` | a `version` row some account can take | — (`request_key` from the panel) | `social.work` |
| `release_check` | `check_hold` whose findings are caption-only (`materials::hold_next_action` = `release`) | slot `revision` | owner or manager, a person |
| `accept_held` | `delivery_held` and the kept delivery is releasable (`delivery::releasable`, the check `delivery_accept` runs, made pure) | area `revision` | `content.manage`, a person |
| `permit_files` | `files_permission` | each material's `revision` | owner or manager with `materials.work` |
| `add_files` | `capture` or `need_photo` | — | owner or manager with `materials.work` |
| `resume_account` | `account_paused` | capability `revision` | `social.manage` |
| `reconnect` | `failed` on `auth`/`permission` while the account cannot post, `account_unavailable` | — | `capabilities.manage` (the connect page's own rule) |
| `acknowledge` | `failed` of a content, `tiktok_draft` with its wait | slot `revision` | person: `content.manage` or `social.manage` |
| `connect` | `no_account`, `no_account_for_platform` | — | `capabilities.manage` |

#### 3.2.4 How the rows are built

One tenant bundle, **read only** (no `FOR UPDATE`: neither `ready::Reader::load` nor `work::gated` is
called), in this order; every read is one query or one batch:

1. `knowledge().settings()` (for `knowledge_empty`, the effective post gate and the closing
   topics, D1), `strategy().current_approved()` (the frame, or none) and
   `studio_control().read_control()` (the brake; no lock).
2. `studio_projects().list_live_areas()` (**new**, every area not archived, whole documents, no cap,
   replacing the open scope's 200 limit for this read; A3.40, A4.19).
3. `PostReads::load` over every slot named by those areas' posts (`AreaPost`) and over the
   **no-content slots** (step 4): one read per kind, as today (A4 fact).
4. No-content posts: `studio_posts().list_posts()` whose package request key is not
   `project:<area>:version:<v>` (`schedule::area_key` is `None`), plus organic slots of the last 180
   days with no planned post (`studio().list_slots` over the window, lane organic), with their pieces
   through **new** `studio().get_pieces(&[SlotId])` (A4.4).
5. `VersionAccounts::load` once (`social::schedule`), and for each unscheduled version
   `VersionAccounts::of`, with its material reads batched through **new**
   `studio_materials().get_materials(&[MaterialId])` (removes the per-material N+1 of `time_waits`;
   A4.7).
6. `studio_materials().list_olays()` once (category titles), `list_shoot_requests()` once (needs),
   the calendar rows once (special days, §3.2.5).
7. Material check holds: `materials::publish_check` only for ready, never-attempted slots of the
   rows (few; the same call `studio.pending` makes).
8. Covers: the first material of each row; preview URLs signed in memory
   (`files().preview_url` per material, no I/O) only when the caller holds `materials.work`.
9. Agents: `wake::takers(repos)` (**new**, pure over `agents_in` and `Offered`): which needs some
   active key can take (`content`, `social`, `materials`) and whether one of them has a usable
   address — for `no_agent`, `pick_time`, `sub_state.queued` and the composer stops.

Per area (from the same rules as `pipeline::project` and `marks`):

- **No finished current package** (`done_at()` is `None`) → one `content` row. Status `revising` when
  a redo stands, else `waiting_you` when it has a wait, else `preparing`. Waits, in this order:
  `delivery_held` (area `Held`); `capture` (an open capture request; one wait per request, the first
  shown); `files_permission` / `files_quality` (§3.4.4: a file in the area's `pending_files` — a
  composer upload or a capture answer — whose analysis found something, failed, was not checked for
  people, or that no materials agent can analyse); `knowledge_empty` (§4.5.1); `no_agent` (queued
  and no key can take `content`). Progress per §2.5.
- **Finished current package** → for each version: when its `slot_id` is set and the slot is
  stored, a `post` row; when it has no slot and is not cancelled, a `version` row; a cancelled one,
  no row. Posts of earlier packages that went out stay as `post` rows (they are published history,
  design 2026-11-18 O11).
- `version` row: `VersionAccounts::of` gives choices and `blocked`. No choice → `waiting_you` with
  the wait of `blocked`:

| `blocked` (social.versions_waiting code) | Wait |
|---|---|
| `material_removed` | `material_removed` |
| `knowledge_empty` (was `no_approved_strategy`) | `knowledge_empty` |
| `no_connected_account` | `no_account` |
| `its_account_unavailable` | `account_unavailable` (the version's own account) |
| `account_paused` | `account_paused` |
| `braked` (new, first in order: the organic brake is on) | none: status `paused` |
| `format_not_supported` with no connected account of a platform that takes the version's format | `no_account_for_platform` (the platform of that format) |
| `format_not_supported` otherwise, `media_not_accepted` | `media` |
| `hypothesis_does_not_post` | none: it cannot arise under a normalised frame; a frame whose live topic lacks a usable organic cadence is normalised by the next `knowledge_settle` tick (§4.10.6), after which the version is offered; the row reads `scheduling` meanwhile |
| `channel_not_in_strategy` | removed (K6) |

  Choices exist → `scheduling`, or `waiting_you` with `pick_time` when no key can take `social`.
- `post` row (version's, or of no content): a TikTok post sent to drafts → `tiktok_draft` (with its
  wait until acknowledged or 7 days old, then `published`); `published` when `published_at` is set;
  `failed` with the `failed` wait (only for an area's post that is not acknowledged and whose area
  has no redo standing: once the owner asked for a redo, the row has no wait; §2.6) when
  `PublicationFact.failed`; else `waiting_you` with `approval` or `posting_screen` when
  `ApprovalFact.waiting` (`posting_screen` decides which), or `check_hold` when `publish_check`
  holds it (`files_permission` when its finding is `sensitive_needs_human` or `share_unset`), or
  `account_paused` / `account_unavailable` when its account is paused or cannot post now
  (`chain::capability_access`); else `paused` while the brake is on; else `scheduled`. A retired
  post that never went out gives no row.
- `need` rows: every open shoot request that is not a `season:` request of a special day already
  shown as a line (§3.2.5) and not an area's own capture; a need with files in its `pending_files`
  carries their `files_permission` / `files_quality` wait, or the sub-state `files_analysing`.

The approval facts use the **effective post gate** (§3.10.1), not the stored flag alone.

#### 3.2.5 `days`, `composer`, `knowledge_empty`

- `days`: the tree's `UpcomingDay` logic (`content/views.rs:784`, extracted as `views::upcoming`), kept to days whose `prepares_from` ≤
  today + 14 days and whose window has not ended, and which have no confirmed olay of the occasion
  and season year holding a usable material (`check_use` passes). Each line carries `{key, year,
  name, window_start, window_end, prepares_from, phase, shoot_request_id, can_add, can_skip}`;
  sorted by `prepares_from`; three returned, the rest counted in `days_more`.
- `composer`: `{allowed, files_allowed, stops, advice, connected}`; `allowed` = content module
  installed and the caller holds `content.manage` and is a person; `stops` are the codes of §2.8
  computed now: `knowledge_empty`, `braked`, `no_account` (no postable social account:
  `schedule::postable`), `no_content_agent`, `agent_sleeps` (a key takes `content` but none has a
  usable address; carries the next expected check-in), `agent_late` (that check-in already passed);
  `advice` is `approval` (switch on), `posting_screen` (a TikTok account is connected),
  `video_only` (every postable account takes only video); `connected` the postable accounts'
  `{kind, name}` for the client-side platform check of §2.8.
- `days[].files`: `{state: none | analysing | needs_permission | unchecked | quality, material_ids,
  found: [face | name | child | logo | company]}` from the day's olay materials carrying
  `upload_for.day` (§3.7.1).
- `knowledge_empty`: §4.5.1's definition.

#### 3.2.6 Order, paging, counts

Every row of the workspace is built (bounded by: areas not archived, posts of the last 180 days,
open needs; tens of areas today, so the build is cheap; §8.1 has the budget test), then:

- **Order** (every filter): group 1 rows with a wait, oldest `since` first; group 2 `failed`, newest
  first, only for seven days after the failure (older ones fall to group 5); group 3 `scheduling`,
  `scheduled` and `paused`, `publish_at` ascending (none last); group 4 `preparing` and `revising`, newest
  area first; group 5 `published` (and old `failed`), `published_at` descending.
- **Filter**: `you` = groups 1 and the `failed` rows of group 2 that have a wait; a stage key = rows
  whose `progress.index` is that stage (a fully done row is `sonuc`).
- **Counts**: `all`, `you`, and per stage, over every row.
- **Cursor**: base64url of `{f: filter, g: group, t: sort time, id: row id}`; the page is the rows
  after it in the order above. A row that moved between pages may repeat or be skipped once; the
  counts are always whole.

### 3.3 `content.post_get`

`GET /api/content/posts/{row_id}` answers one row even when no list holds it (an archived area's,
a retired post: then `status` reads as it was and `actions` is empty, so the panel can say
`Bu paylaşım artık listede değil.`). `row_id` may also be `version:{uuid}` alone (the area is found by
**new** `studio_projects().find_area_by_version`) or `content:{uuid}` (resolved per §2.11).

```rust
pub struct PostDetail {
    pub row: PostRow,
    pub text: String,                     // whole caption; before delivery, the area's brief
    pub materials: Vec<Cover>,            // every material it shows, in order
    pub redo_note: Option<String>,        // while revising
    pub cancelled: Option<CancelFact>,    // {by_name, at, reason} for a cancelled post
}
```
`NOT_FOUND` for an id of another workspace or none.

### 3.4 `content.post_request`: the composer write

#### 3.4.1 Contract

```rust
#[derive(Deserialize)] #[serde(deny_unknown_fields)]
pub struct PostRequestInput {
    pub request_key: String,          // 1..=128, replays answer the same row (spec 2026-11-03 D40 pattern)
    pub text: String,                 // trimmed, 1..=2000 characters (MAX_GOAL_CHARS)
    #[serde(default)] pub file_ids: Vec<FileId>,   // 0..=10, distinct, uploaded with studio.file_upload
}
pub struct PostRequestOut { pub row: PostRow, pub stops: Vec<Stop> }
```
Refusals: `FORBIDDEN human_required` (not a person in person: agents never use it), `FORBIDDEN`
naming `content.manage` / `materials.work`, `VALIDATION` naming `text` or `file_ids`
(`too_many`, `duplicate`), `NOT_FOUND {field: "file_ids", index}` (no such live file of the
workspace), `VALIDATION file_not_media` (a file that is not an image or MP4, e.g. a PDF meant for the
knowledge base), `CONFLICT duplicate_material_file {index, material_id}` when the bytes are a
material that was refused, deleted or erased (spec 2026-11-03 D36/D37 unchanged); bytes that are a **live**
material already are used as that material (no error, no second material).

#### 3.4.2 What it does, in one transaction

1. `library::open(ContentManage)`, `lock_control`, replay by `request_key`
   (`studio.post_request` receipt).
2. For each file: a material (`material_add` internals, as the person): `binding = genel`,
   `freed` by the person (spec 2026-11-03 D8: a person frees a real genel material; the composer upload is that
   decision), `origin = real`, `share = None`, `tags.quality = publishable` (the owner chose it to
   post), and the new document field `upload_for: {area_id, by, at}` (tolerant read: absent on every
   other material; §3.4.4).
3. The area: `project_create` internals with `brief = text`, `title = goal_title(text)`,
   `start_at = now`, `hints = {formats: [], capability_ids: []}` (no platform: P3), `olay_id = None`
   (Genel), `sources` = the materials, `requested_by = person`, and the new document field
   `pending_files` = the materials whose share is unset (all of them here).
4. Ledger `content.post_requested {area_id, files: n}` (no text: the brief is in the area).
5. Wake: `pending_files` empty → `CONTENT` with `ContentRequested` (as `project_create` does);
   else `MATERIALS` with `MaterialUploaded` (the files go to analysis first, §3.4.4).
6. Answer the new `content` row and `stops` (§3.2.5) computed in the same bundle.

#### 3.4.3 Why files are genel and not unfiled

An unfiled material cannot be a source (`material_unfiled`, design 2026-11-18 O5) and analysis may
not file a real material genel (O7), so the owner's photos would wait for a person to file them — a
dead end found late (R1). The owner attaching files to "Ne paylaşalım?" is the in-person decision
both rules wait for: they are about this post, with no event of their own. A material that belongs
to an olay can still be moved there in Dosyalar (`studio.material_bind`).

#### 3.4.4 The share permission of a person's upload: by rule, unless analysis finds a person or a mark

Decision (asked by P3, and the same for every way a person attaches a file to work: the composer, a
capture answer, a need answer, a special day): **the person's upload implies the share decision,
except when analysis finds a face, a child, a name, a client logo or a corporate reference, or names a
person, or did not look for them.**

- Each such material carries `upload_for: {area_id?, shoot_request_id?, day?: {key, year}, by, at}`
  (tolerant read; absent on every other material) and sits in a **pending list**: the area's
  `pending_files` (composer, capture), the need's `pending_files` (a tolerant field of the shoot
  request's document), or, for a day, the files of the day's olay that carry `upload_for.day`. At
  upload the share stays unset (nothing is shareable before anyone looked at it).
- When `studio.material_analysis_complete` finishes such a material with `share = None`: if the
  analysis was made with `sensitive_checked: true` (§5.1), leaves `tags.depicts` and `people` empty
  and keeps quality `publishable`, the share is set **by rule**: `{permission: shareable, by: None,
  at, rule: "person_upload"}` (`ShareDecision.rule`, new, `#[serde(default)]`), ledger
  `studio.material.shared_by_rule {material_id, rule: "person_upload", uploaded_by}` (the pattern of
  O7's `confirmed_by_rule`). `by` stays `None` on purpose: `needs_human_permission()` keeps meaning
  "a person must look", so a face, a child or a name that a later analysis (a retry, an agent's
  `material_intelligence_update`) adds makes the publish gate refuse `sensitive_needs_human` again,
  and the row shows `files_permission` with `İzin ver` (§3.2.4). Otherwise the share stays unset: the
  `files_permission` wait names what was found, or `files_quality` when quality is not publishable.
- When the analysis fails, was made without `sensitive_checked` (a routine not yet moved, §5.6), or
  no key can take `materials` (no analysis will come): `files_permission` with
  `Dosyalarının paylaşılabilir olduğunu onayla.` at once (R1).
- The owner's `İzin ver` is `studio.material_permission` (the person's decision, `share.by` = the
  person, which a face or a child needs anyway).
- Each time a material of a pending list gets its share (by rule or by a person), leaves the sources
  (`Bu dosya olmadan devam et`) or is deleted (§3.10.4), it leaves the list, in the same
  transaction as that write. An area's list becoming empty wakes its agent: `CONTENT` with
  `ContentRequested` (composer) or `CaptureAnswered` (capture), on behalf of `requested_by` or the
  uploader (`request_for`), or in person when a person's own action emptied it. A need's first
  shared file resolves the request `done` with it (`shoot_resolve` internals, on behalf of the
  uploader). A day's first shared file runs the day's calendar trigger when its preparation has
  started (§3.7.1).
- `ProductionProject::needs_agent` is false while the area's `pending_files` is not empty, so no
  agent starts (or resumes after a capture) without the owner's photos and then fails its delivery
  on `share_unset`.

Why: faces, children, names and client marks are exactly what the share rule protects (spec
2026-11-03 D5, D17, D38; R3 keeps "consent and permission rules for people in photos"); everything
else the owner uploaded for a post is plainly meant to be posted, and asking again would be the
"waiting on a click" the owner hates.

#### 3.4.5 What the agent sees

The area is an ordinary `content_area` work item (hints empty: "you choose"). `CONTENT_AREA_HINT`
(§5.2) says: the brief is the owner's own words; a platform named in it ("sadece TikTok") is the
owner's choice: deliver only versions for it and set `capability_id`; otherwise choose among every
connected account; leave `hypothesis_id` out (the post is the owner's request, §3.5). The area is
offered only once its `pending_files` is empty (§3.4.4).

### 3.5 The owner's request: on any connected account, measured on its own

`owner_request::names(p, account)` becomes:

```rust
p.requested_by.is_some()
    && (p.hints.capability_ids.contains(&account.id)
        || (p.hints.capability_ids.is_empty()
            && (p.hints.formats.is_empty()
                || p.hints.formats.iter().any(|f| only_kind(*f) == Some(account.kind_key.as_str())))))
```

A content a person asked for in person with no account and no format named is the owner's request
on **every** connected postable account (P3); naming a format still narrows it to the platforms that
take it. The version's own `capability_id` (the agent's reading of "sadece TikTok") still limits the
choices in `VersionAccounts::of`.

Attribution (design 2026-11-19 F2 kept: a person's posts are measured on their own arms, never mixed
into a topic):

- `content.area_deliver` on an area with `requested_by` set: `hypothesis_id` is optional; left out,
  the server stores the owner's-request id on the version. `held_versions` checks only an id the
  agent named (a hypothesis of the frame; the owner's request named by an agent is still refused
  `hypothesis_reserved`). On an area an agent or the system opened, `hypothesis_id` stays required (a
  topic of the frame), as today.
- `VersionAccounts::pick`: a version whose hypothesis is the owner's request goes out under it
  (`Attribution::OwnerRequest`) on every account `names(p, account)` covers, and on no other;
  `version_schedule` then ensures the hypothesis in the frame (`owner_request::ensure`, as today).
  A version an agent attributed to a topic keeps F1's order (its topic, then the segment, then any
  topic, then the owner's request when `names` holds).

### 3.6 Wakes

- **New** `wake::request_for(repos, ctx, needs, reason, person: UserId)`: as `request`, for an
  action the system or an agent takes **because a person asked** (the person is recorded in
  `caused_by`). Used by: a person's upload becoming usable (§3.4.4), a delivery of a person-requested
  content (below), a filed note, a frame applied after a person's knowledge change (§4.10.8), and a
  connection completed for a person.
- `content.area_deliver`, when the delivery is accepted and `requested_by` is set: `SOCIAL` with the
  new reason `ContentDelivered` ("A content a person asked for is ready for its time."), on behalf of
  `requested_by` (P3). Agent-made and system-made contents still wake nobody.
- Connecting or reconnecting a social account (`connector.complete_oauth`, `confirm_assets`,
  `capabilities.verify`) that makes it postable while an unsent version waits for an account, or a
  failed post's cause was that account: `SOCIAL` with `AccountConnected` (R2: the owner fixed the
  cause; the post must not wait for the agent's schedule). Releasing the organic brake: `SOCIAL`
  with `PostingResumed`.
- `content.files_add` and `content.post_request` with files: `MATERIALS` with `MaterialUploaded`.
- Every site is in §5.3's table; the module docs of `wake.rs` list them;
  `jt_archtest/tests/wake_triggers.rs` gets one row per site (§8.4).

### 3.7 The four small writes

#### 3.7.1 `content.files_add`

```rust
#[derive(Deserialize)] #[serde(deny_unknown_fields)]
pub struct FilesAddInput {
    pub request_key: String,
    pub target: FilesTarget,   // special_day{key, year} | need{shoot_request_id} | capture{project_id, request_id}
    pub file_ids: Vec<FileId>, // 1..=10
}
```
One transaction, owner or manager in person with `materials.work`; files are checked as in §3.4.1.
- `special_day`: the effective calendar entry of `{key, year}` (`NOT_FOUND` otherwise); its
  confirmed olay of that occasion and season year, or a new one created **confirmed** by the person
  (`olay_create` internals: kind from the entry, `title = entry.name`, `starts_on`/`ends_on` = the
  window, `occasion = key`); the materials bound to it with `upload_for.day`, share by the person-upload
  rule (§3.4.4), quality `publishable`; the open `season:{key}:{year}` request stays open until a file
  of the day is shareable, and is then resolved `done` with it. When a file of the day gets its share
  (by rule in `material_analysis_complete`, or by the owner's `İzin ver` in
  `studio.material_permission`) and the day's preparation has started, the calendar trigger runs for
  that olay in the same transaction (`planner::Triggers::calendar_for`, made callable from those use
  cases; the planner's own tick is unchanged) and `CONTENT` is woken on behalf of the uploader, or in
  person, so the owner does not wait for the planner's next tick (R2, R3).
- `need`: the request (open, of the workspace); materials genel, freed by the person, with
  `upload_for.shoot_request_id`, into the request's `pending_files`; the request stays open until one
  of them is shareable and is then resolved `done` with it (`shoot_resolve` internals). Until then the
  `need` row shows the files' state (§3.2.4).
- `capture`: the area's open capture request; materials bound to the area's olay, or genel freed by
  the person when it has none, with `upload_for.area_id`; added to the area's sources and its
  `pending_files`; the request answered `done` with them (`project_request_update` internals). The
  area goes back to the agent, and `CaptureAnswered` is requested, only when its `pending_files` is
  empty (§3.4.4), not at upload.

Answer: the affected row (or day line). Ledger `content.files_added {target, files}`. The same
transaction requests `MATERIALS` with `MaterialUploaded` (in person).

#### 3.7.2 `content.special_day_skip`

`{key, year}` (path): the effective entry of that year saved with `enabled: false`
(`calendar_set` internals, every other field as the effective entry has it) and its open
`season:{key}:{year}` request dismissed, in one transaction. Ledger `studio.calendar.set` as today
plus `content.special_day.skipped`.

#### 3.7.3 `content.version_cancel`

`{project_id, version_id, package_revision, reason}`: a person cancels a version that has no planned
post yet. Refusals: `CONFLICT` "the area's package changed" (revision), `CONFLICT version_scheduled`
(it has a slot: use `studio.slot_cancel`), `CONFLICT version_cancelled`. The version is marked
`cancelled` with `VersionCancel { by, at, reason, slot_id: None }` (`slot_id` becomes
`Option<SlotId>` with `#[serde(default)]`; rollback limit §7.6) and the area is archived when nothing
of it is left to go out (`cancel_archives`'s rule, generalised to a version without a slot).

#### 3.7.4 `content.post_dismiss`

`POST /api/content/posts/{slot_id}/dismiss {expected_revision}`: a person with `content.manage` or
`social.manage` acknowledges a failed post of a content (`Bırak`) or a TikTok draft
(`Tamamladım`). The slot document gets `acknowledged: {by, at}` (a tolerant field,
`#[serde(default)]`; `lock_control` and revision + 1, as every slot write). Nothing is sent,
cancelled or redone; the row stops waiting (§2.6). Refusals: `CONFLICT slot_changed` (revision),
`CONFLICT not_acknowledgeable` (neither failed nor a TikTok draft, or already acknowledged),
`FORBIDDEN human_required`. Ledger `content.post.dismissed {slot_id, kind: failed | tiktok_draft}`.

### 3.8 The panel's actions on existing endpoints

| Panel action | Use case | Input | Gate | Permission (after this change) |
|---|---|---|---|---|
| `Onayla` | `studio.approve` | `{target: {slot}, expected_revision}` | Gated (frame) | `social.manage`/`ads.manage`, owner or manager in person |
| `TikTok'ta tamamla` | `studio.tiktok_posting` (GET), `studio.tiktok_post` | `{slot_id, expected_revision, post}` | Gated | `social.manage`, owner or manager |
| `Düzenleme iste`, `Tekrar hazırlat` | `content.area_redo` | `{project_id, package_revision, note}` | Exempt | `content.manage`, person |
| `İptal` (post) | `studio.slot_cancel` | `{slot_id, expected_revision, reason}` | Gated | person: `social.manage` or `content.manage` (D13) |
| `İptal` (version) | `content.version_cancel` | §3.7.3 | Exempt | `content.manage` or `social.manage` |
| `İptal` (content) / `Geri al` | `studio.project_update` | `{project_id, expected_revision, archived}` | Exempt | `content.manage` |
| `Zaman seç` | `social.version_schedule` | `{project_id, version_id, capability_id, publish_at, request_key}` | Gated | `social.work` |
| `Yine de kabul et` | `content.delivery_accept` | `{project_id, expected_revision}` | Gated | `content.manage`, person |
| `Yine de paylaş` | `studio.material_check_release` | its input | Gated | as today |
| `İzin ver` | `studio.material_permission` | `{material_id, expected_revision, permission: shareable}` | Exempt | owner or manager with `materials.work` |
| `Yine de kullan` | `studio.material_intelligence_update` | quality `publishable` | Exempt | as today |
| `Bu dosya olmadan devam et` | `studio.project_materials` | `{project_id, expected_revision, remove: [m]}` | Exempt | `content.work`/`content.manage` |
| `Dosya ekle`, `Fotoğraf ekle` | `content.files_add` | §3.7.1 | Exempt | §3.1 |
| `Gerek yok` (capture) | `studio.project_request_update` | `{status: dismissed}` | Exempt | as today |
| `Gerek yok` (need) | `studio.shoot_resolve` | `{request_id, status: dismissed}` | Exempt | as today |
| `Sürdür` (account) | `social.account_pause` | `{capability_id, paused: false, expected_revision}` | Exempt | `social.manage` |
| `Sürdür` (all posting) | `studio.brake` | `{lane: organic, engaged: false, expected_revision}` | Exempt | `social.manage` (its existing permission list) |
| `Bırak`, `Tamamladım` | `content.post_dismiss` | §3.7.4 | Exempt | `content.manage` or `social.manage`, person |
| `Yeniden bağla`, `Hesap bağla` | the connect page (`/connect?capability=`, `/connect`) | — | — | `capabilities.manage` |
| `Bu yıl geç` / `Geri al` | `content.special_day_skip` / `studio.calendar_set` | §3.7.2 | Exempt | owner or manager |

Every one of them invalidates the `['posts']` query key (and `['knowledge']` for nothing here),
replacing the per-page invalidations of `PostRow.usePostMutation` and the content page.

### 3.9 New port and repo methods

| Port | Method | Notes |
|---|---|---|
| `ProductionProjects` | `list_live_areas()` | every area with `archived = false`, documents; pg: one select on `studio_production_projects` by workspace and `archived` (index exists with 0044's `olay_id` index; add `(workspace_id, archived, updated_at)` in 0046 if the plan needs it) |
| `ProductionProjects` | `find_area_by_version(version_id)` | jsonb path query over the packages' versions |
| `StudioRepo` | `get_pieces(&[SlotId])` | batch of `get_piece` |
| `StudioMaterials` | `get_materials(&[MaterialId])` | batch of `get_material` |
| `ResearchTasks` | `carry(id, version_id, rubric_digest, daily_cap)` | K5, §4.10.7 |
| `KnowledgeRepo` | §4.2 | new port, `TenantRepos::knowledge()` |

Every in-memory fake in `jt_testkit` gets the same methods with the same constraints (twin parity).

### 3.10 Changes to existing reads and rules

#### 3.10.1 The effective post gate (D1)

One function, `social::approval::post_gate(c: &Capability, k: Option<&KnowledgeSettings>) ->
Option<HumanGate>`: `PostingScreen` for TikTok, else `Approval` when `k.post_approval` (the Kurallar
switch, §4.6.3) or `c.id` is in `k.post_approval_accounts` (§4.6.5), else `None`. Once the
workspace's gate is seeded (`post_gate_seeded_at` set, §4.3.2) it never reads
`c.policy.requires_human_approval`; before that (the minutes between PR 2's deploy and the
workspace's seed) it falls back to the stored flag, so nothing is released early. It replaces the
stored flag in every **posting** path: `schedule::human_gate`, `pipeline::PostReads::facts`
(`required`), `studio::work::pending_in` (slot approvals), `studio::chain::authorize_execution_at` (`capability_requires_human_approval` of the
chain context, so sending waits for the approval), `social::accounts` (`requires_human_approval` and
`human_gate` of `accounts_list` / `account_get`, already true for TikTok since F5). Paid-lane paths
(`studio/ads.rs`, `studio/control.rs` budget moves) and the inbox (`replies.rs` public replies,
`context.rs`) keep reading the stored flag: the switch and the list are about posts only, and the
stored flag keeps its other meanings (comment replies, ad budget moves). An agent's
`capability.set_policy` can therefore no longer lower a post approval (design 2026-11-19 O4).

#### 3.10.2 Stops and blocked codes

- `social::ready` `StopCode`: `no_approved_strategy` → `knowledge_empty` (action `open_knowledge`);
  `channel_not_in_strategy`, `no_hypothesis` and the actions `approve_strategy`,
  `prepare_strategy` are removed (K6: every connected account is used; F3's checklist keeps the
  rest). `approval` uses the effective gate.
- `social::schedule::why_blocked`: `no_approved_strategy` → `knowledge_empty`; a new first step
  `braked` while the organic brake is on (and `VersionAccounts::of` offers no choice then, so the
  social agent schedules nothing into a stopped lane and no freed post loops through F4); the
  `channel_not_in_strategy` step is removed. `hypothesis_does_not_post` stays as the defensive
  fall-through (§3.2.4). `social::ready`'s existing `braked` stop stays (Hesaplar shows it).
- `ready::Reader::load` no longer takes `studio_control ... FOR UPDATE` in reads: a new
  `studio_control().read_control()` without the lock serves reads (`content.areas`, the accounts
  reads, `content.posts`); writes keep `lock_control` (A4.6).

#### 3.10.3 What stays readable for the old pages until they go

`content.tree`, `content.areas`, `content.olay_view`, `content.analysis_queue`, `studio.posts_list`,
`social.versions_waiting`, `social.accounts_list`, `social.account_get` keep their contracts (agents
read some of them; the old pages until PR 5). `content.tree` keeps `waiting.olay_confirmations` for
Dosyalar's count.

#### 3.10.4 Deleting a file a person attached

`studio.material_delete` (owner or manager in person) also, in its transaction, removes the material
from every live area's `sources` and `pending_files` and from every open need's `pending_files`. An
area whose `pending_files` becomes empty by it is offered to its agent again and `CONTENT` is
requested in person (`ContentRequested`, or `CaptureAnswered` for a capture answer); a need whose
list empties with no shared file stays open (`need_photo` again). Until this lands, a deleted file
could keep an area waiting for analysis forever (`needs_agent` false) with the row saying
`Dosyaların inceleniyor`. The `material_removed` wait of `version` rows is unchanged.

## 4. Bilgi bankası

### 4.1 Two layers

| | Knowledge base (owner's) | Frame (internal) |
|---|---|---|
| What | cards, Kurallar, Hedefler, notes, proposals | `strategy_versions` + `strategy_hypotheses` (K1) |
| Edited by | the owner, at once; agents only by filing the owner's notes; proposals the owner accepts | the system only (§4.10), from what agents derive from the cards and from the owner's Kurallar |
| Read by | every agent (`jeeta.strategy.knowledge_get`, `inbox.context`, `studio.slot_get`), the owner | the engine: chain, planner, posting, research, outreach, calls, spend (≈40 call sites, unchanged) |
| History | `knowledge_revisions` (append-only) | versions, append-only (never deleted, never edited after approval) |
| Gate | none | "an approved frame exists" (unchanged) |

An owner edit never creates a frame by itself: a change to a card the frame is derived from bumps
that part's revision and asks the agent to re-derive (§4.10.9); every other edit (voice, Kurallar's
prohibitions, Hedefler, references) is read live by every agent and changes no frame. Only the
Kurallar caps (the ad budget and the paid-message limit), which the engine enforces, are mirrored
into a new frame at once (§4.6), and the first card text of a brand-new workspace bootstraps one
(§4.10.5).

### 4.2 Data model: migration `0046_knowledge_base`

Additive, guarded (`if not exists`), RLS forced with a `<table>_ws` policy exactly as 0045; no
foreign key to or from `strategy_*` (no cycle for the restore drill); no `studio_` prefix (the exact
studio table sets stay).

```sql
-- One row per workspace: the knowledge base's revisions, its rules and goals, the caps and the
-- post approval the system enforces, and what the frame was last derived from.
create table if not exists knowledge_settings (
    workspace_id uuid primary key references workspaces (id) on delete cascade,
    revision bigint not null default 0 check (revision >= 0),          -- +1 on every knowledge change
    changed_at timestamptz,
    changed_by uuid,                                                     -- the person whose change it was
    posting_revision bigint not null default 0,                          -- revision of the last posting-card change (§4.4)
    prospecting_revision bigint not null default 0,                      -- revision of the last prospecting-card change
    posting_derived bigint not null default 0,                           -- revision the posting part was last derived from
    prospecting_derived bigint not null default 0,                       -- revision the prospecting part was last derived from
    prohibitions jsonb not null default '[]'
        check (jsonb_typeof(prohibitions) = 'array' and jsonb_array_length(prohibitions) <= 100),
    goals jsonb not null default '[]'
        check (jsonb_typeof(goals) = 'array' and jsonb_array_length(goals) <= 20),
    -- {amount_minor, period: weekly|monthly, currency}; null: no ads (Kurallar "Reklam yok").
    ad_cap jsonb check (ad_cap is null or jsonb_typeof(ad_cap) = 'object'),
    -- {amount_minor, period, currency}: paid messages (SMS, metered sends); null: no limit of its own.
    message_cap jsonb check (message_cap is null or jsonb_typeof(message_cap) = 'object'),
    post_approval boolean not null default false,                        -- "Her paylaşım onayıma gelsin"
    post_approval_accounts jsonb not null default '[]'                   -- capability ids whose posts wait
        check (jsonb_typeof(post_approval_accounts) = 'array' and jsonb_array_length(post_approval_accounts) <= 200),
    post_gate_seeded_at timestamptz,                                     -- the accounts' flags were copied (§4.3.2)
    closing_topic_ids jsonb not null default '[]'                        -- topics left out, kept for their posts (§4.10.2)
        check (jsonb_typeof(closing_topic_ids) = 'array' and jsonb_array_length(closing_topic_ids) <= 200),
    rules_revision bigint not null default 1 check (rules_revision > 0),
    goals_revision bigint not null default 1 check (goals_revision > 0),
    frame_applied_at timestamptz,
    seeded_at timestamptz not null,
    seed_source text not null check (seed_source in ('approved', 'draft', 'empty'))
);

create table if not exists knowledge_cards (
    workspace_id uuid not null references workspaces (id) on delete cascade,
    id uuid not null,
    key text check (key is null or key ~ '^[a-z][a-z0-9_]{1,39}$'),     -- seed cards; null for the owner's own
    title text not null check (char_length(title) between 1 and 80),
    body text not null default '' check (char_length(body) <= 8000),
    attachments jsonb not null default '[]'
        check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 10),
    position integer not null check (position >= 0),
    revision bigint not null check (revision > 0),
    created_at timestamptz not null,
    created_by_user uuid, created_by_connection uuid, created_by_component text,
    updated_at timestamptz not null,
    updated_by_user uuid, updated_by_connection uuid, updated_by_component text,
    archived_at timestamptz,
    primary key (workspace_id, id)
);
create unique index if not exists knowledge_cards_one_key
    on knowledge_cards (workspace_id, key) where key is not null;
create index if not exists knowledge_cards_list
    on knowledge_cards (workspace_id, archived_at, position);

-- Every change of a card, of the rules and of the goals, as it was. Append-only.
create table if not exists knowledge_revisions (
    workspace_id uuid not null references workspaces (id) on delete cascade,
    id uuid not null,
    subject text not null check (subject in ('card', 'rules', 'goals')),
    card_id uuid,
    revision bigint not null check (revision > 0),
    kb_revision bigint not null check (kb_revision >= 0),
    content jsonb not null check (jsonb_typeof(content) = 'object'),
    cause text not null check (cause in ('seed', 'backfill', 'resync', 'owner', 'proposal', 'note', 'system')),
    source_id uuid,                                                      -- the proposal or note
    at timestamptz not null,
    by_user uuid, by_connection uuid, by_component text,
    primary key (workspace_id, id),
    constraint knowledge_revisions_subject_rule check ((subject = 'card') = (card_id is not null)),
    constraint knowledge_revisions_card_fkey foreign key (workspace_id, card_id)
        references knowledge_cards (workspace_id, id)
);
create unique index if not exists knowledge_revisions_one
    on knowledge_revisions (workspace_id, subject,
        coalesce(card_id, '00000000-0000-0000-0000-000000000000'::uuid), revision);
create index if not exists knowledge_revisions_at on knowledge_revisions (workspace_id, at desc);
create or replace function knowledge_revisions_immutable() returns trigger language plpgsql as $$
begin raise exception 'knowledge_revisions is append-only'; end; $$;
create or replace trigger knowledge_revisions_append_only before update or delete
    on knowledge_revisions for each row execute function knowledge_revisions_immutable();

-- "Ajanlara bir şey anlat": what a person told the agents, until an agent files it.
create table if not exists knowledge_notes (
    workspace_id uuid not null references workspaces (id) on delete cascade,
    id uuid not null,
    text text not null check (char_length(text) between 1 and 4000),
    links jsonb not null default '[]' check (jsonb_typeof(links) = 'array' and jsonb_array_length(links) <= 10),
    file_ids jsonb not null default '[]' check (jsonb_typeof(file_ids) = 'array' and jsonb_array_length(file_ids) <= 10),
    status text not null check (status in ('open', 'filed', 'dismissed', 'withdrawn')),
    claim jsonb check (claim is null or jsonb_typeof(claim) = 'object'),   -- {connection_id, token_hash, until}
    revision bigint not null check (revision > 0),
    created_at timestamptz not null,
    created_by_user uuid not null,
    closed_at timestamptz,
    closed_by_user uuid, closed_by_connection uuid,
    -- filed: {cards: [{card_id, revision}], rules: [line], goals: [line], post_request: {area_id} | null,
    --         proposals: [proposal_id], summary}; dismissed: {dismissed: reason}
    outcome jsonb check (outcome is null or jsonb_typeof(outcome) = 'object'),
    primary key (workspace_id, id),
    constraint knowledge_notes_closed_rule check ((closed_at is null) = (status = 'open'))
);
create index if not exists knowledge_notes_list on knowledge_notes (workspace_id, status, created_at desc);

-- "Ajanın önerileri".
create table if not exists knowledge_proposals (
    workspace_id uuid not null references workspaces (id) on delete cascade,
    id uuid not null,
    kind text not null check (kind in ('card_new', 'card_edit', 'rule_add', 'goal_add')),
    card_id uuid,
    title text check (title is null or char_length(title) between 1 and 80),
    body text not null check (char_length(body) between 1 and 8000),
    reason text not null check (char_length(reason) between 1 and 300),
    status text not null check (status in ('pending', 'accepted', 'skipped', 'expired', 'superseded')),
    base_revision bigint,                                                -- card_edit: the card revision it was written against
    proposed_at timestamptz not null,
    -- an agent, or the system: 'knowledge_backfill' (seeding), 'strategy_resync' (an old approval, §4.3.4)
    proposed_by_connection uuid, proposed_by_component text,
    expires_at timestamptz not null,
    decided_at timestamptz, decided_by_user uuid,
    applied_revision bigint,
    primary key (workspace_id, id),
    constraint knowledge_proposals_card_rule check ((kind = 'card_edit') = (card_id is not null)),
    constraint knowledge_proposals_card_fkey foreign key (workspace_id, card_id)
        references knowledge_cards (workspace_id, id),
    constraint knowledge_proposals_decided_rule check ((decided_at is null) = (status = 'pending'))
);
create unique index if not exists knowledge_proposals_one_pending on knowledge_proposals
    (workspace_id, kind, coalesce(card_id, '00000000-0000-0000-0000-000000000000'::uuid), md5(body))
    where status = 'pending';
create index if not exists knowledge_proposals_list on knowledge_proposals (workspace_id, status, proposed_at desc);

-- Read-model support for `content.posts` (§3.9).
create index if not exists studio_production_projects_live
    on studio_production_projects (workspace_id, archived, updated_at desc);

-- RLS: for each of the five tables, as 0045:
--   alter table … enable row level security; alter table … force row level security;
--   create policy <table>_ws … using/with check (workspace_id = app.workspace_id or app.platform = 'on').
```

Limits enforced in the domain crate as well (strict write parse, tolerant read, as `jt_strategy`):
title 1–80, body ≤ 8000, ≤ 10 attachments, ≤ 50 live cards, prohibitions ≤ 100 × ≤ 500 characters,
goals ≤ 20 × ≤ 300, note text ≤ 4000, ≤ 10 links (`https://` only, ≤ 2048), ≤ 10 files,
proposal reason ≤ 300, ≤ 20 pending proposals per workspace and ≤ 10 proposals per agent connection
per day (system proposals, `knowledge_backfill` and `strategy_resync`, count toward neither), a cap's
`amount_minor` 0..=10^12 with period `weekly` or `monthly` and an ISO currency. An attachment is
`{"kind": "link", "url", "title"?}` or `{"kind": "file", "file_id", "name", "mime"}`; a file is a live
studio file of the workspace, image, MP4 or **PDF** (D17: `files.rs` `limit` gains `application/pdf`,
20 MB, magic `%PDF-`; `material_add` refuses it with `VALIDATION file_not_media`).

**Down** (`0046_knowledge_base.down.sql`, idempotent): drops the five tables, the trigger function
and the index. It refuses (`raise exception`) while a production area holds a version cancelled
without a slot (`VersionCancel.slot_id` absent, §3.7.3), which a binary older than PR 1 cannot read;
the guard runs under `set_config('app.platform', 'on', true)` (restored after, as 0009's down and
0039 do), since the areas table forces RLS and would otherwise show no row. The down is only for
undoing PR 1 before PR 2 is deployed: it is **never** a step of a binary rollback after that (§7.6),
because it deletes the owner's knowledge. Knowledge content is lost by it: ops dumps the five tables
first.

New Rust: domain crate `rust/crates/domain/jt_knowledge` (cards, rules, goals, caps, notes,
proposals, limits, the seed mapping from `jt_strategy::Sections`, the frame merge, validation and
structural diff; depends on `jt_strategy`, `jt_tenancy`, `jt_studio` for `PostFormat`); port
`ports/knowledge.rs` (`KnowledgeRepo`: `settings`, `lock_settings`, `insert_settings`,
`save_settings`, `cards`, `card`, `lock_card`, `insert_card`, `save_card`, `append_revision`,
`revisions(subject, card_id, cursor)`, `notes(status, limit)`, `note`, `lock_note`, `insert_note`,
`save_note`, `proposals(status)`, `proposal`, `lock_proposal`, `insert_proposal`, `save_proposal`,
`expire_proposals(now)`); pg repo `jt_pg/src/repos/knowledge.rs`; fake
`jt_testkit/src/fakes/knowledge.rs`; use cases
`jt_app/src/usecases/knowledge/{mod,seed,resync,cards,rules,notes,proposals,frame,read}.rs`; MCP tools
in `jt_mcp/src/tools/strategy.rs` (prefix kept, K7); panel routes
`jt_panel_http/src/routes/knowledge.rs`.

Tolerant reads shipped in PR 1 (so that every later binary can be rolled back to PR 1's): an unknown
`WakeReason` code in `agent_wakes` (`pending.reasons` and `last.reasons`) is dropped on read instead
of failing the row (`ports/wake.rs`: a `#[serde(other)] Unknown` variant filtered out after
decoding); `VersionCancel.slot_id` is read as `Option<SlotId>` (`#[serde(default)]`; written `Some`
until PR 4).

### 4.3 Seeding and backfill

Every workspace gets its knowledge base once, by the application (not by SQL, so the mapping is
tested Rust), from PR 2 on (PR 1 ships the store unreachable): the first knowledge use case of the
workspace, the `knowledge_settle` job's first tick after the deploy (§4.10.6), or an approval through
the old tools (§4.3.4), runs `knowledge::seed::ensure` in its own short write bundle:
`insert into knowledge_settings … on conflict do nothing`; only the bundle that inserted it writes
the cards, so two concurrent seeds make one.

#### 4.3.1 Which source

| Workspace at deploy | Seed from | Then |
|---|---|---|
| approved version, no draft | the approved version (`seed_source = approved`) | nothing else |
| approved version and an open draft | the approved version | for each part the draft changed (identity, audience, goals, prohibitions, prospecting, live hypotheses), one **proposal** (`proposed_by_component = 'knowledge_backfill'`, reason `Daha önce yazılmıştı ama uygulanmamıştı.`): `card_edit` of the mapped card with the card text §4.3.2 builds from the draft, `rule_add` per prohibition only the draft has, `goal_add` per goal line only the draft has; the draft is archived (log entry `closed: the knowledge base replaces drafts`) |
| no approved version, an open draft | **blank** seed cards (`seed_source = draft`) | every non-empty part of the draft becomes a proposal as in the row above (`card_edit` of each blank seed card the draft gives text to, `rule_add` per prohibition, `goal_add` per goal line, `card_new` "Önceki görüşmeler" for the log); the draft is archived; no cap, no frame. Nothing the draft says takes effect until the owner adds it (D15, R3): the gate stays closed until the owner writes a card or accepts one of these proposals (bootstrap, §4.10.5) |
| neither | blank seed cards (`seed_source = empty`) | the page shows the empty state; the gate stays closed until the first card text |
| neither, but an archived version (the strategy was archived) | blank seed cards (`seed_source = empty`) | the newest archived version's parts become proposals as for a draft, reason `Daha önce kullanılıyordu; istersen geri ekle.`; the gate stays closed, as the archive left it, until the owner writes or adds a card |

System proposals expire after 60 days instead of 14.

When an approved version exists and any version's consultation log holds `answer` or `note` entries,
one more card `past_conversations` "Önceki görüşmeler" holds them, newest first, `• {metin}` each cut
at 600 characters, whole entries only, until 8000 characters; the owner's own words stay available
to agents.

**Invariant**: a workspace has no frame only while no live card has text (§4.5.1). Seeding keeps it
(cards get text only when an approved version exists), and the first card text written without a
frame bootstraps one in the same transaction (§4.10.5).

#### 4.3.2 The seed cards and their text

Positions 0–7 in this order; `key` fixed (ASCII, for agents). A part with nothing to say leaves the
body empty; the card stays (blank seeds show their placeholder, §4.11).

| key | Title | Body generated from the source version's sections |
|---|---|---|
| `who_we_are` | Biz kimiz | `identity.positioning`, then `\n\nBizi farklı kılan: {identity.usp}` when `usp` is not empty |
| `products_prices` | Ürünler ve fiyat | `identity.product` |
| `voice` | Ses tonu | `identity.voice` |
| `customers` | Müşterilerimiz | `goals.objective` (when not empty) and a blank line, then one line per audience segment `• {name}: {description}` |
| `post_ideas` | Paylaşım fikirleri | one line per live hypothesis but the owner's request, in position order, `• {title}: {angle}` |
| `who_we_seek` | Kimi arıyoruz | one paragraph per ICP entry: `• {segment name, else segment key}: {sectors, joined ", "}. Şehirler: {city[ (district)], joined ", "}.` then ` İşaretler: {signals joined "; "}.`, ` Hariç: {exclusions joined "; "}.`, ` Ölçek: {size_hint}.` when present. The rubric is not written (it stays in the frame) |
| `accounts_channels` | Hesaplar ve kanallar | one line per channel choice with a rationale: `• {platform name}: {rationale}`, or `• {rationale}` for `any`. Platform names: instagram Instagram, facebook_page Facebook, x X, linkedin_page / linkedin_member LinkedIn, tiktok TikTok, youtube YouTube, pinterest Pinterest, google_business Google İşletme, mailbox E-posta, whatsapp_cloud WhatsApp, sms_line SMS, meta_ads Meta reklam |
| `references` | Referanslar | empty (no section holds it) |

A body longer than 8000 characters keeps whole lines from the start and ends with
`(+{n} satır daha)`.

Which cards feed which derivation (§4.4 step 3, §4.10.4): **posting cards** `who_we_are`,
`products_prices`, `customers`, `post_ideas`, `past_conversations` and every card with no key;
**prospecting cards** `who_we_seek`, `customers` and every card with no key. `voice`,
`accounts_channels` and `references` feed no derivation: agents read them live.

Kurallar: `prohibitions` = the source's prohibitions, as they are. Hedefler: one line per KPI,
`{name}: {target}`, or `{name}` when the target is empty. Caps and approval (only when an approved
version is the source; a draft or no version gives none of them):

- **Ad budget** (`ad_cap`, D2). Let *L* be the source's paid lane when `paid_enabled`, and *G* the
  live general ad budget item (`budget_items.general`, 0039) in *L*'s currency.
  - *L* and *G*: `ad_cap` = *L*'s period and currency, amount = the lower of *L*'s cap and *G*'s cap
    brought to *L*'s period (prorated as `check_general` does); *G*'s cap is lowered to `ad_cap`
    brought to *G*'s period when it is above (system, ledger `budget.items.update {reason:
    "knowledge_backfill"}`).
  - Only *L*: `ad_cap` = *L*; a general item is created from it (`name = "Reklam bütçesi"`,
    `kind = ad_budget`, unit the lane's currency, `cap = L.cap_minor`, `period = L.period`, ledger
    `budget.items.create {reason: "knowledge_backfill"}`).
  - Only *G* (no paid lane, or `paid_enabled = false`): `ad_cap = null` (Kurallar reads `Reklam yok.`);
    *G* is left as it is (no lane: nothing can be spent on ads, exactly as today).
  - Neither: `ad_cap = null`.
  Effect: no number allows more ad spend than the day before (the lane and the item already bound
  `check_money` together; the new cap is their lower one).
- **Paid-message limit** (`message_cap`, D3): the source's organic lane, as it is (v5: 0 TRY a
  month); `null` when it has none.
- **Post approval**: `post_approval = true` when the workspace has at least one postable social
  account other than TikTok and every such account has `requires_human_approval`; else `false`.
  `post_approval_accounts` = every social account whose stored flag is `true`; `post_gate_seeded_at
  = now`. So every account whose posts wait today still waits (§3.10.1).

Revisions: one `knowledge_revisions` row per seeded card and for rules and goals, `cause = backfill`
(or `seed` for blank seeds), `kb_revision = 1`; `knowledge_settings.revision = 1`; with a frame,
`posting_revision = prospecting_revision = posting_derived = prospecting_derived = 1` (the cards were
made *from* the frame: nothing to re-derive); without one, all four are 0.

#### 4.3.3 The owner's workspace (strategy-v5.json) as seeded

| Card / box | Text (start) | From |
|---|---|---|
| Biz kimiz | `Figurunica: Hikâyeni üret. Anlamı olan her şeyi (bir insanı, bir evcil hayvanı, bir arabayı, bir şehri, bir markanın maskotunu) elle tutulur bir esere dönüştüren 3D üretim stüdyosu. Tek parçadan yüzlerce adede, Türkiye geneli atölye ağıyla.` ⏎⏎ `Bizi farklı kılan: Anlamı esere çeviren tasarım + yapay zekâ destekli hızlı tasarım + …` | positioning, usp |
| Ürünler ve fiyat | `Anlamı olan şeyleri 3D üretimle elle tutulur esere dönüştürür. Ürün grupları: (1) Figür: fotoğraftan kişiye özel figür (insan, evcil hayvan), 15 cm SLA reçine, atölyede elle boyanır; tek fiyat ₺3.499, boyama ve kargo dahil. …` | product |
| Ses tonu | `Samimi, meraklı, sıcak ve hikâye anlatan: … Kısa slogan: 'Hikâyeni üret.'` | voice |
| Müşterilerimiz | `Aynı üretim gücünü üç satış kapısından büyütmek: …` ⏎⏎ `• Marka, kulüp ve kurum ortaklıkları: ÖNCELİK 1. …` + 9 more segments (Toplu sipariş anlaşmaları, Kişiye özel figür, Satış ortakları, Üretim ağı (PR), Influencer ve içerik üreticileri, Atölye (workshop) ortakları, Fuar ve etkinlik stantları, Okul ve eğitim kurumu iş birlikleri, Bayi adayları) | objective, 10 segments |
| Paylaşım fikirleri | `• Fotoğraftan figüre dönüşüm: Müşterinin fotoğrafı → tasarım → baskı → boyama → teslim; …` + `Tutkunu duvara as: diorama tablo`, `Kurumsal yılbaşı hediyesi`, `Kulübün, kurumun simgesi esere dönüşür`, `Tek figürden yüz figüre`, `Fotoğraftan figüre dönüşüm (TikTok)`, `Yılbaşı ve toplu hediye (TikTok)` | 7 live hypotheses |
| Kimi arıyoruz | `• Toplu sipariş anlaşmaları: Etkinlik ve organizasyon ajansı, Düğün ve davet organizasyonu, Pazarlama ve reklam ajansı, Kurumsal hediye ve promosyon tedarikçisi. Şehirler: İstanbul, Ankara, İzmir, Bursa, Antalya, Eskişehir, Konya, Kocaeli. İşaretler: …. Hariç: …. Ölçek: ….` + 6 more (kurumsal_marka, satis_ortagi_hediyelik, atolye_mekan, fuar_etkinlik, okul_isbirligi, bayi_adayi) | 7 ICP entries |
| Hesaplar ve kanallar | `• Instagram: Ana vitrin. …` ⏎ `• E-posta: Kurumsal ve toplu siparişte birebir e-posta …` ⏎ `• TikTok: TikTok (@figurunicaa): …` ⏎ `• LinkedIn şirket sayfası …` ⏎ `• WhatsApp Business 0850 840 73 03: …` ⏎ `• Facebook sayfası (Figurunica): …` ⏎ `• Yapay zekâ aramasında görünürlük …` | 7 channel choices (4 of them `any`) |
| Referanslar | empty | — |
| Önceki görüşmeler | the answers and notes of the 5 log entries, if any are answers or notes | consultation log |
| Kurallar › yasaklar | the 7 prohibitions, verbatim (`Sitede yazmayan fiyat, kargo ya da teslim süresi sözü verilmez; …` … `Otomatik toplu soğuk e-posta gönderilmez …`) | prohibitions |
| Kurallar › reklam | `Reklama ayda en çok ₺5.000.` (`ad_cap` 500000 TRY monthly; lower if the general item is lower) | paid lane, general item |
| Kurallar › mesaj | `Ücretli mesajlara ayda en çok ₺0.` (`message_cap` 0 TRY monthly, the approved organic lane; the owner lifts it in Kurallar) | organic lane |
| Kurallar › onay | from the accounts: the switch is on when every postable non-TikTok account carries the flag; every flagged account (TikTok's flag was set by hand, design 2026-11-19 P5) is in `post_approval_accounts` | capabilities |
| Hedefler | `Marka / kulüp / kurum ortaklığı: 3 ayda 1-2 imzalı anlaşma` · `Toplu sipariş anlaşması: Ayda 2 anlaşma, her biri 30+ adet` · `Kişiye özel figür siparişi: Ayda 5-6'dan 12'ye (3. ayın sonunda)` · `Satış ortağı: 3 ayda 3 aktif satış ortağı` · `İçerik üreticisi iş birliği: 3 ayda 3 ücretsiz iş birliği (para ödenmez)` | 5 KPIs |

The frame of this workspace is then normalised once (§4.10.6): version 6 with `channels = [any]`,
the 7 hypotheses kept (same ids, same organic cadences, content type `general`) with
`channel = any`, the lanes from the caps (paid 500000 TRY monthly, or lower; organic 0 TRY monthly,
unchanged), `channel_mix` emptied, identity mirrored from the cards; audience, prospecting and the
hypotheses' texts unchanged. Its 7 standing research tasks are carried (same ICP entries, §4.10.7).

#### 4.3.4 Approvals through the old tools, until PR 7

The consultation tools and `strategy.approve` stay for external routines until PR 7 (§7.4, G7).
On a workspace whose knowledge base is seeded, an old approval keeps the two layers equal, in its
own transaction:

1. Before validating, the draft's system fields are written as §4.10.1 makes them (draft writes are
   allowed): `channels = [any]`, every hypothesis on `any`, a default organic cadence where a live
   one has none, `channel_mix` emptied, budget lanes from the caps after step 3's lowering. Approval
   then runs as today (gaps, transition hook, research planner with the carry rule, wake).
2. **Re-sync of the cards** (`knowledge::resync`): each seed card whose newest revision has cause
   `seed`, `backfill` or `resync` is rewritten from the approved version with §4.3.2's mapping
   (`cause = resync`); a seed card the owner, a note or a proposal changed since is left as it is,
   and when the version's text for it differs, one `card_edit` proposal carries that text
   (`proposed_by_component = 'strategy_resync'`, reason `Önceki sayfada onaylanan metin.`).
3. Kurallar and Hedefler: prohibitions and goal lines the version adds are appended (never one
   removed, cause `resync`); `ad_cap` and `message_cap` are lowered to the version's lanes when those
   are lower, never raised (raising is the owner's, in Kurallar); the general item follows a lowered
   `ad_cap` as in §4.3.2.
4. `revision += 1`; `posting_revision`, `prospecting_revision`, `posting_derived` and
   `prospecting_derived` all = the new revision (the cards now say what the frame says: nothing to
   re-derive).

A workspace not yet seeded is seeded from the version just approved, in the same transaction.
`strategy.archive` refuses on a seeded workspace with `CONFLICT use_brake` ("the knowledge base keeps
the frame; stop posting with studio.brake"), so a frame never disappears under a written knowledge
base (D10). The panel's `/api/strategy` write routes refuse with `CONFLICT use_knowledge_base` from
PR 3 on (the page they served is gone); the MCP tools keep working, with this re-sync, until PR 7.

### 4.4 Cards

| Use case | Surface | Input | Effect |
|---|---|---|---|
| `strategy.card_create` | panel `POST /api/knowledge/cards` | `{title, body?, attachments?, position?}` | a card (`key = null`), revision 1 |
| `strategy.card_update` | panel `PATCH /api/knowledge/cards/{card_id}` | `{expected_revision, title?, body?, attachments?, position?}` | the fields given replace the card's |
| `strategy.card_archive` | panel `POST /api/knowledge/cards/{card_id}/archive` | `{expected_revision, archived: bool}` | archives or restores |
| `strategy.card_history` | panel `GET /api/knowledge/cards/{card_id}/history` | `?cursor` | revisions newest first, 50 a page |

All need `team.manage` and a person in person (owner's page; agents write cards only through
`note_file` and accepted proposals). Refusals: `VALIDATION` per field (limits of §4.2),
`CONFLICT card_changed {revision}` (stale), `CONFLICT card_archived`, `CONFLICT too_many_cards`,
`NOT_FOUND`. Restoring an old text from the history is a `card_update` with that text.

Every knowledge write (cards here, rules and goals §4.6–§4.7, accepted proposals, filed notes), in
its one transaction:

1. Locks in the order of §4.10.13. A write that may bootstrap (a card write, an accepted
   `card_new`/`card_edit`, a filing with cards) first reads `current_approved()` without a lock; when
   there is no frame it takes `lock_draft` and `lock_execution_frame` before anything else. Every
   write then takes `lock_settings`, then its subject row, and checks the revision.
2. Write the row; append one `knowledge_revisions` row (`content` = the subject as it now is,
   `cause`, `by_*`, `kb_revision` = the new revision).
3. `knowledge_settings.revision += 1`, `changed_at = now`, `changed_by` = the person (the note's or
   proposal's person when an agent files or an owner accepts); `posting_revision = revision` when
   the change touches a posting card, `prospecting_revision = revision` when it touches a prospecting
   card (§4.3.2: a title, body, attachment, archive or restore of such a card; a new card with no key
   is both). Rules and goals changes move neither.
4. Ledger `strategy.knowledge_changed {subject, card_id?, key?, revision, kb_revision, cause}`
   (no text; texts live in the revisions, as the consultation's did; `strategy_version_id` = the
   frame in force).
5. Wakes (§5.3): `KNOWLEDGE` with `KnowledgeChanged` when `posting_revision` moved, `RESEARCH` when
   `prospecting_revision` moved; a person's own write through `wake::request`, an agent's filing
   through `request_for` on behalf of the note's person. A change that moved neither wakes nobody
   (agents read it live at their next run).
6. When no frame exists and the write leaves a live card with text: the bootstrap (§4.10.5), in the
   same transaction.

### 4.5 When the knowledge base is empty

#### 4.5.1 The predicate

The knowledge base is **empty** when no live card has a body with a non-whitespace character.
Kurallar and Hedefler do not count: they say what agents must not do and aim at, not who the
business is. This one predicate is read everywhere: `knowledge_empty` on Paylaşımlar (composer stop,
row wait, empty state), the onboarding step, the `knowledge_empty` work item, `KnowledgeState.empty`,
the bootstrap trigger and the gate's words. By the invariant of §4.3.1 a workspace without a frame
is always empty, so the gate's "no frame" is said to the owner as "Bilgi bankası boş" (the reverse,
a frame under an emptied knowledge base, is §4.10.11's last case).

### 4.6 Kurallar: `strategy.rules_save`

`PUT /api/knowledge/rules`, panel only, a person in person, `team.manage`; plus `budget.manage`
when `ad_budget` or `message_budget` changes; plus the role owner or manager when `post_approval`
goes from `true` to `false` or an account leaves `post_approval_accounts` (an agent's key never
lowers it; design 2026-11-19 O4's concern). Risk `Spend`.

```rust
#[derive(Deserialize)] #[serde(deny_unknown_fields)]
pub struct RulesInput {
    pub expected_revision: u64,                    // knowledge_settings.rules_revision
    pub prohibitions: Vec<String>,                 // trimmed, empty lines dropped, ≤ 100 × ≤ 500
    pub ad_budget: Option<CapInput>,               // None: no ads ("Reklam yok")
    pub message_budget: Option<CapInput>,          // None: no limit of its own
    pub post_approval: bool,
    #[serde(default)] pub post_approval_accounts: Option<Vec<CapabilityId>>,  // None: unchanged
}
pub struct CapInput { pub amount_minor: i64 /* 0..=10^12 */, #[serde(default)] pub period: Option<BudgetPeriod> /* weekly | monthly */ }
```

Locks, in the order of §4.10.13: `lock_draft`, `lock_execution_frame`, `lock_settings`, then (in the
mirror's transition hook) `studio_control`, then the general budget item: within the transaction the
mirror is written before the general item. The answer is the rules box as stored, plus
`stopped_campaigns` (§4.6.2).

#### 4.6.1 Yasaklar

Stored in `knowledge_settings.prohibitions`; a knowledge change (§4.4 steps, no derivation due).
Effect: **at once**, every agent read carries them: `jeeta.strategy.knowledge_get.rules.prohibitions`,
`jeeta.strategy.get` (`approved.sections.prohibitions`, live, §5.4), `inbox.context.prohibitions`
(with the conversation's own), `studio.slot_get.brand_rules.prohibitions`, and the hints
(§5.2: "never cross the rules"). They are copied into the frame the next time one is written
(§4.10.2). They are not checked by the server (D6); the box says so in its help line.

#### 4.6.2 Reklam bütçesi (K4, D2)

The owner's number is **`knowledge_settings.ad_cap`**: written only here (a person in person with
`budget.manage`) and by the lowering-only backfill and re-sync (§4.3.2, §4.3.4). It is the ceiling
nothing else crosses:

- Save with an amount: `ad_cap = {amount_minor, period (given, else the current one, else monthly),
  currency (the general item's unit, else TRY)}`. The live general item gets `cap = amount_minor`
  and that period (`budget.items.update` internals, the person as actor); with none, one is created
  (`name = "Reklam bütçesi"`, `kind = ad_budget`, `general = true`). `None` (no ads): `ad_cap = null`
  and the general item's cap becomes 0 (it is kept: Bütçe's history stays).
- In the same transaction, when a frame exists, the system writes the **mirror** (§4.10.2, cause
  `rules`): the frame's paid lane = `ad_cap` (`{lane: paid, period, cap_minor: amount, currency}`)
  when its amount is above 0, none otherwise; `paid_enabled` = a paid lane exists. `ads::check_money`,
  `studio::ads`, the paid planner and `validate_reservation` read it as today, so the cap binds at
  once. When the mirror cannot be written (§4.10.2 step 6: a bug), the owner's save still commits,
  the general item already holds the new number (a lowering binds through `check_money`'s general
  check at once; a raising waits, which errs safe), `strategy.frame_skipped` is ledgered and the next
  `knowledge_settle` tick writes the mirror.
- **Agents cannot raise it.** `budget.rs` `check_general` compares a general item with `ad_cap`
  instead of the strategy's paid lane (same proration, refusal `VALIDATION {field: "cap", reason:
  "above_rules_cap", cap: <most allowed>}`), for every create, update, period change or
  `general: true`, whoever makes it. So `jeeta.budget.items_update` and `items_create` (which need
  only `budget.manage`, a scope an agent key may carry) can lower the general item, or raise it back
  up to `ad_cap`, never above; the lane never moves from Bütçe (Bütçe's writes run no mirror and take
  no frame lock). `ad_cap = null`: nothing to compare with, and nothing can be spent on ads (no
  lane), exactly as a workspace without a paid lane today. Bütçe shows the ceiling under the general
  item: `Kurallar'daki reklam sınırı: ₺{n} · Kurallar'da değiştir` (→ `/knowledge#kurallar`).
- Lowering the cap: right after the commit `ads::watch::watch_all(deps, ws, now)` runs for the
  workspace (the pass the `studio_control` job makes, `ads/watch.rs:270-300`), so every running
  campaign stops at once when the period's ad spend already reached the new cap, instead of at the
  job's next pass; the answer carries `stopped_campaigns` (its count) and the panel says
  `{n} reklam kampanyası yeni sınıra ulaştığı için durdu.` Below the cap they run on, and the general
  budget stops them when the spend reaches it, as today.
- A missing **paid** lane stays `lane_budget_missing`, worded `Kurallar'da reklam bütçesi yok.`

#### 4.6.3 "Her paylaşım onayıma gelsin" (K4, D1)

Post approval is owned by the knowledge base: the workspace switch `post_approval` and the per-account
list `post_approval_accounts`. Neither is a knowledge revision for derivation (a `rules` revision row
is written). The effective post gate (§3.10.1) reads only these and TikTok's posting screen, so:

- switching **on**: every post not yet sent on any social account waits for the owner (a ready post
  shows `Onayını bekliyor`; one whose time passes while waiting is freed to wait for a new time,
  F4); new accounts are covered at once (nothing is written per account).
- switching **off**: posts go out at their time except on the accounts of `post_approval_accounts`;
  TikTok always needs its screen. When the list is not empty the dialog says, under the switch,
  `{hesap, …} hesaplarındaki paylaşımlar yine onayına gelir.` with the action `Bunlarda da kapat`
  (saves with `post_approval_accounts: []`).
- It does not touch comment replies or ad accounts, whose approval stays each capability's own
  stored flag (`requires_human_approval`, as today).

The Kurallar line is built from the effective gates (§4.11).

#### 4.6.4 Paid messages (`message_cap`, D3)

The organic lane of the frame is the owner's **paid-message limit**: SMS and every metered inbox,
outreach or social send reserves on it (`studio/budget.rs` `reserve_metered_for`). Stored in
`knowledge_settings.message_cap`, seeded from the approved organic lane, written here (a person in
person with `budget.manage`) and lowered only by the re-sync. The mirror writes the organic lane from
it; with `message_cap = null` the frame has no organic lane and `validate_reservation` treats the
missing **organic** lane as no lane cap: the spend still meets the linked budget items' caps and the
capability's own cap (a reservation without budget items is `invalid_spend_context`, so every
metered send is bounded by an item). Kurallar shows the line only while `message_cap` is set, and the
dialog shows the field while it is set or the workspace has a metered capability
(`studio::budget::is_metered`).

#### 4.6.5 One account's approval: `strategy.post_approval_set`

`POST /api/knowledge/post-approval {capability_id, required: bool, expected_revision}` (the rules
revision), panel only, a person in person with `social.manage` or `team.manage`; `required: false`
needs the role owner or manager. Adds the social account to `post_approval_accounts` or removes it
(`CONFLICT post_approval_all` when `required: false` while the switch is on: the dialog says to
switch it off in Kurallar). A `rules` revision row and the ledger entry `strategy.rules_changed` as
§4.6. It is what Hesaplar's per-account switch calls (§2.9.2).

The ledger entry of every Kurallar write is `strategy.rules_changed {prohibitions: n, ad_budget:
{amount_minor, period} | null, message_budget: … | null, post_approval, post_approval_accounts: n}`;
the `rules` revision row holds the whole box.

### 4.7 Hedefler: `strategy.goals_save`

`PUT /api/knowledge/goals {expected_revision, items: [String]}` (≤ 20 × ≤ 300, trimmed), panel
only, `team.manage`, a person. A knowledge change (§4.4 steps; no derivation due, nobody woken).
Read at once by `jeeta.strategy.knowledge_get.goals`, `jeeta.strategy.get`
(`approved.sections.goals.kpis` as `[{name: line, target: ""}]`, live) and `studio.overview`
(`goals`); copied into the frame the next time one is written.

### 4.8 "Ajanlara bir şey anlat": notes

| Use case | Surface | Who | Input → effect |
|---|---|---|---|
| `strategy.note_add` | panel `POST /api/knowledge/notes` | person, `team.manage` | `{request_key, text, links?, file_ids?}` → note `open`; wake `KNOWLEDGE` and `RESEARCH` with `KnowledgeNote`; ledger `strategy.note_added {note_id, links, files}` |
| `strategy.note_withdraw` | panel `POST /api/knowledge/notes/{note_id}/withdraw` | the person who added it, or owner/manager | `{expected_revision}` → `withdrawn` (a claim held on it ends) |
| `strategy.note_claim` | MCP `jeeta.strategy.note_claim` | an agent with a work permission (§5.1) | `{note_id, expected_revision}` → `{claim_token, until, note}`; lease 30 minutes; a live claim of another connection: `CONFLICT note_claimed {until}` |
| `strategy.note_file` | MCP `jeeta.strategy.note_file` | the claimant | `{note_id, claim_token, request_key, summary}` with at least one of the outcomes below, or `{note_id, claim_token, dismiss: {reason}}` → `dismissed` |
| `strategy.note_release` | MCP `jeeta.strategy.note_release` | the claimant | `{note_id, claim_token}` → open again |

`note_file` closes the note with one or more **outcomes**, all in one transaction, all recorded as
the note's person's words (`changed_by` = that person, wakes through `request_for` on their behalf):

| Outcome | Input | Effect | What the owner reads under the note |
|---|---|---|---|
| cards | `cards: [{card_id, expected_revision, title?, body} \| {new: {title, body}}]` (1..=3), `attachments?: [{card index, file_id \| url}]` | cards written (`cause = note`, `source_id`) | `{kart} kartına eklendi: {özet}` |
| rules | `rules: [String]` (1..=10, ≤ 500 each) | lines appended to the prohibitions (duplicates skipped), `cause = note` | `Kurallara eklendi: “{satır}”` with the link `Kurallar` |
| goals | `goals: [String]` (1..=5, ≤ 300 each) | lines appended to Hedefler | `Hedeflere eklendi: “{satır}”` with the link `Hedefler` |
| post request | `post_request: {}` | a content opened exactly as `content.post_request` (§3.4) with `text` = the note's text, the note's image and MP4 files as its files (PDFs stay knowledge), `requested_by` = the note's person; `CONTENT` (or `MATERIALS`) woken on their behalf | `Paylaşım olarak açıldı · Paylaşımlar'da gör` (→ `/posts?content=`) |
| proposals | `proposals: [ProposalId]` (1..=5, made by this connection for this note) | none: they wait in Ajanın önerileri | `Önerilere eklendi` |

Rules of `note_file`: `summary` 1–300 characters, Turkish, shown to the owner under the note; a
filing that makes a card's body shorter than half of what it was is `CONFLICT filing_removes_text`
(an agent adds, it does not wipe); a stale card revision is `CONFLICT card_changed` (re-read and file
again); a withdrawn note is `CONFLICT note_withdrawn`; a post request in a workspace without the
content module is `CONFLICT module_not_installed` (dismiss instead, saying so); the note's files may
become card attachments (they stay knowledge, never library materials, D29) or, through a post
request, the post's files. The ad budget, the message limit and the approval switch are never an
outcome: a note asking to change them is dismissed with a reason that sends the owner to Kurallar
(`Reklam bütçesini Kurallar'dan sen değiştirirsin.`). `dismiss` is for a note with nothing to act on
(a question: the reason says where the answer is).

### 4.9 Proposals ("Ajanın önerileri")

| Use case | Surface | Who | Input → effect |
|---|---|---|---|
| `strategy.proposal_create` | MCP `jeeta.strategy.proposal_create` | an agent with a work permission | `{request_key, kind, card_id?, title?, body, reason}` → `pending`, `expires_at = now + 14 days` |
| `strategy.proposal_accept` | panel `POST /api/knowledge/proposals/{id}/accept` | person, `team.manage` | applies it (below) → `accepted`, `applied_revision` |
| `strategy.proposal_skip` | panel `POST /api/knowledge/proposals/{id}/skip` | person, `team.manage` | → `skipped` |

- `card_new`: `title` and `body` required → a new card (`cause = proposal`). `card_edit`: `card_id`,
  `body` (the card's whole new text) and optionally `title`; `base_revision` = the card's revision
  at proposal time. `rule_add`: `body` ≤ 500, appended to the prohibitions. `goal_add`: `body` ≤ 300,
  appended to the goals. Accepting is a knowledge write (§4.4); a card proposal may bootstrap.
- Accepting a `card_edit` whose card moved past `base_revision` is `CONFLICT proposal_superseded`
  and the proposal becomes `superseded`; every owner edit of a card also supersedes its pending
  `card_edit` proposals (accepting would overwrite the owner's newer text). The agent may propose
  again.
- Refusals at create: `CONFLICT too_many_proposals` (20 pending), `CONFLICT proposal_rate`
  (10 per connection per day), `CONFLICT proposal_exists` (same kind, card and body pending),
  `NOT_FOUND` card, `VALIDATION` limits.
- Expiry: the `knowledge_settle` job sets `expired` past `expires_at`.
- A person's work item `knowledge_proposal {proposal_id}` (priority 3, `team.manage`) lists each
  pending one on the home page.

### 4.10 The frame (K3)

#### 4.10.1 What it holds and who fills it

| Frame field | Source | Filled by | Structural (in the diff, §4.10.2 step 7) |
|---|---|---|---|
| `identity` {product, voice, positioning, usp} | the cards: `product` = `products_prices`' body, else `who_we_are`'s, else the first card with text by position, else the workspace's name (2000 characters); `voice` = `voice`'s body; `positioning` = `who_we_are`'s; `usp` = the previous frame's (or empty) | system, every time a version is written (D34) | no |
| `audience` | segments with stable keys | the content agent (`audience`); segments the merge carries (step 4); the research agent's new ones (`prospecting.segments`); bootstrap: `genel` | the set of keys |
| `goals.objective` | derived text | the content agent (`objective`), else the previous frame's | no |
| `goals.kpis` | Hedefler, `{name: line, target: ""}` | system | no |
| `prohibitions` | Kurallar | system | no |
| `channels` | `[{channel: "any", rationale: "", group_id: null}]` | system (K6) | yes |
| `budget_frame`, `paid_enabled` | paid lane from `ad_cap`, organic lane from `message_cap` (§4.6) | system | yes |
| `cadence` | `{per_week: previous or 3, channel_mix: []}` | system | yes |
| `prospecting` {icp, rubric} | derived from the prospecting cards | the research agent (`prospecting`) | yes, whole (whitespace-normalised) |
| hypotheses ("topics") | derived from the posting cards and what was learned | the content agent (`topics`); paid cadence by an `ads.work` agent (`paid_cadence`); retained topics, closing topics and the owner's request by the system | the set of live ids, and per topic `segment_key`, `state`, `channel` and `cadence` |

Not structural means: a difference in it alone never makes a version; when a version is written for
a structural reason, its latest text is written with it.

#### 4.10.2 One apply function

`knowledge::frame::apply(deps, ctx, repos, next: FrameParts, cause: FrameCause) -> Applied`, inside
the caller's transaction; `cause` ∈ `derive` (an agent's `frame_apply`), `bootstrap`, `rules`
(the Kurallar mirror), `normalize` and `close` (the `knowledge_settle` job). Steps:

1. **Locks** (§4.10.13): `strategy().lock_draft()`; an open draft (only ever an old routine's) is
   archived with the log entry `closed: the knowledge base replaces drafts` (one draft per workspace:
   the new version needs the slot). Then `lock_execution_frame()` → `previous`; then `lock_settings`,
   and `settings` is read now, under the frame lock. For `derive`: `kb_revision > settings.revision`
   is `CONFLICT kb_revision_ahead`; for each part the caller derives, `kb_revision <
   settings.{part}_derived` is `CONFLICT derivation_stale` (a newer derivation of that part was
   applied: re-read and derive again). No frame and `derive`: `CONFLICT knowledge_empty`.
2. **Retained set** *R*, from facts: the live topics of `previous` that a planned or ready slot, a
   live ad-set binding, a queued budget move or an ad of a campaign not ended names
   (`studio().list_slots`, `list_bindings`, the budget moves, the ads repository). For each topic of
   *R*, the content types (per lane) its slots and bindings use.
3. **Topics** (cause `derive` with `topics`): for each topic given, its id when given (it must be a
   hypothesis of some version of this workspace: `VALIDATION topic_unknown`; the owner's request id:
   `FORBIDDEN hypothesis_reserved`), else the id of a live topic of `previous` whose title is the
   same once case and whitespace are normalised, else a new id. `channel = "any"`. A **kept** topic
   sent without a cadence keeps its previous cadence; a **new** one without gets
   `default_organic_cadence(max(per_week, 1))` (`strategy.rs`, moved to `jt_knowledge`); a given
   cadence is validated as `HypothesisCadence` is; a paid cadence is the previous one unless
   `paid_cadence` names the topic. `prior_confidence` defaults to 0.5 (previous for a kept topic).
   **States**: in `previous` and given → `kept` (and it leaves `closing_topic_ids` if it was there);
   new → `added`; live in `previous` and not given → `retired`, **except** when it is in *R*: then it
   stays `kept`, keeps its previous fields, and joins `closing_topic_ids` (no new post is made for
   it; §4.10.6 retires it once *R* no longer holds it). Without `topics`, `previous`'s topics
   stay as they are.
   For every live topic of *R* (sent or not), per lane its slots or bindings use: the lane's cadence
   is kept (the previous one when the new one has none), `slots_per_week ≥ 1`, and each used content
   type stays in it with `max_bps > 0` (added as `{min_bps: 0, max_bps: previous max_bps}` when the
   new cadence dropped it). So a post already planned, ready, held at a platform or bound to an ad
   set still passes `validate_chain` under the new version.
   The owner's request is `kept` when `previous` holds it (F2 carry-over), never sent, never checked.
   `paid_cadence` (ads part, alone or with others): for each `{topic_id, cadence}`, the topic must be
   live in the result (`VALIDATION topic_unknown`), its paid cadence is replaced; nothing is retired.
4. **Audience**: the caller's `audience` when given, else `previous`'s; then every segment key that a
   live topic not sent in this call (retained, closing, carried) or an ICP entry of a part not sent
   in this call names is carried with its previous name and description (`kept_segments` in the
   answer); then the research agent's `prospecting.segments` whose keys are not there yet are
   appended. No segment a live row of the frame names can disappear.
5. **System fields** (every cause): §4.10.1's identity, `goals.kpis`, prohibitions, channels,
   budget lanes, `paid_enabled` and cadence, from the knowledge base and the caps.
6. **Validate** only what this call brought: for `derive`, each topic sent has a
   title, an angle, a metric and a segment of the merged audience, and its cadence is valid; at most
   30 topics sent (`too_many_topics`); an audience sent has at least one segment and keys
   `[a-z0-9_]{2,32}`, unique; prospecting sent passes `rules::prospecting_gaps` against the merged
   audience (ICP shape, rubric weights sum 100); `paid_cadence` valid. Gap paths name the caller's
   input (`topics[2].angle`, `audience[0].key`, `prospecting.icp[1].segment_key`), never the merged
   list. For the system causes, only the system fields (lanes, `identity.product`), which are built
   to pass. Inherited, retained and carried content is never re-validated, and the owner's request
   is outside every topic check and count. A gap in a `derive`: `VALIDATION` with `details.gaps`,
   nothing written. A gap in a system cause is a bug: nothing of the frame is written,
   `strategy.frame_skipped {cause, gaps}` is ledgered, and the caller's own write (a Kurallar save,
   a card) still commits; the next `knowledge_settle` tick tries again.
7. **Diff**, structural only (§4.10.1's last column), canonical JSON after whitespace
   normalisation: `previous` against the merged frame. Equal → `Applied { applied: false,
   text_only }` (`text_only` when the non-structural texts differ); only step 9's acknowledgements and
   `closing_topic_ids` are written.
8. Insert the new version (`number = next_number`, status `draft`, `created_by_*` from `ctx`), write
   its hypotheses (`replace_all` on the new version), archive `previous` (log
   `superseded by version {n}`), approve the new one (`approved_by`: the key's issuer for `derive`,
   the person for `rules`, the person whose write caused it for `bootstrap`, none for `normalize` and
   `close`), log `frame {n} applied ({cause})`; ledger `strategy.frame_applied {number, cause,
   parts, kept, added, retired, closing, kept_segments, kb_revision}` with `strategy_version_id` = the
   new version; `deps.transition_hook.apply(StrategyChange {previous, current, kept, retired,
   added})` (slots of retired topics retired and their versions freed to wait again, F4, then
   attributed under the new frame, F1; by step 3 no retired topic has a planned or ready post);
   `research::plan_in(new)` with the carry rule (§4.10.7).
9. **Acknowledge** (`derive`): for each part the caller derived, `{part}_derived =
   max({part}_derived, kb_revision)`; `closing_topic_ids` as step 3 left it; `frame_applied_at = now`.
   A derivation from an older revision than the current one (but not older than the last applied)
   is applied and acknowledges only what it read, so the work item stays for the rest.
10. Wakes (§4.10.8).

`approve()`'s side effects (transition hook, research planner, wake, owner's-request carry) live here
now; `strategy.approve` keeps its own until it is removed in PR 7 (§4.3.4, §7.4).

#### 4.10.3 `jeeta.strategy.frame_apply` (MCP only)

```rust
#[derive(Deserialize)] #[serde(deny_unknown_fields)]
pub struct FrameApplyInput {
    pub request_key: String,
    /// The knowledge revision the derivation read (`knowledge_get.revision`).
    pub kb_revision: u64,
    /// The derivations this call answers: `posting` (content.work), `prospecting` (prospects.work).
    /// A part listed with none of its fields sent is "unchanged": acknowledged, nothing else.
    /// Empty only when `paid_cadence` is sent.
    #[serde(default)] pub parts: Vec<DerivePart>,
    #[serde(default)] pub audience: Option<Vec<Segment>>,          // posting
    #[serde(default)] pub objective: Option<String>,               // posting, ≤ 2000
    #[serde(default)] pub topics: Option<Vec<TopicInput>>,         // posting, ≤ 30
    #[serde(default)] pub prospecting: Option<ProspectingInput>,   // prospecting
    #[serde(default)] pub paid_cadence: Option<Vec<PaidCadence>>,  // ads.work, merged per topic id
}
pub struct TopicInput {
    #[serde(default)] pub id: Option<HypothesisId>,
    pub title: String, pub segment_key: String, pub angle: String, pub metric: String,
    #[serde(default)] pub prior_confidence: Option<f32>,
    #[serde(default)] pub cadence: Option<BTreeMap<LaneKind, HypothesisCadence>>,  // organic only; paid via paid_cadence
}
pub struct ProspectingInput {
    pub icp: Vec<IcpEntry>, pub rubric: Rubric,                    // jt_strategy's shapes
    #[serde(default)] pub segments: Vec<Segment>,                  // new audience segments its entries name
}
pub struct PaidCadence { pub topic_id: HypothesisId, pub cadence: HypothesisCadence }
pub struct FrameApplyOut {
    pub applied: bool, pub text_only: bool, pub number: i32,
    pub kept: u32, pub added: u32, pub retired: u32,
    pub closing: Vec<HypothesisId>,         // left out, kept for their posts; retired by the system later
    pub kept_segments: Vec<String>,         // segments the merge carried for rows the call did not send
    pub topics: Vec<Topic>,                 // the frame in force: {id, title, segment_key}, without the owner's request and closing topics
}
```

Parsed strictly (`jt_strategy::parse_section_strict` for audience and prospecting; the hypothesis
parser for topics, without `channel` and `state`). A field of a part not listed in `parts` is
`VALIDATION {field, reason: "part_not_listed"}`. Refusals: `FORBIDDEN agent_only` (a person's
session), `FORBIDDEN part_permission {part, permission}` (`posting` needs `content.work`,
`prospecting` `prospects.work`, `paid_cadence` `ads.work`), `VALIDATION` (gaps, §4.10.2 step 6),
`CONFLICT kb_revision_ahead`, `CONFLICT derivation_stale`, `CONFLICT knowledge_empty` ("the
knowledge base has no card text yet: nothing to derive; propose a card with
jeeta.strategy.proposal_create"), `FORBIDDEN hypothesis_reserved`, replay by `request_key`.

The knowledge read gives agents what they need to send unchanged parts verbatim:
`knowledge_get.frame` = `{number, revision, posting_derived, prospecting_derived, derive_due,
audience, objective, topics: [{id, title, segment_key, angle, metric, cadence, has_posts}], closing:
[{id, title}], prospecting}` (topics without the owner's request and closing topics; `has_posts`
when the topic is in *R*).

#### 4.10.4 Who derives

- **Posting** (audience, objective, topics): an agent key holding `content.work`, woken by
  `KnowledgeChanged` (need `KNOWLEDGE`, module none), listed `knowledge_derive {kb_revision, part:
  posting}` while `posting_revision > posting_derived`. A workspace with no `content.work` key keeps
  its topics as they are (the bootstrap's `Genel`, or the last derivation); every connected account
  is still used.
- **Prospecting** (ICP, rubric, new segments): an agent key holding `prospects.work`, need
  `RESEARCH`, item `knowledge_derive {part: prospecting}` while `prospecting_revision >
  prospecting_derived`, in the work module the `RESEARCH` need names.
- **Paid cadence**: an agent holding `ads.work`, through `paid_cadence` alone or with a posting
  derivation; `ADS_PLAN_HINT` says when (a topic the ads agent runs ads for has no paid cadence).
  No item is listed for it.

#### 4.10.5 A brand-new workspace: bootstrap

When no approved frame exists and a write leaves a live card with text, in that write's transaction,
the system applies a **bootstrap** frame (cause `bootstrap`). The writes that may: a person's
in-person card write (`card_create`, `card_update`, `card_archive` restoring), a person's acceptance
of a `card_new` or `card_edit` proposal, and an agent's filing of a person's note into cards
(`approved_by` and the wakes are then that note's person's). Never a Kurallar or Hedefler save,
never a seed, never the job but for the repair below.

- `identity`: §4.10.1's mirror (the product has text: a card has text);
- `audience` = `[{key: "genel", name: "Genel", description: customers' body (2000)}]`;
- one topic, id `stable_id(ws, "strategy.hypothesis:knowledge_base")`, `title: "Genel"`,
  `segment_key: "genel"`, `angle` = `post_ideas`' body (500) or `İşletmeyi tanıtan paylaşımlar`,
  `metric: "Etkileşim"`, organic cadence `default_organic_cadence(3)`;
- prospecting empty (research waits for its agent's derivation);
- the system fields of §4.10.1;
- `posting_revision` and `prospecting_revision` stay as the write set them (> 0), so both
  derivations are due at once.

The gate opens with it: the owner's first composer request is not stopped by "Bilgi bankası boş"
once one card has text. Agents then derive the real frame; the bootstrap topic is left out by the
first posting derivation, kept while a post names it (closing) and retired after (§4.10.6), with its
`genel` segment carried until then (§4.10.2 step 4).

The bootstrap frame is built from fallbacks that always validate (§4.10.2 step 6); if it ever does
not, the write commits without it, `strategy.frame_skipped` is ledgered, and `knowledge_settle`
repairs the invariant.

#### 4.10.6 `knowledge_settle`: normalisation and housekeeping

A new job (`jobs.rs`, every 10 minutes, every workspace that is `active` or `pending_payment`, like
`research_plan`): per workspace, in its own bundle, in this order:

1. seed when not seeded (§4.3);
2. **repair**: no frame and the knowledge base not empty (only after a skipped bootstrap, by the
   invariant of §4.3.1) → a bootstrap with `approved_by = changed_by`; it wakes nobody;
3. **normalise**: when the frame's system fields differ from what §4.10.1 computes — `channels` is
   not `[any]`, a live topic's channel is not `any`, a live topic has no usable organic cadence
   (`posts::content_types` would give none), `channel_mix` is not empty, the budget lanes or
   `paid_enabled` differ from the caps — apply with cause `normalize` (prohibitions, goals and
   identity are copied too, but a difference in them alone is never a reason: they are read live);
4. **close**: when a topic of `closing_topic_ids` is no longer in *R* (§4.10.2 step 2), apply with
   cause `close`: it is retired (with any other closing topic out of *R*); steps 3 and 4 make one
   version when both apply (cause `normalize`). Neither wakes anyone;
5. expire proposals; nothing else (a note's lapsed claim needs no write: `claimable` reads the time).

Step 3 is how every existing frame becomes K6-shaped once, after PR 2's deploy, with no owner action:
the first tick applies one version per workspace whose frame is not normalised, with every
hypothesis kept.

Closing topics are left out of every offer of new work in the meantime: `posts::open_channels`
filters them out as it filters the owner's request (so `pick`, `versions_waiting`, the planner's floor
and `best_option` never choose them), the paid planner skips them, and `knowledge_get.frame.topics`
lists them under `closing`. Their planned posts, bindings and ads keep their chain (the topic is
still live in the frame) and go out as planned.

#### 4.10.7 Research tasks survive (K5)

`research::plan_in(version)` changes its first loop: an open standing task of another version whose
`icp_key` names an entry of `version` with the **same standing brief** (`standing_brief(entry) ==
task.brief`, whitespace-normalised; the "brief digest" of K5) is **carried**:
`ResearchTasks::carry(task.id, version.id, rubric_digest(version), entry.daily_cap)` re-stamps its
version (the FK target is the new version, which exists), keeps its id, claim and today's count;
ledger `research.task_carried {task_id, from_version, to_version}`. Only a task whose entry is gone or
whose brief changed is superseded, as today. The one-open-standing-task index (version, icp_key)
still holds: the new version has no other task for that key. `remaining()` keeps reading the entry
when the task's version is the approved one, which a carried task's is.

`research::plan()` (the hourly `research_plan` job) takes `lock_execution_frame()` and plans under
the version that lock returns, as `approve` and every frame apply do, so the job and an apply
serialise and the job never supersedes tasks an apply just carried from a stale view. The
standing-task close refusal's message becomes `the ICP comes from the knowledge base (card
who_we_seek); change the card instead`.

#### 4.10.8 Wakes of an apply

Only for the structural parts that changed: topics or audience → `SOCIAL`; paid lane or paid cadence
→ `ADS`; prospecting → `RESEARCH`; reason `KnowledgeApplied` ("The knowledge base changed what the
agents work from."). A `rules` apply is a person's action (`wake::request`); a `derive` apply wakes
on behalf of `knowledge_settings.changed_by` (`request_for`), never the deriving agent itself;
`bootstrap` wakes `CONTENT` and `SOCIAL` for the person whose write caused it (in person, or
`request_for` the note's person) — areas that waited for a frame are now offered (§5.2); `normalize`,
`close` and the repair wake nobody.

#### 4.10.9 Debounce and skip

- `knowledge_derive` is listed as soon as `{part}_revision > {part}_derived`, with no quiet delay.
  Bursts are debounced by the wake's own settle (`WAKE_SETTLE` after the last request, at most
  `WAKE_SETTLE_MAX` after the first): a derivation made mid-burst acknowledges only the revision it
  read, so the item comes back for the rest; an edit made after the agent's check-in began moved the
  wake row's `seq`, so `checkin_seen` keeps its wake (`wake.rs:376-392`).
- Only posting and prospecting cards make a derivation due (§4.3.2); Kurallar, Hedefler, `voice`,
  `accounts_channels` and `references` are read live and make none.
- Only a structural difference makes a version (§4.10.2 step 7); the hints ask agents to send what
  stays exactly as `knowledge_get.frame` has it, and to send `parts` alone when nothing changed
  (§5.2). Rewording a paragraph never moves the frame, so `strategy_changed` refusals of in-flight
  spend, ad-set rollovers and `late_completion` entries happen only on real change.
- The wake's own limits (`WAKE_MIN_GAP` 3 minutes, 20 an hour) bound derivations per agent.
- No stored "pending frame": an agent's answer is applied or refused in its own call.

#### 4.10.10 Learning stays continuous

Ids are kept by the caller (from `knowledge_get.frame.topics`) and, when it forgets, by the title
match of step 3; arms are keyed by hypothesis, content type, concrete channel and lane, independent
of the version, and learning applications by hypothesis across versions (A6 facts): a new version
with kept ids loses nothing. A person's request is measured on the owner's-request arms (§3.5), never
on a topic's.

#### 4.10.11 An empty knowledge base

- No frame (the knowledge base is empty, §4.5.1): the gate stays closed (`STRATEGY_REQUIRED`, code
  unchanged). Its message becomes `the knowledge base is empty: the owner fills it in Bilgi bankası
  first`; the panel's words everywhere (`QueryState`, `StudioError`, `lib/errors.ts`, the inbox's
  send refusal): `Ajanlar seni henüz tanımıyor. Önce Bilgi bankasına birkaç satır yaz.` with
  `Bilgi bankasına git`.
- A person holding `team.manage` gets the work item `knowledge_empty` (priority 1).
- `work.pending` lists no `content_area` item while no frame exists (the agent could not deliver).
- A frame and an empty knowledge base (the owner emptied every card): the frame stays (frames are
  never withdrawn: no archive, D10); agents read the empty cards and the frame's derived parts; the
  page shows its empty state; the composer stop `knowledge_empty` shows (it reads §4.5.1), but sending
  still works (D20).

#### 4.10.12 Onboarding

Step 2 becomes **Bilgi bankası** (`onboarding.knowledge`): done when `pending.knowledge.empty` is
false; text pending `Ajanların seni tanıması için Bilgi bankasına birkaç satır yaz.`, done
`Bilgi bankası dolu; ajanlar bunu kullanıyor.`; link `Bilgi bankasını aç` → `/knowledge`; next-step
logic `!knowledgeReady ? 2 : …`; `setupNextStrategy` becomes `setupNextKnowledge`
`Bilgi bankasını doldur`. It can be done before payment (`strategy.*` runs while `pending_payment`).
The server test `m4_onboarding_http` asserts `pending.knowledge.empty == true` for a new workspace,
still `true` after a Kurallar save, and `false` after one card write.

#### 4.10.13 Lock order

Every path that may write a frame, or that touches what the frame's lanes mirror, takes its locks in
this one order, and none takes an earlier one after a later one:

`lock_draft` (advisory) → `lock_execution_frame` (the workspace row) → `knowledge_settings` →
capabilities → `studio_control` → budget items.

- Frame apply (every cause), `rules_save`, `strategy.approve` (as today: "draft before frame") and
  every knowledge write that may bootstrap take `lock_draft` and `lock_execution_frame` first, then
  `lock_settings`, before any capability, control or budget item.
- The spend paths already follow it (`validate_reservation`, `reserve_metered_for`, `check_money`,
  `refresh_period`: frame, capability, control, items) and stay as they are.
- Bütçe's budget-item writes lock only the item and read `knowledge_settings` without a lock (they
  write no frame), so they cannot close a cycle; `check_general` reads `ad_cap` after locking the item,
  so it compares against the committed cap.
- `research::plan()` takes the frame lock first (§4.10.7).
- `studio::ads::recheck_periods` retries a `refresh_period` that failed with `INTERNAL` (a deadlock
  or serialisation failure among them) once, after one second, before braking the paid lane; a
  refusal (`CONFLICT`) still brakes at once.

A pg test runs `rules_save` (ad budget) concurrently with `refresh_period` and `reserve_metered_for`
on the same general item, and with a `frame_apply`, and asserts no deadlock (§8.1).

### 4.11 The page `/knowledge`

As mockup H, one column (max 980 px), no tabs.

1. Header `Bilgi bankası`; subtitle
   `Ajanların işletmen hakkında bildiği her şey. Ne yazarsan her işte onu kullanırlar.`; under it the
   agent line (`AgentWakeLine` for the need `knowledge`, with `Şimdi çalıştır`), shown only while a
   note is open or a derivation is due.
2. Composer: label `Ajanlara bir şey anlat`, placeholder `Örn. Yılbaşı siparişleri 15 Aralık'ta kapanıyor`,
   button `Dosya ya da bağlantı` (a small menu: `Dosya ekle` / `Bağlantı ekle`; files hidden without the
   library module, with the line `Dosya eklemek için bir içerik, sosyal medya ya da reklam modülü gerekir.`),
   primary `Ekle`. **Before sending (R1)**, under the input, from `notes_agent` of the read: no key with a
   work permission → `Notları karta ekleyecek bağlı bir ajan yok.` + `Ajan bağla` (→ `/agents`); keys
   but none with a usable wake address → `Ajan notunu bir sonraki çalışmasında ({saat}) ekler.`; the
   soonest expected check-in already passed → `Ajan {saat} bekleniyordu, gecikti.` + `Şimdi çalıştır`.
   Sending stays possible. After `Ekle`: `Ajana iletildi. Uygun karta eklediğinde burada görürsün.`
   (or, with a stop, `Not kaydedildi; ajan bağlanınca eklenir.`). Under it, the last five notes:
   `{metin, kısaltılmış}` with `Bekliyor` (+ `Geri al`), then the outcomes of §4.8
   (`{kart} kartına eklendi: {özet}`, `Kurallara eklendi: “{satır}”` · `Kurallar`,
   `Hedeflere eklendi: “{satır}”` · `Hedefler`, `Paylaşım olarak açıldı` · `Paylaşımlar'da gör`,
   `Önerilere eklendi`), `Eklenmedi: {neden}`, `Geri alındı`. An open note binds at once: agents read
   it in `inbox.context.knowledge.notes` and `studio.slot_get.brand_rules.notes` before it is filed.
3. Two boxes side by side (stacked on a phone):
   - **Kurallar** (`id="kurallar"`), aside `ajanlar asla aşmaz`, button `Düzenle`. Shows the first two
     prohibitions, then the ad line (`Reklama ayda en çok ₺5.000.` / `Reklama haftada en çok …` /
     `Reklam yok.`), the message line only while `message_cap` is set
     (`Ücretli mesajlara ayda en çok ₺0.`), then the approval line built from the effective gates:
     switch on `Her paylaşım yayından önce onayına gelir.`; off with an empty list
     `Paylaşımlar onay beklemeden zamanında çıkar.`; off with accounts in the list
     `Paylaşımlar onay beklemeden çıkar; {hesap, …} hariç.`; each followed by
     ` TikTok'u sen tamamlarsın.` when a TikTok account is connected. Then `{n} kural daha` (expands).
     Empty prohibitions: `Henüz yasak yok.`
   - **Hedefler** (`id="hedefler"`), button `Düzenle`; first three, then `{n} hedef daha`; empty:
     `Henüz hedef yok.`
4. **Ajanların bildikleri**: heading, search `Ara` (filters titles and bodies client-side), a grid of
   cards (title, body clamped to four lines, attachment chips, a `Yeni` badge for 24 h when an agent
   filed into it, with `Ajan ekledi: {özet}` on hover/focus), and `+ Yeni kart`.
5. **Ajanın önerileri** (`id="oneriler"`): with none, the mockup's text
   `Ajan işini yaparken yeni bir şey öğrenirse (sık sorulan bir soru, işe yarayan bir konu) burada önerir; sen eklersin ya da geçersin. Şu an öneri yok.`;
   else one block each: heading by kind (`Yeni kart: {title}`, `“{kart}” kartına ekleme`,
   `Yeni kural`, `Yeni hedef`), `Neden: {reason}`, the proposed text (three lines, `Tamamını gör`; a
   `card_edit` highlights the added words), buttons `Ekle`, `Geç`.
6. **Neler işe yarıyor** (read only, only when `studio.learned` answers with evidence and the viewer
   holds `content.work`, `social.work` or `ads.work`): one line per topic with evidence —
   `{konu}` · `İlgi: yüksek / orta / düşük` (derived confidence ≥ 0.66 / ≥ 0.40 / below) ·
   `{n} paylaşım ölçüldü`. No version, no hypothesis word. With none: hidden.

Editing:

- A card opens in place as an editor (a sheet on a phone): title, text (auto-grow), attachments,
  `Kaydet`, `Vazgeç`, and in a quiet row `Geçmiş` and `Kaldır`. Save toast
  `Kaydedildi. Ajanlar bundan sonra bunu kullanır.` `Kaldır` asks `Bu kart kaldırılsın mı?`
  (`Kaldır` / `Vazgeç`) and offers `Geri al` for 10 s.
- `Geçmiş` (a sheet): `{tarih} · {kim} · {neden}` per revision (`Sen`, `{ad}`, `Ajan (not)`,
  `Ajan önerisi`, `İlk kurulum`, `Önceki sayfadan`), its text, `Bu hâline dön`.
- Kurallar `Düzenle` dialog: the prohibitions as a list (`Yasak ekle`, a remove × per line), the ad
  field `Reklama ayda en çok [ ₺ ]` (period select `ayda / haftada`) with the switch `Reklam yok`; the
  message field `Ücretli mesajlara (SMS vb.) ayda en çok [ ₺ ]` with the switch `Sınır yok`, shown
  only as §4.6.4 says; the switch `Her paylaşım yayından önce onayıma gelsin` and, while it is off
  and accounts are in the list, the line of §4.6.3 with `Bunlarda da kapat`; the help line
  `Bütçeyi, mesaj sınırını ve onayı sistem uygular; yasakları ajanlar her işte okur ve uyar.`;
  buttons `Kaydet`, `Vazgeç`. Without `budget.manage` the two money fields are read-only with
  `Bütçe yetkin yok.` A saved lowering that stopped campaigns says
  `{n} reklam kampanyası yeni sınıra ulaştığı için durdu.`
- Hedefler `Düzenle` dialog: the list (`Hedef ekle`, ×), `Kaydet`, `Vazgeç`.
- Conflicts: `Bu sen düzenlerken değişti; son hâlini gösteriyorum.` and the editor reloads.

Seed placeholders (blank seed cards): Biz kimiz `Ne yapıyorsun, kime, seni farklı kılan ne?`;
Ürünler ve fiyat `Ne satıyorsun, fiyatı ne, neler dahil?`; Ses tonu
`Nasıl konuşursun? Samimi mi, resmî mi? Bir sloganın var mı?`; Müşterilerimiz
`Kimler alıyor? Öncelikli müşterin kim?`; Paylaşım fikirleri
`Hangi konular işe yarıyor? Neleri göstermek istersin?`; Kimi arıyoruz
`Hangi işletmelere ulaşmak istiyorsun? Sektör, şehir, büyüklük.`; Hesaplar ve kanallar
`Hangi hesabı ne için kullanıyorsun?`; Referanslar
`Adını anabileceğin müşteriler ve projeler; izin durumlarıyla.`

States: loading (two box skeletons, six card skeletons); error (`Bilgi bankası yüklenemedi.` +
`Yeniden dene`); empty (no card has text: a callout `Ajanların seni tanıması için birkaç kart yeter. “Biz kimiz” ile başla.`
and the `Biz kimiz` editor opened; when system proposals are pending, the callout reads
`Daha önce yazdıkların Ajanın önerileri'nde seni bekliyor; eklediğin anda ajanlar başlar.` and links
`#oneriler` instead); read-only member (no `team.manage`): no composer, no `Düzenle`, no
`+ Yeni kart`, proposals without buttons, the line `Bilgi bankasını yalnızca yöneticiler değiştirir.`;
phone: single column, the boxes stacked, editors as full-screen sheets.

Addresses: `/knowledge` with `card={id}` (editor open), `history={card id}`, hashes `#kurallar`,
`#hedefler`, `#oneriler`. `/strategy` and every `/strategy?…` redirect to `/knowledge`. Menu: core
item `Bilgi bankası`. Queries: `['knowledge']` (one read, `GET /api/knowledge`), invalidated by every
knowledge write and by capability changes (the approval line names accounts).

#### 4.11.1 The read: `strategy.knowledge_get`

`GET /api/knowledge` and `jeeta.strategy.knowledge_get` (twins) answer `KnowledgeOut`:

```rust
pub struct KnowledgeOut {
    pub revision: u64,
    pub empty: bool,                                   // §4.5.1
    pub cards: Vec<CardOut>,                           // live, by position: {id, key, title, body, attachments (short-lived links), revision, updated_at, filed: Option<{at, summary}>}
    pub rules: RulesOut,                               // {revision, prohibitions, ad_cap, message_cap, post_approval, post_approval_accounts: [{capability_id, name, kind}], tiktok_connected, metered}
    pub goals: GoalsOut,                               // {revision, items}
    pub notes: Vec<NoteOut>,                           // open ones and the last five closed, newest first, with outcome
    pub notes_agent: AgentReach,                       // {state: none | asleep | late | ok, next_at}
    pub proposals: Vec<ProposalOut>,                   // pending
    pub frame: Option<FrameOut>,                       // §4.10.3; None without a frame
}
```

Permission `workspace.read` (every member and every key); `Exempt`; allowed while `pending_payment`.
It seeds a workspace not seeded yet (§4.3) in a write bundle of its own before reading.

### 4.12 Other readers moved to the knowledge base

| Reader | Today | After |
|---|---|---|
| `inbox.context` | `strategy_guidance {summary: identity, segments, hypotheses}` + the frame's prohibitions, only with an approved version | keeps `strategy_guidance` (summary from the cards as §4.10.1's identity mirror, segments and hypotheses from the frame, without the owner's request and closing topics, A5 risk) and adds `knowledge {cards: [{key, title, body (≤ 2000, truncated flag)}], rules: [..], goals: [..], notes: [open notes' text, ≤ 2000 each, newest first, at most 5], revision}`; prohibitions = the conversation's + the knowledge base's (live); answered without a frame too |
| `studio.slot_get` `brand_rules` | `{identity, prohibitions}` from the frame | `{identity: from the cards (§4.10.1's mirror, live), prohibitions: knowledge base (live), voice: voice card body, notes: open notes as in `inbox.context`, knowledge_revision}` |
| `studio.overview` | `goals` from the frame | `goals.kpis` from Hedefler (live), `objective` from the frame |
| `ads::check_money`, `studio::ads`, paid planner, `validate_reservation` | paid and organic lanes of the frame | the same, now mirrored from Kurallar's `ad_cap` and `message_cap` (§4.6.2, §4.6.4); an organic lane missing (no `message_cap`) = no lane cap; the paid planner skips closing topics |
| `budget::check_general` | item ≤ strategy paid cap (`above_strategy_cap`) | item ≤ Kurallar's `ad_cap` (`above_rules_cap`), read after the item lock; Bütçe writes no frame (§4.6.2) |
| `prospects.playbook` | approved ICP and rubric; text says "propose through the consultation" | same data (frame); text §5.5; `PLAYBOOK_VERSION = 2` and the leads spec's Appendix A in step |
| `research` panel (`data.ts`, `segments.ts`, `TaskRow`, `copy.ts`) | audience names from `/api/strategy`, link "Stratejide değiştir" | audience from `GET /api/strategy` (compat, §5.4); `Bilgi bankasında değiştir` → `/knowledge?card={who_we_seek id}`; `fromStrategy` → `Bilgi bankasından` |
| `ModuleStatusLine` | rows `strategy`, `no-posting`, `paid` | `knowledge` (`Bilgi bankası boş: ajanlar paylaşım hazırlayamaz.` → `/knowledge`), `no-posting` removed, `paid` (`Kurallar'da reklam bütçesi yok.` → `/knowledge#kurallar`) |
| `QueryState`, `StudioShared`, `lib/errors.ts` | `STRATEGY_REQUIRED` → `/strategy` | → `/knowledge`, words of §4.10.11; `no_paid_lane` → `Kurallar'da reklam bütçesi yok.`; `above_rules_cap` and the old `above_strategy_cap` → `Kurallar'daki reklam bütçesini aşıyor.` with `Kurallar'da değiştir` |
| home `WorkFeed`, `copy.ts` | approvals include consult/approve strategy; ledger copy of `strategy.*` | approvals include `knowledge_proposal`, `knowledge_empty`; ledger copy for `strategy.knowledge_changed` (`Bilgi bankası güncellendi`), `strategy.frame_applied` (`Ajanlar bilgi bankasını uyguladı`), `strategy.rules_changed` (`Kurallar güncellendi`), old `strategy.*` copy kept for old entries |
| `modules.rs` strategy module | name `Strateji`, workflow `Hedefi tanımla / Stratejiyi onayla / Sonuçları değerlendir` | name `Bilgi bankası`, description `Ajanların işletmen hakkında bildiği her şey.`, workflow `Bilgiyi yaz`, `Ajanlar okur ve uygular`, `Önerileri değerlendir`; id `strategy` kept |
| content workflow steps 1–3 (`modules.rs`) | `onaylı stratejiden`, `stratejideki kitlelerden`, `bağlı hesaplara ve stratejiye göre` | `bilgi bankasından`, `bilgi bankasındaki müşterilerden`, `alan açılırken seçildiyse ona uy; seçilmediyse bağlı hesapların hepsi arasından, kişinin isteğine göre seç (“sadece TikTok” gibi)` |
| `groups.rs` delete guard | refused while a strategy channel narrows to the group | removed (frames name no group) |
| Bütçe page (`pages/budget`) | general item form with the strategy cap | the line `Kurallar'daki reklam sınırı: ₺{n} · Kurallar'da değiştir` under the general item; the cap field's maximum is `ad_cap` |
| `posts::open_channels`, planner floor, `best_option` | every live hypothesis but the owner's request | also without closing topics (§4.10.6) |
| `agents/keys.tsx`, `production-worker/README.md` | "every key preset reads the strategy" | "reads the knowledge base (`workspace.read`)" |

## 5. The agent contract

### 5.1 Tools

`WORK` below is any of `content.work`, `social.work`, `ads.work`, `materials.work`,
`prospects.work`, `outreach.work`, `inbox.work` (a new constant `knowledge::WORK_PERMISSIONS`).
Descriptions are ASCII and end with the risk tag (registry rule); card keys are written as keys.

**Added** (PR 2: `knowledge_get`; PR 6: the rest):

| Tool | Use case | Permission | Gist of the description |
|---|---|---|---|
| `jeeta.strategy.knowledge_get` | `strategy.knowledge_get` (twin of `GET /api/knowledge`, §4.11.1) | `workspace.read` | "Read the knowledge base the owner keeps for agents: every card (key, title, body, attachments with short-lived links), the rules no agent may cross (prohibitions, the ad budget, the paid-message limit, which accounts' posts wait for the owner's approval), the goals, the notes the owner wrote (open ones bind at once, before they are filed), the pending proposals, and the frame (its number, the knowledge revision each part was derived from, which derivations are due, its audience, objective, topics with has_posts, closing topics and prospecting). Topic ids are what tools that ask for a hypothesis_id take. The owner's edits apply at once: read this at the start of every run. [risk: READ]" |
| `jeeta.strategy.frame_apply` | `strategy.frame_apply` (MCP only) | per part: `posting` `content.work`, `prospecting` `prospects.work`, `paid_cadence` `ads.work` | "Apply what you derived from the knowledge base. Send kb_revision as read and parts, the derivations you answer (posting, prospecting). Send only what changed: a topic, segment or ICP entry that stays is sent exactly as knowledge_get frame has it; a part listed with nothing else is acknowledged as unchanged (applied false). Topics: send every topic that should stay, with its id; one left out gets no new post, is listed under closing while it has planned posts, and is retired by the system after them. A segment a row still uses is kept for you (kept_segments). Identity, channels, prohibitions, goals and budgets are not yours: the system takes them from the cards and the owner's rules. paid_cadence sets the paid cadence of named topics and retires nothing. [risk: WRITE]" |
| `jeeta.strategy.note_claim` | `strategy.note_claim` (MCP only) | `WORK` | "Claim a note the owner wrote to the agents at expected_revision; the answer carries a claim_token and the note (text, links, files with short-lived links). The claim lasts 30 minutes. [risk: WRITE]" |
| `jeeta.strategy.note_file` | `strategy.note_file` (MCP only) | `WORK` | "Close the claimed note with what it asks, in the owner's words: cards (rewrite the body of the card it belongs to, at most three, or a new card; keep what the owner wrote), rules (a prohibition the owner states), goals (a goal the owner states), post_request (the owner asks for a post: it opens a content as if written on the Paylasimlar page), proposals (ids of proposals you made for what you inferred). summary is one line in Turkish the owner reads. Dismiss, with a reason in Turkish, only a note with nothing to act on. The ad budget, the message limit and the approval switch are the owner's alone. [risk: WRITE]" |
| `jeeta.strategy.note_release` | `strategy.note_release` (MCP only) | `WORK` | "Give a claimed note back unfiled. [risk: WRITE]" |
| `jeeta.strategy.proposal_create` | `strategy.proposal_create` (MCP only) | `WORK` | "Propose to the owner a change you learned while working and the owner did not say: a new card, a new text for a card (send its whole new body), a rule or a goal, with a one-line reason in Turkish. Nothing changes until the owner adds it; it closes by itself after 14 days. At most 20 pending, 10 a day from one connection. [risk: WRITE]" |

**Changed** (the social, inbox, studio and budget read changes in PR 2; delivery in PR 4; the rest in
PR 6):

| Tool | Change |
|---|---|
| `jeeta.strategy.get` | the compatibility projection of §5.4 (PR 2); description rewritten |
| `jeeta.work.pending` | `knowledge` state, new kinds, `strategy` reduced (§5.2); description rewritten |
| `jeeta.content.area_deliver` | `hypothesis_id`: required for an area an agent or the system opened ("a topic id of jeeta.strategy.knowledge_get frame.topics", as today); optional for an area a person asked for ("leave it out: the post is the owner's request and is measured on its own; name a topic only when the request is plainly that topic"); never the owner's request's id (refused as today). A delivered person-requested content wakes the social agent |
| `jeeta.social.versions_waiting`, `version_schedule`, `accounts_list`, `account_get` | `knowledge_empty` replaces `no_approved_strategy`; `braked` added; `channel_not_in_strategy`, `no_hypothesis`, `prepare_strategy`, `approve_strategy` gone; `human_gate` and `requires_human_approval` from the effective post gate; texts say "topic" for the attribution |
| `jeeta.inbox.context` | adds `knowledge` (with open notes); prohibitions from the knowledge base; answers without a frame; "Read recent conversation context and the knowledge base" |
| `jeeta.studio.slot_get` | `brand_rules` per §4.12 |
| `jeeta.studio.overview` | goals from Hedefler |
| `jeeta.studio.material_analysis_complete` | new input `sensitive_checked: bool` (default false); "read jeeta.strategy.knowledge_get (products_prices, who_we_are) to reuse groups and labels; look for every face, name, child, client logo and corporate reference and mark each in depicts, every named person in people, then send sensitive_checked true: a file a person attached to a post becomes shareable by itself only when you checked and found none" |
| `jeeta.studio.posts_propose`, `trend_record`, `judgment_record`, `jeeta.ads.plan_submit`, `campaign_move`, `jeeta.studio.adset_bind`, `project_schedule` | "hypothesis_id: a topic id of jeeta.strategy.knowledge_get frame.topics" in place of "of the approved strategy" |
| `jeeta.prospects.playbook`, `score`, … ; `jeeta.research.tasks_*` | "the ICP and rubric of the frame, derived from the card who_we_seek"; `prospecting_off`: "the knowledge base has no ICP yet: derive it (knowledge_derive, part prospecting)"; changes "through jeeta.strategy.frame_apply (prospecting) when the card says so, else jeeta.strategy.proposal_create" |
| `jeeta.budget.items_create`, `items_update` | "the general ad budget may not exceed the ad budget of the owner's rules (Kurallar, knowledge_get rules.ad_cap): above it is refused (above_rules_cap). You may lower it; only the owner raises the ceiling, in Kurallar." |
| `jeeta.outreach.campaigns_save`, `jeeta.calls.*`, `jeeta.workspace.info`, `jeeta.studio.ledger`, `jeeta.content.olay_view`, `jeeta.modules.remove` | "approved strategy" → "a frame (the knowledge base has a card)"; "strategy gate" → "knowledge gate"; `modules.remove`: "Inbox and the knowledge base cannot be removed"; `studio.ledger` drops "also after strategy archive" |

**Kept for compatibility, then removed in PR 7** (after the routines moved, §5.6):
`jeeta.strategy.start_consultation`, `record`, `write_section`, `set_hypotheses`, `submit`,
`approve`, `archive`, `list_versions`, `consultation`, and `jeeta.studio.hypothesis_propose`. Until
then they work on the internal frame, and an approval re-syncs the knowledge base in the same
transaction (§4.3.4); `archive` refuses on a seeded workspace (`use_brake`). Their descriptions gain
the first sentence
`Retired soon: the strategy is the knowledge base now; read jeeta.strategy.knowledge_get and apply with jeeta.strategy.frame_apply.`
The panel-only `strategy.add_channel` is removed in PR 2 (nothing calls it once the Stops action is
gone, K6).

Counts at the end (PR 7): catalog 303 − 11 + 24 = **316** rows (the 24: `content.posts`,
`post_get`, `post_request`, `files_add`, `special_day_skip`, `version_cancel`, `post_dismiss`;
`strategy.knowledge_get`, `card_create`, `card_update`, `card_archive`, `card_history`,
`rules_save`, `goals_save`, `post_approval_set`, `note_add`, `note_withdraw`, `note_claim`,
`note_file`, `note_release`, `proposal_create`, `proposal_accept`, `proposal_skip`,
`frame_apply`); MCP tools 244 − 10 + 6 = **240** (registry, `m4_productisation` `POST_M4_ADDED` /
`POST_M4_REMOVED` / `POST_M4_PANEL_ONLY`, the `m3_surface.json` fixture, `twin_rule` strategy twins
10 → 2). Each PR updates the pins it moves (§8.4).

### 5.2 `work.pending`

```rust
pub struct PendingOut {
    pub knowledge: KnowledgeState,
    /// Deprecated, removed in PR 7: `"missing"` without a frame, `{"approved": {"number": n}}` with one.
    pub strategy: StrategyState,
    pub items: Vec<WorkItem>,
    pub agent: AgentState,
}
pub struct KnowledgeState {
    pub empty: bool,
    pub revision: u64,
    pub frame: Option<i32>,                 // the frame's number
    pub derive_due: Vec<DerivePart>,        // posting | prospecting
}
```
`StrategyState::DraftOpen` and `Submitted` are never produced (no drafts); `WorkKind::ConsultStrategy`
and `ApproveStrategy` are removed. Conditions that read `strategy.approved.is_some()` read
`knowledge.frame.is_some()` (the same thing). New kinds (each with `cleared_by`, a work module for
assignment filtering, and listed only to a caller who can clear it — the `consult_strategy` leak of
A5 is not repeated):

| Kind | Fields | Listed to | Work module | Priority | `cleared_by` | Hint (English, for the agent) |
|---|---|---|---|---|---|---|
| `knowledge_derive` | `kb_revision`, `part` | posting: agent with `content.work`, while `posting_revision > posting_derived`; prospecting: agent with `prospects.work`, while `prospecting_revision > prospecting_derived` | posting: none (as the `KNOWLEDGE` need); prospecting: the `RESEARCH` need's | 2 | `strategy.frame_apply` | posting: "The owner changed a card the posting work is derived from. Read jeeta.strategy.knowledge_get and derive from the cards (who_we_are, products_prices, customers, post_ideas, past_conversations and the owner's own cards) the audience (segments), the topics (what posts are about) and, when it changed, the objective. Send only what changed: a topic or segment that stays is sent exactly as frame.topics and frame.audience have it (same id, key, title, angle, metric); a reworded card is no reason to reword a topic; a topic whose meaning changed is a new topic (no id). At most 30 topics. A topic you leave out gets no new post, waits under frame.closing while it has planned posts (has_posts), and is retired after them. Apply with jeeta.strategy.frame_apply, parts [posting] and the kb_revision you read; when nothing changed send parts [posting] alone: it answers applied false and clears this item. Identity, channels, prohibitions, goals and budgets are not yours: the system takes them from the cards and the owner's rules." prospecting: "The owner changed whom the business looks for (cards who_we_seek, customers or the owner's own cards). Read jeeta.strategy.knowledge_get (frame.prospecting is the ICP and rubric in force, frame.audience the segment keys) and jeeta.prospects.playbook, and derive the ICP entries and the rubric. Send an entry that stays exactly as frame.prospecting.icp has it (same key, same text: its standing research task and today's count carry over); a new or changed entry gets a new key. segment_key is a key of frame.audience; for a kind of business no segment covers, add the segment in prospecting.segments (key, name, description). Change the rubric only when a card asks for it: scores of the old rubric become stale (rubric_mismatch). Apply with jeeta.strategy.frame_apply, parts [prospecting] and the kb_revision you read; nothing changed: parts [prospecting] alone." |
| `knowledge_note` | `note_id`, `expected_revision` | agent with any `WORK` permission | none | 2 | `strategy.note_claim` | "The owner told the agents something. Claim the note with jeeta.strategy.note_claim, read its text, links and files, and close it with jeeta.strategy.note_file with what it asks, as the owner's own words: cards (knowledge: send that card's whole new body keeping everything the owner wrote, or a new card when none fits), rules (a prohibition the owner states), goals (a goal the owner states), post_request (the owner asks for a post), and proposals (ids of proposals you made with jeeta.strategy.proposal_create for what you inferred and the owner did not say). summary is one line in Turkish the owner reads. Dismiss only a note with nothing to act on, with a reason in Turkish that says where the answer is. The ad budget, the message limit and the approval switch are the owner's alone: a note asking to change them is dismissed with a reason that sends the owner to Kurallar. After filing, call jeeta.work.pending again and do the knowledge_derive it lists." |
| `knowledge_proposal` | `proposal_id` | person with `team.manage` | none | 3 | `strategy.proposal_accept` | "An agent proposed a change to the knowledge base; the owner adds or skips it in Bilgi bankasi." |
| `knowledge_empty` | — | person with `team.manage` | none | 1 | `strategy.card_update` | "The knowledge base is empty: nothing is planned, delivered or sent until the owner writes at least one card in Bilgi bankasi (or adds a proposal waiting there)." |

A version blocked `hypothesis_does_not_post` lists no item: it cannot arise under a normalised frame,
and `knowledge_settle` normalises a frame whose live topic lacks a usable organic cadence (§4.10.6).

Hints rewritten:

- `CONTENT_AREA_HINT` (replaces the constant in `work.rs`):
  "Carry this production area to a content package; nobody approves it in between. (1) Read
  jeeta.strategy.knowledge_get (cards, rules, goals, open notes) and jeeta.studio.project_get:
  `brief` is the goal in the owner's words when a person asked for it; `hints` holds a platform or
  format a person chose (empty: you choose, among every connected account; when the brief names a
  platform, such as 'sadece TikTok', make versions only for it and set their capability_id);
  `redo_note` on this item, when present, says what the person wants changed. Never cross the rules:
  the prohibitions are the owner's and bind every word you write. (2) Take the area with
  jeeta.content.area_claim …" — steps (2) to (4) unchanged — "(5) Deliver every platform version in
  one call to jeeta.content.area_deliver. hypothesis_id: when a person asked for this area
  (requested_by), leave it out (the post is the owner's request); otherwise name the topic of
  frame.topics the version is about; never name the owner's request. With no connected account leave
  capability_id out. A refusal lists, by version index, what to fix: fix it and deliver again with a
  new request_key. Three refusals in a row hand the area to a person. An accepted delivery finishes
  the area; when a person asked for it, the social agent is woken for its time."
- material analysis (`work.rs:563`): `Read jeeta.strategy.get and …` → `Read jeeta.strategy.knowledge_get (products_prices, who_we_are) and …`, and the depicts sentence of §5.1 with `sensitive_checked`.
- `ADS_PLAN_HINT`: `Read the strategy (jeeta.strategy.get) for the paid hypotheses and …` →
  `Read jeeta.strategy.knowledge_get: the ad budget of its rules is the hard limit every campaign is held against, and frame.topics are the ids each ad names as hypothesis_id; a topic you run ads for needs a paid cadence: set it with jeeta.strategy.frame_apply paid_cadence (it retires nothing); read …`.
- `SOCIAL_SCHEDULE_HINT`: last sentence → `The post goes out under the topic its choice names (attribution); you choose none. A content a person asked for without naming an account may go out on any account it lists.`
- `jeeta.work.pending` description: the `knowledge` state, the four new kinds, `strategy`
  deprecated; "prospects to score under the frame's rubric".

### 5.3 Wakes

`ports/wake.rs` `WakeReason` gains (serde names, fixed ASCII sentences), and an `Unknown` fallback
dropped on read (PR 1, §4.2):

| Reason | Sentence |
|---|---|
| `knowledge_changed` | `A person changed the knowledge base.` |
| `knowledge_note` | `A person told the agents something to file in the knowledge base.` |
| `knowledge_applied` | `The knowledge base changed what the agents work from.` |
| `content_delivered` | `A content a person asked for is ready for its time.` |
| `account_connected` | `A person connected an account that unsent posts can take.` |
| `posting_resumed` | `A person resumed posting: posts waiting for a time can go out again.` |

`StrategyApproved` stays deserialisable and is produced only by `strategy.approve` until PR 7.
`wake.rs` `Need` gains `KNOWLEDGE {key: "knowledge", permission: ContentWork, module: None}`;
`NEEDS` becomes 7 entries (the panel's agents page and `AgentWakeLine` get the label
`Bilgi bankası`). `request_for(repos, ctx, needs, reason, person)` records the request as
`request` does, for an action the system or an agent takes because `person` asked.

| Site | Reason | Needs | Requested |
|---|---|---|---|
| a card create/update/archive or an accepted card proposal that moves `posting_revision` / `prospecting_revision` | `knowledge_changed` | `KNOWLEDGE` / `RESEARCH`, as moved | in person (`request`) |
| `rules_save`, `goals_save`, `post_approval_set`, an accepted rule or goal proposal | — | none (read live) | — |
| `note_file` (agent) with cards that move a revision | `knowledge_changed` | `KNOWLEDGE` / `RESEARCH`, as moved, the filer's own key included | `request_for` the note's person |
| `note_file` with `post_request` | `content_requested` (no files) / `material_uploaded` (files) | `CONTENT` / `MATERIALS` | `request_for` the note's person |
| `note_add` | `knowledge_note` | `KNOWLEDGE`, `RESEARCH` | in person |
| frame apply `rules` (a cap changed) | `knowledge_applied` | `ADS` | in person |
| frame apply `derive` | `knowledge_applied` | per changed structural part: `SOCIAL`, `ADS`, `RESEARCH` | `request_for` `changed_by` |
| frame apply `bootstrap` | `knowledge_applied` | `CONTENT`, `SOCIAL` | in person, or `request_for` the note's person |
| `knowledge_settle` (repair, normalise, close) | — | none | — |
| `content.post_request` | `content_requested` (no files) / `material_uploaded` (files) | `CONTENT` / `MATERIALS` | in person |
| a person's upload becoming usable (§3.4.4): the last pending file of an area shared by rule / by `İzin ver` or removed | `content_requested` (`capture_answered` for a capture answer) | `CONTENT` | `request_for` the uploader / in person |
| `content.files_add` | `material_uploaded` | `MATERIALS` | in person |
| a special day's file becoming usable while its preparation has started (`content.files_add`, `material_analysis_complete`, `material_permission`) | `content_requested` | `CONTENT` | in person / `request_for` the uploader |
| `studio.material_delete` emptying an area's pending files | `content_requested` | `CONTENT` | in person |
| `content.area_deliver` accepted, `requested_by` set | `content_delivered` | `SOCIAL` | `request_for` `requested_by` |
| `connector.complete_oauth`, `connector.confirm_assets`, `capabilities.verify` making a social account postable while an unsent version waits blocked `no_connected_account`, `its_account_unavailable` or `format_not_supported`, or a failed post's account was the cause | `account_connected` | `SOCIAL` | in person, or `request_for` the person who started the connection |
| `studio.brake` releasing the organic lane, by a person | `posting_resumed` | `SOCIAL` | in person |
| `strategy.approve` | `strategy_approved` | `SOCIAL`, `ADS`, `RESEARCH` | until PR 7 |

The calendar trigger a special-day file starts runs in `content.files_add` (or the analysis or
permission write that made the file usable), never in `planner.rs`'s own tick.
`jt_archtest/tests/wake_triggers.rs`' guard `the_clocks_own_work_wakes_nobody` also matches
`wake::request_for(` in `jobs.rs` and `planner.rs`, and its `TRIGGERS` table gets one row per site
above (§8.4).

### 5.4 `jeeta.strategy.get`: the compatibility projection (K7)

`StrategyOut { approved, draft: null, gaps: [], knowledge }` — `knowledge` is new (the
`KnowledgeOut` of `knowledge_get`). `approved` is null until a frame exists; else the frame's
`VersionOut` with these fields replaced, so a routine reading the old paths gets the owner's live
words:

| Path | Value |
|---|---|
| `approved.sections.identity` | §4.10.1's mirror computed now from the live cards (`product`, `voice`, `positioning`), `usp` the frame's |
| `approved.sections.prohibitions` | the knowledge base's prohibitions (live) |
| `approved.sections.goals` | `{objective: frame's, kpis: Hedefler as [{name: line, target: ""}]}` (live) |
| `approved.sections.audience`, `prospecting`, `budget_frame`, `paid_enabled`, `cadence` | the frame's (its lanes are Kurallar's caps) |
| `approved.sections.channels` | `[{channel: "any", rationale: "", group_id: null}]` |
| `approved.hypotheses` | the frame's, without the owner's request and closing topics |
| `approved.gaps`, `assumptions` | `[]` |
| `approved.id`, `number`, `approved_at`, `status` | the frame's (`approved`) |

Description: "Read the knowledge base in the shape older routines read the strategy:
approved.sections.identity (product, voice and positioning from the owner's cards), prohibitions and
goals (the owner's rules and goals), audience and prospecting (derived), hypotheses (the topics), and
knowledge (everything jeeta.strategy.knowledge_get answers). approved is null until the knowledge
base has a card. The owner's edits apply at once: nothing here waits for an approval. Prefer
jeeta.strategy.knowledge_get. [risk: READ]" The panel route `GET /api/strategy` answers the same
(twin), read by the research and prospects pages for audience names. It ships in PR 2, with the
seeding, so that a routine still reading `strategy.get` sees the owner's card and Kurallar edits the
moment they are made.

### 5.5 Agent-facing texts that change (complete list)

| File | Today | After |
|---|---|---|
| `jt_mcp/src/tools/strategy.rs:30-35` | consultation protocol | §5.4 |
| `jt_mcp/src/tools/strategy.rs` (other 9 tools) | consultation tools | "Retired soon" sentence (PR 6), removed (PR 7) |
| `jt_mcp/src/tools/work.rs:23-63` | strategy states, consult/approve kinds | §5.2 |
| `jt_mcp/src/tools/content.rs:14` | "Needs no approved strategy" | "Needs no frame" |
| `jt_mcp/src/tools/social.rs:14,21,28` | blocked reasons with strategy codes, hypothesis attribution | §5.1 row |
| `jt_mcp/src/tools/studio.rs:23,58,72,93,113-119,142,163,181-182,205-206,230,254,354,403,521-522` | "approved strategy", "hypothesis of the approved strategy", "strategy draft", retirement reasons | "frame", "topic id of jeeta.strategy.knowledge_get frame.topics"; `hypothesis_propose` "Retired soon"; retirement reasons kept as codes |
| `jt_mcp/src/tools/inbox.rs:125` | "strategy guidance" | "the knowledge base" |
| `jt_mcp/src/tools/prospects.rs:28-29,119-124,134,213,457-459` | approved ICP and rubric, consultation | frame's ICP and rubric derived from `who_we_seek`; changes via `frame_apply` or `proposal_create` |
| `jt_mcp/src/tools/research.rs:29-32,55-58,79-80,128` | ICP entry of the approved strategy, `prospecting_off` | frame; `prospecting_off` wording of §5.1 |
| `jt_mcp/src/tools/budget.rs:166-168` | cap within the strategy's paid cap | §5.1 row |
| `jt_mcp/src/tools/outreach.rs:113`, `calls.rs:82`, `projects.rs:86`, `workspace.rs:14-16`, `modules.rs:39` | approved strategy / strategy gate | §5.1 row |
| `jt_app/src/usecases/work.rs:563, 1404-1429, 1444-1448, 1488-1498, 953` | §5.2 | §5.2; `campaign_blocked` hint drops "or the strategy" |
| `jt_app/src/usecases/content/mod.rs:67-71` | `hypothesis_id` required "of the approved strategy" | a topic id of the frame; optional only for an area a person asked for (§3.5) |
| `jt_app/src/usecases/modules.rs:15-16, 102-123` | Strateji module and content steps | §4.12 |
| `jt_prospects/src/playbook.rs:1-9, 78-79` | "propose it … through the strategy consultation (jeeta.strategy.start_consultation); it applies once approved" | "The ICP and the rubric come from the knowledge base (card who_we_seek): when the card says something the frame does not, apply it with jeeta.strategy.frame_apply (prospecting); when you learned something the card does not say, propose it with jeeta.strategy.proposal_create." `PLAYBOOK_VERSION = 2`; the leads spec's Appendix A updated in the same PR |
| `jt_app/src/error.rs` `strategy_required` message | "an approved strategy is required first" | "the knowledge base is empty: the owner fills it in Bilgi bankasi first" (code unchanged) |

### 5.6 What the external routines must change

The routines are outside the repo; these blocks are written to be pasted. Order: after PR 6 is live
(the new tools exist, the old ones still work and re-sync the knowledge base), before PR 7 (the old
ones go).

**Content routine** — replace every step that reads `jeeta.strategy.get`, runs the consultation or
approves, and the rule "schedule only on accounts whose policy has requires_human_approval true"
(design 2026-11-19 G1), with:

```text
Every run:
1. Call jeeta.work.checkin, then jeeta.strategy.knowledge_get. The cards, the rules and the goals are
   the owner's own words and apply at once. The rules bind you: never write against a prohibition,
   never plan spend beyond the ad budget.
2. Do the items of jeeta.work.pending in priority order:
   - knowledge_note: claim, then close it with note_file as it asks: cards (the card's whole new
     body, keeping the owner's text), rules, goals, a post request, or proposals for what you
     inferred; summary in Turkish; dismiss only what has nothing to act on. Then call
     jeeta.work.pending again.
   - knowledge_derive (part posting): derive the audience, the topics and the objective from the
     cards. Send only what changed; send what stays exactly as knowledge_get frame has it (same ids,
     keys and words); nothing changed: parts [posting] alone. Apply with jeeta.strategy.frame_apply
     and the kb_revision you read. Never send identity, channels, prohibitions, goals or budgets.
   - content_area: follow the item's hint. When the brief names a platform ("sadece TikTok"), make
     versions only for it. hypothesis_id: leave it out when a person asked for the area; otherwise a
     topic id of frame.topics.
   - social_schedule: every account jeeta.social.versions_waiting lists may be scheduled; a
     human_gate means the owner acts after scheduling (approval or TikTok's screen), not that you
     must not schedule there.
   - studio_material_analysis: look for faces, names, children, client logos and corporate
     references and mark each in depicts, named people in people, then send sensitive_checked true;
     never set a share permission.
3. When you learn something the cards do not say (a question customers keep asking, a topic that
   works), propose it with jeeta.strategy.proposal_create: one line of reason in Turkish.
Never call jeeta.strategy.start_consultation, record, write_section, set_hypotheses, submit,
approve or archive, nor jeeta.studio.hypothesis_propose: they are being removed.
```

**Research routine** — replace the strategy and consultation steps with:

```text
Every run:
1. Call jeeta.work.checkin, then jeeta.strategy.knowledge_get and jeeta.prospects.playbook.
2. knowledge_derive (part prospecting): derive the ICP entries and the rubric from the cards
   who_we_seek and customers. Send an entry that stays exactly as frame.prospecting.icp has it (same
   key and text: its standing research task and today's count carry over); a new or changed entry
   gets a new key; a segment the audience lacks goes in prospecting.segments. Change the rubric only
   when a card asks for it. Apply with jeeta.strategy.frame_apply, parts [prospecting] and the
   kb_revision you read; nothing changed: parts [prospecting] alone.
3. research_due, prospects_to_score, prospects_to_promote: as the playbook says (version 2). Score
   with the rubric_digest of the playbook.
4. knowledge_note items you can file (a note about whom to look for): file them into who_we_seek;
   then call jeeta.work.pending again.
5. Never call jeeta.strategy.start_consultation or any consultation tool; to change whom we look
   for beyond what the card says, propose it with jeeta.strategy.proposal_create.
```

Other routines: the inbox routine reads `jeeta.inbox.context.knowledge` (or
`jeeta.strategy.knowledge_get`), open notes included; the ads routine reads
`jeeta.strategy.knowledge_get` (the ad budget of the rules is its hard limit; `jeeta.budget.items_*`
can only lower the general item) and sets a topic's paid cadence with `jeeta.strategy.frame_apply`
`paid_cadence` when it runs ads for a topic that has none. Nothing else changes for them.

## 6. Every blocker and major touchpoint, resolved

All 145 blocker (B) and major (M) touchpoints of the map, by area (A0 strategy, A1 content, social
and studio, A2 the gate and the other modules, A3 the panel pages, A4 the server reads and writes,
A5 the agent contract, A6 the data model). Minor touchpoints fall under the same sections
(cross-links §2.13, agent texts §5.5, readers §4.12). Paths are the map's, shortened.

| # | Sev | Where | Decision |
|---|---|---|---|
| A0.1 | B | `rust/crates/domain/jt_strategy/src/sections.rs:14-345 + parse.rs:22-245` | Kept as the frame's internal schema (K1); owner knowledge lives in the 0046 tables (§4.2); cards to frame §4.10.1; sections to cards §4.3.2. |
| A0.2 | M | `rust/crates/domain/jt_strategy/src/rules.rs:71-362` | No owner-facing gate. Reused as the validation of a frame apply, minus every channel rule, and only on what the call brought (§4.10.2 step 6). |
| A0.3 | B | `rust/crates/domain/jt_strategy/src/version.rs:15-71; jt_pg/src/repos/strategy.rs:168-378; migrations/0002_strategy.up.sql:16-36` | Versions stay append-only; a frame is a new version inserted and approved by the system in one transaction (§4.10.2); no in-place edit path. |
| A0.4 | B | `rust/crates/jt_app/src/usecases/strategy.rs:258-711 (start_consultation, record, write_section, set_hypotheses, submit, approve)` | Replaced by card, rules, goals, note and proposal writes (§4.4–§4.9) and `frame_apply` (§4.10.3); approve's side effects move into `knowledge::frame::apply`; until PR 7 an old approval re-syncs the cards (§4.3.4); the old use cases are removed in PR 7. |
| A0.5 | M | `rust/crates/jt_app/src/usecases/strategy.rs:713-798 (archive)` | Refuses on a seeded workspace from PR 2 (`use_brake`, §4.3.4), removed in PR 7 (D10); the owner's stop is `Tüm paylaşımları durdur` in Ayarlar (`studio.brake`), shown on the page when on (§2.2); frames are never withdrawn. |
| A0.6 | M | `rust/crates/jt_app/src/usecases/strategy.rs:800-1003 (add_channel) + panel/src/pages/social/Stops.tsx:44-66,104-106` | Removed in PR 2 with the `prepare_strategy` action (K6). |
| A0.7 | M | `sections.channels consumers: jt_studio/src/chain.rs:192-197; studio/posts.rs:142-150,211; studio/planner.rs:414-417,477; studio/views.rs:106-115; studio/ads.rs:88; studio/trends…` | Frames always carry `channels = [any]` (§4.10.1); every listed consumer already accepts `any`; only `channel_not_in_strategy` (ready, why_blocked) and the group delete guard are removed (§3.10.2, §4.12). |
| A0.8 | B | `rust/crates/domain/jt_strategy/src/hypothesis.rs + strategy_hypotheses table (0002:38-53, 0009:5-15)` | Kept internal as topics, derived by agents (`frame_apply.topics`) with stable ids (given, or matched by title), channel `any`, default organic cadence (§4.10.2, §4.10.10). |
| A0.9 | B | `migrations/0009_studio.up.sql:21-150; 0020_prospects.up.sql:32-33; 0026_outreach.up.sql:52` | Untouched: no version or hypothesis row is deleted or rekeyed; every frame is a new row. |
| A0.10 | B | `jt_app/src/gate.rs:11-35,164-212; jt_pg/src/strategy_gate.rs:27-45; catalog.rs (83 Gated rows); jt_app/src/error.rs:24-25,149-152` | Predicate unchanged (K3); a frame exists from the first card (bootstrap, §4.10.5); message and panel words changed (§4.10.11); catalog modes unchanged but `posting_policy_set` and the four stop rows (D12). |
| A0.11 | B | `lock_execution_frame / current_approved callers (~40): studio/chain.rs:238-242, studio/budget.rs:15-53, ads/mod.rs:195-218, studio/planner.rs:123, social/schedule.rs:170-178,761…` | Unchanged: once the knowledge base has a card a frame always exists; frame apply, `rules_save` and bootstrapping writes take the locks in the one order of §4.10.13 (approve's "draft before frame", then settings, then control and items). |
| A0.12 | M | `jt_app/src/usecases/studio/owner_request.rs:1-164; social/schedule.rs:166-178,781-815; posts.rs:964-971; content/delivery.rs:161-163` | Kept; carry-over moved into frame apply (§4.10.2 step 3); `names()` covers a person's request naming nothing; a person's request is delivered and measured under the owner's request (§3.5). |
| A0.13 | M | `jt_app/src/usecases/studio/trends.rs:121-194; jt_pg/src/repos/hypotheses.rs:112-154` | Removed in PR 7; agents propose knowledge (`proposal_create`, §4.9) and derive topics (`frame_apply`, §4.10.3). |
| A0.14 | M | `jt_strategy/src/consultation.rs + consultation_entries (0002:55-82) + jt_pg/src/repos/consultation.rs` | Log kept append-only and FK-bound (system entries for every apply); its answers and notes seed `Önceki görüşmeler` (§4.3.1); the owner's notes use `knowledge_notes` (§4.8). |
| A0.15 | M | `jt_app/src/usecases/research.rs:198-260; prospects/playbook.rs:85-112; jt_prospects/src/playbook.rs:76-79` | K5 carry (§4.10.7); the research agent derives ICP and rubric (§4.10.4); playbook version 2 (§5.5). |
| A0.16 | M | `budget_frame/paid_enabled consumers: ads/mod.rs:204-245; budget.rs:569-590; studio/ads.rs:83,480,584,862; studio/budget.rs:96,283; studio/chain.rs:402-410; studio/control.rs:457…` | The paid lane is mirrored from Kurallar's `ad_cap` and the organic lane from `message_cap` (§4.6.2, §4.6.4); `check_general` compares against `ad_cap`; readers unchanged; an organic lane is never dropped, and a missing one (a frame that never had one) is no lane cap (D3). |
| A0.17 | M | `jt_app/src/usecases/inbox/context.rs:444-462; studio/work.rs:439-442; content/mod.rs:67-71` | `inbox.context` and `slot_get` read the knowledge base live (§4.12); delivery's `hypothesis_id` optional only for a person's request (§3.5). |
| A0.18 | M | `jt_app/src/usecases/work.rs:121-143,387-388,1133-1186` | `KnowledgeState` and the four new kinds; consult/approve kinds removed (§5.2). |
| A0.19 | M | `rust/crates/adapters/jt_mcp/src/tools/strategy.rs:26-380; jt_app/src/catalog.rs:435-448` | Six tools added, `get` re-described as the compatibility projection, nine plus `hypothesis_propose` removed in PR 7 (§5.1). |
| A0.20 | M | `rust/crates/adapters/jt_panel_http/src/routes/strategy.rs:1-214; routes/mod.rs:250-260,1354-1413` | `GET /api/strategy` kept (compat twin); write routes refuse `use_knowledge_base` from PR 3 and are removed in PR 7; `/api/knowledge` routes added (§4.4–§4.9). |
| A0.21 | M | `rust/panel/src/pages/StrategyPage.tsx; pages/strategy/{sections.tsx,HypothesesSection.tsx,BriefNavigation.tsx,queries.ts}; components/{ApproveDialog,ConsultationLog,GapList,Hypo…` | Replaced by the Bilgi bankası page (PR 3, §4.11); ApproveDialog, ConsultationLog, GapList, HypothesisTable, KindSelect, BriefNavigation, sections, HypothesesSection, api/strategy writes deleted; StrategyLearned becomes `Neler işe yarıyor`. |
| A0.24 | M | `Tests: jt_app/tests/strategy.rs (2803 lines), jt_pg/tests/strategy_repos.rs (1476), jt_strategy/tests/rules.rs (1010), jt_panel_http/tests/strategy_http.rs (595), jt_testkit/src…` | Lifecycle tests rewritten for the frame engine and the compat projection; repo tests kept (versions are still written); fakes extended (§8). |
| A1.1 | B | `rust/crates/jt_app/src/catalog.rs:231-254, 266, 268-269, 300, 337, 340-344 (GateMode::Gated rows) + rust/crates/jt_app/src/gate.rs:190-201 + rust/crates/adapters/jt_pg/src/strat…` | Predicate unchanged; with the bootstrap every workspace with a card has a frame, so the panel's actions run; `posting_policy_set` becomes Exempt (D12). |
| A1.2 | B | `rust/crates/jt_app/src/usecases/studio/work.rs:94-107 (gated) and every caller: work.rs:113,370,465,484; posts.rs:536,687,1112,1243,1412; pieces.rs:246,428,457; materials.rs:403…` | Unchanged: `gated()` still locks and returns the frame; its `.sections` are now system-maintained, `.id` the frame's. |
| A1.3 | B | `rust/crates/adapters/jt_pg/src/repos/strategy.rs:169-179; rust/crates/jt_app/src/ports/mod.rs:727-738; lock-only callers measure.rs:20,425,617, learning.rs:402, publish.rs:358,5…` | Unchanged: lock plus frame read; frame apply takes it after the draft lock as approve did. |
| A1.4 | B | `rust/migrations/0009_studio.up.sql:21-150 (FKs to strategy_hypotheses and strategy_versions); rust/crates/adapters/jt_pg/src/repos/studio/queue.rs:14-16,65-80; rust/crates/adapt…` | Unchanged: claims find the frame once the knowledge base has a card. |
| A1.5 | B | `rust/crates/jt_app/src/usecases/studio/chain.rs:231-389 (authorize_execution_at), 392-444 (check_caps); rust/crates/domain/jt_studio/src/chain.rs:120-202 (ChainContext, validate…` | Rules unchanged; channel checks pass via `any`; `capability_requires_human_approval` fed by the effective post gate (§3.10.1); caps from the mirrored lane. |
| A1.6 | B | `rust/crates/jt_app/src/usecases/studio/planner.rs:121-136, 312-354 (no-strategy early return; triggers), 586-632 (Triggers::run), 968-1094 (floor), 361-521 (plan_paid)` | Unchanged: triggers run once a frame exists; the floor trigger chooses among derived topics, never a closing one (§4.10.6); `SlotUnfilled` names a topic title (owner words). |
| A1.7 | B | `rust/crates/jt_app/src/usecases/studio/posts.rs:103-262 (ChannelOption, content_types, selected, open_channels, channels, best_option)` | Unchanged code: options = live topics × organic content type on every connected account (normalised frame). |
| A1.8 | B | `rust/crates/jt_app/src/usecases/studio/posts.rs:559-1069 (ProposedPost.hypothesis_id, posts_propose_locked, check_item); rust/crates/domain/jt_studio/src/package.rs:90-104, 275-…` | Contract kept; agents name topic ids from `knowledge_get.frame.topics`; refusal codes never reach the owner (rows show waits). |
| A1.9 | B | `rust/crates/jt_app/src/usecases/social/schedule.rs:117-357 (version_schedule), 642-863 (Attribution, why_blocked, VersionAccounts::load/pick/of), 866-899 (waiting)` | `knowledge_empty` replaces `no_approved_strategy`; `channel_not_in_strategy` removed; `hypothesis_does_not_post` kept as a defensive code that lists a derivation (§3.2.4, §3.10.2). |
| A1.10 | B | `rust/crates/jt_app/src/usecases/content/delivery.rs:41, 148-166, 254-349, 364-432; rust/crates/jt_app/src/usecases/content/mod.rs:67-71` | Stays Gated (areas are offered only with a frame, §4.10.11); `hypothesis_id` optional only on a person's request, which the server attributes to the owner's request (§3.5); required, as today, on agent and system areas. |
| A1.11 | B | `rust/crates/jt_app/src/usecases/studio/control.rs:79-169 (hypothesis_live, approve); rust/crates/jt_app/src/usecases/studio/tiktok.rs:158-173, 388-405, 530-629; rust/crates/jt_a…` | Gates unchanged; `hypothesis_inactive` only on a race because a topic a planned or ready post, a binding or an ad names is never retired and keeps the cadence its posts use (D9, §4.10.2 steps 2–3); a person's post cancel takes `social.manage` or `content.manage` (D13). |
| A1.12 | B | `rust/crates/jt_app/src/usecases/studio/lifecycle.rs:13-24; rust/crates/adapters/jt_pg/src/repos/studio/mod.rs:359-374; rust/crates/jt_app/src/usecases/studio/posts.rs:457-502; r…` | Runs on every frame apply; topics a planned or ready post, a binding or an ad names stay kept and closing (D9); F4 frees the rest. |
| A1.13 | M | `rust/crates/jt_app/src/usecases/studio/owner_request.rs:1-140; schedule.rs:170-178, 785-815; strategy.rs:617-623; content/delivery.rs:161-163; posts.rs:191-200, 964-971` | As A0.12. |
| A1.14 | M | `rust/crates/jt_app/src/usecases/social/ready.rs:24-65, 100-212; rust/crates/jt_app/src/usecases/social/accounts.rs:306-326, 488-492; rust/crates/jt_app/src/usecases/content/view…` | Strategy stops removed, `knowledge_empty` added, approval from the effective gate (§3.10.2). |
| A1.15 | M | `rust/crates/jt_app/src/usecases/strategy.rs:800-1003 (add_channel) + rust/crates/jt_app/src/catalog.rs:446-448 + rust/panel/src/api/strategy.ts:25-29 + rust/panel/src/pages/soci…` | Removed in PR 2. |
| A1.16 | M | `rust/crates/jt_app/src/usecases/content/pipeline.rs:169-188, 266-308, 326-335, 577-583; rust/crates/jt_app/src/usecases/content/views.rs:415-484, 632-667, 729-736, 815-816, 973-981` | Blocked codes mapped to owner waits (§3.2.4); retirement reasons stay internal (a retired post is no row). |
| A1.17 | M | `rust/crates/jt_app/src/usecases/studio/work.rs:19-47, 388-450 (SlotOut.hypothesis, brand_rules)` | `brand_rules` from the knowledge base (§4.12). |
| A1.18 | M | `rust/crates/jt_app/src/usecases/studio/pieces.rs:233-377, 527-611` | Unchanged; the chain passes under normalised frames. |
| A1.19 | M | `rust/crates/jt_app/src/usecases/studio/publish.rs:165-226, 249-300, 1243-1292` | Unchanged; an apply never retires a topic with planned or ready posts (D9), so it never withdraws a post a platform holds. |
| A1.20 | M | `rust/crates/jt_app/src/usecases/studio/budget.rs:11-101, 593-676; chain.rs:392-444; ads.rs:67-151; control.rs:341-466; learning.rs:201-242` | Paid lane = `ad_cap`, organic lane = `message_cap` (D3); only structural changes make a version (§4.10.2 step 7, §4.10.9), so `strategy_changed` stays rare; replays re-reserve as today. |
| A1.21 | M | `rust/crates/jt_app/src/usecases/studio/trends.rs:121-194 (hypothesis_propose), 37-120 (trend_record); catalog.rs:246-247` | `hypothesis_propose` removed (PR 7); `trend_record` unchanged with topic ids. |
| A1.22 | M | `rust/crates/jt_app/src/usecases/studio/learning.rs:81-318 (learned_for, judgment_record), 396-426 (reweight_week); measure.rs:17-127; rust/crates/domain/jt_studio/src/learning.r…` | Ids stable (§4.10.10); the learned view becomes `Neler işe yarıyor` without versions (§4.11). |
| A1.23 | M | `rust/crates/jt_app/src/usecases/work.rs:470-485, 584-607, 640-660, 1404-1428, 1488-1498` | Items and hints per §5.2. |
| A1.24 | M | `rust/crates/adapters/jt_mcp/src/tools/social.rs:14,21,28; content.rs:14; studio.rs:58,72,93,113-119,142,163,181,205-206,230,254,403,521-522` | Descriptions per §5.5. |
| A1.25 | M | `rust/crates/jt_app/src/usecases/studio/posts.rs:1389-1442 (posting_policy_set) + catalog.rs:344` | Exempt (D12); stays in Ayarlar › Paylaşım kuralları. |
| A2.1 | B | `rust/crates/jt_app/src/gate.rs:11-35,164-212 (StrategyGate, NoStrategyYet, check_gate) + rust/crates/adapters/jt_pg/src/strategy_gate.rs:29-45` | Predicate unchanged (K3); the CAPABILITY_EXEMPT stop rows become Exempt from the strategy gate too (D12). |
| A2.2 | B | `rust/crates/jt_app/src/catalog.rs:230-612 (82 Gated rows) + rust/crates/jt_archtest/tests/gate_rule.rs:19-196 + rust/crates/jt_app/tests/gate.rs:184-230` | Modes unchanged but `posting_policy_set` and the four stops (Exempt) and `hypothesis_propose` (removed); `gate_rule` EXEMPT_IDS updated; new ids under `strategy.` and `content.` (§3.1, §5.1). |
| A2.3 | B | `rust/crates/adapters/jt_pg/src/repos/strategy.rs:274-338 (draft-only writes) and the strategy_versions indexes in rust/migrations/0002_strategy.up.sql:33-36` | Unchanged; the system inserts a draft and approves it in one transaction; no in-place update. |
| A2.4 | B | `rust/crates/jt_app/src/usecases/studio/budget.rs:11-101 (reserve_connector_spend / validate_reservation), 587-676 (is_metered, reserve_metered_for)` | Organic lane = `message_cap` (carried, D3); paid lane = `ad_cap`; version equality kept, which is safe because reworded text never makes a version (§4.10.9). |
| A2.5 | B | `rust/crates/jt_app/src/usecases/inbox/replies.rs:268-317,1029-1047,1185,1391-1411` | Unchanged: commercial contact is allowed once a frame exists, which is once the owner wrote the knowledge base; words changed (§4.10.11). |
| A2.6 | B | `rust/crates/jt_app/src/usecases/ads/mod.rs:188-258 (check_money) and its callers at 547, 593-596, 686, 887, 994; rust/crates/jt_app/src/usecases/ads/plan.rs:611-672; rust/crates…` | Reads the mirrored lane (§4.6.2); `no_paid_lane` / `above_strategy_cap` worded as Kurallar. |
| A2.7 | M | `rust/crates/jt_app/src/usecases/ads/plan.rs:350-384,513-518; rust/crates/jt_app/src/usecases/ads/watch.rs:422-426,465` | Kept; topic ids from `knowledge_get` (ADS_PLAN_HINT, §5.2). |
| A2.8 | M | `rust/crates/jt_app/src/usecases/studio/ads.rs:67-145,474-500,575-600,803-880; rust/crates/domain/jt_studio/src/chain.rs:153-192` | `paid_channel_not_selected` cannot fire (`any`); a retained topic keeps its paid cadence and the content types its bindings use, so a rollover after a derivation re-validates; `recheck_periods` retries an `INTERNAL` failure once before braking (§4.10.13). |
| A2.9 | M | `rust/crates/jt_app/src/usecases/studio/planner.rs:361-418,473-479` | Paid cadence comes from an `ads.work` agent's `frame_apply` `paid_cadence` part, which retires nothing (§4.10.3); channels `any`; closing topics skipped. |
| A2.10 | B | `rust/crates/jt_app/src/usecases/research.rs:63-289 (prospecting_version, remaining, plan_in, plan), 455-492, 657-684; rust/crates/jt_app/src/usecases/strategy.rs:699; rust/crate…` | K5 carry (§4.10.7); planning runs from every apply and the hourly job, which now takes the frame lock first. |
| A2.11 | M | `rust/crates/jt_app/src/usecases/prospects/score.rs:56-112; rust/crates/jt_app/src/usecases/prospects/playbook.rs:85-170; rust/crates/domain/jt_prospects/src/playbook.rs:11-79; r…` | The frame's rubric as today; playbook version 2 (§5.5); the rubric changes only when a card asks (hint, §5.2). |
| A2.12 | M | `rust/crates/jt_app/src/usecases/inbox/context.rs:58-74,432-462` | Knowledge payload, live prohibitions, answered without a frame (§4.12). |
| A2.13 | M | `rust/crates/jt_app/src/usecases/outreach/campaigns.rs:193-250; rust/migrations/0026_outreach.up.sql:39-41,52; rust/crates/domain/jt_outreach/src/campaign.rs:208-240; rust/crates…` | Unchanged (a frame exists once the knowledge base has a card); `StrategyChanged` pause reason stays unused. |
| A2.18 | M | `rust/crates/jt_app/src/usecases/work.rs:4-11,121-142,429-496,645-708,738-739,1131-1177,563,953,1404-1429,1444-1447; rust/crates/adapters/jt_mcp/src/tools/work.rs:24-25` | Per §5.2. |
| A2.19 | M | `rust/panel/src/pages/OnboardingPage.tsx:48,53-54,62,74-79 + i18n onboarding.* (rust/panel/src/i18n/tr.json:2504-2506,4048) + rust/crates/adapters/jt_panel_http/tests/onboarding/…` | Step 2 Bilgi bankası (§4.10.12). |
| A3.1 | B | `rust/panel/src/App.tsx:117-123` | `/posts` with the three-module gate; `/content`, `/social`, `/studio`, `/materials` redirect (§2.1, §2.11). |
| A3.2 | M | `rust/panel/src/layout/LegacyRedirect.tsx:4-34` | Retargeted with the full mapping (§2.11). |
| A3.3 | M | `rust/panel/src/lib/modules.ts:11-22, 55-65` | `BUILTIN_PATHS` to `/posts`, `POSTS_PAGE_MODULES`, visibility by any of five permissions (§2.1). |
| A3.4 | M | `rust/panel/src/layout/Shell.tsx:56-59, 87-98` | One `Paylaşımlar` entry; `Strateji` becomes `Bilgi bankası` (§2.1). |
| A3.5 | M | `rust/panel/src/layout/ModuleGate.tsx:14-50` | A multi-id gate opens with any installed, ready module (§2.1). |
| A3.6 | B | `rust/panel/src/pages/content/ContentPage.tsx:42-149` | Replaced by `PostsPage`; upload, file drawer, settings, agent line re-homed (§2.8, §2.9). |
| A3.7 | B | `rust/panel/src/pages/social/SocialPage.tsx:23-154` | Replaced; accounts, posting rules, Connect and the TikTok dialog re-homed (§2.9). |
| A3.8 | M | `rust/panel/src/pages/content/location.ts:13-73 and rust/panel/src/pages/social/location.ts:5-94` | One address model (§2.11). |
| A3.9 | B | `rust/panel/src/pages/content/RootView.tsx:13-136` | Rows from `content.posts`; dynamic chips (§2.2, §3.2). |
| A3.10 | M | `rust/panel/src/pages/content/PipelineRow.tsx:41-45, 71-94, 108-242, 278-366` | `StageNode` reused for the dots (the server gives index and state); the exception bar becomes waits with in-page actions. |
| A3.11 | M | `rust/panel/src/pages/content/AreaDetail.tsx:154-337` | The panel of §2.7: no steps, no version frames; its actions kept. |
| A3.12 | M | `rust/panel/src/pages/social/PostRow.tsx:28-312` | Approve, cancel and failure actions in the panel; invalidations on `['posts']` (§3.8). |
| A3.13 | M | `rust/panel/src/pages/social/Revision.tsx:45-345` | `Düzenleme iste` dialog with siblings from the read; `revising` status (§2.7.1). |
| A3.14 | M | `rust/panel/src/pages/social/VersionRow.tsx:23-223` | `version` rows, `pick_time` and `Zamanı ben seçeyim`; no strategy links (§2.6). |
| A3.15 | M | `rust/panel/src/pages/social/timeline.ts:18-150, 203-258` | The server's join (`content.posts`) replaces `buildTimeline`; `suggestTimes` kept for `Zaman seç`. |
| A3.16 | M | `rust/panel/src/pages/social/data.ts:26-62` | One read (`content.posts`, `post_get` on demand); `account_get` only when an account is opened in Hesaplar (§2.9.2). |
| A3.17 | M | `rust/panel/src/pages/content/WaitingStrip.tsx:10-94` | `Seni bekleyen` chip; olay confirmations in Dosyalar (D8). |
| A3.18 | M | `rust/panel/src/pages/content/ContentTree.tsx:26-247` | Removed; special days become lines, the queue goes to Dosyalar (§2.12 #3, #6, #7). |
| A3.19 | M | `rust/panel/src/pages/content/OlayView.tsx:114-446 and OlayForms.tsx:19-103` | Olay create, edit, confirm in Dosyalar as Kategori; Eksikler become `need` rows (§2.9.1). |
| A3.20 | M | `rust/panel/src/pages/content/QueueView.tsx:30-190` | Dosyalar › İnceleniyor (§2.9.1). |
| A3.21 | M | `rust/panel/src/pages/content/FileDrawer.tsx:9-62 and rust/panel/src/pages/materials/MaterialEditor.tsx:31-725` | Unchanged inside Dosyalar; `Olay` labelled `Kategori`; used-in links to `/posts?slot=`. |
| A3.22 | M | `rust/panel/src/pages/content/ContentSettings.tsx:8-20 and rust/panel/src/pages/materials/MaterialsCalendar.tsx:277-349` | Ayarlar › Özel günler and Dosya kullanımı (§2.9.3). |
| A3.23 | M | `rust/panel/src/pages/social/SettingsDialog.tsx:186-395` | Ayarlar › Paylaşım kuralları, plus `Tüm paylaşımları durdur` (§2.9.3). |
| A3.24 | M | `rust/panel/src/pages/social/AccountRail.tsx:39-93 and AccountHeader.tsx:74-215` | Hesaplar sheet (§2.9.2). |
| A3.25 | M | `rust/panel/src/pages/social/TiktokDialog.tsx:11-24, TiktokSlot.tsx:10-27, rust/panel/src/pages/StudioTiktok.tsx:152-697` | Unchanged, opened from the panel; `tiktok=` kept. |
| A3.26 | M | `rust/panel/src/pages/content/uploads.tsx:56-255` | Composer attach and Dosyalar `Yükle`; the tray logic reused (§2.8). |
| A3.27 | M | `rust/panel/src/pages/content/OpenArea.tsx:14-52` | The composer, no pickers (§2.8). |
| A3.34 | M | `rust/panel/src/pages/social/Stops.tsx:17-147` | Strategy codes and actions removed; used by Hesaplar and the OAuth callback (§3.10.2). |
| A3.35 | M | `rust/panel/src/components/ModuleStatusLine.tsx:44-120 and AgentWakeLine.tsx:18-127, rust/panel/src/lib/wake.ts:31-74` | One agent line (§2.9.4); the strategy rows become the knowledge row (§4.12). |
| A3.36 | M | `rust/panel/src/lib/workItems.ts:37-63, rust/panel/src/pages/home/agenda.ts:129-151, rust/panel/src/pages/home/WorkFeed.tsx:44-73` | Retargeted (§2.13). |
| A3.37 | M | `rust/panel/src/api/content.ts:115-263, api/social.ts:25-72, api/studio.ts:77-158, 257-332, api/posts.ts:51-168, api/projects.ts:26-135, api/materials.ts:296-411` | New clients `api/postsPage.ts` and `api/knowledge.ts`; old clients kept where Dosyalar, Hesaplar and TikTok still call them. |
| A3.38 | M | `rust/crates/jt_app/src/usecases/content/pipeline.rs:80-92 and content/views.rs:246-273` | Not needed: `content.posts` takes titles from the version caption (§3.2.4); `VersionSummary` unchanged. |
| A3.39 | B | `rust/crates/jt_app/src/catalog.rs:243-254, 268-269, 342-344` | Predicate unchanged; the bootstrap gives every workspace with a card its frame (§4.10.5). |
| A3.40 | M | `rust/crates/jt_app/src/usecases/studio/projects.rs:77-92, 248-251, 470-490` | `list_live_areas` without a cap; composer files are genel, not unfiled (§3.4.3). |
| A3.41 | M | `rust/panel/src/i18n/tr.json and en.json (namespaces: socialAccounts tr.json:193 (151 keys), contentAreas :362 (61), moduleStatus :431 (8), modulePages :441 (6), nav :492 (19), w…` | Namespaces `postsPage` and `knowledge` added, `strategy` removed (`strategy.remove` moves to `common.remove`), owner-word review (§8.5). |
| A3.42 | M | `Tests: rust/panel/src/pages/content/{ContentPage,ContentEndToEnd,ModuleStatus,OlayCompact,ProductionFlow}.test.tsx; pages/social/{Accounts,Revision,SettingsDialog,SocialPage,Tik…` | Rewritten or retargeted (§8.3). |
| A4.1 | B | `rust/crates/jt_app/src/usecases/content/views.rs:245-273, 449-484, 831-839 (AreaRow, rows(), areas())` | New read `content.posts` (§3.2); `content.areas` kept for the old page until PR 5. |
| A4.2 | M | `rust/crates/jt_app/src/usecases/content/pipeline.rs:80-136, 409-427 (VersionSummary, ApprovalFact, PublicationFact)` | Facts reused by `content.posts`; slot revision and account kind come from `PostReads`' slots and accounts (§3.2.3). |
| A4.3 | M | `rust/crates/jt_app/src/usecases/content/views.rs:626-826 (AreaTally, tree WaitingCounts/WaitReason)` | Stage and `you` counts in `content.posts` (§3.2.6); `olay_proposed` and `content_time` are no owner waits. |
| A4.4 | M | `rust/crates/jt_app/src/usecases/studio/posts.rs:1107-1161 (posts_list)` | No-content posts read through `list_posts` and the new `get_pieces` (§3.2.4 step 4). |
| A4.6 | M | `rust/crates/jt_app/src/usecases/social/ready.rs:109-127, 217-252` | `read_control` without `FOR UPDATE` for reads; composer stops computed workspace-wide (§3.2.5, §3.10.2). |
| A4.7 | B | `rust/crates/jt_app/src/usecases/social/schedule.rs:736-899 (versions_waiting, VersionAccounts::of/pick, why_blocked) and rust/crates/jt_app/src/usecases/content/views.rs:415-446…` | Material reads batched (§3.2.4 step 5); `names()` extended (§3.5). |
| A4.8 | B | `rust/crates/jt_app/src/usecases/studio/owner_request.rs:129-140 (names)` | Extended to a person's request naming nothing (§3.5). |
| A4.9 | B | `rust/crates/jt_app/src/usecases/studio/posts.rs:143-150, 193-234; rust/crates/domain/jt_studio/src/chain.rs:192-197; rust/crates/jt_app/src/usecases/social/ready.rs:158-173; rus…` | Frames carry `any`; `channel_not_in_strategy` removed from ready and why_blocked; chain and planner unchanged. |
| A4.10 | B | `rust/crates/jt_app/src/usecases/content/delivery.rs:27-44, 148-220, 254-349; rust/crates/jt_app/src/usecases/content/mod.rs:51-71; rust/crates/jt_app/src/catalog.rs:266` | Areas are offered only with a frame (§4.10.11); `hypothesis_id` optional (§5.1). |
| A4.11 | M | `rust/crates/jt_app/src/usecases/studio/projects.rs:535-652 (project_create) and 237-254 (material())` | `content.post_request` wraps its internals (§3.4). |
| A4.12 | B | `rust/crates/jt_app/src/usecases/studio/library/items.rs:512-583, 591-740 (decide, material_add); rust/crates/jt_app/src/usecases/studio/library/intelligence.rs:463-551` | Composer files genel, freed by the owner, share by rule after analysis (§3.4.3, §3.4.4). |
| A4.13 | M | `rust/crates/jt_app/src/usecases/wake.rs:17-38, 281-316; rust/crates/jt_app/src/usecases/studio/projects.rs:640-649` | `request_for` and the new sites (§3.6, §5.3). |
| A4.14 | M | `rust/crates/jt_app/src/usecases/studio/control.rs:98-170; studio/tiktok.rs:350-386, 530+; content/areas.rs:220-300; studio/work.rs:451-527; studio/projects.rs:653-749` | Every revision in `actions` (§3.2.3); `content.version_cancel` for a version with no post (§3.7.3). |
| A4.16 | M | `rust/crates/jt_app/src/usecases/studio/work.rs:121-364 (pending_in) material_check_hold blockers` | `check_hold` wait from `publish_check` (§3.2.4). |
| A4.17 | M | `rust/crates/jt_app/src/catalog.rs:229-345; rust/crates/adapters/jt_panel_http/src/routes/mod.rs:57-155, 557-635, 2081; rust/crates/jt_app/tests/catalog.rs:479; rust/crates/jt_ap…` | Rows, routes and counts per §3.1, §5.1, §8.4. |
| A4.18 | M | `rust/crates/jt_app/src/gate.rs:125-162 (LIBRARY_PAGE_READS, gating_module) and rust/crates/jt_app/src/usecases/studio/permissions.rs:9-48` | Shared list gated by `materials`; `post_request` and `version_cancel` by `content` (§3.1). |
| A4.19 | M | `rust/crates/jt_app/src/ports/production_projects.rs:505-548 and rust/crates/adapters/jt_pg/src/repos/studio/projects.rs:24-221` | `list_live_areas`, `find_area_by_version`, index in 0046 (§3.9, §4.2). |
| A5.1 | B | `rust/crates/adapters/jt_mcp/src/tools/strategy.rs:26-380 (all 10 tool definitions, arg structs, schemas)` | Per §5.1. |
| A5.2 | B | `rust/crates/jt_app/src/usecases/strategy.rs (get 229-247, start_consultation 258, record 339, write_section 395, set_hypotheses 453, submit 524, approve 593-711, archive 725-798…` | Approve's effects in frame apply (§4.10.2); until PR 7 an old approval re-syncs the knowledge base (§4.3.4); the consultation use cases removed in PR 7. |
| A5.3 | B | `rust/crates/jt_app/src/gate.rs:199-200; rust/crates/adapters/jt_pg/src/strategy_gate.rs:29-44; rust/crates/jt_app/src/catalog.rs (82 Gated rows, 73 MCP tools)` | As A0.10. |
| A5.4 | B | `rust/crates/jt_app/src/usecases/work.rs:121-143 (StrategyState), 272-274, 387-388 (ConsultStrategy/ApproveStrategy), 738-739, 1131-1186 (strategy_state, may_approve, strategy_it…` | Per §5.2. |
| A5.5 | M | `rust/crates/adapters/jt_mcp/src/tools/work.rs:23-63 (work.pending description)` | Per §5.2. |
| A5.6 | M | `rust/crates/jt_app/src/usecases/work.rs:1404-1429 (CONTENT_AREA_HINT)` | Per §5.2. |
| A5.8 | M | `rust/crates/jt_app/src/usecases/work.rs:1444-1448 (ADS_PLAN_HINT); rust/crates/jt_app/src/usecases/ads/plan.rs:381-383, 513-518, 742; rust/crates/jt_app/src/usecases/ads/mod.rs:…` | Per §5.2 and §4.6.2. |
| A5.9 | M | `rust/crates/jt_app/src/usecases/content/mod.rs:67-71; rust/crates/jt_app/src/usecases/content/delivery.rs:161-166` | Per §5.1. |
| A5.10 | M | `rust/crates/jt_app/src/usecases/studio/trends.rs:121-194; rust/crates/adapters/jt_mcp/src/tools/studio.rs:112-120; rust/crates/jt_app/src/usecases/studio/permissions.rs:23-25; r…` | Removed in PR 7; proposals are knowledge proposals (§4.9). |
| A5.11 | M | `rust/crates/jt_app/src/usecases/inbox/context.rs:59-74, 444-462 (jeeta.inbox.context strategy_guidance and prohibitions)` | Per §4.12. |
| A5.12 | M | `rust/crates/jt_app/src/usecases/studio/work.rs:20-29, 439-442 (studio.slot_get brand_rules)` | Per §4.12. |
| A5.14 | M | `rust/crates/domain/jt_prospects/src/playbook.rs:1-9, 78-79; rust/crates/jt_app/src/usecases/prospects/playbook.rs:89-113; rust/crates/jt_app/src/usecases/research.rs:69-77, 203-…` | K5 carry (§4.10.7); playbook text and version (§5.5). |
| A5.15 | M | `rust/crates/adapters/jt_mcp/src/tools/social.rs:14, 21, 28; rust/crates/jt_app/src/usecases/social/schedule.rs:669, 722-724` | Per §5.1. |
| A5.16 | M | `rust/crates/jt_app/src/usecases/wake.rs:36-37, 122-159; rust/crates/jt_app/src/ports/wake.rs:100-145; rust/crates/jt_archtest/tests/wake_triggers.rs:9-` | Reasons, `KNOWLEDGE` need and triggers per §5.3; `wake_triggers` rows updated (§8.4). |
| A5.17 | M | `rust/crates/jt_app/src/catalog.rs:435-448, 95-99; rust/crates/jt_archtest/tests/gate_rule.rs:19-33, 225` | New ids under `strategy.` (Exempt, allowed while pending payment, no module) and `content.`; `gate_rule` EXEMPT_IDS gets the `content.*` rows and the stops. |
| A5.18 | M | `rust/crates/adapters/jt_mcp/tests/registry.rs:143-152, 263, 361-396, 402-428` | Tool list and count, the permission assertion rewritten for §5.1, description pins (§8.4). |
| A5.19 | M | `rust/crates/jt_archtest/tests/m4_productisation.rs:28, 237, 252, 394-453; rust/crates/jt_archtest/tests/fixtures/m3_surface.json:100-116, 228-244` | `POST_M4_ADDED`, `POST_M4_REMOVED`, `POST_M4_PANEL_ONLY` and `m3_surface.json` updated (§8.4). |
| A5.20 | M | `rust/crates/jt_archtest/tests/twin_parity.rs:8-14, 337-490` | Rewritten: `knowledge_get` and `strategy.get` panel = MCP; a frame applied through MCP is seen identically on both (§8.4). |
| A6.1 | M | `rust/migrations/0002_strategy.up.sql:16-36 (strategy_versions + one_draft/one_approved indexes)` | Unchanged; frames go draft → approved in one transaction. |
| A6.2 | B | `rust/migrations/0002_strategy.up.sql:38-53 + 0009_studio.up.sql:5-15 (strategy_hypotheses, studio_hypothesis_tenant_identity)` | Unchanged; `replace_all` only on the new version; ids carried. |
| A6.3 | M | `rust/migrations/0009_studio.up.sql:21-150 (studio_arms, slots, pieces, publish_attempts, publications, adset_bindings, measurements, learning_applications, trends, spend_reserva…` | Unchanged. |
| A6.4 | M | `rust/crates/adapters/jt_pg/src/repos/strategy.rs:184-377` | No new method: frame apply uses `insert`, `set_status`, `lock_draft`, `lock_execution_frame`. |
| A6.5 | M | `rust/crates/adapters/jt_pg/src/repos/hypotheses.rs:88-260` | `replace_all` on the new version, `upsert` for the owner's request, `set_derived_confidence` unchanged. |
| A6.6 | M | `rust/crates/jt_app/src/usecases/strategy.rs:593-711 (approve) and 725-798 (archive)` | In frame apply, with debounce and skip (§4.10.2, §4.10.9); archive removed. |
| A6.7 | M | `rust/migrations/0020_prospects.up.sql:15-39 + rust/crates/jt_app/src/usecases/research.rs:98-262` | K5 by re-stamping (`carry`, §4.10.7); no index change. |
| A6.10 | M | `rust/migrations/0002_strategy.up.sql:55-82 + rust/crates/adapters/jt_pg/src/repos/consultation.rs` | Kept; knowledge history in `knowledge_revisions` (§4.2). |
| A6.11 | M | `NEW TABLE(S) in 0046 for knowledge cards (no existing table fits)` | The five tables of §4.2. |
| A6.12 | M | `rust/crates/domain/jt_studio/src/chain.rs:191-197 + sections.channels (jsonb) + strategy.rs:866-1000 add_channel` | `channels = [any]` always; `add_channel` removed. |
| A6.13 | M | `rust/crates/adapters/jt_pg/src/strategy_gate.rs:29-45` | Unchanged; the bootstrap replaces a migration that would insert version 1 (§4.10.5). |
| A6.14 | M | `rust/crates/jt_app/src/usecases/studio/budget.rs:36-75 and rust/crates/adapters/jt_pg/src/repos/studio/queue.rs:114-124` | Only structural changes make a version (§4.10.9); `late_completion` entries on such a change are accepted. |

## 7. Migration and rollout

### 7.1 Migration `0046_knowledge_base`

Contents (§4.2): the tables `knowledge_settings`, `knowledge_cards`, `knowledge_revisions`
(append-only trigger), `knowledge_notes`, `knowledge_proposals`, their indexes and forced RLS
policies, and the index `studio_production_projects_live`. Nothing in an existing table is read or
changed by the migration: every backfill is the application's (§4.3), so the migration is safe on a
live database and quick. Pins that move with it: `MIGRATIONS = 46`, `TABLES_AFTER_ALL = 109`
(`jt_pg/tests/migrations.rs`), the newest-first down list (0046 first, run twice), archtest
`all_tables = 112`, `sql_scoping` gains the five tables (every jt_pg literal names `workspace_id`),
`check_rls` sees them forced. 0046 references no `strategy_*` or `studio_*` table by FK, so
`project_tables_down` and the re-apply list of `studio_migration_up_down_up` do not change.

A separate, idempotent ops script `rust/scripts/rollback/strip_new_wake_reasons.sql` (run under
`set_config('app.platform', 'on', true)`) removes the wake codes newer than schema 45 from both
`pending.reasons` and `last.reasons` of `agent_wakes` and nulls a pending wake left with no reason.
It is needed only to go back to a binary older than PR 1 (which has no tolerant decoding); every
other rollback target reads newer rows (§4.2).

### 7.2 What every existing workspace goes through

In order, the first time after PR 2's deploy; each step idempotent and ledgered:

| Step | When | Workspace with an approved version | …and an open draft | Only a draft | Neither |
|---|---|---|---|---|---|
| Seed cards, rules, goals (§4.3) | first knowledge call, first `knowledge_settle` tick, or an old approval | from the approved version | from the approved; draft differences become proposals; draft archived | blank seeds; every draft part becomes a proposal; draft archived | blank seeds |
| Caps and approval (§4.3.2) | with the seed | `ad_cap` = the lower of lane and general item (item lowered to it, or created from the lane); `message_cap` = the organic lane; switch and account list from the accounts' flags | same | no caps; account list from the flags | same |
| Normalise the frame (§4.10.6) | first `knowledge_settle` tick after the seed | a new version: channels `any`, topics on `any`, lanes = caps, mix emptied, every topic kept, tasks carried | same | — (no frame) | — |
| Bootstrap (§4.10.5) | at the owner's first card text or accepted card proposal | — | — | when the owner adds a proposal or writes a card | at the owner's first card |

The owner's workspace (figurunica, approved version 5, no draft): 8 seed cards plus `Önceki
görüşmeler` if its 5 log entries hold answers or notes, 7 prohibitions, 5 goals, `ad_cap` 5.000 TRY a
month (or less if the general item is lower), `message_cap` 0 TRY a month, every flagged account in
the approval list, a normalised version 6 with the same 7 topics and lanes, 7 standing research tasks
carried. The pending HummyTummy import runs after PR 2 and PR 3 are deployed, through card, rules and
goals writes only (`strategy.card_*`, `rules_save`, `goals_save` through the panel, or a one-off
script calling the same use cases as the owner), never through the old consultation tools.

### 7.3 Production data safety

- Additive schema; no column changes on existing tables; no FK rewrites (A6: every studio FK stays
  valid because no version or hypothesis row is deleted or rekeyed).
- Application writes to existing tables are limited to: new `strategy_versions` and
  `strategy_hypotheses` rows (append-only, as every approval did), archiving open drafts (status
  only; their content stays, and becomes proposals), writing the system fields of a draft an old
  routine approves (§4.3.4), re-stamping carried research tasks (`strategy_version_id`, ledgered with
  both ids), lowering or creating the general ad budget item (ledgered with the reason; never
  raising), pausing over-limit campaigns after an owner's lowering (the ads watch's own hold).
- No spend limit is lifted and no post approval is dropped by the migration or the backfill: the ad
  cap is the lower of the lane and the item, the organic lane is carried as the message limit, and
  every account whose posts wait today is in the approval list (§4.3.2).
- Before each deploy of PR 1, PR 2 and PR 7: `pg_dump` of the database as the release runbook does
  (`rust/scripts/backup.sh`), and, for PR 2, a dump of `strategy_versions`, `strategy_hypotheses`,
  `research_tasks`, `budget_items`, `capabilities` to compare after the first `knowledge_settle` tick.
- Every system write is ledgered (`strategy.frame_applied`, `strategy.frame_skipped`,
  `research.task_carried`, `budget.items.*` with `reason`, `strategy.knowledge_changed` with
  `cause = backfill` or `resync`).

### 7.4 Pull requests, in order

| PR | Branch | Scope | Depends on | Ships alone because |
|---|---|---|---|---|
| 1 | `feat/knowledge-store` | 0046; `jt_knowledge` crate; `KnowledgeRepo` (pg, fake, six `TenantRepos` implementors); seed, card, rules, goals, notes and proposals use cases with their tests, **not registered** (no catalog row, route or tool yet); the tolerant reads of §4.2 (unknown `WakeReason` dropped, `VersionCancel.slot_id` optional) | — | nothing reachable reads or writes the new tables; the tolerant reads change no behaviour and make every later rollback safe |
| 2 | `feat/knowledge-frame` | the knowledge use cases registered (panel routes, `jeeta.strategy.knowledge_get`, catalog rows); seeding; `knowledge::frame::apply` with the system causes (rules, bootstrap, normalize, close); `knowledge_settle`; the old-approval re-sync and `archive`'s refusal (§4.3.4); `rules_save` complete (`ad_cap`, `check_general` against it, mirror, hold; `message_cap`; post approval switch and list, `post_approval_set`; the effective gate §3.10.1); `validate_reservation` organic lane (D3); K5 carry and `plan()`'s frame lock; K6 removals (`channel_not_in_strategy`, `no_hypothesis`, strategy stop actions, `strategy.add_channel`, groups guard); `knowledge_empty` and `braked` codes; `posting_policy_set` and the four stops Exempt (D12); the compat projection of `strategy.get` (§5.4); `inbox.context`, `slot_get`, `overview`, `open_channels` read the knowledge base; the six wake reasons, the `KNOWLEDGE` need, `request_for`, the connect and brake wake sites; `recheck_periods`' retry; `STRATEGY_REQUIRED` message | 1 | the old panel keeps working (codes it does not know show its generic words; an approval on the old strategy page re-syncs the cards); agents' old tools keep working and re-sync; owner edits are visible to old routines at once through `strategy.get` |
| 3 | `feat/knowledge-page` | panel `/knowledge` (§4.11), `/strategy` redirect, the `/api/strategy` write routes refusing `use_knowledge_base`, menu rename, onboarding step 2, `ModuleStatusLine`, `QueryState`, `StudioShared`, `lib/errors.ts`, Bütçe's ceiling line, home items and ledger copy, research and prospects copy, `knowledge` i18n namespace; `StrategyPage` and its components deleted | 2 | the server side is complete before it |
| 4 | `feat/posts-read` | `content.posts`, `content.post_get`, `content.post_request` (files, person-upload share rule, `pending_files`, wakes), `content.files_add` (every target with pending files), `content.special_day_skip`, `content.version_cancel`, `content.post_dismiss`; `material_delete` clearing pending files; `owner_request::names` and the person-request attribution (§3.5, delivery `hypothesis_id` optional for a person's area); `material_analysis_complete`'s `sensitive_checked`; `slot_cancel` person permission (D13); delivery wakes SOCIAL; `list_live_areas`, `find_area_by_version`, `get_pieces`, `get_materials`, `read_control`; `VersionCancel` written without a slot | 2 | new panel-only routes and additive agent inputs; the old pages unchanged |
| 5 | `feat/posts-page` | panel `/posts` (§2), drawers, every redirect of §2.11, menu merge, link retargets (§2.13), `postsPage` i18n and the owner-word re-wording of the reused namespaces (§8.5); `ContentPage`, `SocialPage`, `RootView`, `ContentTree`, `OlayView` page shell, `QueueView` shell, `timeline.ts`, `data.ts`, `VersionRow`, unrouted `StudioProjects`, `ProjectPublications`, `ProjectProduction` and their harnesses deleted (`MaterialEditor`, `MaterialsCalendar`, `SettingsDialog`, `StudioTiktok`, `TiktokSlot`, `OlayForms`, `uploads.tsx` reused) | 3, 4 | links into `/knowledge` exist (PR 3) |
| 6 | `feat/knowledge-agents` | MCP `frame_apply` (cause `derive`, `paid_cadence`), `note_claim`, `note_file` (every outcome), `note_release`, `proposal_create`; `work.pending` `knowledge` state and kinds; hints; every description of §5.5 ("Retired soon" on the old tools); playbook version 2 with the leads spec's Appendix A | 2 (4 for the note's post-request outcome) | additive for agents: old routines keep working through the compat projection and the old tools |
| — | routines | the content, research and ads routine prompts of §5.6 | 6 live | — |
| 7 | `chore/retire-strategy-tools` | remove the nine consultation tools, `strategy.approve`'s producer of `strategy_approved` and the re-sync, `studio.hypothesis_propose`, the `/api/strategy` write routes, `PendingOut.strategy`, `ConsultStrategy`/`ApproveStrategy`, panel `api/strategy.ts` writes and types; update `rust/README.md` (strategy sections), `rust/panel/README.md`, `docs/design/modular-agent-workspace.md`; mark the 2026-10-22 spec's K2/B1/B6/B7 as superseded here (§9 D31) | 5, 6, routines moved | checked first: no call to a removed tool in the last 7 days (ledger `agent.*`/MCP call log by tool name) |

**Deploys** (each PR stays safe alone; these are the release cuts): first deploy PR 1; second
deploy PR 2 + PR 3 (the owner gets Bilgi bankası, and the old strategy page stops taking writes the
same day); third deploy PR 4 + PR 5 (the owner gets Paylaşımlar); fourth deploy PR 6, then the
routines; fifth deploy PR 7. PR 6 can be built alongside PR 3–PR 5. Seeding starts with the second
deploy, and from that moment every approval through the old paths re-syncs the cards (§4.3.4):
there is no window in which the old page or tools can write a frame the knowledge base does not
show. Between the second deploy and the routines' move, a note the owner adds stays `Bekliyor` (no
routine files it yet), but it binds at once: every agent read carries open notes (§4.12, §5.4's
`knowledge`).

No feature flags (D25): each PR is shippable as it stands, the server PRs keep the old contracts
working, and the panel switches page by page; a flag would only keep two pages alive longer.

### 7.5 Verifying each PR on production

Run against jeetagrowth.com with the owner's workspace (MCP with an owner key, and the panel):

| PR | Check |
|---|---|
| 1 | `tools/list` and the catalog unchanged; `agents.wakes` and every area read as before |
| 2 | `jeeta.strategy.knowledge_get`: 8 seed cards (+ `past_conversations` if any), texts as §4.3.3, 7 prohibitions, 5 goals, `ad_cap` ≤ 500000 TRY monthly, `message_cap` 0 TRY monthly, `revision = 1`; `knowledge_revisions` has one `backfill` row per subject; a second call writes nothing. After one `knowledge_settle` tick: `jeeta.strategy.list_versions` shows version 6 approved (cause `normalize` in the ledger), version 5 archived; `strategy.get` sections `channels = [any]`, the 7 hypotheses with the same ids and `channel: any`, the same two lanes; `research.tasks_list`: the same 7 standing task ids, open, `research.task_carried` ×7 in the ledger, no `superseded`; `budget.items_list`: the general item's cap ≤ 500000 TRY monthly; an agent key's `budget.items_update` above it answers `above_rules_cap`; `ads.campaigns_list` unchanged; `social.accounts_list` TikTok gated, every account flagged before still `requires_human_approval: true`; a scheduled post still goes out; a second tick applies nothing |
| 3 | `/knowledge` shows the seeded cards and Kurallar (ad, message and approval lines); editing `Ses tonu` changes `strategy.get` at once and makes no version; `/strategy` lands on `/knowledge`; onboarding step 2 done |
| 4 | `GET /api/content/posts` returns every current post of `/social` and every content of `/content` (count compare), `counts.you` equals the sum of today's waiting chips; a composer request from the API creates a `content` row, wakes the content agent, and the delivered versions, attributed to the owner's request, list every connected account |
| 5 | `/content`, `/social`, `/studio`, `/materials` and every legacy query land per §2.11; a TikTok post completes from the panel; home work items open the right row |
| 6 | `work.pending` (agent key): `knowledge` state; after a `Paylaşım fikirleri` edit, a `knowledge_derive` item and a wake (`agents.wakes`) within a minute; the routine's `frame_apply` with `parts [posting]` alone answers `applied: false`; a `Ses tonu` edit lists no derivation |
| 7 | the tool list (`tools/list`) has 240 tools; the routines' next runs show no error in their session logs; `work.pending` has no `strategy` field |

### 7.6 Rollback limits

0046's down is never a step of these: it deletes the owner's knowledge (§4.2).

| After | Rollback by | What is lost or stays |
|---|---|---|
| PR 1 | revert; 0046's down only if PR 2 was never deployed | nothing else changed |
| PR 2 (+3) | revert the binaries to PR 1's (0046 stays). **Before switching**, for each workspace: set `requires_human_approval` on every postable social account when `post_approval` is on, else on each account of `post_approval_accounts` (ledgered `capability.set_policy {reason: "rollback"}`; this also holds comment replies on those accounts until a person changes it, which errs safe) | frames written stay (ordinary approved versions the older code reads); carried research tasks stay carried (valid); budget items stay lowered; the knowledge tables stay, unread; archived drafts stay archived (their text is in the proposals); new wake reasons are dropped on read (PR 1's tolerant decoding) |
| PR 4 (+5) | revert to PR 3's binaries | versions cancelled without a slot are read by PR 1's tolerant decoding; composer materials keep their share and their `upload_for` field (ignored); `pending_files` is ignored, so such areas are offered to agents at once (a delivery with an unshared file is refused `share_unset`, as before) |
| PR 3, PR 5 | revert (panel only) | none; the old pages come back with the server unchanged (PR 3's revert also lets `/api/strategy` writes through again, with the re-sync) |
| PR 6 | revert | items and tools of agents go; the frame stays as last applied; nothing in the data depends on them |
| PR 7 | revert | removed tools come back; nothing in the data depends on them |
| to a binary older than PR 1 | only after reverting every later PR | run `strip_new_wake_reasons.sql` and 0046's down (its guard refuses while a slotless cancel exists: clear those first) |

## 8. Test plan

### 8.1 Server

Pure (`jt_knowledge/tests`):
- limits and strict parsing of cards, rules, caps, goals, notes, proposals; tolerant reads of
  unknown fields; an unknown `WakeReason` in `pending.reasons` and `last.reasons` is dropped on read
  (PR 1);
- the seed mapping against `strategy-v5.json` as a fixture (golden texts of every card, the
  truncation rule, `ad_cap` as the lower of lane and item, `message_cap` = the organic lane 0 TRY,
  the switch and the account list), the draft-difference proposals, the past conversations card;
- the frame merge: system fields recomputed (identity from the cards with its fallbacks, channels,
  prohibitions, goals, lanes from the caps, cadence); topic ids (given, title match, new); a kept
  topic sent without a cadence keeps its own, a new one gets the default; the retained set keeps a
  left-out topic as closing, keeps every content type its posts and bindings use and its paid
  cadence; segments carried for retained topics and for the ICP of a part not sent
  (`kept_segments`); the owner's request carried and outside every check; validation only of what
  was sent (a frame with 31 inherited topics and the owner's request still takes a rules mirror and a
  normalise); the structural diff (two derivations from unchanged cards with reworded identity,
  objective, titles and angles make no version: `text_only`); the empty predicate (Kurallar and
  Hedefler alone are empty).

Repos (`jt_pg/tests/knowledge_repos.rs` and the fake's contract test in `jt_testkit/tests`):
RLS scoping, the append-only trigger, the one-key, one-pending and closed-rule constraints, history
paging, `list_live_areas` with more than 200 areas, `find_area_by_version`, `get_pieces`,
`get_materials`, `ResearchTasks::carry`; migration up/down twice; down refusal with a slotless
cancel under forced RLS (the guard sees the row through `app.platform`); the restore drill with
populated knowledge tables; **no deadlock**: `rules_save` (ad budget) concurrently with
`refresh_period` and `reserve_metered_for` on the same general item, and with a `frame_apply`
(§4.10.13); `strip_new_wake_reasons.sql` cleans `pending` and `last` and is idempotent.

Use cases (`jt_app/tests/knowledge.rs`, `knowledge_frame.rs`, `posts_page.rs`; one test per rule):
- seed: each source of §4.3.1 (a draft-only workspace gets blank cards, proposals and **no frame**:
  after a `knowledge_settle` tick `check_gate` still refuses a Gated use case; accepting the
  `who_we_are` proposal bootstraps); two concurrent seeds make one; the draft archived;
- old approval (§4.3.4): an approval after the seed rewrites cards still at their seed revision,
  proposes for an owner-edited card, appends a new prohibition (it is in `knowledge_get` and in the
  frame), never raises `ad_cap`, sets both `*_derived`, and writes the draft's system fields before
  approving (the approved version is already `any`-shaped); `archive` refuses `use_brake`;
- cards: conflict on stale revision, archive and restore, too many cards, revision rows; a
  `post_ideas` edit moves `posting_revision` only, a `who_we_seek` edit `prospecting_revision` only,
  a `voice` edit neither (no item, no wake); bootstrap in the same transaction as the first card
  text (gate opens: `check_gate` passes a Gated use case right after); **a first write that is a
  yasak or a goal is saved, the gate stays closed, `knowledge_empty` stays true and the composer
  stop still says to write a card**;
- rules: prohibitions live in `knowledge_get`, `strategy.get`, `inbox.context`, `slot_get` in the
  same transaction, and no derivation becomes due; ad budget sets `ad_cap`, updates or creates the
  general item, mirrors the lane, `check_money` refuses above it, `watch_all` right after the save
  stops a running campaign whose period spend reached the new cap, `Reklam yok` removes the lane
  (`no_paid_lane`); **an agent key with `budget.manage` that raises the general item above `ad_cap`
  is refused `above_rules_cap` and the lane is unchanged; its lowering is applied**; a mirror that
  cannot be written still commits the owner's save and ledgers `frame_skipped`; message limit:
  carried from v5 (an SMS reservation above 0 is still refused after the tick), lifted only by the
  owner's save; with no `message_cap` an SMS reservation passes its item caps and a paid reservation
  without lane is `lane_budget_missing`; post approval: the switch makes `pending_in` list a ready X
  post, `authorize_execution_at` hold it, accounts say `requires_human_approval`, a comment reply on
  the same account is **not** held; switching off leaves the listed accounts waiting; turning it off
  or removing an account needs owner or manager; an agent's `capability.set_policy` lowering an
  account's stored flag releases no post;
- notes: claim lease and expiry, `note_claimed`, each outcome (cards with `cause = note`, rules and
  goals appended as the note's person, a post request opening a content with the note's files,
  proposals), `filing_removes_text`, `note_withdrawn`, a budget-change note dismissed, release;
  listed to any work permission; the filer's own re-check-in right after `note_file` lists
  `knowledge_derive` (no listing delay) and keeps the wake a later edit asked for;
- proposals: limits and rate (system proposals exempt), dedupe, `superseded` on an owner edit,
  accept of each kind, expiry by the job;
- frame apply: permission per part (`part_permission`), a field of a part not listed, gaps named
  by input index, `kb_revision_ahead`, **`derivation_stale` (an older-revision apply after a newer
  one is refused and the frame is unchanged)**, `parts` alone → no version and the item cleared, ids
  stable across two applies, **a derive that drops a content type leaves the ready post sendable**,
  **a derive that leaves out a paid topic with a binding keeps it (closing) and does not brake**, a
  left-out topic with a ready slot is closing, gets no new post, and is retired by `knowledge_settle`
  once its post went out with no knowledge edit in between, a dropped segment an ICP entry uses is
  carried, the bootstrap `Genel` topic with a planned post survives the first real derivation,
  transition hook frees versions (F4), owner's request carried, wakes only for changed structural
  parts and on behalf of `changed_by`, acknowledgements take the max;
- normalise: a v5-like frame (channels instagram/tiktok/any, hypotheses on instagram, organic lane
  0, channel_mix) becomes `any`-shaped with every topic kept, both lanes as the caps, and its tasks
  carried; a second tick does nothing; normalise of a frame with 31 topics and the owner's request
  succeeds;
- K5: unchanged brief carried (id, claim and today's count kept), changed brief superseded and a new
  task opened, removed entry superseded; `plan()` with a stale version running concurrently with a
  carry supersedes nothing (it waits on the frame lock);
- compat projection field by field (§5.4); `inbox.context.knowledge` (with open notes);
  `slot_get.brand_rules`;
- posts read: table-driven over the row kinds, statuses, progress and waits of §2.3–§2.6 (the failed
  actions by reason, `Bırak`, `tiktok_draft`, `paused` under the brake, `no_account_for_platform`);
  ordering, paging, cursor validation and counts; actions per permission variant of §2.10; no
  `lock_control`/`gated` call (the fake counts lock calls); a build-cost guard (500 areas, 2,000
  posts in the fake under a fixed budget);
- composer: text only (wake `CONTENT`), with files (genel, freed, pending, wake `MATERIALS`), a live
  duplicate reused, refused bytes `duplicate_material_file`, a PDF `file_not_media`, not a person
  `human_required`; share by rule (checked and none found → shareable with `by: None`, pending
  cleared, `CONTENT` woken on behalf), a face → `files_permission`, an analysis without
  `sensitive_checked` → `files_permission`, a failed analysis or no materials agent →
  `files_permission` at once, `İzin ver` clears it, `Bu dosya olmadan devam et` clears it, **a face
  added by a later analysis to a rule-shared file holds the post (`sensitive_needs_human`) until
  `İzin ver`**, deleting a pending file in Dosyalar empties the list and wakes `CONTENT`;
- `files_add` per target: capture (the area is offered back only once its files are shared;
  `CaptureAnswered` then), need (the request stays open until a file is shared), special day
  (creates a confirmed olay; once a file is shared, by rule or `İzin ver`, runs the calendar trigger
  and wakes `CONTENT`); `special_day_skip`; `version_cancel` (conflicts, archive when last);
  `post_dismiss` (failed and TikTok draft, refusals);
- `owner_request::names` with empty hints; a person's delivery without `hypothesis_id` is attributed
  to the owner's request on every account, an agent area's delivery without one is refused;
  delivery of a person's content wakes `SOCIAL`; connecting an account while a version waits for one
  wakes `SOCIAL` (`account_connected`); releasing the brake wakes `SOCIAL`; a person's post cancel
  with `content.manage` passes, with `social.work` only is refused.

### 8.2 Journeys (`rust/crates/jt_app/tests/journeys.rs`)

The world helper becomes `World::with_knowledge(cards)`: it seeds the knowledge base and applies a
frame through `frame::apply` (cause `derive`, as an agent would) instead of writing an approved
strategy; `w.approve_strategy()` (21 files) is kept as a thin wrapper over it until PR 7. Existing
journeys keep their assertions with the new codes; the two strategy variants become:
`a_derivation_mid_way_unblocks_the_delivered_versions_without_a_redo` and
`a_post_taken_back_by_a_derivation_waits_again_by_itself`. New journeys:

| Journey | Walks |
|---|---|
| `the_owners_free_text_request_posts_on_every_connected_account` | X and Instagram connected, composer text only → agent delivers one version per account without `hypothesis_id` → both offered under the owner's request → scheduled → sent → **the measurements land on the owner's-request arms** |
| `a_photo_with_the_request_is_shared_by_rule_and_used` | composer with an image, TikTok and Instagram → analysis checks and finds nothing → shareable by rule → area offered → delivered → TikTok screen, Instagram goes out |
| `a_face_in_the_photo_waits_for_the_owners_permission_once` | analysis marks a face → row `files_permission` → `İzin ver` → area offered, nothing redone |
| `a_new_workspace_opens_with_its_first_card` | empty → composer stop `knowledge_empty`, no `content_area` item → a yasak saved (still empty) → first card → bootstrap frame, gate open, item listed and `CONTENT` woken → derivation leaves `Genel` out: closing while its post waits, retired after it went out |
| `a_card_edit_is_derived_after_a_burst` | three `Paylaşım fikirleri` edits in 20 s → the agent woken once after the settle → `knowledge_derive` → `frame_apply` → ids kept; a second apply with `parts` alone answers `applied: false`; a `Ses tonu` edit makes no item |
| `the_approval_switch_holds_and_releases_posts` | X without approval scheduled → switch on → waits for approval → approve → sent; switch off with X in the account list → still waits; removed from the list → next goes out at its time; a comment reply never waits |
| `lowering_the_ad_budget_stops_what_reached_it` | campaign live, 3.200 spent this month → budget lowered to 3.000 → stopped by the same save, `check_money` refuses a new campaign of 500; an ads agent raising the general item back is refused |
| `research_keeps_its_standing_tasks_across_a_derivation` | ICP unchanged → same task id and today's count; one brief changed → that task superseded, a new one |
| `a_special_day_photo_starts_its_content_at_once` | day in preparation → `Fotoğraf ekle` → confirmed olay, checked and shared by rule → calendar trigger opens the area in the same transaction, `CONTENT` woken |
| `a_note_is_filed_and_derived` | `note_add` → agent files into `products_prices` → re-checks in and sees `knowledge_derive` → apply → `SOCIAL` woken on behalf of the owner |
| `a_note_asking_for_a_post_opens_one` | `note_add` "Yılbaşı için bir paylaşım yap" → agent files `post_request` → a `content` row requested by the owner, `CONTENT` woken |
| `reconnecting_frees_the_waiting_post_at_once` | the only Instagram account lapses → version `account_unavailable` → `Yeniden bağla` → `SOCIAL` woken (`account_connected`) → scheduled → sent |
| `stopping_all_posting_is_said_and_resumed` | brake on → rows `Durduruldu`, composer stop `braked`, `versions_waiting` offers nothing → `Sürdür` → `SOCIAL` woken → scheduled → sent |

To extend: a new platform is still a `Platform` row and one test calling `journey`; a new gate is
asserted where a journey meets it, then its cause is cleared and the work must go on unredone.

### 8.3 Panel (Vitest + Testing Library)

- `PostsPage.test.tsx`: rows of every kind and status; chips (dynamic stages, counts from the
  server, fallback to Tümü); selection and the address; the panel per kind (no tabs, no step list);
  every wait's sentence and action calling the right endpoint with the read's revision; dialogs
  (Düzenleme iste with siblings, `Tekrar hazırlat` prefilled with the same consequence line, İptal
  per target, Geri al); the failed actions by reason and `Bırak`; `tiktok_draft` and `Tamamladım`;
  the brake's red line, `Durduruldu` rows and `Sürdür`; composer (stops always, advice only on focus
  or text, a named platform not connected said while typing, upload tray, success, hidden without
  permission or module); the `{Platform} · {hesap}` badge; special-day lines in every file state;
  empty, loading, error, filter-nothing, row-not-in-list; phone cards (matchMedia); paging; the
  permission variants of §2.10.
- `PostsDrawers.test.tsx`: Dosyalar (queue, categories, confirm, file editor), Hesaplar (pause,
  per-account approval only when the switch is off, calling `strategy.post_approval_set`, the
  read-only comment-reply line, Sayılar on demand), Ayarlar (three sections, brake).
- `KnowledgePage.test.tsx`: cards (create, edit, conflict, archive and undo, history and restore),
  Kurallar box lines (ad, message only when set, approval built from switch and list) and dialog
  (money fields read-only without `budget.manage`, message field only as §4.6.4 says, switch,
  `Bunlarda da kapat`, stopped campaigns), Hedefler, notes (add, the agent stops before sending,
  withdraw, every outcome's status line), the agent line, proposals (accept, skip, superseded),
  `Neler işe yarıyor` shown only with evidence and permission, read-only member, empty state (and
  its variant with system proposals pending).
- Retargeted: `App.redirects.test.tsx` (the whole §2.11 table), `Shell.test.tsx` (menu hrefs
  `/`, `/knowledge`, `/posts`, …), `HomePage.test.tsx` and `lib/workItems` links, `QueryState.test`,
  `OnboardingPage.test`, `StudioTiktok.test.tsx` (`/posts?slot=s1&tiktok=s1`), material editor and
  calendar tests at their new addresses, `OAuthCallbackPage.test` (no `prepare_strategy`),
  `ModulesPage.test`, `AgentWakeLine.test` (`knowledge` need).
- Deleted with their components: `StrategyPage.test`, `ContentPage`, `ContentEndToEnd`,
  `OlayCompact`, `ProductionFlow`, `SocialPage`, `Accounts`, `Revision`, `timeline`, `StudioProjects`
  tests (their behaviours are re-asserted in the new tests above where they survive).
- Fixtures (`test/*.ts`, `design-review/*.cjs`): knowledge and posts fixtures from the figurunica
  seed; strategy fixtures reduced to the compat projection.

### 8.4 Architecture, catalog, twins, registry

| Pin | Change |
|---|---|
| `jt_app/tests/catalog.rs` row count, `ops/m4_ops.rs` | 303 → 316 at PR 7 (each PR its own step) |
| `jt_mcp/tests/registry.rs` | tool list and `TOOLS.len()` 244 → 240; the `strategy.*` permission assertion rewritten (§5.1: `get`, `knowledge_get` → `[WorkspaceRead]`; notes and proposals → `WORK`; `frame_apply` → `[ContentWork, ProspectsWork, AdsWork]`); the `strategy.get` description pin; ASCII and risk tags |
| `jt_archtest/tests/twin_rule.rs` | strategy twins 10 → 2 |
| `jt_archtest/tests/m4_productisation.rs`, `fixtures/m3_surface.json` | `POST_M4_ADDED` + 24, `POST_M4_REMOVED` + 11, `POST_M4_PANEL_ONLY` + the panel-only rows (−1 `strategy.add_channel`) |
| `jt_archtest/tests/gate_rule.rs` | `EXEMPT_IDS` adds the seven `content.*` rows, `studio.posting_policy_set` and the four stops; `strategy.` prefix covers the new ids |
| `jt_app/tests/gate.rs`, `jt_archtest/tests/inbox_without_strategy.rs` | the "without strategy" cases become "empty knowledge base"; the gate test adds "first card opens the gate" and "a Kurallar save does not" |
| `jt_archtest/tests/twin_parity.rs` | the consultation walk replaced by: card writes in the panel, `frame_apply` over MCP, then `GET /api/strategy` = `jeeta.strategy.get` and `GET /api/knowledge` = `jeeta.strategy.knowledge_get` field for field |
| `jt_archtest/tests/wake_triggers.rs` | rows of §5.3; `the_clocks_own_work_wakes_nobody` also matches `wake::request_for(`; `strategy.approve` row removed in PR 7 |
| `jt_archtest/tests/dependency_boundaries.rs` | `jt_knowledge` depends on `jt_strategy`, `jt_studio`, `jt_tenancy` only; `jt_app` on `jt_knowledge` |
| `jt_archtest/tests/studio_rules.rs` | registry size 240; `hypothesis_propose` removed from its permission list (PR 7) |
| `jt_pg/tests/migrations.rs`, `studio_repos.rs` | §7.1 |
| `jt_mcp/tests/work_mcp.rs`, `jt_panel_http/tests/work_http.rs`, `onboarding/m4_onboarding_http.rs`, `mcp_http.rs` | `knowledge` state instead of `consult_strategy`; `STRATEGY_REQUIRED` with the new message |
| `jt_testkit` fakes and contracts (`fakes/strategy.rs`, `studio.rs`, `tenant.rs`, `activation_contract.rs`, `studio_contract.rs`, …) | `KnowledgeRepo` fake; frame engine helpers |

### 8.5 i18n

- `tr.json` and `en.json` stay in parity (`i18n/parity.test.ts`): namespaces `postsPage` and
  `knowledge` added; `strategy` removed (its `remove` key moved to `common.remove` for the
  capability dialogs); `stops.*` loses `no_approved_strategy`, `channel_not_in_strategy`,
  `no_hypothesis`, `approve_strategy`, `prepare_strategy` and gains `knowledge_empty`;
  `socialAccounts.blocked.*` gains `knowledge_empty`, loses `channel_not_in_strategy`; `onboarding`
  step keys renamed; `moduleStatus` rows renamed.
- Reused copy rendered on `/posts` and `/knowledge` is re-worded in tr and en (PR 5 for the posts
  page's namespaces, PR 3 for the knowledge page's): `materials.finding.*` (e.g.
  `names_other_olay` → `Metin başka bir kategorinin adını, yerini ya da müşterisini anıyor.`,
  `hypothesis_not_in_approved_strategy` → `Paylaşım ajanların konularından birine bağlı değil.`,
  `olay_unconfirmed` → `Bağlı olduğu kategori henüz onaylanmadı.`), `materials.olay.*` (`Yeni olay`
  → `Yeni kategori`, `Olayı oluştur` → `Kategoriyi oluştur`), `materials.editor.*` (`Başka olaya
  taşı` → `Başka kategoriye taşı`, `Olay` → `Kategori`), `materials.policy.*` (`materyal` →
  `dosya`), `content.queue.*` (`Olayı seçin` → `Kategori seç`; `needs_filing` → `Ajan bu dosyayı
  bir kategoriye yerleştiremedi. Bir kategori seç ya da dosyayı sil.`), `content.genelHelp`,
  `socialAccounts.refusal.*` (`bu sürüme zaten zaman verilmiş` → `bu paylaşıma zaten zaman
  verilmiş`), `stops.*` (`onayınızı` → `onayını`: the owner is `sen` everywhere on these pages).
  The wake copy keeps its existing `çağrı adresi` (`agent_sleeps` uses it too). The backfill
  proposals' reason is `Daha önce yazılmıştı ama uygulanmamıştı.`
- A new **render** test `i18n/ownerWords.test.tsx` mounts `PostsPage`, its three drawers and
  `KnowledgePage` over fixtures that hold every row kind, every wait code, every
  `materials.finding` code, every stop and every note outcome, and fails when the visible text
  (Turkish) contains `olay`, `paket`, `sürüm`, `durak`, `hipotez`, `strateji`, `ICP`, `kadans`,
  `materyal`, `onay bekleyen sürüm` or `taslak` (case-insensitive), except the TikTok phrases
  `TikTok'ta taslak` and `TikTok'taki taslaklarına` (TikTok's own word for its drafts), and when it
  mixes `siz` forms into the `sen` pages (`onayınız`, `seçin`, `ekleyin`). A namespace list could
  not see server text or reused keys; the rendered page can (G6). `Kategori` is the only name for an
  olay the owner reads.
- English copy is written for every Turkish key (the panel's `en` locale), same meaning.

## 9. Decisions taken by the lead

| # | Decision | Why |
|---|---|---|
| D1 | **Post approval is owned by the knowledge base**: a workspace switch (`post_approval`) and a per-account list (`post_approval_accounts`), read by the effective gate (§3.10.1) with TikTok's screen; the capability's stored `requires_human_approval` is no longer read for posts, and nothing writes it for them (K4 says to write it onto every social account). | The stored flag also holds every agent **comment reply** on the account (`inbox/replies.rs:526-537`: `held = cap.policy.requires_human_approval && !human` for public items), so writing it would make the owner approve comment replies, which "her paylaşım onayıma gelsin" does not ask. Reading the switch *and* the stored flag (the draft's first answer) put the decision in two places: switching Kurallar off left flagged accounts waiting while the box said posts go out. One owner of the rule fixes both; the seed copies every flagged account into the list, so no post that waits today is released (§4.3.2); an agent's `capability.set_policy` can no longer lower a post approval. K4's other parts (one switch, the default for new accounts, TikTok counts as gated) are kept. |
| D2 | **Kurallar's ad budget is its own number (`ad_cap`), the ceiling nothing else crosses**: only a person in person with `budget.manage` sets it (raising included); `check_general` holds the general item at or below it for everyone; the frame's paid lane is mirrored from it; the backfill and the old-approval re-sync only ever lower it; a lowering runs the ads watch at once. | One number for the owner (K4). The draft made the general item itself the cap, but `jeeta.budget.items_update` needs only `budget.manage`, a scope an agent key may carry (`api_keys.rs:10-12`), so an ads agent could have raised its own ceiling and the mirror would have raised the lane. With `ad_cap` separate, agents can lower spend, never raise it; Bütçe writes no frame and takes no frame lock (no lock cycle, §4.10.13). |
| D3 | **The frame's organic lane is the owner's paid-message limit (`message_cap`)**: carried as it is from the approved frame, shown in Kurallar while set, changed only by the owner; a frame that never had one has none, and a missing organic lane is no lane cap. | The owner approved v5's organic lane of 0 TRY a month; dropping it on normalisation would start paid messages (SMS, metered sends) without a decision (R3). A workspace that never had an organic lane gets none rather than a made-up one: its metered sends stay bounded by their linked budget items (a reservation without items is `invalid_spend_context`) and the capability's own cap. |
| D4 | **A bootstrap frame from the first card text a person writes or accepts** (or a filed note of theirs), in that transaction; never from Kurallar or Hedefler, a seed, or the job except to repair a skipped bootstrap. | K3 keeps the gate "an approved frame exists"; without the bootstrap a new workspace waits for an agent's derivation (up to a day without a wake address) before its first post can be delivered — a clock the owner hates. Text the owner never approved (a draft) never opens the gate (D15). One predicate ("a live card has text") is then both "not empty" and "has a frame" (§4.5.1). |
| D5 | **A file a person attaches to work (composer, capture answer, need answer, special day) is shared by rule once an analysis made with `sensitive_checked` finds no face, child, name, client logo, corporate reference or named person; the rule's share has `by: None`; the work waits for its files.** | §3.4.3–§3.4.4: unfiled files could never be sources (O5) nor filed genel by analysis (O7); the people rules are kept exactly where they protect someone (R3); `by: None` keeps "a person must look" true if a later analysis finds a face; an older routine that did not look (no `sensitive_checked`) gets no rule. Waiting for analysis (minutes, the materials agent is woken) is better than a post made without the photo and refused at delivery, and every upload path waits the same way. |
| D6 | **Prohibitions are instructions, not server checks.** | Free text cannot be matched reliably; a false refusal would dead-end deliveries. Every agent read carries them, the hints say they bind, and the final look stays the owner's (approval switch, TikTok screen). The Kurallar dialog says so plainly. |
| D7 | **Stage 5 is labelled `Uyarlama`, not `Paket`.** | "Paket" is one of the internal words the owner listed; the stage is "adapting to each platform" (steps 11–14). Its internal key `paket` stays. |
| D8 | **Olays an agent proposed are confirmed in Dosyalar, not counted in "Seni bekleyen".** | A proposed olay blocks nothing the owner asked for (a person's upload confirms its own olay, O7); counting it would put the hated concept in the owner's main list. |
| D9 | **A topic left out of a derivation stays live, as a closing topic, while a planned or ready post, a live ad-set binding, a queued budget move or an ad of a running campaign names it; it keeps the content types and paid cadence those use, gets no new work, and the system retires it once nothing names it.** | Retiring it would retire and withdraw posts the owner may have approved or that a platform holds (A1.19), and brake the paid lane on the next rollover; keeping it live but offering it again would keep making posts about an idea the owner deleted. Closing does both right and needs no new knowledge edit to finish. |
| D10 | **No strategy archive; the owner's stop is `Tüm paylaşımları durdur` (brake), said on the page while on.** `strategy.archive` refuses on a seeded workspace. | Archiving the frame would close the gate under a full knowledge base; the brake already exists and stops what runs (A0.5). |
| D11 | **`hypothesis_id` is optional on delivery only for an area a person asked for; left out, the post is the owner's request.** Agent and system areas still name a topic. | A person's posts are measured on their own arms, never mixed into a topic (design 2026-11-19 F2); the draft's default "the frame's first live topic" would have credited topic #1 with every owner request. |
| D12 | **`studio.posting_policy_set` and the four CAPABILITY_EXEMPT stops become Exempt.** | The posting policy is not strategy (A1.25); stopping what runs must never wait for a gate (A2 risk: after an archive nobody could pause an outreach campaign). |
| D13 | **A person's post cancel needs `social.manage` or `content.manage`; an agent's keeps `social.work`.** | Reconciles server (`social.work`) and panel (`social.manage`) (A3 risk) and lets a content manager cancel a post of their own content, which P1's "İptal per post" offers on one page. |
| D14 | **Archived contents are not listed.** | Archiving is how a content leaves the owner's list; their published posts stay reachable through `post_get` links. |
| D15 | **Draft differences, and a never-approved draft's parts, become proposals; the consultation's answers become a card.** | Nothing the owner said is lost, and nothing unapproved takes effect without the owner adding it. |
| D16 | **No new permission.** KB edits need `team.manage`; agents file notes and propose with any work permission; derivation parts need `content.work` / `prospects.work` / `ads.work`. | A new permission would need new API keys for every routine (keys' scopes cannot be changed in place), a dead end on deploy day. |
| D17 | **PDF is accepted as a knowledge attachment only.** | A price list or catalogue is typical knowledge; `material_add` refuses it so it can never be posted. |
| D18 | **`content.version_cancel` with `VersionCancel.slot_id` optional, read tolerantly from PR 1.** | No write could cancel a version with no post (A4.14); reading it from PR 1 on keeps every rollback target able to read it (§7.6). |
| D19 | **`wake::request_for`: the system wakes on behalf of the person who caused the work.** | A delivery, a filed note, an applied frame or a file becoming usable is an agent's or the system's action, which wakes nobody today; the owner asked in person, so the next agent should not wait for its schedule (R2). |
| D20 | **Composer stops are said before sending but never block it.** | R1 asks to say everything at once; blocking would force the owner to come back; the stopped work resumes by itself when the cause clears (R2). |
| D21 | **Two derivation parts (posting, prospecting) acknowledged separately, each due only for its own cards.** | The content and research routines are different agents with different keys; a `voice` or Kurallar edit wakes neither, a `who_we_seek` edit only research. |
| D22 | **Debounce = the wake's own settle and limits + a structural diff + agents sending what stays verbatim; no listing delay, no stored pending frame.** | A quiet delay hid the item from the agent the wake had just called, and `checkin_seen` then dropped the wake; the settle already batches bursts, and a derivation made mid-burst acknowledges only what it read. |
| D23 | **`PendingOut.strategy` kept, reduced, until PR 7.** | Routines may read it; removing it with the tools keeps one breaking moment. |
| D24 | **Old strategy tools kept until the routines moved (PR 7), re-syncing the knowledge base on approval.** | G7: an MCP client sees no compile error, and nothing an old routine or page approves is lost or later undone by a derivation (§4.3.4); the removal waits for evidence of no calls. |
| D25 | **No feature flags.** | §7.4: the server PRs are compatible; flags would only prolong two pages. |
| D26 | **A failed post of no content is no wait.** | Nothing the owner can do sends it again (design 2026-11-19 C8/O5 stays open); counting it would be a wait without an action. |
| D27 | **Special-day lines: preparation within 14 days, three at most.** | The tree lists 120 days ahead; the owner's page shows only what is near, the rest is in Ayarlar. |
| D28 | **Knowledge edits are owner or manager work (`team.manage`), viewing is everyone's.** | The knowledge base steers every agent; the previous strategy writes had the same permission. |
| D29 | **Note and card attachments are knowledge, never library materials** — except through a note's post-request outcome, which hands its images and videos to a content as the composer would. | They are read, not posted, so the consent path of materials does not apply and nothing in them can go out by mistake; a note that asks for a post is the owner's in-person request with its files. |
| D30 | **`Neler işe yarıyor` shows topic titles with İlgi buckets.** | "Learned results may stay"; titles are the agent's words for subjects ("Fotoğraftan figüre dönüşüm"), buckets avoid numbers that look like approvals. |
| D31 | **The 2026-10-22 spec's K2, B1, B6, B7 are superseded as follows:** K2 "no work without an approved strategy" → "no gated work without a frame, which exists once the knowledge base has a card"; B1 `STRATEGY_REQUIRED` keeps its code with the knowledge message; B6 "every post and ad tied to a hypothesis and a version" holds (topics and frames); B7 "the paid cap of the budget frame" holds, mirrored from Kurallar's ad budget. | The code comments cite them; this note is now their source. |
| D32 | **`frame_apply` takes no prohibitions, goals or budgets** (K3 lists prohibitions and goals among the derived parts): the system copies Kurallar and Hedefler into every frame it writes. | They are the owner's own structured words, not something to derive; K4 already says prohibitions are read live and "mirrored into the frame on derivation" — the mirror is the system's, so no agent can drift from what the owner wrote. |
| D33 | **`content.posts` and the file writes are gated by the library module, not by `content`** (P2 says "content module"). | `gating_module` maps every `content.*` id to the install-gated `content` module (`jt_app/src/gate.rs:130-162`, `modules.rs` `INSTALL_GATED`), so a workspace with social but no content module would get `MODULE_NOT_INSTALLED` on the page P4 shows to it. The library comes with content, social and ads and has no requirement, exactly like the content page's library reads of 2026-11-18. The composer and the version cancel stay the content module's. |
| D34 | **Identity is a system field mirrored from the cards, and texts are never structural** (K3 lists identity among the derived parts): identity, objective, segment names and descriptions, topic titles, angles, metrics and priors do not make a version; the latest are written with the next structural one. | An agent rewording free text from the same cards almost never reproduces it byte for byte, so the draft's whole-section diff made a version per edit; every version re-reserves bound ad sets, refuses in-flight spend (`strategy_changed`) and logs late completions. Every reader that needs identity reads the cards live (§4.12, §5.4). |
| D35 | **One lock order for every frame write and everything it mirrors** (§4.10.13), and `recheck_periods` retries an `INTERNAL` failure once before braking. | The draft's `rules_save` took the settings and the budget item before the frame, the reverse of every spend path; a deadlock victim in `refresh_period` would have braked the whole paid lane. |
| D36 | **Validation covers only what a call brought; segments a live row still uses are carried.** | Inherited content (30+ topics, the owner's request's segment, a retained topic's or another part's segment) would otherwise refuse an owner's budget save, block normalisation forever, or refuse a correct derivation the agent cannot fix. |
| D37 | **A derivation is a compare-and-set** (`derivation_stale`), the frame is read under its lock, and the hourly research planner takes the frame lock. | Two overlapping runs could otherwise let an older derivation overwrite a newer one (retiring topics that come back with new ids) and the planner supersede tasks an apply just carried. |
| D38 | **Notes close with what they ask** (cards, rules, goals, a post request, proposals), as the note's person's words; caps and the approval switch never. | A note that states a rule or asks for a post is the owner's explicit request (R3); making it a proposal to approve again, or dismissing it, loses it or tells the owner late (R1). Money and approval stay in Kurallar, where the owner sees them. |
| D39 | **A failed post's action follows its cause, and `Bırak` acknowledges it.** | `Tekrar hazırlat` redoes the whole content, withdrawing its other planned posts, and cannot fix a lapsed login or a rate limit; one click must not take back an approved sibling unseen, and an owner who only wants to drop the post needs a way out. |
| D40 | **Fixing an account wakes the social agent** (`account_connected`), and so does releasing the brake (`posting_resumed`). | R2: when the owner removes the obstacle the work goes on by itself, not at the agent's next scheduled run. |
| D41 | **Release in five deploys** (§7.4): store; knowledge server + page; posts server + page; agent tools then routines; retirement. | The owner sees Bilgi bankası at the second deploy and Paylaşımlar at the third; the old strategy page stops taking writes the day the new page arrives, and the re-sync closes the window in which an old path could write a frame the cards do not show. |
| D42 | **A TikTok post sent to drafts is its own status** (`TikTok'ta taslak`), waiting for the owner until acknowledged or 7 days old. | It is not live: the owner still has to post it in the TikTok app, and no counters will come. |

## Appendix A. Review notes

Three adversarial reviews (data, agents, owner) of the first draft returned 33 findings. Each was
checked against `803cab98` before being resolved; the line references below are where the code
confirmed it.

| # | Lens, severity | Finding | Verified | Resolution |
|---|---|---|---|---|
| 1 | data, blocker | An agent key with `budget.manage` could raise the Kurallar ad cap through the general item | yes: `budget.rs:112-117, 197-203, 547-590`; `catalog.rs:470-474`; `api_keys.rs:10-12` | `ad_cap` separate, `check_general` against it, Bütçe runs no mirror (§4.6.2, D2) |
| 2 | data, blocker | A draft-only workspace bootstrapped a frame from unapproved text by the job | yes: `strategy_gate.rs:29-45`, `replies.rs:1043-1047` | blank seeds + proposals, no frame; bootstrap only on a person's card text (§4.3.1, §4.10.5, D4) |
| 3 | data, major | Lock order inverted against the spend paths; a deadlock could brake the paid lane | yes: `budget.rs:240`, `studio/budget.rs:16-42, 619-630`, `studio/ads.rs:788-806` | one lock order, retry before braking (§4.10.13, D35) |
| 4 | data, major | Retained topics still broke committed work (cadence, bindings, segments) | yes: `jt_studio/src/chain.rs:164-199`, `studio/ads.rs:100-131, 824` | retained set incl. bindings and ads, cadence union, segments carried (§4.10.2 steps 2–4, D9) |
| 5 | data, major | Normalisation silently lifted the approved organic lane of 0 | yes: v5 `budget_frame.lanes`, `studio/budget.rs:95-101, 587-589, 661` | `message_cap` carried and shown in Kurallar (§4.6.4, D3) |
| 6 | data, major | Validation of inherited content refused rules saves and normalisation | yes: `rules.rs:292-358`, `owner_request.rs:67`, `strategy.rs:610` | validate only what the call brought; system causes never refuse the owner's write (§4.10.2 step 6, D36) |
| 7 | data, major | Stale derivations and the hourly research job could overwrite newer state | yes: `research.rs:211-213, 279-283` | `derivation_stale`, settings read under the frame lock, `plan()` locks the frame (§4.10.2, §4.10.7, D37) |
| 8 | data, major | Rollback plan: wake reasons in `last`, RLS in the down, the down dropping knowledge, the approval switch | yes: `ports/wake.rs:76, 248, 286`; `agent_connections.rs:20-21, 170-180`; `0009_studio.down.sql:3-12` | tolerant decoding in PR 1, separate strip script, guarded down never used for binary rollback, approval written back before a rollback (§4.2, §7.1, §7.6) |
| 9 | data, major | Old approvals after seeding never reached the cards and were undone by the next derivation | yes: `strategy.rs:593-711` | re-sync on old approval, `/strategy` writes refused from PR 3, `archive` refused (§4.3.4, D10, D24) |
| 10 | data, major | "First live topic" default misattributed owner requests | yes: `schedule.rs:784-813`, `delivery.rs:161-166` | person's request → owner's-request hypothesis; agent areas still name a topic (§3.5, D11) |
| 11 | data, major | Rule share with `by` = uploader hid later sensitivity | yes: `eligibility.rs:131-133`, `material.rs:183-191` | `by: None` + `rule`, `sensitive_checked` required (§3.4.4, D5). Clearing the share on a later finding is not needed: with `by: None` the gate already refuses `sensitive_needs_human` |
| 12 | data, major | Free-text diff made a version on almost every change | yes: `studio/budget.rs:51-53, 68-69`, `studio/ads.rs:824-826` | structural diff, identity mirrored, per-part revisions, verbatim hint (§4.10.1, §4.10.9, D34) |
| 13 | agents, blocker | `frame_apply` refused correct derivations for rows the caller never sent | yes: `rules.rs:226, 337`, `owner_request.rs:67`, `strategy.rs:610` | segments carried (`kept_segments`), owner's request outside checks, gaps by input index, `prospecting.segments` (§4.10.2–§4.10.3, D36) |
| 14 | agents, major | 30 s listing delay hid the item from the woken agent; `checkin_seen` dropped the wake | yes: `ports/wake.rs:348`, `wake.rs:376-392`, `work.rs:1079-1081` | no delay; `note_file` wakes `KNOWLEDGE` for the filer too; hint says call `work.pending` again (§4.10.9, §5.2, D22) |
| 15 | agents, major | Notes asking for a rule or a post had no outcome | yes (spec §4.8, §5.2) | outcomes `rules`, `goals`, `post_request`, `proposals` (§4.8, D38). The suggested `Geri al` for rules is a `Kurallar` link instead: removing a line there is one ×, no extra write |
| 16 | agents, major | Skip-when-unchanged almost never skipped (prohibitions, goals, prose) | yes, same as 12 | same as 12; Kurallar and Hedefler make no derivation due (§4.4 step 3) |
| 17 | agents, major | An agent could raise the ad cap | same as 1 | same as 1; the budget tools' descriptions say so (§5.1) |
| 18 | agents, major | Two definitions of "empty" looped (Kurallar-first owner) | yes: `rules.rs:94-95` | one predicate, "a live card has text"; bootstrap only on cards; `knowledge_empty` refusal for a derive without a frame; the `hypothesis_does_not_post` listing dropped (§4.5.1, §4.10.5, §5.2) |
| 19 | agents, major | A left-out topic kept for its posts was never retired and kept getting posts | yes: `posts.rs:193-232, 249` | `closing_topic_ids`: excluded from every offer, retired by `knowledge_settle` (§4.10.2, §4.10.6, D9) |
| 20 | agents, minor | Wake plumbing: module of the item, bootstrap wakes, archtest blind to `request_for` | yes: `wake.rs:287`, `work.rs:1020` | work module none for posting; bootstrap wakes per writer; calendar wake in the use case; archtest matches `request_for(` (§5.2, §5.3, §8.4) |
| 21 | agents, minor | The ads agent's paid-cadence path retired topics | yes (spec §4.10.3) | separate `paid_cadence` part that retires nothing; in `ADS_PLAN_HINT` (§4.10.3, §5.2) |
| 22 | owner, blocker | Seed once, old write paths open until PR 4/6, owner's approvals lost; HummyTummy via old tools | yes, same as 9 | same as 9; seeding and the new page land in one deploy; HummyTummy through card, rules and goal writes only (§7.2, §7.4, D41) |
| 23 | owner, major | Post approval in two places misled the owner; per-account switch also held comment replies | yes: `replies.rs:528-537` | approval owned by the knowledge base (switch + list); Hesaplar writes the list, never the stored flag (§3.10.1, §4.6.3, §4.6.5, §2.9.2, D1) |
| 24 | owner, major | Only composer files got the files gate; capture, need, special day, deletion stranded work | yes: `items.rs:1020-1053`, `eligibility.rs:62`, `content_areas.rs:1003-1008` | one rule for every person upload, pending lists, day-line file states, `material_delete` clears lists (§3.4.4, §3.7.1, §3.10.4, §2.7.5, D5) |
| 25 | owner, major | The brake was invisible on Paylaşımlar and freed posts looped | yes: `studio/chain.rs:259-260`, `ready.rs:34` | red line, `Durduruldu`, composer stop, no offers while braked, wake on release (§2.2, §2.4, §3.10.2, D10, D40). Not counted in `Seni bekleyen` (the reviewer's suggestion): a count with no row under the filter would say there is something to do and then show nothing; the red line says it once |
| 26 | owner, major | `Tekrar hazırlat` withdrew siblings unseen and was wrong for most causes | yes: `content/areas.rs:220-261` | action by reason, dialog with the consequence line, `Bırak` (§2.6, §2.7.1, §3.7.4, D39) |
| 27 | owner, major | Connecting or reconnecting woke nobody | yes: no wake in `connector.rs`, `capabilities.rs` | `account_connected` wake sites (§3.6, §5.3, D40) |
| 28 | owner, major | Empty predicate vs bootstrap (yasak first) | same as 18 | same as 18 |
| 29 | owner, major | Internal words through reused copy and server text | yes: `tr.json` `materials.finding.*`, `materials.olay.*`, `content.queue.*`, `socialAccounts.refusal.version_already_scheduled`, `stops.approval`, `wake.line.noAddress` | re-worded namespaces and a render test over every code (§8.5); `çağrı adresi` kept |
| 30 | owner, major | Nothing for the owner until the sixth step | yes (draft §7.4) | five deploys, Bilgi bankası at the second, Paylaşımlar at the third (§7.4, D41). The proposed order (posts before the frame engine) is not taken: before PR 2 the rows would show strategy-coded blocks the owner can no longer fix (`/strategy` read-only) and card edits would not reach old routines (no compat projection yet) |
| 31 | owner, minor | Advice lines always shown; a named, unconnected platform found late; same-platform accounts look alike | yes: `schedule.rs:701-706` | advice merged and shown on focus; client-side platform check; `no_account_for_platform`; `{Platform} · {hesap}` badge (§2.2, §2.8, §3.2.4) |
| 32 | owner, minor | Agent offline not said on Bilgi bankası; notes not read before filing; overdue queue line | yes (spec §4.11, §4.12) | note composer stops, agent line, open notes in `inbox.context` and `slot_get`, `late` sub-state (§4.11, §4.12, §2.4) |
| 33 | owner, minor | A TikTok draft read as `Yayında` | yes: `studio/tiktok.rs:16-18, 129-131, 475-476` | `tiktok_draft` status with `Tamamladım` (§2.4, §2.6, D42) |

No finding was rejected as wrong. Two were adopted in another form (25: the brake is not counted in
`Seni bekleyen`; 30: a different PR order), one in a smaller form (15: a link instead of `Geri al`),
and one suggested write was found unnecessary (11: clearing a rule share), each for the reason given
in its row.
