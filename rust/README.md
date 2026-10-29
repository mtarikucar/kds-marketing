# Jeeta — Rust çalışma alanı

Jeeta'nın Rust ile yeniden yazımı: tek ikili (`jeeta`), altıgen (hexagonal) mimaride ayrılmış crate'ler.
Tasarım belgesi: `docs/superpowers/specs/2026-10-22-jeeta-rust-yeniden-yazim-design.md`.

İkilinin iki alt komutu vardır:

| Komut | Ne yapar |
|---|---|
| `jeeta serve` | HTTP sunucusu: panel (`/`), panelin JSON API'si (`/api/*`), `/healthz`, MCP uç noktası (`/mcp`) ve sağlayıcıların webhook kapısı (`/hooks/*`), tek dinleyicide; ayrıca zamanlanmış işler |
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
   #   JEETA_PRICE_MINOR=<işletmenin belirlediği pozitif küçük birim tutarı>
   #   JEETA_PRICE_CURRENCY=<üç büyük ASCII harfi>
   #   JEETA_BANK_INSTRUCTIONS=<havale bilgileri>
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
   INFO jeeta::serve: provider apps: OAuth needs a configured app; webhook and redirect addresses need the public base URL providers="none" public_base_url="unset (JEETA_PUBLIC_BASE_URL)"
   INFO jeeta::serve: jeeta is listening bind=127.0.0.1:8080 panel=served from panel/dist allowed_hosts=0 migrations_applied=4
   ```

   İlk satır hangi sağlayıcı uygulamalarının yapılandırıldığını (yalnız adları: `meta`, `instagram`,
   `x`; kimlik ya da sır asla) ve genel adresi yazar (bkz. [Sağlayıcı uygulamaları](#sağlayıcı-uygulamaları)).

   `curl -s localhost:8080/healthz` → `{"ok":true}`; tarayıcıda `http://127.0.0.1:8080/` paneli açar.

4. Durdurma: `Ctrl-C` (SIGINT) ya da SIGTERM. Sunucu yeni bağlantı almayı bırakır, açık bağlantılara
   en çok 10 saniye tanır, sonra kapanır (açık bir MCP olay akışı bu süreyi doldurur).

### Göçler

`0005`/`0006`, #360/#361 birleştirilene kadar yerinde değişebilir; yerel veritabanları yeniden oluşturulur.

`migrations/` içindeki her göç bir `NNNN_ad.up.sql` / `NNNN_ad.down.sql` çiftidir; ikisi de yeniden
çalıştırılabilir (idempotent) ve `jt_pg/tests/migrations.rs` bütün kümeyi yukarı → aşağı → yukarı
döndürür. On yedi göç vardır:

| Göç | Ne yapar |
|---|---|
| `0001_foundation` | çalışma alanları, kullanıcılar, oturumlar, roller, üyelikler, API anahtarları, ajan bağlantıları, günlük, platform operatörleri |
| `0002_strategy` | strateji sürümleri, hipotezler, istişare kaydı |
| `0003_capabilities` | kabiliyetler (bildiren ajan bağlantısı `declared_by_connection` dahil), gruplar (adı alan içinde büyük/küçük harf ayırmadan tek: `capability_groups_name_ci`, `lower(name)` üzerinde), bütçe kalemleri ve bağları, harcama kaydı, çalışma alanı politikaları |
| `0004_role_permissions_backfill` | M1a'dan önce açılmış alanların sistem `owner` ve `manager` rollerine `capabilities.manage` ve `budget.manage` izinlerini ekler (özel rollere ve `rep`'e dokunmaz; `down` yalnız bu iki anahtarı o iki rolden çıkarır) ve ajan yoklamasının son kaydını bulan kısmi dizini (`ledger_entries_agent_connection_idx`, yalnız `action = 'work.checkin'` satırları) açar |
| `0005_connectors` | gelen olaylar (`inbound_events`: alan, sağlayıcı ve sağlayıcının kimliği başına bir kez; ham gövde ayrı sütunda; bir tetikleyici yalnız `processed_at`'in yazılmasına ve `raw`'ın silinmesine izin verir, satır silinmez; geçmiş için en yenisi başta bir dizin), bekleyen OAuth akışları (`oauth_pending`: imzalı durumun özeti bütün alanlarda tek, PKCE doğrulayıcısı ve varlıklar mühürlü; akışın oturum açtığı uygulama `app`; yeniden bağlama akışı yenilediği kabiliyeti `capability_id` ile adlar), prob kayıtları (`probe_runs`, yalnız eklenir; bir tetikleyici her değişikliği ve 30 günden genç bir kaydın silinmesini reddeder); bütçe kalemlerine emekliye ayrılma zamanı (`budget_items.retired_at`, canlı kalemde `null`; `down` yalnız bu sütunu düşürür) |
| `0006_inbox` | Gelen kutusu için 13 alan tablosu (36 toplam): kişiler, kimlikler, konuşmalar, mesajlar, yolculuklar ve olayları, görevler, notlar, birleştirmeler, kayıp nedenleri, tüketici kayıtları, gönderim kuyruğu ve 24 saatlik istek anahtarları. FORCE RLS ve bileşik yabancı anahtarlar; varsayılan kayıp nedenleri ve sistem rollerinin gelen kutusu izinleri geriye dönük eklenir. |
| `0007_inbox_policy` | Alan politikalarına `inbox_policy` sütunu ekler; mevcut durum etiketlerini korur, yeni tablo eklemez. |
| `0008_inbox_compliance` | İzinler, engellemeler, teklifler, randevular, komisyonlar, silme kayıtları ve kimlik özetleri, gönderim işleri, posta imleçleri, varsayılan/kullanıcı komisyon oranları ve değişmez yolculuk atfı: 12 yeni alan tablosu, toplam 48. FORCE RLS, bileşik alan anahtarları ve yinelenebilir up/down. |
| `0009_studio` | Growth Studio tenant persistence: 14 tables, total 62; durable claims, replay receipts, learning, spend reservations and reversible owner/manager grant backfill. Includes hypothesis cadence/prior and nullable unit price. |
| `0010_m4_billing` | Payment evidence, permanent entitlement history, stable workspace reference and a platform-only backfill manifest; 66 tables. Schema rollback refuses live rows. |
| `0011_m4_activation_codes` | Workspace-locked keyed activation challenges, attempt cap and replay history; 67 tables. No plaintext or recipient binding. |
| `0012_m4_grandfathered_backfill` | Separate reversible data migration: activated grandfathered grants for existing active workspaces; unchanged, unreferenced migration-owned rows alone can be removed. |
| `0013_probe_reason` | `probe_runs.reason` (the failure line, at most 300 characters) and `unknown` as a legal `error_kind`; down restores the old check only while no `unknown` run is stored. No new table. |
| `0014_social_providers` | `oauth_pending.provider` and `oauth_pending.app` accept `tiktok` and `linkedin`, for their OAuth flows. No new table; `inbound_events` is untouched. |
| `0015_voice_calls` | Voice V0: `call_sessions`, `call_turns`, `call_commands`, `call_duty` (forced RLS, composite keys; 71 tables), `workspace_policies.calls`, `calls.work` for the system owner/manager/rep and `calls.manage` for owner/manager, and the retry columns of `event_consumption` (`attempts`, `retry_at`). Down refuses while a call is not ended. |
| `0016_voice_bridge` | Voice V1: `call_bridge_events` (each event a voice bridge reported, by its `(bridge_call_id, bridge_seq)`; forced RLS; 72 tables), `call_commands.seq` (the queue order commands are handed out in), and `calls.bridge` for the system owner/manager, who issue the bridge's key. No event words or numbers are kept. |
| `0017_device_bridge` | Device bridge D1: `device_commands` (the commands queued for a phone, handed out in `seq` order and answered on their own row), `device_files` (the files the bridges upload, which a result names by id, with the end of their seven-day retention; both forced RLS; 74 tables), and `devices.work` and `devices.bridge` for the system owner/manager; the last is the bridge key's permission, held by them so that they can issue it. `rep` holds none. |

`0008` geri alınırken mevcut `mail` olayları korunur: hiç mail satırı yoksa sağlayıcı CHECK'i
`meta/netgsm/x` değerlerine döner; mail satırı varsa genişletilmiş CHECK kalır. Bu koşullu geri
alma istisnası uygulama verisini silmez ve tekrar çalıştırılabilir.

Silme altyapısında `jeeta.erasure = 'on'` ve `jeeta.erasure_person_id` yalnız işlem içinde
`SET LOCAL` ile ayarlanır; hedefin aynı alandaki `erasure_log` kaydı da gerekir. Yolculuk olaylarının
kişisel metni temizlenebilir, olay kimlikleri, geçişler ve tutarlar korunur. Gelen olayların
`payload.person_id`, prob kayıtlarının `facts.person_id` bağı kullanılır; silme izni başka kişinin
satırını açmaz. `ledger_entries` ve `journey_attribution` bu istisnaya dahil değildir; atıf hiçbir
şekilde değiştirilemez veya silinemez. Tam silme akışı aşağıdaki kişi silme bölümünde açıklanır; bu göç korumaları ve kalıcı veri
sözleşmesini sağlar.


**Geliştirme veritabanını yeniden açın.** `0002`, `0003` ve `0004` M1a sırasında, yayımlanmadan önce
değiştirildi (en son: `0003`'e `capabilities.declared_by_connection` sütunu ve grup adlarının büyük/küçük
harf ayırmayan benzersiz dizini eklendi, `0004`'ün yoklama dizini yalnız `work.checkin` satırlarını
tutar oldu); `0005` de M1b sırasında yayımlanmadan önce yerinde değiştirildi (en son: `oauth_pending.app`
sütunu ve `inbound_events_history_idx` dizini eklendi; ondan önce `probe_runs` tetikleyicisi 30 günden eski
kayıtların silinmesine izin verir oldu ve `budget_items.retired_at` sütunu eklendi). Bu göçlerin eski
bir hâlini uygulamış bir veritabanında `jeeta serve` sağlama toplamı (checksum) uyuşmazlığıyla durur
(`migration 3 was previously applied but has been modified`). Bu yalnız yayından önceki yerel
geliştirme veritabanları içindir: değişmiş bir göç, eski hâlini uygulamış dağıtılmış bir veritabanına asla
uygulanmaz. Yerel veritabanını yönetici olarak silip yeniden açın, `jeeta serve` göçleri baştan uygular:

```sh
psql postgres://postgres@localhost:5432/postgres \
  -c 'drop database if exists jeeta with (force)' -c 'create database jeeta owner jeeta'
```

Yayımlanmış bir göç bundan sonra değişmez; her değişiklik yeni bir göçtür: geri alınabilir bir
`NNNN_ad.up.sql` / `NNNN_ad.down.sql` çifti (`down` yalnız `up`'ın eklediğini kaldırır ve yeniden
çalıştırılabilir).

## Yapılandırma

Bütün değişkenler `.env.example` içinde yer tutucularla listelidir. İsteğe bağlı bir değişkenin boş
bırakılması tanımsız sayılır. Her hata ilgili değişkeni adıyla söyler; sırların değeri hiçbir hatada ve
hiçbir günlük satırında görünmez.

