# Paylaşımlar and Bilgi bankası — design

Date: 2026-11-19. Status: design complete, every open point decided by the lead (§9); nothing waits for
the owner. Base: `origin/design/jeeta-refinement` at `803cab98`, schema 45. Evidence: the eight-reader
code map of that commit (`jeeta-design/map.json`, cited below as **A0–A6** for its areas and **A*n*.*m***
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
  (`content.post_request`), plus three small writes for what had no endpoint (`content.files_add`,
  `content.special_day_skip`, `content.version_cancel`).
- **Bilgi bankası** (`/knowledge`) replaces `/strategy`: free cards, a short **Kurallar** box,
  **Hedefler**, a note composer ("Ajanlara bir şey anlat"), the agents' proposals, and a read-only
  "Neler işe yarıyor". The owner's edits apply at once; there is no draft, submit or approval.
- **The frame** stays: `strategy_versions` and `strategy_hypotheses` remain the internal, append-only
  execution frame every Studio, research and outreach row points at (K1). The owner never sees it.
  It is applied **by the system** from what agents derive from the cards (`jeeta.strategy.frame_apply`),
  from the owner's Kurallar (ad budget) and, for a brand-new workspace, from the first card the owner
  writes (bootstrap). The gate predicate is unchanged: "an approved frame exists" (K3).
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
| G6 | No owner-facing internal word: olay, paket, sürüm, durak, hipotez, strateji onayı, ICP. | i18n review list (§8.5). |
| G7 | Agents outside the repo keep working through the change. | Compatibility projection of `jeeta.strategy.get` (§5.4); old tools removed only after the routines move (§7.4). |

### 1.3 Non-goals

- No change to how a post is approved, sent, measured or learned (Studio chain, publisher, TikTok
  posting screen, measurements, arms).
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
| Kurallar | prohibitions + ad budget + post approval switch |
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
2. **Agent line** (one line, under the subtitle, from the merged `AgentWakeLine`, §2.9.4).
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
     `YouTube`, `Pinterest`, `Google`); `—` with `title="Ajan seçecek"` while no account is chosen.
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
| `need` | an open request of the çekim listesi (a photo or video the system needs) | the request's own sentence | disappears when answered or dismissed |

Not rows: retired posts that never went out (cancelled, replaced, replanned: they are history),
archived contents (D14), olays awaiting confirmation (they live in Dosyalar, D8).

### 2.4 Row statuses

The pill word, its tone, and when. One status per row, first matching line wins.

| Status | Pill | Tone | When |
|---|---|---|---|
| `failed` | `Paylaşılamadı` | red | a post that will not go out: its one attempt failed or was refused, or it passed its grace unsent (`PublicationFact.failed`) |
| `waiting_you` | `Seni bekliyor` | amber | the row has at least one wait (§2.6) |
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
| start time in the future (a special day's content) | `{gün ay} günü hazırlanmaya başlanır` |
| its files wait for analysis | `Dosyaların inceleniyor` |

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
| `post`, out, measurements still to come | 7 Sonuç | current |
| `post`, out and measured (or retired after its measurements) | 7 Sonuç | done |
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
| `files_permission` | `İzin bekliyor` | sensitive: `Dosyanda {yüz / isim / çocuk / logo / kurum adı} görünüyor; paylaşılması için izin ver.`; no analysis possible: `Dosyalarının paylaşılabilir olduğunu onayla.` | `İzin ver` → `studio.material_permission` (`shareable`) for each such file | `Bu dosya olmadan devam et` → `studio.project_materials` (remove) |
| `files_quality` | `Dosya uygun değil` | `Ajan bu dosyayı paylaşmaya uygun bulmadı: {neden}.` | `Yine de kullan` → `studio.material_intelligence_update` (quality `publishable`) | `Bu dosya olmadan devam et` |
| `delivery_held` | `Takıldı` | `Ajan bunu üç kez hazırladı ama kontrolden geçemedi: {ilk bulgu}.` | `Düzenleme iste` → `content.area_redo` | `Yine de kabul et` → `content.delivery_accept` (only when the server says it is releasable) |
| `check_hold` | `Bekletiliyor` | `Paylaşım saatinde bir kontrol durdurdu: {neden}.` | `Düzenleme iste` | `Yine de paylaş` → `studio.material_check_release` (only for caption findings, as `MaterialHold` did) |
| `failed` | `Paylaşılamadı` | `{Kanal} bu paylaşımı almadı: {neden}.` | `Tekrar hazırlat` → `content.area_redo` with the note `Paylaşım gönderilemedi; aynısını yeniden hazırla.` | — |
| `no_account` | `Hesap yok` | `Paylaşacak bağlı bir hesap yok.` | `Hesap bağla` → opens Hesaplar at "Hesap bağla" | — |
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
  `permission` → `hesabın paylaşım izni yok`, `rate_limited` → `platform çok sık paylaşımı durdurdu`,
  `validation` / `refused` → `platform içeriği kabul etmedi`, anything else → `platforma ulaşılamadı`;
  `missed_grace` → `zamanı geçti`.
- `{neden}` of `check_hold`, `delivery_held`, `files_quality`: the first finding's existing Turkish
  copy (`materials` namespace refusal words), never the code.
- Which server reason gives which wait: §3.2.4.

Counted in `Seni bekleyen`: every row with a wait. A `failed` post of no content has no action (nothing
the owner does sends it): it is `Paylaşılamadı` without a wait, never counted, and it leaves the
default view seven days after it failed (it stays reachable under `Yayın`).

### 2.7 Detail panel

No tabs, no step list. Top to bottom (mockup F):

1. 92 px image (the cover; a video shows its first frame and a play mark), beside: title (17 px,
   two lines max), `{Kanal} · {zaman}` and the status pill.
2. Wait sentence when the row waits (§2.6), amber box.
3. **Actions**, one row of buttons, only those the server says this viewer may take
   (`actions`, §3.2.3), in this order: the wait's primary action (filled), `Onayla` or
   `TikTok'ta tamamla` when not already the primary, `Düzenleme iste`, `İptal`; the wait's
   secondary action as a text button under them. No action: no button row.
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
today.

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
`special_day {key, year}` (§3.7.1); the line becomes `Fotoğrafın alındı; ajan bakıyor.` until the
file is usable, then disappears (R2). `Bu yıl geç` calls `content.special_day_skip {key, year}`
(§3.7.2); toast `Bu yıl {Gün} için paylaşım yapılmayacak.` with `Geri al` (calls `studio.calendar_set`
with `enabled: true`).

### 2.8 Composer "Ne paylaşalım?"

- Text 1–2000 characters, files 0–10 (JPEG, PNG, WebP, GIF up to 25 MB; MP4 up to 200 MB). `Dosya`
  opens the picker; dropping files anywhere on the page attaches them to the composer (not to the
  library: that is Dosyalar). Attached files show as chips (`{ad} ×`) with upload progress; a failed
  upload shows `Yüklenemedi · Tekrar dene`.
- `Gönder` uploads the files (`studio.file_upload`, one by one, the existing tray logic of
  `uploads.tsx`) and then calls `content.post_request {request_key, text, file_ids}`. Enter sends;
  Shift+Enter is a new line (the input grows to three lines).
- **Before sending (R1)** the composer shows, under itself, every stop the server already knows
  (`content.posts.composer.stops`, §3.2.5), one line each with its action; sending stays possible
  (D20):

| Stop | Line | Action |
|---|---|---|
| `knowledge_empty` | `Ajanlar seni henüz tanımıyor. Önce Bilgi bankasına birkaç satır yaz; isteğin o zaman başlar.` | `Bilgi bankasına git` |
| `no_account` | `Paylaşacak bağlı bir hesap yok; içerik hazırlanır ama bir hesap bağlayana kadar çıkmaz.` | `Hesap bağla` |
| `no_content_agent` | `İçerik hazırlayacak bağlı bir ajan yok.` | `Ajan bağla` |
| `agent_sleeps` | `Ajanın uyandırma adresi yok; bir sonraki çalışmasında ({saat}) başlar.` | `Uyandırma adresi ekle` (→ `/agents`) |
| `approval` (advice) | `Her paylaşım yayından önce onayına gelir.` | — |
| `posting_screen` (advice, per TikTok account) | `TikTok paylaşımlarını TikTok ekranında sen tamamlarsın.` | — |
| `video_only` (advice) | `Bağlı hesapların yalnızca video alıyor; video eklemezsen ajan görselden video yapar.` | — |

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
  `Her paylaşım onayına gelir (Kurallar)`; while it is off, a switch `Her paylaşım onayıma gelsin`
  writing that account's flag (`capability.set_policy`, the stored policy with only
  `requires_human_approval` changed). TikTok always reads `Her paylaşım TikTok ekranını bekler`.

#### 2.9.3 Ayarlar

One dialog, no tabs: three headed sections in one scroll, with anchors (`section=rules|days|files`):

1. `Paylaşım kuralları`: the existing `SettingsDialog` body (caps, quiet hours, zone, per-format
   lead and grace, floor, debounce, horizon, provider scheduling), plus at its end the switch
   `Tüm paylaşımları durdur` (`studio.brake`, organic lane, `social.manage`) — the owner's one stop
   now that the strategy has no archive (D10).
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
| `content.*` only (no `social.*`) | every row; Hesaplar hidden; `Paylaşım kuralları` hidden in Ayarlar | composer (`content.manage`), `Düzenleme iste`, content and version `İptal` (`content.manage`), post `İptal` (`content.manage`, D13); not `Onayla`, not `TikTok'ta tamamla` |
| `social.*` only (no `content.*`) | every row; no composer (it is absent, not disabled) | `Onayla` / `TikTok'ta tamamla` (`social.manage`, owner or manager in person), post `İptal` (`social.manage`), `Zaman seç`, `Sürdür`; not `Düzenleme iste` |
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
| `accounts=1` (+ `account={capability id}`, `days=7|30|90`) | the Hesaplar sheet, one account open |
| `settings=1` (+ `section=rules|days|files`, `year`, `day={key}:{year}`) | Ayarlar at a section |

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
| `/content?settings=1[&year=y]` (also `tab=calendar|settings`) | `/posts?settings=1&section=days[&year=y]` |
| `/content…#eksikler` | `/posts?f=you` |
| `/social` | `/posts` |
| `/social?view=all` | `/posts` |
| `/social?account=c[&days=n]` | `/posts?accounts=1&account=c[&days=n]` |
| `/social?slot=s` | `/posts?slot=s` |
| `/social?version=v` | `/posts?version=v` |
| `/social?tiktok=s` | `/posts?slot=s&tiktok=s` |
| `/social?filter=approvals|tiktok|failed|blocked` | `/posts?f=you` |
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
| 33 | Account period `days=7|30|90` | /social | Hesaplar `days` |
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
    pub composer: ComposerState,
    pub knowledge_empty: bool,
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
    pub status: RowStatus,                // failed | waiting_you | revising | preparing | scheduling | scheduled | published
    pub sub_state: Option<SubState>,      // §2.4: claimed{stage} | queued{wakes_now, next_at} | starts{at} | files_analysing
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
pub struct ChannelRef { pub capability_id: CapabilityId, pub kind: String, pub name: String }
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
    pub add_files: Option<FilesTarget>,       // capture{project_id, request_id} | need{shoot_request_id}
    pub dismiss: Option<DismissRef>,          // capture request or need
    pub resume_account: Option<AccountRef>,   // {capability_id, expected_revision}
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

#### 3.2.4 How the rows are built

One tenant bundle, **read only** (no `FOR UPDATE`: neither `ready::Reader::load` nor `work::gated` is
called), in this order; every read is one query or one batch:

1. `knowledge().settings()` (for `knowledge_empty` and the post approval switch, D1) and
   `strategy().current_approved()` (the frame, or none).
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
  shown); `files_permission` / `files_quality` (§3.4.4: a source in `pending_files` whose analysis
  found something, failed, or that no materials agent can analyse); `knowledge_empty` (no frame);
  `no_agent` (queued and no key can take `content`). Progress per §2.5.
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
| `format_not_supported`, `media_not_accepted` | `media` |
| `hypothesis_does_not_post` | none: it cannot arise under a normalised frame (§4.10.6); if it does, the row is `scheduling` and a `knowledge_derive` item is listed to the agent (§5.2) |
| `channel_not_in_strategy` | removed (K6) |

  Choices exist → `scheduling`, or `waiting_you` with `pick_time` when no key can take `social`.
- `post` row (version's, or of no content): `published` when `published_at` is set; `failed` with
  the `failed` wait (only for an area's post; §2.6) when `PublicationFact.failed`; else
  `waiting_you` with `approval` or `posting_screen` when `ApprovalFact.waiting` (`posting_screen`
  decides which), or `check_hold` when `publish_check` holds it, or `account_paused` /
  `account_unavailable` when its account is paused or cannot post now (`chain::capability_access`);
  else `scheduled`. A retired post that never went out gives no row.
- `need` rows: every open shoot request that is not a `season:` request of a special day already
  shown as a line (§3.2.5) and not an area's own capture.

The approval facts use the **effective post gate** (§3.10.1), not the stored flag alone.

#### 3.2.5 `days`, `composer`, `knowledge_empty`

- `days`: the tree's `UpcomingDay` logic (`content/views.rs:784`, extracted as `views::upcoming`), kept to days whose `prepares_from` ≤
  today + 14 days and whose window has not ended, and which have no confirmed olay of the occasion
  and season year holding a usable material (`check_use` passes). Each line carries `{key, year,
  name, window_start, window_end, prepares_from, phase, shoot_request_id, can_add, can_skip}`;
  sorted by `prepares_from`; three returned, the rest counted in `days_more`.
- `composer`: `{allowed, files_allowed, stops}`; `allowed` = content module installed and the
  caller holds `content.manage` and is a person; `stops` are the codes of §2.8 computed now:
  `knowledge_empty`, `no_account` (no postable social account: `schedule::postable`),
  `no_content_agent`, `agent_sleeps` (a key takes `content` but none has a usable address; carries
  the next expected check-in), and the advice `approval` (switch on), `posting_screen` (one per
  TikTok account), `video_only` (every postable account takes only video).
- `knowledge_empty`: §4.5.1's definition.

#### 3.2.6 Order, paging, counts

Every row of the workspace is built (bounded by: areas not archived, posts of the last 180 days,
open needs; tens of areas today, so the build is cheap; §8.1 has the budget test), then:

- **Order** (every filter): group 1 rows with a wait, oldest `since` first; group 2 `failed`, newest
  first, only for seven days after the failure (older ones fall to group 5); group 3 `scheduling`
  and `scheduled`, `publish_at` ascending (none last); group 4 `preparing` and `revising`, newest
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
   post), and the new document field `composer: {area_id, by, at}` (tolerant read: absent on every
   other material).
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

#### 3.4.4 The share permission: implied, unless analysis finds a person or a mark

Decision (asked by P3): **the owner's composer upload implies the share decision, except when
analysis finds a face, a child, a name, a client logo or a corporate reference, or names a person.**

- At upload the share stays unset (nothing is shareable before anyone looked at it).
- When `studio.material_analysis_complete` finishes a material with `composer` set and
  `share = None`: if the analysis leaves `tags.depicts` empty and `people` empty, the share is set
  to `shareable` **by rule**, `by = composer.by`, ledger `studio.material.shared_by_rule {material_id,
  rule: "composer_upload", uploaded_by}` (the pattern of O7's `confirmed_by_rule`). Otherwise it stays
  unset: the row's `files_permission` wait names what was found. An analysis that sets
  `quality` other than `publishable` gives `files_quality` instead.
- When the analysis fails, or no key can take `materials` (no analysis will come): the row shows
  `files_permission` with `Dosyalarının paylaşılabilir olduğunu onayla.` at once (R1).
- The owner's `İzin ver` is `studio.material_permission` (the person's decision, which a face or a
  child needs anyway: `SensitiveNeedsHuman` passes once `share.by` is a person).
- Each time a material of `pending_files` gets its share (by rule or by a person), or leaves the
  sources (`Bu dosya olmadan devam et`), it leaves `pending_files`; when the list becomes empty, in
  the same transaction, `CONTENT` agents are woken **on behalf of** `requested_by` with
  `ContentRequested` (§3.6).
- `ProductionProject::needs_agent` is false while `pending_files` is not empty, so no agent starts a
  post without the owner's photos and then fails its delivery on `share_unset`.

Why: faces, children, names and client marks are exactly what the share rule protects (spec
2026-11-03 D5, D17, D38; R3 keeps "consent and permission rules for people in photos"); everything
else the owner uploaded for a post is plainly meant to be posted, and asking again would be the
"waiting on a click" the owner hates.

#### 3.4.5 What the agent sees

The area is an ordinary `content_area` work item (hints empty: "you choose"). `CONTENT_AREA_HINT`
(§5.2) says: the brief is the owner's own words; a platform named in it ("sadece TikTok") is the
owner's choice: deliver only versions for it and set `capability_id`; otherwise choose among every
connected account.

### 3.5 The owner's request on any connected account

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
choices in `VersionAccounts::of`. Under a normalised frame (§4.10.6) every live topic posts
everywhere, so `pick` rarely reaches the fallback; this keeps the guarantee when it does.

### 3.6 Wakes

- **New** `wake::request_for(repos, ctx, needs, reason, person: UserId)`: as `request`, for an
  action the system or an agent takes **because a person asked** (the person is recorded in
  `caused_by`). Used by: the composer files becoming ready (§3.4.4), a delivery of a person-requested
  content (below), and a frame applied after a person's knowledge change (§4.10.8).
- `content.area_deliver`, when the delivery is accepted and `requested_by` is set: `SOCIAL` with the
  new reason `ContentDelivered` ("A content a person asked for is ready for its time."), on behalf of
  `requested_by` (P3). Agent-made and system-made contents still wake nobody.
- `content.files_add` and `content.post_request` with files: `MATERIALS` with `MaterialUploaded`.
- The module docs of `wake.rs` list the new sites; `jt_archtest/tests/wake_triggers.rs` gets one
  row per site (§8.4).

### 3.7 The three small writes

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
  window, `occasion = key`); the materials bound to it, share by the composer rule (§3.4.4, with
  `composer.area_id = None`), quality `publishable`; the open `season:{key}:{year}` request resolved
  `done`. When a material of a special-day olay gets its share by rule and the day's preparation has
  started, the calendar trigger runs for that olay in the same transaction
  (`planner::Triggers::calendar_for`, made callable) and `CONTENT` is woken on behalf of the
  uploader, so the owner does not wait for the planner's next tick (R2, R3).
