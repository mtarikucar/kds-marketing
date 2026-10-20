# Ticaret ingest sözleşmeleri: sipariş webhook'u, ExternalOrder, GA4, site parçacığı, get_weekly_report

Tarih: 2026-10-21 · Yazan: Kerem (Teknik Lider) · Okuyan: Arda (geliştirici), Koordinatör
Taban: `origin/main` @ `a08d21a9` (tüm `dosya:satır` referansları bu commit'e göredir)
Üst belge: `docs/superpowers/specs/2026-10-19-figurunica-on-jeeta-design.md` (taslak; bu belge onu
**bağlayıcı sözleşmeye** çevirir ve aşağıda "Taslaktan sapmalar" başlığında nerede ayrıldığını söyler).

Kural (sahibin talimatı): her parça çalışma alanı bazlı, self-servis, belgeli **standart Jeeta özelliği**dir.
Figurunica bu sözleşmenin ilk *istemcisi*dir; Jeeta kodunda `figurunica` adı geçmez (yalnız örneklerde).

Kısaltmalar: `B` = `backend/src/modules/marketing`, `S` = `backend/prisma/schema.prisma`,
`P` = printer reposu (`mtarikucar/printer`, `origin/main` @ `fd3dee7`).

---

## 0. Kod tabanından çıkan gerçekler (taslaktan sapmaların nedeni)

| Taslak varsayımı | Koddaki gerçek | Bu sözleşmedeki karar |
|---|---|---|
| `x-ingest-token` ile HMAC imzalanır | `IngestToken` yalnız sha256 hash saklar (`B/guards/ingest-token.guard.ts:14-16`, `S:1464-1478`); ham token sunucuda yok → HMAC anahtarı olamaz | Kimlik `x-ingest-token`, imza **ayrı, mühürlü (sealSecret) kaynak sırrı** ile: yeni `CommerceSource` modeli |
| `generic-hmac.ts` zaman damgalı, yeniden kullanılır | `generic-hmac.ts:22-34` yalnız ham gövdeyi, platform-geneli `ESP_FEEDBACK_SECRET` ile imzalar; `t=` yok sayılır | Yeni `commerce-signature.ts`; `constantTimeEquals`, `header`, `timestampFresh` mantığı (`B/channels/inbound/webhook-verifier/index.ts:114-138`) ve `WebhookReplayStore` yeniden kullanılır |
| `page-view-stats` site trafiğini tutar | `PageViewStat` (`S:5593`) uygulama içi ekran açılışı; JWT'li, aylık, route bazlı (`B/analytics/page-view-stats.controller.ts:46-56`) | Site trafiği için yeni `SiteTrafficDaily`; yalnız `PageViewStatsService.normalise` (`B/analytics/page-view-stats.service.ts:39`) yeniden kullanılır |
| GA4 için "YouTube'da kullanılan Google OAuth" | YouTube OAuth yok; Google OAuth örnekleri: Calendar (`B/integrations/google-calendar.service.ts`), GMB (`B/social-planner/oauth/social-oauth.config.ts:142-149`), Ads | GA4 bağlantısı Google Calendar akışının kalıbıyla, kendi `Ga4Connection` modeli |
| Snippet `https://jeetagrowth.com/s/{publicKey}.js` | Var olan gömme kalıbı statik `frontend/public/widget.js` + `data-widget-key`; API CORS'u kesin allowlist (`backend/src/app.config.ts:119-150`) | `frontend/public/jeeta.js` + `data-site-key`; trafik **GET piksel** ile (CORS'a takılmaz, ön uçuş yok) |
| Sipariş tutarı `total` (ondalık) | Jeeta `Invoice.total` ve printer `orders.amountKurus` küçük birim tam sayı | Tüm tutarlar **küçük birim tam sayı** (`amountMinor`) |
| Testler "vitest" | Backend **Jest** (`backend/package.json:15`), frontend Vitest, printer `tsx` betikleri | Test komutları buna göre |
| MCP'ye yeni araç eklemek serbest | Reklam edilen araç sayısı **tam tavanda: 46/46** (`B/mcp/tools/tool-catalogue.spec.ts:331`; 21 Eki'de ölçüldü: `ADVERTISED_COUNT 46 TOTAL 163`) | `jeeta.get_weekly_report` reklam edilir, karşılığında `jeeta.get_funnel` ertelenir (§5.4) |

---

## 1. Sipariş webhook'u — şema v1

### 1.1 Uç nokta

```
POST /api/marketing/commerce/ingest/orders
Content-Type: application/json
x-ingest-token:     mkt_live_…                 (var olan çalışma alanı ingest token'ı)
x-jeeta-source:     figurunica                  (CommerceSource.slug, [a-z0-9-]{2,40})
x-jeeta-timestamp:  1792574043                  (unix saniye, gönderim anı)
x-jeeta-signature:  v1=<64 hex>                 (HMAC-SHA256)
```

- Controller: `@Controller('marketing/commerce/ingest')`, `@MarketingRoute()`, `@UseGuards(IngestTokenGuard)` —
  `B/controllers/marketing-leads-ingest.controller.ts:27-29` ile aynı kalıp; çalışma alanı `req.ingestWorkspaceId` (`:40-46`).
- Ham gövde: `backend/src/app.config.ts`'e **`:64`'ten sonra, `:75`'teki JSON ayrıştırıcıdan önce** eklenir:
  `app.use('/api/marketing/commerce/ingest', bodyParser.raw({ type: '*/*', limit: '256kb' }));`
  Controller gövdeyi `Buffer` olarak okur (`B/controllers/esp-feedback.controller.ts:66` kalıbı), imza doğrulandıktan
  **sonra** `JSON.parse` + `class-validator` (`plainToInstance` + `validateOrReject`) uygular. Global
  `ValidationPipe`'ın `forbidNonWhitelisted` kuralı burada da elle uygulanır: bilinmeyen alan → 400.
- Hız sınırı: `@Throttle({ default: { limit: 120, ttl: 60_000 } })` (anahtar `default` olmak zorunda;
  `marketing-leads-ingest.controller.ts:30-34` açıklaması).
- Bayrak kapalıysa (`COMMERCE_INGEST_ENABLED`, §9) → **404** (uç nokta yokmuş gibi).

### 1.2 İmza

```
signedPayload = `${x-jeeta-timestamp}.${rawBody}`          // rawBody: gönderilen baytların AYNISI
signature     = hex( HMAC_SHA256(key = CommerceSource sırrı (whsec_…), signedPayload) )
header        = "v1=" + signature
```

- Tazelik: `|now − ts| ≤ 300 s` (5 dk). `timestampFresh` 24 saatlik (`index.ts:107, :133-138`) — sipariş için
  fazla geniş; `commerce-signature.ts` kendi `COMMERCE_SIGNATURE_MAX_AGE_MS = 300_000` sabitini kullanır,
  `constantTimeEquals` (`index.ts:122-130`) ve `header` (`index.ts:114`) import edilir.
