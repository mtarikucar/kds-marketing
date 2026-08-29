# Lead ve İletişimin Birleşmesi — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Lead ile iletişimi tek kayıtta buluştur — lead'de konuşma ve satış sekmeleri, başlıkta ara/mesaj eylemleri, ve `/inbox` ile `/leads`'in tek yüzeyde iki sekme olması.

**Architecture:** Neredeyse tamamı bağlama işi. `Opportunity.leadId`, `Conversation.leadId` ve tıkla-ara altyapısı mevcut; tek backend değişikliği konuşma listesine `leadId` filtresi eklemek.

**Tech Stack:** NestJS + Prisma (jest), Vite + React + TanStack Query (vitest), Playwright.

Spec: `docs/superpowers/specs/2026-08-29-lead-iletisim-birlesimi-design.md`

---

## Dosya yapısı

**Backend — değişen:**
- `src/modules/marketing/controllers/marketing-conversations.controller.ts` — `leadId` query
- `src/modules/marketing/inbox/conversations.service.ts` (veya listeyi sahiplenen servis) — filtre
- `test/e2e/lead-conversations.realdb.e2e-spec.ts` — **yeni**

**Frontend — yeni:**
- `src/pages/marketing/leadDetail/ConversationsTab.tsx` + test
- `src/pages/marketing/leadDetail/SalesTab.tsx` + test
- `src/pages/marketing/leadDetail/LeadHeaderActions.tsx` + test

**Frontend — değişen:**
- `src/pages/marketing/leadDetail/LeadDetailPage.tsx` — iki yeni sekme + başlık eylemleri
- `src/features/marketing/api/` — lead'e göre konuşma ve fırsat istemcileri
- gelen kutusu / lead listesi yüzeyi — iki sekme (Task 5)

---

### Task 1: Konuşmaları lead'e göre filtrele (backend)

**Files:**
- Modify: `backend/src/modules/marketing/controllers/marketing-conversations.controller.ts`
- Modify: the service that owns the conversation list
- Test: the service's existing spec

- [x] **Step 1: Write the failing test**

Servisin mevcut spec'ine ekle — `leadId` verildiğinde `where`'e düşmeli, verilmediğinde düşmemeli:

```ts
it('filters by lead when asked, and does not when not', async () => {
  await svc.list(WS, { leadId: 'lead-1' });
  expect(prisma.conversation.findMany.mock.calls[0][0].where).toMatchObject({
    workspaceId: WS,
    leadId: 'lead-1',
  });

  prisma.conversation.findMany.mockClear();
  await svc.list(WS, {});
  expect(prisma.conversation.findMany.mock.calls[0][0].where).not.toHaveProperty('leadId');
});
```

`svc.list`'in gerçek imzasını ve filtre nesnesinin şeklini **koda bakarak** doğrula; yukarıdaki bir taslak.

- [x] **Step 2: Run it, confirm FAIL**

`cd backend && npx jest <servisin spec dosyasi>`

- [x] **Step 3: Implement** — controller'a `@Query('leadId') leadId?: string`, servise `...(filter.leadId ? { leadId: filter.leadId } : {})`. Deseni `marketing-opportunities.controller.ts`'ten kopyala; orada aynı filtre zaten var.

- [x] **Step 4: Run, confirm PASS**, `npx tsc --noEmit -p tsconfig.json`

- [x] **Step 5: Commit**

---

### Task 2: Gerçek-DB e2e — lead filtresi ve kiracı izolasyonu

**Files:** Create `backend/test/e2e/lead-conversations.realdb.e2e-spec.ts`

Birim testleri Prisma'yı mock'lar ve mock her `where`'i kabul eder. `workspaceId: { in: [id, null] }` sekiz hafta boyunca yeşil bir paketle fırladı. Yeni filtre gerçek Postgres'e dokunmalı.