| Değişken | Varsayılan | Anlamı |
|---|---|---|
| `JEETA_PRICE_MINOR` | — (zorunlu) | Tek seferlik fiyat, pozitif tamsayı küçük para birimi |
| `JEETA_PRICE_CURRENCY` | — (zorunlu) | Üç büyük ASCII harfi |
| `JEETA_BANK_INSTRUCTIONS` | — (zorunlu) | Salt okunur havale açıklaması, boş olamaz, en çok 4096 bayt |
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
| `JEETA_JOBS_ENABLED` | `true` | `false` ise `jeeta serve` zamanlanmış işleri (jeton yenileme, yoklamalar, NetGSM yoklamaları, temizlik) hiç başlatmaz ve açılışta bunu günlüğe yazar. Aynı veritabanında birden çok örnek varsa işleri yalnız birinde açık bırakın (bkz. [Zamanlanmış işler](#zamanlanmış-işler)) |
| `JEETA_ALLOW_TEST_LOOPBACK` | kapalı | `1` (ya da `true`) ise `jt_outbound`'un `test-loopback` özelliğiyle derlenmiş bir ikili de açılır ve bir `WARN` satırı yazar; kapalıyken böyle bir ikili açılışı reddeder (bkz. [Üretim notları](#üretim-notları)). **Yalnızca yerel test için**; üretimde asla |
| `JEETA_META_APP_ID` | — | Platformun Meta uygulamasının kimliği (Facebook Login, Graph API, Meta webhook'ları); sırla birlikte verilir |
| `JEETA_META_APP_SECRET` | — | Meta uygulamasının sırrı; kimlikle birlikte verilir |
| `JEETA_META_VERIFY_TOKEN` | — | Meta'nın webhook adresini doğrularken geri yolladığı anahtar; Meta uygulamasıyla **zorunlu**. Kendiniz üretin (`openssl rand -hex 32`) ve Meta panelinde de girin |
| `JEETA_META_LOGIN_CONFIG_ID` | — | İsteğe bağlı: Facebook Login for Business yapılandırma kimliği (boşsa izinler tek tek istenir) |
| `JEETA_META_WHATSAPP_CONFIG_ID` | — | İsteğe bağlı: WhatsApp gömülü kayıt yapılandırma kimliği |
| `JEETA_META_GRAPH_VERSION` | `v19.0` | Graph API sürümü, `v` ve iki sayı (ör. `v21.0`); başka bir biçim açılışı durdurur |
| `JEETA_INSTAGRAM_APP_ID` | — | Platformun Instagram uygulamasının kimliği (Instagram Login); sırla birlikte verilir |
| `JEETA_INSTAGRAM_APP_SECRET` | — | Instagram uygulamasının sırrı; kimlikle birlikte verilir |
| `JEETA_X_CLIENT_ID` | — | Platformun X uygulamasının (OAuth 2.0 gizli istemci) kimliği; sırla birlikte verilir |
| `JEETA_X_CLIENT_SECRET` | — | X uygulamasının istemci sırrı; kimlikle birlikte verilir |
| `JEETA_TIKTOK_CLIENT_KEY` | — | Platformun TikTok uygulamasının (Login Kit, Content Posting API) client key'i; sırla birlikte verilir |
| `JEETA_TIKTOK_CLIENT_SECRET` | — | TikTok uygulamasının client secret'ı; anahtarla birlikte verilir |
| `JEETA_LINKEDIN_CLIENT_ID` | — | Platformun LinkedIn uygulamasının (Sign In with LinkedIn using OpenID Connect, Share on LinkedIn) istemci kimliği; sırla birlikte verilir |
| `JEETA_LINKEDIN_CLIENT_SECRET` | — | LinkedIn uygulamasının istemci sırrı; kimlikle birlikte verilir |
| `JEETA_LINKEDIN_ORG_SCOPES` | kapalı | `1`/`true`: LinkedIn akışları kurum kapsamlarını da ister (`r_organization_social`, `w_organization_social`, `rw_organization_admin`) ve `linkedin_page` bağlanabilir. Yalnız LinkedIn uygulamaya Community Management API'yi onayladıktan sonra açılır (onaysız kapsam isteyen yetkilendirmeyi LinkedIn tümden reddeder); kapalıyken `linkedin_page` akışı `409` `details.reason = "provider_product_not_enabled"`. LinkedIn uygulaması olmadan verilemez |
| `JEETA_LINKEDIN_API_VERSION` | adaptörün sabit sürümü | REST çağrılarının `LinkedIn-Version` başlığı, `YYYYMM`. Sürüm emekliye ayrılınca hata satırı `426` ile sürümü adıyla söyler; LinkedIn uygulaması olmadan verilemez |
| `JEETA_PUBLIC_BASE_URL` | — | Panelin dışarıdan ulaşılan genel adresi: `https://alan-adi` ya da `https://alan-adi:port`; yol, sorgu, parça ya da kullanıcı yok (yalnız yerel geliştirmede `http://localhost:port`). Herhangi bir sağlayıcı uygulaması yapılandırılmışsa **zorunlu**. OAuth yönlendirme adresleri ve webhook adresleri bundan kurulur; boşken akış başlamaz ve webhook adresi gösterilmez (`409`, `details.reason = "public_base_url_not_configured"`) |

**Sağlayıcı değişkenleri.** Her uygulama isteğe bağlıdır ama ancak bütün olarak yapılandırılır:
kimliği ve sırrı birlikte (Meta uygulaması ayrıca doğrulama anahtarıyla). Yarım bir uygulama (kimlik var,
sır yok ya da tersi; Meta uygulaması olmadan bir Meta ayarı) açılışı durdurur ve eksik değişkeni adıyla
söyler, hiçbir değeri yazmaz. `JEETA_PUBLIC_BASE_URL` ile `JEETA_ALLOWED_HOSTS` ayrı işlerdir: genel
adres sağlayıcılara verilen adresin kendisidir (yönlendirme ve webhook adresleri), izinli adlar ise MCP uç
noktasının kabul ettiği `Host` başlıklarıdır; aynı adı ikisine de yazmak gerekebilir. `jeeta serve` ve
`jeeta mcp-stdio` aynı yapılandırmayı okur.

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
açar; alan `pending_payment` durumunda başlar. Operatör ödeme kanıtını doğrular ve tek kullanımlık
etkinleştirme kodunu sahibine iletir; kodun panelde kullanılması M4 Task 4 kapsamındadır.

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
   # 200, Mcp-Session-Id: …; ardından aynı başlıkla notifications/initialized ve tools/list (125 araç)
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

Sunucu 125 araç tanımlar; `tools/list` her ajana yalnızca anahtarının etkin izinlerinin yettiğini
gösterir (ör. `team.manage` taşımayan bir anahtar ekibi değiştiren araçları görmez). Her açıklama
risk etiketiyle biter (`[risk: READ]`, `WRITE`, `SPEND`, `DESTRUCTIVE`); geri dönüşü olmayan üç araç,
`jeeta.strategy.archive` (strateji kapısını kapatır), `jeeta.capability.retire` (kabiliyeti kesin olarak
emekliye ayırır) ve `jeeta.budget.items_retire` (bütçe kalemini kesin olarak emekliye ayırır), ayrıca
`confirm: true` ister, yoksa `VALIDATION`. Birleştirmeyi geri alan
`jeeta.inbox.merges_undo` ve `jeeta.inbox.people_erase` de `DESTRUCTIVE` olarak işaretlidir
ve `confirm: true` ister. Panel, silme onayı için Türkçe `SİL`, İngilizce `ERASE` yazılmasını ister.
Öteki yıkıcı araçlar istemez, çünkü
etkileri onarılabilir: çıkarılan üye yeniden davet edilir, silinen rol ya da grup yeniden açılır, iptal
edilen anahtarın yerine yenisi çıkarılır; bir grup ancak strateji ona başvurmuyorsa silinir (başvuruyorsa
`CONFLICT`), bu yüzden silinen grup yeniden kurulabilir. Yetki onaydan değil rolden gelir: anahtar, çıkaran insanın
rolünü ve izinlerini kapsamı içinde taşır (onay ve arşiv için sahip ya da yönetici + `team.manage`, bkz.
[Strateji](#strateji)). Hatalar yapısaldır: `{"code": …, "message": …, "details": …}` hem
`structuredContent` hem metin olarak döner. Panelde her aracın ikiz bir rotası vardır, yalnızca
ajanın yoklaması (`jeeta.work.checkin`) hariç; panelin ise bir OAuth akışını tamamlayan geri dönüş
rotasının (`connector.complete_oauth`) aracı yoktur: ajan sahibin tarayıcı oturumunu hiç tutmaz (bkz.
[Bağlayıcılar](#bağlayıcılar)). Ajanın giriş noktası `jeeta.work.pending`'dir
(bkz. [Sırada ne var](#sırada-ne-var)).

| Alan | Araç | Ne yapar | Risk |
|---|---|---|---|
| ajan | `jeeta.agent.whoami` | Anahtarın kimin adına çalıştığı: ajan bağlantısı, anahtarı çıkaran üye, alan, rol ve etkin izinler | READ |
| ödeme | `jeeta.billing.report_payment` | Sahip yetkisi ve `team.manage` kapsamında havale kanıtı kaydeder; ödeme doğrulamaz, alanı açmaz, kod almaz | WRITE |
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
| bağlayıcı | `jeeta.connector.start_oauth` | Bir Meta ya da X hesabını sağlayıcının girişiyle bağlamayı başlatır; sahibe iletilecek `authorize_url` ve bunu söyleyen `handoff` cümlesi (`tr`, `en`) döner, ajan akışı tamamlayamaz | WRITE |
| | `jeeta.connector.confirm_assets` | Sahibin tamamladığı akışın seçilen varlıklarını kabiliyete çevirir ve yoklar | WRITE |
| | `jeeta.connector.set_credentials` | Sahibin verdiği NetGSM kimlik bilgilerini (ya da yapıştırılmış Meta jetonunu) mühürler ve yoklar; günlük bunu ajanın girdiğini yazar (`by_agent: true`) | WRITE |
| | `jeeta.connector.probe` | Bağlayıcı kabiliyeti sağlayıcısına karşı yoklar: sonuç ve sonraki durum | WRITE |
| | `jeeta.connector.health` | Bütün bağlayıcıların sağlığı: durum, son yoklama, jetonun bitişi, yeniden bağlama gereği | READ |
| | `jeeta.connector.reconnect` | Girişi düşen ya da hiç bağlanmamış (`declared`) Meta ya da X kabiliyeti için ona bağlı bir giriş başlatır (`handoff` ile); onayda ilk seçilen varlık o kabiliyet olur | WRITE |
| | `jeeta.connector.hooks` | Sağlayıcılara girilecek webhook adresleri: alanın her amaç için NetGSM adresi (alanın anahtarıyla) ve platformun Meta adresi (doğrulama anahtarı asla) | READ |
| | `jeeta.connector.set_pbx_policy` | NetGSM santralinin çağrı politikası: `call_mode` (`originate` ya da `linkup`) ve `recording_allowed` (görüşmeler santralde kaydedilsin mi); verilmeyen alan değişmez | WRITE |
| olaylar | `jeeta.events.pending` | İşlenmemiş gelen olaylar, en eskisi başta, sayfa sayfa (`next` ile ileri) | READ |
| | `jeeta.events.ack` | İşlenen olayları işaretler (1–200 kimlik, hepsi ya da hiçbiri); `{acked}` | WRITE |
| | `jeeta.events.list` | Bütün gelen olaylar, en yenisi başta; işlenenler dahil, sağlayıcı ve tür süzgeçleri | READ |
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
| `UPSTREAM_UNAVAILABLE` | 503 | sağlayıcı meşgul ya da ulaşılamıyor; yalnız `details.retryable: true` ise yeniden denenebilir |
| `INTERNAL` | 500 | beklenmeyen hata; ileti ve ayrıntılar yalnızca günlüğe yazılır, yanıt `"internal error"` ve boş `details` taşır |

`ConnectorError::Unknown`, yazmanın sağlayıcıya ulaşmış olabileceğini belirtir ve `UPSTREAM_UNAVAILABLE`, `retryable: false`, `reason: "outcome unknown"` olarak döner; körlemesine yeniden gönderilmez.

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
| `social_account` Sosyal hesaplar (bağlayıcı) | `instagram`: Instagram, `facebook_page`: Facebook sayfası, `x`: X, `linkedin_page`: LinkedIn sayfası, `linkedin_member`: LinkedIn kişisel hesap, `tiktok`: TikTok, `pinterest`: Pinterest, `youtube`: YouTube, `google_business`: Google İşletme Profili |
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
hesapları …) bir beyanla doğrulanamaz (`409`), kendi yoklamalarıyla (probe) doğrulanır (bkz.
[Bağlayıcılar](#bağlayıcılar)). Bir bağlayıcının ulaşacağı adresler `connector_public.hosts` alanında bildirilir ve yalnızca genel
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
kabiliyetlerinin `connector_public.hosts` alanı) yeniden kurar; `jeeta serve` ve `jeeta mcp-stdio` bunu
her açılışta, istek almadan önce yapar.
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
| `inbox.work` (gelen kutusunda çalışma) | ✓ | ✓ | ✓ |
| `inbox.manage` (kayıp nedenleri ve yetkili yolculuk işlemleri) | ✓ | ✓ | — |
| `studio.work` (stüdyoda çalışma) | ✓ | ✓ | — |
| `studio.manage` (stüdyoyu yönetme) | ✓ | ✓ | — |
| `calls.work` (arama yapma ve görüşme kaydını görme) | ✓ | ✓ | ✓ |
| `calls.manage` (arama politikasını yönetme, görüşmenin numarasını görme) | ✓ | ✓ | — |
| `calls.bridge` (ses köprüsü olarak çalışma; yalnızca köprünün anahtarı) | ✓ | ✓ | — |
| `devices.work` (telefonları kullanma) | ✓ | ✓ | — |
| `devices.bridge` (cihaz köprüsü olarak çalışma; yalnızca köprünün anahtarı) | ✓ | ✓ | — |

`calls.bridge` ve `devices.bridge` bir köprünün API anahtarının izinleridir; sahip ve yönetici onları o anahtarı
verebilmek için taşır.

`capabilities.manage` ve `budget.manage` M1a ile geldi. Yeni bir alanın sahip ve yönetici rolleri onları
açılışta alır; M1a'dan önce açılmış alanlarınkine `0004_role_permissions_backfill` göçü ekler (bkz.
[Göçler](#göçler)). Özel rollere kendiliğinden eklenmezler: bir özel role sahibi ya da yöneticisi verir.

Bir API anahtarının kapsamları sahibinin izinlerini daraltır: yalnızca `workspace.read` taşıyan bir anahtarla
ajan okur, kendi bağlantısının bildirdiği kabiliyeti doğrular ve harcama bildirir, ama bildiremez,
gruplayamaz, başkasının bildirdiğini doğrulayamaz ve kalem açamaz.

Grup adları alan içinde büyük/küçük harf ayırmadan tektir ("Marka A" ile "marka a" aynı addır); kullanım
durumu bunu yazmadan önce denetler, veritabanı da `capability_groups_name_ci` dizini ile (`lower(name)`)
zorlar: dizine takılan bir yazma da `409 CONFLICT` alır.

## Bağlayıcılar

Meta (Facebook sayfası, Instagram, WhatsApp Business, Messenger, Meta reklamları, Facebook yorumları), NetGSM
(SMS hattı, santral) ve X hesapları bağlayıcıyla ulaşılan kabiliyetlerdir; ajanın beyanıyla değil, sistemin
kendi yoklamasıyla (probe) doğrulanırlar. Bağlantı araçları strateji kapısından muaftır (istişare bağlı
hesapları bilmek ister), çalışma alanı durumu denetiminden muaf değildir: ödeme bekleyen ya da askıya
alınmış bir alan hesap bağlamaz (`423 WORKSPACE_INACTIVE`).

**İki giriş yolu.** Meta ve X hesapları platformun sağlayıcı uygulamalarına OAuth ile bağlanır; NetGSM
hatları (ve bir Meta jetonu, panelde "Gelişmiş" altında) elle girilen kimlik bilgileriyle. X'in elle giriş
yolu yoktur. Bir OAuth akışı şöyle yürür:

1. Sahip panelde (ya da ajan `jeeta.connector.start_oauth` ile) akışı başlatır; yanıt sağlayıcının
   `authorize_url`'idir. Ajan bu adresi sahibe iletir (yanıtın `handoff` cümlesi bunu söyler); akışı
   tamamlayamaz.
2. Sahip kendi tarayıcısında sağlayıcıda oturum açar; sağlayıcı tarayıcıyı panelin sayfasına,
   `{genel adres}/oauth/callback/{uygulama}?state=…&code=…` adresine geri gönderir (yönlendirme adresi
   API değil, paneldir). `{uygulama}` akışın oturum açtığı platform uygulamasıdır: `meta` (Facebook
   Login: `instagram` dışındaki bütün Meta türleri), `instagram` (Instagram Login: `instagram` türü) ya da
   `x`. Kod değişiminde de aynı adres gönderilir; her uygulama kendi adresini kaydeder (bkz.
   [Sağlayıcı uygulamaları](#sağlayıcı-uygulamaları)).
3. Sayfa `state` ve `code`'u okur ve geri dönüş rotasını aynı uygulama adıyla
   (`GET /api/connectors/oauth/callback/{meta|instagram|x}`) kendisi çağırır. Bu istek aynı sitedendir, bu
   yüzden `SameSite=Strict` oturum çerezini taşır (sağlayıcının siteler arası yönlendirmesi taşımazdı). Rota
   oturum ister (`401`), alanın etkin olmasını ister (`423`); durum (`state`) bu alan ve bu adın sağlayıcısı
   için imzalanmış, on dakikadan eski olmayan ve kullanılmamış olmalı, akış da bu adın uygulamasıyla
   başlamış olmalıdır (Instagram Login akışı `meta`'ya, Facebook Login akışı `instagram`'a dönemez), değilse
   nedeni ne olursa olsun `403 FORBIDDEN` ve sağlayıcıya hiç gidilmez. Başka bir ad `422`'dir. Sorgu yalnız
   `state` ve `code` alır. Yanıt, hesabın ulaştığı varlıklardır (tür, ad, dış kimlik, genel bilgiler; hiçbir
   jeton), `Cache-Control: no-store` ile.
4. Sahip panelde bağlanacak varlıkları işaretler; onay (`POST /api/connectors/oauth/{pending_id}/confirm`,
   gövde `{"selected": [dış kimlikler]}`) her birini bir kabiliyete çevirir, kimlik bilgisini mühürler ve
   yoklar. Akış onaydan sonra silinir.

**Bir kabiliyete bağlı akış.** Yeniden bağlama (`reconnect`) akışı bir kabiliyete bağlıdır: hesabı belli
bir kabiliyet için geri dönüş yalnızca o hesabı sunar ve onay kimlik bilgisini yeniler; hiç bağlanmamış
(`declared`) ve hesap kimliği taşımayan bir kabiliyet için ise geri dönüş sağlayıcının bütün varlıklarını
sunar. Onayda **ilk seçilen** (seçim sırasıyla) ve kabiliyetin türünden olan varlık o kabiliyet olur
(hesabı ona bağlanır, kimlik bilgisi mühürlenir; adı sahibin verdiği ad kalır), kalan seçilenler yeni
kabiliyetler olur; böylece önceden bildirilmiş bir kabiliyet yetim kalmaz. Türünden olmayan bir ilk seçim
`422` (`selected`), başka bir canlı kabiliyetin tuttuğu hesap `409 CONFLICT`'tır ve hiçbir şey yazılmaz.
Günlük kaydı `connector.connected` bağlanan kabiliyet için `bound: true`, yenilenen için
`reconnected: true` taşır. Panelde `declared` bir Meta ya da X kabiliyetinin **Bağla** düğmesi bu yolu
kullanır.

Panelde hesaplar **Hesap bağla** sayfasından (`/connect`) bağlanır: Meta türleri "Meta", NetGSM türleri
"NetGSM" başlığı altında, X ayrı; Meta ve X için sağlayıcıda oturum açılır, NetGSM için kimlik bilgisi formu
doldurulur (parola alanları gizlidir, değerler hiçbir önbellekte tutulmaz ve kayıttan sonra formdan silinir),
yapıştırılmış Meta jetonu ise "Gelişmiş" altındadır; X hiçbir kimlik bilgisi formu göstermez. Kabiliyetler
sayfası her bağlayıcı kabiliyetinin sağlığını (`connector.health`: son yoklama ve yaşı, hata türü, yeniden
bağlama gereği, yaklaşan jeton bitişi) gösterir ve duruma uyan işlemleri sunar: **Bağla** (`declared`),
**Yeniden bağla** (Meta ve X sağlayıcıya yeniden gider, NetGSM yeni kimlik bilgisi alır) ve **Yokla**.
Ana sayfadaki `reconnect_connector` işi doğrudan o kabiliyetin yeniden bağlanmasına götürür.
Sağlayıcının hata dönüşü (`error`, `error_description`) panelde kendi metniyle gösterilir, ham hali asla.
Bir türün platform uygulaması yapılandırılmamışsa o türün OAuth akışı `409 CONFLICT` ("provider app not
configured", `details.reason = "provider_app_not_configured"`) alır; genel adres yapılandırılmamışsa her
akış ve webhook adresleri `409 CONFLICT` ("public base url not configured", `details.reason =
"public_base_url_not_configured"`) alır; panel ikisini de kendi cümlesiyle söyler. NetGSM elle girişi
uygulama istemez.

### Sağlayıcı uygulamaları

Meta, Instagram, X, TikTok ve LinkedIn hesapları platformun kendi OAuth uygulamalarına bağlanır: uygulamalar kiracı başına
değil platform başınadır, ortamdan okunur (bkz. [Yapılandırma](#yapılandırma)), kiracılar kendi
hesaplarını bu uygulamalara bağlar. Uygulamaları açmak, ayarlamak ve onaylatmak **platform sahibinin
işidir**; Jeeta yalnız aşağıdaki değerleri okur. Kayıtlı yönlendirme adresleri, her biri sağlayıcının
panelinde birebir girilir (`{genel adres}` = `JEETA_PUBLIC_BASE_URL`):

| Uygulama | Değişkenler | Sağlayıcı panelinde | Yönlendirme adresi |
|---|---|---|---|
| Meta (Facebook Login, Graph API) | `JEETA_META_APP_ID`, `JEETA_META_APP_SECRET`, `JEETA_META_VERIFY_TOKEN`; isteğe bağlı `JEETA_META_LOGIN_CONFIG_ID`, `JEETA_META_WHATSAPP_CONFIG_ID`, `JEETA_META_GRAPH_VERSION` | developers.facebook.com → uygulama → Ayarlar → Temel: Uygulama Kimliği ve Uygulama Sırrı; Facebook Login (for Business) → Ayarlar → Geçerli OAuth Yönlendirme URI'leri; Webhooks → Sayfa, Instagram ve WhatsApp Business Hesabı nesneleri için geri çağırma adresi `{genel adres}/hooks/meta` ve doğrulama anahtarı (`JEETA_META_VERIFY_TOKEN` ile aynı değer) | `{genel adres}/oauth/callback/meta` |
| Instagram (Instagram Login) | `JEETA_INSTAGRAM_APP_ID`, `JEETA_INSTAGRAM_APP_SECRET` | Meta uygulamasının Instagram ürünü → API setup with Instagram login: Instagram uygulama kimliği ve sırrı; "Business login settings" → OAuth redirect URIs | `{genel adres}/oauth/callback/instagram` |
| X | `JEETA_X_CLIENT_ID`, `JEETA_X_CLIENT_SECRET` | developer.x.com → proje → uygulama → User authentication settings: OAuth 2.0, tür "Web App, Automated App or Bot" (gizli istemci), okuma ve yazma izni (Jeeta `tweet.read`, `tweet.write`, `users.read`, `offline.access`, `media.write` ister), Callback URI; Keys and tokens → OAuth 2.0 Client ID ve Client Secret | `{genel adres}/oauth/callback/x` |
| TikTok | `JEETA_TIKTOK_CLIENT_KEY`, `JEETA_TIKTOK_CLIENT_SECRET` | developers.tiktok.com → uygulama: ürünler **Login Kit** ve **Content Posting API** (Direct Post); Login Kit → Redirect URI; kapsamlar `user.info.basic`, `video.publish`, `video.list`, `user.info.stats`; denetimden (audit) önce yalnız `SELF_ONLY` paylaşım ve yalnız test kullanıcıları; fotoğraf paylaşımı için dosya deposunun genel alan adı URL properties altında doğrulanır | `{genel adres}/oauth/callback/tiktok` |
| LinkedIn | `JEETA_LINKEDIN_CLIENT_ID`, `JEETA_LINKEDIN_CLIENT_SECRET`; isteğe bağlı `JEETA_LINKEDIN_ORG_SCOPES`, `JEETA_LINKEDIN_API_VERSION` | linkedin.com/developers → uygulama (bir Şirket Sayfasına bağlı): ürünler **Sign In with LinkedIn using OpenID Connect** ve **Share on LinkedIn** (kişisel akış, `openid profile w_member_social`); kurum sayfaları için **Community Management API** onayı → `JEETA_LINKEDIN_ORG_SCOPES=1`; Auth → Authorized redirect URLs; programatik yenileme yoksa erişim 60 günde biter ve bağlantı yeniden kurulur | `{genel adres}/oauth/callback/linkedin` |

(Panel menülerinin adları sağlayıcıların arayüzüne göre değişebilir; aranan alanlar uygulama kimliği, sırrı,
OAuth yönlendirme adresleri ve Meta için webhook geri çağırma adresi ile doğrulama anahtarıdır.)

- **Meta uygulama incelemesi (App Review).** Facebook Login'in istediği izinler (`pages_show_list`,
  `pages_manage_posts`, `pages_read_engagement`, `pages_messaging`, `pages_manage_metadata`,
  `business_management`, `instagram_basic`, `instagram_manage_messages`, `instagram_content_publish`,
  `instagram_manage_insights`, `whatsapp_business_management`, `whatsapp_business_messaging`, `ads_read`,
  `ads_management`, `read_insights`, `leads_retrieval`) ve Instagram Login'in izinleri
  (`instagram_business_basic`, `instagram_business_content_publish`) başka işletmelerin hesapları için
  ancak Meta'nın incelemesinden (Advanced Access) ve iş doğrulamasından sonra çalışır; inceleme sürecinde
  uygulama yalnız rolü olan hesaplarla (yönetici, geliştirici, test kullanıcısı) denenebilir. İnceleme ve
  iş doğrulaması **sahibin işidir** (tasarım §14); Jeeta'nın kodu bunu beklemez, eksik bir izin yoklamada
  `permission` olarak görünür. `leads_retrieval` verilmemişse (ya da Meta `leadgen` alanını reddederse)
  bağlanan Sayfa yalnız mesajlaşma alanlarına abone edilir (`connector_public.leadgen = false`): mesajlar
  gelir, lead formu gönderimleri gelmez.
- **Webhook yalnız Meta uygulamasıyla açılır.** `/hooks/meta` Meta uygulaması (ve doğrulama anahtarı)
  yapılandırılmadıkça kapalıdır; Instagram Login webhook'ları Instagram uygulamasının sırrıyla da
  imzalanabildiği için kapı iki sırrı da dener, ama yalnız Instagram uygulaması yapılandırılmış bir
  kurulumda webhook alınmaz (OAuth bağlantısı ve yoklama çalışır).
- **Bir uygulama ya hep ya hiç.** Yarım yapılandırma açılışı durdurur; bir uygulama yokken onun türleri
  bağlanamaz ama sunucu açılır. Genel adres, herhangi bir uygulama varken zorunludur; hiç uygulama yokken de
  NetGSM webhook adreslerinin gösterilebilmesi için gerekir.

### Yoklama, sağlık ve yeniden bağlama

Bir bağlayıcı kabiliyetini yalnız sistemin kendi deneme çağrısı (yoklama, `connector.probe`) doğrular.
Başarılı bir yoklama hesabın kimliğini (`facts.account_id`) söylemek zorundadır ve bu kabiliyetin hesabı
olmalıdır; değilse `permission` ("account mismatch") sayılır. Yoklamanın sonucu durumu şöyle değiştirir:

| Sonuç | Kayıtlı durum | Ayrıca |
|---|---|---|
| başarı | `verified` (`last_verified_at` şimdi) | `reconnect_required` temizlenir |
| `auth` (giriş artık kabul edilmiyor) | `unreachable` | `reconnect_required = true`: bekleyen işlerde 1. öncelikte "yeniden bağla" |
| `permission`, `permanent` (izin yok, hesap uyuşmuyor, kalıcı ret) | `unreachable` | — |
| `throttle`, `transient` (sağlayıcı meşgul ya da ulaşılamıyor) | değişmez | bağlantı hakkında bir şey söylemez |

Doğrulanmış bir kabiliyet, son başarılı yoklamasından politikanın `verify_max_age_days` süresi (varsayılan
30 gün) geçince `stale` okunur; zamanlayıcının `probe_all` işi etkin alanlarda her canlı bağlayıcıyı
saatte bir yokladığı için sağlıklı bir bağlantı tazeliğini korur (ödeme bekleyen bir alanın bağlantıları
yoklanmaz, jetonları yine yenilenir). Her yoklama `probe_runs` kaydına yazılır (sonuç sınıfı, başarısızlık
satırı `kind: provider: reason` (en çok 300 karakter, sağlayıcı hatasının kurucusunda maskelenmiş) ve genel
bilgiler, 30 gün tutulur; `unknown` da geçerli bir sınıftır, migration 0013); günlüğe (`connector.probe`)
yalnız durum değiştiğinde yazılır. Sağlık (`connector.health`) her bağlayıcı kabiliyetinin şimdiki
durumunu, son yoklamasını (başarısızsa `reason` satırıyla), jetonun bitişini ve yeniden bağlama gereğini
mühür açmadan okur; panel bu satırı hata türünün cümlesinin altında gösterir. Yeniden bağlama (`connector.reconnect`) Meta ve X için
kabiliyete bağlı yeni bir OAuth akışı başlatır; NetGSM kabiliyeti yeni kimlik bilgisi alır.

**Hangi uygulamayla yeniden bağlanır.** Bir OAuth akışının verdiği kimlik bilgisi, akışın oturum açtığı
uygulamayı kaydeder (`connector_public.access.app`: `meta`, `instagram` ya da `x`; jeton yenilemesi
korur; yapıştırılan bir Meta jetonu `meta` adlar, elle girilen NetGSM kimlik bilgisi uygulama adlamaz) ve
yeniden bağlama o uygulamayla oturum açar; akış uygulamasını
geri dönüşe kadar taşır, başka bir uygulamanın geri dönüş adresi `403`'tür. Facebook Login'le (sayfası
üzerinden) bağlanmış bir `instagram` kabiliyeti Meta uygulamasıyla döner, Instagram uygulaması
yapılandırılmamış olsa da; Instagram Login'le bağlanmış olan Instagram uygulamasıyla döner (o uygulama
yoksa `409 provider_app_not_configured`); jetonu yapıştırılarak bağlanmış olan Meta uygulamasıyla döner.
Uygulama adlamayan bir `instagram` kabiliyeti (yalnız bildirilmiş) Meta uygulaması yapılandırılmışsa
onunla, değilse Instagram uygulamasıyla bağlanır;
öteki türler hep kendi uygulamalarıyla.

### Sabit çıkış adresleri

Bağdaştırıcılar yalnız kendi sağlayıcılarının sabit adreslerine çıkar (`jt_outbound::FIXED_HOSTS`, testte
birebir sabitlenir; başka hiçbir crate `reqwest` adını anmaz):

| Bağlayıcı | Adresler |
|---|---|
| `meta` | `graph.facebook.com`, `graph.instagram.com`, `api.instagram.com`, `rupload.facebook.com` |
| `netgsm` | `api.netgsm.com.tr`, `whatsappapi.netgsm.com.tr`, `sesdosya.netgsm.com.tr`, `crmsntrl.netgsm.com.tr:9111` |
| `x` | `api.twitter.com`, `api.x.com` |

Hepsi yalnız `https`'tir; tek istisna Netsantral'in tıkla-ara ucudur: sağlayıcı onu yalnız düz `http` ile,
`crmsntrl.netgsm.com.tr` adresinin 9111 portunda sunar, bu yüzden yalnız `netgsm` kapsamında, yalnız o
adres ve port için düz `http` kullanılır (bir sağlayıcı kısıtı; DNS koruması yine uygulanır). Tarayıcının
gittiği giriş sayfaları (`www.facebook.com`, `www.instagram.com`, `twitter.com`) çıkış değildir: sunucu
onlara hiç istek atmaz, yalnız adreslerini kurar.

### Webhook'lar

Sağlayıcılar olaylarını (gelen mesaj, iletim durumu, potansiyel müşteri formu, arama, İYS izni) sunucunun
webhook kapısına (`jt_webhook`, `/hooks/*`) gönderir. Kapı panelin oturum ve istek başlığı denetimlerinin
dışındadır (sağlayıcının oturumu yoktur), güvenlik başlıkları ve erişim günlüğü içindedir; günlük rotayı
şablonuyla yazar, bu yüzden adresteki anahtar günlüğe hiç düşmez. Adresler genel adresin
(`JEETA_PUBLIC_BASE_URL`) altındadır; panelde **Kabiliyetler** sayfasının "Webhook adresleri" bölümü
(yalnız `capabilities.manage` taşıyana) her birini kopyalanacak biçimde gösterir, ajan aynı listeyi
`jeeta.connector.hooks` ile okur (`GET /api/connectors/hooks`, yanıt `{meta, netgsm: [{purpose, url}]}`).
Genel adres yapılandırılmamışsa liste `409 CONFLICT`'tır (`details.reason =
"public_base_url_not_configured"`).

| İstek | Yanıt |
|---|---|
| `GET /hooks/meta` (doğrulama) | `hub.mode=subscribe` ve doğru `hub.verify_token` için `hub.challenge` düz metin olarak, `200`; başka her şey `403`; Meta uygulaması yapılandırılmamışsa `404` |
| `POST /hooks/meta` | imza başlığı yoksa ya da Meta uygulaması yoksa gövde okunmadan `401`; 3 MB üstü `413`; imza tutmazsa `401`; olaylar yazılınca (ya da kurala göre atılınca) `200 EVENT_RECEIVED`; veritabanı hatası `500` (Meta yeniden gönderir) |
| `POST /hooks/netgsm/{workspace_id}/{anahtar}/{amaç}` | bozuk ya da bilinmeyen parça, yanlış anahtar, var olmayan ya da askıya alınmış (`suspended`) alan: gövde okunmadan çıplak `404`; 256 KB üstü `413`; okunamayan gövde `202` (hiçbir şey yazılmaz); olaylar yazılınca `202`; veritabanı hatası `503` (NetGSM yeniden gönderir) |

**Alanın durumu.** Meta olayları hesaba göre yönlendirilir ve hesabı tutan alan **etkin** ya da **ödeme
bekliyor** (`pending_payment`) ise yazılır: ödeme beklerken bağlı hesapların olayları kaybolmaz. Alan
**askıya alınmışsa** (`suspended`) olay atılır: hiçbir yere satır yazılmaz, `unrouted_meta` sayacı
artar ve günlüğe yalnız sağlayıcı, neden (`reason="inactive"`), hesap türü ve sayı yazılır (gövde, hesap
kimliği ya da mesaj asla); Meta'ya yine `200` döner (yeniden gönderim bir şey değiştirmezdi). NetGSM'in
adresi alanı kendisi adlar; Meta gibi etkin (`active`) ve ödeme bekleyen (`pending_payment`) alanların
olaylarını saklar, askıdaki (`suspended`) alanın adresi ise `404` döner.

- **NetGSM**: her amaç için ayrı bir adres, `{genel adres}/hooks/netgsm/{workspace_id}/{anahtar}/{amaç}`;
  amaç `mo` (gelen SMS), `events` (santral çağrı olayları), `iys` (İYS izin değişiklikleri), `voice-report`
  (sesli mesaj raporları) ya da `autocall-report` (otomatik arama raporları). Anahtar, alanın gizli
  anahtarından o amaç için türetilen HMAC'tir (saklanmaz, her istekte yeniden hesaplanır, sabit zamanda
  karşılaştırılır); adresi elle kurmayın, paneldeki "Webhook adresleri" bölümünden kopyalayıp NetGSM
  panelinde ilgili geri çağırma alanına yapıştırın ve başkasıyla paylaşmayın (adres alanın anahtarını
  taşır; şimdilik döndürülemez). Çözülemeyen bir adres parçası (bozuk yüzde kodlaması), bilinmeyen amaç, bozuk alan
  kimliği, yanlış anahtar, var olmayan ya da askıya alınmış alan: hepsi gövde okunmadan çıplak `404` alır
  ve hiçbir şey yazılmaz. Gövde en çok 256 KB'tır (`413`).
  Okunamayan bir gövde `202` alır, hiçbir şey yazılmaz, yalnız amaç günlüğe yazılır ve sayılır (NetGSM
  başka her yanıtı yeniden denerdi). Olaylar alanın o amaca ait tek canlı kabiliyetine bağlanır (`mo` ve
  `iys` → `sms_line`, ötekiler → `netgsm_pbx`; hiç ya da birden çok varsa hiçbirine). Başarı `202`'dir;
  yazma başarısız olursa `503` (NetGSM yeniden gönderir).
- **Meta**: platformun tek adresi `{genel adres}/hooks/meta`; Meta uygulamasının panelinde (Webhooks)
  geri çağırma adresi olarak bu, doğrulama anahtarı olarak platformun doğrulama anahtarı girilir
  (`JEETA_META_VERIFY_TOKEN`; platform sahibinin işidir ve anahtar hiçbir yanıtta görünmez, panel yalnız
  nereye girildiğini söyler). `GET` doğrulaması `hub.mode=subscribe` ve doğru
  `hub.verify_token` için `hub.challenge`'ı düz metin olarak döndürür, değilse `403`; Meta uygulaması
  yoksa `404`. `POST` teslimleri eşzamanlıdır: imza başlığı (`X-Hub-Signature-256`) yoksa ya da uygulama
  yoksa gövde okunmadan `401`; gövde en çok 3 MB'tır (WhatsApp Cloud API yükleri bu boyuta varır;
  üstü `413`); imza, ham gövde üzerinde her şeyden önce Meta uygulamasının sırrıyla ve platformun
  Instagram uygulaması yapılandırılmışsa onun sırrıyla da (Instagram Login webhook'ları onunla imzalanır)
  sabit zamanda doğrulanır; biri imzalıyorsa geçer, hiçbiri imzalamıyorsa `401` ve hiçbir şey yazılmaz. Her olay hesabıyla (sayfa, Instagram hesabı,
  WhatsApp numarası) bütün alanlarda aranır ve hesabı **bağlı** tutan tek alana yazılır (mühürlü kimlik
  bilgisi, en az bir kez yoklamayla doğrulanmış, emekli değil; jetonu sonradan düşse bile). Hesabı bağlı
  tutan alan yoksa (`reason="unrouted"`) ya da o alan askıdaysa (`reason="inactive"`) olay **atılır**:
  hiçbir alana satır yazılmaz, günlüğe yalnız sağlayıcı, neden ve hesap türü yazılır ve sayılır. Teslim
  **eşzamanlıdır**: imza → ayrıştırma → yönlendirme → alanın işleminde yazma → `200 EVENT_RECEIVED`;
  yanıt ancak her şey yazıldıktan sonra döner, bu yüzden kaybolan bir yanıt yeniden gönderimdir, kaybolan
  bir olay değil. Veritabanı hatası `500` (Meta yeniden gönderir).

Bir olay alan, sağlayıcı ve sağlayıcı kimliği (`wamid`, `mid`, `netgsm-mo:<gorevid>` …) başına bir kez
saklanır: yeniden gönderim ve aynı anda gelen kopyalar tek satır bırakır. Bir teslimin olayları her
alanda sağlayıcı kimliklerinin sırasıyla yazılır (alanlar da kimlik sırasıyla), böylece aynı olayları
farklı sırada taşıyan iki teslim kilitleri aynı sırada alır ve birbirini kilitlemez. Ham gövde teslim ve
alan başına bir kez, oraya yeni yazılan ilk olayın yanında tutulur (bin olaylı bir gövde bin kez
saklanmaz; kardeş olaylar aynı `received_at`'i taşır); 30 gün tutulur ve hiçbir yanıtta görünmez. Ham
gövde **alanın kendisinindir**: Meta bir teslimde birkaç alanın sayfalarını, Instagram hesaplarını ya da
WhatsApp numaralarını bir arada gönderebilir; her alan yalnız kendi olaylarının geldiği girdileri (bir
WhatsApp girdisinde yalnız kendi numaralarının `changes` öğelerini) `{"object", "entry": […]}` olarak
saklar (ayrıştırılmış gövdeden yeniden yazılır; imza özgün gövdeyi kapsar), gövdenin tamamı o alanınsa
olduğu gibi saklar. Hiçbir alanın almadığı bir öğe (bağlı olmayan hesap, askıdaki alan, olay çıkmayan
öğe) hiçbir yerde saklanmaz. NetGSM gövdesi adresin adladığı tek alanındır ve olduğu gibi saklanır. Daha
eskilerini zamanlayıcının günlük `purge_raw_bodies` işi her alanda ayrı ayrı siler
(`webhook::purge_raw_in`, bkz. [Zamanlanmış işler](#zamanlanmış-işler)); olaylar kalır. Olaylar günlüğe
(ledger) yazılmaz: dış dünyanın kayıtlarıdır.

### Gelen olaylar

Ajan gelen olayları okur ve işlediklerini işaretler; sonraki aşamalar olayları konuşmalara ve
ölçümlere çevirene dek tüketicisi odur. Araçlar strateji kapısından muaftır (olaylar gözlemdir,
planlanmış iş değil), çalışma alanı durumu denetiminden muaf değildir. Bir olay `{id, provider,
capability_id, external_id, kind, payload, received_at, processed_at}` olarak döner; `payload`
sağlayıcının ögesidir (bağdaştırıcının ayıkladığı haliyle), sağlayıcı olayın ne zaman olduğunu söylediyse
`occurred_at` da taşır; ham gövde asla. Sayfalar `{events, next}`'tir: `next` boş değilse bir sonraki
sayfanın imlecidir ve olduğu gibi geri gönderilir.

| Adım | Panel | MCP aracı | İzin |
|---|---|---|---|
| İşlenmemişler, en eskisi başta (`limit` varsayılan 50, en çok 200; `after_at`, `after_id`) | `GET /api/events/pending` | `jeeta.events.pending` | `workspace.read` |
| İşaretleme (gövde `{"ids": [...]}`, 1–200; bilinmeyen kimlik `404` ve hiçbiri işaretlenmez; yanıt `{acked}`; günlük `events.acked {n}`) | `POST /api/events/ack` | `jeeta.events.ack` | `capabilities.manage` |
| Hepsi, en yenisi başta (`limit`, `before_at`, `before_id`, `include_processed` varsayılan `true`, `kind`, `provider`) | `GET /api/events` | `jeeta.events.list` | `workspace.read` |
| Webhook adresleri | `GET /api/connectors/hooks` | `jeeta.connector.hooks` | `capabilities.manage` |

İşaretleme `capabilities.manage` ister: olayların geldiği bağlantıları yöneten izindir ve daha hafif bir
yazma izni yoktur; `workspace.read` olayları yalnız okur.

- **Devir noktası.** Gelen olaylar M2'ye (gelen kutusu: konuşmalar, kişiler) ve M3'e (ölçüm) devrin
  kendisidir: o aşamaların tüketicileri gelene dek ajan `jeeta.events.pending` ile okur, işlediğini
  `jeeta.events.ack` ile işaretler, geçmişe `jeeta.events.list` ile bakar. Olay kaydı günlüğe yazılmaz;
  yalnız işaretleme `events.acked` olarak yazılır.
- **İmleç.** `events.pending` en eskiden ileri gider: yanıtın `next`'i (`after_at`, `after_id`) bir sonraki
  sayfanın başıdır. Bir olay geç kaydedilip (işlemi geç biterse) imlecin gerisine düşebilir; o yüzden ajan
  her turu imleçsiz başlatır (işlenmemişlerin başından), imleci yalnız aynı turun sayfaları arasında
  kullanır: işaretlenmeyen hiçbir olay kaybolmaz. `events.list` en yeniden geriye gider (`before_at`,
  `before_id`).
- **İşaretleme sırası.** Kimlikler tekilleştirilir ve sıralanır, sonra her biri tek tek işaretlenir: aynı
  olayları ters sırada işaretleyen iki istek satır kilitlerini aynı sırada alır ve birbirini kilitlemez;
  ikisinin `acked` toplamı işaretlenen olay sayısına eşittir.

| Adım | Panel | MCP aracı | İzin |
|---|---|---|---|
| OAuth başlatma (gövde `{"kind_key": …}`; yanıt `{authorize_url, pending_id, expires_at}`, araç ayrıca `handoff`) | `POST /api/connectors/oauth/start` | `jeeta.connector.start_oauth` | `capabilities.manage` |
| Geri dönüş (yalnızca panel; sorgu `state`, `code`; yanıt `{pending_id, assets}`) | `GET /api/connectors/oauth/callback/{provider}` | — | `capabilities.manage` |
| Varlık onayı (gövde `{"selected": […]}`; yanıt kabiliyetlerin listesi, araçta `{capabilities}`) | `POST /api/connectors/oauth/{pending_id}/confirm` | `jeeta.connector.confirm_assets` | `capabilities.manage` |
| Elle kimlik bilgisi (gövde `{capability_id}` ya da `{kind_key, name}`, isteğe bağlı `external_id`, `credential`) | `POST /api/connectors/credentials` | `jeeta.connector.set_credentials` | `capabilities.manage` |
| Yoklama (gövdesiz; yanıt `{result, status}`) | `POST /api/connectors/{capability_id}/probe` | `jeeta.connector.probe` | `workspace.read` |
| Sağlık (yanıt liste, araçta `{connectors}`) | `GET /api/connectors/health` | `jeeta.connector.health` | `workspace.read` |
| Kabiliyete bağlı giriş: yeniden bağlama ya da `declared` bir kabiliyetin ilk bağlanması (gövdesiz; yanıt başlatma gibi) | `POST /api/connectors/{capability_id}/reconnect` | `jeeta.connector.reconnect` | `capabilities.manage` |
| Santralin çağrı politikası (gövde `{call_mode?, recording_allowed?}`, en az biri; yalnız `netgsm_pbx`, başka tür `409`; yanıt `{capability_id, call_mode, recording_allowed}`; günlük `connector.pbx_policy_set`). Bu iki `connector_public` anahtarı ayrılmıştır: bildirim ve bağlantı adımı yazamaz, kaydın açılması tek ve günlüklü bir karardır | `PUT /api/connectors/{capability_id}/pbx-policy` | `jeeta.connector.set_pbx_policy` | `capabilities.manage` |

Kimlik bilgisi biçimleri (`credential.kind`): `netgsm_sms` (`usercode`, `password`, `msgheader`;
`sms_line` için), `netgsm_pbx` (`username`, `password`, isteğe bağlı `trunk`, `pbxnum`; `netgsm_pbx` için)
ve `meta_token` (`access_token`; Facebook sayfası ve WhatsApp jetonu `external_id` ister). Gövde katı
okunur: bilinmeyen alan, eksik alan ya da yanlış türde değer `422 VALIDATION` alır ve ret hiçbir değeri
tekrarlamaz. Mühürlenen kimlik bilgisi hiçbir yanıtta, günlük kaydında ya da log satırında görünmez;
günlük kaydı `connector.credentials_set` yalnızca türü ve girenin ajan olup olmadığını (`by_agent`) yazar.
Doğrulanmış bir kabiliyet kimlik bilgilerini bir yoklama düşene dek tutar (`409`). Bir NetGSM kabiliyeti
yeniden bağlanmaz, yeni kimlik bilgisi alır (`422`, `details.reason = "use_set_credentials"`).

**Deneme (smoke).** Sağlayıcılara karşı bütün otomatik testler süreç içinde, `127.0.0.1`'e bağlı sahte
sunuculara karşı çalışır (kayıtlı sağlayıcı yanıtları `tests/fixtures/` altındadır); hiçbir test internete
çıkmaz. "Testler geçti", gerçek bir hesabın bağlandığı anlamına gelmez: gerçek hesaplarla canlı deneme
(uygulamalar ve genel adres yapılandırıldıktan sonra bir Meta sayfası, bir Instagram hesabı, bir X hesabı ve
bir NetGSM hattı bağlamak, webhook'ları doğrulatmak) elle yapılır ve adımları sahibin canlı deneme
listesindedir.

Sunucu (`jeeta serve` ve `jeeta mcp-stdio`) üç sağlayıcının gerçek bağdaştırıcılarını (`jt_meta`,
`jt_netgsm`, `jt_x`) üretim adresleriyle ve tek bir çıkış istemcisiyle (`jt_outbound::Egress`) kurar
(`bin/jeeta/src/connectors.rs`); bağdaştırıcılar yalnızca o istemciyle, yalnızca sağlayıcılarının sabit
adreslerine ulaşır. Her biri yalnızca uyguladığı işlemler için sunulur: Meta bağlantı, OAuth, yayın, sayaçlar,
mesajlaşma, reklam bütçesi ve potansiyel müşteri formları; NetGSM bağlantı, SMS, arama, İYS izni ve iletim
raporları (OAuth yok); X bağlantı, OAuth, yayın ve sayaçlar.

`SendReceipt`, `provider_id` yanında sağlayıcı bildirdiğinde en küçük para birimi cinsinden `cost_minor: Option<i64>` taşır; NetGSM gönderim yanıtındaki `cost_minor` okunur, bildirilmeyen tutar (Meta dahil) `None` kalır.

## Zamanlanmış işler

`jeeta serve` bağlantıları canlı, kayıtları derli toplu tutan sabit aralıklı işler çalıştırır (yalnız
belirlenimci işler: içerik kararı vermezler). Her iş `jt_app::usecases::jobs` içinde bir fonksiyondur;
zamanlayıcı (`bin/jeeta/src/scheduler.rs`) onu aralığında, kilidinin altında çağırır.

| İş | Aralık | Ne yapar | Kilit |
|---|---|---|---|
| `refresh_tokens` | 1 saat | Süresi 7 gün içinde dolan (`connector_public.access.expires_at`; seçmek için hiçbir mühür açılmaz) her canlı bağlayıcı jetonunu ve her X jetonunu (yenileme jetonu her kullanımda döner) sağlayıcıda yeniler; yenisini eskisinin yerine mühürler, `access`'i (bitiş, kapsamlar) ondan yeniden yazar ve `reconnect_required`'ı temizler. Karşılaştır-ve-değiştir: sağlayıcıya sorulurken kabiliyetin mühürlü baytları değiştiyse (sahip yeniden bağladı, yeni kimlik bilgisi girdi, emekliye ayırdı) hiçbir şey yazılmaz. Yeni kimlik bilgisinin yazılması (veritabanı yüzünden) başarısız olursa bir kez daha denenir; yine olmazsa `error` düzeyinde günlüğe yazılır (sağlayıcı eskisini çoktan geçersiz kılmış olabilir). Sağlayıcı girişi artık kabul etmezse (`auth`) kabiliyet `unreachable` olur ve `reconnect_required` işaretlenir; günlüğe `connector.refresh_failed` (`{kind_key, error_kind}`) yalnız işaret ilk kez konduğunda yazılır. İşaretli bir Meta kabiliyeti sahibi yeniden bağlayana dek bir daha sorulmaz; işaretli bir X kabiliyeti ise her saat yeniden sorulur (iki saatlik erişim jetonu düşünce bir yoklama onu işaretler, oysa yenileme jetonu hâlâ geçerli olabilir) ve yenileme başarılı olunca hemen yoklanır, durumu olağan yoldan geri gelir. Başka bir hata hiçbir şeyi değiştirmez; olağan bir yenileme günlüğe yazılmaz | `jeeta.jobs.refresh_tokens` |
| `probe_all` | 15 dakika | Son yoklaması (`connector_public.health.at`) en az bir saatlik olan ya da hiç yoklanmamış her canlı bağlayıcı kabiliyetini (mühürlü kimlik bilgisi olan; kimlik bilgisi olmayan bir `declared` kabiliyet asla) `connector.probe`'un yaptığının aynısıyla yoklar; en çok dördü aynı anda (yoklama sağlayıcıyı beklerken kabiliyetin satır kilidini ve bir veritabanı bağlantısını tutar) | `jeeta.jobs.probe_all` |
| `netgsm_dlr_poll` | 1 dakika | İletimi kesinleşmemiş gönderilerin iş kimliklerini (en çok 50) alanın doğrulanmış SMS hatlarının kimlik bilgisiyle NetGSM iletim raporuna sorar ve duyduğu durumları kaydeder. Gönderiler M2'nin tablosundadır; o gelene dek bekleyen iş yoktur ve sağlayıcıya hiç gidilmez | `jeeta.jobs.netgsm_dlr_poll` |
| `netgsm_inbox_poll` | 1 saat | Her doğrulanmış SMS hattının NetGSM gelen kutusunu son iki saat için okur (başlangıç ve bitiş tarihi her zaman verilir) ve webhook'un kaçırdığı mesajları o hatta bağlı gelen olay olarak saklar. Kimlik webhook'unkiyle aynıdır (`netgsm-mo:<gorevid>`): webhook'un ya da önceki yoklamanın sakladığı mesaj ikinci kez yazılmaz. Yoklamanın ham gövdesi yoktur | `jeeta.jobs.netgsm_inbox_poll` |
| `netgsm_cdr_poll` | 1 saat | Her doğrulanmış `netgsm_pbx` için santralin görüşme kayıtlarını (CDR, `/netsantral/report`) son iki saat için okur ve `cdr` çağrı olayı olarak saklar; kimlik webhook'unkiyle aynıdır (`netgsm-call:<id>:cdr`), itilen kayıt ikinci kez yazılmaz. Tüketici, Jeeta'dan yapılmış bir aramanın oturumunu süre, kayıt bağlantısı ve maliyetle tamamlar. Sunucunun IP'si NetGSM hesabının izinli listesinde olmalıdır | `jeeta.jobs.netgsm_cdr_poll` |
| `iys_sync` | 1 saat | İYS izin kararlarını eşitler; beş hatadan sonra insan takip görevi açar | `jeeta.jobs.iys_sync` |
| `refresh_tenant_hosts` | 1 dakika | Active/pending_payment çalışma alanlarının canlı connector host listesinden bu instance'ın tenant egress katmanını yeniler | `jeeta.jobs.refresh_tenant_hosts` |
| `mail_inbox_poll` | 2 dakika | Doğrulanmış posta kutularında INBOX/Sent UID imleçlerini okur; olaylarla imleçleri aynı işlemde kaydeder ve gelen kutusu tüketicisini çalıştırır | `jeeta.jobs.mail_inbox_poll` |
| `purge_raw_bodies` | 1 gün | 30 günden eski gelen olayların ham gövdesini her alanda ayrı ayrı siler (`webhook::purge_raw_in`; silinemeyen alan sayılır, ötekiler yine silinir); olaylar kalır | `jeeta.jobs.purge_raw_bodies` |
| `purge_oauth_pending` | 1 saat | Süresi geçmiş bekleyen OAuth akışlarını siler | `jeeta.jobs.purge_oauth_pending` |
| `purge_probe_runs` | 1 gün | 30 günden eski prob kayıtlarını siler; `probe_runs` tetikleyicisi her değişikliği ve veritabanının saatine göre 30 günden genç bir kaydın silinmesini reddeder | `jeeta.jobs.purge_probe_runs` |
| `inbox_consume` | 10 saniye | Gelen olayları tek işlemde gelen kutusu kayıtlarına dönüştürür; active ve pending_payment alanlar. Ertelenen (`deferred`) bir olay, erteleme başına bir saat (en çok bir gün) sonra yeniden denenir; yedi günden eski olan bırakılır (`abandoned`, günlükte `inbox.event.abandoned`). Kaybedilmiş bir yolculuktaki arama yolculuğa işlenmez ama konuşmayı yeniden açar: `work.pending` bunu yeniden açma sorusu olarak gösterir. Bağlayıcısı olmadan saklanmış bir NetGSM olayı, türünün tek canlı kabiliyeti olunca ona bağlanır. Sesli mesaj ve otomatik arama raporları `inbox.netgsm_report` ile tüketilir | `jeeta.jobs.inbox_consume` |
| `outbox_recover` | 1 dakika | 2 dakikadan eski `sending` → `unknown` (yeniden göndermez); 5 dakikadan eski `queued` kayıtlarını iki çitli gönderim adımına verir | `jeeta.jobs.outbox_recover` |
| `call_timers` | 1 saniye | Hatta ajan araması olan alanlarda (tek bir platform okumasıyla bulunur) her aramanın zamanlayıcılarını işletir: yavaş ajana 4. ve 10. saniyede planın bekleme cümlesi, sessiz ajana her 20 saniyede planın sıradaki yedek cümlesi, yedekler bitince kapanış cümlesi ve kapatma (`agent_timeout`); en uzun süreyi aşan, arayanı sessiz kalan, 90 saniye cevapsız çalan ve köprüsü susmuş arama da senaryoyla biter. Sunucu hiçbir cümle yazmaz | `jeeta.jobs.call_timers` |
| `purge_call_commands` | 1 gün | Ses köprüsü için 7 günden önce kuyruğa alınmış komutları (onaylanmış olsun olmasın) siler; aramalar ve konuşma kayıtları kalır | `jeeta.jobs.purge_call_commands` |

- **Kilit: üst üste binme yok.** Her tıkta iş kendi kilidini ister
  (`pg_try_advisory_lock(hashtext('<kilit>'))`); kilidi başka bir koşucu (aynı ya da başka bir örnek)
  tutuyorsa o tık atlanır, beklenmez. Böylece aynı işin iki çalışması hiçbir zaman üst üste binmez. Kilit
  örneklere sıra vermez ama: her örnek kendi takvimiyle tıklar, iki örnek bir işi (birbirini beklemeden,
  ayrı zamanlarda) iki kat sık çalıştırır (X jetonu saatte iki kez döner, NetGSM dakikada iki kez
  sorulur). Birden çok örnek çalıştırıyorsanız işleri **tek bir örnekte** çalıştırın:
  ötekilerde `JEETA_JOBS_ENABLED=false`. Kilit, işlere ayrılmış küçük bir havuzdaki
  (`application_name = jeeta-jobs`, en çok iş sayısı kadar bağlantı, ilk kilit istendiğinde açılır) bir
  bağlantının oturumuna aittir ve iş bitince bırakılır; süreç ölürse Postgres kilidi oturumla birlikte
  bırakır. Bu havuz sunucunun kendi havuzundan ayrıdır: kilit tutan bir iş panelin bağlantısını almaz.
  Bağlantı havuza ancak oturumunun bu kilitlerden hiçbirini tutmadığı bilinince döner: kilit
  alınırken ya da bırakılırken iş yarıda kesilirse (görev iptali, zaman aşımı, panik) bağlantı kapatılır,
  oturum biter ve Postgres kilidi bırakır; böylece havuzda sahipsiz bir kilit kalmaz.
- **İlk çalışma** açılıştan sonra 0–30 saniyelik rastgele bir gecikmeyle gelir (birlikte açılan örnekler
  kilidi aynı anda istemesin); sonraki tıklar aralığı izler, aralıktan uzun süren bir çalışma bir sonrakini
  erteler.
- **Hatalar.** Her çalışma kendi görevinde koşar: panik olursa günlüğe yazılır, kilit bırakılır, bir sonraki
  tık işi yeniden çalıştırır (bir işin döngüsü panik olursa bir aralık sonra yeniden başlatılır). Bir
  kabiliyetin, hattın ya da alanın başarısızlığı işi durdurmaz: sayılır ve nedeniyle günlüğe yazılır;
  temizlik işleri de ulaşılamayan bir alanı sayıp ötekilere devam eder. Her çalışma tek bir özet
  satırıyla biter (`job`, `touched`, `changed`, `skipped`, `failed`): bir şey yaptıysa `info`, yapacak
  bir şey bulmadıysa `debug` (her dakika çalışan yoklama günlüğü doldurmasın); hiçbir günlük satırı,
  günlük kaydı ya da rapor kimlik bilgisi taşımaz.
- **Hangi alanlar.** `probe_all` ve NetGSM teslim raporu yoklaması (`netgsm_dlr_poll`) yalnız etkin
  (`active`) alanlar için çalışır: ödeme bekleyen ya da askıya alınmış bir alan adına bu işler
  sağlayıcıları yoklamaz. Webhook girişleri etkin ve ödeme bekleyen alanların olaylarını saklar,
  askıdaki alanların olaylarını almaz; NetGSM gelen kutusu yedeği (`netgsm_inbox_poll`) de aynı alanlar
  için çalışır, böylece ödeme beklerken webhook'un kaçırdığı mesajlar da kaybolmaz.
  `refresh_tokens` etkin ve ödeme bekleyen (`pending_payment`) alanlar için çalışır: yenileme yalnız
  var olan bir izni canlı tutar, bir ödeme beklemesi bütün hesapların yeniden bağlanmasına dönüşmemeli; askıya alınmış alan dışarıda kalır. NetGSM yoklamaları
  yalnız doğrulanmış bir SMS hattı olan alanlara girer: bu alanlar platform genelinde tek bir okumayla
  bulunur, ötekilerde hiçbir işlem (transaction) açılmaz. Temizlik işleri bütün alanlar için çalışır.
  İşlerin yazdığı günlük kayıtlarının yazarı sistemdir (`system`, `scheduler:<iş>`).
- **Kapatma.** `JEETA_JOBS_ENABLED=false` iken hiçbir iş başlamaz ve açılış bunu günlüğe yazar (birden
  çok örnekte işler yalnız birinde açık kalsın). `jeeta mcp-stdio` iş çalıştırmaz.
- **Durdurma.** SIGINT ya da SIGTERM gelince yeni hiçbir iş çalışması başlamaz; açık HTTP bağlantıları
  en çok 10 saniye boşaltılır, ardından süren iş çalışmalarına bitmeleri için en çok 30 saniye verilir,
  sonra kesilirler (kilitleri yine bırakılır). Bir jeton yenilemesi, sağlayıcının yanıtı ile yeni kimlik
  bilgisinin yazılması arasında kesilirse (X eski yenileme jetonunu o anda geçersiz kılmıştır) hesap
  yeniden bağlanmak zorunda kalabilir; bu bekleme bunu önler.
- **Açılışta** her komut (`serve` ve `mcp-stdio`) istek almadan önce çıkış izin listesinin kiracı katmanını
  kabiliyet kayıtlarından yeniden kurar: yalnız canlı bağlayıcı kabiliyetlerinin adresleri girer, emekli bir
  kabiliyetin adresleri kaydında dursa da girmez (açılış günlüğündeki `rebuilt the tenant egress tier`
  satırı alan ve adres sayısını yazar).

## Sırada ne var

Ajanın giriş noktası `jeeta.work.pending`'dir (panelde `GET /api/work/pending`, ana sayfanın verisi): stratejinin
durumu, en acil olanı başta bekleyen işler ve ajanın son görülme uyarısı. Strateji kapısından muaftır, çalışma
alanı durumu denetiminden ise alan ödeme beklerken muaftır: ajan, strateji yokken ve alan ödeme beklerken de
neyin beklediğini sorabilir; askıya alınmış bir alanda `work.*` de `WORKSPACE_INACTIVE` alır. Yalnız alanın
durumunun yapılmasına izin verdiği işler listelenir: her iş onu bitiren kullanım durumunu bilir ve o
kullanım durumu `WORKSPACE_INACTIVE` alacaksa iş gösterilmez. Ödeme bekleyen bir alanda bu yalnız
stratejinin işleridir (`consult_strategy`, `approve_strategy`); kabiliyet, bağlantı ve gelen olay işleri
ödeme sonrasına kalır (webhook'lar bu arada olayları saklamayı sürdürür, alan etkinleşince listelenir).

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
| `connect_connector` (`capability_id`, `name`) | 2 | bağlayıcıyla ulaşılan, `declared` okunan her kabiliyet (bkz. [Bağlayıcılar](#bağlayıcılar)) |
| `inbound_events` (`count`) | 2 | işlenmemiş gelen olaylar var ve soran onları işaretleyebilir (`capabilities.manage`; işaretleyemeyen bu işi görmez); `count` en çok 1000'e kadar sayılır, 1000 "en az 1000" demektir (bkz. [Gelen olaylar](#gelen-olaylar)) |
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
  değişkenler (`JEETA_DATABASE_URL`, `JEETA_SECRET_KEY` …) `serve` ile aynı kurallarla doğrulanır;
  sağlayıcı uygulamaları ve genel adres de (yarım bir uygulama burada da açılışı durdurur), bu yüzden
  burada başlatılan bir OAuth akışı sunucununkiyle aynı yönlendirme adresini kurar.

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
- Süreç yöneticisinin durdurma süresi 40 saniyeden uzun olmalıdır: 10 saniyelik HTTP boşaltması ve
  süren zamanlanmış işler için 30 saniye (bkz. [Zamanlanmış işler](#zamanlanmış-işler)).
- Birden çok örnek aynı veritabanını kullanıyorsa zamanlanmış işleri yalnız birinde açık bırakın
  (ötekilerde `JEETA_JOBS_ENABLED=false`).

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
| `make sweep` | `cargo sweep --time 1` (bir günden eski `target/` çıktılarını siler) |

CI (`.github/workflows/rust.yml`) `rust/**` ya da iş akışı dosyası değiştiğinde, `main` ve `feat/**`
dallarına gönderimde ve her çekme isteğinde çalışır: `rust-checks` (fmt, clippy, doc, cargo-deny),
`rust-test` (PostgreSQL 16 hizmetiyle `cargo test --workspace`) ve `panel` (`pnpm install --frozen-lockfile`,
`pnpm test`, `pnpm typecheck`, `pnpm build`). `fmt` dışındaki her `cargo` komutu, CI'da da `make` ile de
(`make dev` dahil), `--locked` çalışır: `Cargo.lock` yeniden çözümlenmez, kilit dosyası güncel değilse iş
durur (bir bağımlılık değiştiğinde kilit dosyasını bir kez düz `cargo build` ile güncelleyip işleyin).

**Disk düzeni.** Her farklı `cargo` çağrı biçimi (paket kümesi, özellik kümesi, profil) bağımlılık
ağacının ve test ikililerinin kendi kopyasını `target/` altına üretir: bir `-p` alt kümesi ya da başka bir
özellik kümesi ağacı yeniden derler ve diskte ayrı yer tutar. Bu yüzden tam olarak Makefile'ın biçimlerini
kullanın: `cargo test --locked --workspace`, `cargo clippy --locked --workspace --all-targets -- -D warnings`
ve tek `cargo test --locked -p jt_outbound --test production_build` çalıştırması; `-p` alt kümeleri değil.
Kök `Cargo.toml`'daki `[profile.dev] debug = "line-tables-only"` test ikililerini küçük tutar. İş gününün
sonunda `make sweep` (bir kez `cargo install cargo-sweep` gerekir) ya da `cargo clean` çalıştırın.

## Sınırlar

Crate sınırları iki yerden denetlenir; ikisi de `make check` içinde çalışır:

- `crates/jt_archtest`: alan (domain) crate'leri (`jt_tenancy`, `jt_ledger`, `jt_strategy`, `jt_capability`)
  yalnızca `serde`, `serde_json`, `uuid`, `time`, `thiserror` ve birbirlerini (`jt_tenancy`, `jt_ledger`)
  kullanır; `jt_app` hiçbir adaptöre bağlı değildir; `reqwest` yalnızca `jt_outbound`'da (başka hiçbir
  paket, ikili dahil, ona bağlı değildir ve onu manifestinin bağımlılık bölümlerinde ya da herhangi bir Rust
  kaynağında anmaz; tek istisna `jt_mcp`'nin `[dev-dependencies]` içindeki MCP test istemcisidir), sağlayıcı
  bağdaştırıcıları (`jt_meta`, `jt_netgsm`, `jt_x`) yalnız `jt_outbound` üzerinden çıkar ve hiçbir HTTP
  istemcisi ya da soket adlandırmaz, sabit çıkış adresleri (`FIXED_HOSTS`) belgelenen kümenin birebir
  aynısıdır; `sqlx` yalnızca
  `jt_pg`'de (havuz kurmak için `jt_testkit` ve `jeeta`'da da), şifreleme ve anahtar türetme kütüphaneleri
  (`aes-gcm`, `hkdf`) yalnızca `jt_seal`'de bulunur; `jt_outbound`'un `test-loopback` özelliğini yalnız
  `[dev-dependencies]` bölümleri açar, `bin/jeeta` hiç açmaz. Aynı crate kapı kurallarını da sabitler: strateji
  kapısından yalnızca `auth.`, `workspace.`, `team.`, `roles.`, `api_keys.`, `agents.`, `platform.`,
  `strategy.`, `capability.`, `budget.`, `work.`, `connector.`, `events.` önekli kullanım durumları ve
  `ledger.list` muaf olabilir;
  çalışma alanı durumu denetiminden her durumda tam olarak `auth.`, `workspace.`, `platform.` önekliler,
  yalnız `pending_payment` iken de tam olarak `strategy.`, `work.` önekliler muaftır (her `connector.*` ve
  `events.*` kullanım durumu strateji kapısından muaf, durum denetimine tabidir); panel rotaları ve
  MCP araçları kataloğun tam karşılığıdır, MCP'ye özgü tek kullanım durumu `work.checkin`'dir ve kayıt
  60 araç tutar (M1a sonundaki 47'ye M1b'de `connector` 7, `events` 3, `capability` 1 ve `budget` 2
  eklendi). Webhook kapısı (`jt_webhook`) panel gibi bir axum adaptörüdür: izin listesi `jt_app`,
  alan crate'leri, sağlayıcı bağdaştırıcılarının ayrıştırıcıları, `axum`, `http-body-util`, `url` ve
  `tracing`'dir; hiçbir HTTP istemcisi ya da veritabanı crate'i adlandırmaz.
- `deny.toml`: aynı HTTP istemcisi ve `sqlx` kuralları (`reqwest` dışında hiçbir HTTP istemcisi, `ureq`,
  `isahc`, `surf`, `attohttpc`, `curl`, ağacın hiçbir yerinde bulunmaz) ile yapay zekâ, medya üretimi, ses
  tanıma ve ses sentezi sağlayıcı kütüphanelerinin bağımlılık ağacının hiçbir yerinde bulunmaması; lisans,
  güvenlik bildirimi ve kaynak denetimleri. Bir crate'in iki sürümü yalnızca `[bans] skip` listesinde
  nedeniyle yazılıysa kabul edilir (ör. `sqlx` 0.8'in kullandığı önceki RustCrypto kuşağı: `hkdf` 0.12,
  `hmac` 0.12, `sha2` 0.10, `digest` 0.10); `cargo deny check` uyarısız geçer.


## Gelen kutusu çekirdeği (M2a)

Aşağıdaki 30 işlem panel ve MCP üzerinde aynı JSON gövdesini döndürür. Hepsi etkin çalışma
alanı ister; `pending` ve `context` dışındakiler onaylı strateji de ister. Günlük çalışma `inbox.work`; sözlük, sahip atama ve
birleştirme işlemleri `inbox.manage` gerektirir.

| İşlem | Panel | MCP | Risk / izin |
|---|---|---|---|
| Kişi arama (`q`, `limit`) | `GET /api/inbox/people` | `jeeta.inbox.people_search` | READ / `inbox.work` |
| Kişi, kimlikler, açık yolculuk, konuşmalar | `GET /api/inbox/people/{person_id}` | `jeeta.inbox.people_get` | READ / `inbox.work` |
| Kişi eşleştir/oluştur | `POST /api/inbox/people` | `jeeta.inbox.people_create` | WRITE / `inbox.work` |
| Kimlik ekle / birleştirme öner | `POST /api/inbox/people/{person_id}/identities` | `jeeta.inbox.identities_add` | WRITE / `inbox.work` |
| Yolculuk aç | `POST /api/inbox/people/{person_id}/journeys` | `jeeta.inbox.journeys_open` | WRITE / `inbox.work` |
| Yolculuk, son 50 olay, görevler, notlar | `GET /api/inbox/journeys/{journey_id}` | `jeeta.inbox.journeys_get` | READ / `inbox.work` |
| Yolculuk olayı | `POST /api/inbox/journeys/{journey_id}/events` | `jeeta.inbox.events_report` | WRITE / `inbox.work` |
| Komisyon sahibi ata/kaldır | `POST /api/inbox/journeys/{journey_id}/owner` | `jeeta.inbox.journeys_assign_owner` | WRITE / `inbox.manage` |
| Kayıp nedenlerini oku | `GET /api/inbox/lost-reasons` | `jeeta.inbox.lost_reasons_list` | READ / `inbox.work` |
| Kayıp nedeni düzenle | `PUT /api/inbox/lost-reasons` | `jeeta.inbox.lost_reasons_set` | WRITE / `inbox.manage` |
| Durum etiketlerini düzenle | `PUT /api/inbox/status-labels` | `jeeta.inbox.status_labels_set` | WRITE / `inbox.manage` |
| Birleştirme önerilerini listele | `GET /api/inbox/merges` | `jeeta.inbox.merges_list` | READ / `inbox.manage` |
| Birleştir (`{keep}`) | `POST /api/inbox/merges/{merge_id}/apply` | `jeeta.inbox.merges_apply` | WRITE / `inbox.manage` |
| Birleştirmeyi geri al (`{confirm:true}`) | `POST /api/inbox/merges/{merge_id}/undo` | `jeeta.inbox.merges_undo` | DESTRUCTIVE / `inbox.manage` |
| Birleştirme önerisini reddet | `POST /api/inbox/merges/{merge_id}/refuse` | `jeeta.inbox.merges_refuse` | WRITE / `inbox.manage` |
| Görev oluştur (`{title,due_at,assignee?}`) | `POST /api/inbox/journeys/{journey_id}/tasks` | `jeeta.inbox.tasks_create` | WRITE / `inbox.work` |
| Görevi tamamla | `POST /api/inbox/tasks/{task_id}/complete` | `jeeta.inbox.tasks_complete` | WRITE / `inbox.work` |
| Görev kuyruğunu oku (`queue`, `assignee`) | `GET /api/inbox/tasks` | `jeeta.inbox.tasks_list` | READ / `inbox.work` |
| Not ekle (`{text}`) | `POST /api/inbox/journeys/{journey_id}/notes` | `jeeta.inbox.notes_add` | WRITE / `inbox.work` |
| `pending` | `GET /api/inbox/pending` | `jeeta.inbox.pending` | READ / `inbox.work` |
| `context` | `GET /api/inbox/conversations/{conversation_id}/context` | `jeeta.inbox.context` | READ / `inbox.work` |
| `conversations.list` | `GET /api/inbox/conversations` | `jeeta.inbox.conversations_list` | READ / `inbox.work` |
| `conversations.get` | `GET /api/inbox/conversations/{conversation_id}` | `jeeta.inbox.conversations_get` | READ / `inbox.work` |
| `messages.list` | `GET /api/inbox/conversations/{conversation_id}/messages` | `jeeta.inbox.messages_list` | READ / `inbox.work` |
| `take_over` | `POST /api/inbox/conversations/{conversation_id}/take-over` | `jeeta.inbox.take_over` | WRITE / `inbox.work` |
| `hand_to_agent` | `POST /api/inbox/conversations/{conversation_id}/hand-to-agent` | `jeeta.inbox.hand_to_agent` | WRITE / `inbox.work` |
| `snooze` | `POST /api/inbox/conversations/{conversation_id}/snooze` | `jeeta.inbox.snooze` | WRITE / `inbox.work` |
| `unsnooze` | `POST /api/inbox/conversations/{conversation_id}/unsnooze` | `jeeta.inbox.unsnooze` | WRITE / `inbox.work` |
| `close` | `POST /api/inbox/conversations/{conversation_id}/close` | `jeeta.inbox.close` | WRITE / `inbox.work` |
| `reply` | `POST /api/inbox/conversations/{conversation_id}/reply` | `jeeta.inbox.reply` | WRITE / `inbox.work` |

`reply`: `{text,intent:"reply"|"commercial",request_key?}`. Ticari gönderim güncel izin ve bastırma kayıtlarını iki çitte denetler.
Yanıt penceresi aynı konuşmadaki son gelen mesajdan itibaren 24 saattir. İki gönderim çiti
kayıp yolculuk, silinmiş/birleştirilmiş kişi, canlı kabiliyet ve yürütücü neslini denetler.
İnsan yanıtı yürütücüyü değiştirmez. Niyet, sağlayıcı çağrısından önce kalıcıdır; çağrı sırasında
veritabanı kilidi tutulmaz. Sonuç ve sistem `replied` olayı birlikte kaydedilir. Çağrı sırasında
terminal olan yolculuk değişmez; kabul edilmiş mesaj `sent` kalır ve `inbox.sent_after_terminal`
yazılır. Geç kabul, daha yeni gelen mesajı veya operatörün konuşma durumunu değiştirmez; gönderim
zamanı ilk denemenin zamanıdır. Kurtarma, göndermeden önce strateji onayını yeniden denetler.
Belirsiz gönderim `unknown` olur ve otomatik yeniden gönderilmez. Aynı çalışma alanındaki
`request_key` 24 saat boyunca kayıtlı yanıtı döndürür; sürmekte olan isteğin yanıtı `queued` olabilir.
`SendIntent` şimdilik uygulamanın `usecases::inbox::replies` modülündedir.

`people.create`: `{display_name, identities:[{channel,value,capability_id?}], source}`.
Başında `+` olmayan 10 haneli telefonlar Türkiye ulusal numarası sayılır: `532 123 45 67` → `+905321234567`; `0532…`, `90532…` ve `+90532…` aynı kimlikle eşleşir.
Telefonlar SMS/WhatsApp/arama arasında ortak, opak kimlikler kabiliyetin dış hesap kimliğiyle
kapsamlıdır. Çakışan kimlikler kişi verisini taşımaz; `identity_split` hatası iki kişi kimliğini ve
kalıcı birleştirme önerisini verir. İlk temas değişmez; kişi, ilk yolculuk ve kimlikleri tek işlemde
oluşturulur. Gelen mesajda kendi kanalının eşleşmesi önceliklidir.

`events.report`: `{kind,idempotency_key,payload}`. Dışarıdan yalnızca `call_made`,
`appointment_booked`, `meeting_held`, `quote_accepted`, `won`, `lost`, `snoozed`, `reopened`
raporlanır. `lost` yükü `{reason_key}`, `won` yükü `{product,amount_minor,currency}`,
`call_made` yükü `{connected}`, `snoozed` yükü `{until}`; ötekiler `{}` alır.
Kayıp nedeninin o andaki etiketi olayda korunur. Aynı çalışma alanında aynı anahtarın tekrarı
etkileri çalıştırmaz ve `inbox.event.duplicate` yazar; yeni anahtarla ikinci Won terminal
`CONFLICT` olur. Lost konuşmaları kapatır, açık görevleri iptal eder; Won açık görevleri tamamlar.
Değişiklik, etkiler ve günlük aynı veritabanı işlemindedir. Yeniden açma, insan sahip/yönetici ve
`inbox.manage` ister; Won yeniden açılmaz, yeni yolculuk `repeat` kaynağını alır.

`status_labels.set`: `{labels:{new:"Yeni",won:"Kazanıldı"}}`; yalnızca dokuz sabit durum
anahtarı kabul edilir. Etiketler çalışma alanı politika satırında saklanır; diğer politika alanları
korunur. Harita tamamen değiştirilir, boş harita varsayılan etiketlere döner. Bilinmeyen anahtarlar
ve boş etiketler `VALIDATION` verir; günlük yalnızca değiştirilen durum anahtarlarını içerir.

Birleştirmede `keep` kalan kişiyi seçer; iki kişinin de açık yolculuğu varsa işlem
`CONFLICT` / `two_open_journeys` döner. Kimlikler, yolculuklar, görevler ve notlar taşınır;
aynı kabiliyetteki konuşmaların eskisi kalır ve mesajlar korunur. Kalan kişinin ilk temas bilgisi
korunur. Geri alma en fazla 30 gün içinde ve `confirm: true` ile yapılır; birleşmeden sonra
kalan kişi, yolculuk veya konuşma değişmişse `CONFLICT` / `edited_after_merge` döner.
Aynı sağlayıcı mesaj kimliği iki konuşmada bulunursa her iki mesaj saklanır; çakışan kimliklerden
biri birleştirme süresince boş bırakılır, geri almada özgün kimliği yüklenir. Birleştirme zaman
damgası kilitlenen kayıtların son değişiklik zamanından ileridir; aynı zamanla gelen ikinci
bir birleştirme önceki geri alma korumasını silemez.

Görevlerde varsayılan `queue=due_24h`, şu andan 24 saat sonrasına kadar olanları (iki sınır dahil)
gösterir; `overdue` şu andan önceki görevleri, `all` zaman sınırı olmadan görevleri getirir.
`assignee` isteğe bağlı kullanıcı filtresidir. Not metni işlem defterine yazılmaz.

Conversation and message lists return `{items,next_cursor}` with stable keyset pagination (default 50, maximum 499). Pass `next_cursor` unchanged to continue. Conversation queues: `ours`, `unassigned` (human executor without a user, excluding closed), `snoozed`, `all`. Takeover requires a human principal and increments the executor generation; hand-to-agent also increments it. Snooze accepts a future RFC3339 `until`; unsnooze returns to `ours`. Reply accepts `{text,intent:"reply"|"commercial",request_key?,subject?,in_reply_to?,references?}`; commercial intent requires effective consent and no suppression. Human replies preserve the executor.

### Gelen olay tüketicisi (`inbox@1`)

`inbox_consume`, 10 saniyede bir `jeeta.jobs.inbox_consume` kilidi altında
`active` ve `pending_payment` alanlarda çalışır; strateji onayı gerektirmez.
`list_for_consumer("inbox@1", cursor, 100)` üzerinden sayfalar. Her olayın talebi
(`try_claim`), kişi/kimlik, konuşma, mesaj, yolculuk olayı ve tüketim sonucu tek
alan işleminde yazılır. Hata hepsini geri alır; yalnız hata kodu günlüğe yazılır,
sonraki olaylar devam eder, başarısız olay bir sonraki taramada yeniden denenir.
`events.ack` yalnız görülme bilgisidir; alan tüketimini atlatmaz.

WhatsApp, Messenger/Instagram ve NetGSM SMS mesajları gerçek adaptör payload'larından
okunur. Telefon kimliği SMS/WhatsApp/aramada ortaktır; opak kimlikler kabiliyetin
harici hesap kimliğiyle kapsamlanır. Her yeni inbound mesajdan sonra aynı işlemde
`MessageRepo::record_inbound_sender(message_id, sender_identity_id)` çağrılır;
normalleştirilmiş/hesapla kapsamlanmış kimlik, mesajın gönderenini kaydeder ve en son
gelen mesaja göre `last_inbound_identity_id` değerini günceller. Geç gelen eski mesaj
ve tekrar teslim, daha yeni göndereni değiştirmez; ayrı bir gönderen kaydı tutulmaz.
Etkinlik ve mesaj zamanı RFC3339 `payload.occurred_at` değerinden alınır; değer yoksa,
geçersizse veya `received_at` değerinden beş dakikadan fazla ilerideyse `received_at`
kullanılır. Yanıt kontrolü de kabul edilen beş dakikalık saat farkını tanır.
Gecikmiş eski mesaj, 24 saatlik yanıt penceresini yenilemez.
Page/Instagram profil kabiliyetine yönlenen Meta mesaj/echo/raporları, aynı çalışma
alanı ve harici hesaptaki emekliye ayrılmamış `messenger`/`instagram_dm` kardeşine
çözülür; kardeşi bulunmayan olay ertelenir.
Mesaj kimliği sağlayıcının mesaj kimliği,
yolculuk anahtarı `inbound:<event_id>` olur. Lost mesajı aynı yolculuğu korur ve
konuşmayı Ours/Human{None} yapıp executor neslini artırır; Won sonrası yeni Repeat
yolculuğu açılır, kişinin ilk kaynağı değişmez. Echo, mevcut gönderiyi eşler veya
bilinen konuşmaya System outbound yazar; teslim raporları eşleşen gönderiyi günceller.
Echo makbuzdan önce gelirse, aynı metinli ve henüz harici kimliği olmayan `sending`
gönderiye (veya son beş dakikada `sent` olmuş gönderiye) kimliği bağlar; yazarını korur.
Kaydedilmiş `fence_snapshot.send_at` echo'nun alınma zamanını geçemez; kuyruk zamanı
tek başına eşleşme kanıtı değildir. Teslim sonucu, sonradan dönen kabul makbuzu veya
belirsiz ağ hatası tarafından düşürülmez.
Birden fazla aday varsa tahmin etmek yerine erteler. Makbuz aynı kimliği tekrar
kaydedebilir. `MessageRepo::find_by_external_id` çalışma alanı/kabiliyet kapsamında
indeksli arar; rapor ve echo eşlemesi tüm konuşma/mesaj geçmişini taramaz.

NetGSM PBX olayları `unique_id` ile ilişkilendirilir. `inbound_call`/`answer`
konuşma etkinliğini günceller; Hangup, `call:<unique_id>` anahtarıyla tek `call_made`
yazar. Kısmi etkinlik, sürümler arasında sabit `inbox.pbx_activity` talebiyle
yalnız bir kez uygulanır. Aynı teslim zamanındaki kardeş olaylar, üretilen kimliklerin
sırasından bağımsız olarak çalışma alanı/sağlayıcı/`unique_id` ile ilişkilendirilir.
Bağlantı yalnız Hangup'a kadar saklanan Answer ile doğrulanır; Hangup'ın
durum/metin/süre alanı bağlantı kanıtı değildir. Sonradan gelen olay sonucu değiştirmez.

M2a `inbox@1`, LeadGen ve Consent olaylarını ertelerdi; M2b `inbox@2` bu türleri işler.
Unknown, yönlendirilmemiş/desteklenmeyen kabiliyet olayları, eşleşmeyen raporlar ve
henüz konuşması bulunmayan echo'lar `deferred` kaydedilir.
Önceki tüketicinin kayıtları `inbox@2` tarafından tekrar talep edilebilir; mesaj ve yolculuk anahtarları
sürümler arasında sabit kalır. Konuşmasız echo için gelen temas zamanı uydurulmaz.

T014 inceleme notu: Lost yolculuktaki PBX olayları şu anda yan etki olmadan ertelenir;
reducer `CallMade` olayını Lost üzerinde reddeder. Lost Hangup kararının kalıcı kaydı ve
konuşmasız echo için gelen temas oluşturmayan repository işlemi koordinatör kararı bekler.


### Inbox pending/context and timers

Only `inbox.pending` and `inbox.context` are exempt from the strategy gate; both still require
an active workspace and `inbox.work`. Pending queues follow the executor (unassigned human
queues are visible to all holders). Context includes at most ten recent conversations for the
same person, the last three messages each, ten journey events, open tasks, and live strategy
identity/segments/channel hypotheses plus prohibitions. No strategy produces null guidance.
`work.pending` derives ReplyDue/ReopenQuestion (priority 2) and MergeSuggested/TaskDue (3), after
strategy work, and preserves workspace status filtering.

`response_sla` and `snooze_wake` run every minute under separate advisory locks. SLA hands stale
Ours/Agent conversations to the journey owner or unassigned humans, increments the executor
fence and records one ledger entry per handover. Snooze wake changes elapsed snoozes to Ours
once. Member removal unassigns their executor conversations and all owned open journeys in the
removal transaction, recording each change. `WorkspacePolicy.inbox` holds `max_response_s`
(whatsapp/instagram_dm/messenger 900; sms 3600), `unreachable_threshold` (3) and fixed-key
`status_labels`. Migration 0007 stores response settings and preserves existing label overrides;
its down migration removes only the added policy column.


### M2a inbox core: model, reducer and surfaces

The catalog contains **106 MCP tools: the M1b 60 plus 46 inbox tools**. Every inbox tool
has a panel HTTP twin and a shared strict input schema. `inbox.pending` and `inbox.context`
are strategy-exempt; all other inbox operations are gated. All retain the workspace-status
check. `inbox.work` covers normal work; `inbox.manage` covers owner assignment, dictionaries
and merges. Owner/manager have both, Rep has work; custom grants are preserved.
`jeeta.inbox.merges_undo` requires explicit confirmation. Agents cannot take over as a person.

A person owns active identities and conversations (one per capability), with at most one open
journey. SMS, WhatsApp and calls share the normalized `phone` identity; email is trimmed and
lowercased. Instagram DM, Messenger and webchat identifiers include the capability's external
account id before matching. Acquisition source/first touch is separate and a merge preserves
the keeper's first touch. Every person creation path shares `match_or_create`; conflicting
email/phone identities produce a merge suggestion, not a silent reassignment. Undo refuses
when the keeper has changed since the merge.

| Event | Journey and effects |
| --- | --- |
| `message_received` | Keep stage, conversation Ours; Lost stays Lost and becomes unassigned human work. |
| `replied`, connected `call_made` | New/Unreachable → Contacted; reset failed attempts. Reply also makes conversation Theirs. |
| Failed `call_made` | Count attempts; default third failure enters Unreachable only at rank ≤ 1. |
| `appointment_booked`, `meeting_held`, `quote_sent`, `quote_accepted` | Advance to Appointment, Met, Quoted, Pending respectively without regressing a later stage. |
| `won` | Close journey and open tasks; consume CommissionDue and snapshot the human owner’s commission in the same transaction. |
| `lost` | Snapshot active loss-reason label; close conversations and cancel open tasks. |
| `snoozed` | Snooze conversation until the given instant. |
| `reopened` | Human owner/manager with inbox.manage: Lost → Contacted; clear closure, loss and attempts. |
| `merged` | Preserve stage while moving ownership to the keeper person. |

Rank is New=0, Contacted=Unreachable=1, Appointment=2, Met=3, Quoted=4, Pending=5.
Won/Lost are terminal, outside this order. Won never reopens; later inbound opens a Repeat
journey. Lost inbound never creates another journey. System Replied after terminal closure is
a no-op transition. Events use a required workspace-wide idempotency key; duplicates suppress
effects and ledger `inbox.event.duplicate`. Different-key Won on Won conflicts.
`Transition` has private fields, no public constructor, Deserialize or Default; compile-fail
doctests protect those boundaries. Creation uses `begin_journey(id, workspace_id, person_id,
source, at) -> InitialJourney`, an equally unforgeable wrapper with an immutable journey accessor.
It fixes New, zero attempts, no owner/closure/loss, and both timestamps to `at`. The port only
accepts `insert_initial(InitialJourney)`; later status writes require `apply_transition(Transition)`.
Structural tests parse every PostgreSQL source file and distinguish INSERT from UPDATE. Merge
undo's single documented snapshot statement restores only an existing journey's person/time;
it neither creates a journey nor changes its status. Fixtures use the same domain creation path
and assign owners explicitly through the existing operation.

A conversation's executor defaults to Agent and is separate from the journey owner. Every
handover increments its generation; Human(None) is the unassigned queue. Human replies do not
change the executor and do not require holding it. Agent replies refuse human-held conversations.
`context` and `journeys.get` return all nine effective `status_labels`: fixed Turkish defaults
with workspace policy overrides. Keys remain fixed. They also return `status_label_overrides`,
only the workspace's own labels: the panel renders an override when one exists and otherwise its
own translation of the stage, so the English panel does not show the Turkish defaults.

Reply uses a durable outbox: commit queued intent after the first fence, recheck under locks
immediately before sending and persist the fence snapshot, release all locks for provider I/O,
then atomically persist the receipt/message/event/effects. Both fences check loss, erased or
merged person, live capability, executor generation and agent ownership; reply intent also
requires inbound in the same conversation within 24 hours. Lost/takeover before sending refuses.
Uncertain provider acceptance stays Unknown and is never blindly retried. A successful send
racing terminal closure remains Sent and records `inbox.sent_after_terminal`; it does not reopen
the journey. Optional `request_key` reuses responses for 24 hours within a workspace.

`inbox_consume` claims provider events separately from `events.ack`, with person/identity/message,
reducer effects and consumption completion in one transaction. It does not need a principal or
approved strategy; it consumes Active/PendingPayment workspaces and defers suspended ones.
The consumer namespace is `inbox@1`; provider/message/event keys remain stable across versions.
`response_sla` transfers overdue Ours/Agent conversations to the journey owner or Human(None),
bumps the fence and ledgers once; `snooze_wake` wakes elapsed snoozes once. Both run every minute.
Member departure unassigns human conversations and open journey ownership in the removal transaction.

The panel exposes conversations, tasks and people with the three-column inbox: queue/person,
conversation/reply, journey/events/tasks/notes. It shows actor and executor, supports takeover,
hand-back, snooze, events, loss/reopen and merge/undo confirmation; customer text is rendered as text.

Run `make smoke-inbox` from `rust/`: `cargo test --locked -p jt_app --test smoke_inbox`.
It parses a scripted WhatsApp fixture, consumes it into person/journey/conversation, reads agent
context, sends a scripted successful reply, checks the system Replied event and acknowledges
inbound events. Everything runs in process without PostgreSQL, network access or provider secrets.

Merging conversations refuses moved queued outbox entries with `conversation_merged`, completes
their request-key responses and records refusals in the ledger. Moved sending/unknown entries keep
their state and gain a durable `conversation_merged` flag: provider outcomes, request-key responses
and journey Replied events reconcile normally, but never change conversation state or activity.
Undo preserves both refusals and the flag. Sending entries older than two minutes still recover to
Unknown without resending. Replies, context and pending queues
prefer the open journey over newer closed history. A successful receipt still establishes contact
when inbound or other events leave the journey rank unchanged; newer milestones or any intervening
closure keep historical-only bookkeeping. Closure is retained in the outbox fence across reopening;
the separate conversation activity revision preserves newer inbound/Ours activity.

PBX calls use the workspace's `inbox.unreachable_threshold`. Correlation uses
`InboundEventRepo::call_events(unique_id, until)`, including same-receipt-time siblings and processed
rows, scoped to Netgsm call events in the tenant. Migration 0006 adds stored generated
`inbound_events.call_unique_id` and the `inbound_events_call_lookup` composite index: PostgreSQL can
use the call key as an index condition under forced RLS. The BEFORE append-only guard excludes only
the database-generated key; rollback drops the key/index and restores the original guard. Shared
fake/PostgreSQL contracts cover time/tenant/provider/kind boundaries and processing updates; a tenant
EXPLAIN regression verifies the indexed lookup and a schema test checks up → down → up.


### M2b connector port prerequisites

`SmsSender::send` takes `commercial: bool`: NetGSM sends `iysfilter="11"` for commercial SMS
to individuals and `"0"` for informational messages; `"12"` for business recipients is not used yet.
M2a reply callers explicitly pass `false`; commercial
consent enforcement is supplied by the later M2b use cases.

`MailSender` accepts a typed `MailMessage` with recipient, subject, text, stable Message-ID,
thread headers and `Attachment` values. Credentials remain a separate argument. Attachment
`Debug` includes only filename, MIME type and byte count; attachment bytes are never logged or
written to the ledger. The message and attachment types deliberately do not implement serde.
`MailboxPoller` returns inbound drafts and a `MailboxCursor` with a `MailboxPosition`
(`uidvalidity`, `last_uid`) for each mailbox name (INBOX/Sent). The caller must persist the cursor
atomically with drafts. The `mail_sender` and
`mailbox_poller` registry getters offer the [mail adapter](crates/adapters/jt_mail/README.md) for
`Provider::Mail` in production and scripted registries. Both ports take a workspace per call and
use tenant-authorized SMTP/IMAP sockets with mandatory TLS. Probe and connection hooks receive
the capability's authoritative `workspace_id` through public metadata. Scripted connectors
record workspaces, arguments and queued outcomes for tests.

`OutboundJobRepo::pending_job_ids` and `record_status` both require a capability ID. The NetGSM
DLR job reads pending jobs, polls and records statuses separately for each verified SMS capability;
provider job IDs shared by different capabilities cannot update one another. PostgreSQL and the
in-memory adapter persist jobs and poll only queued/sent rows younger than 72 hours, with a known
provider job ID. Unknown submissions are not automatically polled or resent.

Compliance repository getters on `TenantRepos` share the transaction with inbound event inserts,
mailbox cursor updates, journey changes and ledger writes. `consents` preserves effective history
while updating only synchronization state; suppression inserts are idempotent; commissions are
unique per journey. `commission_default` and `commission_user_rates` store independent rate settings.
`erasure` records first requests and channel-scoped identity hashes for replay protection.

`attribution().insert_once` preserves the first acquisition record on replay or later touches.
`Deps::attribution()` supplies the application-owned `AttributionReader` over the configured Pg or
in-memory unit of work. Reads establish the workspace context, use the half-open acquisition window
`[from,to)` and order by `(acquired_at,journey_id)`. No update or delete API exists.

### Mailbox connection and email replies (M2b Task 4)

The existing `connector.set_credentials` operation accepts a `mailbox` credential on both
`POST /api/connectors/credentials` and `jeeta.connector.set_credentials`:
`smtp_host`, `smtp_port`, `imap_host`, `imap_port`, `username`, `password`, `from_address`,
`tls` (`implicit`: 465/993; `start_tls`: 587/143). The panel Connect page offers the same form
in Turkish and English. Credentials are sealed; committed public hosts authorize the initial
probe, which verifies the IMAP account and SMTP sender. Connection, declaration, rebind and
retirement serialize host changes per workspace, preserving shared live connector hosts and
excluding agent/device metadata. Rebinding removes old hosts and resets mailbox cursors;
credential replacement also resets cursors before polling the new server.

Mail polling runs every two minutes for active/pending-payment workspaces. Network I/O runs
outside the cursor transaction; the account, credential and previous cursor are rechecked
before drafts and both mailbox positions commit atomically. The normal inbox consumer matches
normalized email identities, including MIME senders with display names.

`inbox.reply` / `POST /api/inbox/conversations/{id}/reply` / `jeeta.inbox.reply` accept optional
`subject`, `in_reply_to`, `references` and `request_key`. Email replies persist the full typed
mail and stable `<outbox-uuid@public-base-host>` Message-ID before sending through MailSender;
they require the configured public base URL, the same 24-hour inbound window and both normal
outbox fences. If omitted, threading uses the latest inbound Message-ID; the default subject is
`Re:`. Account/host or recipient changes refuse a queued email instead of sending stale bindings.

Sent evidence is correlated by exact persisted Message-ID and capability, in the consumer's
claim transaction. It resolves an unknown send once, reuses the request-key response, and
records `inbox.sent_after_terminal` without reopening a terminal journey. DSNs record failure.
Unknown SMS without a provider job ID stays unknown: no reference lookup or automatic resend.
Mailbox flows add no catalog rows. The completed M2b release has 106 tools, including the five
compliance tools below.
Commercial sending/consent ingestion remain Task 5; calendar integration, archive, HTML mail
composition and webchat remain M2c.


## M2b consent, suppression and commercial sending

Five strategy-gated compliance operations are included in the 46 inbox tools (106 total):

| Row | Panel route | MCP tool | Permission |
|---|---|---|---|
| `inbox.consent.record` | POST `/api/inbox/people/{person_id}/consents` | `jeeta.inbox.consent_record` | InboxWork |
| `inbox.consent.list` | GET `/api/inbox/people/{person_id}/consents` | `jeeta.inbox.consent_list` | InboxWork |
| `inbox.suppressions.add` | POST `/api/inbox/people/{person_id}/suppressions` | `jeeta.inbox.suppressions_add` | InboxManage |
| `inbox.suppressions.remove` | DELETE `/api/inbox/people/{person_id}/suppressions/{channel}/{reason}` | `jeeta.inbox.suppressions_remove` | InboxManage |
| `inbox.send` | POST `/api/inbox/people/{person_id}/send` | `jeeta.inbox.send` | InboxWork |

Consent input is `{channel,kind,source,at}`; `at` is RFC3339 and cannot be future dated.
The latest effective decision wins, with withdrawal winning equal-time ties. SMS and call
consent are separate. Lists include both consent history and active suppressions. Manual
suppression insertion is idempotent; removal removes only the selected reason/channel.
Applied merge aliases contribute their immutable consent/suppression history to the survivor.
Undo excludes that alias again; compliance mutations advance the person edit guard.

`send` takes `{channel,text,intent:"commercial",request_key?}` and selects the single verified,
configured capability for that channel; ambiguous capability or recipient selection is refused.
It creates an outbound conversation without manufacturing inbound activity. Both enqueue and
provider fences read current consent and suppression; missing permission or suppression returns
FORBIDDEN `IZIN_YOK`, ledgered without message/identity text. Reply intent keeps its same-conversation
24-hour inbound window. Commercial sends require consent; WhatsApp, Messenger and Instagram
also require an open provider 24-hour window at enqueue and send time, otherwise returning
VALIDATION `provider_window_closed`. Templates and message-tag sends are deferred to M2c.
SMS and email commercial sends have no inbound-window requirement. SMS commercial sends use
`iysfilter=1`; Reply uses 0. Both send/reply share the 24-hour workspace request-key response cache
and existing outbox recovery, including never automatically retrying unknown sends.

The `inbox@2` consumer reclaims deferred consent callbacks. NetGSM adapter decisions use the
provider's effective timestamp; undated, invalid or future grants are deferred instead of
using arrival time. Incoming mail withdrawals suppress the matched person.
Correlated mail bounces and ARF abuse/fraud/virus complaints add email suppression and refuse subsequent queued commercial
mail at its provider fence. Unknown identities are deferred without creating a person.

Mail sends, polls and probes refresh the instance's tenant egress registry from the workspace's
committed live connector host declarations before provider I/O, including on instances with jobs
disabled. `refresh_tenant_hosts` also runs every minute for active/pending_payment workspaces under
the scheduler advisory lock. Both refresh paths use the workspace host-mutation guard, replace the
whole tenant tier, preserve hosts shared by live connectors, and remove obsolete hosts. This keeps
a mailbox connected on one instance usable on the next mail call on another instance.

The hourly `iys_sync` job uses the existing advisory-lock scheduler. It submits pending/failed
SMS (`MESAJ`), telephone (`ARAMA`) and email (`EPOSTA`) decisions. Withdrawals send `granted=false`.
Submissions batch up to 500 rows; throttling does not spend the retry budget. Unsupported
channels and erased people are excluded before pagination. Merged aliases synchronize through
the survivor’s identities, retaining the original decision and effective time. Missing or ambiguous recipients
consume bounded validation retries so they cannot permanently block later withdrawals.
An acknowledgement marks sent; errors increment attempts, and attempt five marks failed_final
and creates a human follow-up task. Sent/failed_final rows are not retried. Provider I/O holds
no tenant transaction. Lost acknowledgements may repeat submissions: there is no exactly-once
provider guarantee. As with other jobs, enable scheduling on one server instance.

Provision İYS through `POST /api/connectors/credentials` or `jeeta.connector.set_credentials`:
`{"capability_id":"<existing SMS line>","credential":{"kind":"netgsm_iys","usercode":"<same SMS usercode>","password":"<IYS password>","brand_code":"<brand>"}}`.
The line must be live and hold SMS credentials; a mismatched usercode returns `VALIDATION`
with reason `iys_usercode_mismatch`. İYS credentials are sealed in the line's separate
`iys_sealed` slot; SMS credentials, probe state and account binding are preserved. The public
brand is `connector_public.iys.brand_code`; `iys` is reserved against ordinary capability edits.
Migration 0008 adds the nullable slot and its down removes only that added column.
The optional İYS section on ConnectPage attaches to an existing SMS line, including immediately
after saving a new line. Its password is cleared after success and excluded from query caches.
Sync reads each candidate capability and both sealed slots in one row-locked snapshot, rechecks
liveness, and takes the brand from inside the sealed İYS credential; the public brand is display only.
It checks the usercode against the SMS credential and leaves consent pending when none or multiple
are usable. The row lock is released before provider I/O.
One open owner task asks for provisioning; repeated hourly runs do not duplicate it or spend
consent retry attempts. Provisioning can be retried without replacing the SMS credential.
The capabilities page offers İYS setup for live SMS lines with credentials, including verified
lines; verified lines show only the İYS form. Retirement clears both sealed slots, and rebinding
a line clears its İYS slot and brand metadata along with the old account credentials.

## M2b quotes and internal appointments

Six strategy-gated `InboxWork` operations handle quotes and appointments. Each operation uses the same input, output and permission on HTTP and MCP:

| Use case | MCP tool | HTTP route |
|---|---|---|
| `inbox.quotes.send` | `jeeta.inbox.quotes_send` | POST `/api/inbox/journeys/{journey_id}/quotes` |
| `inbox.quotes.list` | `jeeta.inbox.quotes_list` | GET `/api/inbox/journeys/{journey_id}/quotes` |
| `inbox.quotes.accept` | `jeeta.inbox.quotes_accept` | POST `/api/inbox/quotes/{id}/accept` |
| `inbox.appointments.book` | `jeeta.inbox.appointments_book` | POST `/api/inbox/journeys/{journey_id}/appointments` |
| `inbox.appointments.cancel` | `jeeta.inbox.appointments_cancel` | POST `/api/inbox/appointments/{id}/cancel` |
| `inbox.appointments.held` | `jeeta.inbox.appointments_held` | POST `/api/inbox/appointments/{id}/held` |

MCP uses `journey_id`, `quote_id` or `appointment_id` for the corresponding path identifier.
Quote send accepts `{amount_minor,currency,valid_until,file_ref?,channel,text,intent,request_key?}`.
Business event key prefixes `quote:` and `appointment:` are reserved; client `events.report`
cannot manufacture delivery or booking evidence. Amounts must be nonnegative, currency must be
an assigned uppercase ISO 4217 code, and validity
must end in the future. The quote, message, outbox and optional 24-hour workspace request-key
response commit together. The response is `{quote,delivery:{message_id,state}}`; `delivery.state`
is authoritative for delivery, separately from the quote's business lifecycle. Reusing a key
returns the stored quote and response without another send. Unknown delivery is never resent;
provider acceptance or later evidence records `quote_sent` once. Late receipts after Won/Lost
remain historical, including after a Lost journey is reopened: the persisted closure fence
prevents old receipts from advancing its new lifecycle. Accept requires confirmed
delivery, refuses an expired quote, and atomically records `quote_accepted` (Pending).
`file_ref` is opaque and agent-owned: the platform does not fetch, host or delete its asset.

Book accepts `{starts_at,ends_at,location,intent}` with RFC3339 times and `ends_at > starts_at`.
It atomically records `appointment_booked` and an automatic task due **one hour before** start,
assigned to the journey owner (or unassigned). The reminder uses the appointment UUID in the
separate task table. Held records `meeting_held` and completes the reminder; cancel cancels only
that booking's reminder. Cancellation also works on Won/Lost journeys without a journey
transition; it cancels the reminder even if closure already completed it. Repeating the same final state is idempotent; a different final state
conflicts. The result contains `{appointment,reminder,notification:{state,message_id}}`.

When a verified mailbox and active email identity are available, booking includes an
`appointment.ics` attachment in the ordinary durable mail outbox. The explicit Reply/Commercial
intent obeys both enqueue and provider fences, including the reply window and commercial consent/
suppression checks. A missing mailbox or email identity gives notification `unavailable`;
an enqueue fence refusal gives `refused` and a ledger entry while retaining the internal booking.
Unknown mail is ledgered and reconciled through the same Message-ID recovery, without resending.
Cancelling or holding a booking before its mail is claimed refuses the pending confirmation.
Attachment bytes and personal location/text are excluded from ledger entries. These are internal
appointments; external calendar availability, OAuth, events and public booking remain deferred.


## M2b human commissions

The release has **106 MCP tools**, including **46 inbox tools**. Commissions are part of the
inbox (`/inbox/commissions` in the panel), with shared strict request schemas on both surfaces:

| Use case | MCP tool | HTTP route | Permission |
| --- | --- | --- | --- |
| `inbox.commissions.list` | `jeeta.inbox.commissions_list` | GET `/api/inbox/commissions?state&payee` | `inbox.work` |
| `inbox.commissions.approve` | `jeeta.inbox.commissions_approve` | POST `/api/inbox/commissions/{id}/approve` | `inbox.manage`, owner/manager authority |
| `inbox.commissions.pay` | `jeeta.inbox.commissions_pay` | POST `/api/inbox/commissions/{id}/pay` | `inbox.manage`, owner/manager authority |
| `inbox.commission_rates.set` | `jeeta.inbox.commission_rates_set` | PUT `/api/inbox/commission-rates` | `inbox.manage` |

All four operations require an approved strategy and an active workspace. MCP approval/payment
uses the issuer's owner/manager authority and effective `inbox.manage` scope. Payment records a
human payment decision; it does not transfer funds. Only Pending → Approved → Paid is allowed;
repeated or out-of-order decisions return CONFLICT and do not duplicate ledger entries.

Won consumes CommissionDue inside the journey/event/effects/ledger transaction. Its payee is the
active human journey owner at that instant, independent of the reporting actor or conversation
executor. `commission_user_rates` overrides `commission_default`, including a zero override;
a missing default means zero basis points. PUT accepts `{user_id?, rate_bp}`: omit/null user_id
for the workspace default, or name an active member for an override. Rates are unsigned 16-bit
basis points (100 = 1%). The amount uses integer round-half-even; unrepresentable amounts return
VALIDATION and roll back Won. Amount, currency, rate and payee remain fixed after later rate or
owner changes. Same-key Won repeats produce one commission; another key on Won returns terminal
CONFLICT. Workspace locking serializes Won, rate changes and commission decisions.

Without an active owner, the snapshot is NoPayee and can never be approved or paid. Existing open
tasks close on Won; a new unassigned follow-up task remains open and due immediately. Assigning
an owner later does not rewrite that financial snapshot. The panel lists state/payee filters,
shows snapshot rates and amounts, and offers only permitted next actions and future-rate settings.


### Person erasure and replay protection

`POST /api/inbox/people/{person_id}/erase` and `jeeta.inbox.people_erase` require
`inbox.manage`, the strategy gate and explicit `{ "confirm": true }`. The panel provides
this action on the selected person's page and conversation, with a typed confirmation dialog:
`SİL` in Turkish, `ERASE` in English. Dismissal/reopening clears the typed confirmation.
The operation is atomic and repeatable: it keeps the person as `silinmiş kişi` with
`erased_at`, keeps journey/event/commission IDs and financial amounts, and removes identities
while retaining tenant-scoped hashes of their normalized, account-scoped values.

Erasure clears personal message/note/event text, task titles, quote file references,
appointment locations, merge restoration snapshots, queued mail bodies/recipients/attachments,
matching request-key responses and person-linked probe facts. Provider delivery jobs enter terminal
`erased` state; polling skips them and late delivery reports cannot restore recipient numbers.
Queued sends are refused and
conversation generations advance to invalidate outstanding send claims. The non-personal stable
mail Message-ID remains available for late Sent-folder evidence to reconcile unknown sends. An already submitted
provider request cannot be recalled. File references are forgotten; agent-owned assets are
not fetched or deleted by the platform.

Inbound events match by person reference, normalized adapter identity, or the original outbound
mail Message-ID within the same capability (including bounce and complaint reports). Matching payloads are
scrubbed, and every copy of their raw delivery batch in that workspace is nulled; unrelated
parsed payloads and other tenants remain unchanged. PostgreSQL's non-ledger history guards
permit only person-scoped erasure using transaction-local settings, with ordinary append-only
protection restored when the transaction ends. Migration 0008 remains an up/down pair.

Ledger rows remain physically append-only. All ledger reads recursively mask personal keys
when `payload.person_id` appears in that tenant's erasure log. Webhook and IMAP intake check
tombstones under the same workspace lock as erasure, before storing payloads or raw batches.
A batch containing an erased identity retains no raw body, even on an unrelated sibling event.
Consumer identity checks also run before person matching; each dropped event is durably
counted by its `event_consumption.outcome = 'erased_identity_drop'`, without recreating a person.
Manual creation and identity attachment reject these hashes as well. Erased journeys reject
new tasks, notes and reports with `CONFLICT` / `person_erased`; repeat erasure scrubs any late
legacy writes. Scrubbed mail status evidence still reconciles uncertain sends.

The commissions panel formats amounts using the currency's minor units (including JPY and KWD).

## M2b lead-gen intake and attribution

The `inbox@2` system consumer now processes Meta Page lead-form webhooks, including events
previously deferred by `inbox@1` or earlier `inbox@2` builds. Only deferred Meta LeadGen
claims are reclaimable within `inbox@2`; other kinds, providers, outcomes, and consumers stay
final. Reclaiming a claim and applying effects share the same transaction. Page webhooks routed to either `facebook_page` or `messenger`
fetch the submission with that capability's bound `PageToken` credential,
then matches all `LeadGenRecord.fields` email/phone values in one identity operation. The
provider read holds no transaction or domain locks; intake locks and rechecks the Page binding
before applying the fetched data. Provider errors leave the event unclaimed for retry.

New people have `first_touch.source = meta_ads`. Existing people retain their original first
touch and gain a `lead_received` journey event. An open journey is reused; a Won journey leads
to a new Repeat journey; a Lost journey stays Lost and receives a review follow-up. Each accepted
submission creates one task due one hour after intake, assigned to the journey owner or the
unassigned queue. Forms create no conversation, inbound message, consent, or reply window.

Person/identity changes, the journey event, initial attribution, task, ledger, and consumer claim
commit together. Replays cannot duplicate their effects. An email/phone split returns
`CONFLICT` with `reason: identity_split`, both person IDs, and a durable merge suggestion. This conflict commits only its review
suggestion and ledger entry, leaves the event unclaimed, and creates no intake effects. Repeated
unresolved attempts reuse the suggestion; a caller can resolve the split and retry with one identity.

`journey_attribution` records only the submission that opens a journey. Existing-journey later
touches never fill or replace its original attribution. `acquired_at` is the provider's form
acquisition time (fetched `created_time`, or the webhook's acquisition timestamp), never the
processing time. Missing ad, campaign, and form IDs remain null; `adset_id` stays null rather
than inferring it from `adgroup_id`. PostgreSQL and the fake preserve the first row; PostgreSQL
also rejects direct updates/deletes. Anonymous provenance survives raw-event retention and
person erasure. Erased email/phone hashes prevent later forms from recreating the person.

The existing people-get and journeys-get panel/MCP operations expose the results; journeys-get
includes `attribution` (or null), touch events, and follow-up tasks. This system consumer adds
no public catalog row, route, permission, or tool, so release counts remain unchanged.
`Deps::attribution()` provides tenant-scoped journey reads and half-open `[from,to)` ad reads,
ordered by acquisition time and journey ID. The historical Task 9 migration-test name mentions
0007; the compliance schema lives in unreleased **0008**, whose reversible round trip retains
unrelated inbox rows.


## M2b panel and architecture completion

The inbox has **46 tools**, of which **16** are new in M2b: consent/suppression/commercial send
(5), quotes/internal appointments (6), commissions/rates (4), and person erasure (1).
Together with M1b's 60 tools, the release has **106**. Catalog rows, panel HTTP routes, MCP
registry entries and shared input schemas have exact-set parity checks. Only `inbox.pending`
and `inbox.context` bypass the strategy gate; workspace-status checks remain on every inbox row.
Both `inbox.merges.undo` and `inbox.people.erase` require explicit confirmation.

The panel exposes consent history, effective time/source, İYS synchronization status and active
suppressions in the person's or conversation's **Consent and suppressions** disclosure.
`inbox.work` records consent and sends commercial messages; `inbox.manage` adds manual blocks,
removes a specific reason/channel, and erases personal data. Commercial sends always declare
Commercial intent; neither changing a form nor removing one suppression substitutes for consent.
Quote and appointment forms use the same fields validated by the HTTP/MCP shared schemas.
Quote sends retain the request key across transport retries and report delivery state separately
from business state. An unknown delivery must not be resent. File references are opaque text,
never fetched or rendered as asset links.

Journey disclosures list quotes and internal bookings, accept a quote, book an appointment,
cancel a booking or mark it held. `journeys.get` now includes persisted `appointments` on both
surfaces so those actions remain available after reloading. A booking remains recorded when its
ICS notification is refused or unavailable; the panel shows that outcome explicitly. Cancellation
remains available on a closed journey. Input times use the browser's local timezone and are sent
as RFC3339 instants. The commission page and mailbox/optional İYS connection forms retain their
existing permission checks and secret-clearing lifecycle. Panel strings and forms have TR/EN parity.

`mail_crate_has_no_direct_dns_or_connect` is a **supplementary source scan**, backed by the mail
adapter's real socket tests (including a public hostname resolving into private space and DNS
timeouts). Dependency allowlists keep domain/application code independent of mail libraries;
only `jt_mail` uses the mail protocol libraries and its sockets come from authorized outbound
egress. Tests also cover commercial consent at both fences, identity replay after erasure,
and duplicate Won events/commission creation.

Q4 retention keeps a `silinmiş kişi` tombstone and accounting IDs/amounts; it scrubs personal
content and masks append-only ledger payloads at read time. Migration 0008's conditional CHECK
downgrade retains the widened provider constraint if mail rows exist. Unknown SMS without a
provider job ID stays unknown, without correlation or automatic resend; İYS synchronization has
bounded retries and no exactly-once guarantee. External calendar OAuth/availability/events,
HTML mail, webchat and an inbox archive command remain **M2c**. Erasure, Lost and archive are
not interchangeable operations; no erase/lost/archive parity is claimed.

Task verification (from `rust/`, with `JEETA_TEST_DATABASE_URL` configured):

```sh
cargo test --locked --workspace --test inbox_rules --test twin_rule --test gate_rule
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
cd panel && pnpm test && pnpm build
```

The wider `make check`/CI checks documented above remain the release checks.

### M3 Task 0 — controller contracts and baseline

The integrated M2b baseline is **106 tools, 48 tables, migrations 0001–0008**.
`journey_attribution` is in **0008** (0007 is inbox policy); `Deps::attribution()`
already supplies the tenant-scoped `AttributionReader`. `jt_inbox::sms_segments`
already supplies the Q2 fixtures: ASCII 160/161 → 1/2 and ş/ğ 70/71 → 1/2;
a segment price of 3 therefore reserves 3/6/3/6 minor units.

Task 0 adds **zero tools**. Existing strategy and budget HTTP/MCP twins carry
strict per-hypothesis/lane cadence and nullable `unit_cost_minor`. An absent lane
has no slots; exploration defaults to zero; weekly scheduling uses Europe/Istanbul.
Editable `prior_confidence` replaces legacy `confidence`; read-only
`derived_confidence` is projected from stable tenant/hypothesis evidence. The panel
shows derived confidence when present, otherwise the prior, and draft edits keep
cadence and authoritative learning. Explicit null clears a price to unknown; zero
is a known price, and negative prices refuse. Manual historical spend is unchanged.

`0009_studio` is the unreleased M3 migration. T0 introduced cadence/prior/price
columns and learning evidence; T2 completes all **14 Studio tables**, giving **62
current tables**. Up/down/up is exercised as a non-bypass-RLS role; down is safe to
repeat and removes Studio schema/data and M3 fields while preserving baseline
strategy, budget, inbox and ledger rows. Migrations 0001–0008 are unchanged.
New and existing owner/manager roles have `studio.work` and `studio.manage`; rep
receives neither, and authenticated agents retain only their issuer's current
permissions. The backfill records only migration-added role UUID/permission pairs
in `studio_control.seed_grants`, so down preserves preexisting grants. Startup does
not change grants. At the T0 boundary **106 tools were implemented**; M3 now has 124.

Strategy approval/archive lock the draft before acquiring `lock_execution_frame`,
including when there is no approved version, then invoke `StrategyTransitionHook`
inside their transaction. The workspace frame uses `FOR NO KEY UPDATE` to serialize
frame users while allowing the `FOR KEY SHARE` checks taken by ledger foreign keys.
Any frame user that also needs the draft must take the draft lock first; Studio
control locks follow the frame. Hook failure rolls back the transition and its writes.
The existing post-commit archive hook is preserved. T3 supplies Studio cancellation;
T0's default hook has no queue to cancel. Studio repositories are implemented in PostgreSQL and the transactional fake.
FileStore remains unavailable until T5 wires its byte-storage adapter.
Shared contract rows now live in `jt_studio` and are re-exported from
`jt_app::ports::studio` (T1). No public Studio routes were added at the T0/T1 boundary.

Meta adds pause/active status writes, verified account currency/timezone context,
ad-set/day insights, and account-checked ad→ad-set resolution. Missing ad-set
counters remain `None`; malformed money and unsupported currencies refuse.
Supported currency exponents are explicit: JPY/KRW/VND/CLP/PYG (0) and
TRY/EUR/USD/GBP/CAD/AUD/CHF (2). See Meta's
[account field definitions](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adaccount.py).
There is no ad creation API and no zero-budget pause. `BUDGET_CAP` maps to HTTP 409
with the same MCP structured code and details. Atomic reservations and connector
spend enforcement remain T8's implementation task; this baseline does not claim
that enforcement has shipped.


### M3 Task 1 — pure Studio domain

`crates/domain/jt_studio` defines the typed chain, arms, slots, pieces, publication
snapshots/outcomes, measurements, learning deltas, trends, external ad-set bindings,
budget moves and controls. Its dependencies are pure domain types, serialization,
UUID/time/error types and the URL parser; it performs no I/O. Existing application
port paths re-export the shared records, including connector `MediaUpload` and
`PublishReceipt`, without changing repository or provider method signatures.

### Calls (voice V0, V1)

`crates/domain/jt_calls` holds the call session and its state machine, the plan and the policy,
the fence and the timers (spec `docs/superpowers/specs/2026-10-27-agent-voice-calls-design.md`).
V0 places a rep's call through the NetGSM PBX (`Telephony::click_to_call`: the rep's extension
rings, then the person) and keeps the call log. V1 lets the connected agent talk on the call
itself through the workspace's voice bridge: `calls.place{mode: "agent", plan}`, then
`calls.listen` → think → `calls.say` until `calls.end` (or `calls.transfer` to a rep). Every
placed call passes the fence twice, the second time in the transaction that dials (right before
the PBX is asked; for an agent's call, the one that queues the bridge's `dial`); numbers are
masked in every output and ledger payload (`calls.get` shows a person holding `calls.manage` the
number; the bridge is handed the number it dials).

The server never composes a sentence: the bridge plays only the plan's opening, holding phrases,
fallback lines and closing, the policy's recording announcement, and the agent's own `say`
texts. The `call_timers` job (every second, only for workspaces with an agent's call on the
line) covers a slow agent with a holding phrase after 4 s and 10 s, a silent one with the next
fallback line every 20 s, and then plays the closing and hangs up (`agent_timeout`); it also
ends a call at its maximum duration, a caller who stays silent (`caller_silent`), a line left
ringing for 90 s (`no_answer`), and a call whose bridge stopped reporting (`bridge_offline`; a
closing never reported played is taken for done after 60 s). Every end of an agent's call (the
caller's hangup, the timers, a transfer) is settled once: the journey's `CallMade{connected}`,
the spend at the policy's tariff on the bridge's budget item, `calls.ended`; `calls.end` then
records the outcome (`calls.outcome_recorded`). The long-polls (`calls.listen`, the bridge's
commands) are woken at once by an in-process signal (`BridgeSignals`, on the calls' key) and
read again at least every second, so a second server instance only adds up to a second. The
bridge's commands are purged after 7 days (`purge_call_commands`, daily); erasing a person
removes their calls' commands and the bridge's event notes, and empties their calls' plans.

| Use case | Panel | MCP | Risk | Permission |
|---|---|---|---|---|
| `calls.policy_get` | `GET /api/calls/policy` | `jeeta.calls.policy_get` | READ | `calls.work` |
| `calls.policy_set` | `PUT /api/calls/policy` | `jeeta.calls.policy_set` | WRITE | `calls.manage` (only a person turns the disclosure off) |
| `calls.place` | `POST /api/calls` | `jeeta.calls.place` | SPEND | `calls.work`; refusals are `409` with `details.reason` and one `calls.refused` |
| `calls.get` | `GET /api/calls/{call_id}` | `jeeta.calls.get` | READ | `calls.work` |
| `calls.list` | `GET /api/calls` | `jeeta.calls.list` | READ | `calls.work` |
| `calls.end` | `POST /api/calls/{call_id}/end` | `jeeta.calls.end` | WRITE | `calls.work`; journey `CallMade`, note, task, spend once |
| `calls.listen` | `GET /api/calls/{call_id}/events?after_seq&wait_s` | `jeeta.calls.listen` | READ | `calls.work`; long-poll of at most 25 s: `{call_id, state, events, timed_out}` |
| `calls.say` | `POST /api/calls/{call_id}/say` | `jeeta.calls.say` | WRITE | `calls.work`; `{text ≤ 600, expect_reply, allow_barge_in}`; `409 not_live` off the line |
| `calls.transfer` | `POST /api/calls/{call_id}/transfer` | `jeeta.calls.transfer` | WRITE | `calls.work`; to `to_extension` or the policy's `handoff_extension`; ends the agent's part |

#### The voice bridge (voice V1)

The voice bridge (`docs/operations/voice-bridge.md`) is the sidecar that is a workspace's phone
line for agent calls. Its three use cases are panel-only rows served under `/api/voice/bridge/*`
to its bearer API key alone, a key issued with `calls.bridge` and nothing else (any other key,
and every session cookie, is refused); no MCP tool reaches them. Its registration every 15
seconds verifies its `voice_bridge` capability (reached like a device, verified only by this
heartbeat): stale after 60 seconds, unreachable after 10 minutes (the `voice_bridge_health` job,
every minute), listed as `voice_bridge_offline` pending work meanwhile. The key check, the
heartbeat, the health job's marking and the long-poll are the bridge kernel's
(`jt_app::usecases::bridges::kernel`), which every bridge shares; the voice bridge is its first.

| Use case | Panel | Risk | Notes |
|---|---|---|---|
| `calls.bridge.register` | `POST /api/voice/bridge/register` | WRITE | declares the extension's bridge on its first registration; `calls.bridge.online` when it comes back |
| `calls.bridge.commands` | `GET /api/voice/bridge/commands?wait_s&extension` | READ | long-poll of at most 25 s; a command not acknowledged within 10 s is handed out again |
| `calls.bridge.events` | `POST /api/voice/bridge/events` | WRITE | at most 100 events, each applied once by `(bridge_call_id, bridge_seq)` |

#### The device bridge (device bridge D1)

The device bridge (`jeeta-device-bridge`, spec `docs/superpowers/specs/2026-10-28-device-bridge-design.md`)
runs on the PC a workspace's phones are plugged into, on the same kernel as the voice bridge. Its
four use cases are panel-only rows served under `/api/devices/bridge/*` to its bearer API key
alone, a key issued with `devices.bridge` and nothing else; no MCP tool reaches them. The key is
also which bridge calls, so each bridge program holds a key of its own. The bodies are
`jt_device_protocol`'s; a body that breaks a limit is a `422` whose `details.field` names the
field.

| Use case | Panel | Risk | Notes |
|---|---|---|---|
| `devices.bridge.register` | `POST /api/devices/bridge/register` | WRITE | a `phone` capability per phone (`{platform}:{serial}`), facts merged key by key under `connector_public.device` (only the bridge writes it); a phone that fails its checks, is retired (`phone_retired`) or is held by another bridge that registered it within 60 s (`phone_held_by_another_bridge`) is listed in `refused`, never the registration |
| `devices.bridge.commands` | `GET /api/devices/bridge/commands?wait_s&limit` | READ | long-poll of at most 25 s, at most 20 commands, for the phones the bridge's latest registration lists; a command the phone's bridge no longer lists is failed `unsupported_by_bridge`; `push_file` carries a 10-minute signed `download_url` |
| `devices.bridge.results` | `POST /api/devices/bridge/results` | WRITE | at most 100 results, 2 MiB; each applied once, from the bridge the command was leased to (or the one that holds its phone now), else counted `unknown`; a file id that is not a device file this bridge uploaded refuses the batch |
| `devices.bridge.files` | `POST /api/devices/bridge/files` | WRITE | the body is the file itself, streamed (`image/png` up to 25 MB, `application/octet-stream` up to 256 MiB; two uploads at a time); a device file kept seven days; `{"file_id"}` |

Every Studio timestamp (slots, approvals, attempts, publications, measurements and their
dates, trends, bindings, budget moves, spend reservations and their windows, stored files) goes
through `jt_studio::time_compat`: written as RFC 3339 text (a date as `YYYY-MM-DD`), so MCP
outputs and panel answers carry text; read as that text or as `time`'s compact tuple, which rows
and ledger payloads stored before it keep. See the deployment release note for the 24-hour
request-key replay effect.
The T0 application `PublishOutcome` still transports `AppError`; persistence must
map it to the domain's closed redacted outcome codes, never store diagnostic text.

`validate_chain` checks nonnil tenant/birth/hypothesis/arm identities against loaded
birth and current strategy versions, a live hypothesis, enabled lane cadence,
selected content type, supported concrete capability kind and the target account's
`ChannelChoice.group_id` memberships. Its context must come from tenant-scoped
repositories and the operation's connector registry. Birth identity is retained
when a newer approved strategy authorizes execution. Arms start at Beta(1,1),
weight 0.5, independently of hypothesis prior confidence; kept arms retain learning.
Nonfinite/invalid arm parameters refuse, including on deserialization. Learning
updates validate finite deltas and confidence; there is no public confidence setter.

The reducer follows Planned → Ready → Published → Measured → Retired. Editing
Ready creates a new revision. Cancellation, hypothesis retirement and archive retire
only unstarted work; week-end cleanup retires only Planned work. Consent is optional
revision-bound metadata, with lane and capability requirements composed by OR.
Budget moves carry their own revision so changing the amount invalidates consent.
Human identity/permission checks and fresh brake/spend authorization remain T3/T8
responsibilities; a domain transition is not an execution permit.

Publication claims freeze the piece revision, actor, capability, strategy and control
fences. Failed/refused attempts never return to the queue; unknown outcomes may be
resolved by evidence without another publish. Retired slots remain retired when late
in-flight outcomes or historical measurements arrive. Measurements require exactly
one publication or ad-set/day target, preserve missing counters as `None`, and keep
24h/72h/7d windows separate. An unknown pause is never evidence that an ad set stopped.
Raw bytes cannot be serialized as persisted media; T5 must normalize them to File IDs.
HostedUrl references remain direct. DNS/egress checks, file ownership, durable evidence
immutability and transactional replay enforcement belong to the application/storage
tasks. Stored records must be validated before writes. T4/T7 add planning/reward math;
trends remain display context.

| Release boundary after T1 | Current state |
|---|---|
| MCP tools / Studio public operations | **106 / 0** (T1 specifies no public rows) |
| Tables / latest migration | **49 / 0009_studio**, unchanged by T1 |
| Studio domain verification | `cargo test --locked --workspace --test studio_domain` |

No migrations or new public surface schemas are introduced in T1. The later Studio
rows require catalog, HTTP, MCP and parity coverage together when implemented.


### M3 Task 2 — durable tenant storage

The fourteen Studio tables are `studio_arms`, `studio_slots`, `studio_pieces`,
`studio_files`, `studio_publications`, `studio_publish_attempts`,
`studio_measurements`, `studio_learning_applications`, `studio_trends`,
`studio_adset_bindings`, `studio_budget_moves`, `studio_spend_reservations`,
`studio_control` and `studio_request_keys`. All have forced RLS; relational
references include workspace identity. Birth chains retain their original strategy
version, while an arm's identity survives strategy replacement.

Repository writes participate in the caller's tenant transaction. Request keys are
scoped by workspace/action, store a SHA-256 payload digest and the original response,
and reject a changed payload. Slot reads use half-open schedule windows; edits and
retirement require the expected revision. File rows store metadata only. Bindings
reference externally created ad sets; no provider creation operations are added.

A claim freezes its piece, current strategy, control revision and system scheduler
actor as Sending. Commit the claim before provider I/O; rollback leaves the slot
unclaimed. Committed Sending/Unknown attempts are never automatically queued again.
Completion stores redacted outcome evidence, the unique successful publication and
an existing-ledger entry together; an identical completion is a no-op. A late
receipt preserves retirement. The control row serializes competing claims and
receipts; the strategy frame precedes that lock. Public execution authorization and
human/agent attribution are supplied by the later application tasks, not by treating
these storage operations as public execution permits.

Measurement uniqueness is publication/window or external binding/day/scope. Failed
and missing reads can be replaced; complete evidence is required for learning.
Evidence keys apply arm deltas and derived confidence once. Reservations serialize
lane and budget-item caps, include existing recorded item spend, retain uncertain
costs, and settle idempotently. Absolute daily budgets remain distinct from actual
spend. T8 supplies provider-specific cost calculations and reconciliation. The fake
holds a transaction lock and refreshes committed dependency state to exercise the
same claim, replay, rollback and cap contracts as PostgreSQL.

| Release boundary after T2 | Current state |
|---|---|
| MCP tools / Studio public operations | **106 / 0** (Task 2 adds repository contracts only) |
| Tables / latest migration | **62 / 0009_studio** |
| Fast verification | `cargo test --locked --workspace --test migrations --test studio_repos` |
| Plan-named contract targets | `studio_pg`, `studio_fakes` |

Tests cover real non-bypass-RLS migration up/down/up, double rollback, sentinel and
grant preservation, tenant/composite-FK refusal, version-stable arms, concurrent
claims/reservations, replay conflicts, learning dedupe, file/trend/budget records,
issuer-scope inheritance and price/cadence round trips. Task 2 adds no catalog row,
HTTP route or MCP tool; later public rows must ship all twins and parity tests.


## M3 Task 3 — strategy lifecycle, permissions and brakes

At the T3 boundary the release contained **109 MCP tools**, including **3 Studio operations**.
The T0–T2 tables above describe their historical boundaries; T3 keeps **62 tables**
and migration **0009**, with no new migration or permission seed.

| Use case / MCP suffix after `jeeta.` | HTTP | Permission | Strategy gate |
|---|---|---|---|
| `studio.brake` | `POST /api/studio/brake` | `studio.manage` | Exempt |
| `studio.policy_set` | `PUT /api/studio/policy` | `studio.manage` | Required |
| `studio.approve` | `POST /api/studio/approvals` | `studio.manage`, owner/manager human | Required |

All three still require an **active workspace**, including direct application calls.
Owners and managers have `studio.work` and `studio.manage`; reps have neither.
Agent authority is the intersection of issuer permissions and connection scopes.
An agent can operate a brake or policy but cannot provide human consent.

Brake input is `{engaged, lane?: organic|paid|null, expected_revision}`. Omit the
lane for the workspace brake. Policy input is `{lane, requires_human_approval,
expected_revision}`. Approval input is `{target: {slot: UUID}|{budget_move: UUID},
expected_revision}`. Unknown fields are rejected on both surfaces. Control writes
use compare-and-swap revisions; approvals bind the immutable piece/move revision
and do not change the five-state slot lifecycle. Lane and capability requirements
compose with OR; both default to false. Consent never overrides a brake or cap.

Strategy approval/archive invokes `StudioTransition` inside the same transaction
as the frame change. Retired hypotheses and archive retire Planned/Ready slots
(including Ready work waiting for consent) and cancel queued budget moves. Kept
hypotheses retain their arms, learning and queue. Birth versions and published
history remain immutable; old-born execution uses the current approved frame.

`authorize_execution` checks the workspace, current strategy, hypothesis, channel,
group, capability health, access expiry/scopes, working hours, current payload
revision, consent and brake. `dispatch_execution` also checks registry support and
runs one freshly fenced provider call after releasing transaction locks. T6/T8
execution workers must use this boundary for **every call and every queue item**,
and T8 must atomically reserve connector cost before spend. A call already admitted
when a concurrent brake commits may finish and record its result; the next iteration
is held. There is no one-second timing guarantee and no automatic publication retry.

Brake flags commit before Meta status reconciliation. Queued work stays in place,
with no reset of attempts. The `studio_control` job runs every minute under its
scheduler advisory lock and a per-workspace status lock, and also runs immediately
after a control write. It reads bound external Meta sets, pauses active ones and
persists pending/applied/unknown status evidence. Safety pauses work while braked.
Release rechecks the current frame, capability, consent and budget caps, reserves
the remaining-period daily-budget liability, and resumes only sets this brake
paused. Manually paused sets remain paused. A failed/unknown provider operation
never clears the persisted brake; reconciliation reads provider status after restart.
No campaigns, ad sets or creatives are created.
OAuth-derived Page/Instagram assets retain the trusted parent grant scopes. Older or
manually pasted credentials without permission evidence fail closed and need an OAuth
reconnection; a successful identity probe alone does not prove publishing/read scopes.
Meta account comparisons accept both numeric and `act_`-prefixed identities. Resume
recovery reuses the durable reservation timestamp within its budget period, so a lost
status response cannot create a new payload under an existing request key.

`authorize_measurement` is a separate system-only read path: published/bound
immutable evidence, original capability/account and current healthy read credentials
are required. It remains usable after retirement/archive and under a brake, but
cannot authorize publishing, budget changes or ad resume. Publication attempts now
freeze the account identity; a later capability rebind cannot read old evidence
through the replacement account. Missing original account evidence fails closed.

Fast checks: `cargo test --locked --workspace --test studio_brakes --test studio_permissions`.
These include the PostgreSQL/fake control contract, two-worker admission and iteration
barriers, revision-bound consent, archive/retirement, historical reads, scoped restart,
Meta pause/resume and unknown-response reconciliation. `studio_http`, `studio_mcp`
and the `studio_controls_have_schema_error_effect_and_actor_parity` test exercise
catalog/routes, strict schema, live HTTP/MCP effects and the human-only consent rule.

The plan-named `studio_control` target also runs the control checks; permission checks
remain in `studio_permissions`.


## M3 Task 4 — weekly planning and suggestions

At the T4 boundary the release had **114 MCP tools**, including **8 Studio operations**;
the schema remains **62 tables** at migration **0009**. No provider or content
generation service was added.

| Use case / MCP suffix after `jeeta.` | HTTP | Permission | Strategy gate |
|---|---|---|---|
| `studio.pending` | `GET /api/studio/pending` | `studio.work` | Required |
| `studio.slot_get` | `GET /api/studio/slots/{slot_id}` | `studio.work` | Required |
| `studio.slot_cancel` | `POST /api/studio/slots/{slot_id}/cancel` | `studio.work` | Required |
| `studio.trend_record` | `POST /api/studio/trends` | `studio.work` | Required |
| `studio.hypothesis_propose` | `POST /api/studio/hypotheses/proposals` | `studio.work` + `team.manage` | Required |

All five require an active workspace, including direct application calls.
`studio_plan` runs hourly under `jeeta.jobs.studio_plan`. Weeks start Monday
00:00 Europe/Istanbul; cadence positions are spaced evenly across the week and
only positions in the next seven days are materialized. Missed positions are not
caught up. Stable workspace/hypothesis/lane/week/ordinal IDs survive overlapping
runs, retries, cancellations and strategy replacement. Birth versions stay fixed.
At week-end, overdue Planned slots retire; Ready work and evidence remain.

Only connected, supported accounts in the strategy's selected channels/groups
are eligible, and brakes stop planning that lane. Paid planning also needs the
strategy's paid lane. Integer type minima use ceiling and maxima use floor;
infeasible quotas return validation details. Remaining positions use posterior
mean weights and bounded largest remainders, with type-key ties. Within a type,
injected Beta samples select the largest sample (stable arm-ID ties); exploration
uses a separate uniform draw. Trends never alter this selection or learning.

`pending` derives slots with overdue flags, revision consent, queued budget moves
and blockers. `slot_get` includes the piece, hypothesis, current brand identity
and prohibitions, arm learning, publication attempts and measurements. The same
slot/consent/budget summaries appear in `work.pending` and `work.checkin`, preserving
the existing last-seen and overdue calculation. The scheduler never wakes agents.
Cancellation takes `{expected_revision, reason}`; it retires Planned/Ready work
and records the reason without deleting content or evidence.

Trend input is `{hypothesis_id, channel, summary, source_url?, observed_at,
request_key}`. The agent supplies the observation; recording performs no research.
Retries preserve the stored identity; changed payloads conflict. URL query tokens
and fragments are removed before storage. A hypothesis proposal uses the strict
strategy hypothesis input, without an existing ID. It opens or locks a draft and
appends one new hypothesis, preserving approved/draft hypotheses and derived
learning. Concurrent first proposals share draft creation; suggestions never
activate themselves or alter the approved strategy.

Validation: `studio_planning` covers the pure planner, application flows and real
Postgres draft concurrency; `studio_work` covers absent-agent overdue projections;
`studio_http`, `studio_mcp` and `twin_parity` cover registration, schema and effects.


## M3 Task 5 — tenant files and agent content

At completion of Task 5, the release had **116 MCP tools / 10 Studio operations**, **62 tables**,
and migration **0009_studio**. T5 adds no migration.

| Operation / MCP suffix | HTTP | Permission / gate |
|---|---|---|
| `studio.file_upload` | `POST /api/studio/files` | `studio.work`, approved strategy and active workspace |
| `studio.piece_submit` | `POST /api/studio/slots/{slot_id}/piece` | `studio.work`, approved strategy and active workspace |

Both surfaces accept strict tagged media inputs. Upload content is
`{"kind":"bytes_base64","data":"..."}` or `{"kind":"source_url","url":"https://..."}`.
Piece media is `file` (id), `hosted_url` (url, mime, size_bytes), or `bytes`
(data in base64, mime, filename). Account adaptations are keyed by the slot
capability's external account ID. Raw bytes normalize to tenant file IDs before
persistence; HostedUrl references remain direct. X transport reloads file bytes or
uses the same bounded, tenant-authorized fetch. No content generation or provider
publication occurs during submission.

File startup requires **JEETA_FILES_DIR**, an existing absolute directory on a Linux
persistent volume, and a **public HTTPS JEETA_PUBLIC_BASE_URL** origin. Create the
storage directory owned by the service user with mode 0700; mount the same volume
on instances serving the same database. Keep JEETA_SECRET_KEY stable: it signs file
transport as well as sealing credentials. Tenant/file IDs choose paths; filenames
never do. Directory descriptors and no-follow opens prevent symlink escapes.
Atomic durable writes include a SHA-256 integrity envelope, survive restart, and
refuse corrupt assets. Abandoned temporary writes older than 24 hours are repaired
on the next write to that tenant root. Disk operations run on blocking workers.

Allowed MIME values are image/jpeg, image/png, image/webp, image/gif (25,000,000
bytes maximum) and video/mp4 (200,000,000 bytes maximum), checked against actual
bytes and signatures. URL ingestion uses the existing tenant egress allowlist and
DNS guard, bounds streamed bytes, and refuses redirects. The source host must
already be authorized for that tenant. HTTP upload/submission and MCP messages
have a 280,000,000-byte envelope limit to accommodate base64 video.

`GET /files/{id}` requires a signature bound to workspace, file and expiry. URLs
expire 24 hours after signing and responses use no-store/nosniff headers. Signed
queries, bytes and content are absent from application logs and mutation ledgers;
request receipts store a payload digest and original result. Same key/body replays
the original result even after a later edit. Different bodies conflict. Submission
commits content, Ready revision, ledger and receipt together, validates current
chain/account/file ownership, and leaves previous consent unable to authorize an
edited revision. In-flight or uncertain publication content cannot be replaced.

The daily `studio_files_cleanup` job uses `jeeta.jobs.studio_files_cleanup` and
runs independently of live strategy. It deletes bytes only 30 days after the last
successful publication using them, while retaining files referenced by current
pending work or Queued/Sending/Unknown attempts. Never-published assets are retained.
Deletion is idempotent across a crash before the metadata marker; hashes, piece,
publication, measurement and ledger evidence remain permanent. Hosted assets are
never deleted by Jeeta.

Failed writes are compensated before a commit is attempted. If the process stops
or commit acknowledgement is uncertain, daily cleanup reconciles physical files
older than 24 hours that have no tenant metadata, under the same control lock.
Tracked uploads and pending content are protected. Submission checks byte availability
under that lock, so a crash between deletion and its marker cannot create Ready
work that references missing bytes.

## M3 Task 6 — fenced publication and recovery

At completion of Task 6, the release had **116 MCP tools / 10 Studio operations**, **62 tables** and
migration **0009_studio**. T6 adds two system-only jobs (19 scheduled jobs total),
no public operation and no migration. Existing `studio.pending` and
`studio.slot_get` HTTP/MCP twins expose attempts and actionable failure blockers.

| Job | Interval | Advisory lock |
|---|---|---|
| `studio_publish` | 1 minute | `jeeta.jobs.studio_publish` |
| `studio_publish_recover` | 1 minute | `jeeta.jobs.studio_publish_recover` |

Publication checks the active workspace, current strategy/hypothesis/channel/group,
capability access and policy, revision-bound consent when required, and the brake.
Capability changes serialize on the capability row; group removals share the short
execution frame. Studio paths lock the workspace execution frame before the capability;
capability locks use `FOR NO KEY UPDATE` so planner foreign-key checks remain compatible.
A brake queued behind an admitted authorization takes effect after that transaction releases
its frame. Held queue entries are skipped, and a targeted claim can only capture the selected
authorized slot.
The default policy needs no human approval. Media preparation uses the existing
bounded fetch/file transport outside tenant locks. A fresh execution fence then
freezes the piece, account, actor, birth/execution versions and control revision in
a durable Sending attempt before calling Publisher without tenant locks. Each
subsequent dispatch repeats authorization. Account adaptations retain text, link
and attachments; X receives bytes, Meta receives approved or signed URLs.

Budget-bound publishing (including a capability spend ceiling) refuses with
`publication_spend_gate_unavailable` until T8 wires its atomic reservation gate.
It must not be enabled by interpreting an unknown price/currency as zero.
`daily_ops_cap` reserves operations atomically with each claim under the capability lock.
Each attempt counts once for its claim's Europe/Istanbul calendar day, including completed
and uncertain writes. At the limit, the run records `daily_ops_cap` and leaves the slot Ready
for the next day; concurrent workers cannot claim beyond the cap.

Candidate-specific media preparation errors record redacted Failed attempts and let the run
continue. Unreachable hosts are Transient; invalid/missing media is Permanent and retires the
slot. The concrete fetcher preserves transient transport/body failures and HTTP 408/429/5xx
responses without storing URLs or response diagnostics. Infrastructure errors still fail the run.
Preparation failures share the no-retry policy.

There are **zero automatic publish retries**, for every connector error category.
Auth/Permission produce reconnection work. Permanent/Throttle/Transient produce
Failed work; retry-after is retained only as diagnostic ledger data. Lost responses
and Sending claims abandoned for two minutes become Unknown with explicit
publication/duplicate-risk review work. Failed/Unknown slots are never reclaimed,
even if they still say Ready; a deliberate new publication needs separate work.

A receipt checkpoint preserves the exact external ID/URL before final bookkeeping.
Recovery only calls `InsightsReader::post_metrics` for that captured ID under
historical read authorization; it never calls Publisher, discovers IDs or treats
account totals or duplicate-content errors as success. Missing IDs, unavailable
read support, changed accounts and failed reads retain Unknown. Successful
completion atomically records Publication, slot state and redacted linked ledger
evidence; replay is idempotent. A late result after a brake, strategy replacement
or archive retains late-completion evidence and never reactivates a retired slot.
This is not a claim of exactly-once delivery at the provider.

X preflight retains GIF-alone and URL/byte-count rules, counts explicit URLs and
bare domains as 23 characters. Emoji clusters including variation selectors, skin tones,
flags and ZWJ families weigh two; non-emoji combining text retains its scalar weights.
Emoji recognition uses Unicode 17 property data and sequence syntax; CJK characters weigh two. Meta/X
successful writes with unreadable responses or missing publication IDs remain
Unknown. Provider text, credentials, file bytes and URL query tokens are absent
from durable failure/receipt evidence.

`studio_publish` targets cover the application, real PostgreSQL receipt persistence
and Meta/X mock HTTP behavior. The application tests also cover concurrent claims,
no locks during provider I/O, all error classes, restart recovery, historical
read-back, immutable version/arm links, late completion and full adapted media. PostgreSQL
regressions overlap planning/publication and cap-limited claims; application tests cover
Istanbul midnight rollover and broken media followed by healthy work.


### M3 Task 7 — measurements, learning and results

At the Task 7 boundary the release had **118 MCP tools / 12 Studio operations**, **62 tables**,
migration **0009_studio**, and **21 scheduled jobs**. The two new operations are
`studio.learned` (`GET /api/studio/learned`, `jeeta.studio.learned`) and
`studio.judgment_record` (`POST /api/studio/judgments`, `jeeta.studio.judgment_record`).
Both require `studio.work`, an active workspace and a current approved strategy,
and use shared strict schemas. Learned queries take RFC3339 `from`/`until` and
optional `hypothesis_id`/`lane`; intervals are half-open. Judgments require a
nonempty list of same-hypothesis measurement IDs, text and an idempotency key.
They are typed ledger entries and never change measured results or confidence.

`studio_measure` runs every six hours under its advisory lock. It reads each
publication's 24-hour, 72-hour and seven-day windows independently, including
windows due after Measured, strategy archive or hypothesis retirement. Historical
reads still require an active workspace and the original connected account with
valid read access. Provider calls run outside database locks. Failed or incomplete
reads remain retryable, contribute no reward and never manufacture zero counters.
All three complete windows retire the slot without deleting publication evidence.
Measurements retain the original chain/version, scheduled and read instants, raw
counters, source, scope, completeness, rule and correction revision.

Learning uses `studio-learning-v1`: organic engagements/impressions or paid
clicks/impressions, clipped to [0,1]. X's `impression_count` is normalized while
preserving the raw counter; reach, unique reach and account followers are never
substitutes for impressions. Missing denominators therefore remain unknown even
when an adapter can supply reach. Each arm starts Beta(1,1). One publication
contributes once, with 7d taking precedence over 72h and 24h; explicit corrections
replace that contribution. Paid evidence is account/set/day, never campaign totals.
Evidence insertion, replacement deltas and derived confidence share one tenant
transaction. Replays add nothing. Editable priors remain separate, including when
an older draft is approved after newer learning.

`studio_reweight` runs Monday 00:00 Europe/Istanbul, under its own advisory lock,
with one receipt per local week. Stored weights are posterior means; normalization
belongs to slot allocation. Learned results recompute posteriors from the selected
evidence range and expose original evidence/version links, lane performance,
observed spend versus strategy caps, trends and separate judgments. Missing spend
and unproven attribution are explicit nulls, never inferred zeros.

Paid reads use account/set/day metrics even for paused sets and retain currency,
minor-unit exponent, account timezone, observed budget and status. Day corrections
replace spend in the report instead of adding it twice. Mismatches against confirmed
budget moves or status controls persist a paid-lane brake and an actionable ledger
entry; the existing safety reconciliation requests pauses and retains uncertain
outcomes. Task 8 owns spend-reservation transfer, rollover and budget-write services;
Task 9 owns proven inbox attribution. No campaign creation, lead ingestion or
automatic budget allocation is introduced here.

Coverage includes pure ruling vectors, window/revision ordering, retry/replay,
archive reads, draft preservation, paid correction and shared-campaign isolation,
filtered results/judgments, real PostgreSQL atomicity and tenant isolation, and
HTTP/MCP result, filter, replay and error parity. Migration 0009 retains its scoped
idempotent down script; the workspace suite verifies up → down → up.


### M3 Task 8 — external paid bindings and hard connector caps

At the Task 8 boundary the release had **121 MCP tools / 15 Studio operations**, **62 tables**,
migration **0009_studio**, and **21 scheduled jobs**. No campaign, ad set or creative
creation is exposed. No schema migration is added by T8; reservation accounting
metadata lives in the existing tenant-scoped durable JSON records.

| Catalog / tool suffix | HTTP route | Permission |
|---|---|---|
| `studio.adsets_list` / `jeeta.studio.adsets_list` | `GET /api/studio/adsets?capability_id=…` | `studio.work` |
| `studio.adset_bind` / `jeeta.studio.adset_bind` | `POST /api/studio/adsets/bind` | `studio.work` |
| `studio.budget_move` / `jeeta.studio.budget_move` | `POST /api/studio/budget-moves` | `studio.manage` |

All three require an active workspace, approved paid strategy, selected channel/group
and a connected, scoped ad account. Binding checks authenticated account membership;
replay keys reject changed payloads. Binding an already active set brakes the paid
lane and requests a safety pause until its budget is authorized.

A budget move is an **absolute daily setting**, never an actual spend entry.
Default policy dispatches immediately. Revision-bound human consent, when configured,
leaves the move queued; the existing minute `studio_control` job dispatches it through
fresh authorization after consent. It also refreshes period/frame exposure before
reconciling status. No new budget amount is chosen automatically.

The shared reservation gate locks the current strategy, capability, Studio control
and all linked live budget caps before recording `Sending`. Provider calls run after
commit. A daily reservation multiplies the amount by the ceiling of remaining days
in each cap's own UTC period (Total caps use the finite strategy period). Capability
spending policy, lane caps, observed spend, manual historical spend and outstanding
exposure all apply. `BUDGET_CAP` is HTTP 409 and the identical structured MCP error.
Known replacements hold max(old,new) while uncertain; confirmed replacements retain
unobserved elapsed exposure. Unknown writes remain reserved across restarts and are
never blindly retried. Read-back of the matching absolute setting can resolve them.

SMS outbox claims price the shared GSM-7/UCS-2 segment count using persisted
`unit_cost_minor`; 160/161 ASCII and 70/71 Turkish characters cost 3/6/3/6 at a
three-minor-unit segment price. Budget-bound publishing uses one explicit publication
operation. Missing price, unsupported units, mismatched currencies or undefined
quantities refuse before provider I/O. Existing unmetered publishing remains available.
An accepted send with no reported actual cost retains its upper bound as exposure.

Measurement corrections replace the provider's ad-set/day/currency bucket and adjust
cap accounting atomically with evidence. Complete elapsed buckets transfer reserved
exposure to observed spend; uncertain and overlapping buckets remain conservatively
held. The six-hour measurement cycle brakes only the paid lane on budget/status drift,
exposes a work item in `studio.pending.paid_alerts`, and requests `Paused` status.
The comparison uses the latest Applied reservation, including brake-release resumes
and their authorised daily budget. Publication access/provider failures persist a
category and retry time (1 hour, 6 hours, then daily), without learning or blocking
other publications and paid spend/drift checks. Binding failures are audited per
target and do not stop checks of other bindings. Insight requests and accepted daily
buckets use the ad account timezone (`timezone_name` from Meta; Europe/Istanbul fallback).
Observed spend is checked against lane and linked item caps independently of work
hours and operation limits; those eligibility checks gate new budget moves only.
An active binding and its required safety brake commit together. Receipt replay
restores a missing brake, and periodic rechecks cover bindings without reservations.
Rollover refusal likewise persists the brake before pausing. Unknown pause outcomes
report residual provider exposure. Jeeta guarantees preflight authorization caps;
providers can still incur in-flight or externally initiated spend, which remains
recordable even above a cap. Status changes never use `set_daily_budget(0)`.

Validation: `studio_paid` covers the application and real PostgreSQL concurrency;
`budget` preserves truthful historical spend; `twin_parity`, `studio_http` and
`studio_mcp` exercise surface effects, strict schemas and errors.

### M3 Task 9 — read-only inbox attribution

At the Task 9 boundary the release remained at **121 MCP tools / 15 Studio operations**, **62 tables**,
migration **0009_studio**, and **21 scheduled jobs**. Task 9 adds the internal
`studio::attribution::attribution_for_ad` projection for learned/overview callers;
it adds no catalog row, HTTP route, MCP tool, migration or intake job. The public
learned/overview integration belongs to the five-region panel task (T10).
`Deps::attribution()` reuses M2b's tenant-scoped reader over immutable
`journey_attribution` (migration **0008**, not the plan's prereconciliation 0007).

`AttributionQuery { binding_id, ad_id, from, to }` requires `studio.work`, an active
workspace, and a nonempty half-open acquisition window `[from,to)`. A foreign
binding is not found. Historical reads remain possible after strategy archive;
they authorize evidence only, never publication or spending. The current strategy
selects capability groups when present; after archive the binding's birth strategy
supplies that selection. Actual group membership and connected Ads access are read
again after provider calls.

A result carries only the journey ID, original provider acquisition time, erasure
flag, and an optional binding/chain. Attribution requires all of these proofs:

- The retained Meta lead-gen event identifies the actual acquisition's Page
  capability and Page ID, including for repeat journeys. Raw form bodies are never
  read. Keyset pagination reaches older events after raw-body retention.
- The Page (or Page-bound Messenger capability) and Ads capability share a group
  explicitly selected for the paid channel. An arbitrary shared group is insufficient.
- The Ads credential verifies the account and its listed ad set/campaign. The ad
  resolves to that set, or immutable stored ad-set evidence matches it. A missing
  resolution does not discard independently verified stored evidence; contradictory
  set/campaign evidence cannot be used.
- The account/set has one binding, and its chain identifies the persisted paid arm
  and birth hypothesis. A shared campaign alone never selects an arm.

Missing or changed proof leaves the journey in the result with null binding/chain.
The projection never fetches leads, consumes events, changes first touch or journey
ownership, writes inbox data, updates rewards, or returns personal lead content.
Erased people remain safe ID/time-only tombstone projections. Event metadata is
scanned through the existing paginated read port; no new indexed lookup is added.

`studio_attribution` runs the eight named T9 contracts plus stored-evidence,
permission/status/window, archive/pagination and concurrent-group-change cases
against both the transactional fake and real PostgreSQL: **12 tests per adapter**.
Fixtures use the M2b consumer; optional stored ad-set variants additionally exercise
its immutable repository contract. No provider-live verification is claimed.


## M3 Task 10 — Five-region Growth Studio

At the M3 Task 10 boundary the release had **124 MCP tools / 18 Studio operations**, **62 tables**,
migration **0009_studio**, and **21 scheduled jobs**. This task adds no tables or jobs.

| Shared row / MCP tool | HTTP | Strategy gate / permission |
|---|---|---|
| `studio.overview` / `jeeta.studio.overview` | `GET /api/studio/overview` | Gated / `studio.work` |
| `studio.ledger` / `jeeta.studio.ledger` | `GET /api/studio/ledger` | Exempt / `studio.work` |
| `studio.ledger_export` / `jeeta.studio.ledger_export` | `POST /api/studio/ledger/export` | Exempt / `studio.work` |

All three independently require an active workspace. Ledger read/export remain available
when the strategy is absent or archived. Queries use a half-open RFC3339 `from`/`until`
window, optional stable `hypothesis_id` and `lane`; ledger also accepts an exclusive
sequence cursor `before` and `limit` from 1 to 500 (default 50). Filtering resolves
historical target chains in the tenant repository, preserving relevant global brake/policy
and takeover evidence. Sparse matches continue across bounded 500-row storage chunks.
Export follows the same cursor/filter to exhaustion and returns identical
`{filename, media_type, content}` on HTTP and MCP. CSV cells are quoted, dangerous
spreadsheet prefixes neutralized, payload secrets masked and transport URLs/bytes removed.
The response contains the full export in memory; this is not a streaming download service.

`/studio` is one responsive screen with five regions: Strateji, Plan, Bugün,
Öğrenilenler and Günlük. The hypothesis, lane and time filters drive the shared projections;
the seven-day Istanbul plan switches Liste/Takvim over the same slot IDs. Mobile stacks
these same regions. Confidence bars distinguish prior from derived confidence. Human
approval remains a blocker on Ready, never a lifecycle state. Unknown publication warns
against resending; agent overdue status comes from existing `work.pending`.

Contextual controls cover proposal into the strategy draft, slot detail/cancel, file upload
and content submission, human consent, lane policy and brakes, trend/judgment entry,
external ad-set binding and daily-budget moves. The server remains authoritative for
permissions, revision fences, paid eligibility and budget caps. Organic stays visible
when blocked; paid actions require the connected account and selected strategy lane.
No ad creation, independent calendar/trend screen, installation or commission feature
is added. Existing inbox commissions remain at `/inbox/commissions`.

Verification targets: `studio_projection` (also named `studio_views` by the plan),
`studio_http`, `studio_mcp`, behavioral `twin_parity`, and `StudioPage.test.tsx`, plus
TR/EN key parity, panel type checking/build and the full workspace checks. Provider
operations in these tests use local fixtures, not live customer accounts.

## M3 Task 11 — Growth Studio acceptance

M3's implemented release contains **62 tables (48 + 14)**, **124 MCP tools
(106 + 18)**, **18 Studio operations**, **21 scheduled jobs** and migration
**0009_studio**. The earlier Task 0–9 release tables above are historical snapshots.
Task 11 adds tests and documentation; it adds no product operation, provider or migration.

The exact `studio.*` / `jeeta.studio.*` suffix set is:
`brake`, `policy_set`, `approve`, `pending`, `slot_get`, `slot_cancel`,
`trend_record`, `hypothesis_propose`, `file_upload`, `piece_submit`, `learned`,
`judgment_record`, `adsets_list`, `adset_bind`, `budget_move`, `overview`,
`ledger`, `ledger_export`. Only brake and ledger read/export are strategy-exempt;
all 18 independently require an active workspace. Jobs, signed asset retrieval,
M2b attribution reads and the existing work integration add no tools.

```sh
cd rust
make smoke-studio
cargo test --locked --workspace --test studio_rules --test twin_rule --test gate_rule
```

`smoke-studio` runs seven in-process scenarios with the transactional fake and
scripted connectors, without a database, provider credentials or live customer data:

- Real strategy approval, seven-day planning, upload/submission, default publication,
  receipt replay, 24h/72h/7d measurement, idempotent learning and shared projections.
- An externally seeded Meta set, public binding and reserved absolute budget update,
  M2b intake-generated journey attribution, read-only chain join and paid projection.
- Lost publication response followed by a new service instance: no blind resend.
- Archive followed by due historical measurement; new execution refuses and a rebound
  account cannot read the earlier account's evidence.
- Thirty-day file cleanup after archive, with hashes, publication and ledger retained.
- Both workers held at pre-dispatch barriers when the brake is pressed, with restart
  persistence and tenant isolation.
- Two concurrent consumers of the same remaining cap, plus idempotent settlement.

`studio_rules` calls every public write dispatcher directly with missing strategy and
inactive workspace contexts, so middleware alone cannot satisfy the gate invariant.
It injects forged chain components, runs scheduled jobs under each execution blocker,
checks default consent behavior, exercises hard-cap refusal and concurrent reservations,
and attempts to overwrite measured confidence through ordinary hypothesis updates.
Syntax-tree checks additionally pin real HTTP/MCP handlers to shared services, the
paid port's operation set, dependency/connector boundaries and connector write sites.
The exact catalog excludes ad creation, commissions and field installations; only
M2b consumes lead events. B6/B7/B9 evidence includes behavior and races, not just scans.

For database-backed parity, tenant isolation and reversible migration contracts,
configure `JEETA_TEST_DATABASE_URL` as described above and run the full workspace
checks. `twin_parity`, `studio_http`, `studio_mcp`, `studio_paid`, `studio_brakes`,
`studio_measure`, `studio_attribution` and `studio_projection` cover the lower-level
contracts; the smoke does not replace those PostgreSQL tests. These fixtures prove
application behavior, not live Meta/X approval, provider availability, actual billing
or the provider's eventual spend. The broader release checks remain `make check panel-test panel-build`.


## M4 Task 1 — durable billing storage

The implemented storage boundary is **67 tables**, **12 migration pairs** (latest
`0012_m4_grandfathered_backfill`), **124 MCP tools** and **21 scheduled jobs**.
This task adds repository contracts; payment reporting, operator confirmation and panel
redemption surfaces belong to M4 Tasks 2–4. The existing M3 release tables above are historical.
There is no payment provider, subscription, credit balance or automatic entitlement expiry.
Price, currency and bank instructions remain deployment inputs for the subsequent billing
operations, not business constants derived from test fixtures.

`payment_notifications` stores immutable evidence through insert-only repository methods:
reporter, request key, amount in minor units, currency, payment/report timestamps and a sealed
bank reference. The same request key is unique within a workspace. Secret-bearing payment and
challenge rows have masked Debug and do not implement serialization. `workspace_billing`
creates a stable `JEETA-<8 uppercase workspace UUID hex digits>-<6 random decimal digits>`
reference once under the workspace lock, retrying unique-reference collisions.

A paid entitlement requires a payment from the same workspace and a confirming platform
operator. Confirmation stores an unactivated grant; activation records time and the redeeming
user. Grandfathered grants have no payment or operator. Only one nonrevoked grant may exist per
workspace; revocation retains the row and its reason, and a later grant may reuse the same
payment. `activation_codes` stores only a keyed 32-byte digest and challenge metadata. Challenges
are restricted to `billing.activate`, have no designated recipient, retain consumed rows for
replay refusal, and cap failed attempts at five. Current-owner authorization and code generation
are implemented by the later redemption use case.

Billing writers lock the workspace before grants/challenges, retaining the lock until the
caller commits or drops its bundle. PostgreSQL uses `FOR NO KEY UPDATE`, compatible with
unrelated ledger foreign-key locks; the fake serializes writes and refreshes its snapshot.
Tenant status mutation rejects another workspace. Both status mutation ports require a reason
and actor and atomically append `platform.workspace_status` with `from`, `to`, `reason`, `by`.
A repeated status is a no-op. This specified port has no timestamp parameter, so its audit uses
transaction time (fixed transaction time in the fake); other billing timestamps come from callers.
Registration still creates pending workspaces and `workspace.info` remains read-only. Task 3
replaces the legacy console status operation with the ruled payment/status state machine.

All four billing tables have ENABLE/FORCE RLS and tenant composite foreign keys. Platform access
uses the existing explicit platform transaction, with no superuser/BYPASSRLS role. The separate
backfill manifest is platform-only. Backfill IDs are deterministic per workspace and the manifest
retains the entire original row plus its workspace ledger watermark. Repeated up skips existing
grants. Data down removes only untouched owned rows without later ledger history, other grants
or challenge references; edited/revoked/runtime-associated rows and their manifest entries stay.
It never changes workspace status. Schema downs preflight and lock their tables, then refuse
atomically if live rows remain. Roll back live installations through a preserved backup, not by
dropping durable payment history. Migrations 0001–0009 are unchanged.

Verification: `cargo test --locked --workspace --test billing_repos --test migrations` runs
shared fake/Pg contracts, ordinary-role RLS and composite FK checks, challenge replay/attempt
checks, concurrent grants/reference creation, and up/down/up/repeated-down/live-row preservation.
The named `m4_billing_storage` and `m4_billing_contracts` targets also run in the workspace suite.


## M4 Task 2 — tenant payment status and bank-transfer evidence

At the Task 2 boundary: **136 catalog rows**, **125 MCP tools**, **67 tables**,
**12 migration pairs**, **21 scheduled jobs**. Task 2 adds no migrations or provider calls.
Operator confirmation and panel code redemption remain Tasks 3–4; this change does not
claim those flows are implemented.

| Use case | Panel route | MCP tool | Permission / status |
|---|---|---|---|
| `billing.status` | `GET /api/billing` | None (panel only) | Active membership + `workspace.read`; every workspace status |
| `billing.report_payment` | `POST /api/billing/payments` | `jeeta.billing.report_payment` | Current owner + `team.manage`, including effective key scopes; active or pending, never suspended |

Both are strategy-exempt. These are exact status exceptions; team, keys and capabilities
remain unavailable while pending. Fresh registrations report through their panel session;
existing authorized keys can report after a workspace returns to pending. No unpaid key
issuance or alternate agent authentication is introduced.

The required deployment variables `JEETA_PRICE_MINOR`, `JEETA_PRICE_CURRENCY` and
`JEETA_BANK_INSTRUCTIONS` apply to both `serve` and `mcp-stdio`. No price, currency or bank
instructions default is supplied. Status returns those read-only instructions and the stable
workspace payment reference, the latest payment, and the latest grant including revoked history.
`confirmed` means a paid grant has existed for that payment, even after revocation; it does not
mean active access. Codes, sealed evidence and operator identity are absent from these DTOs.

Report JSON contains exactly `reference`, `amount_minor`, `paid_at` and `request_key`.
Reference matching ignores whitespace and ASCII letter case. Amount must be positive;
amounts different from the configured price are retained for operator review. `paid_at` is a
nonfuture RFC 3339 timestamp with at most microsecond precision (PostgreSQL's precision).
The nonblank request key is at most 128 bytes. Workspace and reporter come from authentication.
Unknown fields, including codes and caller-supplied workspace/currency, are rejected.

Reports seal the normalized reference and append an ID-only `billing.payment_reported` event
in the same workspace-locked transaction. The same request key with identical normalized
reference, amount and payment time returns the stored payment and currency; changed evidence
is `CONFLICT`. Payment reporting never changes workspace status, entitlement, strategy,
capability verification or connection status. Concurrent retries produce one payment/event.

`cargo test --locked --workspace --test billing` covers the Task 2 app, PostgreSQL HTTP and
real MCP transport tests (the `billing/m4_billing_*` modules), including cross-surface retries,
owner/scopes, rollback, restart, history and exact billing schemas/status exceptions. Binary
unit test `billing_config_rejects_missing_or_invalid_values` verifies required configuration.


## M4 Task 3 — operator confirmation and explicit workspace transitions

At the Task 3 boundary: **141 catalog rows**, **125 MCP tools**, **67 tables**,
**12 migration pairs**, **21 scheduled jobs**. No new migrations, jobs or MCP tools.
The six rows below are **panel-only**, strategy-exempt and available regardless of workspace
status, with a separate authenticated operator session and the existing mutation request header.
There are no `jeeta.platform.*` or `jeeta.ops.*` tools.

| Use case | HTTP | Risk |
|---|---|---|
| `platform.payments.list` | `GET /api/platform/payments` | Read |
| `platform.billing.confirm` | `POST /api/platform/workspaces/{workspace_id}/payments/{payment_id}/confirm` | Write |
| `platform.billing.reissue` | `POST /api/platform/workspaces/{workspace_id}/payments/{payment_id}/reissue` | Write |
| `platform.billing.revoke_activation` | `POST /api/platform/workspaces/{workspace_id}/revoke-activation` | Write |
| `platform.workspaces.suspend` | `POST /api/platform/workspaces/{workspace_id}/suspend` | Write |
| `platform.workspaces.resume` | `POST /api/platform/workspaces/{workspace_id}/resume` | Write |

The operator list decrypts only payment references and exposes amount, currency, paid/report times
and the matching open entitlement. The operator must compare all evidence with the bank transfer
before confirmation; a tenant's reported amount does not settle a payment automatically.
Confirmation creates an **unactivated** paid entitlement and an eight-character `[A-Z0-9]` code,
valid for 72 hours with five failed guesses allowed. It never activates or resumes the workspace.
The code is generated uniformly from secure random tokens and stored only as an HMAC-SHA256 digest,
bound to workspace, entitlement and `billing.activate`. Evidence and code responses use
`Cache-Control: no-store`; their DTOs do not implement Debug. Plaintext delivery is once only,
for operator out-of-band handoff. Lost responses require explicit reissue.

Retrying confirmation of the same payment with an open grant returns its current state and
`activation: null`, without writes/audit, even after activation or suspension. A different payment
conflicts. Reissue requires a pending workspace and matching unactivated paid grant; it invalidates
the old challenge, resets attempts and starts a fresh 72-hour lifetime without changing the grant.
After revocation, the same payment can create a new grant/code; closed history and evidence remain.

Suspend accepts active → suspended and retains the grant. Resume accepts suspended → active only
with an activated open paid or grandfathered grant. Repeating the resulting status is a no-op;
pending workspaces cannot use either operation to activate. Revoke closes any open grant,
invalidates its challenge and returns active/suspended/pending workspaces to pending payment;
already pending without a grant is a no-op. Suspend and revoke require `{ "reason": "…" }`,
trimmed and 1–500 characters. Refunds remain outside the application.

Each write locks and rereads the workspace and commits all effects once. Billing audit actions are
`billing.confirmed`, `billing.code_reissued`, `billing.activation_revoked`; status transitions append
`platform.workspace_status` with from/to/reason and operator actor. No reference or code enters
billing audit payloads. The old `platform.workspaces.set_status` row, use case, panel client helper
and `PATCH /api/platform/workspaces/{workspace_id}/status` route are removed (404).
The existing workspace page offers reasoned suspension and entitlement-preserving resumption.
Owner code redemption is Task 4; the dedicated operator payment console is Task 6.

Fast verification: `cargo test --locked --workspace --test billing --test platform`. The `platform`
targets include `platform/m4_platform_payments.rs`, `platform/m4_payment_races.rs` and
`platform/m4_platform_payments_http.rs`: shared fake/Pg behavior, real concurrent confirmations,
SQL-failure rollback after code/status writes, exact audit counts/actors, cross-workspace refusal,
operator/tenant session separation, request-header enforcement, no-store and legacy-route removal.
The complete catalog/HTTP/MCP parity tests retain the exact 125-tool count.

## M4 Task 4 — workspace-locked panel activation

Current implemented boundary: **142 catalog rows**, **125 MCP tools**, **67 tables**,
**12 migration pairs (0001–0012)**, **21 scheduled jobs**. No new migration, job or MCP tool.

| Use case | Panel route | Permission / status |
|---|---|---|
| `billing.activate` | `POST /api/billing/activate` | Human session, `team.manage`, active current owner membership; pending payment only |

The row is panel-only, strategy-exempt and has an exact PendingPayment status exemption.
There is no MCP activation handler, tool or schema. The existing mutation request header is
required. `{ "code": "…" }` is the only input; successful and validation responses use
`Cache-Control: no-store`. Invalid request bodies receive sanitized errors and count as guesses.

Redemption acquires the same workspace lock as confirmation, reissue, suspension and revocation
before reading the challenge. It then locks the caller's membership and current role and checks
both again inside the transaction. Any current owner may redeem; a stale former-owner context
cannot. Ownership changes do not invalidate a challenge. The workspace/grant/action-bound HMAC
is verified in constant time. Issuance checks all challenge digests in the workspace, including
invalidated and consumed history, and regenerates any collision under the workspace lock.

Each incorrect or malformed code commits one failed attempt before returning `VALIDATION`.
Five attempts lock the challenge even for a correct code; only operator reissue resets it.
The 72-hour expiry is exclusive (`expires_at <= now` is refused). Absent, consumed or invalidated
challenges cannot change payment or status. A successful redemption atomically consumes the
challenge, records the redeemer and activation time on the paid grant, changes the workspace to
active, and appends `billing.activated` with IDs and redeemer only. Lost responses recover through
billing status; replay cannot undo suspension or revocation. No payment action approves strategy,
verifies capabilities or connects an agent; existing `confirm: true` actions remain intact.

Fast verification: `cargo test --locked --workspace --test billing --test platform --test gate_rule --test twin_rule --test catalog`.
`billing/m4_payment_codes.rs` and `billing/m4_payment_code_storage.rs` run shared fake/Pg contracts
for guesses, expiry, ownership and role locks, binding/replay, historical digests, rollback and the
full activate/suspend/resume/revoke/reconfirm lifecycle. Platform contracts exercise both lock
orders with a held real transaction; PostgreSQL also injects a final-audit SQL failure. HTTP and
MCP tests verify session/header requirements, code secrecy, no-store and the exact 125-tool set.

## M4 Task 5 — readiness and redacted operational health

Boundary: **143 catalog rows, 125 MCP tools, 67 tables, 12 migration pairs,
21 scheduled jobs**. The only added catalog row is `ops.health` →
`GET /api/platform/health`: panel-only, Exempt / Always / Read. It requires an
operator `jt_platform` session; tenant sessions and API keys cannot open it.
`GET /healthz` remains liveness (`200 {"ok":true}`). `GET /readyz` returns only
`{"ok":true|false}` with 200/503, checking completed boot/migrations, database
connectivity and local FileStore read/write availability. The file probe writes a nonempty
4 KiB payload, fsyncs, reads and compares it, then removes its reserved non-tenant file
through the active store's directory handle. A changed directory identity is degraded,
including a rename followed by recreation at the configured path. Readiness and health
bound the store probe to two seconds; results are not cached. Connector reports,
recovery markers and disk capacity do not gate readiness. Neither `/readyz` nor
`/metrics` has a catalog row or MCP tool; both paths are reserved from SPA fallback.

`JEETA_METRICS_TOKEN` is required and nonblank for **serve** (not mcp-stdio).
`GET /metrics` requires `Authorization: Bearer <token>`; cookies do not substitute
for the token. Authentication compares SHA-256 digests in constant time. Responses
use `text/plain; version=0.0.4`, stay within 256 KiB, and never truncate a metric.
HTTP counters use registered route templates (unknown paths collapse to `other`),
connector counts aggregate across tenants by fixed provider kind, and job and
webhook outcome labels are fixed sets. Workspace IDs appear only in authenticated
operator JSON, never metric labels. Pool reachability/occupancy, available disk
bytes, job outcomes, reconnect counts and accepted/unrouted/unresolved webhook
counters are process-local. Unresolved includes signed bodies the parser cannot
interpret and NetGSM intake without an unambiguous capability. A signed, unrouted
Meta webhook still returns 200 and increments `unrouted`; it stores no event.

Health exposes RFC3339 observation and process-start times, explicit
`history: "unknown_before_process_start"`, job last-success times (null until a
success) and failure totals. Counters reset on restart; there is no persistent
counter history or new table. Missing probes remain `unknown`, never healthy.
Connector projection reads only workspace ID, kind and reconnect/expiry metadata;
it never selects sealed credentials, full public JSON, messages or payment evidence.
A failed connector projection has its own state and does not change DB reachability.

`JEETA_RECOVERY_STATUS_DIR` is optional; when set it must be an absolute directory,
protected from tenant writes and readable by the service. Task 9 writes these
**verified-success artifacts** atomically; this task only reads them (maximum 4 KiB
per file). Minimal schemas, with RFC3339 timestamps:

```json
// backup-status.json: publish only after a completed and verified full backup
{"completed_at":"2026-10-26T01:00:00Z"}
// wal-status.json: publish only after confirmed WAL archive success
{"archived_at":"2026-10-26T01:05:00Z"}
```

Never publish a current timestamp merely because a timer ran. Missing, malformed or
oversized files are `unknown`; future timestamps and backup age >24 hours or WAL
age >15 minutes are `degraded`. Available disk <10% is `degraded`. Capacity uses
`/usr/bin/df -Pk -- <files-directory>` without a shell (GNU coreutils, included in
the Linux deployment); inability to observe capacity is `unknown`. No new crate
or unsafe FFI is introduced for this probe.

Production uses `JEETA_LOG_FORMAT=json` to stderr/journald. Internal errors log
fixed error categories, never arbitrary error chains, input bodies or URLs.
`rmcp` is capped at warnings even when a more-specific filter requests info/trace.
Domain audit entries remain separate from operational logs; journald retention
remains 30 days / 1 GiB as configured by deployment.

Fast verification (includes all ten named acceptance tests, metadata Pg/fake parity,
operator session isolation, exact catalog/gate/twin assertions and subprocess stderr
canaries with separate ledger assertions):

```sh
cargo test --locked --workspace --test ops --test m4_observability --test catalog --test gate_rule --test twin_rule
```


## M4 Task 6 — platform console and operator recovery

Boundary: **144 catalog rows, 125 MCP tools**; no migrations or new tools.
`platform.operators.reset_password` is the sole added row:
`POST /api/platform/operators/{operator_id}/reset-password` with `{password}`,
panel-only / Exempt / Always / Write. It requires a different authenticated
operator and the panel mutation header. Tenant cookies and bearer/API keys do
not authorize it; operator cookies cannot authorize tenant routes.

`OperatorRepo::{set_password,lock_all}` and `PlatformSessionRepo::revoke_all`
provide atomic reset and session revocation in Pg and the transactional fake.
Operator lookup for login locks its row through password verification and session
insertion. Reset hashes before beginning its transaction. Pg locks the operator
table against concurrent inserts when checking the sole-operator predicate,
then locks rows; reset updates the hash and deletes all target sessions in one
commit. Another operator's sessions remain valid. Passwords require at least
12 Unicode characters; neither password nor hash enters reset logs.

`JEETA_PLATFORM_BOOTSTRAP_RESET=1` selects startup recovery instead of bootstrap
and requires both bootstrap variables. Exactly one matching-email operator must
exist; zero/multiple/mismatch abort boot. Absent flag or `0` retains ordinary
bootstrap's existing-operator no-op. Other flag values and short passwords are
configuration errors. Remove all three variables after recovery. Recovery may
commit even if a later boot stage fails. See
[operator access](../docs/operations/operator-access.md) and
[deployment](../docs/operations/deployment.md).

The operator-only navigation links workspaces, payment reports and sanitized
health. Payment confirmation/reissue responses display the one-time code and
expiry in page-local state, never query/mutation caches, localStorage or telemetry;
navigation discards it. Confirmation retries retain the returned current workspace
status. Suspend/revoke require reasons; resume reads “Yeniden aç”. Health renders
explicit sanitized fields and hosts the other-operator reset form.

The operator payment list uses `PlatformRepos::payment_entitlements_latest` to
read the latest grant per `(workspace_id, payment_id)`, including revoked grants.
PostgreSQL uses one bulk `DISTINCT ON` query; the fake and wrappers share the same
ordering (`confirmed_at DESC, id DESC`). Together with the payment evidence read,
listing uses two fixed queries rather than one entitlement lookup per payment.
`entitlement_get` retains its open-grant semantics for confirm, reissue and resume.
The console distinguishes “Geri alındı” from “Onay bekliyor” after reload, and
re-confirming a payment displays its new open grant. A shared fake/Pg contract
covers confirm → activate → revoke → list → re-confirm, multiple workspaces and
separate payments within one workspace; a browser test verifies the Turkish
states and reissue availability.

Fast verification includes `platform/m4_platform_access.rs` in app/Pg aggregates,
`platform/m4_platform_access_http.rs`, `m4_operator_reset` and exact catalog/twin
rules. Shared contracts test both lock orders on fake and real PostgreSQL,
password replacement, target-only revocation and invalid recovery cardinality.
The binary test exercises absent/zero/one flags through real startup and checks
Argon2 replacement plus session revocation. Browser tests assert Turkish labels,
confirmation retry, code cache absence/navigation lifetime, reason forms, operator
navigation and sanitized health field selection.

## M4 Task 7 — tenant first-run journey and provider setup

`/billing` and `/onboarding` derive progress from the existing workspace, billing,
work/strategy, team, API-key and capability APIs. Home, connection and key pages link
back to the journey. No completion flag, table, seed, catalog row or MCP tool was
added: the Task 6 boundary remains **144 catalog rows / 125 tools**.

A pending owner can prepare strategy and report bank-transfer evidence. The billing
page displays configured price/currency/bank instructions and the workspace reference
read-only. Operator confirmation leaves access pending until a current owner redeems
the delivered code. Guidance explains the 72-hour expiry, five-attempt lockout and
operator reissue. Suspension keeps entitlement visible; revoked grants lead back to
payment. Workspace activation, payment confirmation, strategy approval, connector
verification and recent agent contact remain separate indicators. The agent step
explains that the tenant's own scheduler must run.

Billing queries use `gcTime: 0`, abortable reads and explicit removal on page exit.
Evidence submissions and activation input/results stay outside mutation caches;
late responses cannot repopulate an exited page. Activation codes never enter URLs,
storage or logs. API-key plaintext is component-local, copied only on an explicit
click, and lost on dialog close/navigation; creation responses are not cached.

Provider guidance derives `${JEETA_PUBLIC_BASE_URL}/oauth/callback/{meta|instagram|x|tiktok|linkedin}`
from the existing hooks API's configured public base, preserving any path prefix.
It displays actual webhook addresses, reconnection requirements and access expiry.
The missing-app `CONFLICT` reason is shown as “Sağlayıcı uygulaması yapılandırılmadı”;
other conflicts retain their normal error handling. Hook data is page-scoped too.
Existing connector forms continue to own credential entry. Turkish/English keys
remain in parity.

`cargo test --locked --workspace --test onboarding` runs the real-router/PostgreSQL
journey tests, including pending/confirmed refusals, independent activation gates,
current-owner redemption, suspend/reload/resume and narrow-scope refusals. Browser
coverage in `BillingPage`, `OnboardingPage`, `ApiKeysPage` and `ConnectPage` exercises
navigation, state changes, secret lifetime, provider failures and callback addresses;
`api/billing.test.ts` checks exact wrapper routes and payloads. Ownership-transition
setup changes the membership through the repository after issuing a challenge because
pending workspaces correctly prohibit team mutations; redemption uses the real route.

## M4 Task 9 — daily backup, WAL and isolated recovery

T067 supplies `scripts/backup.sh`, `scripts/restore-drill.sh`, the backup service/timer
and reversible synthetic drill fixtures. T072 supplies `jeeta recovery-verify`,
explicit reversible `recovery-canary-up`/`recovery-canary-down` provisioning, the
60-second WAL probe, Rust restore tests and the `restore-drill` CI job.

`recovery-verify` uses protected environment/key-file configuration and the ordinary
DB role. It requires exactly the embedded successful sqlx versions/checksums, FORCE
RLS on tenant tables and a matching sealed canary, without migrating or serving.
`serve` rejects unknown/dirty/changed applied migrations before migration or binding.
See [the recovery runbook](../docs/operations/backup-restore.md) for canary custody,
Unix-socket hooks, logical/PITR differences, isolation and recovery commands.

Run `make restore-drill` for the real-binary logical/PITR shell harness and
`cargo test --locked -p jt_pg --test m4_restore` for SQL-only restore contracts
(`JEETA_TEST_DATABASE_URL` required). The harness builds one debug binary and uses
PG16 host tools in a private network namespace, or a uniquely named disposable
`postgres:16` container plus the host verifier over a mounted Unix socket.
Python 3/libseccomp enforce Unix-only sockets for that verifier. CI requires host
tools and uploads fixed PASS categories only.

The owner checks daily backup completion, `ops.health` and off-machine custody,
and records **both** logical restore and PITR drills monthly (RPO 24 h, RTO 1 h),
including recovery of the original master key and file evidence. The shell writes
`backup-status.json` with `completed_at` only after verified success. With optional
absolute `JEETA_WAL_ARCHIVE_DIR` plus `JEETA_RECOVERY_STATUS_DIR`, the server writes
`wal-status.json` atomically only after PostgreSQL archiver success and segment
presence; `archived_at` is the PostgreSQL timestamp, `observed_at` the probe time.
Failures retain the old marker and degrade WAL health; disabled is unknown.
Both artifacts are bounded JSON with RFC3339 times, never credentials or URLs.


## M4 Task 8 — reproducible deployment and boot/shutdown

One package contains the production `jeeta`, matching `panel/`, reversible
`migrations/`, `scripts/`, `deploy/`, operation documents and `manifest.json`.
From a clean committed revision in `rust/`:

```sh
python3 -m unittest discover -s scripts -p 'test_package_release.py'
python3 scripts/package-release.py /absolute/new/jeeta-release
```

The packager runs `cargo build --release --locked -p jeeta` (with JSON artifact
metadata), `pnpm --dir panel install --frozen-lockfile` and `pnpm --dir panel build`
itself. It refuses a changed/dirty source revision, missing production artifact
evidence or `jt_outbound/test-loopback`; pre-existing binaries/panel files are
never accepted as build provenance. It also refuses untracked/ignored Rust or
panel source inputs (including Vite dotenv files), except the expected build/cache
directories; use a clean packaging checkout. Ambient `VITE_*` and Rust cfg flags
are excluded from the controlled build. Cargo uses the default `target/` directory.

Before builds and copying, it rejects symlinks in input roots, ancestors and trees,
including the binary, panel, migrations, scripts, deploy and operation documents.
After building, it validates the generated panel inventory: only `index.html` and
explicit browser asset types (JS/CSS, images, fonts, WASM) are allowed. Dotfiles,
`.env*`, PEM/key files, JSON/text/configuration files and source maps are refused,
including files copied from ignored `panel/public/` inputs. The Python regression
suite runs in CI's existing release job.

The manifest records the source SHA, binary SHA-256, a sorted `panel.sha256` and
its SHA-256, ordered migration versions/up-down SHA-384 checksums, highest schema
version and toolchain versions. Source files come only from the committed tree.
This is a repeatable packaging recipe; it does not promise identical bytes
across build hosts. CI's `release-artifact` job archives the package without
publishing/deploying. `rust-test` tests that exact candidate, preserving executable
permissions by extracting its tar archive.

Build the package-scoped release candidate **before** running workspace tests:
workspace dev features enable test-only loopback paths in the debug binary.
`bin/jeeta/tests/m4_deployment.rs` drives real children against disposable
`JEETA_TEST_DATABASE_URL` databases. It requires `target/release/jeeta` and the built
`panel/dist`, or explicit `JEETA_RELEASE_BINARY` / `JEETA_RELEASE_PANEL_DIR` paths
for an extracted package. It covers all eight named Task 8 contracts, production
egress refusal and panel/API/MCP smoke checks. It does not recursively build Cargo.

After configuration validation, serve rejects test-loopback builds, connects,
rejects unsafe database roles, checks the existing schema and applies pending up
migrations under sqlx locking. Adapters/egress and optional operator bootstrap/reset
finish before HTTP binds and jobs start. Failures abort startup with redacted
runtime diagnostics. `mcp-stdio` never migrates or runs jobs; it requires a compatible
schema and authenticates its key at startup. Restart affected stdio clients after
key revocation or issuer demotion. `JEETA_JOBS_ENABLED=false` starts no scheduled
provider work; configured WAL health probing remains enabled.

SIGTERM/SIGINT stops scheduling and drains HTTP for at most 10 seconds, followed
by up to 30 seconds for remaining job runs. The supplied systemd unit allows 60
seconds. Use an existing absolute private FileStore at `/var/lib/jeeta/files` and
include it with the original master key in recovery sets. Metrics, operator reset
and recovery status/WAL variables are implemented; see the
[deployment runbook](../docs/operations/deployment.md) and
[backup/restore runbook](../docs/operations/backup-restore.md) for custody, units,
proxy limits, upgrade/rollback and the required monthly isolated restore drill.

## M4 — final automated acceptance boundary

The ratified boundary is **144 catalog rows, 125 MCP tools, 67 tables,
12 reversible migration pairs (0001–0012), and 21 scheduled jobs**. Relative to
M3's 134 rows/124 tools, M4 adds eleven named rows and removes
`platform.workspaces.set_status`; only `jeeta.billing.report_payment` is a new
MCP tool. Activation, operator administration and health remain panel-only.
`/healthz`, `/readyz` and `/metrics` are infrastructure, without catalog rows.
Payment evidence, operator confirmation, current-owner redemption, workspace
status, strategy approval, capability verification and agent contact remain
independent facts. There is no payment provider, credit or subscription system.

From `rust/`, with `JEETA_TEST_DATABASE_URL` pointing at a disposable test server:

```sh
# Exact M3 snapshot + ratified M4 names, actual HTTP bindings, MCP schemas/effects.
cargo test --locked --workspace --test m4_productisation --test twin_rule --test gate_rule
# Aggregate real-Pg HTTP/MCP lifecycle, existing M2/M3 recording-provider scenarios,
# retention, ordinary-role RLS, billing/onboarding/platform, T5 logs and T9 restores.
make smoke-productisation
# Individual M4 storage, migrations, race/authorization, and binary contracts.
cargo test --locked --workspace --test m4_billing_storage --test m4_billing_contracts --test billing_repos --test migrations --test billing --test platform --test onboarding --test ops --test m4_operator_reset --test m4_observability --test jobs --test rls --test m4_restore
# T8: first build the production candidate independently of workspace dev features.
cargo build --release --locked -p jeeta
pnpm --dir panel build
cargo test --locked --workspace --test m4_deployment
# T9/T10 real isolated logical/PITR drill and synthetic cutover rehearsal.
bash scripts/tests/backup-restore.sh
bash scripts/tests/v1-cutover.sh
```

`full_productisation_smoke` runs registration, pending strategy preparation,
evidence/report retry, operator handoff, current-owner panel activation, adapter
restart, team/key/capability operations and authenticated MCP with explicit
refusals. It exercises suspend/resume/revoke/re-confirm on the same payment and
single-use codes. It reuses `smoke_inbox` and `smoke_studio` unchanged scenario
bodies for M2/M3's recorded webhook/reply/publication/measurement sequence; those
scenarios use transactional fakes. The existing paid attribution smoke also runs
on Pg. The script runs T9's `m4_restore` actual-Pg contracts, rather than treating
a health marker as proof of restoration. The shell logical/PITR harness remains
a separate required final check. No CI scenario sends real provider/payment traffic.

The Pg job tests compare retained message, publication, attempt, piece, slot and
ledger row images before/after cleanup. Temporary raw bodies and probes test the
30-day cutoff at minus/exact/plus one microsecond, repeated cleanup, and active,
pending and suspended tenants. Production domain data is never seeded by these tests.

Final release-candidate verification (once after the fast checks are green):

```sh
set -o pipefail
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
RUSTDOCFLAGS="-D warnings" cargo doc --locked --workspace --no-deps
cargo test --locked -p jt_outbound --test production_build
cargo deny --locked check
pnpm --dir panel test
pnpm --dir panel typecheck
pnpm --dir panel build
bash scripts/tests/backup-restore.sh
bash scripts/tests/v1-cutover.sh
```

T8 evidence comes from the deployment/package contracts and package-scoped release
build (`51f91b12`, `87979a1b`, packaging hardening `8c697fd1`); T9 from the backup scripts and real verifier/drill
(`f9cdf206`, `fc3c17fd`, `56228ee0`, `ad729fad`); T10 from the synthetic cutover
rehearsal (`4cfc3feb`). These identify implementation provenance, not live approval.
The [Turkish owner acceptance checklist](../docs/operations/m4-acceptance.md)
records the remaining owner-only live payment/provider smoke, new provider-app
approval, deployment, actual recovery-set logical/PITR validation, secret custody,
and switch/rollback decisions. Unresolved provider approval or a failed restore
keeps M4 acceptance open. Automated verification does not tag, publish or deploy.


### Operator-only v1 lead import

The 2026-10-26 owner ruling permits **allowlisted leads only** from v1.
`jeeta import-v1-leads --workspace <uuid> --input /root/v1-leads.jsonl --dry-run`
rehearses every repository write (including the ledger) in rolled-back 100-lead
transactions, with cross-chunk duplicate and parent context held in memory.
Normalized emails over 254 characters and phones over 15 digits are skipped and
counted as invalid in both modes. Omit `--dry-run` to import or replace it with
`--rollback` to remove unchanged imported aggregates. Existing identities are
never stolen; touched records survive rollback. Use the protected serve database
and secret-key environment, an ordinary RLS role and an exactly matching schema.
This command runs no migrations, HTTP, jobs or providers. See the
[export, verification and rollback procedure](../docs/operations/v1-cutover.md#leads-only-owner-amendment-2026-10-26).
