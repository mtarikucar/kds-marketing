# MCP Connector — Tasarım Dokümanı

**Tarih:** 2026-07-28
**Durum:** Onaylandı, implementasyon planı bekliyor
**Kapsam:** Jeeta'yı bir MCP (Model Context Protocol) sunucusu olarak dışarı açmak; Claude Code ve Claude.ai/Desktop üzerinden sistemin kontrol edilebilmesi.

---

## 1. Amaç ve arka plan

Jeeta bugün Claude API'yi **içeriden** kullanıyor (`AnthropicService`, tek LLM giriş noktası). Bu tasarım ters yönü kuruyor: **dışarıdaki bir Claude istemcisinin Jeeta'yı kontrol etmesi.**

Bu sıfırdan bir güvenlik mimarisi değil. Repoda politika katmanı zaten mevcut ve unit-testli, ama **transport'u hiç yazılmadığı için tamamen erişilemez durumda**:

| Bileşen | Konum | Durum |
|---|---|---|
| `McpToolRegistry` | `backend/src/modules/marketing/mcp/mcp-tool-registry.ts` | Yazılmış, provider olarak bağlı, **kayıtlı tool yok** |
| `McpBrokerService` | `backend/src/modules/marketing/mcp/mcp-broker.service.ts` | Yazılmış, testli, provider olarak bağlı (`marketing.module.ts:888-889`) |
| MCP transport | — | **Yok** |
| `ApiKeysService` / `ApiKeyGuard` | `marketing/services/api-keys.service.ts`, `marketing/guards/api-key.guard.ts` | Yazılmış; `mk_live_…` workspace-scoped |
| Onay kuyruğu | `marketing-approvals.controller.ts` + `BudgetAutopilotPage.tsx` | API + UI mevcut |

Registry'nin kendi yorumu bu boşluğu zaten öngörmüş: *"The transport (MCP server) is a thin layer over this registry; policy lives in the broker."*

Bu tasarımın işi: **eksik olan transport'u eklemek, mevcut politika katmanını olduğu gibi korumak.**

### Ölçek

140 controller, 716 endpoint, 209 servis, ~55 marketing alt-modülü. Tüm endpoint'leri tool'a çevirmek hem gereksiz iş hem de model doğruluğunu düşürür; bu yüzden kürasyonlu bir alt küme açılır (bkz. §5).

---

## 2. Alınan kararlar

| # | Karar | Seçim | Gerekçe |
|---|---|---|---|
| 1 | Kitle | **Hem Claude Code hem Claude.ai** — tek sunucu, iki auth yolu | Operatör kullanımı gün 1'de çalışsın, tenant'lara açılım da aynı sunucudan gelsin |
| 2 | Tool yüzeyi | **Kürasyonlu kontrol düzlemi, ~35 tool** | 716 endpoint'i açmak modele 700 tool vermek demek; doğruluk düşer |
| 3 | Yazma politikası | **Workspace başına mod** (`APPROVAL` / `AUTONOMOUS`) | Operatör otonom çalışsın, tenant'lar onay kapısında kalsın |
| 4 | Mimari | **A — Nest'e gömülü, fazlı auth** | Broker in-process kalır; onay kuyruğu ve denetim zinciri korunur |
| 5 | SDK | **v2 — `@modelcontextprotocol/server` + `@modelcontextprotocol/express`** | Hazır `bearerAuth` / `oauthMetadata` / `originValidation` middleware'leri; risk izole (yeni endpoint) |

---

## 3. Mimari

```
Claude Code ──Bearer mk_live_…──┐
                                 ├──► POST /mcp ──► McpModule (transport)
Claude.ai  ──OAuth access token──┘                        │
                                                          │ McpToolContext
                                                          │ {workspaceId, userId, grantedScopes, agentRunId}
                                                          ▼
                                                  McpBrokerService  ◄── DEĞİŞTİRİLMEZ
                                                  allow-list → scope → onay → arg limiti → çalıştır + audit
                                                          ▼
                                            mevcut servisler (leads, campaigns, ads, …)
```

**Değişmez kural:** transport'ta hiç politika yoktur. MCP katmanı yalnızca (a) protokolü konuşur, (b) auth'u tek bir `McpToolContext`'e çözer, (c) broker'a devreder. `McpBrokerService`'in mevcut davranışı §6'daki mod dalı dışında değiştirilmez.

### Modül yerleşimi

