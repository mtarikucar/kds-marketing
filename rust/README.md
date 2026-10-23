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
döndürür. Beş göç vardır:

| Göç | Ne yapar |
|---|---|
| `0001_foundation` | çalışma alanları, kullanıcılar, oturumlar, roller, üyelikler, API anahtarları, ajan bağlantıları, günlük, platform operatörleri |
| `0002_strategy` | strateji sürümleri, hipotezler, istişare kaydı |
| `0003_capabilities` | kabiliyetler (bildiren ajan bağlantısı `declared_by_connection` dahil), gruplar (adı alan içinde büyük/küçük harf ayırmadan tek: `capability_groups_name_ci`, `lower(name)` üzerinde), bütçe kalemleri ve bağları, harcama kaydı, çalışma alanı politikaları |
| `0004_role_permissions_backfill` | M1a'dan önce açılmış alanların sistem `owner` ve `manager` rollerine `capabilities.manage` ve `budget.manage` izinlerini ekler (özel rollere ve `rep`'e dokunmaz; `down` yalnız bu iki anahtarı o iki rolden çıkarır) ve ajan yoklamasının son kaydını bulan kısmi dizini (`ledger_entries_agent_connection_idx`, yalnız `action = 'work.checkin'` satırları) açar |
| `0005_connectors` | gelen olaylar (`inbound_events`: alan, sağlayıcı ve sağlayıcının kimliği başına bir kez; ham gövde ayrı sütunda; bir tetikleyici yalnız `processed_at`'in yazılmasına ve `raw`'ın silinmesine izin verir, satır silinmez; geçmiş için en yenisi başta bir dizin), bekleyen OAuth akışları (`oauth_pending`: imzalı durumun özeti bütün alanlarda tek, PKCE doğrulayıcısı ve varlıklar mühürlü; akışın oturum açtığı uygulama `app`; yeniden bağlama akışı yenilediği kabiliyeti `capability_id` ile adlar), prob kayıtları (`probe_runs`, yalnız eklenir; bir tetikleyici her değişikliği ve 30 günden genç bir kaydın silinmesini reddeder); bütçe kalemlerine emekliye ayrılma zamanı (`budget_items.retired_at`, canlı kalemde `null`; `down` yalnız bu sütunu düşürür) |
| `0006_inbox` | Gelen kutusu için 13 alan tablosu (36 toplam): kişiler, kimlikler, konuşmalar, mesajlar, yolculuklar ve olayları, görevler, notlar, birleştirmeler, kayıp nedenleri, tüketici kayıtları, gönderim kuyruğu ve 24 saatlik istek anahtarları. FORCE RLS ve bileşik yabancı anahtarlar; varsayılan kayıp nedenleri ve sistem rollerinin gelen kutusu izinleri geriye dönük eklenir. |

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
   # 200, Mcp-Session-Id: …; ardından aynı başlıkla notifications/initialized ve tools/list (90 araç)
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

Sunucu 90 araç tanımlar; `tools/list` her ajana yalnızca anahtarının etkin izinlerinin yettiğini
gösterir (ör. `team.manage` taşımayan bir anahtar ekibi değiştiren araçları görmez). Her açıklama
risk etiketiyle biter (`[risk: READ]`, `WRITE`, `SPEND`, `DESTRUCTIVE`); geri dönüşü olmayan üç araç,
`jeeta.strategy.archive` (strateji kapısını kapatır), `jeeta.capability.retire` (kabiliyeti kesin olarak
emekliye ayırır) ve `jeeta.budget.items_retire` (bütçe kalemini kesin olarak emekliye ayırır), ayrıca
`confirm: true` ister, yoksa `VALIDATION`. Birleştirmeyi geri alan
`jeeta.inbox.merges_undo` da `DESTRUCTIVE` olarak işaretlidir ve `confirm: true` ister.
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