- Sır döndürme sırasında iki sır geçerli olabilir: `CommerceSource.signingSecret` ve `previousSecret`
  (`previousSecretExpiresAt`'e kadar, varsayılan 24 saat). Başlıkta birden çok `v1=` virgülle gelebilir; biri tutarsa geçer.
- Sır biçimi: `whsec_` + 32 bayt hex (var olan `InboundWebhook` önekiyle aynı aile,
  `B/inbound-webhooks/inbound-webhooks.service.ts:13-18`). Sunucuda **`sealSecret`** ile mühürlü saklanır
  (`backend/src/common/crypto/secret-box.helper.ts:46`, açma `:54`) — doğrulamak için açılabilir olmalı, hash yetmez.
  `MARKETING_SECRET_KEY` yoksa kaynak oluşturulamaz (409 `SECRET_BOX_NOT_CONFIGURED`).

**HMAC hesap örneği (doğrulanmış; node `crypto` ve `openssl dgst` aynı sonucu verdi):**

```
secret     = whsec_3f9a1c7e5b2d4f60a8e1c9b7d5f3a1e2
timestamp  = 1792574043            (2026-10-21T09:14:03Z)
rawBody    = §1.4'teki tek satırlık JSON (UTF-8, 818 bayt, sonda satır sonu YOK)
signature  = 7d5da73ac398d5bfa4407e58d27580f3e6a4f2954d1f06f4100f35f532c502a8
header     = x-jeeta-signature: v1=7d5da73ac398d5bfa4407e58d27580f3e6a4f2954d1f06f4100f35f532c502a8
```

Elle doğrulama:
```bash
printf '%s.%s' 1792574043 "$(cat body.json)" | openssl dgst -sha256 -hmac whsec_3f9a1c7e5b2d4f60a8e1c9b7d5f3a1e2
# SHA2-256(stdin)= 7d5da73ac398d5bfa4407e58d27580f3e6a4f2954d1f06f4100f35f532c502a8
```
Bu vektör `commerce-signature.spec.ts`'de ve printer `scripts/test-jeeta-commerce.ts`'de **aynen** test vektörü olur
(iki taraf aynı baytlara aynı imzayı üretmeli).

### 1.3 Olaylar ve alanlar

| Olay | Anlamı | Durum geçişi (`ExternalOrder.status`) |
|---|---|---|
| `order.created` | Sipariş oluştu, ödeme bekleniyor (isteğe bağlı; ödemeyle aynı anda oluşan mağazalar göndermez) | → `PENDING` |
| `order.paid` | Ödeme alındı | → `PAID`, `paidAt = occurredAt` |
| `order.refunded` | Kısmi ya da tam iade; `order.refundedMinor` **kümülatif** toplamdır | `refundedMinor = max(mevcut, gelen)`; tamamı iade → `REFUNDED`, değilse `PAID` kalır |
| `order.cancelled` | Ödenmeden iptal, ya da ödendikten sonra iptal (iade ayrıca `order.refunded` ile gelir) | → `CANCELLED`, `cancelledAt` |

Gövde (TypeScript gösterimi; DTO: `B/commerce-ingest/dto/order-event.dto.ts`):

```ts
interface OrderEventV1 {
  version: 1;                                   // başka değer → 400 UNSUPPORTED_VERSION
  eventId: string;                              // 1..200, kaynak içinde benzersiz; önerilen `${source}:${event}:${externalId}[:${seq}]`
  event: 'order.created' | 'order.paid' | 'order.refunded' | 'order.cancelled';
  occurredAt: string;                           // ISO-8601, UTC; gelecekte en çok 5 dk
  order: {
    externalId: string;                         // 1..120, mağazanın sipariş no'su (FIG-XXXXXXXX)
    groupRef?: string | null;                   // sepet/ana sipariş referansı (printer `parentReference`)
    createdAt?: string;                         // ISO-8601
    currency: string;                           // ISO-4217, 3 büyük harf
    amountMinor: number;                        // tam sayı ≥ 0, müşterinin ödediği net tutar (küçük birim)
    refundedMinor?: number;                     // tam sayı ≥ 0, ≤ amountMinor, kümülatif; varsayılan 0
    paymentMethod?: string;                     // serbest, ≤ 40 (card | bank_transfer | gift_card_full …)
    items?: Array<{ sku?: string; name: string; qty: number; unitMinor: number }>;  // ≤ 100 kalem
  };
  customer?: { email?: string; phone?: string /* E.164 */; name?: string };       // yoksa anonim sipariş
  attribution?: {
    utmSource?: string | null; utmMedium?: string | null; utmCampaign?: string | null;
    utmContent?: string | null; utmTerm?: string | null;
    fbclid?: string | null; gclid?: string | null; ttclid?: string | null;
    landingUrl?: string | null; referrer?: string | null;                          // her alan ≤ 512
  };
}
```

Taslaktaki `external.source` gövdeden kaldırıldı: kaynak `x-jeeta-source` başlığıdır (imza doğrulamadan önce
sırrı bulmak için gerekir).

### 1.4 Örnek istek / yanıt

```bash
curl -sS -X POST https://jeetagrowth.com/api/marketing/commerce/ingest/orders \
  -H 'Content-Type: application/json' \
  -H 'x-ingest-token: mkt_live_<token>' \
  -H 'x-jeeta-source: figurunica' \
  -H 'x-jeeta-timestamp: 1792574043' \
  -H 'x-jeeta-signature: v1=7d5da73ac398d5bfa4407e58d27580f3e6a4f2954d1f06f4100f35f532c502a8' \
  --data-binary @body.json
```

`body.json` (tek satır, satır sonu yok):
```json
{"version":1,"eventId":"figurunica:order.paid:FIG-7K2M9QXA","event":"order.paid","occurredAt":"2026-10-21T09:14:03.000Z","order":{"externalId":"FIG-7K2M9QXA","groupRef":null,"createdAt":"2026-10-21T09:02:11.000Z","currency":"TRY","amountMinor":349900,"refundedMinor":0,"paymentMethod":"card","items":[{"sku":"custom-figure-15cm","name":"Kişiye özel figür 15 cm","qty":1,"unitMinor":349900}]},"customer":{"email":"ayse@example.com","phone":"+905321234567","name":"Ayşe Yılmaz"},"attribution":{"utmSource":"instagram","utmMedium":"paid_social","utmCampaign":"ekim-hediye","utmContent":null,"utmTerm":null,"fbclid":"IwAR0abc","gclid":null,"ttclid":null,"landingUrl":"https://figurunica.com/?utm_source=instagram&utm_medium=paid_social&utm_campaign=ekim-hediye&fbclid=IwAR0abc","referrer":"https://l.instagram.com/"}}
```

Yanıt `200`:
```json
{ "ok": true, "duplicate": false, "orderId": "6f0c…uuid", "status": "PAID", "leadId": "1b2d…uuid", "leadMatched": "created" }
```
`leadMatched`: `"email" | "phone" | "created" | "none"` (anonim). Aynı `eventId` tekrar gelirse `200` ve
`"duplicate": true` (gövde ilk yanıttaki `orderId`/`status` ile).

### 1.5 Idempotency ve sıra

1. **Olay düzeyi (kalıcı):** `ExternalOrderEvent @@unique([sourceId, eventId])`. Aynı `eventId` + aynı gövde hash'i →
   `200 duplicate:true`, hiçbir şey yazılmaz. Aynı `eventId` + **farklı** gövde → `409 EVENT_ID_REUSED`.
2. **Replay (kısa süreli):** `WebhookReplayStore.check('commerce', eventId, hashBody(raw))` (`B/channels/inbound/webhook-verifier/webhook-replay.store.ts:82, :92`);
   `remember` yalnız 2xx'ten sonra (`:107`). Redis yoksa fail-open — kalıcı garanti (1) maddesidir.
3. **Sipariş düzeyi:** `ExternalOrder @@unique([workspaceId, sourceId, externalId])` → upsert.
4. **Sıra dışı gelen olaylar:** durum makinesi tek yönlüdür: `PENDING < PAID < {REFUNDED, CANCELLED}`. Geriye
   giden geçiş uygulanmaz ama olay kaydedilir (`applied=false`). `order.paid`, `order.created` gelmeden gelebilir
   (sipariş satırı o anda oluşur). `refundedMinor` yalnız artar.
5. Tüm yazımlar tek `prisma.$transaction` içinde: olay satırı + sipariş upsert + lead eşleme + attribution.

### 1.6 Hata kodları

| HTTP | `code` | Ne zaman |
|---|---|---|
| 401 | `MISSING_INGEST_TOKEN` / `INVALID_INGEST_TOKEN` | guard (`B/guards/ingest-token.guard.ts:39, :48`) — var olan mesajlar korunur |
| 401 | `UNKNOWN_SOURCE` | `x-jeeta-source` bu çalışma alanında yok ya da `REVOKED` |
| 401 | `BAD_SIGNATURE` | imza eksik/yanlış |
| 401 | `STALE_TIMESTAMP` | ±300 s dışında |
| 400 | `MALFORMED_JSON` / `VALIDATION_FAILED` (`details[]`) / `UNSUPPORTED_VERSION` | gövde |
| 409 | `EVENT_ID_REUSED` | aynı eventId, farklı gövde |
| 413 | — | gövde > 256 kb |
| 422 | `CURRENCY_MISMATCH` | aynı `externalId` için para birimi değişti |
| 429 | — | throttle |
| 404 | — | `COMMERCE_INGEST_ENABLED` kapalı |
| 5xx | — | gönderen yeniden dener (§8) |

Hata gövdesi: `{ "ok": false, "code": "BAD_SIGNATURE", "message": "…" }`. 4xx'ler (429 hariç) yeniden denenmez;
429 ve 5xx üstel geri çekilmeyle yeniden denenir.

### 1.7 Kaynak yönetimi (self-servis)

`B/commerce-ingest/commerce-sources.controller.ts`, `@Controller('marketing/commerce/sources')`,
`MarketingGuard + MarketingRolesGuard`, rol `MANAGER`, `@RequiresFeature('apiAccess')` (ingest token'larıyla aynı paket
kapısı, `B/controllers/marketing-research.controller.ts:135`):

| Yöntem | Yol | Dönen |
|---|---|---|
| `GET` | `/api/marketing/commerce/sources` | `[{id, slug, kind, status, lastEventAt, createdAt}]` — sır asla dönmez |
| `POST` | `/api/marketing/commerce/sources` `{slug, kind}` | `{…, signingSecret}` — **yalnız bir kez** |
| `POST` | `/api/marketing/commerce/sources/:id/rotate` | yeni `signingSecret` bir kez; eskisi 24 saat geçerli |
| `DELETE` | `/api/marketing/commerce/sources/:id` | `status=REVOKED` (satır silinmez; siparişler kalır) |

`kind`: `SHOPIFY | WOOCOMMERCE | CUSTOM` (Figurunica = `CUSTOM`). Belge: `docs/marketing/commerce-ingest.md` (yeni; müşteriye açık).

---

## 2. ExternalOrder Prisma modeli ve migration planı

### 2.1 Modeller (`S` sonuna, yeni blok `// ── Commerce ingest (2026-10-21) ──`)

```prisma
model CommerceSource {
  id                      String    @id @default(uuid())
  workspaceId             String
  slug                    String    // x-jeeta-source; [a-z0-9-]{2,40}
  kind                    String    // SHOPIFY|WOOCOMMERCE|CUSTOM
  signingSecret           String    // SEALED (secret-box v1:…)
  previousSecret          String?   // SEALED; rotate sonrası geçiş
  previousSecretExpiresAt DateTime?
  status                  String    @default("ACTIVE") // ACTIVE|REVOKED
  lastEventAt             DateTime?
  createdAt               DateTime  @default(now())
  revokedAt               DateTime?

  orders ExternalOrder[]
  events ExternalOrderEvent[]

  @@unique([workspaceId, slug])
  @@map("commerce_sources")
}

model ExternalOrder {
  id            String    @id @default(uuid())
  workspaceId   String
  sourceId      String
  source        CommerceSource @relation(fields: [sourceId], references: [id], onDelete: Restrict)
  externalId    String
  groupRef      String?
  status        String    // PENDING|PAID|REFUNDED|CANCELLED
  currency      String    @db.VarChar(3)
  amountMinor   Int
  refundedMinor Int       @default(0)
  paymentMethod String?
  items         Json?
  orderedAt     DateTime? // payload.order.createdAt ?? ilk olayın occurredAt'i
  paidAt        DateTime?
  refundedAt    DateTime? // son iade olayının occurredAt'i
  cancelledAt   DateTime?
  leadId        String?
  lead          Lead?     @relation(fields: [leadId], references: [id], onDelete: SetNull)
  attribution   Json?     // payload.attribution olduğu gibi (normalize edilmiş anahtarlar)
  utmSource     String?   // rapor gruplaması için düz kolonlar
  utmMedium     String?
  utmCampaign   String?
  lastEventAt   DateTime
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  events ExternalOrderEvent[]

  @@unique([workspaceId, sourceId, externalId])
  @@index([workspaceId, status, paidAt])
  @@index([workspaceId, leadId])
  @@map("external_orders")
}

model ExternalOrderEvent {
  id          String   @id @default(uuid())
  workspaceId String
  sourceId    String
  source      CommerceSource @relation(fields: [sourceId], references: [id], onDelete: Restrict)
  orderId     String
  order       ExternalOrder  @relation(fields: [orderId], references: [id], onDelete: Cascade)
  eventId     String
  type        String   // order.created|order.paid|order.refunded|order.cancelled
  occurredAt  DateTime
  bodyHash    String   // sha256(rawBody) — EVENT_ID_REUSED tespiti
  applied     Boolean  // durum makinesi uyguladı mı
  receivedAt  DateTime @default(now())

  @@unique([sourceId, eventId])
  @@index([workspaceId, receivedAt])
  @@map("external_order_events")
}
```

`Lead` modeline (`S:300`) yalnız geri ilişki eklenir: `externalOrders ExternalOrder[]`. `Workspace`'e ilişki **eklenmez**
(paralel dallarda `Workspace` bloğu çakışmasın; var olan pek çok model de yalnız `workspaceId` taşır).
Ham gövde (müşteri PII'si) olay tablosunda **saklanmaz**; yalnız hash.

### 2.2 Migration'lar (ad ve sıra baştan paylaştırıldı)

Son migration `20260922104000_lead_iys_email`. Yeni klasörler (`backend/prisma/migrations/`):

| Klasör | İçerik | Sahibi |
|---|---|---|
| `20261021100000_commerce_ingest` | `commerce_sources`, `external_orders`, `external_order_events` | Arda — Parça A |
| `20261021101000_ga4` | `ga4_connections`, `ga4_daily_stats` | Arda — Parça B |
| `20261021102000_site_tracking` | `site_tracking_keys`, `site_traffic_daily` | Arda — Parça C |

Her klasörde `migration.sql` (yalnız ekleyici: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, FK'ler) ve elle
yazılmış **`down.sql`** (repo geleneği, 59 migration'da var; örnek `20260922104000_lead_iys_email/down.sql`):

```sql
-- 20261021100000_commerce_ingest/down.sql
DROP TABLE IF EXISTS "external_order_events";
DROP TABLE IF EXISTS "external_orders";
DROP TABLE IF EXISTS "commerce_sources";
```
(GA4 ve site_tracking aynı biçimde, bağımlı tablo önce.) Var olan hiçbir tabloya kolon eklenmez → down veri kaybettirmez
(yalnız yeni tabloların verisi gider; canlıda down kararı sahibinin).

Gidiş-dönüş denemesi (her migration için, yerel/test DB'de):
```bash
cd backend
npx prisma migrate deploy                                   # up
psql "$DATABASE_URL" -f prisma/migrations/20261021100000_commerce_ingest/down.sql
psql "$DATABASE_URL" -c "DELETE FROM _prisma_migrations WHERE migration_name='20261021100000_commerce_ingest'"
npx prisma migrate deploy                                   # tekrar up
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code --shadow-database-url "$SHADOW_DATABASE_URL"   # 0 = sapma yok
```

---

## 3. Revenue birleşim kuralı

Değişen dosya: `B/budget/revenue-events.util.ts`.

1. `RevenueSource` (`:3`) → `'OPPORTUNITY' | 'INVOICE' | 'EXTERNAL_ORDER' | 'OFFER' | 'ESTIMATE'`.
2. `RevenueEventsDb` (`:14-19`) → `externalOrder: { findMany(args: unknown): Promise<unknown[]> }` eklenir.
3. `collectRevenueEvents(db, workspaceId, since, opts?: { includeExternalOrders?: boolean })` (`:30-34`); varsayılan
   `false`. Çağıran `B/budget/performance-loop.service.ts:39` `commerceRevenueEnabled()` (§9) değerini geçer.
4. Sorgu (`:35-52` `Promise.all`'a beşinci kol, bayrak kapalıyken **sorgu atılmaz**):
   ```ts
   db.externalOrder.findMany({
     where: { workspaceId, status: { in: ['PAID', 'REFUNDED'] }, paidAt: { gte: since },
              leadId: { not: null }, currency: workspace.defaultCurrency },
     select: { leadId: true, amountMinor: true, refundedMinor: true, paidAt: true },
   })
   ```
   Değer = `minorToMajor(amountMinor − refundedMinor)`; `≤ 0` ise olay üretilmez (tam iade gelir saymaz).
   `at = paidAt` (iade, satışın gününden düşülür — ROAS günü satış günüdür).
5. Öncelik (`:54-79` `tiers`): **WON Opportunity > PAID Invoice > PAID ExternalOrder > ACCEPTED Offer > ACCEPTED Estimate**.
   Aynı lead'de güçlü kademe varsa zayıf kademe tamamen düşer (var olan `claimed` mantığı, `:80-93`, değişmez);
   aynı kademedeki birden çok sipariş toplanır (iki sipariş = iki satış).
6. Para birimi: util bugün para birimine bakmıyor. ExternalOrder için yalnız `Workspace.defaultCurrency` (`S:38`) ile aynı
   olanlar alınır; diğerleri **kur çevrimi yapılmadan dışarıda** kalır ve haftalık raporda `commerce.otherCurrencies` olarak görünür.
7. Leadsiz (anonim) siparişler ROAS'a girmez (performance loop lead → `LeadAttribution.sourceAdCampaignId` üstünden
   bağlar, `performance-loop.service.ts:43-47`); haftalık rapordaki ticaret toplamlarına **girer** (§5).

Etki: `PerformanceLoopService.reconcile` `AdMetric.revenue/conversionValue/roas`'u **üzerine yazar** (`:84-105`); bu yüzden
birleşim ayrı bayrakla (`COMMERCE_REVENUE_IN_ROAS`) açılır ve Growth Autopilot davranışını değiştirdiği için açma kararı sahibindedir.

---

## 4. Lead eşleme kuralı

Yeni dosya `B/commerce-ingest/external-order-lead.matcher.ts`, saf fonksiyon + tx alır.

1. `customer` yoksa ya da e-posta/telefon ikisi de yoksa → `leadId = null`, `leadMatched = "none"`. Lead **açılmaz**.
2. Normalize: `normalizeEmail` (`B/utils/lead-normalize.ts:16`), telefon `toE164` (`:76`) sonra `normalizePhone` (`:10`).
3. Arama — var olan standart sorgu (aynısı `B/sites/forms.service.ts:174-192`):
   ```ts
   tx.lead.findFirst({ where: { workspaceId, mergedIntoId: null, deletedAt: null,
     OR: [{ emailNormalized }, { phoneNormalized: { in: localMsisdnVariants(phone) } }] },   // lead-normalize.ts:46
     orderBy: { createdAt: 'asc' } })
   ```
   E-posta eşleşmesi telefondan önce raporlanır (`leadMatched: "email"`).
4. Bulunursa: lead'e bağla. `source` **değiştirilmez** (ilk kaynak korunur — forms'taki `WEBSITE` üzerine yazma davranışı burada yok).
   Lead `WON` değilse durumu değişmez (sipariş ≠ CRM fırsatı; kapsam dışı).
5. Bulunmazsa: lead oluştur — `source: 'COMMERCE'`, `name = customer.name ?? email ?? phone`, `email`, `phone`,
   `emailNormalized`, `phoneNormalized`; `externalRef` **boş bırakılır** (aynı müşterinin ikinci siparişi 3. adımdaki
   iletişim eşleşmesiyle bulunur; `@@unique([workspaceId, externalRef])` `S:407` ile çakışma riski yok), oluşturan SYSTEM sentinel (`B/services/marketing-leads-ingest.service.ts:90-100` kalıbı).
   AI research günlük kotasına **sayılmaz**. `lead.created` outbox olayı var olan yolla yayılır.
6. Attribution: `attribution` varsa her durumda (yeni ya da var olan lead) aynı tx içinde
   `LeadAttributionService.capture(workspaceId, leadId, input, {}, tx)` (`B/leads/lead-attribution.service.ts:37-43`) çağrılır.
   İlk dokunuş kazanır (`:90` upsert `update:{}`) — var olan lead'in attribution'ı ezilmez. Girdi eşlemesi:
   ```ts
   input = { url: a.landingUrl ?? undefined, referrer: a.referrer ?? undefined,
             fields: { utm_source: a.utmSource, utm_medium: a.utmMedium, utm_campaign: a.utmCampaign,
                       utm_content: a.utmContent, utm_term: a.utmTerm,
                       fbclid: a.fbclid, gclid: a.gclid, ttclid: a.ttclid } }   // attribution-capture.util.ts:26-35, :123-127
   ```
   `resolveAttributionRefs` (`B/leads/ad-campaign-resolver.ts:39-72`) capture içinden zaten çalışır → `utm_campaign` bir
   `AdMetric.campaignId` ile eşleşirse sipariş reklam kampanyasına bağlanır.
7. `LeadSource` enum'una `COMMERCE = 'COMMERCE'` eklenir (`B/dto/create-lead.dto.ts:35-54`, yorumla: "sistem atar; IMPORT/EMAIL gibi
   birinci sınıf olmalı"). Frontend etiketleri: `frontend/src/features/marketing/schemas.ts`, `types.ts`,
   `frontend/src/pages/marketing/leads/leadsColumns.tsx` (Türkçe etiket: "E-ticaret").
8. Lead zaman çizelgesi: `CommerceTraceService.record` (`B/invoicing/commerce-trace.service.ts:43, :57`) ile `COMMERCE` aktivitesi;
   `CommerceEvent` (`B/invoicing/commerce-activity.ts:38`) birliğine `'order_paid' | 'order_refunded'` eklenir.

---

## 5. `jeeta.get_weekly_report`

### 5.1 Kayıt

`B/mcp/tools/analytics.tools.ts` içinde `registerAnalyticsTools` (`:18`); bağımlılığa `weeklyReport: WeeklyReportService` eklenir
(`B/marketing.module.ts:1571` çağrısı güncellenir). `domain: 'analytics'`, `scopes: ['reports.read']`, `risk: 'READ'`,
`requiresApproval: false`, **advertised**. Servis: `B/analytics/weekly-report.service.ts`.

### 5.2 Girdi şeması (zod; registry `.strict()` uygular)

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "weekEnding": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "description": "Haftanın son günü (Pazar), çalışma alanı saat diliminde. Yoksa: son TAMAMLANMIŞ hafta." }
  }
}
```
Pazar değilse 400 (`weekEnding must be a Sunday`). Hafta = Pazartesi 00:00 – Pazar 23:59:59, `Workspace.timezone` (`S:39`).
Gelecekteki hafta → 400.

### 5.3 Çıktı şeması

Her sayı `Metric` nesnesidir; böylece "her sayı kaynağını söyler":

```ts
type Metric = { value: number | null; previous: number | null; deltaPct: number | null; source: SourceTag };
type Section<T> = { available: boolean; reason?: 'NOT_CONNECTED' | 'NO_DATA' | 'FLAG_OFF'; data?: T };
type SourceTag = 'ga4' | 'site_snippet' | 'social_post_metric' | 'social_account_metric' | 'social_post'
               | 'ad_metric' | 'external_order' | 'lead' | 'analytics.funnel';

interface WeeklyReportV1 {
  version: 1;
  workspaceId: string;
  week: { start: string; end: string; timezone: string };          // YYYY-MM-DD
  previousWeek: { start: string; end: string };
  currency: string;                                                 // Workspace.defaultCurrency
  traffic: {
    ga4:  Section<{ sessions: Metric; users: Metric; conversions: Metric; purchaseCount: Metric; purchaseValue: Metric;
                    topSources: Array<{ source: string; medium: string; sessions: number }> }>;     // en çok 5
    site: Section<{ pageViews: Metric; topPaths: Array<{ path: string; views: number }>;
                    topSources: Array<{ source: string; views: number }> }>;
  };
  content: Section<{ postsPublished: Metric; impressions: Metric; reach: Metric; engagements: Metric;
                     clicks: Metric; videoViews: Metric; followers: Metric }>;
  ads: Section<{ spend: Metric; impressions: Metric; clicks: Metric; leads: Metric; revenue: Metric; roas: Metric }>;
  commerce: Section<{ ordersPaid: Metric; grossRevenue: Metric; refunds: Metric; netRevenue: Metric; aov: Metric;
                      cancelled: Metric; anonymousShare: Metric;
                      bySource: Array<{ utmSource: string | null; orders: number; netRevenue: number }>;    // en çok 5
                      otherCurrencies: Array<{ currency: string; orders: number; netMinor: number }> }>;
  leads: Section<{ newLeads: Metric; won: Metric; conversionRate: Metric }>;
  discrepancies: Array<{ kind: 'GA4_VS_ORDERS'; ga4PurchaseValue: number; ordersNetRevenue: number; diffPct: number }>;
  generatedAt: string;
}
```

Para tutarları ana birimde (TL), 2 ondalık. `deltaPct = previous ? (value − previous)/previous·100 : null` (1 ondalık).

### 5.4 Alanların kaynağı

| Alan | Kaynak (model / fonksiyon) | Sorgu kuralı |
|---|---|---|
| `traffic.ga4.*` | `Ga4DailyStat` (§6) | `date ∈ hafta`, `dimension='TOTAL'` toplam; `topSources` `dimension='SOURCE_MEDIUM'` |
| `traffic.site.*` | `SiteTrafficDaily` (§7) | `date ∈ hafta` toplam; path / source gruplama |
| `content.postsPublished` | `SocialPost` `status='PUBLISHED'`, `publishedAt ∈ hafta` (`S:3739-3741`) | count |
| `content.impressions…videoViews` | `SocialPostMetric` (`S:3831`) | `date ∈ hafta` toplam (günlük satırlar) |
| `content.followers` | `SocialAccountMetric.followers` (`S:3873`) | haftanın son günü itibarıyla hesap başına **son değer**, toplamı (seviye; toplanmaz-gün) |
| `ads.*` | `AdMetric` (`S:4875`) | `campaignId=''` (hesap toplamı) satırları, `date ∈ hafta`; `roas = revenue / spend` |
| `commerce.*` | `ExternalOrder` | `ordersPaid`: `paidAt ∈ hafta`; `gross = Σ amountMinor`; `refunds = Σ refundedMinor` (o hafta ödenenlerin); `net = gross − refunds`; `aov = net / ordersPaid`; `cancelled`: `cancelledAt ∈ hafta`; `anonymousShare`: `leadId IS NULL` oranı; yalnız `defaultCurrency` |
| `leads.newLeads` | `Lead.createdAt ∈ hafta`, `mergedIntoId=null`, `deletedAt=null` | count |
| `leads.won / conversionRate` | `AnalyticsService.funnel(workspaceId, {from, to})` (`B/analytics/analytics.service.ts:41`) | var olan uç, değişmez |
| `discrepancies` | GA4 `purchaseValue` vs `commerce.netRevenue` | `|diff| > %10` ise eklenir; rapor ikisini de gösterir, birini doğru saymaz (tasarım kararı) |

Bölüm `available=false` kuralları: GA4 bağlantısı yok → `NOT_CONNECTED`; ilgili bayrak kapalı → `FLAG_OFF`; bağlı ama haftada satır
yok → `NO_DATA`. Hiçbir bölüm hata yüzünden tüm aracı düşürmez (bölüm başına try/catch, `reason:'NO_DATA'` + log).

### 5.5 Katalog bütçesi

Reklam edilen araçlar tavanda (46/46). Karar: `jeeta.get_weekly_report` advertised; `jeeta.get_funnel`
(`B/mcp/tools/analytics.tools.ts:20`) `defer: true` olur — haftalık rapor huniyi zaten içerir ve analitik alanında advertised bir okuma
kalır. `B/mcp/tools/tool-catalogue.spec.ts`'de:
- `:685` `toHaveLength(163)` → `164`; isim listesine (`:413-417`) `jeeta.get_weekly_report`.
- D4/D5 kalıbında yeni test: `it('paid for the weekly report by deferring jeeta.get_funnel', …)` (ad ile sabitlenir).
- `docs/marketing/mcp-connector.md`'ye araç girişi (katalog testi belgeyi de kontrol eder). Aynı PR'da belgedeki `jeeta.get_funnel`
  örnekleri `jeeta.call_tool { name: "jeeta.get_funnel", … }` biçimine çevrilir ve "deferred: tools/list'te görünmez, `find_tools` /
  `call_tool` ile çağrılır" notu eklenir.
- **Araç kullanıcılarına duyuru (D birleşmeden önce):** `jeeta.get_funnel` kaldırılmıyor, yalnız doğrudan listeden çıkıyor. Elif'in KPI raporu
  talimatları ve görev metinleri `get_weekly_report`'a (huni dahil) ya da `call_tool` ile `get_funnel`'a göre güncellenir; aksi halde
  `tools/list`'te göremeyip "araç kalktı" sanılabilir. Sorumlu: D'yi inceleyen (Kerem), birleştirme öncesi koordinatöre bildirir.

---

## 6. GA4

### 6.1 OAuth

- Kapsam: `https://www.googleapis.com/auth/analytics.readonly` (tek kapsam). `access_type=offline`, `prompt=consent`,
  `include_granted_scopes=true` — `B/integrations/google-calendar.service.ts:193-196` kalıbı.
- İstemci: var olan `googleOAuthClientId()` / `googleOAuthClientSecret()` (`backend/src/common/util/google-oauth-env.ts:38, :42`),
  `isGoogleOAuthConfigured()` (`:46`). Ayrı client yok.
- Yollar (`B/analytics/ga4/ga4-oauth.controller.ts`, `@Controller('marketing/integrations/ga4')`):
  `GET connect` (MANAGER) → Google'a yönlendirir; `GET callback` (`@MarketingPublic`, `state` imzalı, Calendar callback'iyle aynı kalıp);
  `GET properties` → Admin API `accountSummaries.list` ile property listesi; `POST property {propertyId}` seçim; `DELETE` bağlantıyı kaldırır.