```
backend/src/modules/marketing/mcp/
  mcp-tool-registry.ts        (mevcut, değişmez)
  mcp-broker.service.ts       (mevcut; yalnızca write-mode dalı eklenir)
  mcp.module.ts               (yeni)
  mcp.controller.ts           (yeni — transport)
  mcp-session.service.ts      (yeni — AgentRun yaşam döngüsü)
  mcp-auth.service.ts         (yeni — iki auth yolunu tek context'e çözer)
  tools/
    leads.tools.ts            (yeni)
    inbox.tools.ts
    campaigns.tools.ts
    social.tools.ts
    ads.tools.ts
    analytics.tools.ts
    brand.tools.ts
    scheduling.tools.ts
    workspace.tools.ts
    index.ts                  (tek noktadan register)
backend/src/modules/mcp-oauth/  (yeni — Faz 3, authorization server)
```

---

## 4. Transport

`@modelcontextprotocol/server` 2.0.0 + `@modelcontextprotocol/express` 2.0.0, bir Nest controller'ına bağlanır.

- Tek endpoint: `POST /mcp` — Streamable HTTP
- SDK middleware'leri: `originValidation` + `hostHeaderValidation` (DNS-rebinding ve CSRF koruması)
- Tool'lar `registerTool()` ile, Zod şemalarıyla tanımlanır

**Express 5 dikkat noktası:** global `ValidationPipe` ve body-parser bu route'u ham geçirmelidir; MCP gövdesi Nest DTO doğrulamasından geçmemelidir. Route, global pipe'ların dışında bırakılır.

**SDK sürüm riski:** `@modelcontextprotocol/server` 2.0.0 GA tarihi 2026-07-27 (alpha 2026-04-01, toplam 10 sürüm). v1 hattı (`@modelcontextprotocol/sdk` 1.30.0, 79 sürüm) hâlâ bakımda. v2 seçildi çünkü MCP endpoint'i tamamen yeni ve izole bir yüzey — buradaki bir regresyon mevcut ürün trafiğini değil yalnızca connector'ü etkiler. **İmplementasyonda tüm API imzaları kurulu pakete karşı doğrulanacak, dokümantasyondan tahmin edilmeyecek.**

---

## 5. Auth — iki yol, tek çıkış

Her iki yol da aynı `McpToolContext`'e çözülür; broker hangi yoldan gelindiğini bilmez.

| | Claude Code | Claude.ai / Desktop |
|---|---|---|
| Kimlik | `Authorization: Bearer mk_live_…` | OAuth 2.1 access token |
| Çözüm | mevcut `ApiKeysService.authenticate()` | `mcp-oauth` modülünün token doğrulaması |
| Faz | 1 | 3 |

MCP spec'i authorization'ı **OPTIONAL** tanımlar, dolayısıyla statik Bearer + OAuth ikilisi spec'e aykırı değildir.

### 5.1 OAuth 2.1 gereksinimleri

Resource server (biz) için **MUST**:

- `/.well-known/oauth-protected-resource/mcp` — RFC 9728 Protected Resource Metadata
- Canonical resource URI: `https://<host>/mcp`
- Token audience doğrulaması — RFC 8707 `resource` parametresi bize işaret etmeli; etmiyorsa 401
- 401 yanıtı: `WWW-Authenticate: Bearer resource_metadata="…", scope="…"`
- Yetersiz scope: 403 + `WWW-Authenticate: Bearer error="insufficient_scope", scope="…", resource_metadata="…"` (istemcide step-up akışını tetikler)

Authorization server (biz) için:

- `/.well-known/oauth-authorization-server` — RFC 8414 metadata, içinde `client_id_metadata_document_supported: true`
- `/oauth/authorize` — PKCE zorunlu; mevcut login'i kullanan **onay ekranı** (hangi workspace, hangi scope'lar)
- `/oauth/token` — authorization_code + refresh_token
- Authorization yanıtında `iss` (RFC 9207) ve metadata'da `authorization_response_iss_parameter_supported: true`

### 5.2 Client registration — DCR yazılmıyor

Güncel MCP spec'i Dynamic Client Registration'ı (RFC 7591) **deprecated** ilan etti ve **MAY** seviyesine indirdi. Yerine gelen **Client ID Metadata Documents (CIMD)**: istemci `client_id` olarak bir HTTPS URL verir, biz o URL'den metadata'yı çeker ve doğrularız.

Yapılacak: URL formatlı `client_id` tespiti → dokümanı çek → `client_id`'nin URL ile birebir eşleştiğini doğrula → `redirect_uris` kontrolü → HTTP cache header'larına saygı göstererek cache'le.

**DCR bu tasarımda yazılmıyor.** Gerekirse sonradan opsiyonel fallback olarak eklenir.

### 5.3 Scope uyumsuzluğu ve geçiş

Bugünkü `ApiKey.scopes` yalnızca `['read','write']` taşıyor; `ApiKeyGuard` HTTP metoduna göre karar veriyor. MCP tool'ları ise granüler scope ilan ediyor (`leads:write`, `ads:spend`, `inbox:send`…).

