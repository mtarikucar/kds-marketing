# Jeeta — Rust çalışma alanı

Jeeta'nın Rust ile yeniden yazımı: tek ikili (`jeeta`), altıgen (hexagonal) mimaride ayrılmış crate'ler.
Tasarım belgesi: `docs/superpowers/specs/2026-10-22-jeeta-rust-yeniden-yazim-design.md`.

İkilinin iki alt komutu vardır:

| Komut | Ne yapar |
|---|---|
| `jeeta serve` | HTTP sunucusu: panel (`/`), panelin JSON API'si (`/api/*`), `/healthz` ve MCP uç noktası (`/mcp`), tek dinleyicide |
| `jeeta mcp-stdio` | MCP araçlarını stdin/stdout üzerinden, `JEETA_STDIO_API_KEY` anahtarı adına sunar; HTTP yoktur |
| `jeeta --help` | Kullanımı yazdırır |

Bilinmeyen bir komut kullanımı yazdırır ve `2` koduyla çıkar. Yapılandırma, veritabanı bağlantısı ya da göç
hatası tek, okunur bir satır yazdırır (`jeeta: JEETA_SECRET_KEY: must be 64 hexadecimal characters …`) ve
`1` koduyla çıkar.

## Önkoşullar

- [rustup](https://rustup.rs). `rust-toolchain.toml` sürümü (Rust 1.96.0) ve `rustfmt`/`clippy`
  bileşenlerini ilk `cargo` çağrısında kendisi kurar.
- cargo-deny 0.19: `cargo install cargo-deny --locked`
- PostgreSQL **14 veya üstü** (yerelde ve CI'da 16). Taban sürümü iki deyim belirler: göçteki
  `create or replace trigger` 14 ister; test veritabanlarını silen `drop database … with (force)` 13 ister.
- Panel için Node 24 ve pnpm 9.

## Yerelde çalıştırma

1. Veritabanı ve uygulama rolü. Rol **süper kullanıcı olmamalı** ve `BYPASSRLS` taşımamalıdır (bkz.
   [Satır düzeyi güvenlik](#satır-düzeyi-güvenlik-rls-ve-veritabanı-rolleri)). Yönetici olarak:

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
   make dev                         # cargo run -p jeeta -- serve
   ```

   İkili önce `rust/.env`'i, yoksa çalışılan dizindeki `.env`'i okur; ortamda zaten tanımlı değişkenler
   dosyadakileri ezer. Açılışta sırasıyla: veritabanına bağlanır, bekleyen göçleri uygular
   (`migrations are up to date applied=1 total=1`), yapılandırılmışsa ilk platform operatörünü açar,
   sonra dinlemeye başlar:

   ```text
   INFO jeeta::serve: jeeta is listening bind=127.0.0.1:8080 panel=served from panel/dist allowed_hosts=0 migrations_applied=1
   ```

   `curl -s localhost:8080/healthz` → `{"ok":true}`; tarayıcıda `http://127.0.0.1:8080/` paneli açar.

4. Durdurma: `Ctrl-C` (SIGINT) ya da SIGTERM. Sunucu yeni bağlantı almayı bırakır, açık bağlantılara
   en çok 10 saniye tanır, sonra kapanır (açık bir MCP olay akışı bu süreyi doldurur).

## Yapılandırma

Bütün değişkenler `.env.example` içinde yer tutucularla listelidir. İsteğe bağlı bir değişkenin boş
bırakılması tanımsız sayılır. Her hata ilgili değişkeni adıyla söyler; sırların değeri hiçbir hatada ve
hiçbir günlük satırında görünmez.

| Değişken | Varsayılan | Anlamı |
|---|---|---|
| `JEETA_DATABASE_URL` | — (zorunlu) | Uygulamanın PostgreSQL adresi, `postgres://kullanıcı:parola@sunucu:port/veritabanı` |
| `JEETA_SECRET_KEY` | — (zorunlu) | Tam 64 onaltılık karakter (32 bayt): `openssl rand -hex 32`. Açılışta doğrulanır; M1'de bağlayıcı sırlarını mühürlemek için kullanılacak |
| `JEETA_BIND` | `127.0.0.1:8080` | Dinlenen `ip:port` |
| `JEETA_PANEL_DIR` | — | Derlenmiş panelin dizini (`panel/dist`); yoksa yalnızca API ve MCP sunulur. `index.html` bulunmazsa açılış günlüğü bunu söyler |
| `JEETA_COOKIE_SECURE` | `true` | Oturum çerezlerinde `Secure`. Yalnızca düz `http://localhost` için `false` |
| `JEETA_ALLOWED_HOSTS` | — | MCP uç noktasının `Host` başlığında kabul ettiği genel adlar, virgülle: `jeeta.example.com,jeeta.example.com:8443`. Döngü (loopback) adları her zaman kabul edilir. `JEETA_BIND` döngü adresi değilse zorunludur |
| `JEETA_PLATFORM_BOOTSTRAP_EMAIL` | — | İlk platform operatörünün e-postası; parolayla birlikte verilir |
| `JEETA_PLATFORM_BOOTSTRAP_PASSWORD` | — | İlk platform operatörünün parolası (en az 12 karakter); e-postayla birlikte verilir |
| `JEETA_STDIO_API_KEY` | — | `jeeta mcp-stdio` kipinin kullandığı API anahtarı (`jt_live_…`) |
| `JEETA_LOG` | `info,rmcp=warn` | `tracing` süzgeci, ör. `info,rmcp=warn,jeeta=debug`. Kendi süzgecinizde `rmcp=warn`'u koruyun: rmcp her yeni MCP oturum kimliğini (`Mcp-Session-Id`) `info` düzeyinde yazar |
| `JEETA_LOG_FORMAT` | `compact` | `compact` ya da `json`. Günlükler stderr'e yazılır |

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
`workspace.*` ve `platform.*` dışındaki her kullanım durumu (`team.*`, `roles.*`, `api_keys.*`, `agents.*`,
`ledger.*`), panelden de MCP'den de, alan `pending_payment` ya da `suspended` iken
`423 {"code":"WORKSPACE_INACTIVE","details":{"status":"pending_payment"}}` alır. Yani ödeme bekleyen bir alan
operatör onu etkinleştirene kadar üye davet edemez ve API anahtarı açamaz; giriş, çıkış, `GET /api/auth/me`,
`GET /api/workspace` ve alan değiştirme çalışır. Askıya alınan bir alanda da aynısı geçerlidir; askıdaki bir
alana bekleyen bir davet de kabul edilemez. API'den (değişiklik yapan her istek
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
   `initialize` eder. Ajan anahtarın çalışma alanında, anahtarın kapsamlarıyla çalışır.

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
   # 200, Mcp-Session-Id: …; ardından aynı başlıkla notifications/initialized ve tools/list (M0'da 15 araç)
   ```

   Geçersiz bir anahtar `401 {"code":"UNAUTHENTICATED","message":"invalid api key","details":{}}` alır.

**Döngü dışı adlar.** MCP uç noktası DNS yeniden bağlama (rebinding) saldırılarına karşı `Host` başlığını
denetler: varsayılan olarak yalnızca `localhost`, `127.0.0.1` ve `::1` kabul edilir, başka her ad `403` alır.
Sunucuya başka bir adla ulaşılıyorsa (genel bir alan adı, ters vekil (reverse proxy) arkasında bile)
`JEETA_ALLOWED_HOSTS` o adı içermelidir. Port yazılmayan bir ad her portta kabul edilir.

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

Bu adresin rolü süper kullanıcı olmalıdır, ama testler bu rolle çalışmaz: her test
`jt_test_<12 onaltılık>` adlı bir veritabanı ve aynı adlı, rastgele parolalı, sıradan bir oturum rolü
(`NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`) açar, veritabanını o role verir, göçleri ve sorguları o
rolle çalıştırır; test bitince ikisini de siler. Yönetici bağlantısı yalnızca açma ve silme içindir. Yeni
veritabanı `template0`'dan kopyalanır; bu yüzden adres `template1` dahil herhangi bir mevcut veritabanını
gösterebilir.

## Satır düzeyi güvenlik (RLS) ve veritabanı rolleri

Kiracı tabloları (`roles`, `memberships`, `api_keys`, `agent_connections`, `ledger_entries`) ve `workspaces`,
`ENABLE` + `FORCE ROW LEVEL SECURITY` ile korunur: bir satır yalnızca işlem içinde `app.workspace_id` o
çalışma alanını gösterdiğinde ya da `app.platform = 'on'` olduğunda görünür ve yazılabilir. Bu ayarları
yalnızca `jt_pg`'nin `TenantTx`, `PlatformTx` ve `UserTx` işlemleri koyar.

PostgreSQL, `FORCE` olsa bile süper kullanıcılara ve `BYPASSRLS` rollerine RLS uygulamaz. **Üretimde
uygulama, `JEETA_DATABASE_URL` içinde süper kullanıcı olmayan ve `BYPASSRLS` taşımayan sıradan bir rolle
bağlanmalıdır**; aksi halde çalışma alanları arasındaki yalıtım sessizce ortadan kalkar. Tabloların sahibi
bu rol olabilir (`FORCE` sahibi de bağlar).

Hedef düzen iki roldür: şemanın sahibi olan ve göçleri uygulayan bir **göç rolü**, ve yalnızca veri
işlemleri (`select`/`insert`/`update`/`delete`) yetkisi olan ayrı bir **çalışma rolü**. M0'da `jeeta serve`
göçleri her açılışta `JEETA_DATABASE_URL` ile kendisi uyguladığından bu rol şimdilik şemanın sahibi
olmalıdır; göçleri ayrı bir adımda göç rolüyle çalıştırmak sonraki bir kilometre taşına kalmıştır.

## Üretim notları

- TLS'i bir ters vekil sonlandırır; `JEETA_COOKIE_SECURE=true` (varsayılan) kalır.
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
| `make lint` | `cargo clippy --workspace --all-targets -- -D warnings` |
| `make doc` | `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps` |
| `make deny` | `cargo deny check` |
| `make test` | `cargo test --workspace` |
| `make dev` | `cargo run -p jeeta -- serve` |
| `make panel-install` / `panel-test` / `panel-build` | `panel/` içinde pnpm |

CI (`.github/workflows/rust.yml`) `rust/**` ya da iş akışı dosyası değiştiğinde, `main` ve `feat/**`
dallarına gönderimde ve her çekme isteğinde çalışır: `rust-checks` (fmt, clippy, doc, cargo-deny),
`rust-test` (PostgreSQL 16 hizmetiyle `cargo test --workspace`) ve `panel` (`pnpm install --frozen-lockfile`,
`pnpm test`, `pnpm typecheck`, `pnpm build`).

## Sınırlar

Crate sınırları iki yerden denetlenir; ikisi de `make check` içinde çalışır:

- `crates/jt_archtest`: alan (domain) crate'leri (`jt_tenancy`, `jt_ledger`) yalnızca `serde`, `serde_json`,
  `uuid`, `time`, `thiserror` kullanır; `jt_app` hiçbir adaptöre bağlı değildir; `reqwest` yalnızca
  `jt_outbound`'da, `sqlx` yalnızca `jt_pg`'de (havuz kurmak için `jt_testkit` ve `jeeta`'da da) bulunur.
- `deny.toml`: aynı HTTP istemcisi ve `sqlx` kuralları ile yapay zekâ, medya üretimi, ses tanıma ve ses
  sentezi sağlayıcı kütüphanelerinin bağımlılık ağacının hiçbir yerinde bulunmaması; lisans, güvenlik
  bildirimi ve kaynak denetimleri.