- `need`: the request (open, of the workspace); materials genel, freed by the person, the composer
  share rule; the request resolved `done` with them (`shoot_resolve` internals).
- `capture`: the area's open capture request; materials bound to the area's olay, or genel freed by
  the person when it has none; added to the area's sources; the request answered `done` with them
  (`project_request_update` internals, which hands the area back to the agent and wakes it with
  `CaptureAnswered`).

Answer: the affected row (or day line). Ledger `content.files_added {target, files}`.

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
| `Sürdür` | `social.account_pause` | `{capability_id, paused: false, expected_revision}` | Exempt | `social.manage` |
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

One function, `social::approval::post_gate(c: &Capability, switch: bool) -> Option<HumanGate>`:
`PostingScreen` for TikTok, else `Approval` when `switch` (the Kurallar switch, §4.6.3) or
`c.policy.requires_human_approval`, else `None`. It replaces the stored flag in every **posting**
path: `schedule::human_gate`, `pipeline::PostReads::facts` (`required`), `studio::work::pending_in`
(slot approvals), `studio::chain::authorize_execution_at` (`capability_requires_human_approval` of the
chain context, so sending waits for the approval), `social::accounts` (`requires_human_approval` and
`human_gate` of `accounts_list` / `account_get`, already true for TikTok since F5). Paid-lane paths
(`studio/ads.rs`, `studio/control.rs` budget moves) and the inbox (`replies.rs` public replies,
`context.rs`) keep reading the stored flag: the switch is about posts only.

#### 3.10.2 Stops and blocked codes

- `social::ready` `StopCode`: `no_approved_strategy` → `knowledge_empty` (action `open_knowledge`);
  `channel_not_in_strategy`, `no_hypothesis` and the actions `approve_strategy`,
  `prepare_strategy` are removed (K6: every connected account is used; F3's checklist keeps the
  rest). `approval` uses the effective gate.
- `social::schedule::why_blocked`: `no_approved_strategy` → `knowledge_empty`; the
  `channel_not_in_strategy` step is removed. `hypothesis_does_not_post` stays as the defensive
  fall-through (§3.2.4).
- `ready::Reader::load` no longer takes `studio_control ... FOR UPDATE` in reads: a new
  `studio_control().read_control()` without the lock serves reads (`content.areas`, the accounts
  reads, `content.posts`); writes keep `lock_control` (A4.6).

#### 3.10.3 What stays readable for the old pages until they go

`content.tree`, `content.areas`, `content.olay_view`, `content.analysis_queue`, `studio.posts_list`,
`social.versions_waiting`, `social.accounts_list`, `social.account_get` keep their contracts (agents
read some of them; the old pages until PR 5). `content.tree` keeps `waiting.olay_confirmations` for
Dosyalar's count.

## 4. Bilgi bankası

### 4.1 Two layers

