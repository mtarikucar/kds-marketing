# İçerik Programı: türlere göre üreten, ölçen ve ağırlığı tutanlara kaydıran otonom döngü

Tarih: 2026-09-08
Durum: sahip tasarımı onayladı ("sana güveniyorum … devam et"); üç açık karar sahibin
devriyle burada kapatıldı.

## Sahibin istediği

Belirli TİPLERDE içerik olsun; önce içerik tipe göre sınıflansın, hesapta paylaşılsın,
bir süre beklenip trendler takip edilsin, yeterince beklendikten sonra TUTAN tiplerin
ağırlığı artırılsın ki her zaman tutan içerik üretilsin. Her adım DÜZENLENEBİLİR olsun
ama ONAY kapısı olmasın; ölçeklenebilir olsun. Her şey Studio'nun TEK ekranından,
kompakt bir panelden yönetilsin; metriklerin ayrıntısı arayüzde görünsün.

## Kapatılan kararlar (sahip devretti)

| # | Karar | Seçim |
|---|---|---|
| K1 | Tür listesi | Kod sabiti `DEFAULT_CONTENT_TYPES` (10 tür), program açılırken çalışma alanına kopyalanır; sonrası düzenlenebilir (ad, yapı, süre, ağlar, taban/tavan, aktif). |
| K2 | "Tutan" | Program başına `goal` (ENGAGEMENT / VIEWS / SAVES_SHARES / LEADS / COMPOSITE). Varsayılan COMPOSITE = 0.5·etkileşim oranı + 0.3·kaydet-paylaş oranı + 0.2·izlenme; her biri hesabın kendi taban çizgisine göre normalize. |
| K3 | Otonomi | İlk günden tam otonom: onay yok. Kill switch + duraklat her an. Slot'a 2 saat kalana kadar düzenleme penceresi. Konsept T-36s'de planlanır ve storyboard'u çizilir (24 saat kare/hareket düzenleme fırsatı), T-12s'de üretilir, T-2s'de donar. |

## Var olanın üstüne (inşa değil bağlama)

Konsept hattı (fikir → konsept → storyboard → klip), FULL_AUTO kampanya + `confirmItem`
kapıları (brand-safety, günlük limit), `SocialPostMetric` toplama, `AnglePerformance`,
kredi/cüzdan, `ScheduledJob` koşucusu. Eksik: tür boyutu, onaysız konsept hattı,
ileriye dönük planlama + düzenleme penceresi, gerçek öğrenme motoru, trend sinyali, ve
tek ekranda program paneli.

## Veri modeli (tek geri alınabilir migrasyon: `migration.sql` + `down.sql`)

```prisma
model ContentType {                       // content_types
  id, workspaceId, key (slug), name, description
  structure Json        // [{ role, durationSec, guidance }]  — beat şablonu
  defaultDurationSec Int
  networks String[]     // INSTAGRAM | TIKTOK | FACEBOOK | LINKEDIN | TWITTER | YOUTUBE
  minShare Float @default(0.05)  maxShare Float @default(0.4)
  active Boolean @default(true)  isSeed Boolean @default(true)  ordinal Int
  @@unique([workspaceId, key])
}
model ContentProgramme {                  // content_programmes
  id, workspaceId, name, status String  // ACTIVE | PAUSED | KILLED
  socialCampaignId String   // programın yayınladığı FULL_AUTO kampanya (1:1)
  goal String @default("COMPOSITE")
  brief String              // programın konusu / ürün / ton
  personaId String?
  perWeek Int @default(5)   // hesap başına haftalık gönderi
  weeklyCreditCap Int @default(600)
  explorationRate Float @default(0.15)
  maturityHours Int @default(72)
  halfLifeDays Int @default(30)
  editWindowHours Int @default(2)
  lookaheadDays Int @default(14)
  planLeadHours Int @default(36)     // konsept + storyboard bu kadar önce
  produceLeadHours Int @default(12)  // klipler bu kadar önce
  seedWeeks Int @default(2)
  phase String @default("SEED")      // SEED | LEARN | EXPLOIT (learn işi yazar)
  killSwitch Boolean @default(false)
  lastPlannedAt, lastMeasuredAt, lastReweightedAt DateTime?
  createdById
  @@unique([socialCampaignId])  @@index([workspaceId, status])
}
model ContentSlot {                       // content_slots
  id, workspaceId, programmeId, scheduledFor DateTime
  status String  // PLANNED | IDEATED | PRODUCING | READY | PUBLISHED | MEASURED | SKIPPED | FAILED
  contentTypeId, contentTypeKey String
  selectionReason String        // "thompson 0.61 vs 0.44 …", "seed round-robin", "exploration", "owner override"
  trendSignalId String?  trendTitle String?
  idea String                   // planlayıcıya giden fikir metni (düzenlenebilir)
  conceptId, campaignItemId, socialPostId String?
  quotedCredits Int?
  editableUntil DateTime
  publishedAt, measuredAt DateTime?
  reward Float?  rewardBreakdown Json?   // { network: { impressions, reach, engagements, saves, shares, videoViews, leads, rate, baseline, r } }
  error String?
  @@unique([programmeId, scheduledFor])  @@index([workspaceId, programmeId, status])
}
model ContentTypeStat {                   // content_type_stats — her yeniden ağırlıklandırmada bir satır (tarih)
  id, workspaceId, programmeId, contentTypeId, contentTypeKey, network String
  samples Int, alpha Float, beta Float, meanReward Float, weight Float
  computedAt DateTime
  @@index([programmeId, computedAt])
}
model TrendSignal {                       // trend_signals — bölge bazlı, çalışma alanından bağımsız
  id, region String @default("TR"), network String, kind String  // TOPIC | HASHTAG | SOUND | FORMAT
  title, ref String?, score Float, source String, observedAt DateTime, halfLifeHours Int
  raw Json?
  @@unique([region, network, kind, title])  @@index([region, observedAt])
}
model ContentProgrammeEvent {             // content_programme_events — "neden" günlüğü
  id, workspaceId, programmeId, kind String, message String, data Json?, createdAt
  @@index([programmeId, createdAt])
}
// Ek sütunlar
SocialCampaign.programmeId String?       // planTick bu set ise HİÇ üretmez; programı planlar
ContentConcept.contentTypeKey String?  ContentConcept.programmeId String?  ContentConcept.slotId String?
```