- [x] **Step 1:** Sibling'lerin desenini oku — `test/e2e/home-timeline.realdb.e2e-spec.ts` en yenisi ve en iyisi.
- [x] **Step 2:** İki workspace, her birinde bir lead ve o lead'e bağlı konuşmalar; ayrıca aynı workspace'te **başka bir lead'in** konuşması.
- [x] **Step 3:** Üç iddia: (a) `leadId` verilince yalnızca o lead'in konuşmaları döner, (b) yabancı workspace'in konuşması hiç dönmez, (c) `leadId` verilmeyince workspace'in hepsi döner.
- [x] **Step 4:** Koş: `docker start kds-marketing-postgres && E2E_REAL_DB=1 npx jest --config test/jest-e2e.json lead-conversations.realdb --runInBand`
- [x] **Step 5: Kasten kır** — filtreden `workspaceId`'yi çıkar, (b)'nin düştüğünü gör, geri al. Ne gördüğünü raporla.
- [x] **Step 6:** Temizlik doğrula (ektiğin satırlar kalmamalı), commit.

---

### Task 3: Lead'de Konuşmalar sekmesi

**Files:**
- Create: `frontend/src/pages/marketing/leadDetail/ConversationsTab.tsx` + `.test.tsx`
- Modify: `LeadDetailPage.tsx`, ilgili api servisi

- [x] **Step 1:** İstemci: `getLeadConversations(leadId)` → `GET /conversations?leadId=…`
- [x] **Step 2: Testi önce yaz** — üç hâl: konuşma listelenir; hiç yoksa boş durum; **fetch hata verirse boş durum DEĞİL, hata gösterilir** (bunlar farklı şeyler ve karıştırılmaları bu deponun tekrar eden hatası).
- [x] **Step 3:** Bileşen. `ActivityTimelineTab.tsx`'i üslup ve yapı için örnek al; `QueryStateBoundary` API'si düz children (`isLoading`/`isError`/`onRetry`), render-prop **değil**.
- [x] **Step 4:** `LeadDetailPage`'e sekme olarak ekle.
- [x] **Step 5:** Mutasyon: hata dalını sil, testin düştüğünü gör.
- [x] **Step 6:** `npx vitest run src/pages/marketing/leadDetail/`, `npx tsc --noEmit`, commit.

---

### Task 4: Lead'de Satış sekmesi

**Files:** Create `SalesTab.tsx` + `.test.tsx`; modify `LeadDetailPage.tsx`

`GET /marketing/opportunities?leadId=…` **zaten çalışıyor** — `OpportunityFilterDto.leadId` mevcut. Backend değişikliği yok.

- [x] **Step 1: Test önce** — fırsatlar aşamalarıyla listelenir; hiç yoksa boş durum + "fırsat oluştur" eylemi; hata hâli boş durumdan ayırt edilir.
- [x] **Step 2:** Bileşen. Her satır fırsata gider (`/opportunities/:id`).
  > **Sapma:** `/opportunities/:id` diye bir rota yok — `App.tsx`'te yalnızca
  > `/opportunities` var ve fırsatın tek yüzeyi board. Satır, board'u
  > `?deal=<id>&pipelineId=<id>` ile o fırsatta açıyor (`SalesTab.tsx:79`).
  > Commit `cb592489`.
- [x] **Step 3:** "Fırsat oluştur" mevcut oluşturma akışını `leadId` önceden dolu olarak açar — yeni bir oluşturma yolu yazma.
- [x] **Step 4:** Mutasyon: `leadId`'yi istekten düşür, testin düştüğünü gör (aksi hâlde sekme tüm fırsatları gösterir ve bunu kimse fark etmez).
- [x] **Step 5:** Test, tsc, commit.

---

### Task 5: Lead başlığında Ara ve Mesaj

**Files:** Create `LeadHeaderActions.tsx` + `.test.tsx`; modify `LeadDetailPage.tsx`