- Token yenileme: istek anında, `oauth2.googleapis.com/token` (`google-calendar.service.ts:270-300`, `refreshAccessToken` `:428` kalıbı).
- Bağımlılık eklenmez: Data API `fetch` ile (`POST https://analyticsdata.googleapis.com/v1beta/properties/{id}:runReport`),
  Admin API `GET https://analyticsadmin.googleapis.com/v1beta/accountSummaries`. Repo'daki tüm Google entegrasyonları ham `fetch` kullanıyor.
- **Dış bağımlılık (sahip/koordinatör):** `analytics.readonly` hassas kapsam; Google Cloud OAuth onay ekranına eklenmesi ve gerekirse
  doğrulama gerekir. Doğrulama bitene kadar test kullanıcıları (sahibin GA4 hesabı) ile çalışır.

### 6.2 Modeller

```prisma
model Ga4Connection {
  id              String    @id @default(uuid())
  workspaceId     String    @unique               // çalışma alanı başına bir property
  marketingUserId String
  googleEmail     String?
  propertyId      String?                        // "properties/123456789"; seçilene kadar null
  propertyName    String?
  accessToken     String                          // SEALED
  refreshToken    String                          // SEALED
  tokenExpiresAt  DateTime
  scopes          String?
  lastSyncedAt    DateTime?
  lastError       String?
  enabled         Boolean   @default(true)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  @@map("ga4_connections")
}

model Ga4DailyStat {
  id            String   @id @default(uuid())
  workspaceId   String
  propertyId    String
  date          DateTime @db.Date               // property'nin saat diliminde gün
  dimension     String                          // TOTAL | SOURCE_MEDIUM | CAMPAIGN
  key           String   @default("")           // TOTAL: ""; SOURCE_MEDIUM: "google / cpc"; CAMPAIGN: kampanya adı
  sessions      Int      @default(0)
  totalUsers    Int      @default(0)
  newUsers      Int      @default(0)
  conversions   Int      @default(0)            // GA4 "keyEvents"
  purchaseCount Int      @default(0)            // eventName=purchase eventCount
  purchaseValue Decimal  @default(0) @db.Decimal(14, 2)  // purchaseRevenue
  currency      String?  @db.VarChar(3)
  pulledAt      DateTime @default(now())
  @@unique([workspaceId, propertyId, date, dimension, key])
  @@index([workspaceId, date])
  @@map("ga4_daily_stats")
}
```
`SOURCE_MEDIUM` ve `CAMPAIGN` için gün başına en çok 50 satır (sessions'a göre ilk 50; kalan `key="(other)"`).

### 6.3 Cron

- `B/analytics/ga4/ga4-sync.cron.ts`: `@Cron('0 15 * * * *', { name: 'ga4-daily-sync' })` (her saat :15),
  gövde `withAdvisoryLock(prisma, 'ga4:daily-sync', …)` (`backend/src/common/scheduling/advisory-lock.ts:26`) — heartbeat
  `jeeta.list_scheduled_runs`'ta görünür. Kalıp: `B/social-planner/social-insights.cron.ts:100-102`.
- Her saat yalnız `lastSyncedAt` 20 saatten eski bağlantılar (en eski önce, 20'lik parti). Çekim penceresi: dün dahil **son 3 gün**
  (GA4 geç işler; upsert ile üzerine yazılır). İlk bağlantıda 35 günlük geri doldurma (haftalık raporun önceki haftası için).
- Atlama koşulları: `GA4_SYNC_ENABLED` kapalı, `isGoogleOAuthConfigured()` false, `MARKETING_SECRET_KEY` yok, `propertyId` null.
- Hata: `lastError` yazılır; 401 → bir kez refresh, yine 401 → `enabled=false`, `lastError='REAUTH_REQUIRED'`.
- Data API kotası: istek başına 3 rapor (`TOTAL`, `SOURCE_MEDIUM`, `CAMPAIGN`), `runReport` ile; `batchRunReports` serbest.

---

## 7. `jeeta.js` site parçacığı

### 7.1 Kurulum

```html
<script src="https://jeetagrowth.com/jeeta.js" data-site-key="jst_<32 hex>" async></script>
```
Dosya `frontend/public/jeeta.js` (statik, `frontend/public/widget.js` gibi; ≤ 3 KB, bağımlılıksız, ES5).
Anahtar: yeni `SiteTrackingKey` (`key = 'jst_' + randomBytes(16).hex`, `B/channels/channels.service.ts:267` üretim kalıbı), MANAGER
panelden/`POST /api/marketing/site-tracking/keys` ile oluşturur; `allowedHosts String[]` (boşsa her host).

### 7.2 Çerez

- Ad **`_jeeta_attr`**, birinci taraf (mağaza alan adında, `document.cookie`), `Max-Age=7776000` (**90 gün**), `Path=/`, `SameSite=Lax`,
  `Secure` (https'te). Değer: `encodeURIComponent(JSON)`; ≤ 1200 bayt:
  `{"v":1,"utmSource","utmMedium","utmCampaign","utmContent","utmTerm","fbclid","gclid","ttclid","landingUrl","referrer","ts"}`
  (alan adları webhook `attribution` nesnesiyle **birebir** aynı → mağaza çerezi doğrudan webhook'a koyar).
- Yazma kuralı: **son anlamlı dokunuş** — URL'de `utm_*` veya `fbclid/gclid/ttclid` varsa ya da referrer başka bir siteyse çerez
  yenilenir; doğrudan ziyaret ve site içi gezinme mevcut çerezi bozmaz.
- Rıza: parçacık kendi rıza kararı vermez; yükleyen site rıza kapısının arkasına koyar (Figurunica: `analytics-scripts.tsx`
  rıza bloğu). `data-consent="granted|denied"` özelliği `denied` ise yalnız sayfa görüntüleme gönderir, çerez yazmaz.

### 7.3 Sayfa görüntüleme uç noktası

```
GET /api/public/s/:siteKey/pv.gif?p=<path>&s=<source>&m=<medium>&c=<campaign>&r=<referrerHost>
→ 200 image/gif (1×1), Cache-Control: no-store
```
- `new Image().src` ile; CORS ve ön uçuş yok (`app.config.ts:119-150` allowlist'ine dokunulmaz).
- Controller `B/site-tracking/site-tracking-public.controller.ts`, `@Controller('public/s')`, guard yok,
  `@Throttle(PUBLIC_WRITE_THROTTLE)` değil — sayfa görüntüleme sık olur: `@Throttle({ default: { limit: 120, ttl: 60_000 } })` IP başına.
- Doğrulama: anahtar `ACTIVE`; `allowedHosts` doluysa `Referer` host'u listede olmalı (değilse sessizce 200 + yazmaz).
  Bot UA (basit regex) yazılmaz. Bayrak kapalıysa 200 gif, yazmaz (site kırılmasın).
- `p` `PageViewStatsService.normalise` (`B/analytics/page-view-stats.service.ts:39`) ile normalize edilir (id benzeri segment → `:id`), sorgu dizgisi atılır.
- Model:
  ```prisma
  model SiteTrackingKey { id String @id @default(uuid()); workspaceId String; key String @unique; label String?
    allowedHosts String[]; status String @default("ACTIVE"); createdAt DateTime @default(now()); revokedAt DateTime?
    @@index([workspaceId]) @@map("site_tracking_keys") }
  model SiteTrafficDaily { id String @id @default(uuid()); workspaceId String; siteKeyId String; date DateTime @db.Date
    path String; source String @default("(direct)"); medium String @default(""); campaign String @default(""); views Int @default(0)
    @@unique([siteKeyId, date, path, source, medium, campaign]) @@index([workspaceId, date]) @@map("site_traffic_daily") }
  ```
  Yazım `upsert … views: { increment: 1 }`; `date` çalışma alanı saat diliminde. Ziyaretçi kimliği, IP, UA **saklanmaz** (anonim sayaç).

---

## 8. Figurunica (printer) tarafı

Figurunica bu sözleşmenin sıradan bir istemcisidir. Printer'da zaten attribution var (`fig_ft`/`fig_lt` çerezleri,
`P/src/lib/analytics/attribution.ts:17-21`; `orders.utm*` + `orders.attribution` jsonb, `P/src/lib/db/schema.ts:941-948`) →
webhook attribution'ı **bu kolonlardan** doldurur, `_jeeta_attr` çerezini okumaz. Snippet yalnız trafik için konur.

### 8.1 Çağrı noktaları

| Olay | Yer | Not |
|---|---|---|
| `order.paid` | `P/src/lib/services/order-draft.ts` `finishDraftPromotion` (`:665`): sepette her alt sipariş için `recordPurchase` yanında (`:680`), tek siparişte `if ("newOrder" in result)` bloğunda `recordPurchase` yanında (`:732`) | Commit sonrası, yeni sipariş başına bir kez; `alreadyPromoted` yeniden girişi (`~:157-175`) tetiklemez. PayTR, havale onayı, OCR, hediye kartı, teklif yollarının hepsi buradan geçer |
| `order.refunded` | `P/src/lib/services/order-refund-record.ts` `kickNotices` (`:589`), `kickRefundRecordAnalytics` (`:594`) yanında | `refundedMinor` = siparişin tüm iade kayıtlarının toplamı (kümülatif) |
| `order.cancelled` | aynı dosya `cancelPaidOrder` commit sonrası `kickNotices` (`:537`) | printer'da `status:"rejected"` |
| `order.created` | **gönderilmez** | printer'da `orders` satırı yalnız ödemeyle oluşur; taslaklar sipariş değildir |

Alan eşlemesi: `externalId = orders.orderNumber`, `groupRef = orders.parentReference`, `currency = "TRY"`
(`P/src/lib/analytics/config.ts:32`), `amountMinor` = **`recordPurchase`'ın GA4'e gönderdiği değerin kuruş karşılığı**
(`P/src/lib/analytics/server.ts:279`; GA4 ile webhook aynı sayıyı söylesin), `customer = {email, phone, customerName}`,
`items` = `order_items` (`P/src/lib/db/schema.ts:2656`), attribution = `orders.utmSource…utmTerm` + `orders.attribution`'daki son dokunuşun
`gclid/fbclid/ttclid/landingUrl/referrer`'ı. `eventId = "figurunica:<event>:<orderNumber>"` (iade için `:<refundRecordId>` eki).

### 8.2 Teslim mekanizması

Ateşle-unut değil: yeni BullMQ kuyruğu `jeeta-commerce` (`P/src/lib/queue/queues.ts`, `attempts: 8`, üstel `backoff` 30 s'den;
`jobId = eventId` → kuyrukta tekil). Worker `P/src/lib/queue/workers/jeeta-commerce.worker.ts`, `workers/start.ts`'e kaydedilir.
İmzalama/gönderme `P/src/lib/integrations/jeeta-commerce.ts` (`buildEvent`, `sign`, `send`); 4xx (429 hariç) → yeniden deneme yok, log.
**`x-jeeta-timestamp` ve imza her denemede gönderim anında yeniden üretilir** — olay anında değil, kuyruğa eklenirken de değil.
Kuyrukta yalnız gövde baytları (ve `eventId`) saklanır; 30 s'den başlayan backoff 5.-6. denemede 300 s'lik pencereyi aşar,
saklanan imza o noktada `401 STALE_TIMESTAMP` alırdı. Gövde denemeler arasında **aynı bayt** kalır (yeniden serileştirilmez),
böylece `eventId` + `bodyHash` idempotency'si (§1.5) bozulmaz.
Kalıcı kurtarma gerekirse kalıp `P/src/lib/services/refund-record-analytics.ts` (lease/claim/retry).

### 8.3 `.env` değişkenleri (`P/.env.example` analitik bloğu `:117-154` altına)

| Değişken | Örnek | Not |
|---|---|---|
| `JEETA_COMMERCE_ENABLED` | `false` | kuyruk ekleme ve worker'ı açar |
| `JEETA_INGEST_URL` | `https://jeetagrowth.com/api/marketing/commerce/ingest/orders` | |
| `JEETA_INGEST_TOKEN` | `mkt_live_…` | Jeeta figurunica çalışma alanı ingest token'ı |
| `JEETA_SOURCE` | `figurunica` | `CommerceSource.slug` |
| `JEETA_SIGNING_SECRET` | `whsec_…` | kaynak oluşturulunca bir kez gösterilen sır |
| `NEXT_PUBLIC_JEETA_SITE_KEY` | `jst_…` | boşsa snippet render edilmez |

Snippet: `P/src/components/analytics/analytics-scripts.tsx` rıza bloğunda, GTM/GA'nın (`:96`, `:117`) yanına `next/script`
`strategy="afterInteractive"`. CSP (`P/next.config.ts:12` `script-src`, `:18-25` `connect-src`, `img-src`) → `https://jeetagrowth.com`
eklenir (bugün Report-Only, ama enforcing'e geçince kırılmasın).

---

## 9. Feature flag'ler

Repo kalıbı: env kill switch, yalnız `'1' | 'true' | 'on'` açar (`B/budget/growth-autonomy.flag.ts:8-11`). Varsayılan hepsi **kapalı**.

| Bayrak | Dosya | Kapalıyken |
|---|---|---|
| `COMMERCE_INGEST_ENABLED` | `B/commerce-ingest/commerce-ingest.flag.ts` | ingest uç noktası 404; sources CRUD çalışır (önce kurulum yapılabilsin) |
| `COMMERCE_REVENUE_IN_ROAS` | aynı dosya, `commerceRevenueEnabled()` | `collectRevenueEvents` ExternalOrder sorgusu atmaz; ROAS eskisi gibi |
| `GA4_SYNC_ENABLED` | `B/analytics/ga4/ga4.flag.ts` | OAuth yolları 404, cron atlar |
| `SITE_TRACKING_ENABLED` | `B/site-tracking/site-tracking.flag.ts` | piksel 200 döner ama yazmaz; anahtar CRUD 404 |
| `JEETA_COMMERCE_ENABLED` | printer env | webhook kuyruğa eklenmez |

`jeeta.get_weekly_report` bayraksızdır (salt okuma); kapalı parçanın bölümü `available:false, reason:'FLAG_OFF'` döner.
Paket kapısı: kaynak ve site anahtarı yönetimi `@RequiresFeature('apiAccess')`; yeni `FEATURE_KEYS` anahtarı **eklenmez**
(`entitlements.tripwire.spec.ts` dokunulmaz).

---

## 10. Kabul ölçütleri ve test listesi

Komutlar: backend `cd backend && npx jest <yol>` (tümü: `npm test`); frontend `cd frontend && npx vitest run <yol>`;
printer `npx tsx scripts/test-jeeta-commerce.ts` (ve `npm run test:unit` zincirine eklenir).

### A. Sipariş webhook'u + ExternalOrder + lead + revenue (Parça A)

| # | Ölçüt | Doğrulama |
|---|---|---|
| A1 | §1.2 test vektörü aynı imzayı üretir; yanlış imza, eksik başlık, ±300 s dışı zaman reddedilir; iki `v1=` değerinden biri tutarsa geçer; aynı gövde + yeni zaman damgası + yeni imza (yeniden deneme) → 200 `duplicate:true` | `B/commerce-ingest/commerce-signature.spec.ts` — `it('reproduces the contract vector 7d5da73a…')` |
| A2 | Geçerli `order.paid` → 200, `ExternalOrder` `PAID`, `paidAt=occurredAt`, olay satırı `applied=true` | `B/commerce-ingest/commerce-ingest.service.spec.ts`; e2e `backend/test/e2e/commerce-ingest.e2e-spec.ts` |
| A3 | Aynı `eventId` + aynı gövde → 200 `duplicate:true`, satır sayısı değişmez; farklı gövde → 409 `EVENT_ID_REUSED` | service spec `it('is idempotent on eventId')` |
| A4 | `order.refunded` kümülatif: 100000 sonra 349900 → `REFUNDED`; ardından gelen eski 100000 `refundedMinor`'ı düşürmez | service spec `it('refunds only grow')` |
| A5 | Sıra dışı: `order.paid` sonra `order.created` → durum `PAID` kalır, olay `applied=false` | service spec `it('never moves state backwards')` |
| A6 | Hata kodları §1.6 tablosu: 401×4, 400×3, 409, 422, 404 (bayrak) | `B/commerce-ingest/commerce-ingest.controller.spec.ts` (tablo başına bir `it.each`) |
| A7 | Ham gövde mount'u: `/api/marketing/commerce/ingest` JSON ayrıştırıcıdan önce raw | `B/commerce-ingest/commerce-ingest.mount.spec.ts` (yeni) — `B/controllers/email-webhook.controller.spec.ts`'deki mount testinin kalıbı |
| A8 | Lead eşleme: e-posta → var olan lead (source değişmez); yalnız telefon `0532…`/`90532…` varyantı → eşleşir; hiçbiri → `COMMERCE` lead + attribution; anonim → `leadId=null`, lead açılmaz | `B/commerce-ingest/external-order-lead.matcher.spec.ts` |
| A9 | Attribution `utm_campaign` bir `AdMetric.campaignId` ise `LeadAttribution.sourceAdCampaignId` dolar; var olan attribution ezilmez | matcher spec + var olan `B/leads/lead-attribution.service.spec.ts` yeşil |
| A10 | Revenue: bayrak kapalı → `externalOrder.findMany` çağrılmaz; açık → kademe sırası WON > INVOICE > EXTERNAL_ORDER > OFFER; tam iade olay üretmez; başka para birimi alınmaz | `B/budget/revenue-events.util.spec.ts` (yeni `describe('external orders')`); `B/budget/performance-loop.service.spec.ts` mock'una `externalOrder` |
| A11 | Kaynak CRUD: sır yalnız oluşturma/rotate yanıtında; DB'de `v1:` mühürlü; rotate sonrası eski sır 24 saat geçer | `B/commerce-ingest/commerce-sources.service.spec.ts` |
| A12 | Migration gidiş-dönüş | §2.2 komutları, çıktısı teslimde |

Canlı duman testi (staging, bayrak açık):
```bash
TS=$(date +%s); BODY=$(cat body.json)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
curl -sS -w '\n%{http_code}\n' -X POST "$JEETA/api/marketing/commerce/ingest/orders" \
  -H 'Content-Type: application/json' -H "x-ingest-token: $TOKEN" -H 'x-jeeta-source: figurunica' \
  -H "x-jeeta-timestamp: $TS" -H "x-jeeta-signature: v1=$SIG" --data-binary "$BODY"
# beklenen: {"ok":true,"duplicate":false,…,"status":"PAID"} 200 ; aynı komut tekrar → "duplicate":true
# imzayı bozunca: {"ok":false,"code":"BAD_SIGNATURE"} 401
```

### B. GA4 (Parça B)

| # | Ölçüt | Doğrulama |
|---|---|---|
| B1 | `connect` URL'i `analytics.readonly`, `access_type=offline`, `prompt=consent`, imzalı `state` içerir | `B/analytics/ga4/ga4-oauth.service.spec.ts` |
| B2 | callback token'ları mühürlü saklar; `properties` Admin API yanıtını eşler | aynı spec (fetch mock) |
| B3 | `runReport` yanıtı → `Ga4DailyStat` satırları (TOTAL/SOURCE_MEDIUM/CAMPAIGN, ilk 50 + `(other)`); tekrar çekim upsert, çift satır yok | `B/analytics/ga4/ga4-data.client.spec.ts`, `B/analytics/ga4/ga4-sync.service.spec.ts` |
| B4 | Cron: bayrak kapalı/OAuth yok/property yok → atlar; 20 saatten yeni bağlantıyı atlar; 401 → refresh → yine 401 → `REAUTH_REQUIRED` | `B/analytics/ga4/ga4-sync.cron.spec.ts` |
| B5 | Gerçek property ile bir gün çekildi (sahibin GA4'ü, OAuth onayından sonra) | `psql -c "select date,dimension,key,sessions from ga4_daily_stats order by date desc limit 5"` çıktısı — **sahibin onayı ve Google onay ekranı gerekir** |

### C. Site parçacığı (Parça C)

| # | Ölçüt | Doğrulama |
|---|---|---|
| C1 | `jeeta.js`: UTM'li URL → `_jeeta_attr` 90 gün yazılır, alan adları §7.2; doğrudan ziyaret çerezi ezmez; `data-consent="denied"` çerez yazmaz | `frontend/src/lib/jeeta-snippet.test.ts` (jsdom; `public/jeeta.js`'i `eval` ile yükler) |
| C2 | Piksel: geçerli anahtar → 200 gif + `SiteTrafficDaily.views` +1; geçersiz/iptal anahtar ve izinsiz host → 200 ama yazmaz; bayrak kapalı → yazmaz | `B/site-tracking/site-tracking-public.controller.spec.ts`, `B/site-tracking/site-tracking.service.spec.ts` |
| C3 | Yol normalize: `/siparis/FIG-7K2M9QXA?x=1` → `/siparis/:id` | service spec |
| C4 | Duman: `curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' "$JEETA/api/public/s/$KEY/pv.gif?p=/&s=instagram"` → `200 image/gif` | staging |

### D. `jeeta.get_weekly_report` (Parça D)

| # | Ölçüt | Doğrulama |
|---|---|---|
| D1 | Girdi: `weekEnding` yok → son tamamlanmış hafta (Europe/Istanbul'da Pazartesi 00:00'dan önce çağrı → iki hafta önceki değil, geçen hafta); Pazar değil → hata; bilinmeyen alan → hata | `B/analytics/weekly-report.service.spec.ts` |
| D2 | Her bölüm §5.4 kaynağından; her `Metric.source` dolu; `deltaPct` önceki hafta 0 iken `null` | aynı spec (Prisma mock fixture'ı) |
| D3 | GA4 bağlı değil → `traffic.ga4.available=false, reason='NOT_CONNECTED'`; bir bölümün hatası diğerlerini düşürmez | aynı spec |
| D4 | GA4 `purchaseValue` ile `netRevenue` %10'dan fazla ayrışırsa `discrepancies`'de ikisi de | aynı spec |
| D5 | Araç kaydı: `reports.read`, `READ`, advertised; `jeeta.get_funnel` deferred; katalog 164, tavan 46 | `B/mcp/tools/analytics.tools.spec.ts`, `B/mcp/tools/tool-catalogue.spec.ts` |
| D6 | Figurunica çalışma alanında çağrı | `python ~/.control-center/desks/koordinator/tools/jeeta_mcp.py figurunica call jeeta.get_weekly_report '{}'` → `version:1` JSON (deploy sonrası) |

### E. Printer (Parça E)

| # | Ölçüt | Doğrulama |
|---|---|---|
| E1 | `sign()` §1.2 test vektörünü üretir (aynı gövde baytları, aynı imza); worker her denemede yeni zaman damgası ve imza üretir (sahte saatle 400 s sonraki deneme farklı `x-jeeta-timestamp`, aynı gövde baytları) | `scripts/test-jeeta-commerce.ts` |
| E2 | `buildEvent(order)` alan eşlemesi §8.1; sepet alt siparişleri ayrı olay, aynı `groupRef` | aynı betik |
| E3 | `JEETA_COMMERCE_ENABLED=false` → kuyruğa iş eklenmez; `true` → `finishDraftPromotion` yeni sipariş başına bir iş, `jobId=eventId` | aynı betik (kuyruk mock'u) |
| E4 | Worker: 5xx/429 yeniden dener, 4xx denemez | aynı betik |
| E5 | Kapı: `npm run verify` yeşil (lint, typecheck, build, test:unit) | komut çıktısı |

### Genel

- Tüm backend: `cd backend && npm test` yeşil; `npx tsc --noEmit -p tsconfig.json` temiz.
- `npx prisma migrate diff … --exit-code` 0.
- Her parça ayrı PR; inceleyen Kerem (testleri kendisi koşar). Birleştirme, migration'ın canlıda uygulanması ve bayrak açma **sahibinin kararı**.

---

## Paralel geliştirme paylaşımı

### Parçalar, dallar, modül yolları

| Parça | Dal (origin/main'den) | Yeni modül yolları | Bağımlılık |
|---|---|---|---|
| A — ingest + ExternalOrder + lead + revenue | `feat/commerce-ingest` | `B/commerce-ingest/` (`commerce-ingest.controller.ts`, `commerce-ingest.service.ts`, `commerce-signature.ts`, `commerce-sources.controller.ts`, `commerce-sources.service.ts`, `external-order-lead.matcher.ts`, `commerce-ingest.flag.ts`, `dto/order-event.dto.ts`) | yok |
| B — GA4 | `feat/ga4-connection` | `B/analytics/ga4/` (`ga4-oauth.controller.ts`, `ga4-oauth.service.ts`, `ga4-data.client.ts`, `ga4-sync.service.ts`, `ga4-sync.cron.ts`, `ga4.flag.ts`) | yok |
| C — snippet | `feat/site-tracking` | `B/site-tracking/` (`site-tracking-public.controller.ts`, `site-keys.controller.ts`, `site-tracking.service.ts`, `site-tracking.flag.ts`), `frontend/public/jeeta.js` | yok |
| D — haftalık rapor | `feat/weekly-report-tool` | `B/analytics/weekly-report.service.ts`, `analytics.tools.ts` değişikliği | A, B, C'nin **şema**sı (§2.1, §6.2, §7.3); A/B/C birleşince rebase |
| E — printer | `feat/jeeta-commerce-webhook` (printer) | `src/lib/integrations/jeeta-commerce.ts`, `src/lib/queue/workers/jeeta-commerce.worker.ts`, `scripts/test-jeeta-commerce.ts` | A'nın sözleşmesi (bu belge); A canlıda olmadan yalnız test vektörüyle |

Önerilen sıra (tek geliştirici): A → E → C → B → D. B, Google onay ekranı beklerken kodlanabilir.

### Hangi paylaşılan dosya kimde (çakışma listesi)

| Dosya | Değişiklik | Parça |
|---|---|---|
| `backend/prisma/schema.prisma` | sonuna üç ayrı blok (Commerce / GA4 / Site tracking); `Lead` (`:300`) geri ilişki yalnız A | A, B, C — **blok sırası A, B, C**; her parça yalnız kendi bloğunu ekler |
| `backend/prisma/migrations/2026102110{0,1,2}000_*` | §2.2 | A, B, C |
| `backend/src/app.config.ts` | `:64`'ten sonra raw mount | A |
| `B/marketing.module.ts` | controllers/providers; yeni bağımlılıklar kurucu parametre listesinin **sonuna** (`~:1557` geleneği); `:1571` `registerAnalyticsTools` | A, B, C (provider), D (`:1571`) |
| `B/dto/create-lead.dto.ts:35-54` | `COMMERCE` | A |
| `frontend/src/features/marketing/{schemas,types}.ts`, `frontend/src/pages/marketing/leads/leadsColumns.tsx` | `COMMERCE` etiketi | A |
| `B/budget/revenue-events.util.ts` (`:3, :14-19, :30-52, :54-79`) + spec | §3 | A |
| `B/budget/performance-loop.service.ts:39` + spec | `opts` geçişi | A |
| `B/invoicing/commerce-activity.ts:38` | `order_paid`, `order_refunded` | A |
| `B/mcp/tools/analytics.tools.ts` (`:18-38`), `tool-catalogue.spec.ts` (`:413-417`, `:685`), `docs/marketing/mcp-connector.md` | §5.5 | D |
| `docs/marketing/commerce-ingest.md` (yeni, müşteriye açık kurulum belgesi) | webhook + snippet + GA4 kurulumu | A yazar, B/C kendi bölümünü ekler |

### Yeniden kullanılacak fonksiyonlar (dosya:satır)

| Ne | Nerede |
|---|---|
| `IngestTokenGuard`, `hashIngestToken`, `req.ingestWorkspaceId` | `B/guards/ingest-token.guard.ts:14-16, :37-52` |
| `@MarketingRoute()` + throttle kalıbı | `B/controllers/marketing-leads-ingest.controller.ts:27-46` |
| `constantTimeEquals`, `header`, (tazelik mantığı) `timestampFresh` | `B/channels/inbound/webhook-verifier/index.ts:114, :122-130, :133-138` |
| `WebhookReplayStore.hashBody/check/remember` | `B/channels/inbound/webhook-verifier/webhook-replay.store.ts:82, :92, :107` |
| `sealSecret` / `openSecret` | `backend/src/common/crypto/secret-box.helper.ts:46, :54` |
| `normalizeEmail`, `normalizePhone`, `localMsisdnVariants`, `toE164` | `B/utils/lead-normalize.ts:16, :10, :46, :76` |
| Standart lead arama sorgusu | `B/sites/forms.service.ts:174-192` |
| SYSTEM sentinel kullanıcı | `B/services/marketing-leads-ingest.service.ts:90-100` |
| `LeadAttributionService.capture` | `B/leads/lead-attribution.service.ts:37-43` |
| `parseAttribution`, `AttributionInput` | `B/leads/attribution-capture.util.ts:118, :26-35` |
| `resolveAttributionRefs` | `B/leads/ad-campaign-resolver.ts:39-72` |
| `collectRevenueEvents` | `B/budget/revenue-events.util.ts:30` |
| `CommerceTraceService.record` | `B/invoicing/commerce-trace.service.ts:57` |
| `PageViewStatsService.normalise` | `B/analytics/page-view-stats.service.ts:39` |
| `AnalyticsService.funnel` | `B/analytics/analytics.service.ts:41` |
| `googleOAuthClientId/Secret`, `isGoogleOAuthConfigured` | `backend/src/common/util/google-oauth-env.ts:38, :42, :46` |
| Google OAuth URL + refresh kalıbı | `B/integrations/google-calendar.service.ts:193-196, :270-300, :428` |
| `withAdvisoryLock` | `backend/src/common/scheduling/advisory-lock.ts:26` |
| Saatlik cron kalıbı | `B/social-planner/social-insights.cron.ts:100-102` |
| Env bayrak kalıbı | `B/budget/growth-autonomy.flag.ts:8-11` |
| `@RequiresFeature('apiAccess')` | `B/controllers/marketing-research.controller.ts:135` |
| Statik gömme kalıbı / anahtar üretimi | `frontend/public/widget.js`, `B/channels/channels.service.ts:267` |
| MCP araç kaydı ve test kalıbı | `B/mcp/mcp-tool-registry.ts:144-258`, `B/mcp/tools/analytics.tools.spec.ts` |

### MCP araç adları

Yeni: `jeeta.get_weekly_report` (advertised). Değişen: `jeeta.get_funnel` → `defer: true`. Başka yeni araç yok
(GA4/kaynak yönetimi panel + REST; MCP'den yazma bu turda kapsam dışı).

## Kapsam dışı (bu tur)

- Shopify/WooCommerce hazır eklentileri (sözleşme onlara uygun; eklenti yazılmaz).
- Kur çevrimi; çok para birimli ROAS.
- MCP'den kaynak/GA4 yönetimi; haftalık raporun e-posta/WhatsApp ile otomatik gönderimi (daily-digest altyapısına bağlama ayrı iş).
- Studio'da haftalık rapor kartı (frontend UI) — D'den sonra ayrı görev.
- Meta CAPI / TikTok Events API'ye Jeeta'dan sunucu olayı göndermek.

## Açık sorular (sahibe, koordinatör üzerinden)

Cevaplar gelene kadar: Parça B'nin OAuth onay ekranı/hesabı (soru 1) ve Parça A'nın `customer` PII alanlarının canlıda açılması (soru 3)
kesin değildir. Kod ve testler bu sözleşmeyle yazılabilir; bayraklar (§9) kapalı kalır.

1. GA4 property'si hangi Google hesabında? OAuth o hesapla yapılacak; `analytics.readonly` için Google Cloud onay ekranı güncellemesi gerekiyor.
2. `COMMERCE_REVENUE_IN_ROAS` açılınca Growth Autopilot ROAS'ı sipariş gelirini görür ve bütçe kararlarını etkiler — açma zamanı sahibin.
3. Müşteri PII'si (e-posta/telefon/ad) Figurunica'dan Jeeta'ya akıyor; KVKK aydınlatma metninde Jeeta'nın veri işleyen olarak anılması gerekir mi (hukuk → sahibi).
