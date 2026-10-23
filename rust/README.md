# Jeeta — Rust çalışma alanı

Jeeta'nın Rust ile yeniden yazımı: tek ikili (`jeeta`), altıgen (hexagonal) mimaride ayrılmış crate'ler.
Tasarım belgesi: `docs/superpowers/specs/2026-10-22-jeeta-rust-yeniden-yazim-design.md`.

İkilinin iki alt komutu vardır:

| Komut | Ne yapar |
|---|---|
| `jeeta serve` | HTTP sunucusu: panel (`/`), panelin JSON API'si (`/api/*`), `/healthz` ve MCP uç noktası (`/mcp`), tek dinleyicide |
| `jeeta mcp-stdio` | MCP araçlarını stdin/stdout üzerinden, `JEETA_STDIO_API_KEY` anahtarı adına sunar; HTTP yoktur |
| `jeeta --help` | Kullanımı yazdırır |

Bilinmeyen bir komut kullanımı yazdırır ve `2` koduyla çıkar. Yapılandırma, veritabanı bağlantısı, veritabanı
rolü ya da göç hatası tek, okunur bir satır yazdırır (ör.
`jeeta: configuration: JEETA_SECRET_KEY: must be 64 hexadecimal characters …`) ve `1` koduyla çıkar.

## Önkoşullar

