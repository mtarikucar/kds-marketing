# İçerik hattı yüzeyi ve öğrenme döngüsü — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Growth Studio ana ekranını hattın merkezi yap (parti kartları, dallanma) ve açı performansını konsept üretimine geri besle — müdahale edilebilir, keşif slotlu, soğuk başlangıçta dürüst.

**Architecture:** Zincir zaten bağlı (`ContentConcept` → `SocialCampaignItem.contentConceptId` → `SocialPost.campaignItemId` → `SocialPostTarget` → `SocialPostMetric`). Tek şema eklemesi `ContentConcept.selectionReason`. Geri kalanı okuma modeli + REST yüzeyi + hub arayüzü.

**Tech Stack:** NestJS + Prisma (jest), Vite + React + TanStack Query (vitest).

Spec: `docs/superpowers/specs/2026-09-03-icerik-hatti-yuzeyi-ve-ogrenme-dongusu-design.md`

---

## Dosya yapısı

**Backend — yeni:**
- `content-concepts/angle-performance.service.ts` (+ spec) — açı başına etkileşim oranı, eşik, ağırlık
- `content-concepts/content-line.service.ts` (+ spec) — parti özetleri (durum sayıları + erişim)
- `controllers/marketing-content-line.controller.ts` — konsept/parti REST yüzeyi
- `test/e2e/content-line.realdb.e2e-spec.ts`

**Backend — değişen:**
- `prisma/schema.prisma` + migration — `ContentConcept.selectionReason String?`
- `content-concepts/content-concepts.service.ts` — ağırlık girdisi, keşif slotu, prompt'a performans
- `marketing.module.ts` — yeni servis/denetleyici kaydı

**Frontend — yeni:**
- `features/marketing/api/contentLine.service.ts`
- `pages/marketing/studio/BatchCard.tsx` (+ test)
- `pages/marketing/studio/LearnedPanel.tsx` (+ test)
- `pages/marketing/studio/IdeaComposer.tsx` (+ test)

**Frontend — değişen:**
- `pages/marketing/studio/GrowthStudioPage.tsx` — hub düzeni; `?view=tools` dokunulmaz

---

### Task 1: Açı performansı okuma modeli

**Files:** Create `angle-performance.service.ts` + `.spec.ts`

- [ ] **Step 1: Testi önce yaz.** Dört davranış:
  - (a) sıralama `engagements/impressions` ile; erişimi yüksek ama oranı düşük açı, oranı yüksek olanın ALTINDA kalır
  - (b) 3 yayınlanmış gönderiden az taşıyan açı sıralanmaz, `insufficient: true` döner
  - (c) hiç yayınlanmış gönderi yoksa `cold: true`, liste boş
  - (d) `impressions = 0` olan hedef oranı NaN yapmaz
- [ ] **Step 2:** Koş, FAIL gör.
- [ ] **Step 3: Uygula.** Join: concept → item (`contentConceptId`) → post (`campaignItemId`) → target → metric. `workspaceId` her seviyede.
- [ ] **Step 4:** PASS + `npx tsc --noEmit -p tsconfig.json`.
- [ ] **Step 5: Mutasyon** — eşiği kaldır, (b)'nin düştüğünü gör. Raporla, geri al.
- [ ] **Step 6:** Commit.

---

### Task 2: Gerçek-DB e2e — açı performansı

**Files:** Create `test/e2e/content-line.realdb.e2e-spec.ts`

Birim testleri Prisma'yı mock'lar ve mock her `where`'i kabul eder. Beş seviyeli bir join mock'la doğrulanamaz.

- [ ] **Step 1:** `home-timeline.realdb.e2e-spec.ts` desenini oku.
- [ ] **Step 2:** İki workspace tohumla; her birinde konsept→öğe→gönderi→hedef→metrik zinciri kurulu açılar.
- [ ] **Step 3:** Üç iddia: sıralama doğru; yabancı workspace'in metriği hiç sızmaz; eşik altı açı sıralanmaz.
- [ ] **Step 4:** `docker start kds-marketing-postgres && E2E_REAL_DB=1 npx jest --config test/jest-e2e.json content-line --runInBand`
- [ ] **Step 5: Kasten kır** — join'den `workspaceId`'yi çıkar, kiracı iddiasının düştüğünü gör. Raporla, geri al.
- [ ] **Step 6:** Temizlik doğrula, commit.

---

### Task 3: Şema — `selectionReason`

- [ ] **Step 1:** `ContentConcept`'e `selectionReason String?`. Yorumu farkı yazsın: `rationale` konseptin değeri, `selectionReason` bu açının neden seçildiği (ölçülen performans mı, keşif slotu mu, elle ağırlık mı).
- [ ] **Step 2:** `npx prisma migrate dev --name content_concept_selection_reason`
- [ ] **Step 3: CI parite kapısı** — `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <throwaway> --exit-code` sıfır dönmeli.
- [ ] **Step 4:** Commit.

---

### Task 4: Üretimi yönlendir — ağırlık, keşif, soğuk başlangıç

**Files:** Modify `content-concepts.service.ts` + spec

- [ ] **Step 1: Test önce.** Dört davranış:
  - (a) performans varsa prompt'a giriyor
  - (b) her partide EN AZ BİR keşif slotu ayrılıyor, `selectionReason` ile işaretli
  - (c) çağıran `angleWeights` verirse ölçülen ağırlığın YERİNE geçiyor
  - (d) soğuk başlangıçta tarafsız üretiliyor ve sonuç `cold: true` taşıyor — sessizce rastgele değil
