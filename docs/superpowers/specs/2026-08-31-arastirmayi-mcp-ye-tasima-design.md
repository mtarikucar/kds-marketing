# Gece araştırmasını MCP'ye taşımak

Tarih: 2026-08-31
Durum: tasarım — sahibin talimatı: *"MCP'de çalışabiliyorsa MCP'de çalışsın"*

## Sorun

Anthropic faturası, son 30 gün, canlı ölçüm (`jeeta.get_ai_usage`):

| İş | Model | Maliyet | Pay |
|---|---|---|---|
| `research.turn` | Opus | 4,12 $ | %45 |
| `research.turn` | Sonnet | 2,31 $ | %25 |
| `strategy.turn` | Opus | 1,16 $ | %13 |
| `research.native_search` | Haiku | 1,06 $ | %12 |
| `research.native_scrape` | Haiku | 0,31 $ | %3 |
| `content.compose` | Opus | 0,15 $ | %2 |
| **Toplam** | | **9,11 $** | 251 çağrı |

**Araştırma tek başına %86 (7,80 $).** Ve bu tek bir workspace için — SaaS
olarak her müşteri kendi gece araştırmasını koşturduğunda maliyet müşteri
sayısıyla doğrusal büyür ve tamamı platformda kalır.

Platform tek bir `ANTHROPIC_API_KEY` kullanıyor (`anthropic.service.ts:100`);
workspace başına anahtar altyapısı yok.

## Anahtar keşif: cron zaten taşınmaya hazır

`research-runner.service.ts:72` — `@Cron(EVERY_DAY_AT_3AM)` **para harcamıyor.**
Yaptığı tek şey iş üretip kuyruğa yazmak (`scheduledJob.schedule({ kind:
RESEARCH_RUN_KIND })`). Parayı **kuyruğu boşaltan işçi** harcıyor:
`research-worker.service.ts:58 runProfile()` bir Anthropic araç-döngüsü koşuyor.

Yani soru "cron'u nasıl taşırız" değil, **"kuyruğu kim boşaltır"**.

## Karar

Kuyruğu, sahibin kendi Claude'u boşaltsın. Cron olduğu yerde kalır.

```
BUGÜN                          SONRA
03:00 cron → kuyruk            03:00 cron → kuyruk       (aynı, bedava)
   ↓                              ↓
sunucu işçisi                  sahibin zamanlanmış görevi
   ↓ Anthropic (Jeeta öder)       ↓ claim_research_job
sonuç DB'ye                       ↓ düşünme + arama (SAHİP öder)
                                  ↓ submit_research_candidates
                               sonuç DB'ye
```

### Üç yeni MCP aracı

- **`claim_research_job`** — sıradaki işi kiralar ve **talimatın tamamını** verir
  (profil brief'i, geo, dil, hariç tutulanlar, çıktı sözleşmesi). Talimat
  sunucuda kalır: kalite sahibin o geceki cümlesine bağlı olmamalı.
- **`submit_research_candidates`** — mevcut `submit_candidates` aracının MCP
  karşılığı. Adayları **staging**'e yazar, lead'e değil.
- **`complete_research_job`** — işi kapatır (başarı/başarısızlık + sebep).

### Kiralama (lease), çünkü iki boşaltıcı olabilir

İş `PENDING → CLAIMED(sahibi, sonAt) → DONE|FAILED` yürür. Kiralama **atomik**
alınır (`updateMany` + `WHERE status=PENDING`), yoksa iki istemci aynı işi
koşar ve fatura iki kez yazılır. Süresi dolan kiralama `PENDING`'e döner —
çöken bir istemci işi sonsuza kadar rehin alamaz.

### Workspace başına mod, genel anahtar değil

`researchExecution: 'SERVER' | 'MCP'`. `MCP` iken sunucu işçisi o workspace'in
işine **dokunmaz**, kuyrukta bırakır. `SERVER` bugünkü davranış.

Bu bir mod olmak zorunda: yalnızca MCP bağlayıp kendi tarafında zamanlama kuran
müşteri için çalışır. Diğerlerinde ya sunucu koşar ya da araştırma kapalıdır.

## Ne kurtarır, ne kurtarmaz

**Kurtarır:** araştırmanın Anthropic payının tamamı — akıl yürütme (6,43 $) ve
yerel web araması (1,37 $). Sahibin Claude'u kendi aramasını yaptığı için
`native_search`/`native_scrape` de sıfırlanır. Aylık **7,80 $ / workspace**.

**Kurtarmaz:** `search_places` ve `lookup_instagram` **Apify**'a gidiyor
(`compass~crawler-google-places`, `apify~instagram-scraper`), `scrape_page` önce
**Firecrawl**'a. Bunlar Jeeta'nın kendi anahtarları — çağıran kim olursa olsun
fatura Jeeta'da kalır ve bu 9,11 $'ın içinde bile değiller. Google Maps
yorumları "acı sinyali"nin birincil kaynağı olduğu için Claude'un genel web
aramasıyla ikame edilemez; bu yüzden ikisi de MCP aracı olarak açılır ve
maliyetleri değişmez.

## Bedel: otonomi

Bu tasarım sahibin tarafında koşan bir zamanlanmış göreve bağlı. Kimse
boşaltmazsa işler birikir. **Panel bunu adıyla söyler** — "aday yok" değil,
"N iş senin Claude'unu bekliyor, en eskisi 3 gündür". Bu deponun tekrar eden
hatası tam olarak buydu (`.catch(() => 0)`, v2.271.0).

Bekleyen iş sayısı ve en eskisinin yaşı ana ekranın akışında görünür.

## Açık kalan sahip kararı

Bu workspace'in MCP yazma modu **APPROVAL**. `submit_research_candidates` bir
WRITE, yani her gece onaya düşer ve sahip onaylayana kadar hiçbir aday
kaydedilmez — otonom bir gece işi için bu modun o araçta gevşetilmesi gerekir.

Lehine argüman: aday **lead değil**. `accept_research_candidates` zaten insan
kapısı ve ürünün kendi tasarımı incelemeyi oraya koymuş. Yani staging yazımı
geri alınabilir ve zaten gözden geçiriliyor.

**Bu spec o modu değiştirmiyor.** Karar sahibin; değiştirilene kadar MCP modu
kurulur ama adaylar onay kuyruğunda bekler ve panel bunu söyler.

## Test

- **Birim:** kiralamanın atomikliği (iki eşzamanlı `claim` → biri boş döner);
  süresi dolan kiralamanın `PENDING`'e dönmesi; `MCP` modunda sunucu işçisinin
  işe dokunmaması
- **Gerçek-DB e2e:** kiracı izolasyonu — bir workspace'in MCP anahtarı başka
  workspace'in işini **hiç** kiralayamamalı; her `workspaceId` yüklemi kendi
  iddiasını düşürmeli
- **Dürüstlük:** boşaltılmayan kuyruk panelde adıyla görünür; sessiz kalmaz
- Her davranış mutasyonla doğrulanır

## Kapsam dışı

- `strategy.turn` (%13) ve `content.compose` (%2) — ikisi de kullanıcı
  eyleminden tetikleniyor, gece koşmuyor. Mekanizma sonradan onları da alabilir.
- BYOK (workspace başına Anthropic anahtarı) — ayrı bir yol; bu spec onu
  varsaymıyor.
- Apify/Firecrawl fiyatlandırması.