- [rustup](https://rustup.rs). `rust-toolchain.toml` sürümü (Rust 1.96.0) ve `rustfmt`/`clippy`
  bileşenlerini ilk `cargo` çağrısında kendisi kurar.
- cargo-deny 0.19: `cargo install cargo-deny --locked`
- PostgreSQL **14 veya üstü** (yerelde ve CI'da 16). Taban sürümü iki deyim belirler: göçteki
  `create or replace trigger` 14 ister; test veritabanlarını silen `drop database … with (force)` 13 ister.
- Panel için Node 24 ve pnpm 9.

## Yerelde çalıştırma

1. Veritabanı ve uygulama rolü. Rol **süper kullanıcı olmamalı** ve `BYPASSRLS` taşımamalıdır (bkz.
   [Satır düzeyi güvenlik](#satır-düzeyi-güvenlik-rls-ve-veritabanı-rolleri)); öyleyse `jeeta` açılmayı
   reddeder. Yönetici olarak:

   ```sh
   psql postgres://postgres@localhost:5432/postgres <<'SQL'
   create role jeeta login password 'yerel-bir-parola' nosuperuser nobypassrls nocreatedb nocreaterole;
   create database jeeta owner jeeta;
   SQL
   ```

2. Ayarlar. `.env` git'e girmez; sırlar yalnızca orada durur:

   ```sh
   cd rust
   cp .env.example .env
   # .env içinde en azından:
   #   JEETA_DATABASE_URL=postgres://jeeta:yerel-bir-parola@localhost:5432/jeeta
   #   JEETA_SECRET_KEY=<openssl rand -hex 32 çıktısı>
   #   JEETA_COOKIE_SECURE=false        (yalnızca http://localhost için)
   #   JEETA_PANEL_DIR=panel/dist
   ```

3. Panel ve sunucu:

   ```sh
   make panel-install panel-build   # panel/dist
   make dev                         # cargo run --locked -p jeeta -- serve
   ```

   İkili önce `rust/.env`'i, yoksa çalışılan dizindeki `.env`'i okur; ortamda zaten tanımlı değişkenler
   dosyadakileri ezer. Açılışta sırasıyla: veritabanına bağlanır, rolün RLS'i atlamadığını denetler,
   bekleyen göçleri uygular (boş bir veritabanında `migrations are up to date applied=4 total=4`),
   yapılandırılmışsa ilk platform operatörünü açar, sonra dinlemeye başlar:

   ```text
   INFO jeeta::serve: jeeta is listening bind=127.0.0.1:8080 panel=served from panel/dist allowed_hosts=0 migrations_applied=4
   ```

   `curl -s localhost:8080/healthz` → `{"ok":true}`; tarayıcıda `http://127.0.0.1:8080/` paneli açar.

4. Durdurma: `Ctrl-C` (SIGINT) ya da SIGTERM. Sunucu yeni bağlantı almayı bırakır, açık bağlantılara
   en çok 10 saniye tanır, sonra kapanır (açık bir MCP olay akışı bu süreyi doldurur).

### Göçler

`migrations/` içindeki her göç bir `NNNN_ad.up.sql` / `NNNN_ad.down.sql` çiftidir; ikisi de yeniden
çalıştırılabilir (idempotent) ve `jt_pg/tests/migrations.rs` bütün kümeyi yukarı → aşağı → yukarı
döndürür. Beş göç vardır:

| Göç | Ne yapar |
|---|---|
| `0001_foundation` | çalışma alanları, kullanıcılar, oturumlar, roller, üyelikler, API anahtarları, ajan bağlantıları, günlük, platform operatörleri |
| `0002_strategy` | strateji sürümleri, hipotezler, istişare kaydı |
| `0003_capabilities` | kabiliyetler (bildiren ajan bağlantısı `declared_by_connection` dahil), gruplar (adı alan içinde büyük/küçük harf ayırmadan tek: `capability_groups_name_ci`, `lower(name)` üzerinde), bütçe kalemleri ve bağları, harcama kaydı, çalışma alanı politikaları |
| `0004_role_permissions_backfill` | M1a'dan önce açılmış alanların sistem `owner` ve `manager` rollerine `capabilities.manage` ve `budget.manage` izinlerini ekler (özel rollere ve `rep`'e dokunmaz; `down` yalnız bu iki anahtarı o iki rolden çıkarır) ve ajan yoklamasının son kaydını bulan kısmi dizini (`ledger_entries_agent_connection_idx`, yalnız `action = 'work.checkin'` satırları) açar |
| `0005_connectors` | gelen olaylar (`inbound_events`: alan, sağlayıcı ve sağlayıcının kimliği başına bir kez; ham gövde ayrı sütunda; bir tetikleyici yalnız `processed_at`'in yazılmasına ve `raw`'ın silinmesine izin verir, satır silinmez), bekleyen OAuth akışları (`oauth_pending`: imzalı durumun özeti bütün alanlarda tek, PKCE doğrulayıcısı ve varlıklar mühürlü; yeniden bağlama akışı yenilediği kabiliyeti `capability_id` ile adlar), prob kayıtları (`probe_runs`, yalnız eklenir); bütçe kalemlerine emekliye ayrılma zamanı (`budget_items.retired_at`, canlı kalemde `null`; `down` yalnız bu sütunu düşürür) |

**Geliştirme veritabanını yeniden açın.** `0002`, `0003` ve `0004` M1a sırasında, yayımlanmadan önce
değiştirildi (en son: `0003`'e `capabilities.declared_by_connection` sütunu ve grup adlarının büyük/küçük
harf ayırmayan benzersiz dizini eklendi, `0004`'ün yoklama dizini yalnız `work.checkin` satırlarını
tutar oldu); `0005` de M1b sırasında yayımlanmadan önce değişiyor (en son: `budget_items.retired_at`
sütunu eklendi). Bu göçlerin eski
bir hâlini uygulamış bir veritabanında `jeeta serve` sağlama toplamı (checksum) uyuşmazlığıyla durur
(`migration 3 was previously applied but has been modified`). Veritabanını yönetici olarak silip
yeniden açın, `jeeta serve` göçleri baştan uygular:

```sh
psql postgres://postgres@localhost:5432/postgres \
  -c 'drop database if exists jeeta with (force)' -c 'create database jeeta owner jeeta'
```

Yayımlanmış bir göç bundan sonra değişmez; her değişiklik yeni bir göçtür.

## Yapılandırma

Bütün değişkenler `.env.example` içinde yer tutucularla listelidir. İsteğe bağlı bir değişkenin boş
bırakılması tanımsız sayılır. Her hata ilgili değişkeni adıyla söyler; sırların değeri hiçbir hatada ve
hiçbir günlük satırında görünmez.

| Değişken | Varsayılan | Anlamı |
|---|---|---|
| `JEETA_DATABASE_URL` | — (zorunlu) | Uygulamanın PostgreSQL adresi, `postgres://kullanıcı:parola@sunucu:port/veritabanı` |
| `JEETA_SECRET_KEY` | — (zorunlu) | Tam 64 onaltılık karakter (32 bayt): `openssl rand -hex 32`. Açılışta doğrulanır. Sır kutusunun (`jt_seal`) ana anahtarıdır: bağlayıcı sırları, her çalışma alanı için bundan türetilen ayrı bir anahtarla mühürlenir (bkz. [Sırların mühürlenmesi](#sırların-mühürlenmesi)). Değiştirilirse önceden mühürlenmiş sırlar açılamaz |
| `JEETA_BIND` | `127.0.0.1:8080` | Dinlenen `ip:port` |
| `JEETA_PANEL_DIR` | — | Derlenmiş panelin dizini; göreli bir yol **çalışılan dizine** göredir: `rust/` içinden (`make dev`) `panel/dist`, depo kökünden `rust/panel/dist`. Yoksa yalnızca API ve MCP sunulur. `index.html` bulunmazsa açılış günlüğü bunu söyler |
| `JEETA_COOKIE_SECURE` | `true` | Oturum çerezlerinde `Secure`. Yalnızca düz `http://localhost` için `false` |
| `JEETA_ALLOWED_HOSTS` | — | MCP uç noktasının `Host` başlığında kabul ettiği genel adlar, virgülle: `jeeta.example.com,jeeta.example.com:8443`. Döngü (loopback) adları her zaman kabul edilir. `JEETA_BIND` döngü adresi değilse zorunludur |
| `JEETA_PLATFORM_BOOTSTRAP_EMAIL` | — | İlk platform operatörünün e-postası; parolayla birlikte verilir |
| `JEETA_PLATFORM_BOOTSTRAP_PASSWORD` | — | İlk platform operatörünün parolası (en az 12 karakter); e-postayla birlikte verilir |
| `JEETA_STDIO_API_KEY` | — | `jeeta mcp-stdio` kipinin kullandığı API anahtarı (`jt_live_…`) |
| `JEETA_LOG` | `info,rmcp=warn` | `tracing` süzgeci, ör. `info,rmcp=warn,jeeta=debug`. Kendi süzgecinizde `rmcp=warn`'u koruyun: rmcp her yeni MCP oturum kimliğini (`Mcp-Session-Id`) `info` düzeyinde yazar |
| `JEETA_LOG_FORMAT` | `compact` | `compact` ya da `json`. Günlükler stderr'e yazılır |
| `JEETA_ALLOW_SUPERUSER` | `false` | `true` ise veritabanı rolü süper kullanıcı ya da `BYPASSRLS` olsa da açılır ve bir `WARN` satırı yazar (çalışma alanı yalıtımı uygulanmaz). **Yalnızca yerel geliştirme için**; üretimde asla |
| `JEETA_ALLOW_TEST_LOOPBACK` | kapalı | `1` (ya da `true`) ise `jt_outbound`'un `test-loopback` özelliğiyle derlenmiş bir ikili de açılır ve bir `WARN` satırı yazar; kapalıyken böyle bir ikili açılışı reddeder (bkz. [Üretim notları](#üretim-notları)). **Yalnızca yerel test için**; üretimde asla |

Erişim günlüğü her istek için yalnızca yöntemi, rota şablonunu (`/api/team/{membership_id}`), durumu ve
süreyi yazar; ham yol ve sorgu dizesi hiç yazılmaz. Rotası olmayan istekler (panel sayfaları ve dosyaları,
`/invite/<jeton>` dahil) `route="-"`, operatör girişi `route="<redacted>"` olarak görünür.

## İlk platform operatörü

Platform operatörü çalışma alanlarını görür ve durumlarını değiştirir; kullanıcılardan ayrı bir tablodadır ve
yalnızca açılışta oluşturulur:

1. `.env` içine ikisini birden yazın: `JEETA_PLATFORM_BOOTSTRAP_EMAIL=op@example.com` ve
   `JEETA_PLATFORM_BOOTSTRAP_PASSWORD=<en az 12 karakter>`. Yalnızca biri doluysa açılış durur.
2. `make dev`. Günlük `platform operator created` der; operatör zaten varsa (hangi e-postayla olursa olsun)
   `platform operator already present` der ve hiçbir şey yazılmaz.
3. İlk açılıştan sonra parolayı `.env`'den silin (ikisini birden silin).
4. Konsol: `http://127.0.0.1:8080/platform/login`. API'den:

   ```sh
   curl -i -X POST localhost:8080/api/platform/login \
     -H 'Content-Type: application/json' -H 'X-Requested-With: jeeta-panel' \
     -d '{"email":"op@example.com","password":"…"}'      # 200, Set-Cookie: jt_platform=…
   ```

## Kayıt

Panelde `http://127.0.0.1:8080/register`. Kayıt, kullanıcıyı ve onun sahibi olduğu yeni bir çalışma alanını
açar; alan `pending_payment` durumunda başlar ve operatör konsolundan (`/platform/workspaces`) etkinleştirilir.

**Etkinleşmeden önce alan kilitlidir.** Çalışma alanı durumu denetimi stratejiden bağımsızdır: `auth.*`,
`workspace.*` ve `platform.*` her durumda çalışır; `strategy.*` ve `work.*` alan `active` ya da
`pending_payment` iken çalışır, `suspended` iken çalışmaz; geri kalan her kullanım durumu (`team.*`, `roles.*`,
`api_keys.*`, `agents.*`, `ledger.*`, `capability.*`, `budget.*`) yalnız alan `active` iken çalışır. Çalışmayan
bir çağrı, panelden de MCP'den de, `423 {"code":"WORKSPACE_INACTIVE","details":{"status":"pending_payment"}}`
(ya da `"suspended"`) alır. Yani ödeme bekleyen bir alan operatör onu etkinleştirene kadar üye davet edemez ve
API anahtarı açamaz; giriş, çıkış, `GET /api/auth/me`, `GET /api/workspace`, alan değiştirme, strateji
istişaresi (bkz. [Strateji](#strateji)) ve bekleyen işler (bkz. [Sırada ne var](#sırada-ne-var)) çalışır.
Ödeme bekleyen bir alan stratejiyi hazırlayıp onaylayabilir ama alan etkinleşene kadar kabiliyet
bildiremez (`capability.*` ve `budget.*` yalnız `active` alanda çalışır). Askıya alınan bir alanda yalnız
giriş, çıkış, oturum ve alan bilgisi çalışır: strateji ve bekleyen işler de kapanır, askıdaki bir alana
bekleyen bir davet de kabul edilemez. API'den (değişiklik yapan her istek
`X-Requested-With: jeeta-panel` başlığını taşımalıdır, yoksa `403`):

```sh
curl -i -c jar.txt -X POST localhost:8080/api/auth/register \
  -H 'Content-Type: application/json' -H 'X-Requested-With: jeeta-panel' \
  -d '{"email":"owner@example.com","password":"correct horse battery","display_name":"Owner","workspace_name":"Acme"}'
# 201, Set-Cookie: jt_session=…
```

## Bir ajanı MCP'ye bağlama

1. Panelde **API anahtarları** sayfasından (`/api-keys`) bir anahtar açın; çalışma alanı etkin olmalıdır
   (bkz. [Kayıt](#kayıt)). Düz metni (`jt_live_…`) yalnızca bir kez gösterilir. API'den: `POST /api/api-keys`
   gövdesi `{"name":"ajan"}`, oturum çereziyle.
2. Uç nokta `http://127.0.0.1:8080/mcp`, taşıma **streamable HTTP**, kimlik
   `Authorization: Bearer jt_live_…`. Anahtar her istekte doğrulanır; bir MCP oturumu (`Mcp-Session-Id`) onu
   açan anahtara bağlıdır. Bu bağı olmayan bir oturum kimliği (başka bir anahtarın, silinmiş, hiç
   açılmamış ya da bellekteki 10.000 bağın en eskisi olarak düşmüş bir oturum) her anahtar için
   `404 {"code":"NOT_FOUND","message":"unknown session","details":{}}` alır; istemci yeniden
   `initialize` eder. Ajan anahtarın çalışma alanında, anahtarın kapsamlarıyla çalışır. Anahtarı açan
   üye ekipten çıkarıldığında açtığı bütün etkin anahtarlar aynı işlemde iptal edilir (`team.remove`
   kaydı `revoked_api_key_ids` alanında listeler); üye sonra geri davet edilse bile eski anahtarlar çalışmaz.

   Claude Code:

   ```sh
   claude mcp add --transport http jeeta http://127.0.0.1:8080/mcp \
     --header "Authorization: Bearer jt_live_…"
   ```

   Codex (`~/.codex/config.toml`; streamable HTTP destekleyen bir sürüm, anahtar ortam değişkeninde):

   ```toml
   [mcp_servers.jeeta]
   url = "http://127.0.0.1:8080/mcp"
   bearer_token_env_var = "JEETA_API_KEY"
   ```

   Streamable HTTP desteklemeyen bir istemci için [stdio kipi](#stdio-kipi).

3. Elle deneme:

   ```sh
   curl -si -X POST localhost:8080/mcp -H "Authorization: Bearer $KEY" \
     -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
   # 200, Mcp-Session-Id: …; ardından aynı başlıkla notifications/initialized ve tools/list (47 araç)
   ```

   Geçersiz bir anahtar `401 {"code":"UNAUTHENTICATED","message":"invalid api key","details":{}}` alır.

**M1a'dan önce açılmış anahtarlar yeni kapsamları taşımaz.** Kapsamsız açılan bir anahtar, açıldığı an
sahibinin taşıdığı izinleri kapsam olarak saklar; M1a'dan önce açılmış bir anahtarda bu yüzden
`capabilities.manage` ve `budget.manage` yoktur (sahibinin rolü onları göçle almış olsa bile). Ajanın
kabiliyet bildirmesi ya da bütçe kalemi açması için M1a'dan sonra yeni bir anahtar açın.

**Döngü dışı adlar.** MCP uç noktası DNS yeniden bağlama (rebinding) saldırılarına karşı `Host` başlığını
denetler: varsayılan olarak yalnızca `localhost`, `127.0.0.1` ve `::1` kabul edilir, başka her ad `403` alır.
Sunucuya başka bir adla ulaşılıyorsa (genel bir alan adı, ters vekil (reverse proxy) arkasında bile)
`JEETA_ALLOWED_HOSTS` o adı içermelidir. Port yazılmayan bir ad her portta kabul edilir.

## MCP araçları

Sunucu 50 araç tanımlar; `tools/list` her ajana yalnızca anahtarının etkin izinlerinin yettiğini
gösterir (ör. `team.manage` taşımayan bir anahtar ekibi değiştiren araçları görmez). Her açıklama
risk etiketiyle biter (`[risk: READ]`, `WRITE`, `SPEND`, `DESTRUCTIVE`); geri dönüşü olmayan üç araç,
`jeeta.strategy.archive` (strateji kapısını kapatır), `jeeta.capability.retire` (kabiliyeti kesin olarak
emekliye ayırır) ve `jeeta.budget.items_retire` (bütçe kalemini kesin olarak emekliye ayırır), ayrıca
`confirm: true` ister, yoksa `VALIDATION`. Öteki yıkıcı araçlar istemez, çünkü
etkileri onarılabilir: çıkarılan üye yeniden davet edilir, silinen rol ya da grup yeniden açılır, iptal
edilen anahtarın yerine yenisi çıkarılır; bir grup ancak strateji ona başvurmuyorsa silinir (başvuruyorsa
`CONFLICT`), bu yüzden silinen grup yeniden kurulabilir. Yetki onaydan değil rolden gelir: anahtar, çıkaran insanın
rolünü ve izinlerini kapsamı içinde taşır (onay ve arşiv için sahip ya da yönetici + `team.manage`, bkz.
[Strateji](#strateji)). Hatalar yapısaldır: `{"code": …, "message": …, "details": …}` hem
`structuredContent` hem metin olarak döner. Panelde her aracın ikiz bir rotası vardır, yalnızca
ajanın yoklaması (`jeeta.work.checkin`) hariç. Ajanın giriş noktası `jeeta.work.pending`'dir
(bkz. [Sırada ne var](#sırada-ne-var)).

| Alan | Araç | Ne yapar | Risk |
|---|---|---|---|
| ajan | `jeeta.agent.whoami` | Anahtarın kimin adına çalıştığı: ajan bağlantısı, anahtarı çıkaran üye, alan, rol ve etkin izinler | READ |
| alan | `jeeta.workspace.info` | Çalışma alanının kimliği, adı, kısa adı ve durumu | READ |
| ekip | `jeeta.team.list` | Üyeler ve açık davetler | READ |
| | `jeeta.team.invite` | Bir e-postayı bir rolle davet eder; tek seferlik davet jetonunu döndürür | WRITE |
| | `jeeta.team.set_role` | Bir üyenin rolünü değiştirir | WRITE |
| | `jeeta.team.remove` | Bir üyeyi çıkarır (açtığı anahtarlar iptal olur) ya da bir daveti iptal eder | DESTRUCTIVE |
| roller | `jeeta.roles.list` | Sistem ve özel roller, izinleriyle | READ |
| | `jeeta.roles.create` | Özel rol açar | WRITE |
| | `jeeta.roles.update` | Özel rolün izinlerini değiştirir | WRITE |
| | `jeeta.roles.delete` | Kullanılmayan bir özel rolü siler | DESTRUCTIVE |
| API anahtarları | `jeeta.api_keys.create` | Anahtar çıkarır; düz metni yalnızca bu yanıtta görünür | WRITE |
| | `jeeta.api_keys.list` | Anahtarlar, önekleri, kapsamları ve son kullanımları (sırları asla) | READ |
| | `jeeta.api_keys.revoke` | Anahtarı hemen iptal eder | DESTRUCTIVE |
| ajanlar | `jeeta.agents.list` | Bağlanan istemciler: sürüm, kullanılan anahtar, ilk/son görülme, araç çağrısı, `overdue` | READ |
| günlük | `jeeta.ledger.list` | Alanın değişmez günlüğü, en yenisi başta, sır değerleri maskeli | READ |
| strateji | `jeeta.strategy.get` | Onaylı sürüm, açık taslak ve taslağın eksikleri; istişare protokolünü anlatır | READ |
| | `jeeta.strategy.start_consultation` | Taslağı açar (onaylı sürümün kopyası) ya da açık olanı döndürür | WRITE |
| | `jeeta.strategy.record` | İstişareye soru, cevap, varsayım ya da not yazar | WRITE |
| | `jeeta.strategy.write_section` | Taslağın bir bölümünü bütünüyle yazar | WRITE |
| | `jeeta.strategy.set_hypotheses` | Taslağın hipotezlerini yazar (kimliğiyle tutar, kimliksiz ekler, eksik olanı emekliye ayırır) | WRITE |
| | `jeeta.strategy.submit` | Taslağı onaya sunar; eksik varsa `VALIDATION` ve `details.gaps` | WRITE |
| | `jeeta.strategy.approve` | Sunulmuş taslağı okunduğu gibi (`version_id`, `submitted_at`) onaylar, önceki onaylı sürümü arşivler; okunduktan sonra değişmiş bir taslak `CONFLICT` | WRITE |
| | `jeeta.strategy.archive` | Adı verilen onaylı sürümü arşivler, strateji kapısını kapatır | DESTRUCTIVE |
| | `jeeta.strategy.list_versions` | Bütün sürümler, en yenisi başta | READ |
| | `jeeta.strategy.consultation` | Bir sürümün istişare kaydı, sayfa sayfa | READ |
| kabiliyet | `jeeta.capability.list` | Kabiliyetler, etkin durumlarıyla; grup, tür, durum ve kabiliyet grubu süzgeçleri | READ |
| | `jeeta.capability.get` | Tek bir kabiliyet | READ |
| | `jeeta.capability.declare` | Bir kabiliyet bildirir (`declared` başlar) | WRITE |
| | `jeeta.capability.update` | Kabiliyetin adını, açıklamasını ya da dış hesap kimliğini değiştirir; bağlayıcı kabiliyetin hesabı değişirse doğrulaması sıfırlanır ve mühürlü kimlik bilgileri silinir (`verification_reset: true`) | WRITE |
| | `jeeta.capability.verify` | Ajan ya da cihaz kabiliyetini kanıtıyla doğrular (ajan, kendi bağlantısının bildirdiğini `workspace.read` ile) | WRITE |
| | `jeeta.capability.mark_unreachable` | Kabiliyeti nedeniyle ulaşılamaz işaretler | WRITE |
| | `jeeta.capability.set_policy` | Çalışma saatleri, günlük işlem ve harcama tavanı, insan onayı, doğrulama yaşı | WRITE |
| | `jeeta.capability.retire` | Kabiliyeti kesin olarak emekliye ayırır, gruplardan ve bütçe kalemlerinden çıkarır | DESTRUCTIVE |
| | `jeeta.capability.link_budget` | Kabiliyeti türüne uyan bir bütçe kalemine bağlar | WRITE |
| | `jeeta.capability.unlink_budget` | Bütçe bağını kaldırır | WRITE |
| | `jeeta.capability.groups_list` | Kabiliyet grupları, üyeleriyle | READ |
| | `jeeta.capability.groups_create` | Grup açar (marka, şube, amaç …) | WRITE |
| | `jeeta.capability.groups_rename` | Grubu yeniden adlandırır | WRITE |
| | `jeeta.capability.groups_delete` | Grubu siler; üyeler kalır. Stratejinin daralttığı bir grup silinemez (`CONFLICT`) | DESTRUCTIVE |
| | `jeeta.capability.groups_add_member` | Gruba bir kabiliyet ekler | WRITE |
| | `jeeta.capability.groups_remove_member` | Gruptan bir kabiliyeti çıkarır | WRITE |
| bütçe | `jeeta.budget.items_list` | Bütçe kalemleri, dönemdeki harcama ve kalanla | READ |
| | `jeeta.budget.items_create` | Bütçe kalemi açar (tür, birim, tavan, dönem) | WRITE |
| | `jeeta.budget.items_update` | Kalemin adını, tavanını ya da dönemini değiştirir; tür ve birim değişmez | WRITE |
| | `jeeta.budget.items_retire` | Kalemi kesin olarak emekliye ayırır (`confirm: true`): bağları kalkar, bağ ve harcama almaz, harcama geçmişi kalır | DESTRUCTIVE |
| | `jeeta.budget.spend_record` | Bir kaleme harcama yazar; tavan aşılsa da kaydedilir ve işaretlenir | SPEND |
| | `jeeta.budget.spend_list` | Bir kalemin harcamaları, sayfa sayfa | READ |
| iş | `jeeta.work.pending` | Bekleyen işler, stratejinin durumu, ajanın gecikmesi | READ |
| | `jeeta.work.checkin` | Ajanın yoklaması: kaydedilir ve bekleyen işleri döndürür (yalnızca MCP) | WRITE |
| | `jeeta.work.set_checkin_interval` | Beklenen yoklama aralığını değiştirir | WRITE |

## Hatalar

Her başarısız çağrı, panelden de MCP'den de aynı yapıyı döndürür:
`{"code": "<KOD>", "message": "<İngilizce açıklama>", "details": {…}}`. MCP'de başarısız bir araç çağrısı
`is_error: true` taşır ve aynı gövdeyi hem yapılandırılmış hem metin içerik olarak verir.

| Kod | Panel HTTP | Ne zaman |
|---|---|---|
| `UNAUTHENTICATED` | 401 | oturum ya da anahtar yok veya geçersiz |
| `FORBIDDEN` | 403 | yetki yok (`details.permission` eksik izni adlar) |
| `NOT_FOUND` | 404 | kayıt yok ya da bu alanın değil |
| `CONFLICT` | 409 | mevcut durumla çelişki (ör. aynı hesap iki kez) |
| `VALIDATION` | 422 | girdi kurala uymuyor (`details.field` ya da `details.gaps`) |
| `STRATEGY_REQUIRED` | 409 | kapılı bir iş onaylı strateji ister |
| `WORKSPACE_INACTIVE` | 423 | alan etkin değil (`details.status`) |
| `HOST_NOT_ALLOWED` | 403 | dışarıya izinsiz bir adrese gidilmek istendi |
| `UPSTREAM_UNAVAILABLE` | 503 | sağlayıcı meşgul ya da ulaşılamıyor; sonra yeniden denenebilir |
| `INTERNAL` | 500 | beklenmeyen hata; ileti ve ayrıntılar yalnızca günlüğe yazılır, yanıt `"internal error"` ve boş `details` taşır |

`UPSTREAM_UNAVAILABLE` ayrıntıları olduğu gibi iletilir:
`{"code":"UPSTREAM_UNAVAILABLE","message":"the provider is unavailable; try again later","details":{"provider":"meta","retryable":true,"retry_after_s":30,"reason":"rate limited"}}`
(`retry_after_s` yalnız sağlayıcı bekleme süresi söylediğinde vardır; `reason` maskelenmiştir). Bir yoklamanın
(probe) başarısızlığı hata değildir, yoklamanın sonucudur.

## Strateji

Stratejisi onaylanmamış bir alanda stratejiye bağlı (`Gated`) her araç ve rota (bu sürümde henüz yoktur)
`409 {"code":"STRATEGY_REQUIRED"}` alır; kapı, alanın onaylı bir strateji sürümü olup olmadığını her çağrıda
veritabanından okur (`jt_pg::PgStrategyGate`, panel ve MCP için aynı kapı). Strateji kayıtlı bir istişareyle
kurulur; ajan ya da panel aynı adımları izler (`jeeta.strategy.get` açıklaması ajana bu sırayı söyler):

| Adım | Panel | MCP aracı | İzin |
|---|---|---|---|
| Okuma (onaylı sürüm, taslak, eksikler) | `GET /api/strategy` | `jeeta.strategy.get` | `workspace.read` |
| İstişareyi açma | `POST /api/strategy/consultation` | `jeeta.strategy.start_consultation` | `team.manage` |
| Soru, cevap, varsayım, not | `POST /api/strategy/consultation/entries` | `jeeta.strategy.record` | `team.manage` |
| Bölüm yazma | `PUT /api/strategy/draft/sections/{section_key}` | `jeeta.strategy.write_section` | `team.manage` |
| Hipotezler | `PUT /api/strategy/draft/hypotheses` | `jeeta.strategy.set_hypotheses` | `team.manage` |
| Onaya sunma | `POST /api/strategy/draft/submit` | `jeeta.strategy.submit` | `team.manage` |
| Onaylama (gövde `{"version_id": …, "submitted_at": …}`: taslak okunduğu gibi) | `POST /api/strategy/draft/approve` | `jeeta.strategy.approve` | sahip ya da yönetici + `team.manage` |
| Arşivleme (gövde `{"version_id": …, "confirm": true}`; yanıt iki kapıda da `200 {"version_id": …, "archived": true}`) | `POST /api/strategy/archive` | `jeeta.strategy.archive` | sahip ya da yönetici + `team.manage` |
| Sürümler | `GET /api/strategy/versions` | `jeeta.strategy.list_versions` | `workspace.read` |
| İstişare kaydı (`limit`, `before_at` + `before_id`) | `GET /api/strategy/versions/{version_id}/consultation` | `jeeta.strategy.consultation` | `workspace.read` |

Eksikleri olan bir taslak onaya sunulamaz: `422 VALIDATION`, `details.gaps` her eksiği alan yoluyla sayar.
Bir bölüm yazılırken bilinmeyen bir alan, `lane` ya da `period`'u olmayan bir bütçe şeridi ve sınırını aşan
bir metin de `422 VALIDATION` ile reddedilir: kimlik alanları, kanal gerekçesi, segment açıklaması ve hedef en
çok 2.000; adlar, anahtarlar, kanallar, KPI hedefleri ve para birimi en çok 200; her yasak en çok 500
karakter. Saklanmış bir sürüm okunurken bunların hiçbiri uygulanmaz (eksik şerit `organic`, eksik dönem
`monthly` okunur).

**Onayda varsayımlar listelenir ve onay taslağı adlandırır.** Bir taslağın yanıtı (`VersionOut`), istişarede
cevap alınmadan konan varsayımları (`assumptions`: `assumption` türündeki kayıtlar, en yenisi başta) taşır;
onaylı ve arşivlenmiş sürümlerde bu liste boştur. Panel onaylamadan önce bir onay penceresi açar: varsayımları
ve yürürlüğe girecek hipotez sayısını gösterir, istek ancak orada onaylanınca gider. Onay, taslağı okunduğu
gibi adlandırır (`version_id` ve `submitted_at`, `GET /api/strategy`'nin ya da `jeeta.work.pending`'in
verdiği hâliyle); kilitler alındıktan sonra taslak başka bir sürümse ya da o arada yeniden sunulmuşsa
`409 {"code":"CONFLICT","message":"the draft changed since you read it","details":{"version_id": …,
"submitted_at": …}}` döner (ayrıntılar taslağın şimdiki hâlidir) ve hiçbir şey değişmez.
Arşivleme yalnızca adı verilen onaylı sürümü arşivler (başka bir sürüm yürürlükteyse `409`) ve kapıyı
yeniden kapatır. Bir anahtarın kapsamları her zaman daraltır: `team.manage` taşımayan bir sahip anahtarı
istişareyi yürütemez, onaylayamaz ve arşivleyemez. Stratejinin kanalları kabiliyet kaydından okunur
(bkz. [Kabiliyetler](#kabiliyetler)): bir kanal `any` ya da alanın emekliye ayrılmamış bir kabiliyetinin
türüyse (`phone`, `mailbox`, `instagram` …) onaylanabilir; bir kanalın daraltıldığı grup (`group_id`) alanın
bir kabiliyet grubu olmalıdır; bir hipotezin kanalı stratejinin seçtiği kanallardan biri ya da `any`
olmalıdır. Strateji, alan ödeme beklerken de hazırlanıp onaylanabilir (`strategy.*` alan `pending_payment`
iken durum denetiminden muaftır); askıya alınmış bir alanda strateji araçları da `WORKSPACE_INACTIVE` alır
(bkz. [Kayıt](#kayıt)).

**Ajan için istişare protokolü.** İstişare sohbette ajanla sahip arasında geçer; sistem onu yapılandırır
ve kaydeder. Ajan şu sırayı izler:

1. `jeeta.work.pending` bir `consult_strategy` işi gösterir (strateji yok ya da taslak açık).
2. `jeeta.strategy.get`: onaylı sürümü, açık taslağı ve taslağın eksiklerini (`gaps`) okur.
3. `jeeta.strategy.start_consultation`: taslak açar; onaylı bir sürüm varsa taslak onun kopyasıdır ve her
   hipotezi korur. Açık bir taslak varsa onu döndürür, yeniden açmaz.
4. Sahibe açık soruları sohbette sorar ve her soruyu, cevabı, cevapsız koyduğu varsayımı ve notu
   `jeeta.strategy.record` ile yazar (`kind`: `question`, `answer`, `assumption`, `note`; isteğe bağlı
   `section_key`). Metin günlüğe değil istişare kaydına girer. Onaya sunulmuş bir taslağa yazılan varsayım
   sunumu geri çeker (onay varsayımları sahibe okur; günlükte `strategy.submission_withdrawn`); ajan
   taslağı yeniden sunar.
5. `jeeta.strategy.write_section` ile her bölümü bütünüyle yazar: `identity`, `audience`, `channels`,
   `goals`, `budget_frame`, `prohibitions`, `cadence`, `paid_enabled`. Yanıt kalan eksikleri gösterir;
   eksikler yazmayı engellemez.
6. `jeeta.strategy.set_hypotheses` ile hipotezleri yazar: tutulan hipotez kimliğiyle verilir, yenisi
   kimliksiz (ya da `id: null`); onaylı sürümde olup listede olmayan emekliye ayrılır.
7. `jeeta.strategy.submit`: eksik kalmadıysa taslak onaya sunulur; kalmışsa `VALIDATION` ve
   `details.gaps` döner, ajan 4–6'ya döner.
8. Onay sahibin ya da yöneticinin işidir. Ajan önce taslağın varsayımlarını (`jeeta.strategy.get` →
   `draft.assumptions`) sahibe okur; sahip panelde onaylar ya da sohbette onayladığını söyler ve ajan,
   sahibin ya da yöneticinin `team.manage` taşıyan anahtarıyla, okuduğu taslağın `version_id` ve
   `submitted_at` değerleriyle `jeeta.strategy.approve` çağırır (ek kod istenmez; taslak o arada değiştiyse
   `CONFLICT` döner ve ajan yeniden okur). `jeeta.work.pending` artık `{"approved": {"number": …}}` okur.

## Kabiliyetler

Kabiliyet, alanın eylemde bulunabildiği her şeydir: bir hesap, bir cihaz, bir ajan bağlantısı, bilgisayar
erişimi ya da üçüncü taraf bir araç. Türler, on grupta 49 anahtarlık kapalı bir listedir; listede olmayan
bir tür `422 VALIDATION` alır, `third_party` içindeki `other` türü ise aracın adını `key_detail` alanında
ister (`[a-z0-9_-]`, 2–40 karakter). Aynı türden birden çok kabiliyet olabilir (iki SMS hattı, iki ajan
bağlantısı); aynı dış hesap (tür ve `external_id`) ise emekliye ayrılmamış tek bir kabiliyette durur.
Kabiliyet araçları strateji kapısından muaftır (istişare alanın neye sahip olduğunu bilmek ister), çalışma
alanı durumu denetiminden muaf değildir.

| Grup (ulaşım yolu) | Türler (anahtar: paneldeki ad) |
|---|---|
| `social_account` Sosyal hesaplar (bağlayıcı) | `instagram`: Instagram, `facebook_page`: Facebook sayfası, `x`: X, `linkedin_page`: LinkedIn sayfası, `tiktok`: TikTok, `pinterest`: Pinterest, `youtube`: YouTube, `google_business`: Google İşletme Profili |
| `messaging` Mesajlaşma (bağlayıcı) | `whatsapp_cloud`: WhatsApp Business, `instagram_dm`: Instagram mesajları, `messenger`: Messenger, `sms_line`: SMS hattı, `mailbox`: E-posta kutusu, `webchat`: Web sohbeti |
| `telephony` Telefon (bağlayıcı) | `netgsm_pbx`: NetGSM santrali |
| `community` Topluluk (bağlayıcı) | `discord`: Discord, `reddit`: Reddit, `review_google`: Google yorumları, `review_facebook`: Facebook yorumları |
| `ads` Reklam (bağlayıcı) | `meta_ads`: Meta reklamları, `tiktok_ads`: TikTok reklamları, `linkedin_ads`: LinkedIn reklamları, `google_ads`: Google reklamları |
| `calendar` Takvim (bağlayıcı) | `google_calendar`: Google Takvim, `outlook_calendar`: Outlook takvimi |
| `device` Cihazlar (cihaz) | `phone`: Telefon, `computer`: Bilgisayar, `printer`: Yazıcı, `printer_3d`: 3B yazıcı, `audio_io`: Ses giriş/çıkışı, `camera`: Kamera, `screen`: Ekran, `scanner`: Belge tarayıcı, `usb_storage`: USB bellek |
| `agent_connection` Ajan bağlantıları (ajan) | `claude_code`: Komut satırı kod ajanı, `codex`: Kod ajanı, `claude_ai`: Web sohbet asistanı, `other_agent`: Başka bir ajan |
| `computer_access` Bilgisayar erişimi (ajan) | `filesystem_root`: Dosya sistemi, `browser_profile`: Tarayıcı profili, `shell`: Kabuk, `adb`: Android hata ayıklama köprüsü, `screen_control`: Ekran denetimi |
| `third_party` Üçüncü taraf araçlar (ajan) | `notion`: Notion, `slack`: Slack, `gmail`: Gmail, `apify`: Apify, `firecrawl`: Firecrawl, `other`: Başka bir araç (`key_detail` ile) |

**Ajan kendi ellerini nasıl bildirir.** Ajan, kendi tuttuğu bir cihazı (`phone`, `printer` …) ya da
erişimi (`shell`, `adb`, `browser_profile` …) `jeeta.capability.declare` ile bildirir; kabiliyet
`declared` durumunda başlar. Sonra `jeeta.capability.verify` ile kanıtını verir: ne çalıştırdığı ya da
ne gördüğü (`evidence.text`) ve isteğe bağlı dayanaklar (`evidence.refs`: seri numarası, dosya ya da ekran
görüntüsü kimliği). Kanıt ajanın beyanı olarak kaydedilir, sistem onu denetlemez; doğrulama, politikanın
`verify_max_age_days` süresi (varsayılan 30 gün) dolunca `stale` okunur ve ajan yeniden doğrular.
Bildirilen kabiliyet onu bildiren ajan bağlantısını saklar (`declared_by_connection`; bir kişi bildirdiyse
`null`). Bir ajan bir ajan ya da cihaz kabiliyetini yalnızca `workspace.read` ile ancak **kendi bağlantısı
bildirdiyse** doğrulayabilir; başka bir bağlantının ya da bir kişinin bildirdiğini doğrulamak için
`capabilities.manage` ister (yoksa `403`, `details.permission = "capabilities.manage"`). Panelde bir kişi her
zaman `capabilities.manage` ister. Bağlantı, anahtar ve istemci adı ile sürümüne bağlıdır: istemcinin sürümü
değişince yeni bir bağlantı açılır. Bağlayıcıyla (connector) ulaşılan hesaplar (`mailbox`, `instagram`, reklam
hesapları …) bir beyanla doğrulanamaz (`409`), kendi yoklamalarıyla (probe) doğrulanır; bağlayıcılar M1b ile
gelir. Bir bağlayıcının ulaşacağı adresler `connector_public.hosts` alanında bildirilir ve yalnızca genel
(public) adresler kabul edilir. Emekliye ayrılan bir kabiliyetin mühürlü kimlik bilgileri aynı işlemde
silinir. `connector_public` hiçbir sır taşımaz: sır gibi görünen bir anahtar adı,
her derinlikte, `422 VALIDATION` alır; bu, günlüğün maskeleme listesindeki adlar (`password`, `token`,
`api_key`, `plaintext` …) ile adında büyük/küçük harf ayırmadan `pass`, `secret`, `token`, `key`, `auth` ya
da `credential` geçen her addır (`token_count`, `author` da reddedilir).

**Çıkış (egress) denetimi.** Bir adres iki anda denetlenir. Bildirildiği an yalnızca metniyle (IP adresi
yazımları ve yalnız özel ağların çözdüğü ad kalıpları); bağlanırken de DNS koruması, adın çözüldüğü
adresleri aynı bloklara göre süzer: genel olmayan her adres atılır (özel ağlar, geri döngü, bağlantı-yerel,
CGNAT gibi blokların tek ve eksiksiz listesi `jt_outbound::validate_public_host` belgesindedir; iki denetim
aynı kodu kullanır); geriye adres kalmazsa ya da ad çözülmezse istek hiçbir soket açılmadan düşer
(DNS korumasının reddi `HOST_NOT_ALLOWED`, `details.reason = "no_public_address"`). Koruma sağlayıcıların sabit
adreslerine de uygulanır; böylece genel görünen bir ad özel bir adrese çözülse (DNS yeniden bağlama) bile
ona ulaşılmaz. HTTP dışındaki bağlantılar (M2'nin SMTP/IMAP soketleri) aynı denetimi
`jt_outbound::resolve_public` ile paylaşır. Kiracı adresleri bellekte tutulur;
`jt_outbound::rebuild_tenant_hosts` onları kabiliyet kayıtlarından (emekliye ayrılmamış bağlayıcı
kabiliyetlerinin `connector_public.hosts` alanı) yeniden kurar, açılışa bağlanması M1b'nin son adımıyla gelir.
Yalnızca `https` kabul edilir; tek istisna bir sağlayıcı kısıtıdır: NetGSM Netsantral'in tıkla-ara ucu
yalnız düz `http` sunar, bu yüzden `crmsntrl.netgsm.com.tr:9111` yalnızca `netgsm` bağlayıcısının kapsamında
düz `http` ile çağrılır. Testler için `jt_outbound`'un `test-loopback` özelliği (feature), bu makinedeki
sahte sunuculara (`127.0.0.1`) düz `http` ile ulaşmayı ve onları bir bağlayıcının sabit adreslerine
eklemeyi (`Egress::with_test_hosts`) açar; yalnız `[dev-dependencies]` bölümleri açabilir, `bin/jeeta` hiç
açmaz.

| Adım | Panel | MCP aracı | İzin |
|---|---|---|---|
| Liste (`group`, `kind`, `status`, `group_id` süzgeçleri) | `GET /api/capabilities` | `jeeta.capability.list` | `workspace.read` |
| Okuma | `GET /api/capabilities/{capability_id}` | `jeeta.capability.get` | `workspace.read` |
| Bildirme | `POST /api/capabilities` | `jeeta.capability.declare` | `capabilities.manage` |
| Düzenleme (`{"name"?, "description"?, "external_id"?}`, en az biri; yanıt: kabiliyet ve `verification_reset`) | `PATCH /api/capabilities/{capability_id}` | `jeeta.capability.update` | `capabilities.manage` |
| Doğrulama (gövde `{"evidence": {"text": …, "refs": […]}}`) | `POST /api/capabilities/{capability_id}/verify` | `jeeta.capability.verify` | ajan: kendi bağlantısının bildirdiğine `workspace.read`, başkasınınkine `capabilities.manage`; kişi: `capabilities.manage` |
| Ulaşılamaz işaretleme (`{"reason": …}`) | `POST /api/capabilities/{capability_id}/unreachable` | `jeeta.capability.mark_unreachable` | `capabilities.manage` |
| Politika (gövde politikanın kendisi) | `PUT /api/capabilities/{capability_id}/policy` | `jeeta.capability.set_policy` | `capabilities.manage` |
| Emekliye ayırma (`{"confirm": true}`) | `POST /api/capabilities/{capability_id}/retire` | `jeeta.capability.retire` | `capabilities.manage` |
| Bütçe kalemine bağlama | `POST /api/capabilities/{capability_id}/budget-links` | `jeeta.capability.link_budget` | `capabilities.manage` |
| Bağı kaldırma (yanıt: kabiliyetin kendisi) | `DELETE /api/capabilities/{capability_id}/budget-links/{budget_item_id}` | `jeeta.capability.unlink_budget` | `capabilities.manage` |
| Gruplar | `GET /api/capability-groups` | `jeeta.capability.groups_list` | `workspace.read` |
| Grup açma, adlandırma | `POST /api/capability-groups`, `PATCH /api/capability-groups/{group_id}` | `jeeta.capability.groups_create`, `groups_rename` | `capabilities.manage` |
| Grup silme (yanıt: `{"group_id": …, "deleted": true}`; onaylı sürüm ya da açık taslak bir kanalı ona daraltmışsa `409`, `details.version_ids`) | `DELETE /api/capability-groups/{group_id}` | `jeeta.capability.groups_delete` | `capabilities.manage` |
| Grup üyeliği (yanıt: grubun kendisi) | `POST /api/capability-groups/{group_id}/members`, `DELETE …/members/{capability_id}` | `jeeta.capability.groups_add_member`, `groups_remove_member` | `capabilities.manage` |
| Bütçe kalemleri | `GET /api/budget/items` | `jeeta.budget.items_list` | `workspace.read` |
| Bütçe kalemi açma | `POST /api/budget/items` | `jeeta.budget.items_create` | `budget.manage` |
| Bütçe kalemi düzenleme (`{"name"?, "cap"?, "period"?}`, en az biri) | `PATCH /api/budget/items/{budget_item_id}` | `jeeta.budget.items_update` | `budget.manage` |
| Bütçe kalemini emekliye ayırma (`{"confirm": true}`) | `POST /api/budget/items/{budget_item_id}/retire` | `jeeta.budget.items_retire` | `budget.manage` |
| Harcama bildirme (`{"amount": …, "reference": …}`) | `POST /api/budget/items/{budget_item_id}/spend` | `jeeta.budget.spend_record` | `workspace.read` |
| Harcamalar (`limit`, `before_at` + `before_id`) | `GET /api/budget/items/{budget_item_id}/spend` | `jeeta.budget.spend_list` | `workspace.read` |

Her değişiklik iki kapıda da aynı yanıtı verir: panel rotası, `DELETE` rotaları dahil, ikiz MCP aracının
döndürdüğü JSON'u döndürür (açma `201`, gerisi `200`). Panelde sorgu parametresi alan her liste ve sayfa
ucu (`GET /api/ledger`, `GET /api/capabilities`, `GET /api/budget/items/{budget_item_id}/spend`,
`GET /api/strategy/versions/{version_id}/consultation`) tanımadığı bir parametreyi yok saymaz,
`422 VALIDATION` ile reddeder.

Bütçe kalemleri alanın kendi parası ve tavanlarıdır (sistemin kredisi değil). Kalemin birimi türüne uyar:
nakit, reklam ve SMS bütçesi bir para birimiyle (en küçük biriminde, ör. kuruş), ajan kotası ve sarf
malzeme bir sayı birimiyle, ajan çalışma saati dakikayla; uymayan `422 VALIDATION`
(`details.reason = "unit_mismatch"`). Bir kabiliyet yalnızca türüne uyan kaleme bağlanır (reklam
hesabı reklam bütçesine ya da nakde, SMS hattı SMS bütçesine ya da nakde, ajan bağlantısı ajan kotasına ya
da çalışma saatine, yazıcılar sarf malzemeye ya da nakde, gerisi nakde). Harcama tavanı aşsa da kaydedilir
ve `budget.over_cap` kaydıyla işaretlenir; bağlayıcıların harcamasında tavan M3'te sert sınır olur.

**Düzenleme.** Bir kabiliyetin adı, açıklaması ve dış hesap kimliği (`external_id`) bildirimdeki
kurallarla değiştirilir: bildirimde, düzenlemede ve kimlik bilgisi girişinde üçü de kırpılır, boş kalan
ad ya da dış kimlik ve denetim karakteri (satır sonu …) taşıyan dış kimlik `422 VALIDATION`
(sağlayıcının yoklamada bildirdiği hesap kimliği ise olduğu gibi karşılaştırılır); verilmeyen alan
olduğu gibi kalır, hiçbir alan vermeyen düzenleme `422 VALIDATION` (`details.fields`). Türü, ulaşılma
yolu, bağlayıcı ayarları (`connector_public`) ve politikası bu yolla değişmez; gövdede başka bir alan
`422`. Türünün başka bir canlı kabiliyetinin tuttuğu hesap `409 CONFLICT` (`details.kind_key`,
`details.external_id`). Bağlayıcıyla ulaşılan bir kabiliyetin hesabı değişirse eski hesabı kanıtlayan
hiçbir şey yenisini kanıtlamaz: kabiliyet yeniden `declared` okunur, doğrulama zamanı ve kanıtı silinir,
mühürlü kimlik bilgileri düşer ve yanıt `verification_reset: true` taşır; eski hesabı anlatan genel
bilgiler de gider (son yoklama `health`, yoklama bilgileri `facts`, OAuth varlığı `asset`, `account`,
düşen kimlik bilgisinin `access` bilgileri), `provider` ve `hosts` kalır. Bağlayıcı sağlığı
(`connector.health`) son yoklamayı `connector_public.health` alanından okur, böylece yeni bağ hiç
yoklanmamış görünür. Hesap yeniden bağlanır, sonra yoklanır. Bir ajan ya da cihaz kabiliyetinin kimliği
değişince doğrulaması kalır. Günlük kaydı `capability.update` değişen alanların adlarını (`fields`),
değiştiyse yeni adı ve dış kimliği, hesap değişimi doğrulamayı sıfırladıysa `rebind: true` taşır;
açıklamanın metnini asla. Bağlayıcıların yazdığı `connector_public` anahtarları (`access`, `account`,
`asset`, `facts`, `health`, `provider`, `reconnect_required`) bildirimde reddedilir (`422 VALIDATION`,
"reserved public key", `details.gaps`); `hosts` bildirilebilir, bağlayıcı kendi adreslerini ona ekler.

Bir bütçe kaleminin adı, tavanı ve dönemi değiştirilir; türü ve birimi değişmez (gövdede `kind` ya da `unit`
`422`). Dönemde harcanandan düşük bir tavan kabul edilir: harcama kayıtlı kalır, kalem tavanı aşmış okunur.
Günlük kaydı `budget.items.update` değişen alanları ve önceki değerlerini (`previous`) taşır. Bir kalemi
emekliye ayırmak (`confirm: true` ister) kesindir: bütün bağları aynı işlemde kalkar (`budget.items.retire`,
`links_removed`), harcama geçmişi kalır, listede `retired_at` ile görünmeye devam eder; artık bir kabiliyete
bağlanamaz, harcama almaz ve düzenlenemez (`409 CONFLICT`, "budget item is retired").

Emekliye ayırma kesindir: kabiliyet gruplarından ve bütçe kalemlerinden aynı işlemde çıkar, kaydı kalır;
emekliye ayrılmış bir kabiliyet artık düzenlenemez, doğrulanamaz, ulaşılamaz işaretlenemez, bir gruba
eklenemez, bir kaleme bağlanamaz ve politikası değişmez (`409 CONFLICT`, "capability is retired"). Politikanın çalışma
saatleri yarı açık bir aralıktır: `from` 0–23, `to` 1–24 (`24` gün sonundaki gece yarısı; `18`–`24`
akşam, `0`–`24` bütün gün), `from < to`; gece yarısını aşan bir pencere iki günün pencereleri olarak
yazılır.

Sistem rollerinin izinleri:

| İzin | Sahip | Yönetici | Temsilci |
|---|---|---|---|
| `workspace.read` | ✓ | ✓ | ✓ |
| `team.manage` | ✓ | ✓ | — |
| `api_keys.manage` | ✓ | ✓ | — |
| `ledger.read` | ✓ | ✓ | — |
| `capabilities.manage` (kabiliyetleri ve grupları değiştirme) | ✓ | ✓ | — |
| `budget.manage` (bütçe kalemi açma, düzenleme, emekliye ayırma) | ✓ | ✓ | — |

`capabilities.manage` ve `budget.manage` M1a ile geldi. Yeni bir alanın sahip ve yönetici rolleri onları
açılışta alır; M1a'dan önce açılmış alanlarınkine `0004_role_permissions_backfill` göçü ekler (bkz.
[Göçler](#göçler)). Özel rollere kendiliğinden eklenmezler: bir özel role sahibi ya da yöneticisi verir.

Bir API anahtarının kapsamları sahibinin izinlerini daraltır: yalnızca `workspace.read` taşıyan bir anahtarla
ajan okur, kendi bağlantısının bildirdiği kabiliyeti doğrular ve harcama bildirir, ama bildiremez,
gruplayamaz, başkasının bildirdiğini doğrulayamaz ve kalem açamaz.

Grup adları alan içinde büyük/küçük harf ayırmadan tektir ("Marka A" ile "marka a" aynı addır); kullanım
durumu bunu yazmadan önce denetler, veritabanı da `capability_groups_name_ci` dizini ile (`lower(name)`)
zorlar: dizine takılan bir yazma da `409 CONFLICT` alır.

## Sırada ne var

Ajanın giriş noktası `jeeta.work.pending`'dir (panelde `GET /api/work/pending`, ana sayfanın verisi): stratejinin
durumu, en acil olanı başta bekleyen işler ve ajanın son görülme uyarısı. Strateji kapısından muaftır, çalışma
alanı durumu denetiminden ise alan ödeme beklerken muaftır: ajan, strateji yokken ve alan ödeme beklerken de
neyin beklediğini sorabilir; askıya alınmış bir alanda `work.*` de `WORKSPACE_INACTIVE` alır.

- **`strategy`**: `"missing"` (ne onaylı sürüm ne taslak), `{"draft_open": {"gaps": […]}}` (taslak üzerinde
  çalışılıyor), `{"submitted": {"version_id": …, "submitted_at": …}}` (taslak onay bekliyor; onay bu iki
  değeri geri gönderir) ya da `{"approved": {"number": 2}}`. Açık ya da sunulmuş bir taslak, yürürlükte onaylı
  bir sürüm olsa bile gösterilir: bekleyen iş odur.
- **`items`**: her biri `kind`, `priority` (1 en acil) ve ajan için İngilizce bir `hint` taşır; panel kendi
  metnini gösterir.

| `kind` | Öncelik | Ne zaman |
|---|---|---|
| `consult_strategy` | 1 | strateji hiç yok ya da açık (sunulmamış) bir taslak var |
| `approve_strategy` | 1 | sunulmuş bir taslak var ve soran onaylayabilir (sahip ya da yönetici + `team.manage`) |
| `verify_capability` (`capability_id`, `name`, `stale`) | 2 | ajan ya da cihazla ulaşılan, `declared` ya da `stale` okunan her kabiliyet |
| `reconnect_connector` (`capability_id`, `name`) | 1 | bağlayıcıyla ulaşılan, sağlayıcısı girişini artık kabul etmediği için (yoklama `auth` hatası, `connector_public.reconnect_required`) `unreachable` okunan her kabiliyet |
| `connect_connector` (`capability_id`, `name`) | 2 | bağlayıcıyla ulaşılan, `declared` okunan her kabiliyet (bağlayıcılar M1b ile gelir) |
| `declare_first_capability` | 3 | emekliye ayrılmamış hiçbir kabiliyet yok |

- **`agent`**: `last_seen_at` (alanın ajan bağlantılarından en son görüleni, hiç yoksa `null`),
  `interval_minutes` (yoklama aralığı) ve `overdue` (hiç bağlantı yok ya da en son görülen aralıktan eski).
  `GET /api/agents` ve `jeeta.agents.list` her bağlantı için aynı `overdue` bayrağını verir. Panelde ana
  sayfanın ajan kartı gecikmeyi kırmızı bir uyarıyla, **Ajanlar** sayfası her bağlantının satırında
  "Gecikti" ya da "Zamanında" olarak gösterir.

**Ajanın yoklaması.** Ajanı uyandırmak sistemin değil kiracının işidir: ajan kendi zamanlayıcısıyla en az
yoklama aralığında bir `jeeta.work.checkin` çağırır (yanıtı `jeeta.work.pending` ile aynıdır, ama yoklayan
bağlantı o an görülmüş sayılır: geç kalmış bir ajan yokladığında `agent.overdue` `false` okur); geç kaldığında
sistem yalnızca uyarır. Yoklama yalnızca bir ajanın çağrısıdır, panelde rotası yoktur (`mcp_only`); bir kişi
çağıramaz (`403 FORBIDDEN`, `details.reason = "agents_only"`). Ajanın her çağrısı bağlantısının
`last_seen_at` alanını zaten günceller; yoklama ise bağlantı başına en çok saatte bir `work.checkin` olarak
kaydedilir (bağlantının son yoklama kaydı, yalnız `work.checkin` satırlarını tutan kısmi
`ledger_entries_agent_connection_idx` dizininden okunur; sorgu eylemi dizinle aynı sabitle adlandırır).
Yoklamanın kayıt işlemi, bekleyen işler okunmadan önce biter: eşzamanlı yoklamalar havuzdaki bağlantıları
birbirini bekleyerek tüketmez. Aralık
çalışma alanı başınadır (`workspace_policies`), 15 dakika ile bir hafta arasıdır; varsayılanı bir gündür.

| Adım | Panel | MCP aracı | İzin |
|---|---|---|---|
| Bekleyen işler | `GET /api/work/pending` | `jeeta.work.pending` | `workspace.read` |
| Yoklama (yalnızca ajan) | — | `jeeta.work.checkin` | `workspace.read` |
| Yoklama aralığı (gövde `{"minutes": 15…10080}`, varsayılan 1440) | `PUT /api/work/checkin-interval` | `jeeta.work.set_checkin_interval` | `team.manage` |

## stdio kipi

Ajanın Jeeta'yı yerel bir süreç olarak çalıştırdığı istemciler için:

```sh
JEETA_STDIO_API_KEY=jt_live_… cargo run -q -p jeeta -- mcp-stdio
```

Codex örneği:

```toml
[mcp_servers.jeeta]
command = "/yol/jeeta"
args = ["mcp-stdio"]
env = { JEETA_DATABASE_URL = "postgres://…", JEETA_SECRET_KEY = "…", JEETA_STDIO_API_KEY = "jt_live_…" }
```

- Anahtar **yalnızca açılışta** doğrulanır; süreç, kapanana kadar anahtarın o anki izinleriyle çalışır.
  Anahtarı iptal etmek ya da sahibinin rolünü düşürmek ancak bir sonraki açılışta etkili olur (ertelenmiş
  sertleştirme: HTTP uç noktası ise anahtarı her istekte yeniden doğrular).
- stdout MCP akışıdır; günlükler stderr'e gider.
- Bu kip göç uygulamaz ve operatör açmaz: veritabanı önce `jeeta serve` ile hazırlanmış olmalıdır. Diğer
  değişkenler (`JEETA_DATABASE_URL`, `JEETA_SECRET_KEY` …) `serve` ile aynı kurallarla doğrulanır.

## Test veritabanı

Veritabanına dokunan testler, `JEETA_TEST_DATABASE_URL` ile verilen yönetici (admin) adresindeki sunucuda
kendi geçici veritabanlarını açar ve siler. Docker ile yerel bir sunucu:

```sh
docker run -d --name jeeta-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16-alpine
export JEETA_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
```

Testler bu değeri `.env` dosyasından değil, ortam değişkeninden okur.

Panelin HTTP yüzeyini süreç içinde süren yardımcılar (`jt_testkit::panel`) `jt_testkit`'in `panel`
özelliğinin arkasındadır; onu yalnızca testleri paneli süren `jt_panel_http` ve `jeeta` açar. Böylece
`cargo test -p jt_app` paneli derlemez; `cargo test --workspace` ise özellikleri birleştirir ve bütün
testleri çalıştırır.

Bu adresin rolü süper kullanıcı olmalıdır, ama testler bu rolle çalışmaz: her test
`jt_test_<12 onaltılık>` adlı bir veritabanı ve aynı adlı, rastgele parolalı, sıradan bir oturum rolü
(`NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`) açar, veritabanını o role verir, göçleri ve sorguları o
rolle çalıştırır; test bitince ikisini de siler. Yönetici bağlantısı yalnızca açma ve silme içindir. Yeni
veritabanı `template0`'dan kopyalanır; bu yüzden adres `template1` dahil herhangi bir mevcut veritabanını
gösterebilir.

## Satır düzeyi güvenlik (RLS) ve veritabanı rolleri

Kiracı tabloları (`roles`, `memberships`, `api_keys`, `agent_connections`, `ledger_entries`,
`strategy_versions`, `strategy_hypotheses`, `consultation_entries`, `capabilities`,
`capability_groups`, `capability_group_members`, `budget_items`, `capability_budget_links`,
`budget_spend_entries`, `workspace_policies`) ve `workspaces`,
`ENABLE` + `FORCE ROW LEVEL SECURITY` ile korunur: bir satır yalnızca işlem içinde `app.workspace_id` o
çalışma alanını gösterdiğinde ya da `app.platform = 'on'` olduğunda görünür ve yazılabilir. Bu ayarları
yalnızca `jt_pg`'nin `TenantTx`, `PlatformTx` ve `UserTx` işlemleri koyar.

PostgreSQL, `FORCE` olsa bile süper kullanıcılara ve `BYPASSRLS` rollerine RLS uygulamaz. **Üretimde
uygulama, `JEETA_DATABASE_URL` içinde süper kullanıcı olmayan ve `BYPASSRLS` taşımayan sıradan bir rolle
bağlanmalıdır**; aksi halde çalışma alanları arasındaki yalıtım sessizce ortadan kalkar. Tabloların sahibi
bu rol olabilir (`FORCE` sahibi de bağlar).

Bu yüzden `jeeta serve` ve `jeeta mcp-stdio`, bağlandıktan hemen sonra ve göçlerden önce
`select rolsuper or rolbypassrls from pg_roles where rolname = current_user` sorar; sonuç doğruysa rolü
adıyla söyleyen tek satırı yazdırıp `1` koduyla çıkar:

```text
jeeta: the database role `postgres` in JEETA_DATABASE_URL is a superuser or has BYPASSRLS, so row-level security would not isolate workspaces; connect as an ordinary role (NOSUPERUSER NOBYPASSRLS, see rust/README.md), or set JEETA_ALLOW_SUPERUSER=true for local development only
```

`JEETA_ALLOW_SUPERUSER=true` bu denetimi yalnızca yerel geliştirme için geçer ve her açılışta yalıtımın
uygulanmadığını söyleyen bir `WARN` satırı yazar.

Hedef düzen iki roldür: şemanın sahibi olan ve göçleri uygulayan bir **göç rolü**, ve yalnızca veri
işlemleri (`select`/`insert`/`update`/`delete`) yetkisi olan ayrı bir **çalışma rolü**. M0'da `jeeta serve`
göçleri her açılışta `JEETA_DATABASE_URL` ile kendisi uyguladığından bu rol şimdilik şemanın sahibi
olmalıdır; göçleri ayrı bir adımda göç rolüyle çalıştırmak sonraki bir kilometre taşına kalmıştır.

## Sırların mühürlenmesi

`JEETA_SECRET_KEY` M1a'dan beri kullanılır: bağlayıcı sırları (bir hesabın parolası ya da erişim jetonu)
veritabanına (`capabilities.connector_sealed`) yalnızca onunla mühürlenmiş olarak yazılır; mühürlü baytları
ya da açılmış sırrı hiçbir kullanım durumu, günlük kaydı ya da panel yanıtı geri döndürmez (bir kabiliyet
yalnızca `has_sealed_config` bayrağını taşır). Mühürleme `jt_seal` içindedir ve uygulama ona `SecretBox`
kapısından (port) ulaşır:

- Her çalışma alanının anahtarı `JEETA_SECRET_KEY`'den HKDF-SHA256 ile türetilir (tuz `jeeta-seal-v1`,
  bilgi alanı çalışma alanı kimliğinin 16 baytı). Bellekte yalnızca ana anahtar durur; türetilen anahtar
  tek bir çağrı boyunca yaşar ve ardından silinir. HKDF'nin ara anahtarını (PRK) tutan HMAC-SHA-256
  durumları da: `sha2` `zeroize` özelliğiyle derlenir, her SHA-256 durumu düşerken kendini siler.
- Biçim `v1 || nonce || şifreli metin`: bir sürüm baytı (`0x01`), her mühürde yeniden çekilen rastgele
  96 bitlik bir nonce, ardından AES-256-GCM şifreli metni ve 128 bitlik etiketi. Çalışma alanı kimliği
  ayrıca ek doğrulanmış veridir (AAD): bir alanın mühürlü sırrı başka bir alanın satırına kopyalansa
  bile açılmaz.
- Başka bir alanın, başka bir anahtarın ya da değiştirilmiş veya kesilmiş bir mührün açılması
  nedenini söylemeden `INTERNAL` "sealed data cannot be opened" ile reddedilir.
- **Anahtarı değiştirmeyin.** `JEETA_SECRET_KEY` değişirse önceden mühürlenmiş bütün bağlayıcı
  yapılandırmaları açılamaz olur ve o bağlayıcılar yeniden bağlanmalıdır; anahtar döndürme (eski anahtarla
  açıp yenisiyle yeniden mühürleme) sonraki bir kilometre taşına kalmıştır. Anahtarı yedekleyin: veritabanı
  yedeği onsuz bu sırları geri getiremez.

## Üretim notları

- Yayın ikilisi yalnızca `cargo build --release --locked -p jeeta` ile derlenir. Bir crate
  `jt_outbound`'un `test-loopback` özelliğini `[dev-dependencies]` içinde açtığında, tüm çalışma alanını
  kapsayan bir test ya da `--all-targets` derlemesi özelliği `jt_outbound`'a da katar; o derlemenin ürettiği
  `jeeta` ikilisi dış isteklerle bu makineye düz `http` ile ulaşabilir. Böyle bir ikili (`serve` de
  `mcp-stdio` da) açılışta durur ve hatada özelliği ve bu derleme komutunu adıyla söyler;
  `JEETA_ALLOW_TEST_LOOPBACK=1` bu denetimi yalnızca yerel test için geçer.
- TLS'i bir ters vekil sonlandırır; `JEETA_COOKIE_SECURE=true` (varsayılan) kalır.
- Her yanıt (panel, API, `/healthz`, MCP) `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`
  ve `Content-Security-Policy: frame-ancestors 'none'` taşır; ters vekil bunları silmemeli.
- Sunucuya ulaşılan genel ad `JEETA_ALLOWED_HOSTS` içinde olmalıdır; `JEETA_BIND` döngü adresi değilse
  (ör. `0.0.0.0:8080`) bu değişken boşken açılış durur.
- `JEETA_LOG_FORMAT=json` her olayı tek satırlık JSON olarak stderr'e yazar.
- Süreç yöneticisinin durdurma süresi 10 saniyelik boşaltmadan uzun olmalıdır.

## Denetimler

```sh
make check   # fmt + lint + doc + deny + test (JEETA_TEST_DATABASE_URL gerekli)
```

| Hedef | Komut |
|---|---|
| `make fmt` | `cargo fmt --all -- --check` |
| `make lint` | `cargo clippy --locked --workspace --all-targets -- -D warnings` |
| `make doc` | `RUSTDOCFLAGS="-D warnings" cargo doc --locked --workspace --no-deps` |
| `make deny` | `cargo deny --locked check` |
| `make test` | `cargo test --locked --workspace` |
| `make dev` | `cargo run --locked -p jeeta -- serve` |
| `make panel-install` / `panel-test` / `panel-build` | `panel/` içinde pnpm |

CI (`.github/workflows/rust.yml`) `rust/**` ya da iş akışı dosyası değiştiğinde, `main` ve `feat/**`
dallarına gönderimde ve her çekme isteğinde çalışır: `rust-checks` (fmt, clippy, doc, cargo-deny),
`rust-test` (PostgreSQL 16 hizmetiyle `cargo test --workspace`) ve `panel` (`pnpm install --frozen-lockfile`,
`pnpm test`, `pnpm typecheck`, `pnpm build`). `fmt` dışındaki her `cargo` komutu, CI'da da `make` ile de
(`make dev` dahil), `--locked` çalışır: `Cargo.lock` yeniden çözümlenmez, kilit dosyası güncel değilse iş
durur (bir bağımlılık değiştiğinde kilit dosyasını bir kez düz `cargo build` ile güncelleyip işleyin).

## Sınırlar

Crate sınırları iki yerden denetlenir; ikisi de `make check` içinde çalışır:

- `crates/jt_archtest`: alan (domain) crate'leri (`jt_tenancy`, `jt_ledger`, `jt_strategy`, `jt_capability`)
  yalnızca `serde`, `serde_json`, `uuid`, `time`, `thiserror` ve birbirlerini (`jt_tenancy`, `jt_ledger`)
  kullanır; `jt_app` hiçbir adaptöre bağlı değildir; `reqwest` yalnızca `jt_outbound`'da, `sqlx` yalnızca
  `jt_pg`'de (havuz kurmak için `jt_testkit` ve `jeeta`'da da), şifreleme ve anahtar türetme kütüphaneleri
  (`aes-gcm`, `hkdf`) yalnızca `jt_seal`'de bulunur; `jt_outbound`'un `test-loopback` özelliğini yalnız
  `[dev-dependencies]` bölümleri açar, `bin/jeeta` hiç açmaz. Aynı crate kapı kurallarını da sabitler: strateji
  kapısından yalnızca `auth.`, `workspace.`, `team.`, `roles.`, `api_keys.`, `agents.`, `platform.`,
  `strategy.`, `capability.`, `budget.`, `work.` önekli kullanım durumları ve `ledger.list` muaf olabilir;
  çalışma alanı durumu denetiminden her durumda tam olarak `auth.`, `workspace.`, `platform.` önekliler,
  yalnız `pending_payment` iken de tam olarak `strategy.`, `work.` önekliler muaftır; panel rotaları ve
  MCP araçları kataloğun tam karşılığıdır, MCP'ye özgü tek kullanım durumu `work.checkin`'dir ve kayıt
  47 araç tutar.
- `deny.toml`: aynı HTTP istemcisi ve `sqlx` kuralları (`reqwest` dışında hiçbir HTTP istemcisi, `ureq`,
  `isahc`, `surf`, `attohttpc`, `curl`, ağacın hiçbir yerinde bulunmaz) ile yapay zekâ, medya üretimi, ses
  tanıma ve ses sentezi sağlayıcı kütüphanelerinin bağımlılık ağacının hiçbir yerinde bulunmaması; lisans,
  güvenlik bildirimi ve kaynak denetimleri. Bir crate'in iki sürümü yalnızca `[bans] skip` listesinde
  nedeniyle yazılıysa kabul edilir (ör. `sqlx` 0.8'in kullandığı önceki RustCrypto kuşağı: `hkdf` 0.12,
  `hmac` 0.12, `sha2` 0.10, `digest` 0.10); `cargo deny check` uyarısız geçer.