Meta, Instagram ve X hesapları platformun kendi OAuth uygulamalarına bağlanır: uygulamalar kiracı başına
değil platform başınadır, ortamdan okunur (bkz. [Yapılandırma](#yapılandırma)), kiracılar kendi
hesaplarını bu uygulamalara bağlar. Uygulamaları açmak, ayarlamak ve onaylatmak **platform sahibinin
işidir**; Jeeta yalnız aşağıdaki değerleri okur. Kayıtlı yönlendirme adresleri, her biri sağlayıcının
panelinde birebir girilir (`{genel adres}` = `JEETA_PUBLIC_BASE_URL`):

| Uygulama | Değişkenler | Sağlayıcı panelinde | Yönlendirme adresi |
|---|---|---|---|
| Meta (Facebook Login, Graph API) | `JEETA_META_APP_ID`, `JEETA_META_APP_SECRET`, `JEETA_META_VERIFY_TOKEN`; isteğe bağlı `JEETA_META_LOGIN_CONFIG_ID`, `JEETA_META_WHATSAPP_CONFIG_ID`, `JEETA_META_GRAPH_VERSION` | developers.facebook.com → uygulama → Ayarlar → Temel: Uygulama Kimliği ve Uygulama Sırrı; Facebook Login (for Business) → Ayarlar → Geçerli OAuth Yönlendirme URI'leri; Webhooks → Sayfa, Instagram ve WhatsApp Business Hesabı nesneleri için geri çağırma adresi `{genel adres}/hooks/meta` ve doğrulama anahtarı (`JEETA_META_VERIFY_TOKEN` ile aynı değer) | `{genel adres}/oauth/callback/meta` |
| Instagram (Instagram Login) | `JEETA_INSTAGRAM_APP_ID`, `JEETA_INSTAGRAM_APP_SECRET` | Meta uygulamasının Instagram ürünü → API setup with Instagram login: Instagram uygulama kimliği ve sırrı; "Business login settings" → OAuth redirect URIs | `{genel adres}/oauth/callback/instagram` |
| X | `JEETA_X_CLIENT_ID`, `JEETA_X_CLIENT_SECRET` | developer.x.com → proje → uygulama → User authentication settings: OAuth 2.0, tür "Web App, Automated App or Bot" (gizli istemci), okuma ve yazma izni (Jeeta `tweet.read`, `tweet.write`, `users.read`, `offline.access`, `media.write` ister), Callback URI; Keys and tokens → OAuth 2.0 Client ID ve Client Secret | `{genel adres}/oauth/callback/x` |

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
  `permission` olarak görünür.
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
yoklanmaz, jetonları yine yenilenir). Her yoklama `probe_runs` kaydına yazılır (yalnız sonuç sınıfı ve
genel bilgiler, 30 gün tutulur); günlüğe (`connector.probe`) yalnız durum değiştiğinde yazılır. Sağlık
(`connector.health`) her bağlayıcı kabiliyetinin şimdiki durumunu, son yoklamasını, jetonun bitişini ve
yeniden bağlama gereğini mühür açmadan okur. Yeniden bağlama (`connector.reconnect`) Meta ve X için
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
| `purge_raw_bodies` | 1 gün | 30 günden eski gelen olayların ham gövdesini her alanda ayrı ayrı siler (`webhook::purge_raw_in`; silinemeyen alan sayılır, ötekiler yine silinir); olaylar kalır | `jeeta.jobs.purge_raw_bodies` |
| `purge_oauth_pending` | 1 saat | Süresi geçmiş bekleyen OAuth akışlarını siler | `jeeta.jobs.purge_oauth_pending` |
| `purge_probe_runs` | 1 gün | 30 günden eski prob kayıtlarını siler; `probe_runs` tetikleyicisi her değişikliği ve veritabanının saatine göre 30 günden genç bir kaydın silinmesini reddeder | `jeeta.jobs.purge_probe_runs` |
| `inbox_consume` | 10 saniye | Gelen olayları tek işlemde gelen kutusu kayıtlarına dönüştürür; active ve pending_payment alanlar | `jeeta.jobs.inbox_consume` |
| `outbox_recover` | 1 dakika | 2 dakikadan eski `sending` → `unknown` (yeniden göndermez); 5 dakikadan eski `queued` kayıtlarını iki çitli gönderim adımına verir | `jeeta.jobs.outbox_recover` |

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

`reply`: `{text,intent:"reply",request_key?}`. M2a'da `commercial` doğrulama hatasıdır.
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

Conversation and message lists return `{items,next_cursor}` with stable keyset pagination (default 50, maximum 499). Pass `next_cursor` unchanged to continue. Conversation queues: `ours`, `unassigned` (human executor without a user, excluding closed), `snoozed`, `all`. Takeover requires a human principal and increments the executor generation; hand-to-agent also increments it. Snooze accepts a future RFC3339 `until`; unsnooze returns to `ours`. Reply accepts `{text,intent:"reply",request_key?}`; commercial intent is reserved for M2b. Human replies preserve the executor.

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

LeadGen, Consent, Unknown, yönlendirilmemiş/desteklenmeyen kabiliyet olayları,
eşleşmeyen raporlar ve henüz konuşması bulunmayan echo'lar `deferred` kaydedilir.
Bu kayıtlar `inbox@2` tarafından tekrar talep edilebilir; mesaj ve yolculuk anahtarları
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

The catalog contains **90 MCP tools: the M1b 60 plus 30 inbox tools**. Every inbox tool
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
| `won` | Close journey and open tasks; emit CommissionDue (commission accounting is M2b). |
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
with workspace policy overrides. Keys remain fixed; the panel renders the returned label.

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
