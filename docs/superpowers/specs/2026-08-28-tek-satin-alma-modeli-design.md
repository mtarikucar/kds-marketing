# Tek satın alma modeli: kademeleri emekliye ayır

Tarih: 2026-08-28
Durum: tasarım onaylandı, uygulama planı bekliyor

## Karar

Tek fiyat, tüm özellikler açık. Bir satın alma = bir workspace. Kotalar herkeste
**sabit**; artırmak isteyen artırımı ayrıca satın alır.

## Bugünkü durum (ölçüldü)

Katalogda altı paket var ama kademe pratikte yok:

| Paket | ₺/ay | Açık | lead/gün | araştırma profili | bilgi dok. |
|---|---|---|---|---|---|
| TRIAL | 0 | hayır | 5 | 1 | 10 |
| **STARTER** | **3.490** | **evet** | 50 | 4 | 500 |
| JEETA | 6.900 | hayır | 50 | 4 | 500 |
| GROWTH | 8.490 | hayır | 50 | 4 | 500 |
| SCALE | 16.900 | hayır | 50 | 4 | 500 |
| OPERATOR | — | hayır | sınırsız (iç kullanım) | | |

Dört fiyat, **birebir aynı kotalar**. `maxUsers`, `maxAgents`, `maxWorkflows`,
`maxFunnels`, `maxCalendars` hepsinde `-1` (sınırsız). Satın alınabilir tek paket
zaten STARTER.

Artırım altyapısı da kurulu: `WorkspaceAddOn`, `grantAddOn`, `PaymentOrder`
`type: 'ADDON'` ve üç kredi paketi (`credits_1k`, `credits_4k`, `credits_12k`).
`billing-settlement.service.ts`'in kendi yorumu modeli şöyle tarif ediyor:

> *"for a plan whose whole shape is 'modest included credits, top up when you
> need more'"*

Abonelik zaten workspace başına (`WorkspaceSubscription`).

**Sonuç:** hedeflenen model büyük ölçüde zaten kurulu. Kademeler ve özellik
kapıları arta kalan parçalar.

## Yapılacaklar

### 1 · Kademeleri emekliye ayır

- Tek herkese açık paket kalır. JEETA / GROWTH / SCALE `isPublic: false` olarak
  iç kullanıma çekilir (silinmez — mevcut abonelikleri kırmamak için).
- OPERATOR ve TRIAL olduğu gibi kalır: biri iç bootstrap, diğeri deneme.
- **Açık karar:** tek fiyatın ne olacağı sahibe ait. Spec bir rakam
  varsaymıyor; bugünkü tek açık fiyat 3.490 ₺.

### 2 · Özellik kapılarını kaldır — asıl iş

**Panel (13 kapı)** — `navigation.ts` içindeki `feature:` alanları:
`funnels` ×3, `voiceAi` ×2, `workflows`, `telephony`, `sendingDomains`,
`research`, `prospecting`, `memberships`, `invoicing`, `customDomains`,
`conversationAi`, `commissions`, `installations`.

`visibleNav`'ın `has(feature)` süzgeci kalkar. Rol süzgeci (`isManager`,
`isOwner`) **kalır** — o yetki, paket değil.

**Sunucu (10 kapı)** — `FEATURE_NOT_IN_PACKAGE` fırlatan yerler; kanallar,
kampanyalar, AI kredileri, bilgi tabanı, mesaj kotası, ajan profilleri, marka
uygulama, hesap merkezi.

Kapılar kaldırılırken **kota kontrolleri korunur**. İkisi karıştırılmamalı:

- *Özellik kapısı* = "bu paket bunu içermiyor" → **kalkıyor**
- *Kota kontrolü* = "bu ayki hakkın bitti" → **kalıyor**

`assertChannelFeature` gibi çağrılar özellik kapısıdır ve kalkar;
`message-quota.service.ts` kotadır ve kalır.

### 3 · Kapasite artırımlarını kataloğa ekle

Bugün yalnızca AI kredisi satılabiliyor. Sabit kotaların her biri için artırım
kalemi gerekiyor:

- `dailyLeadQuota` (varsayılan 50)
- `maxResearchProfiles` (varsayılan 4)
- `maxKnowledgeDocs` (varsayılan 500)

Mekanizma var (`grantAddOn`), eksik olan katalog kalemleri ve bunların
`EntitlementsService.compute()` içinde temel kotanın üstüne eklenmesi.

**Dikkat:** `grantAddOn` bugün koşulsuz `create` yapıyor ve bu yüzden
`reconcile` süpürgesinden bilerek dışlanmış — tekrarlanan bir webhook aynı
artırımı iki kez verebilir. Kalemler çoğalmadan önce `WorkspaceAddOn`'a
`ref` üzerinden tekilleştirme eklenmeli. Kredi yüklemeleri bunu zaten
`order:{id}` benzersiz referansıyla yapıyor; aynı deseni izle.

**Neden kotalar sınırsız değil:** araştırma profili doğrudan Anthropic
faturasına dönüşür. 30 günlük ölçüm: 15,97 $ — %86'sı gece araştırmasının model
turundan. Sınırsız profil, tahmin edilemeyen bir gider demektir.

### 4 · Geçiş

- Mevcut abonelikler paketlerinde kalır; kapılar kalktığı için hepsi tüm
  özellikleri görür — kimsenin erişimi daralmaz.
- `PackageMatrix.tsx` (karşılaştırma tablosu) tek pakete indiğinde anlamını
  yitirir; yerine tek fiyat + artırım listesi gelir.

## Test

- **Birim:** `EntitlementsService.compute()` artık her özelliği açık döndürüyor;
  kota + artırım toplamı doğru hesaplanıyor.
- **Gerçek-DB e2e:** artırım satın alımı kotayı yükseltiyor; **aynı ödeme iki
  kez işlenirse artırım bir kez veriliyor** (bugünkü boşluk).
- **Regresyon:** hiçbir uçtan `FEATURE_NOT_IN_PACKAGE` dönmediğini doğrulayan
  tarama testi — kapılardan biri geride kalırsa CI söyler.

## Kapsam dışı

- Fiyatın kendisi (sahibin kararı)
- AGENCY / çoklu lokasyon: "bir satın alma = bir workspace" kuralı bunu zaten
  cevaplıyor — beş müşterisi olan ajans beş workspace alır. Ayrı bir bayi
  modeli tasarlanmıyor.