Çözüm — **mevcut API key'ler kırılmaz**:

- Granüler scope'lar tanımlanır (`<domain>:<read|write|send|publish|spend>`)
- Eski `read` → tüm `*:read` scope'larına, eski `write` → tüm `*:write` scope'larına genişletilir (eşleme tablosu, tek yerde)
- Yeni API key'ler doğrudan granüler scope alabilir
- OAuth token'ları scope'u consent ekranından alır

---

## 6. Tool yüzeyi (~35)

Her tool `McpToolRegistry`'ye `scopes` + `risk` (`READ`/`WRITE`/`SPEND`) + `requiresApproval` ilan ederek kaydedilir; girdi şeması Zod ile tipli.

| Dikey | Tool'lar | Risk |
|---|---|---|
| **workspace** | listele, aktif workspace seç, mevcut mod bilgisi | READ |
| **leads / opportunities** | ara, getir, oluştur, güncelle, aşama değiştir, not ekle | READ / WRITE |
| **inbox** | konuşma listele, mesajları oku, **yanıt gönder** | READ / **SEND (onay kapılı)** |
| **campaigns** | listele, detay, metrikler, **başlat/durdur** | READ / **PUBLISH** |
| **social** | planlanmış içerik listele, taslak oluştur, **yayınla** | READ / WRITE / **PUBLISH** |
| **ads / budget** | performans, ROAS, **bütçe değiştir** | READ / **SPEND** |
| **analytics** | rapor çek, funnel, atıf | READ |
| **brand-brain** | marka profili sorgula, kaynak getir | READ |
| **scheduling** | randevu listele, uygunluk, randevu oluştur | READ / WRITE |

Yüksek riskli olanlar (`SEND` / `PUBLISH` / `SPEND`) broker tarafından **zaten** onay kuyruğuna alınıyor — transport'ta ek iş yok.

---

## 7. Yazma politikası — workspace başına mod

### Şema değişikliği

`Workspace` modeline yeni alan:

```prisma
mcpWriteMode  String  @default("APPROVAL")  // APPROVAL | AUTONOMOUS
```

### Davranış