- [x] **Step 1: Test önce** — telefonu olan lead'de Ara görünür; **telefonu olmayan lead'de Ara HİÇ render edilmez** (tıklanınca başarısız olan düğme, olmayan düğmeden kötüdür); Mesaj mevcut konuşmayı açar, yoksa başlatma akışını açar.
- [x] **Step 2:** Mevcut tıkla-ara yolunu bul (`DialerPage`, telefon modülü) ve **onu çağır** — yeni arama yolu yazma.
- [x] **Step 3:** Arama sonrası kaydın Hareketler'e düştüğünü doğrula (mevcut davranışsa iddia et, değilse rapor et — bu spec onu eklemiyor).
  > **Bulgu:** yazma tarafı mevcuttu (`SalesCallService.logCall`, `call.leadId`
  > üstünden CALL LeadActivity), ama ekrana **gelmiyordu**: ClickToDialButton
  > yalnızca `['marketing','calls']`'ı invalidate ediyordu, Hareketler ise
  > `['marketing','lead',id]`'den besleniyor. Elle yenilemeden görünmüyordu.
  > Commit `07c5d9fc` dial bir lead taşıyorsa lead'i de invalidate ediyor.
- [x] **Step 4:** Mutasyon: telefon kontrolünü kaldır, testin düştüğünü gör.
- [x] **Step 5:** Test, tsc, commit.

---

### Task 6: Birleşik yüzey — iki sekme, tek veri kümesi

**Files:** gelen kutusu ve lead listesi sayfaları; rota tanımları **değişmez**

- [x] **Step 1:** `/inbox` ve `/leads`'in **ikisi de** kalmalı. Frozen 50-yol kümesi `navigation.test.ts`'te sabitli; bir rotayı silmek testi düşürür ve yer imlerini kırar. İkisi aynı bileşeni render eder, yalnızca varsayılan sekme farklıdır.
- [x] **Step 2: Test önce** — `/inbox` Konuşmalar sekmesiyle açılır; `/leads` Kişiler sekmesiyle açılır; sekme değiştirmek seçili kaydı korur.
- [x] **Step 3:** Sekme bileşeni olarak `src/components/ui/Tabs.tsx` (Radix) kullan — elle `role="tablist"` yazma; tam ARIA sözleşmesini o veriyor ve `LeadColumn` örneği var.
- [x] **Step 4:** Kişiler sekmesinde iş kuyruğu filtreleri: `Bekleyen` / `Atanmamış` / `Hepsi`, sayılarıyla. **363 sessiz lead'in görünür kalması bu tasarımın asıl sebebi** — konuşma-öncelikli tek liste onları gizler.
- [x] **Step 5:** Mutasyon: `/leads`'i Konuşmalar sekmesine düşür, testin düştüğünü gör.
  > **İlk teslimde bu mutasyon YEŞİL geçiyordu.** `MergedSurface.test.tsx`
  > kendi rota tablosunu kuruyordu; el kopyası kopyayı kanıtlar, uygulamayı
  > değil. `App.tsx` artık `MERGED_SURFACE_ROUTES`'u dışa veriyor ve test onu
  > mount ediyor; `defaultTab="contacts"` silinince 11 testin 3'ü düşüyor.
  > Commit `c1dbe2ac`.
- [x] **Step 6:** Tüm ön yüz paketi + `npx tsc --noEmit`, commit.

---

## Bitiş doğrulaması

- [x] `cd backend && npx jest` ve `E2E_REAL_DB=1 npx jest --config test/jest-e2e.json realdb --runInBand`
  > 563 suite / 6024 test yeşil; realdb 12 suite / 54 test yeşil.
- [x] `cd frontend && npx vitest run && npx tsc --noEmit`
- [x] **Frozen yol kümesi bozulmadı** — `navigation.test.ts` yeşil, 27 test,
      dosya değiştirilmedi
- [ ] PR aç, **CI'ın altı işinin de yeşil olduğunu gör** (dağıtım koşusunu değil, CI koşusunu — bu ayrım bu hafta main'i dört koşu kırmızı bıraktı)
- [ ] Merge, `v*.*.*` etiketi, dağıtımı izle, canlıda ucu doğrula