- [ ] **Step 2:** FAIL gör.
- [ ] **Step 3:** Uygula. `PlanConceptsInput`'a `angleWeights?: Record<string, number>`; `systemPrompt`/`userPrompt`'a performans özeti; her konsepte `selectionReason`.
- [ ] **Step 4:** PASS + tsc.
- [ ] **Step 5: Mutasyon** — keşif slotunu kaldır, (b)'nin düştüğünü gör. Slot sessizce kaybolursa sistem tek açıya çöker ve kimse fark etmez.
- [ ] **Step 6:** Commit.

---

### Task 5: Parti özetleri (hub verisi)

**Files:** Create `content-line.service.ts` + spec

- [ ] **Step 1: Test önce.**
  - (a) parti başına durum sayıları doğru (onay bekleyen / üretimde / planlı / yayında)
  - (b) yayına çıkmış partide erişim toplanıyor, çıkmamışta `null` — sıfır DEĞİL. Sıfır "ölçüldü ve sıfır", null "henüz ölçülmedi"
  - (c) yeni parti üstte
- [ ] **Step 2:** FAIL gör. **Step 3:** Uygula. **Step 4:** PASS + tsc.
- [ ] **Step 5: Mutasyon** — null/0 ayrımını boz, (b)'nin düştüğünü gör.
- [ ] **Step 6:** Commit.

---

### Task 6: REST yüzeyi

**Files:** Create `marketing-content-line.controller.ts`; modify `marketing.module.ts`

Konseptler bugün yalnızca MCP'den erişilebilir; hub REST'e ihtiyaç duyuyor.

- [ ] **Step 1:** Uçlar: `GET /marketing/content-line/batches`, `GET /marketing/content-line/batches/:batchId`, `POST /marketing/content-line/plan`, `GET /marketing/content-line/angles`
- [ ] **Step 2:** Yetki: `content-concepts.tools.ts`'in kullandığı izinle AYNI olmalı — yeni izin icat etme.
- [ ] **Step 3:** `@Audit` — plan üretimi kredi harcıyor, denetime düşmeli.
- [ ] **Step 4:** tsc + commit.

---

### Task 7: Gerçek-DB e2e — parti özetleri ve kiracı izolasyonu

- [ ] **Step 1:** Task 2'nin dosyasına ekle: parti özeti ucu tohumlanmış veriye karşı; yabancı workspace'in partisi dönmemeli.
- [ ] **Step 2:** Koş, yeşil gör. **Step 3: Kasten kır**, düştüğünü gör, geri al. **Step 4:** Commit.

---

### Task 8: Ön yüz istemcisi

- [ ] **Step 1:** Dört uç için istemci + tipler; mevcut servislerin desenini izle.
- [ ] **Step 2:** tsc + commit.

---

### Task 9: Hub — fikir girişi, öğrenilenler, parti kartları

**Files:** Create `IdeaComposer.tsx`, `LearnedPanel.tsx`, `BatchCard.tsx` (+ testler); modify `GrowthStudioPage.tsx`

- [ ] **Step 1: Test önce, her bileşen için üç hâl:** veri var / veri yok / hata — boş ile hata AYRI görünür.
- [ ] **Step 2:** `LearnedPanel`: açılar oranlarıyla; eşik altı "yeterli veri yok"; soğuk başlangıç "henüz veri yok, tarafsız üretiliyor".
- [ ] **Step 3:** `BatchCard`: kaynak fikir, konsept sayısı, durum sayıları, erişim. Dallanma mevcut sayfalara gider; detay burada YENİDEN YAZILMAZ.
- [ ] **Step 4:** `IdeaComposer`: fikir girişi + ağırlık müdahalesi (görünür ve değiştirilebilir).
- [ ] **Step 5:** `GrowthStudioPage`'e yerleştir. `?view=tools` davranışı DEĞİŞMEZ — testle sabitle.
- [ ] **Step 6: Mutasyon** — bir panelin hata dalını sil, testin düştüğünü gör.
- [ ] **Step 7:** `npx vitest run` + `npx tsc --noEmit` + commit.

---

### Task 10: Bağımsız hata sınırları

- [ ] **Step 1: Test önce** — açı performansı 500 dönerken parti kartları YİNE gelir, ve okunamayan bölüm adıyla söyler.
- [ ] **Step 2:** `QueryStateBoundary` (düz children API'si: `isLoading`/`isError`/`onRetry`) ile uygula.
- [ ] **Step 3: Mutasyon** — sınırı kaldır, testin düştüğünü gör. **Step 4:** Commit.

---

## Bitiş doğrulaması

- [ ] `cd backend && npx jest` ve `E2E_REAL_DB=1 npx jest --config test/jest-e2e.json realdb --runInBand`
- [ ] `cd frontend && npx vitest run && npx tsc --noEmit`
- [ ] **Frozen yol kümesi bozulmadı** — yeni rota yok, `navigation.test.ts` yeşil
- [ ] **Prisma parite kapısı** sıfır dönüyor
- [ ] PR aç, **CI'ın altı işinin de yeşil olduğunu gör** (dağıtım koşusunu değil)
- [ ] Merge, `v*.*.*` etiketi, `headBranch == "<tag>"` ile dağıtımı doğrula, canlıda ucu doğrula