## Motor (algoritmalar; hepsi saf, tohumlanabilir, birim testli)

**Tür seçimi (`type-selector.util.ts`).** Girdi: aktif türler (taban/tavan), tür başına
posterior (alpha, beta; ağlar hesap sayısıyla ağırlıklı birleşik), pencere içindeki slot
sayıları, önceki slotun türü, keşif oranı, evre, RNG. SEED: aktif türler üzerinde
round-robin. LEARN/EXPLOIT: keşif oranı olasılığıyla en az örneklenmiş türlerden düzgün
seçim; aksi hâlde Thompson: her tür için Beta(alpha, beta)'dan örnek çek, en büyüğü
seç. Kısıtlar: pencere payı tavanı aşan tür seçilmez, tabanı dolmamış tür önce
doldurulur, önceki slotla aynı tür seçilmez (tek aktif tür hariç). Neden metni döner.

**Ödül (`reward.util.ts`).** Girdi: hedef, ağ, hedefteki en son metrik anlık görüntüsü,
hesap taban çizgisi (o hesabın son 30 gönderisinin medyan oranları; yoksa ağ
varsayılanı). Ağ başına oran: etkileşim = engagements/impressions (TikTok:
(likes+comments+shares)/videoViews), kaydet-paylaş = (saves+shares)/impressions,
izlenme = videoViews (yoksa impressions) / taban. r = clip(x / (2·taban), 0, 1) ⇒ taban
= 0.5. COMPOSITE ağırlıklı toplam. Parçalar `rewardBreakdown`'a yazılır.

**Posterior (`posterior.util.ts`).** Beta(alpha, beta), başlangıç (1, 1). Gözlem: alpha
+= r, beta += 1−r. Yeniden ağırlıklandırmada aşınma: alpha' = 1 + (alpha−1)·0.5^(Δgün/
yarıÖmür), beta aynı. Ağırlık = posterior ortalaması, taban/tavan ile kırpılıp
normalize. Evre: SEED → LEARN seedWeeks dolunca veya her aktif türde ≥ 3 ölçülmüş
slot; LEARN → EXPLOIT en iyi türün posterior ortalaması ikinci türün üst %80
güven sınırının üstündeyse; EXPLOIT'te keşif oranı korunur (asla sıfır değil).