| | Knowledge base (owner's) | Frame (internal) |
|---|---|---|
| What | cards, Kurallar, Hedefler, notes, proposals | `strategy_versions` + `strategy_hypotheses` (K1) |
| Edited by | the owner, at once; agents only by filing the owner's notes; proposals the owner accepts | the system only (§4.10), from what agents derive and from the owner's rules |
| Read by | every agent (`jeeta.strategy.knowledge_get`, `inbox.context`, `studio.slot_get`), the owner | the engine: chain, planner, posting, research, outreach, calls, spend (≈40 call sites, unchanged) |
| History | `knowledge_revisions` (append-only) | versions, append-only (never deleted, never edited after approval) |
| Gate | none | "an approved frame exists" (unchanged) |

An owner edit never creates a frame by itself: it bumps the knowledge revision and asks agents to
re-derive (§4.10.9). Only the ad budget, which the engine enforces, is mirrored into a new frame at
once (§4.6.2).

### 4.2 Data model: migration `0046_knowledge_base`

Additive, guarded (`if not exists`), RLS forced with a `<table>_ws` policy exactly as 0045; no
foreign key to or from `strategy_*` (no cycle for the restore drill); no `studio_` prefix (the exact
studio table sets stay).

```sql
-- One row per workspace: the knowledge base's revision, its rules and goals, and what the frame
-- was last derived from.
create table if not exists knowledge_settings (
    workspace_id uuid primary key references workspaces (id) on delete cascade,
    revision bigint not null default 0 check (revision >= 0),          -- +1 on every knowledge change
    changed_at timestamptz,
    changed_by uuid,                                                     -- last person who changed it
    prospecting_revision bigint not null default 0,                      -- last change that concerns whom we look for
    prohibitions jsonb not null default '[]'
        check (jsonb_typeof(prohibitions) = 'array' and jsonb_array_length(prohibitions) <= 100),
    goals jsonb not null default '[]'
        check (jsonb_typeof(goals) = 'array' and jsonb_array_length(goals) <= 20),
    post_approval boolean not null default false,                        -- "Her paylaşım onayıma gelsin"
    rules_revision bigint not null default 1 check (rules_revision > 0),
    goals_revision bigint not null default 1 check (goals_revision > 0),
    posting_derived bigint not null default 0,                           -- revision the posting part was derived from
    prospecting_derived bigint not null default 0,                       -- revision the prospecting part was derived from
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
    cause text not null check (cause in ('seed', 'backfill', 'owner', 'proposal', 'note', 'system')),
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
    outcome jsonb check (outcome is null or jsonb_typeof(outcome) = 'object'), -- {cards:[{card_id,revision}], summary} | {dismissed: reason}
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
    proposed_by_connection uuid, proposed_by_component text,             -- an agent, or 'knowledge_backfill'
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
proposal reason ≤ 300, ≤ 20 pending proposals per workspace, ≤ 10 proposals per agent connection per
day. An attachment is `{"kind": "link", "url", "title"?}` or `{"kind": "file", "file_id", "name",
"mime"}`; a file is a live studio file of the workspace, image, MP4 or **PDF** (D17: `files.rs`
`limit` gains `application/pdf`, 20 MB, magic `%PDF-`; `material_add` refuses it with
`VALIDATION file_not_media`).

**Down** (`0046_knowledge_base.down.sql`, idempotent): drops the five tables, the trigger function
and the index; strips the new wake reasons from pending wakes so the older binary parses them
(`update agent_wakes set data = jsonb_set(data, '{pending,reasons}', …)` keeping only the 13 codes of
schema 45); refuses (`raise exception`) while a production area holds a version cancelled without a
slot (`VersionCancel.slot_id` absent, §3.7.3), which the older binary cannot read. Knowledge content
is lost by a rollback (§7.6): ops dumps the five tables first.

New Rust: domain crate `rust/crates/domain/jt_knowledge` (cards, rules, goals, notes, proposals,
limits, the seed mapping from `jt_strategy::Sections`, the frame merge and diff; depends on
`jt_strategy`, `jt_tenancy`, `jt_studio` for `PostFormat`); port `ports/knowledge.rs`
(`KnowledgeRepo`: `settings`, `lock_settings`, `insert_settings`, `save_settings`, `cards`,
`card`, `lock_card`, `insert_card`, `save_card`, `append_revision`, `revisions(subject, card_id,
cursor)`, `notes(status, limit)`, `note`, `lock_note`, `insert_note`, `save_note`, `proposals(status)`,
`proposal`, `lock_proposal`, `insert_proposal`, `save_proposal`, `expire_proposals(now)`); pg repo
`jt_pg/src/repos/knowledge.rs`; fake `jt_testkit/src/fakes/knowledge.rs`; use cases
`jt_app/src/usecases/knowledge/{mod,seed,cards,rules,notes,proposals,frame,read}.rs`; MCP tools in
`jt_mcp/src/tools/strategy.rs` (prefix kept, K7); panel routes `jt_panel_http/src/routes/knowledge.rs`.

### 4.3 Seeding and backfill

Every workspace gets its knowledge base once, by the application (not by SQL, so the mapping is
tested Rust): the first knowledge use case of the workspace, or the `knowledge_settle` job's first
tick after the deploy (§4.10.6), runs `knowledge::seed::ensure` in its own short write bundle:
`insert into knowledge_settings … on conflict do nothing`; only the bundle that inserted it writes
the cards, so two concurrent seeds make one.

#### 4.3.1 Which source

| Workspace at deploy | Seed from | Then |
|---|---|---|
| approved version, no draft | the approved version (`seed_source = approved`) | nothing else |
| approved version and an open draft | the approved version | for each part the draft changed (identity, audience, goals, prohibitions, prospecting, live hypotheses), one **proposal** (`proposed_by_component = 'knowledge_backfill'`, reason `Onaylanmamış bir strateji taslağında vardı.`): `card_edit` of the mapped card with the draft's card text, `rule_add` per prohibition only the draft has, `goal_add` per goal line only the draft has; the draft is archived (log entry `closed: the knowledge base replaces drafts`) |
| no approved version, an open draft | the draft (`seed_source = draft`) | the draft is archived; the bootstrap (§4.10.5) applies a frame when the result is not empty |
| neither | blank seed cards (`seed_source = empty`) | the page shows the empty state; the gate stays closed until the first card is written |

In every case: when any version's consultation log holds `answer` or `note` entries, one more card
`past_conversations` "Önceki görüşmeler" holds them, newest first, `• {metin}` each cut at 600
characters, whole entries only, until 8000 characters; the owner's own words stay available to
agents.

#### 4.3.2 The seed cards and their text

Positions 0–7 in this order; `key` fixed (ASCII, for agents). A part with nothing to say leaves the
body empty; the card stays (blank seeds show their placeholder, §4.10).

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

Kurallar: `prohibitions` = the source's prohibitions, as they are. Hedefler: one line per KPI,
`{name}: {target}`, or `{name}` when the target is empty. Ad budget and the approval switch:

- **Ad budget** (D2). Let *G* be the live general ad budget item (`budget_items.general`) and *L*
  the source's paid lane when `paid_enabled`. *G* and *L*: when *L*'s cap (brought to *G*'s period
  as `check_general` prorates) is lower, *G*'s cap is lowered to it (system, ledger
  `budget.items.update {reason: "knowledge_backfill"}`). Only *L*: a general item is created from it
  (`name = "Reklam bütçesi"`, `kind = ad_budget`, unit the lane's currency, `cap = L.cap_minor`,
  `period = L.period`, ledger `budget.items.create {reason: "knowledge_backfill"}`). Only *G* with
  `paid_enabled = false`: *G*'s cap is set to 0 (ads were off; ledger reason
  `knowledge_backfill_paid_off`). Neither: nothing (Kurallar reads `Reklam yok.`). Effect: the
  number the owner sees never allows more spend than the day before.
- **Approval switch**: `true` when the workspace has at least one postable social account other than
  TikTok and every such account has `requires_human_approval`; else `false` (the accounts' own flags
  keep working through the effective gate, §3.10.1).

Revisions: one `knowledge_revisions` row per seeded card and for rules and goals, `cause = backfill`
(or `seed` for blank seeds), `kb_revision = 1`; `knowledge_settings.revision = 1`,
`posting_derived = prospecting_derived = 1` when a frame exists (the cards were derived *from* it:
nothing to re-derive), else 0.

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
| Kurallar › reklam | `Reklama ayda en çok ₺5.000.` (paid lane 500000 TRY monthly, `paid_enabled`; lowered further if the general item is lower) | budget_frame, general item |
| Kurallar › onay | from the accounts (TikTok is gated by its screen whatever the switch says) | capabilities |
| Hedefler | `Marka / kulüp / kurum ortaklığı: 3 ayda 1-2 imzalı anlaşma` · `Toplu sipariş anlaşması: Ayda 2 anlaşma, her biri 30+ adet` · `Kişiye özel figür siparişi: Ayda 5-6'dan 12'ye (3. ayın sonunda)` · `Satış ortağı: 3 ayda 3 aktif satış ortağı` · `İçerik üreticisi iş birliği: 3 ayda 3 ücretsiz iş birliği (para ödenmez)` | 5 KPIs |

The frame of this workspace is then normalised once (§4.10.6): version 6 with `channels = [any]`,
the 7 hypotheses kept (same ids) with `channel = any`, the organic lane (cap 0) dropped, the paid lane
mirrored from the general item, `channel_mix` emptied; identity, audience, prospecting and the
hypotheses' texts unchanged. Its 7 standing research tasks are carried (same ICP entries, §4.10.7).

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

1. `lock_settings`, then the subject row; check the revision.
2. Write the row; append one `knowledge_revisions` row (`content` = the subject as it now is,
   `cause`, `by_*`, `kb_revision` = the new revision).
3. `knowledge_settings.revision += 1`, `changed_at = now`, `changed_by` = the person (the note's or
   proposal's person when an agent files or an owner accepts); `prospecting_revision = revision`
   when the change touches `who_we_seek`, `customers` or a card with no key.
4. Ledger `strategy.knowledge_changed {subject, card_id?, key?, revision, kb_revision, cause}`
   (no text; texts live in the revisions, as the consultation's did; `strategy_version_id` = the
   frame in force).
5. Wake (a person's own write: `wake::request`; an agent's filing: `request_for` on behalf of the
   note's person): `KNOWLEDGE` with `KnowledgeChanged`, plus `RESEARCH` when
   `prospecting_revision` moved.
6. When no frame exists and the knowledge base is no longer empty: the bootstrap (§4.10.5), in the
   same transaction.

### 4.5 When the knowledge base is empty

#### 4.5.1 The predicate

The knowledge base is **empty** when no live card has a body with a non-whitespace character, the
prohibitions are empty and the goals are empty. `knowledge_empty` (Paylaşımlar), the onboarding
step and the `knowledge_empty` work item read this one predicate.

### 4.6 Kurallar: `strategy.rules_save`

`PUT /api/knowledge/rules`, panel only, a person in person, `team.manage`; plus `budget.manage`
when the ad budget changes, plus the role owner or manager when `post_approval` goes from `true` to
`false` (an agent's key never lowers it; design 2026-11-19 O4's concern). Risk `Spend`.

```rust
#[derive(Deserialize)] #[serde(deny_unknown_fields)]
pub struct RulesInput {
    pub expected_revision: u64,                    // knowledge_settings.rules_revision
    pub prohibitions: Vec<String>,                 // trimmed, empty lines dropped, ≤ 100 × ≤ 500
    pub ad_budget: Option<AdBudgetInput>,          // None: no ads
    pub post_approval: bool,
}
pub struct AdBudgetInput { pub amount_minor: i64 /* ≥ 0 */, #[serde(default)] pub period: Option<BudgetPeriod> /* weekly | monthly */ }
```

#### 4.6.1 Yasaklar

Stored in `knowledge_settings.prohibitions`; a change is a knowledge change (§4.4 steps). Effect:
**at once**, every agent read carries them: `jeeta.strategy.knowledge_get.rules.prohibitions`,
`jeeta.strategy.get` (`approved.sections.prohibitions`, live, §5.4), `inbox.context.prohibitions`
(with the conversation's own), `studio.slot_get.brand_rules.prohibitions`, and the hints
(§5.2: "never cross the rules"). They are copied into the frame the next time one is applied
(§4.10.2). They are not checked by the server (D6); the box says so in its help line.

#### 4.6.2 Reklam bütçesi (K4, D2)

One number for the owner: **the general ad budget item** (`budget_items.general`, 0039).

- Save with an amount: the live general item gets `cap = amount_minor` and, when given, `period`
  (`budget.items.update` internals, system-stamped with the person as actor); with none, one is
  created (`name = "Reklam bütçesi"`, `kind = ad_budget`, unit `TRY` or the workspace's last ad
  currency, `period` given or `monthly`, `general = true`). `None` (no ads): the item's cap becomes 0
  (it is kept: Bütçe's history stays).
- Then, in the same transaction and when a frame exists, the system applies the **mirror**
  (§4.10.2, cause `rules`): `budget_frame.lanes` = one paid lane `{lane: paid, period: the item's
  (weekly, or monthly; a daily item maps to weekly × 7), cap_minor: the item's cap in that period,
  currency: the item's}` when the cap is above 0, none otherwise; `paid_enabled` = a lane exists.
  `ads::check_money`, `studio::ads`, the paid planner and `validate_reservation` read it as today, so
  the cap binds at once.
- `budget.rs` `check_general` no longer compares the item with the strategy's paid lane (the lane is
  now the item); every general item create or update from Bütçe runs the same mirror (one number,
  whichever page edits it).
- Lowering the cap: right after the commit `ads::watch::watch_all(deps, ws, now)` runs for the
  workspace (the pass the `studio_control` job makes, `ads/watch.rs:270-300`), so every running
  campaign stops at once when the period's ad spend already reached the new cap, instead of at the
  job's next pass; the answer carries `stopped_campaigns` (its count) and the panel says
  `{n} reklam kampanyası yeni sınıra ulaştığı için durdu.` Below the cap they run on, and the general
  budget stops them when the spend reaches it, as today.
- The organic lane is not the owner's (D3): mirrors write none, and `validate_reservation` treats a
  missing **organic** lane as no lane cap (the spend still meets the linked budget items' caps and the
  capability's own cap, which every metered capability has: `budget_item_ids` may not be empty).
  A missing **paid** lane stays `lane_budget_missing`, worded `Kurallar'da reklam bütçesi yok.`

#### 4.6.3 "Her paylaşım onayıma gelsin" (K4, D1)

Stored in `knowledge_settings.post_approval`; not a knowledge change (no derive, no revision of the
knowledge revision; a `rules` revision row is still written). Read by the effective post gate
(§3.10.1) everywhere a post's approval is decided, so:

- switching **on**: every post not yet sent on any social account waits for the owner (a ready post
  shows `Onayını bekliyor`; one whose time passes while waiting is freed to wait for a new time,
  F4); new accounts are covered at once (nothing is written per account).
- switching **off**: posts go out at their time unless their own account's flag says otherwise;
  TikTok always needs its screen.
- It does not touch comment replies or ad accounts, whose approval stays each capability's own flag.

The ledger entry `strategy.rules_changed {prohibitions: n, ad_budget: {amount_minor, period} | null,
post_approval}`; the `rules` revision row holds the whole box.

### 4.7 Hedefler: `strategy.goals_save`

`PUT /api/knowledge/goals {expected_revision, items: [String]}` (≤ 20 × ≤ 300, trimmed), panel
only, `team.manage`, a person. A knowledge change (§4.4 steps). Read at once by
`jeeta.strategy.knowledge_get.goals`, `jeeta.strategy.get` (`approved.sections.goals.kpis` as
`[{name: line, target: ""}]`, live) and `studio.overview` (`goals`); copied into the frame at the
next apply.

### 4.8 "Ajanlara bir şey anlat": notes

| Use case | Surface | Who | Input → effect |
|---|---|---|---|
| `strategy.note_add` | panel `POST /api/knowledge/notes` | person, `team.manage` | `{request_key, text, links?, file_ids?}` → note `open`; wake `KNOWLEDGE` and `RESEARCH` with `KnowledgeNote`; ledger `strategy.note_added {note_id, links, files}` |
| `strategy.note_withdraw` | panel `POST /api/knowledge/notes/{note_id}/withdraw` | the person who added it, or owner/manager | `{expected_revision}` → `withdrawn` (a claim held on it ends) |
| `strategy.note_claim` | MCP `jeeta.strategy.note_claim` | an agent with a work permission (§5.1) | `{note_id, expected_revision}` → `{claim_token, until, note}`; lease 30 minutes; a live claim of another connection: `CONFLICT note_claimed {until}` |
| `strategy.note_file` | MCP `jeeta.strategy.note_file` | the claimant | `{note_id, claim_token, request_key, cards: [{card_id, expected_revision, title?, body} \| {new: {title, body}}] (1..=3), attachments?: [{card index, file_id \| url}], summary}` → cards written (`cause = note`, `source_id`), note `filed` with `outcome`; or `{note_id, claim_token, dismiss: {reason}}` → `dismissed` |
| `strategy.note_release` | MCP `jeeta.strategy.note_release` | the claimant | `{note_id, claim_token}` → open again |

Rules of `note_file`: `summary` 1–300 characters, Turkish, shown to the owner under the note; a
filing that makes a card's body shorter than half of what it was is `CONFLICT filing_removes_text`
(an agent adds, it does not wipe); a stale card revision is `CONFLICT card_changed` (re-read and file
again); a withdrawn note is `CONFLICT note_withdrawn`; the note's files may become card attachments
(they stay knowledge, never library materials: D29). Filing never touches the rules or the goals:
those go through a proposal (§4.9).

### 4.9 Proposals ("Ajanın önerileri")

| Use case | Surface | Who | Input → effect |
|---|---|---|---|
| `strategy.proposal_create` | MCP `jeeta.strategy.proposal_create` | an agent with a work permission | `{request_key, kind, card_id?, title?, body, reason}` → `pending`, `expires_at = now + 14 days` |
| `strategy.proposal_accept` | panel `POST /api/knowledge/proposals/{id}/accept` | person, `team.manage` | applies it (below) → `accepted`, `applied_revision` |
| `strategy.proposal_skip` | panel `POST /api/knowledge/proposals/{id}/skip` | person, `team.manage` | → `skipped` |

- `card_new`: `title` and `body` required → a new card (`cause = proposal`). `card_edit`: `card_id`,
  `body` (the card's whole new text) and optionally `title`; `base_revision` = the card's revision
  at proposal time. `rule_add`: `body` ≤ 500, appended to the prohibitions. `goal_add`: `body` ≤ 300,
  appended to the goals.
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

| Frame field | Source | Filled by |
|---|---|---|
| `identity` {product, voice, positioning, usp} | derived from the cards | the content agent (`frame_apply.identity`); bootstrap: from cards (§4.10.5) |
| `audience` | derived (segments with stable keys) | the content agent; bootstrap: one segment `genel` |
| `goals.objective` | derived | the content agent (`frame_apply.objective`), else kept |
| `goals.kpis` | Hedefler, `{name: line, target: ""}` | system, at every apply |
| `prohibitions` | Kurallar | system, at every apply |
| `channels` | `[{channel: "any", rationale: "", group_id: null}]` | system, always (K6) |
| `budget_frame`, `paid_enabled` | the general ad budget item | system, at every apply (§4.6.2) |
| `cadence` | `{per_week: previous or 3, channel_mix: []}` | system |
| `prospecting` {icp, rubric} | derived from `who_we_seek` (and `customers`) | the research agent (`frame_apply.prospecting`) |
| hypotheses ("topics") | derived from `post_ideas`, `customers`, … | the content agent; organic cadence defaulted; paid cadence by an `ads.work` agent; the owner's request carried |

#### 4.10.2 One apply function

`knowledge::frame::apply(deps, ctx, repos, next: FrameParts, cause: FrameCause) -> Applied`, inside
the caller's transaction; `cause` ∈ `derive` (an agent's `frame_apply`), `bootstrap`, `rules`,
`normalize`. Steps:

1. `strategy().lock_draft()`; an open draft (only ever an old one) is archived with the log entry
   `closed: the knowledge base replaces drafts`. Then `lock_execution_frame()` → `previous`.
2. **Merge**: every part `next` leaves out is `previous`'s; the system fields of §4.10.1 are always
   recomputed from the knowledge base and the general item.
3. **Topics**: for each topic given, its id when given (it must be a hypothesis of some version of
   this workspace: `VALIDATION topic_unknown`; the owner's request id: `FORBIDDEN hypothesis_reserved`),
   else the id of a live topic of `previous` whose title is the same once case and whitespace are
   normalised, else a new id. `channel = "any"`. A live topic with no organic cadence gets
   `default_organic_cadence(max(per_week, 1))` (`strategy.rs`, moved to `jt_knowledge`); a given
   organic cadence is validated as `HypothesisCadence` is; a paid cadence is kept from `previous`
   unless the caller holds `ads.work` and gives one. `prior_confidence` defaults to 0.5.
   **States**: in `previous` and given → `kept`; new → `added`; live in `previous`, not given →
   `retired`, **except** while it still has a planned or ready slot: then it stays `kept` and the
   answer lists it in `kept_for_posts` (D9; the next apply after its posts are gone retires it). The
   owner's request is `kept` when `previous` holds it (F2 carry-over).
4. **Validate** (the approval gaps that still mean something; `rules::validate_for_approval` minus
   every channel rule): `identity.product` not empty; at least one segment, keys
   `[a-z0-9_]{2,32}` unique; at least one live topic but the owner's request; each live topic has a
   title, an angle, a metric and a known segment; prospecting, when not empty, as
   `rules::prospecting_gaps` (ICP shape, rubric weights sum 100, segment keys known); at most 30 live
   topics (`too_many_topics`). Any gap: `VALIDATION` with `details.gaps`, nothing written.
5. **Diff**: `previous`'s sections and live topics (by id: title, segment, angle, metric, prior,
   cadence, channel) against the merged ones, canonical JSON. Equal → `Applied { applied: false }`;
   only the acknowledgements of step 10 are written.
6. Insert the new version (`number = next_number`, status `draft`, `created_by_*` from `ctx`), write
   its hypotheses (`replace_all` on the new version), archive `previous` (log
   `superseded by version {n}`), approve the new one (`approved_by = acting_user(ctx.actor)`: the
   key's issuer for an agent, the person for `rules`, none for the system), log
   `frame {n} applied ({cause})`.
7. Ledger `strategy.frame_applied {number, cause, parts, kept, added, retired, kept_for_posts,
   kb_revision}` with `strategy_version_id` = the new version.
8. `deps.transition_hook.apply(StrategyChange {previous, current, kept, retired, added})`: slots of
   retired topics are retired and their versions freed to wait again (F4), then attributed under the
   new frame (F1).
9. `research::plan_in(new)` with the carry rule (§4.10.7).
10. Acknowledge: `posting_derived` / `prospecting_derived` = the `kb_revision` the caller derived
    from (only for the parts it gave); `frame_applied_at = now`.
11. Wakes (§4.10.8).

`approve()`'s side effects (transition hook, research planner, wake, owner's-request carry) live here
now; `strategy.approve` is removed in PR 6 (§7.4).

#### 4.10.3 `jeeta.strategy.frame_apply` (MCP only)

```rust
#[derive(Deserialize)] #[serde(deny_unknown_fields)]
pub struct FrameApplyInput {
    pub request_key: String,
    /// The knowledge revision the derivation read (`knowledge_get.revision`).
    pub kb_revision: u64,
    #[serde(default)] pub identity: Option<Identity>,          // content.work
    #[serde(default)] pub audience: Option<Vec<Segment>>,      // content.work
    #[serde(default)] pub objective: Option<String>,           // content.work, ≤ 2000
    #[serde(default)] pub topics: Option<Vec<TopicInput>>,     // content.work (paid cadence: ads.work)
    #[serde(default)] pub prospecting: Option<Prospecting>,    // prospects.work
}
pub struct TopicInput {
    #[serde(default)] pub id: Option<HypothesisId>,
    pub title: String, pub segment_key: String, pub angle: String, pub metric: String,
    #[serde(default)] pub prior_confidence: Option<f32>,
    #[serde(default)] pub cadence: Option<BTreeMap<LaneKind, HypothesisCadence>>,
}
pub struct FrameApplyOut {
    pub applied: bool, pub number: i32,
    pub kept: u32, pub added: u32, pub retired: u32,
    pub kept_for_posts: Vec<HypothesisId>,
    pub topics: Vec<Topic>,                 // {id, title, segment_key} of the frame in force
}
```

Parsed strictly (`jt_strategy::parse_section_strict` for identity, audience and prospecting; the
hypothesis parser for topics, without `channel` and `state`). Refusals: `FORBIDDEN agent_only` (a
person's session), `FORBIDDEN part_permission {part, permission}`, `VALIDATION` (gaps), `CONFLICT
kb_revision_ahead` (a revision the knowledge base has not reached), replay by `request_key`.
A derivation from an older revision than the current one is accepted (it applies what it has) and
acknowledges only that revision, so the work item comes back for the newer one.

#### 4.10.4 Who derives

- Posting part (identity, audience, objective, topics): an agent key holding `content.work`, woken by
  `KnowledgeChanged` (need `KNOWLEDGE`), listed the `knowledge_derive {kb_revision, part: posting}`
  item while `revision > posting_derived`.
- Prospecting part: an agent key holding `prospects.work`, need `RESEARCH`, item
  `knowledge_derive {part: prospecting}` while `prospecting_revision > prospecting_derived`.
- Paid cadence: optional, an agent holding `ads.work` with its posting derivation, or alone
  (`topics` with only cadences changed).

#### 4.10.5 A brand-new workspace: bootstrap

When no approved frame exists and the knowledge base stops being empty (§4.5.1), in the transaction of
the write that made it so — and from the `knowledge_settle` job for a workspace seeded from a draft —
the system applies a **bootstrap** frame (cause `bootstrap`, `approved_by` = the person who wrote):

- `identity.product` = the first non-empty body among `products_prices`, `who_we_are`, then any card
  by position (2000 characters); `voice` = `voice`'s body; `positioning` = `who_we_are`'s; `usp` = "";
- `audience` = `[{key: "genel", name: "Genel", description: customers' body (2000)}]`;
- one topic, id `stable_id(ws, "strategy.hypothesis:knowledge_base")`, `title: "Genel"`,
  `segment_key: "genel"`, `angle` = `post_ideas`' body (500) or `İşletmeyi tanıtan paylaşımlar`,
  `metric: "Etkileşim"`, organic cadence `default_organic_cadence(3)`;
- prospecting empty (research waits for its agent's derivation);
- the system fields of §4.10.1.

The gate opens with it: the owner's first composer request is not stopped by "Bilgi bankası boş"
once one card has text. Agents then derive the real frame; the bootstrap topic is retired by the
first derivation that leaves it out (with the D9 rule for its posts).

#### 4.10.6 `knowledge_settle`: normalisation and housekeeping

A new job (`jobs.rs`, every 10 minutes, every workspace that is `active` or `pending_payment`, like
`research_plan`): per workspace, in its own bundle, in this order:

1. seed when not seeded (§4.3);
2. bootstrap when no frame and not empty (§4.10.5);
3. **normalise**: when the frame's *execution mirrors* differ from what §4.10.1 says — `channels` is
   not `[any]`, a live topic's channel is not `any`, a live topic lacks an organic cadence,
   `channel_mix` is not empty, `budget_frame`/`paid_enabled` differ from the general item — apply
   with cause `normalize` (prohibitions and goals are copied too, but a difference in them alone is
   never a reason: they are read live);
4. expire proposals; nothing else (a note's lapsed claim needs no write: `claimable` reads the time).

Step 3 is how every existing frame becomes K6-shaped once, after PR 2a's deploy, with no owner action:
the first tick applies one version per workspace whose frame is not normalised, with every
hypothesis kept.

#### 4.10.7 Research tasks survive (K5)

`research::plan_in(version)` changes its first loop: an open standing task of another version whose
`icp_key` names an entry of `version` with the **same standing brief** (`standing_brief(entry) ==
task.brief`, normalised; the "brief digest" of K5) is **carried**: `ResearchTasks::carry(task.id,
version.id, rubric_digest(version), entry.daily_cap)` re-stamps its version (the FK target is the new
version, which exists), keeps its id, claim and today's count; ledger `research.task_carried
{task_id, from_version, to_version}`. Only a task whose entry is gone or whose brief changed is
superseded, as today. The one-open-standing-task index (version, icp_key) still holds: the new
version has no other task for that key. `remaining()` keeps reading the entry when the task's version
is the approved one, which a carried task's is. The standing-task close refusal's message becomes
`the ICP comes from the knowledge base (card who_we_seek); change the card instead`.

#### 4.10.8 Wakes of an apply

Only for the parts that changed: topics or identity/audience → `SOCIAL`; paid lane or paid cadence →
`ADS`; prospecting → `RESEARCH`; reason `KnowledgeApplied` ("The knowledge base changed what the
agents work from."). A `rules` apply is a person's action (`wake::request`); a `derive` apply wakes
on behalf of `knowledge_settings.changed_by` (`request_for`), never the deriving agent itself;
`bootstrap` wakes `CONTENT` and `SOCIAL` on behalf of the person who wrote (areas that waited for a
frame are now offered, §5.2); `normalize` wakes nobody.

#### 4.10.9 Debounce and skip

- The `knowledge_derive` item is listed only once the knowledge base has been quiet for 30 seconds
  (`changed_at ≤ now − 30 s`), shorter than `WAKE_SETTLE` (45 s), so the woken agent sees it, while
  a burst of edits makes one derivation.
- The wake's own limits (`WAKE_MIN_GAP` 3 minutes, 20 an hour) bound derivations per agent.
- A derivation that changes nothing makes no version (§4.10.2 step 5).
- No stored "pending frame": an agent's answer is applied or refused in its own call.

#### 4.10.10 Learning stays continuous

Ids are kept by the caller (from `knowledge_get.frame.topics`) and, when it forgets, by the title
match of step 3; arms are keyed by hypothesis, content type, concrete channel and lane, independent
of the version, and learning applications by hypothesis across versions (A6 facts): a new version
with kept ids loses nothing.

#### 4.10.11 An empty knowledge base

- No frame and empty: the gate stays closed (`STRATEGY_REQUIRED`, code unchanged). Its message
  becomes `the knowledge base is empty: the owner fills it in Bilgi bankası first`; the panel's words
  everywhere (`QueryState`, `StudioError`, `lib/errors.ts`, the inbox's send refusal):
  `Ajanlar seni henüz tanımıyor. Önce Bilgi bankasına birkaç satır yaz.` with `Bilgi bankasına git`.
- A person holding `team.manage` gets the work item `knowledge_empty` (priority 1).
- `work.pending` lists no `content_area` item while no frame exists (the agent could not deliver).
- A frame and an empty knowledge base (the owner deleted every card): the frame stays (frames are
  never withdrawn: no archive, D10); agents read the empty cards and the frame's derived parts; the
  page shows its empty state.

#### 4.10.12 Onboarding

Step 2 becomes **Bilgi bankası** (`onboarding.knowledge`): done when `pending.knowledge.empty` is
false; text pending `Ajanların seni tanıması için Bilgi bankasına birkaç satır yaz.`, done
`Bilgi bankası dolu; ajanlar bunu kullanıyor.`; link `Bilgi bankasını aç` → `/knowledge`; next-step
logic `!knowledgeReady ? 2 : …`; `setupNextStrategy` becomes `setupNextKnowledge`
`Bilgi bankasını doldur`. It can be done before payment (`strategy.*` runs while `pending_payment`).
The server test `m4_onboarding_http` asserts `pending.knowledge.empty == true` for a new workspace and
`false` after one card write.

### 4.11 The page `/knowledge`

As mockup H, one column (max 980 px), no tabs.

1. Header `Bilgi bankası`; subtitle
   `Ajanların işletmen hakkında bildiği her şey. Ne yazarsan her işte onu kullanırlar.`
2. Composer: label `Ajanlara bir şey anlat`, placeholder `Örn. Yılbaşı siparişleri 15 Aralık'ta kapanıyor`,
   button `Dosya ya da bağlantı` (a small menu: `Dosya ekle` / `Bağlantı ekle`; files hidden without the
   library module, with the line `Dosya eklemek için bir içerik, sosyal medya ya da reklam modülü gerekir.`),
   primary `Ekle`. After `Ekle`: `Ajana iletildi. Uygun karta eklediğinde burada görürsün.` Under it,
   the last five notes: `{metin, kısaltılmış}` with `Bekliyor` (+ `Geri al`), `{kart} kartına eklendi: {özet}`,
   `Eklenmedi: {neden}`, `Geri alındı`.
3. Two boxes side by side (stacked on a phone):
   - **Kurallar** (`id="kurallar"`), aside `ajanlar asla aşmaz`, button `Düzenle`. Shows the first two
     prohibitions, then the ad line (`Reklama ayda en çok ₺5.000.` / `Reklama haftada en çok …` /
     `Reklam yok.`), then the approval line (`Her paylaşım yayından önce onayına gelir.` /
     `Paylaşımlar onay beklemeden zamanında çıkar (TikTok'u sen tamamlarsın).`), then
     `{n} kural daha` (expands). Empty prohibitions: `Henüz yasak yok.`
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
  `Ajan önerisi`, `İlk kurulum`), its text, `Bu hâline dön`.
- Kurallar `Düzenle` dialog: the prohibitions as a list (`Yasak ekle`, a remove × per line), the ad
  field `Reklama ayda en çok [ ₺ ]` with the switch `Reklam yok`, the switch
  `Her paylaşım yayından önce onayıma gelsin`, the help line
  `Bütçeyi ve onayı sistem uygular; yasakları ajanlar her işte okur ve uyar.`, buttons `Kaydet`,
  `Vazgeç`. Without `budget.manage` the ad field is read-only with `Bütçe yetkin yok.`
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
`Yeniden dene`); empty (all blank: a callout `Ajanların seni tanıması için birkaç kart yeter. “Biz kimiz” ile başla.` and the `Biz kimiz` editor opened);
read-only member (no `team.manage`): no composer, no `Düzenle`, no `+ Yeni kart`, proposals without
buttons, the line `Bilgi bankasını yalnızca yöneticiler değiştirir.`; phone: single column, the
boxes stacked, editors as full-screen sheets.

Addresses: `/knowledge` with `card={id}` (editor open), `history={card id}`, hashes `#kurallar`,
`#hedefler`, `#oneriler`. `/strategy` and every `/strategy?…` redirect to `/knowledge`. Menu: core
item `Bilgi bankası`. Queries: `['knowledge']` (one read, `GET /api/knowledge`), invalidated by every
knowledge write and by capability changes (the approval line names accounts).

### 4.12 Other readers moved to the knowledge base

| Reader | Today | After |
|---|---|---|
| `inbox.context` | `strategy_guidance {summary: identity, segments, hypotheses}` + the frame's prohibitions, only with an approved version | keeps `strategy_guidance` from the frame (hypotheses without the owner's request, A5 risk) and adds `knowledge {cards: [{key, title, body (≤ 2000, truncated flag)}], rules: [..], goals: [..], revision}`; prohibitions = the conversation's + the knowledge base's (live); answered without a frame too |
| `studio.slot_get` `brand_rules` | `{identity, prohibitions}` from the frame | `{identity: frame, prohibitions: knowledge base (live), voice: voice card body, knowledge_revision}` |
| `studio.overview` | `goals` from the frame | `goals.kpis` from Hedefler (live), `objective` from the frame |
| `ads::check_money`, `studio::ads`, paid planner, `validate_reservation` | paid lane of the frame | the same, now mirrored from the general item (§4.6.2); organic lane missing = no lane cap |
| `budget::check_general` | item ≤ strategy paid cap | the comparison removed; a general item write runs the mirror |
| `prospects.playbook` | approved ICP and rubric; text says "propose through the consultation" | same data (frame); text §5.5; `PLAYBOOK_VERSION = 2` and the leads spec's Appendix A in step |
| `research` panel (`data.ts`, `segments.ts`, `TaskRow`, `copy.ts`) | audience names from `/api/strategy`, link "Stratejide değiştir" | audience from `GET /api/strategy` (compat, §5.4); `Bilgi bankasında değiştir` → `/knowledge?card={who_we_seek id}`; `fromStrategy` → `Bilgi bankasından` |
| `ModuleStatusLine` | rows `strategy`, `no-posting`, `paid` | `knowledge` (`Bilgi bankası boş: ajanlar paylaşım hazırlayamaz.` → `/knowledge`), `no-posting` removed, `paid` (`Kurallar'da reklam bütçesi yok.` → `/knowledge#kurallar`) |
| `QueryState`, `StudioShared`, `lib/errors.ts` | `STRATEGY_REQUIRED` → `/strategy` | → `/knowledge`, words of §4.10.11; `no_paid_lane` / `above_strategy_cap` → `Kurallar'daki reklam bütçesini aşıyor.` |
| home `WorkFeed`, `copy.ts` | approvals include consult/approve strategy; ledger copy of `strategy.*` | approvals include `knowledge_proposal`, `knowledge_empty`; ledger copy for `strategy.knowledge_changed` (`Bilgi bankası güncellendi`), `strategy.frame_applied` (`Ajanlar bilgi bankasını uyguladı`), `strategy.rules_changed` (`Kurallar güncellendi`), old `strategy.*` copy kept for old entries |
| `modules.rs` strategy module | name `Strateji`, workflow `Hedefi tanımla / Stratejiyi onayla / Sonuçları değerlendir` | name `Bilgi bankası`, description `Ajanların işletmen hakkında bildiği her şey.`, workflow `Bilgiyi yaz`, `Ajanlar okur ve uygular`, `Önerileri değerlendir`; id `strategy` kept |
| content workflow steps 1–3 (`modules.rs`) | `onaylı stratejiden`, `stratejideki kitlelerden`, `bağlı hesaplara ve stratejiye göre` | `bilgi bankasından`, `bilgi bankasındaki müşterilerden`, `alan açılırken seçildiyse ona uy; seçilmediyse bağlı hesapların hepsi arasından, kişinin isteğine göre seç (“sadece TikTok” gibi)` |
| `groups.rs` delete guard | refused while a strategy channel narrows to the group | removed (frames name no group) |
| `agents/keys.tsx`, `production-worker/README.md` | "every key preset reads the strategy" | "reads the knowledge base (`workspace.read`)" |

## 5. The agent contract

### 5.1 Tools

`WORK` below is any of `content.work`, `social.work`, `ads.work`, `materials.work`,
`prospects.work`, `outreach.work`, `inbox.work` (a new constant `knowledge::WORK_PERMISSIONS`).
Descriptions are ASCII and end with the risk tag (registry rule); card keys are written as keys.

**Added** (PR 2b):

| Tool | Use case | Permission | Gist of the description |
|---|---|---|---|
| `jeeta.strategy.knowledge_get` | `strategy.knowledge_get` (twin of `GET /api/knowledge`) | `workspace.read` | "Read the knowledge base the owner keeps for agents: every card (key, title, body, attachments with short-lived links), the rules no agent may cross (prohibitions, the ad budget, whether every post waits for the owner's approval), the goals, the notes waiting to be filed, the pending proposals, and the frame (its number, the knowledge revision each part was derived from, which derivations are due, and its identity, audience, topics and prospecting). Topic ids are what tools that ask for a hypothesis_id take. The owner's edits apply at once: read this at the start of every run. [risk: READ]" |
| `jeeta.strategy.frame_apply` | `strategy.frame_apply` (MCP only) | parts: `content.work` (identity, audience, objective, topics), `prospects.work` (prospecting), `ads.work` (paid cadence) | "Apply what you derived from the knowledge base. Send kb_revision as read. A part left out stays as it is. Topics: send every topic that should stay, with its id when it has one (ids keep what was learned); one left out is retired once it has no planned post, and its planned posts wait for a new topic by themselves. Channels are not yours: every connected account is used. Prohibitions, goals and the ad budget come from the owner's rules and goals. Nothing changed: applied false. [risk: WRITE]" |
| `jeeta.strategy.note_claim` | `strategy.note_claim` (MCP only) | `WORK` | "Claim a note the owner wrote to the agents at expected_revision; the answer carries a claim_token and the note (text, links, files with short-lived links). The claim lasts 30 minutes. [risk: WRITE]" |
| `jeeta.strategy.note_file` | `strategy.note_file` (MCP only) | `WORK` | "File the claimed note: rewrite the body of the card it belongs to (at most three cards, or a new card when none fits), keeping what the owner wrote, and say in summary, in Turkish, one line the owner reads. A note that is no knowledge is dismissed with a reason. Rules and goals are never filed: propose them. [risk: WRITE]" |
| `jeeta.strategy.note_release` | `strategy.note_release` (MCP only) | `WORK` | "Give a claimed note back unfiled. [risk: WRITE]" |
| `jeeta.strategy.proposal_create` | `strategy.proposal_create` (MCP only) | `WORK` | "Propose to the owner a change you learned while working: a new card, a new text for a card (send its whole new body), a rule or a goal, with a one-line reason in Turkish. Nothing changes until the owner adds it; it closes by itself after 14 days. At most 20 pending, 10 a day from one connection. [risk: WRITE]" |

**Changed** (the social, inbox and studio read changes in PR 2a; the rest in PR 2b):

| Tool | Change |
|---|---|
| `jeeta.strategy.get` | the compatibility projection of §5.4; description rewritten |
| `jeeta.work.pending` | `knowledge` state, new kinds, `strategy` reduced (§5.2); description rewritten |
| `jeeta.content.area_deliver` | `hypothesis_id` optional ("a topic id of jeeta.strategy.knowledge_get frame.topics; left out: the frame's first live topic"); a delivered person-requested content wakes the social agent |
| `jeeta.social.versions_waiting`, `version_schedule`, `accounts_list`, `account_get` | `knowledge_empty` replaces `no_approved_strategy`; `channel_not_in_strategy`, `no_hypothesis`, `prepare_strategy`, `approve_strategy` gone; `human_gate` and `requires_human_approval` from the effective post gate; texts say "topic" for the attribution |
| `jeeta.inbox.context` | adds `knowledge`; prohibitions from the knowledge base; answers without a frame; "Read recent conversation context and the knowledge base" |
| `jeeta.studio.slot_get` | `brand_rules` per §4.12 |
| `jeeta.studio.overview` | goals from Hedefler |
| `jeeta.studio.material_analysis_complete` | "read jeeta.strategy.knowledge_get (products_prices, who_we_are) to reuse groups and labels; mark every face, name, child, client logo and corporate reference in depicts and every named person in people: a file the owner attached to a post becomes shareable only when you find none" |
| `jeeta.studio.posts_propose`, `trend_record`, `judgment_record`, `jeeta.ads.plan_submit`, `campaign_move`, `jeeta.studio.adset_bind`, `project_schedule` | "hypothesis_id: a topic id of jeeta.strategy.knowledge_get frame.topics" in place of "of the approved strategy" |
| `jeeta.prospects.playbook`, `score`, … ; `jeeta.research.tasks_*` | "the ICP and rubric of the frame, derived from the card who_we_seek"; `prospecting_off`: "the knowledge base has no ICP yet: derive it (knowledge_derive, part prospecting)"; changes "through jeeta.strategy.frame_apply (prospecting) when the card says so, else jeeta.strategy.proposal_create" |
| `jeeta.budget.items_create`, `items_update` | "the general ad budget is the owner's ad budget of the rules (Kurallar): it is the paid cap" (no strategy cap any more) |
| `jeeta.outreach.campaigns_save`, `jeeta.calls.*`, `jeeta.workspace.info`, `jeeta.studio.ledger`, `jeeta.content.olay_view`, `jeeta.modules.remove` | "approved strategy" → "a frame (the knowledge base has a card)"; "strategy gate" → "knowledge gate"; `modules.remove`: "Inbox and the knowledge base cannot be removed"; `studio.ledger` drops "also after strategy archive" |

**Kept for compatibility, then removed in PR 6** (after the routines moved, §5.6):
`jeeta.strategy.start_consultation`, `record`, `write_section`, `set_hypotheses`, `submit`,
`approve`, `archive`, `list_versions`, `consultation`, and `jeeta.studio.hypothesis_propose`. Until
then they keep their behaviour on the internal frame (a version an old routine approves is
normalised by the next `knowledge_settle` tick, §4.10.6, and never touches the cards); their
descriptions gain the first sentence
`Retired soon: the strategy is the knowledge base now; read jeeta.strategy.knowledge_get and apply with jeeta.strategy.frame_apply.`
The panel-only `strategy.add_channel` is removed in PR 2a (nothing calls it once the Stops action is
gone, K6).

Counts at the end (PR 6): catalog 303 − 11 + 22 = **314** rows; MCP tools 244 − 10 + 6 = **240**
(registry, `m4_productisation` `POST_M4_ADDED` / `POST_M4_REMOVED` / `POST_M4_PANEL_ONLY`, the
`m3_surface.json` fixture, `twin_rule` strategy twins 10 → 2). Each PR updates the pins it moves
(§8.4).

### 5.2 `work.pending`

```rust
pub struct PendingOut {
    pub knowledge: KnowledgeState,
    /// Deprecated, removed in PR 6: `"missing"` without a frame, `{"approved": {"number": n}}` with one.
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

| Kind | Fields | Listed to | Priority | `cleared_by` | Hint (English, for the agent) |
|---|---|---|---|---|---|
| `knowledge_derive` | `kb_revision`, `part` | agent with `content.work` (posting) / `prospects.work` (prospecting), while due and quiet 30 s (§4.10.9); also posting when a version is blocked `hypothesis_does_not_post` | 2 | `strategy.frame_apply` | posting: "The owner changed the knowledge base. Read jeeta.strategy.knowledge_get and derive what agents work from: identity (product, voice, positioning, usp: one paragraph each, from the cards who_we_are, products_prices and voice), audience (segments; keep the keys of frame.audience for those that stay), objective, and topics (what posts are about, from post_ideas, customers and what you learned; keep each id of frame.topics for a topic that stays; at most 30). Apply with jeeta.strategy.frame_apply and the kb_revision you read. Channels are not yours: every connected account is used. Prohibitions, goals and the ad budget are the owner's rules and goals: never derive them. Send it even when nothing changed: it answers applied false and clears this item." prospecting: "The owner changed whom the business looks for. Read jeeta.strategy.knowledge_get (cards who_we_seek and customers; frame.prospecting is the ICP and rubric in force) and jeeta.prospects.playbook, and derive the ICP entries (keep each key of frame.prospecting.icp for an entry that stays: its standing research task carries over) and the rubric. Apply with jeeta.strategy.frame_apply (prospecting, kb_revision). Change the rubric only when the card asks for it: scores of the old rubric become stale (rubric_mismatch)." |
| `knowledge_note` | `note_id`, `expected_revision` | agent with any `WORK` permission | 2 | `strategy.note_claim` | "The owner told the agents something. Claim the note with jeeta.strategy.note_claim, read its text, links and files, and file it with jeeta.strategy.note_file into the card it belongs to: send that card's whole new body, keeping everything the owner wrote, or a new card when none fits; summary is one line in Turkish the owner reads. A note that is no knowledge (a request for a post, a question) is dismissed with a reason in Turkish: a post is asked for on the Paylasimlar page. Never put a note into the rules or the goals: propose those with jeeta.strategy.proposal_create. After filing, check in again: the derivation follows." |
| `knowledge_proposal` | `proposal_id` | person with `team.manage` | 3 | `strategy.proposal_accept` | "An agent proposed a change to the knowledge base; the owner adds or skips it in Bilgi bankasi." |
| `knowledge_empty` | — | person with `team.manage` | 1 | `strategy.card_update` | "The knowledge base is empty: nothing is planned, delivered or sent until the owner writes at least one card in Bilgi bankasi." |

Hints rewritten:

- `CONTENT_AREA_HINT` (replaces the constant in `work.rs`):
  "Carry this production area to a content package; nobody approves it in between. (1) Read
  jeeta.strategy.knowledge_get (cards, rules, goals) and jeeta.studio.project_get: `brief` is the
  goal in the owner's words when a person asked for it; `hints` holds a platform or format a person
  chose (empty: you choose, among every connected account; when the brief names a platform, such as
  'sadece TikTok', make versions only for it and set their capability_id); `redo_note` on this item,
  when present, says what the person wants changed. Never cross the rules: the prohibitions are the
  owner's and bind every word you write. (2) Take the area with jeeta.content.area_claim …" — steps
  (2) to (4) unchanged — "(5) Deliver every platform version in one call to
  jeeta.content.area_deliver; hypothesis_id is optional: name the topic of frame.topics the version
  is about, or leave it out; never name the owner's request. With no connected account leave
  capability_id out. A refusal lists, by version index, what to fix: fix it and deliver again with a
  new request_key. Three refusals in a row hand the area to a person. An accepted delivery finishes
  the area; when a person asked for it, the social agent is woken for its time."
- material analysis (`work.rs:563`): `Read jeeta.strategy.get and …` → `Read jeeta.strategy.knowledge_get (products_prices, who_we_are) and …`, and the depicts sentence of §5.1.
- `ADS_PLAN_HINT`: `Read the strategy (jeeta.strategy.get) for the paid hypotheses and …` →
  `Read jeeta.strategy.knowledge_get: the ad budget of its rules is the hard limit every campaign is held against, and frame.topics are the ids each ad names as hypothesis_id; read …`.
- `SOCIAL_SCHEDULE_HINT`: last sentence → `The post goes out under the topic its choice names (attribution); you choose none. A content a person asked for without naming an account may go out on any account it lists.`
- `jeeta.work.pending` description: the `knowledge` state, the four new kinds, `strategy`
  deprecated; "prospects to score under the frame's rubric".

### 5.3 Wakes

`ports/wake.rs` `WakeReason` gains (serde names, fixed ASCII sentences):

| Reason | Sentence |
|---|---|
| `knowledge_changed` | `A person changed the knowledge base.` |
| `knowledge_note` | `A person told the agents something to file in the knowledge base.` |
| `knowledge_applied` | `The knowledge base changed what the agents work from.` |
| `content_delivered` | `A content a person asked for is ready for its time.` |

`StrategyApproved` stays deserialisable (pending wakes may hold it) and is produced only by
`strategy.approve` until PR 6, never after. `wake.rs` `Need` gains
`KNOWLEDGE {key: "knowledge", permission: ContentWork, module: None}`; `NEEDS` becomes 7 entries
(the panel's agents page and `AgentWakeLine` get the label `Bilgi bankası`).

| Site | Reason | Needs | Requested |
|---|---|---|---|
| card create/update/archive, `rules_save` (prohibitions changed), `goals_save`, `proposal_accept` | `knowledge_changed` | `KNOWLEDGE`, + `RESEARCH` when `prospecting_revision` moved | in person (`request`) |
| `note_file` (agent) | `knowledge_changed` | `RESEARCH` when `prospecting_revision` moved (the filer itself checks in again) | on behalf of the note's person (`request_for`) |
| `note_add` | `knowledge_note` | `KNOWLEDGE`, `RESEARCH` | in person |
| frame apply `rules` (ad budget) | `knowledge_applied` | `ADS` | in person |
| frame apply `derive` | `knowledge_applied` | per changed part: `SOCIAL`, `ADS`, `RESEARCH` | on behalf of `changed_by` |
| frame apply `bootstrap` | `knowledge_applied` | `CONTENT`, `SOCIAL` | in person (the writer) |
| `content.post_request` | `content_requested` (no files) / `material_uploaded` (files) | `CONTENT` / `MATERIALS` | in person |
| composer files ready (analysis by an agent / `material_permission` or `project_materials` by a person) | `content_requested` | `CONTENT` | on behalf of `requested_by` / in person |
| `content.files_add` | `material_uploaded` | `MATERIALS` | in person |
| a special day's file shared by rule, preparation started | `content_requested` | `CONTENT` | on behalf of the uploader |
| `content.area_deliver` accepted, `requested_by` set | `content_delivered` | `SOCIAL` | on behalf of `requested_by` |
| `strategy.approve` | `strategy_approved` | `SOCIAL`, `ADS`, `RESEARCH` | until PR 6 |

### 5.4 `jeeta.strategy.get`: the compatibility projection (K7)

`StrategyOut { approved, draft: null, gaps: [], knowledge }` — `knowledge` is new (the
`KnowledgeOut` of `knowledge_get`). `approved` is null until a frame exists; else the frame's
`VersionOut` with these fields replaced, so a routine reading the old paths gets the owner's live
words:

| Path | Value |
|---|---|
| `approved.sections.identity.product` | `products_prices` body (2000 characters), else the frame's |
| `approved.sections.identity.voice` | `voice` body, else the frame's |
| `approved.sections.identity.positioning` | `who_we_are` body, else the frame's |
| `approved.sections.identity.usp` | the frame's |
| `approved.sections.prohibitions` | the knowledge base's prohibitions (live) |
| `approved.sections.goals` | `{objective: frame's, kpis: Hedefler as [{name: line, target: ""}]}` (live) |
| `approved.sections.audience`, `prospecting`, `budget_frame`, `paid_enabled`, `cadence` | the frame's |
| `approved.sections.channels` | `[{channel: "any", rationale: "", group_id: null}]` |
| `approved.hypotheses` | the frame's, without the owner's request |
| `approved.gaps`, `assumptions` | `[]` |
| `approved.id`, `number`, `approved_at`, `status` | the frame's (`approved`) |

Description: "Read the knowledge base in the shape older routines read the strategy:
approved.sections.identity (product, voice and positioning from the owner's cards), prohibitions and
goals (the owner's rules and goals), audience and prospecting (derived), hypotheses (the topics), and
knowledge (everything jeeta.strategy.knowledge_get answers). approved is null until the knowledge
base has a card. The owner's edits apply at once: nothing here waits for an approval. Prefer
jeeta.strategy.knowledge_get. [risk: READ]" The panel route `GET /api/strategy` answers the same
(twin), read by the research and prospects pages for audience names.

### 5.5 Agent-facing texts that change (complete list)

| File | Today | After |
|---|---|---|
| `jt_mcp/src/tools/strategy.rs:30-35` | consultation protocol | §5.4 |
| `jt_mcp/src/tools/strategy.rs` (other 9 tools) | consultation tools | "Retired soon" sentence (PR 2b), removed (PR 6) |
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
| `jt_app/src/usecases/content/mod.rs:67-71` | `hypothesis_id` required "of the approved strategy" | optional, topic id |
| `jt_app/src/usecases/modules.rs:15-16, 102-123` | Strateji module and content steps | §4.12 |
| `jt_prospects/src/playbook.rs:1-9, 78-79` | "propose it … through the strategy consultation (jeeta.strategy.start_consultation); it applies once approved" | "The ICP and the rubric come from the knowledge base (card who_we_seek): when the card says something the frame does not, apply it with jeeta.strategy.frame_apply (prospecting); when you learned something the card does not say, propose it with jeeta.strategy.proposal_create." `PLAYBOOK_VERSION = 2`; the leads spec's Appendix A updated in the same PR |
| `jt_app/src/error.rs` `strategy_required` message | "an approved strategy is required first" | "the knowledge base is empty: the owner fills it in Bilgi bankasi first" (code unchanged) |

### 5.6 What the external routines must change

The routines are outside the repo; these blocks are written to be pasted. Order: after PR 2b is live
(the new tools exist, the old ones still work), before PR 6 (the old ones go).

**Content routine** — replace every step that reads `jeeta.strategy.get`, runs the consultation or
approves, and the rule "schedule only on accounts whose policy has requires_human_approval true"
(design 2026-11-19 G1), with:

```text
Every run:
1. Call jeeta.work.checkin, then jeeta.strategy.knowledge_get. The cards, the rules and the goals are
   the owner's own words and apply at once. The rules bind you: never write against a prohibition,
   never plan spend beyond the ad budget.
2. Do the items of jeeta.work.pending in priority order:
   - knowledge_note: claim, file into the right card (its whole new body, keeping the owner's text),
     summary in Turkish; dismiss what is no knowledge. Then check in again.
   - knowledge_derive (part posting): derive identity, audience, objective and topics from the
     cards; keep the ids of frame.topics and the keys of frame.audience that stay; apply with
     jeeta.strategy.frame_apply and the kb_revision you read. Never send channels, prohibitions,
     goals or budgets.
   - content_area: follow the item's hint. When the brief names a platform ("sadece TikTok"), make
     versions only for it. hypothesis_id is optional (a topic id of frame.topics).
   - social_schedule: every account jeeta.social.versions_waiting lists may be scheduled; a
     human_gate means the owner acts after scheduling (approval or TikTok's screen), not that you
     must not schedule there.
   - studio_material_analysis: mark faces, names, children, client logos and corporate references
     in depicts, and named people in people; never set a share permission.
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
   who_we_seek and customers. Keep the key of every entry of frame.prospecting.icp that stays the
   same (its standing research task and today's count carry over); a new or changed entry gets a new
   key. Change the rubric only when a card asks for it. Apply with jeeta.strategy.frame_apply
   (prospecting) and the kb_revision you read.
3. research_due, prospects_to_score, prospects_to_promote: as the playbook says (version 2). Score
   with the rubric_digest of the playbook.
4. knowledge_note items you can file (a note about whom to look for): file them into who_we_seek.
5. Never call jeeta.strategy.start_consultation or any consultation tool; to change whom we look
   for beyond what the card says, propose it with jeeta.strategy.proposal_create.
```

Other routines (inbox): read `jeeta.inbox.context.knowledge` (or `jeeta.strategy.knowledge_get`);
nothing else changes for them.

## 6. Every blocker and major touchpoint, resolved

All 145 blocker (B) and major (M) touchpoints of the map, by area (A0 strategy, A1 content, social
and studio, A2 the gate and the other modules, A3 the panel pages, A4 the server reads and writes,
A5 the agent contract, A6 the data model). Minor touchpoints fall under the same sections
(cross-links §2.13, agent texts §5.5, readers §4.12). Paths are the map's, shortened.

| # | Sev | Where | Decision |
|---|---|---|---|
| A0.1 | B | `rust/crates/domain/jt_strategy/src/sections.rs:14-345 + parse.rs:22-245` | Kept as the frame's internal schema (K1); owner knowledge lives in the 0046 tables (§4.2); cards to frame §4.10.1; sections to cards §4.3.2. |
| A0.2 | M | `rust/crates/domain/jt_strategy/src/rules.rs:71-362` | No owner-facing gate. Reused as the validation of a frame apply, minus every channel rule (§4.10.2 step 4). |
| A0.3 | B | `rust/crates/domain/jt_strategy/src/version.rs:15-71; jt_pg/src/repos/strategy.rs:168-378; migrations/0002_strategy.up.sql:16-36` | Versions stay append-only; a frame is a new version inserted and approved by the system in one transaction (§4.10.2); no in-place edit path. |
| A0.4 | B | `rust/crates/jt_app/src/usecases/strategy.rs:258-711 (start_consultation, record, write_section, set_hypotheses, submit, approve)` | Replaced by card, rules, goals, note and proposal writes (§4.4–§4.9) and `frame_apply` (§4.10.3); approve's side effects move into `knowledge::frame::apply`; the old use cases are removed in PR 6. |
| A0.5 | M | `rust/crates/jt_app/src/usecases/strategy.rs:713-798 (archive)` | Removed in PR 6 (D10); the owner's stop is `Tüm paylaşımları durdur` in Ayarlar (`studio.brake`); frames are never withdrawn. |
| A0.6 | M | `rust/crates/jt_app/src/usecases/strategy.rs:800-1003 (add_channel) + panel/src/pages/social/Stops.tsx:44-66,104-106` | Removed in PR 2a with the `prepare_strategy` action (K6). |
| A0.7 | M | `sections.channels consumers: jt_studio/src/chain.rs:192-197; studio/posts.rs:142-150,211; studio/planner.rs:414-417,477; studio/views.rs:106-115; studio/ads.rs:88; studio/trends…` | Frames always carry `channels = [any]` (§4.10.1); every listed consumer already accepts `any`; only `channel_not_in_strategy` (ready, why_blocked) and the group delete guard are removed (§3.10.2, §4.12). |
| A0.8 | B | `rust/crates/domain/jt_strategy/src/hypothesis.rs + strategy_hypotheses table (0002:38-53, 0009:5-15)` | Kept internal as topics, derived by agents (`frame_apply.topics`) with stable ids (given, or matched by title), channel `any`, default organic cadence (§4.10.2, §4.10.10). |
| A0.9 | B | `migrations/0009_studio.up.sql:21-150; 0020_prospects.up.sql:32-33; 0026_outreach.up.sql:52` | Untouched: no version or hypothesis row is deleted or rekeyed; every frame is a new row. |
| A0.10 | B | `jt_app/src/gate.rs:11-35,164-212; jt_pg/src/strategy_gate.rs:27-45; catalog.rs (83 Gated rows); jt_app/src/error.rs:24-25,149-152` | Predicate unchanged (K3); a frame exists from the first card (bootstrap, §4.10.5); message and panel words changed (§4.10.11); catalog modes unchanged but `posting_policy_set` and the four stop rows (D12). |
| A0.11 | B | `lock_execution_frame / current_approved callers (~40): studio/chain.rs:238-242, studio/budget.rs:15-53, ads/mod.rs:195-218, studio/planner.rs:123, social/schedule.rs:170-178,761…` | Unchanged: once the knowledge base has a card a frame always exists; frame apply takes the locks in approve's order. |
| A0.12 | M | `jt_app/src/usecases/studio/owner_request.rs:1-164; social/schedule.rs:166-178,781-815; posts.rs:964-971; content/delivery.rs:161-163` | Kept; carry-over moved into frame apply (§4.10.2 step 3); `names()` covers a person's request naming nothing (§3.5). |
| A0.13 | M | `jt_app/src/usecases/studio/trends.rs:121-194; jt_pg/src/repos/hypotheses.rs:112-154` | Removed in PR 6; agents propose knowledge (`proposal_create`, §4.9) and derive topics (`frame_apply`, §4.10.3). |
| A0.14 | M | `jt_strategy/src/consultation.rs + consultation_entries (0002:55-82) + jt_pg/src/repos/consultation.rs` | Log kept append-only and FK-bound (system entries for every apply); its answers and notes seed `Önceki görüşmeler` (§4.3.1); the owner's notes use `knowledge_notes` (§4.8). |
| A0.15 | M | `jt_app/src/usecases/research.rs:198-260; prospects/playbook.rs:85-112; jt_prospects/src/playbook.rs:76-79` | K5 carry (§4.10.7); the research agent derives ICP and rubric (§4.10.4); playbook version 2 (§5.5). |
| A0.16 | M | `budget_frame/paid_enabled consumers: ads/mod.rs:204-245; budget.rs:569-590; studio/ads.rs:83,480,584,862; studio/budget.rs:96,283; studio/chain.rs:402-410; studio/control.rs:457…` | The paid lane is mirrored from the general ad budget item (§4.6.2); readers unchanged; a missing organic lane is no lane cap (D3). |
| A0.17 | M | `jt_app/src/usecases/inbox/context.rs:444-462; studio/work.rs:439-442; content/mod.rs:67-71` | `inbox.context` and `slot_get` read the knowledge base live (§4.12); delivery's `hypothesis_id` optional (§5.1). |
| A0.18 | M | `jt_app/src/usecases/work.rs:121-143,387-388,1133-1186` | `KnowledgeState` and the four new kinds; consult/approve kinds removed (§5.2). |
| A0.19 | M | `rust/crates/adapters/jt_mcp/src/tools/strategy.rs:26-380; jt_app/src/catalog.rs:435-448` | Six tools added, `get` re-described as the compatibility projection, nine plus `hypothesis_propose` removed in PR 6 (§5.1). |
| A0.20 | M | `rust/crates/adapters/jt_panel_http/src/routes/strategy.rs:1-214; routes/mod.rs:250-260,1354-1413` | `GET /api/strategy` kept (compat twin); write routes removed in PR 6; `/api/knowledge` routes added (§4.4–§4.9). |
| A0.21 | M | `rust/panel/src/pages/StrategyPage.tsx; pages/strategy/{sections.tsx,HypothesesSection.tsx,BriefNavigation.tsx,queries.ts}; components/{ApproveDialog,ConsultationLog,GapList,Hypo…` | Replaced by the Bilgi bankası page (PR 4, §4.11); ApproveDialog, ConsultationLog, GapList, HypothesisTable, KindSelect, BriefNavigation, sections, HypothesesSection, api/strategy writes deleted; StrategyLearned becomes `Neler işe yarıyor`. |
| A0.24 | M | `Tests: jt_app/tests/strategy.rs (2803 lines), jt_pg/tests/strategy_repos.rs (1476), jt_strategy/tests/rules.rs (1010), jt_panel_http/tests/strategy_http.rs (595), jt_testkit/src…` | Lifecycle tests rewritten for the frame engine and the compat projection; repo tests kept (versions are still written); fakes extended (§8). |
| A1.1 | B | `rust/crates/jt_app/src/catalog.rs:231-254, 266, 268-269, 300, 337, 340-344 (GateMode::Gated rows) + rust/crates/jt_app/src/gate.rs:190-201 + rust/crates/adapters/jt_pg/src/strat…` | Predicate unchanged; with the bootstrap every workspace with a card has a frame, so the panel's actions run; `posting_policy_set` becomes Exempt (D12). |
| A1.2 | B | `rust/crates/jt_app/src/usecases/studio/work.rs:94-107 (gated) and every caller: work.rs:113,370,465,484; posts.rs:536,687,1112,1243,1412; pieces.rs:246,428,457; materials.rs:403…` | Unchanged: `gated()` still locks and returns the frame; its `.sections` are now system-maintained, `.id` the frame's. |
| A1.3 | B | `rust/crates/adapters/jt_pg/src/repos/strategy.rs:169-179; rust/crates/jt_app/src/ports/mod.rs:727-738; lock-only callers measure.rs:20,425,617, learning.rs:402, publish.rs:358,5…` | Unchanged: lock plus frame read; frame apply takes it after the draft lock as approve did. |
| A1.4 | B | `rust/migrations/0009_studio.up.sql:21-150 (FKs to strategy_hypotheses and strategy_versions); rust/crates/adapters/jt_pg/src/repos/studio/queue.rs:14-16,65-80; rust/crates/adapt…` | Unchanged: claims find the frame once the knowledge base has a card. |
| A1.5 | B | `rust/crates/jt_app/src/usecases/studio/chain.rs:231-389 (authorize_execution_at), 392-444 (check_caps); rust/crates/domain/jt_studio/src/chain.rs:120-202 (ChainContext, validate…` | Rules unchanged; channel checks pass via `any`; `capability_requires_human_approval` fed by the effective post gate (§3.10.1); caps from the mirrored lane. |
| A1.6 | B | `rust/crates/jt_app/src/usecases/studio/planner.rs:121-136, 312-354 (no-strategy early return; triggers), 586-632 (Triggers::run), 968-1094 (floor), 361-521 (plan_paid)` | Unchanged: triggers run once a frame exists; the floor trigger chooses among derived topics; `SlotUnfilled` names a topic title (owner words). |
| A1.7 | B | `rust/crates/jt_app/src/usecases/studio/posts.rs:103-262 (ChannelOption, content_types, selected, open_channels, channels, best_option)` | Unchanged code: options = live topics × organic content type on every connected account (normalised frame). |
| A1.8 | B | `rust/crates/jt_app/src/usecases/studio/posts.rs:559-1069 (ProposedPost.hypothesis_id, posts_propose_locked, check_item); rust/crates/domain/jt_studio/src/package.rs:90-104, 275-…` | Contract kept; agents name topic ids from `knowledge_get.frame.topics`; refusal codes never reach the owner (rows show waits). |
| A1.9 | B | `rust/crates/jt_app/src/usecases/social/schedule.rs:117-357 (version_schedule), 642-863 (Attribution, why_blocked, VersionAccounts::load/pick/of), 866-899 (waiting)` | `knowledge_empty` replaces `no_approved_strategy`; `channel_not_in_strategy` removed; `hypothesis_does_not_post` kept as a defensive code that lists a derivation (§3.2.4, §3.10.2). |
| A1.10 | B | `rust/crates/jt_app/src/usecases/content/delivery.rs:41, 148-166, 254-349, 364-432; rust/crates/jt_app/src/usecases/content/mod.rs:67-71` | Stays Gated (areas are offered only with a frame, §4.10.11); `hypothesis_id` optional, the server takes the first live topic (§5.1). |
| A1.11 | B | `rust/crates/jt_app/src/usecases/studio/control.rs:79-169 (hypothesis_live, approve); rust/crates/jt_app/src/usecases/studio/tiktok.rs:158-173, 388-405, 530-629; rust/crates/jt_a…` | Gates unchanged; `hypothesis_inactive` only on a race because a topic with planned posts is never retired (D9); a person's post cancel takes `social.manage` or `content.manage` (D13). |
| A1.12 | B | `rust/crates/jt_app/src/usecases/studio/lifecycle.rs:13-24; rust/crates/adapters/jt_pg/src/repos/studio/mod.rs:359-374; rust/crates/jt_app/src/usecases/studio/posts.rs:457-502; r…` | Runs on every frame apply; topics with planned or ready posts stay kept (D9); F4 frees the rest. |
| A1.13 | M | `rust/crates/jt_app/src/usecases/studio/owner_request.rs:1-140; schedule.rs:170-178, 785-815; strategy.rs:617-623; content/delivery.rs:161-163; posts.rs:191-200, 964-971` | As A0.12. |
| A1.14 | M | `rust/crates/jt_app/src/usecases/social/ready.rs:24-65, 100-212; rust/crates/jt_app/src/usecases/social/accounts.rs:306-326, 488-492; rust/crates/jt_app/src/usecases/content/view…` | Strategy stops removed, `knowledge_empty` added, approval from the effective gate (§3.10.2). |
| A1.15 | M | `rust/crates/jt_app/src/usecases/strategy.rs:800-1003 (add_channel) + rust/crates/jt_app/src/catalog.rs:446-448 + rust/panel/src/api/strategy.ts:25-29 + rust/panel/src/pages/soci…` | Removed in PR 2a. |
| A1.16 | M | `rust/crates/jt_app/src/usecases/content/pipeline.rs:169-188, 266-308, 326-335, 577-583; rust/crates/jt_app/src/usecases/content/views.rs:415-484, 632-667, 729-736, 815-816, 973-981` | Blocked codes mapped to owner waits (§3.2.4); retirement reasons stay internal (a retired post is no row). |
| A1.17 | M | `rust/crates/jt_app/src/usecases/studio/work.rs:19-47, 388-450 (SlotOut.hypothesis, brand_rules)` | `brand_rules` from the knowledge base (§4.12). |
| A1.18 | M | `rust/crates/jt_app/src/usecases/studio/pieces.rs:233-377, 527-611` | Unchanged; the chain passes under normalised frames. |
| A1.19 | M | `rust/crates/jt_app/src/usecases/studio/publish.rs:165-226, 249-300, 1243-1292` | Unchanged; an apply never retires a topic with planned or ready posts (D9), so it never withdraws a post a platform holds. |
| A1.20 | M | `rust/crates/jt_app/src/usecases/studio/budget.rs:11-101, 593-676; chain.rs:392-444; ads.rs:67-151; control.rs:341-466; learning.rs:201-242` | Paid lane mirrored; missing organic lane no lane cap (D3); frames change only on real change (§4.10.9), so `strategy_changed` stays rare; replays re-reserve as today. |
| A1.21 | M | `rust/crates/jt_app/src/usecases/studio/trends.rs:121-194 (hypothesis_propose), 37-120 (trend_record); catalog.rs:246-247` | `hypothesis_propose` removed (PR 6); `trend_record` unchanged with topic ids. |
| A1.22 | M | `rust/crates/jt_app/src/usecases/studio/learning.rs:81-318 (learned_for, judgment_record), 396-426 (reweight_week); measure.rs:17-127; rust/crates/domain/jt_studio/src/learning.r…` | Ids stable (§4.10.10); the learned view becomes `Neler işe yarıyor` without versions (§4.11). |
| A1.23 | M | `rust/crates/jt_app/src/usecases/work.rs:470-485, 584-607, 640-660, 1404-1428, 1488-1498` | Items and hints per §5.2. |
| A1.24 | M | `rust/crates/adapters/jt_mcp/src/tools/social.rs:14,21,28; content.rs:14; studio.rs:58,72,93,113-119,142,163,181,205-206,230,254,403,521-522` | Descriptions per §5.5. |
| A1.25 | M | `rust/crates/jt_app/src/usecases/studio/posts.rs:1389-1442 (posting_policy_set) + catalog.rs:344` | Exempt (D12); stays in Ayarlar › Paylaşım kuralları. |
| A2.1 | B | `rust/crates/jt_app/src/gate.rs:11-35,164-212 (StrategyGate, NoStrategyYet, check_gate) + rust/crates/adapters/jt_pg/src/strategy_gate.rs:29-45` | Predicate unchanged (K3); the CAPABILITY_EXEMPT stop rows become Exempt from the strategy gate too (D12). |
| A2.2 | B | `rust/crates/jt_app/src/catalog.rs:230-612 (82 Gated rows) + rust/crates/jt_archtest/tests/gate_rule.rs:19-196 + rust/crates/jt_app/tests/gate.rs:184-230` | Modes unchanged but `posting_policy_set` and the four stops (Exempt) and `hypothesis_propose` (removed); `gate_rule` EXEMPT_IDS updated; new ids under `strategy.` and `content.` (§3.1, §5.1). |
| A2.3 | B | `rust/crates/adapters/jt_pg/src/repos/strategy.rs:274-338 (draft-only writes) and the strategy_versions indexes in rust/migrations/0002_strategy.up.sql:33-36` | Unchanged; the system inserts a draft and approves it in one transaction; no in-place update. |
| A2.4 | B | `rust/crates/jt_app/src/usecases/studio/budget.rs:11-101 (reserve_connector_spend / validate_reservation), 587-676 (is_metered, reserve_metered_for)` | Organic lane per D3; paid lane mirrored; version equality kept (frame changes are rare and deliberate). |
| A2.5 | B | `rust/crates/jt_app/src/usecases/inbox/replies.rs:268-317,1029-1047,1185,1391-1411` | Unchanged: commercial contact is allowed once a frame exists, which is once the owner wrote the knowledge base; words changed (§4.10.11). |
| A2.6 | B | `rust/crates/jt_app/src/usecases/ads/mod.rs:188-258 (check_money) and its callers at 547, 593-596, 686, 887, 994; rust/crates/jt_app/src/usecases/ads/plan.rs:611-672; rust/crates…` | Reads the mirrored lane (§4.6.2); `no_paid_lane` / `above_strategy_cap` worded as Kurallar. |
| A2.7 | M | `rust/crates/jt_app/src/usecases/ads/plan.rs:350-384,513-518; rust/crates/jt_app/src/usecases/ads/watch.rs:422-426,465` | Kept; topic ids from `knowledge_get` (ADS_PLAN_HINT, §5.2). |
| A2.8 | M | `rust/crates/jt_app/src/usecases/studio/ads.rs:67-145,474-500,575-600,803-880; rust/crates/domain/jt_studio/src/chain.rs:153-192` | `paid_channel_not_selected` cannot fire (`any`); the rollover on a frame change is accepted (rare). |
| A2.9 | M | `rust/crates/jt_app/src/usecases/studio/planner.rs:361-418,473-479` | Paid cadence comes from an `ads.work` agent's `frame_apply` (§4.10.3); channels `any`. |
| A2.10 | B | `rust/crates/jt_app/src/usecases/research.rs:63-289 (prospecting_version, remaining, plan_in, plan), 455-492, 657-684; rust/crates/jt_app/src/usecases/strategy.rs:699; rust/crate…` | K5 carry (§4.10.7); planning runs from every apply and the hourly job. |
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
| A5.2 | B | `rust/crates/jt_app/src/usecases/strategy.rs (get 229-247, start_consultation 258, record 339, write_section 395, set_hypotheses 453, submit 524, approve 593-711, archive 725-798…` | Approve's effects in frame apply (§4.10.2); the consultation use cases removed in PR 6. |
| A5.3 | B | `rust/crates/jt_app/src/gate.rs:199-200; rust/crates/adapters/jt_pg/src/strategy_gate.rs:29-44; rust/crates/jt_app/src/catalog.rs (82 Gated rows, 73 MCP tools)` | As A0.10. |
| A5.4 | B | `rust/crates/jt_app/src/usecases/work.rs:121-143 (StrategyState), 272-274, 387-388 (ConsultStrategy/ApproveStrategy), 738-739, 1131-1186 (strategy_state, may_approve, strategy_it…` | Per §5.2. |
| A5.5 | M | `rust/crates/adapters/jt_mcp/src/tools/work.rs:23-63 (work.pending description)` | Per §5.2. |
| A5.6 | M | `rust/crates/jt_app/src/usecases/work.rs:1404-1429 (CONTENT_AREA_HINT)` | Per §5.2. |
| A5.8 | M | `rust/crates/jt_app/src/usecases/work.rs:1444-1448 (ADS_PLAN_HINT); rust/crates/jt_app/src/usecases/ads/plan.rs:381-383, 513-518, 742; rust/crates/jt_app/src/usecases/ads/mod.rs:…` | Per §5.2 and §4.6.2. |
| A5.9 | M | `rust/crates/jt_app/src/usecases/content/mod.rs:67-71; rust/crates/jt_app/src/usecases/content/delivery.rs:161-166` | Per §5.1. |
| A5.10 | M | `rust/crates/jt_app/src/usecases/studio/trends.rs:121-194; rust/crates/adapters/jt_mcp/src/tools/studio.rs:112-120; rust/crates/jt_app/src/usecases/studio/permissions.rs:23-25; r…` | Removed in PR 6; proposals are knowledge proposals (§4.9). |
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
| A6.14 | M | `rust/crates/jt_app/src/usecases/studio/budget.rs:36-75 and rust/crates/adapters/jt_pg/src/repos/studio/queue.rs:114-124` | Frames change only on real change (§4.10.9); `late_completion` entries on a change are accepted. |

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

### 7.2 What every existing workspace goes through

In order, the first time after each deploy; each step idempotent and ledgered:

| Step | When | Workspace with an approved version | …and an open draft | Only a draft | Neither |
|---|---|---|---|---|---|
| Seed cards, rules, goals, switch (§4.3) | PR 1 (first knowledge call; PR 2a's `knowledge_settle` seeds the rest) | from the approved version | from the approved; draft differences become proposals; the draft is archived (PR 2a, with the frame engine; PR 1 only seeds) | from the draft; draft archived in PR 2a | blank seeds |
| Ad budget reconciliation (§4.3.2) | PR 2a | general item lowered to the lane, or created from it, or zeroed when ads were off | same | — | — |
| Normalise the frame (§4.10.6) | PR 2a, first `knowledge_settle` tick | a new version: channels `any`, topics on `any`, organic lane dropped, paid lane mirrored; every topic kept; standing tasks carried | same | after the bootstrap | — |
| Bootstrap (§4.10.5) | PR 2a | — | — | when the seeded cards are not empty | at the owner's first card |

The owner's workspace (figurunica, approved version 5, no draft): 8 seed cards plus `Önceki
görüşmeler` if its 5 log entries hold answers or notes, 7 prohibitions, 5 goals, ad budget 5.000 TRY a
month (or less if the general item is lower), a normalised version 6 with the same 7 topics, 7 standing
research tasks carried. The pending HummyTummy import: run it after PR 2b by writing cards
(`strategy.card_*` through the panel, or a one-off script calling the same use cases); before PR 6 it
may still use the old tools, whose result `knowledge_settle` normalises.

### 7.3 Production data safety

- Additive schema; no column changes on existing tables; no FK rewrites (A6: every studio FK stays
  valid because no version or hypothesis row is deleted or rekeyed).
- Application writes to existing tables are limited to: new `strategy_versions` and
  `strategy_hypotheses` rows (append-only, as every approval did), archiving open drafts (status
  only; their content stays), re-stamping carried research tasks (`strategy_version_id`, ledgered with
  both ids), lowering or creating the general ad budget item (ledgered with the reason; never
  raising), pausing over-limit campaigns after an owner's lowering (the ads watch's own hold).
- Before each deploy of PR 1, PR 2a and PR 6: `pg_dump` of the database as the release runbook does
  (`rust/scripts/backup.sh`), and, for PR 2a, a dump of `strategy_versions`, `strategy_hypotheses`,
  `research_tasks`, `budget_items` to compare after the first `knowledge_settle` tick.
- Every system write is ledgered (`strategy.frame_applied`, `research.task_carried`,
  `budget.items.*` with `reason`, `strategy.knowledge_changed` with `cause = backfill`).

### 7.4 Pull requests, in order

| PR | Branch | Scope | Depends on | Ships alone because |
|---|---|---|---|---|
| 1 | `feat/knowledge-store` | 0046; `jt_knowledge` crate; `KnowledgeRepo` (pg, fake, six `TenantRepos` implementors); seed (§4.3, without the draft archive and the budget reconciliation); `strategy.knowledge_get` (twin); card, goals, notes (`note_add`, `note_withdraw`), proposals accept/skip panel writes; `rules_save` for prohibitions only (ad budget and switch read-only in the answer); revisions and history | — | nothing reads the new tables but the new use cases; agents may read `knowledge_get` at once |
| 2a | `feat/knowledge-frame` | `knowledge::frame::apply`, bootstrap, `knowledge_settle` job (seed, bootstrap, normalise, expiry), draft archive; `rules_save` ad budget (general item, mirror, `check_general`, hold) and post approval switch (effective gate §3.10.1); `validate_reservation` organic lane (D3); K5 carry; K6 removals (`channel_not_in_strategy`, `no_hypothesis`, strategy stop actions, `strategy.add_channel`, groups guard); `knowledge_empty` code; `posting_policy_set` and the four stops Exempt (D12); `inbox.context`, `slot_get`, `overview` read the knowledge base; `STRATEGY_REQUIRED` message | 1 | the old panel keeps working (codes it does not know show its generic words); agents' old tools keep working; the old strategy page's drafts are closed by the next frame apply, so PR 2b and PR 4 are deployed the same day |
| 2b | `feat/knowledge-agents` | MCP `frame_apply`, `note_claim`, `note_file`, `note_release`, `proposal_create`; `work.pending` `knowledge` state and kinds; hints; the four wake reasons (`content_delivered` is produced from PR 3 on), the `KNOWLEDGE` need, `request_for`; compat projection of `strategy.get`; delivery `hypothesis_id` optional; every description of §5.5 ("Retired soon" on the old tools); playbook version 2 with the leads spec's Appendix A | 2a | additive for agents: old routines keep working through the compat projection and the old tools |
| — | routines | the content and research routine prompts of §5.6 | 2b live | — |
| 3 | `feat/posts-read` | `content.posts`, `content.post_get`, `content.post_request` (files, share by rule, `pending_files`, wakes), `content.files_add`, `content.special_day_skip`, `content.version_cancel`; `owner_request::names`; `slot_cancel` person permission (D13); delivery wakes SOCIAL; `list_live_areas`, `find_area_by_version`, `get_pieces`, `get_materials`, `read_control`; `VersionCancel.slot_id` optional | 2a | new panel-only routes; the old pages unchanged |
| 4 | `feat/knowledge-page` | panel `/knowledge` (§4.11), `/strategy` redirect, menu rename, onboarding step 2, `ModuleStatusLine`, `QueryState`, `StudioShared`, `lib/errors.ts`, home items and ledger copy, research and prospects copy, `knowledge` i18n namespace; `StrategyPage` and its components deleted | 1, 2a, 2b | the server side is complete before it |
| 5 | `feat/posts-page` | panel `/posts` (§2), drawers, every redirect of §2.11, menu merge, link retargets (§2.13), `postsPage` i18n; `ContentPage`, `SocialPage`, `RootView`, `ContentTree`, `OlayView` page shell, `QueueView` shell, `timeline.ts`, `data.ts`, `VersionRow`, unrouted `StudioProjects`, `ProjectPublications`, `ProjectProduction` and their harnesses deleted (`MaterialEditor`, `MaterialsCalendar`, `SettingsDialog`, `StudioTiktok`, `TiktokSlot`, `OlayForms`, `uploads.tsx` reused) | 3, 4 | links into `/knowledge` exist (PR 4) |
| 6 | `chore/retire-strategy-tools` | remove the nine consultation tools, `strategy.approve`'s producer of `strategy_approved`, `studio.hypothesis_propose`, the `/api/strategy` write routes, `PendingOut.strategy`, `ConsultStrategy`/`ApproveStrategy`, panel `api/strategy.ts` writes and types; update `rust/README.md` (strategy sections), `rust/panel/README.md`, `docs/design/modular-agent-workspace.md`; mark the 2026-10-22 spec's K2/B1/B6/B7 as superseded here (§9 D31) | 4, 5, routines moved | checked first: no call to a removed tool in the last 7 days (ledger `agent.*`/MCP call log by tool name) |

No feature flags (D25): each PR is shippable as it stands, the server PRs keep the old contracts
working, and the panel switches page by page; a flag would only keep two pages alive longer.

### 7.5 Verifying each PR on production

Run against jeetagrowth.com with the owner's workspace (MCP with an owner key, and the panel):

| PR | Check |
|---|---|
| 1 | `jeeta.strategy.knowledge_get`: 8 seed cards (+ `past_conversations` if any), texts as §4.3.3, 7 prohibitions, 5 goals, `revision = 1`; `knowledge_revisions` has one `backfill` row per subject; a second call writes nothing; a card edit through the API bumps `revision` and appears in `knowledge_get` and in the history |
| 2a | after one `knowledge_settle` tick: `jeeta.strategy.list_versions` shows version 6 approved (cause `normalize` in the ledger), version 5 archived; `strategy.get` sections `channels = [any]`, the 7 hypotheses with the same ids and `channel: any`; `research.tasks_list`: the same 7 standing task ids, open, `research.task_carried` ×7 in the ledger, no `superseded`; `budget.items_list`: the general item's cap ≤ 500000 TRY monthly; `ads.campaigns_list` unchanged; `social.accounts_list` TikTok `requires_human_approval: true`; a scheduled post still goes out; a second tick applies nothing |
| 2b | `work.pending` (agent key): `knowledge` state; after a card edit, within a minute, a `knowledge_derive` item and a wake (`agents.wakes`); the routine's `frame_apply` with unchanged content answers `applied: false`; `strategy.get` identity.voice equals the `voice` card |
| 3 | `GET /api/content/posts` returns every current post of `/social` and every content of `/content` (count compare), `counts.you` equals the sum of today's waiting chips; a composer request from the API creates a `content` row, wakes the content agent, and the delivered versions list every connected account |
| 4 | `/knowledge` shows the seeded cards; editing `Ses tonu` changes `strategy.get` at once; `/strategy` lands on `/knowledge`; onboarding step 2 done |
| 5 | `/content`, `/social`, `/studio`, `/materials` and every legacy query land per §2.11; a TikTok post completes from the panel; home work items open the right row |
| 6 | the tool list (`tools/list`) has 240 tools; the routines' next runs show no error in their session logs; `work.pending` has no `strategy` field |

### 7.6 Rollback limits

| After | Rollback by | What is lost or stays |
|---|---|---|
| PR 1 | revert and run 0046's down | the knowledge tables (owner edits since the deploy: dump first); nothing else changed |
| PR 2a | revert the binary (0046 stays) | frames written stay (ordinary approved versions the older code reads); carried research tasks stay carried (valid); budget items stay lowered; the switch is no longer read (accounts' own flags rule again); archived drafts stay archived |
| PR 2b | revert | pending wakes with new reasons: the older binary cannot parse them — run 0046's down step that strips them, or wait for them to be sent (≤ 3 minutes) before switching |
| PR 3 | revert | the PR 2b binary cannot read a version cancelled without a slot (`VersionCancel.slot_id` absent): before switching, clear such cancels by hand (`cancelled` set to null in the area document; 0046's down refuses while one exists); composer materials keep their share and their `composer` field (ignored); `pending_files` is ignored, so such areas are offered to agents at once |
| PR 4, 5 | revert (panel only) | none; the old pages come back with the server unchanged |
| PR 6 | revert | removed tools come back; nothing in the data depends on them |

## 8. Test plan

### 8.1 Server

Pure (`jt_knowledge/tests`):
- limits and strict parsing of cards, rules, goals, notes, proposals; tolerant reads of unknown fields;
- the seed mapping against `strategy-v5.json` as a fixture (golden texts of every card, the
  truncation rule, the ad budget and switch rules), the draft-difference proposals, the past
  conversations card;
- the frame merge: system fields always recomputed (channels, prohibitions, goals, budget,
  cadence); topic ids (given, title match, new); `kept_for_posts`; the owner's request carried; the
  diff that skips; the empty predicate.

Repos (`jt_pg/tests/knowledge_repos.rs` and the fake's contract test in `jt_testkit/tests`):
RLS scoping, the append-only trigger, the one-key, one-pending and closed-rule constraints, history
paging, `list_live_areas` with more than 200 areas, `find_area_by_version`, `get_pieces`,
`get_materials`, `ResearchTasks::carry`; migration up/down twice; down refusal with a slotless
cancel; the restore drill with populated knowledge tables.

Use cases (`jt_app/tests/knowledge.rs`, `knowledge_frame.rs`, `posts_page.rs`; one test per rule):
- seed: each source of §4.3.1; two concurrent seeds make one; draft archived in PR 2a;
- cards: conflict on stale revision, archive and restore, too many cards, revision rows, knowledge
  revision and prospecting revision, wakes (`KnowledgeChanged`, `RESEARCH` only for the three card
  kinds), bootstrap in the same transaction as the first non-empty write (gate opens:
  `check_gate` passes a Gated use case right after);
- rules: prohibitions live in `knowledge_get`, `strategy.get`, `inbox.context`, `slot_get` in the
  same transaction; ad budget creates/updates the general item, mirrors the lane, `check_money`
  refuses above it, `watch_all` right after the save stops a running campaign whose period spend reached the new cap, cap 0 removes the lane
  (`no_paid_lane`); `check_general` no longer refuses `above_strategy_cap`; post approval switch:
  `pending_in` lists a ready X post for approval, `authorize_execution_at` holds it, accounts say
  `requires_human_approval`, a comment reply on the same account is **not** held; turning it off
  needs owner or manager; organic lane missing: an SMS reservation passes its item caps, a paid
  reservation without lane is `lane_budget_missing`;
- notes: claim lease and expiry, `note_claimed`, filing writes cards with `cause = note`,
  `filing_removes_text`, `note_withdrawn`, dismiss, release; listed to any work permission;
- proposals: limits and rate, dedupe, `superseded` on an owner edit, accept of each kind, expiry by
  the job;
- frame apply: permission per part (`part_permission`), gaps, `kb_revision_ahead`, unchanged →
  no version, ids stable across two applies, a left-out topic with a ready slot stays kept and is
  retired by the next apply once its post went out, transition hook frees versions (F4), owner's
  request carried, wakes only for changed parts and on behalf of `changed_by`, acknowledgements;
- normalise: a v5-like frame (channels instagram/tiktok/any, hypotheses on instagram, organic lane
  0, channel_mix) becomes `any`-shaped with every topic kept and its tasks carried; a second tick
  does nothing;
- K5: unchanged brief carried (id, claim and today's count kept), changed brief superseded and a new
  task opened, removed entry superseded;
- compat projection field by field (§5.4); `inbox.context.knowledge`; `slot_get.brand_rules`;
- posts read: table-driven over the row kinds, statuses, progress and waits of §2.3–§2.6; ordering,
  paging, cursor validation and counts; actions per permission variant of §2.10; no
  `lock_control`/`gated` call (the fake counts lock calls); a build-cost guard (500 areas, 2,000
  posts in the fake under a fixed budget);
- composer: text only (wake `CONTENT`), with files (genel, freed, pending, wake `MATERIALS`), a live
  duplicate reused, refused bytes `duplicate_material_file`, a PDF `file_not_media`, not a person
  `human_required`; share by rule (none found → shareable, pending cleared, `CONTENT` woken on behalf),
  a face → `files_permission`, a failed analysis or no materials agent → `files_permission` at once,
  `İzin ver` clears it, `Bu dosya olmadan devam et` clears it;
- `files_add` per target (special day creates a confirmed olay and, once shared, runs the calendar
  trigger and wakes `CONTENT`), `special_day_skip`, `version_cancel` (conflicts, archive when last);
- `owner_request::names` with empty hints; delivery of a person's content wakes `SOCIAL`; a
  person's post cancel with `content.manage` passes, with `social.work` only is refused.

### 8.2 Journeys (`rust/crates/jt_app/tests/journeys.rs`)

The world helper becomes `World::with_knowledge(cards)`: it seeds the knowledge base and applies a
frame through `frame::apply` (cause `derive`, as an agent would) instead of writing an approved
strategy; `w.approve_strategy()` (21 files) is kept as a thin wrapper over it until PR 6. Existing
journeys keep their assertions with the new codes; the two strategy variants become:
`a_derivation_mid_way_unblocks_the_delivered_versions_without_a_redo` and
`a_post_taken_back_by_a_derivation_waits_again_by_itself`. New journeys:

| Journey | Walks |
|---|---|
| `the_owners_free_text_request_posts_on_every_connected_account` | X and Instagram connected, composer text only → agent delivers one version per account → both offered (`owner_request` not needed: normalised frame) → scheduled → sent |
| `a_photo_with_the_request_is_shared_by_rule_and_used` | composer with an image, TikTok and Instagram → analysis finds nothing → shareable by rule → area offered → delivered → TikTok screen, Instagram goes out |
| `a_face_in_the_photo_waits_for_the_owners_permission_once` | analysis marks a face → row `files_permission` → `İzin ver` → area offered, nothing redone |
| `a_new_workspace_opens_with_its_first_card` | empty → composer stop `knowledge_empty`, no `content_area` item → first card → bootstrap frame, gate open, item listed and `CONTENT` woken → derivation retires the bootstrap topic only after its post went out |
| `a_card_edit_is_derived_once_after_a_burst` | three edits in 20 s → one `knowledge_derive` item after 30 s quiet → `frame_apply` → ids kept; a second apply answers `applied: false` |
| `the_approval_switch_holds_and_releases_posts` | X without approval scheduled → switch on → waits for approval → approve → sent; switch off → next goes out at its time; a comment reply never waits |
| `lowering_the_ad_budget_stops_what_reached_it` | campaign live, 3.200 spent this month → budget lowered to 3.000 → stopped by the same save, `check_money` refuses a new campaign of 500 |
| `research_keeps_its_standing_tasks_across_a_derivation` | ICP unchanged → same task id and today's count; one brief changed → that task superseded, a new one |
| `a_special_day_photo_starts_its_content_at_once` | day in preparation → `Fotoğraf ekle` → confirmed olay, shared by rule → calendar trigger opens the area in the same transaction, `CONTENT` woken |
| `a_note_is_filed_and_derived` | `note_add` → agent files into `products_prices` → `knowledge_derive` → apply → `SOCIAL` woken on behalf of the owner |

To extend: a new platform is still a `Platform` row and one test calling `journey`; a new gate is
asserted where a journey meets it, then its cause is cleared and the work must go on unredone.

### 8.3 Panel (Vitest + Testing Library)

- `PostsPage.test.tsx`: rows of every kind and status; chips (dynamic stages, counts from the
  server, fallback to Tümü); selection and the address; the panel per kind (no tabs, no step list);
  every wait's sentence and action calling the right endpoint with the read's revision; dialogs
  (Düzenleme iste with siblings, İptal per target, Geri al); composer (stops before sending, upload
  tray, success, hidden without permission or module); special-day lines; empty, loading, error,
  filter-nothing, row-not-in-list; phone cards (matchMedia); paging; the permission variants of §2.10.
- `PostsDrawers.test.tsx`: Dosyalar (queue, categories, confirm, file editor), Hesaplar (pause,
  per-account approval only when the switch is off, Sayılar on demand), Ayarlar (three sections,
  brake).
- `KnowledgePage.test.tsx`: cards (create, edit, conflict, archive and undo, history and restore),
  Kurallar dialog (budget read-only without `budget.manage`, switch), Hedefler, notes (add,
  withdraw, statuses), proposals (accept, skip, superseded), `Neler işe yarıyor` shown only with
  evidence and permission, read-only member, empty state.
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
| `jt_app/tests/catalog.rs` row count, `ops/m4_ops.rs` | 303 → 314 at PR 6 (each PR its own step) |
| `jt_mcp/tests/registry.rs` | tool list and `TOOLS.len()` 244 → 240; the `strategy.*` permission assertion rewritten (§5.1: `get`, `knowledge_get` → `[WorkspaceRead]`; notes and proposals → `WORK`; `frame_apply` → `[ContentWork, ProspectsWork, AdsWork]`); the `strategy.get` description pin; ASCII and risk tags |
| `jt_archtest/tests/twin_rule.rs` | strategy twins 10 → 2 |
| `jt_archtest/tests/m4_productisation.rs`, `fixtures/m3_surface.json` | `POST_M4_ADDED` + 22, `POST_M4_REMOVED` + 11, `POST_M4_PANEL_ONLY` + the panel-only rows (−1 `strategy.add_channel`) |
| `jt_archtest/tests/gate_rule.rs` | `EXEMPT_IDS` adds the six `content.*` rows, `studio.posting_policy_set` and the four stops; `strategy.` prefix covers the new ids |
| `jt_app/tests/gate.rs`, `jt_archtest/tests/inbox_without_strategy.rs` | the "without strategy" cases become "empty knowledge base"; the gate test adds "first card opens the gate" |
| `jt_archtest/tests/twin_parity.rs` | the consultation walk replaced by: card writes in the panel, `frame_apply` over MCP, then `GET /api/strategy` = `jeeta.strategy.get` and `GET /api/knowledge` = `jeeta.strategy.knowledge_get` field for field |
| `jt_archtest/tests/wake_triggers.rs` | rows of §5.3; `strategy.approve` row removed in PR 6 |
| `jt_archtest/tests/dependency_boundaries.rs` | `jt_knowledge` depends on `jt_strategy`, `jt_studio`, `jt_tenancy` only; `jt_app` on `jt_knowledge` |
| `jt_archtest/tests/studio_rules.rs` | registry size 240; `hypothesis_propose` removed from its permission list (PR 6) |
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
- A new test `i18n/ownerWords.test.ts` fails when a value under `postsPage`, `knowledge`, `stops`,
  `onboarding` or `moduleStatus` (Turkish) contains `olay`, `paket`, `sürüm`, `durak`, `hipotez`,
  `strateji`, `ICP`, `kadans`, `taslak` or `onay bekleyen sürüm` (case-insensitive), so the owner's
  words stay clean (G6). `Kategori` is the only name for an olay the owner reads.
- English copy is written for every Turkish key (the panel's `en` locale), same meaning.

## 9. Decisions taken by the lead

| # | Decision | Why |
|---|---|---|
| D1 | **The approval switch is a workspace setting read with each account's own flag** (`knowledge_settings.post_approval`, effective gate §3.10.1), not written onto every social account's `requires_human_approval` as K4 says. | Evidence: the account flag also holds every agent's **comment reply** on that account (`inbox/replies.rs:526-537`: `held = cap.policy.requires_human_approval && !human` for public items; `jt_capability/src/kind.rs` notes comment replies follow the account's flag). Writing it would make the owner approve every comment reply, which "her paylaşım onayıma gelsin" does not ask. Reading a switch also covers newly connected accounts with no write (K4's "default for new ones") and is reversible without touching each account. K4's other parts (one switch, TikTok counts as gated) are kept. |
| D2 | **The ad budget is the general ad budget item; the frame's paid lane mirrors it**; at backfill the number never allows more than before (lowered to the lane, created from it, or zeroed when ads were off); `check_general`'s strategy comparison goes; a lowering runs the ads watch at once, so a campaign whose spend reached the new cap stops in the same request. | One number for the owner (K4); `check_money` already holds campaigns against both, so making them equal changes no rule; never raising at backfill keeps spend safe; running the watch at once avoids "waiting on a clock" for a money limit. |
| D3 | **No organic lane in frames; a missing organic lane is no lane cap.** | The owner's rules name only an ad cap; nobody would write an organic lane any more, so every SMS and metered send would end in `lane_budget_missing` (A2.4). Spend stays bounded: a metered capability must link budget items (`budget_item_ids` may not be empty) whose caps and its own `spend_cap_minor` still apply. The owner's workspace had an organic lane of 0, written by an agent, that would have silently blocked any SMS. |
| D4 | **A bootstrap frame from the first written card.** | K3 keeps the gate "an approved frame exists"; without the bootstrap a new workspace waits for an agent's derivation (up to a day without a wake address) before its first post can be delivered — a clock the owner hates. The bootstrap topic is retired by the first derivation. |
| D5 | **Composer files are genel, freed by the owner, shared by rule after analysis unless a face, child, name, client logo, corporate reference or named person is found; the content waits for its files** (P3's wakes: `MATERIALS` at once, `CONTENT` when the files are ready, on behalf of the owner). | §3.4.3–§3.4.4: unfiled files could never be sources (O5) nor filed genel by analysis (O7); the people rules are kept exactly where they protect someone (R3); waiting for analysis (minutes, the materials agent is woken) is better than a post made without the owner's photo and refused at delivery. |
| D6 | **Prohibitions are instructions, not server checks.** | Free text cannot be matched reliably; a false refusal would dead-end deliveries. Every agent read carries them, the hints say they bind, and the final look stays the owner's (approval switch, TikTok screen). The Kurallar dialog says so plainly. |
| D7 | **Stage 5 is labelled `Uyarlama`, not `Paket`.** | "Paket" is one of the internal words the owner listed; the stage is "adapting to each platform" (steps 11–14). Its internal key `paket` stays. |
| D8 | **Olays an agent proposed are confirmed in Dosyalar, not counted in "Seni bekleyen".** | A proposed olay blocks nothing the owner asked for (a person's upload confirms its own olay, O7); counting it would put the hated concept in the owner's main list. |
| D9 | **A topic left out of a derivation stays live while it has planned or ready posts.** | Retiring it would retire and withdraw posts the owner may have approved or that a platform holds (A1.19); keeping it until they are gone costs nothing. |
| D10 | **No strategy archive; the owner's stop is `Tüm paylaşımları durdur` (brake).** | Archiving the frame would close the gate under a full knowledge base and the next tick would bootstrap it again; the brake already exists and stops what runs (A0.5). |
| D11 | **`hypothesis_id` is optional on delivery** (the frame's first live topic when absent). | The agent no longer sees owner-approved hypotheses; F1 already treats the id as a preference, and attribution settles it per account. |
| D12 | **`studio.posting_policy_set` and the four CAPABILITY_EXEMPT stops become Exempt.** | The posting policy is not strategy (A1.25); stopping what runs must never wait for a gate (A2 risk: after an archive nobody could pause an outreach campaign). |
| D13 | **A person's post cancel needs `social.manage` or `content.manage`; an agent's keeps `social.work`.** | Reconciles server (`social.work`) and panel (`social.manage`) (A3 risk) and lets a content manager cancel a post of their own content, which P1's "İptal per post" offers on one page. |
| D14 | **Archived contents are not listed.** | Archiving is how a content leaves the owner's list; their published posts stay reachable through `post_get` links. |
| D15 | **Draft differences become proposals; the consultation's answers become a card.** | Nothing the owner said is lost, and nothing unapproved takes effect without the owner adding it. |
| D16 | **No new permission.** KB edits need `team.manage`; agents file notes and propose with any work permission; derivation parts need `content.work` / `prospects.work` / `ads.work`. | A new permission would need new API keys for every routine (keys' scopes cannot be changed in place), a dead end on deploy day. |
| D17 | **PDF is accepted as a knowledge attachment only.** | A price list or catalogue is typical knowledge; `material_add` refuses it so it can never be posted. |
| D18 | **`content.version_cancel` with `VersionCancel.slot_id` optional.** | No write could cancel a version with no post (A4.14); the rollback limit is stated (§7.6). |
| D19 | **`wake::request_for`: the system wakes on behalf of the person who caused the work.** | A delivery, a filed note or an applied frame is an agent's action, which wakes nobody today; the owner asked in person, so the next agent should not wait for its schedule (R2). |
| D20 | **Composer stops are said before sending but never block it.** | R1 asks to say everything at once; blocking would force the owner to come back; the stopped work resumes by itself when the cause clears (R2). |
| D21 | **Two derivation parts (posting, prospecting) acknowledged separately.** | The content and research routines are different agents with different keys; one part's edit (voice) should not wake research. |
| D22 | **Debounce = 30 s quiet + the wake limits + skip-when-unchanged; no stored pending frame.** | Simple, observable, and enough for edit bursts; a stored pending frame would add a state and a job. |
| D23 | **`PendingOut.strategy` kept, reduced, until PR 6.** | Routines may read it; removing it with the tools keeps one breaking moment. |
| D24 | **Old strategy tools kept until the routines moved (PR 6).** | G7: an MCP client sees no compile error; the removal waits for evidence of no calls. |
| D25 | **No feature flags.** | §7.4: the server PRs are compatible; flags would only prolong two pages. |
| D26 | **A failed post of no content is no wait.** | Nothing the owner can do sends it again (design 2026-11-19 C8/O5 stays open); counting it would be a wait without an action. |
| D27 | **Special-day lines: preparation within 14 days, three at most.** | The tree lists 120 days ahead; the owner's page shows only what is near, the rest is in Ayarlar. |
| D28 | **Knowledge edits are owner or manager work (`team.manage`), viewing is everyone's.** | The knowledge base steers every agent; the previous strategy writes had the same permission. |
| D29 | **Note and card attachments are knowledge, never library materials.** | They are read, not posted, so the consent path of materials does not apply and nothing in them can go out by mistake. |
| D30 | **`Neler işe yarıyor` shows topic titles with İlgi buckets.** | "Learned results may stay"; titles are the agent's words for subjects ("Fotoğraftan figüre dönüşüm"), buckets avoid numbers that look like approvals. |
| D31 | **The 2026-10-22 spec's K2, B1, B6, B7 are superseded as follows:** K2 "no work without an approved strategy" → "no gated work without a frame, which exists once the knowledge base has a card"; B1 `STRATEGY_REQUIRED` keeps its code with the knowledge message; B6 "every post and ad tied to a hypothesis and a version" holds (topics and frames); B7 "the paid cap of the budget frame" holds, mirrored from the general ad budget. | The code comments cite them; this note is now their source. |
| D32 | **`frame_apply` does not take prohibitions or goals** (K3 lists them among the derived parts): the system copies Kurallar and Hedefler into every frame it applies. | They are the owner's own structured words (a list of rules, a list of goals), not something to derive; K4 already says prohibitions are read live and "mirrored into the frame on derivation" — the mirror is the system's, so no agent can drift from what the owner wrote. |
| D33 | **`content.posts` and the file writes are gated by the library module, not by `content`** (P2 says "content module"). | `gating_module` maps every `content.*` id to the install-gated `content` module (`jt_app/src/gate.rs:130-162`, `modules.rs` `INSTALL_GATED`), so a workspace with social but no content module would get `MODULE_NOT_INSTALLED` on the page P4 shows to it. The library comes with content, social and ads and has no requirement, exactly like the content page's library reads of 2026-11-18. The composer and the version cancel stay the content module's. |