- **`APPROVAL`** (varsayılan, tüm tenant'lar): bugünkü davranış — `requiresApproval` olan tool inline çalışmaz, `ApprovalRequest` kuyruğuna girer, `PENDING_APPROVAL` + `approvalId` döner
- **`AUTONOMOUS`** (operatör workspace'i): riskli işlemler inline çalışır; **denetim kaydı yine zorunludur** (§8)

Broker'ın `invoke()` metodundaki mevcut onay dalı bu modu okuyacak şekilde genişletilir. Bu, broker'da yapılan **tek** değişikliktir.

### Migration

Prisma migration + **`down.sql` ile geri alınabilir** (proje konvansiyonu: 143 migration'ın 47'sinde `down.sql` mevcut). `up` idempotent (`IF NOT EXISTS`), `down` yalnızca eklenen kolonu düşürür ve tekrar çalıştırılabilir. Round-trip (up → down → up) doğrulanacak.

Ayar OWNER'a açılır; ops toggle'ı olarak connector yönetim ekranından yönetilir (Faz 4).

---

## 8. Denetim açığı — bu tasarımın en kritik maddesi

`McpBrokerService.log()` şu satırı içeriyor:

```ts
if (!ctx.agentRunId) return; // logging is tied to an agent run
```

`ToolCallLog.runId` zorunlu bir alan ve `AgentRun`'a cascade ile bağlı. Sonuç: **transport bir `AgentRun` açmazsa, dışarıdaki Claude'un her tool çağrısı sıfır denetim iziyle, sessizce çalışır.**

Bu mevcut kodda bir hata değil — MCP transport'u hiç yazılmadığı için tetiklenmemiş bir boşluk. Ama transport yazıldığı anda aktif bir güvenlik açığına dönüşür.

### Karşılığı

1. Her MCP oturumu açılışta bir `AgentRun` yaratır: `agent: 'mcp'`, `goal` = istemci adı + oturum tanımlayıcısı, `input` = bağlanan workspace/scope özeti

   > `AgentRun.agent` bir `String`; şemada kısıt yok ama üstündeki yorum satırı izinli değerleri sayıyor (`researcher | strategist | …`). `mcp` bu listeye eklenir — yalnızca yorum güncellemesi, migration gerektirmez.

2. O oturumdaki **tüm** tool çağrıları bu `agentRunId` ile geçer
3. Oturum kapanışında `finishedAt` + `status` yazılır
4. **`agentRunId` olmadan gelen çağrı reddedilir** — loglanmadan çalışmasına izin verilmez

(4) maddesi bir regresyon testiyle kilitlenir.

---

## 9. Hata yönetimi

| Durum | Yanıt |
|---|---|
| Bilinmeyen tool | Broker `NotFoundException` → MCP hata yanıtı |
| Eksik scope | HTTP 403 + `insufficient_scope` challenge (istemcide step-up tetikler) |
| Geçersiz/süresi dolmuş token | HTTP 401 + `resource_metadata` challenge |
| Yanlış audience (`resource` bize işaret etmiyor) | HTTP 401 |
| Argüman > 32 KB | Broker `ForbiddenException` |
| Onay kuyruğuna düşen çağrı | **Hata değil** — `PENDING_APPROVAL` + `approvalId` içeren yapılandırılmış sonuç; Claude kullanıcıya "onayına düştü" diyebilir |
| `agentRunId` yok | Çağrı reddedilir (§8) |

---

## 10. Test stratejisi

- **Korunur:** `mcp-broker.service.spec.ts` mevcut hâliyle geçmeye devam etmeli
- **Transport birim testleri:** iki auth yolunun aynı context'e çözülmesi, `AgentRun` yaşam döngüsü, broker istisnalarının MCP hatalarına eşlenmesi
- **Tool testleri:** her tool için şema doğrulaması ve scope zorlaması
- **Write-mode testleri:** `APPROVAL` modunda riskli tool'un kuyruğa düştüğü, `AUTONOMOUS` modunda çalıştığı — **her iki durumda da `ToolCallLog` yazıldığı**
- **Regresyon testi:** `agentRunId` olmadan çağrı reddedilir
- **OAuth e2e:** metadata endpoint'lerinin spec şekline uyduğu, PKCE zorunluluğu, yanlış audience'lı token'ın reddedildiği, CIMD doğrulaması (`client_id` ≠ URL → red)
- **Migration:** up → down → up round-trip

---

## 11. Fazlama

| Faz | Kapsam | Çıktı |
|---|---|---|
| **1** | Transport + Bearer auth + `AgentRun` oturumu + 5 salt-okunur tool | Claude Code'dan bağlanılıp okuma yapılabilir |
| **2** | Tool kataloğu ~35'e çıkar; `mcpWriteMode` alanı + migration + broker mod dalı | Tam kontrol düzlemi, operatör workspace'i otonom |
| **3** | `mcp-oauth` modülü: metadata endpoint'leri, authorize/token, consent ekranı, CIMD | Claude.ai / Desktop connector'ü açılır |
| **4** | Connector yönetim UI'ı: bağlı istemciler, oturum ve denetim görünümü, mod toggle'ı | Tenant'lara sunulabilir hâle gelir |

**Faz 1'in 5 tool'u** (dikey başına birer temsilci, uçtan uca doğrulama için):
`workspace.list`, `leads.search`, `campaigns.list`, `analytics.report`, `brand.query`. Beşi de `READ`; yazma yolu Faz 2'ye kadar hiç açılmaz.

**Plan ayrışması:** bu doküman connector programının tamamını tanımlar, tek bir implementasyon planı değil. Faz 1–2 tek plan olarak yürütülür. Faz 3 (OAuth authorization server) kendi başına ayrı bir alt sistemdir ve **kendi planını alır**; Faz 4 (yönetim UI'ı) Faz 3 bittikten sonra ayrıca planlanır.

---

## 12. Kapsam dışı

- **Dynamic Client Registration (RFC 7591)** — spec'te deprecated; CIMD yeterli
- **MCP resources ve prompts primitifleri** — yalnızca tools açılıyor
- **Tool search / `defer_loading`** — 35 tool bunu gerektirmiyor; katalog 100'ü aşarsa yeniden değerlendirilir
- **Kalan 680+ endpoint** — kürasyon dışı bırakıldı
- **stdio transport** — yalnızca remote HTTP

---

## 13. Riskler

| Risk | Etki | Karşılık |
|---|---|---|
| SDK v2 GA'sı 1 günlük | API kayması, erken bug'lar | Yüzey izole (yeni endpoint); imzalar kurulu pakete karşı sabitlenir; v1'e geçiş yolu açık |
| MCP auth spec'i draft | İleride uyum işi | Yalnızca MUST maddeleri implemente edilir; CIMD/DCR ayrımı tek dosyada izole |
| `AUTONOMOUS` modda insan kapısı kalkar | Yanlış işlem doğrudan uygulanır | Varsayılan `APPROVAL`; `AUTONOMOUS` yalnızca OWNER tarafından açılır; denetim kaydı her modda zorunlu |
| Granüler scope geçişi | Mevcut API key'ler bozulabilir | Eski `read`/`write` eşleme tablosuyla genişletilir; geçiş testle kilitlenir |