**Trend skoru (`trend-score.util.ts`).** decayed = score · 0.5^(saat/halfLifeHours);
marka uygunluğu = marka anahtar kelimeleri (BrandProfile adı, ürünler, anahtar kelimeler,
program brief'i) ile başlık kelimelerinin Jaccard'ı (gömme yok, anahtarsız). Öneri
skoru = decayed · (0.3 + 0.7·uygunluk).

## İşler (`ScheduledJob` koşucusu; kind adları)

| Kind | Sıklık | Ne yapar |
|---|---|---|
| `content.programme.plan` | her 6 saat (dedup program başına) | Kadans (perWeek + kampanya cadence.daysOfWeek/timeOfDay) ile `lookaheadDays` içindeki boş slotları `ContentSlot(PLANNED)` olarak açar; tür seçici + trend kancasıyla `idea` metnini kurar. |
| `content.slot.plan` | slot başına, scheduledFor − planLeadHours | Haftalık kredi tavanı kontrolü; `planConcepts` (count 3, `programme` rehberliği: tür yapısı, süre, trend kancası, brief) → ilk uygun konsept (son 20 slot hook'una Jaccard < 0.5) seçilir, diğerleri DISCARDED; konsept PROPOSED kalır (kare/hareket düzenlenebilir), storyboard istenir → slot IDEATED. |
| `content.slot.produce` | scheduledFor − produceLeadHours | `decideByProgramme` (APPROVED, reviewedById = `programme:<id>`), `promote({ socialCampaignId, scheduledFor })`, `produce` → öğe SCHEDULED (FULL_AUTO) → slot READY. |
| `content.programme.learn` | her 6 saat | PUBLISHED + olgunlaşmış slotları ölçer (MEASURED); haftada bir (lastReweightedAt) posterior/ağırlık/evre günceller, `ContentTypeStat` yazar, olay günlüğüne "neden" satırı. |
| `trend.refresh` | her 12 saat (global) | Sağlayıcılar: Google Trends günlük RSS (`trends.google.com/trending/rss?geo=TR`, anahtarsız), Apify TikTok trend aktörü (`APIFY_TOKEN` + `TREND_TIKTOK_ACTOR`), YouTube mostPopular (`YOUTUBE_API_KEY`). Her biri env ile açılır; kapalıysa sessizce atlanır. |

Anomali: art arda 3 slot FAILED veya haftalık harcama tavanın %120'si ⇒ program PAUSED +
olay. Kill switch: plan/produce/learn hiçbir şey yapmaz; kampanya PAUSE.

## Koruyucular ve para

Kredi: slot planlanırken teklif (`production.credits`) slot'a yazılır; hafta içi toplam +
teklif > `weeklyCreditCap` ise slot beklemeye alınır (SKIPPED değil, ertelenir; olay).
Üretim mevcut `MediaGenService` yolundan, `campaignItemId` ile (motor cüzdanı). Yayın
mevcut `confirmItem` kapılarından (kampanya ACTIVE, medya READY, günlük limit,
brand-safety). Günlük limit program kampanyasında hesap başına `perWeek/7` üstü.

## API

REST (`/marketing/content-programme`, MANAGER + `campaigns.write`, okuma `reports.read`):
`GET` (program + gösterge: evre, tür ağırlıkları, yaklaşan slotlar, hafta harcaması,
son olaylar), `POST` (kur + aktive: name, brief, accountIds, perWeek, goal,
weeklyCreditCap, personaId?), `PATCH` (ayarlar), `POST /pause|resume|kill`,
`GET|POST|PATCH /types`, `GET /slots?from&to`, `PATCH /slots/:id` (type, idea, scheduledFor
— pencere içinde), `POST /slots/:id/skip`, `POST /slots/:id/regenerate`,
`GET /learning` (tür×ağ posterior tablosu + ağırlık geçmişi), `GET /trends`,
`GET /slots/:id/metrics`.

MCP (3 yeni, deferred): `jeeta.get_content_programme` (READ), `jeeta.update_content_programme`
(WRITE: ayarlar, pause/resume), `jeeta.edit_content_slot` (WRITE). Katalog pini 129 → 132;
connector belgesine satırlar.

## Tek ekran (Studio)

`StudioOneScreen` üst şeridinin altına **`ProgrammePanel`** (tam genişlik, kompakt):
tek satırda durum/evre rozeti, Duraklat/Kill anahtarları, hafta harcaması/tavan
çubuğu, 14 günlük slot çipleri (tür rengi, durum ikonu; tık → satır içi slot
düzenleyici: tür, fikir, saat, atla, yeniden üret, konsept storyboard'una geçiş),
"Ayrıntı" düğmesi. Ayrıntı açılınca panel sekmeleri: **Slotlar** (liste + slot
metrikleri), **Türler** (pay hedefi / öğrenilen ağırlık / taban-tavan / aktif; satır
içi düzenleme), **Öğrenme** (tür×ağ tablosu: örnek, ortalama ödül, ağırlık; ağırlık
geçmişi mini-grafik SVG), **Trendler** (skor + uygunluk), **Günlük**. Program yoksa
şerit "Programı başlat" → kurulum diyaloğu. Yeni rota yok; yeni menü öğesi yok.

## Test

Saf motorlar: tohumlu RNG ile deterministik; taban/tavan/no-repeat/keşif/evre geçişleri
mutasyonla doğrulanır. Servisler: mock Prisma. Gerçek-DB e2e: migrasyon round-trip
(up→down→up), program kurulumu → plan → slot → (sahte medya) üretim → ölçüm → yeniden
ağırlıklandırma zinciri gerçek Postgres'te — `backend/test/e2e/content-programme.realdb.e2e-spec.ts`
(`E2E_REAL_DB=1` ile açılır). Frontend: panel/sekme/düzenleyici testleri,
i18n parity/usedKeys/studioSurfaceKeys. Kiracı izolasyonu: yabancı çalışma alanının
programı/slotu/türü okunmaz.

## Kapsam dışı

Instagram/TikTok içgörü izinleri (app-review) — dış bağımlılık; izin gelene kadar
ölçüm yalnızca izinli ağlardan. Gömme tabanlı marka uygunluğu (anahtar kelime ile
başlanır). Kampanya dışı gönderilerin türe sınıflanması (ileride LLM sınıflayıcı).
