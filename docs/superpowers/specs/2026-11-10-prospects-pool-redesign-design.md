# Prospect pool: mail-style workspace, notes, timeline, and "Send message"

Owner request, 2026-11-10, agreed step by step in conversation with mockups
(`.superpowers/brainstorm/…/prospects-v1.html`). This note records the decisions.

## What the owner decided

- **"Gelen kutusuna aktar" goes away.** The action on a prospect is **"Mesaj gönder"**: choose a
  connected channel, write, send. Sending moves the prospect into the inbox at that moment
  (promotion happens underneath); the reply shows up in the inbox.
- **Every channel is included for the first message** ("İYS kaydı yapılabilir, hepsini ekle;
  gerekirse sonra kaldırırız"): e-mail, SMS, WhatsApp and Instagram.
- **The pool's home is redesigned** as a full-bleed workspace like the inbox: the list on the left,
  the chosen prospect on the right (owner did not pick A/B; B, the announced default, stands).
- **Notes must be there**, as on the old lead page: the research note, prominent, editable.
- **The prospect's progress, chronological and compact**, inside the prospect: one-line entries,
  newest first.
- **Inner pages are too plain**: the prospect page gets stage steps, contact, business, score and
  record cards.

## Channels of a first message (builder's findings, told to the owner)

| Channel | How it goes |
|---|---|
| E-mail | Jeeta sends from the connected mailbox (`inbox.send`, commercial). |
| SMS | Jeeta sends from the connected SMS line; a business recipient goes out under İYS's **tacir** filter (`iysfilter: "12"`), an individual under `"11"` as before. The İYS registration is the owner's. |
| WhatsApp | Meta refuses a business-initiated free-text message outside the 24-hour window (only approved templates may start one; the adapter has none). So: Jeeta prepares the text, promotes the prospect and opens `wa.me/<number>?text=…`; the person presses send in WhatsApp. With the number paired to the WhatsApp Business app, the echo files the message in the inbox on its own. |
| Instagram | Meta lets nobody start a DM through the API. Jeeta copies the text, promotes the prospect and opens `ig.me/m/<handle>`; the conversation appears in the inbox when the business answers. |

A WhatsApp/Instagram hand-off is recorded on the journey as a note ("WhatsApp'tan yazıldı: …"),
so it shows in the prospect's timeline.

## Permission rule (owner decision; builder's reading recorded)

- The code no longer forbids any messaging channel for the business-recipient basis:
  `jt_outreach::B2B_BASIS_CHANNELS` widens from e-mail to e-mail, SMS, WhatsApp, Instagram DM and
  Messenger.
- Unchanged, deliberately: each workspace's **owner** opens the basis per channel once, with the
  counsel-confirmation record (`outreach.settings_set`), and the platform switch
  `JEETA_OUTREACH_ENABLED` must be on. Opt-outs (suppressions, a withdrawn consent, the pool's
  do-not-contact) always refuse.
- A human who messages a `new` prospect qualifies it by that act (`prospects.decide qualify`, then
  promote, then send).

## Screens

- `/prospects` and `/prospects/:id`: one full-bleed page. Header: title, this month's funnel from
  `prospects.report` (found, qualified, in contact, replied, won), "Araştırma görevleri", "Ajan
  talimatları". Status tabs (Tümü, Yeni, Nitelikli, İletişimde, Reddedilen, Yasaklı) and the other
  filters (score range, task, city, segment). Left: compact rows (name, sector · place, score,
  status, age), selection for bulk reject / do-not-contact, paging. Right: the prospect.
- The prospect: header (name, status, place, actions: Mesaj gönder; ⋯ Nitelikli say, Reddet,
  Yeniden aç, İletişim yasağı, Sil), stage steps (Bulundu → Puanlandı → Nitelikli → Mesaj atıldı →
  Yanıt → Görüşme → Satış, from the prospect and its journey), **Notlar** (edit in place,
  `prospects.update set.notes`), **Akış** (pool ledger + journey events + journey notes, newest
  first), and side cards: İletişim (values with their evidence), İşletme, Puan (per criterion,
  history below), Kayıt, Olası mükerrerler.
- The `promoted` status reads **"İletişimde"**.
- Narrow screens: the list first; a chosen prospect replaces it, with a way back.

## Steps

1. The workspace page and the prospect pane (panel only).
2. "Mesaj gönder" for e-mail and SMS: the basis widening, the tacir filter, the dialog
   (qualify if new → promote → send, one request key per draft).
3. WhatsApp and Instagram hand-off.

## Not in this change

- WhatsApp templates (the way Jeeta itself could start a WhatsApp conversation).
- Message preview in the inbox list; name search in the pool (no server support yet).
