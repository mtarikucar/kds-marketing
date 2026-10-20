# codex-media

Jeeta'nın görsel üretim yan servisi. Tek bir uzun ömürlü `codex app-server --listen stdio://` sürecini
(ChatGPT aboneliği, `features.image_generation`) yönetir; her iş ayrı bir ephemeral thread'dir. Üretilen görseli
istenen orana kırpar, R2'ye yükler ve küçük bir HTTP API ile backend'e verir.

Sözleşme: [`docs/superpowers/specs/2026-10-21-codex-media.md`](../docs/superpowers/specs/2026-10-21-codex-media.md) §1.
Backend tarafı (`CodexMediaProvider`) ayrı daldadır.

## Kurulum (yerel)

Node 22+ ve Codex CLI gerekir (`npm i -g @openai/codex@0.162.1`; sürüm sabittir, app-server protokolü sürümler arasında değişiyor).

```bash
cd codex-media
npm ci
npm test          # node:test + sahte app-server (test/fake-app-server.mjs); gerçek Codex'e gitmez
npm run typecheck # src + test
npm run build     # dist/
```

Gerçek Codex ile tek görsel (sahibin ChatGPT kotasından düşer):

```bash
codex login status                       # giriş yoksa: codex login --device-auth
CODEX_MEDIA_SECRET=dev CODEX_MEDIA_R2_DRYRUN=1 node dist/server.js &
curl -s -X POST localhost:7311/generate -H "Authorization: Bearer dev" -H 'Content-Type: application/json' \
  -d '{"prompt":"red apple on white","aspectRatio":"1:1"}'
# → {"jobId":"cm_…","status":"QUEUED","position":1}
curl -s localhost:7311/jobs/cm_… -H "Authorization: Bearer dev"
# → {"status":"COMPLETED","url":"file:///…/out/codex-media/_/cm_….png","width":1080,"height":1080,…}
```

`CODEX_MEDIA_R2_DRYRUN=1` R2 yerine `./out/` klasörüne yazar. Kısa sır (`dev`) yalnız `127.0.0.1` dinlerken kabul edilir.

## Sunucu (koordinatör)

Kapsayıcı tercih edilir: `Dockerfile` + `docker-compose.example.yml` (backend ile aynı `kds_marketing_net` ağı,
**port yayını yok**, backend `CODEX_MEDIA_URL=http://codex-media:7311`). Kapsayıcı `codex` (uid 10001) kullanıcısıyla,
salt-okunur kök dosya sistemiyle çalışır; `CODEX_HOME` kalıcı `codex-home` birimidir, `/work` tmpfs'tir.
Docker dışı seçenek: `codex-media.service` (systemd; docker köprüsü `172.17.0.1:7311`, iptables'ta yalnız backend'e açılır).

### ChatGPT girişi (device auth)

Sunucuda tarayıcı yok; giriş sahibinin hesabıyla, cihaz koduyla yapılır:

```bash
docker compose run --rm codex-media codex login --device-auth
#   → bir adres ve tek kullanımlık kod yazar; sahibi kendi tarayıcısında açıp kodu onaylar
docker compose run --rm codex-media codex login status
#   → "Logged in using ChatGPT"
docker compose up -d codex-media
curl -s http://codex-media:7311/health    # backend kapsayıcısının içinden: {"codex":"ready",…}
```

Oturum düşerse `/health` → `"codex":"auth_required"` ve `POST /generate` → `503 CODEX_AUTH_REQUIRED`; aynı iki giriş
komutu yeniden çalıştırılır. Servis 30 sn'de bir girişi yeniden okur, yeniden başlatmak gerekmez.

## Ortam değişkenleri

| Değişken | Varsayılan | Not |
|---|---|---|
| `CODEX_MEDIA_SECRET` | — (zorunlu) | Backend ile paylaşılan sır, ≥ 32 bayt (`openssl rand -hex 32`) |
| `CODEX_MEDIA_HOST` | `127.0.0.1` | Kapsayıcıda `0.0.0.0` (Dockerfile), port yayınlanmaz |
| `CODEX_MEDIA_PORT` | `7311` | |
| `CODEX_MEDIA_CONCURRENCY` | `2` | Aynı anda koşan thread |
| `CODEX_MEDIA_MAX_QUEUE` | `20` | Bekleyen iş sınırı; dolunca `429 QUEUE_FULL` |
| `CODEX_MEDIA_JOB_TIMEOUT_MS` | `180000` | Aşılınca `turn/interrupt`, iş `FAILED/TIMEOUT` |
| `CODEX_MEDIA_QUOTA_CEILING` | `60` | Haftalık Codex kotası bu yüzdeyi geçince `503 CODEX_QUOTA_EXHAUSTED` (ofise pay bırakır) |
| `CODEX_MEDIA_REF_HOSTS` | `R2_PUBLIC_BASE_URL` host'u | Virgüllü ek referans host'ları |
| `CODEX_MEDIA_MODEL` | boş | Boşsa hesabın varsayılan modeli |
| `CODEX_MEDIA_CODEX_BIN` | `codex` | Codex CLI yolu |
| `CODEX_MEDIA_WORK_DIR` | `$TMPDIR/codex-media-work` | İş klasörleri (thread `cwd`'si, referanslar); iş bitince silinir |
| `CODEX_HOME` | `~/.codex` | `auth.json` burada |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` | — | Backend ile aynı adlar |
| `CODEX_MEDIA_R2_DRYRUN` / `CODEX_MEDIA_DRYRUN_DIR` | — / `./out` | Yerel deneme: R2 yerine klasöre yaz |

## API

Her istekte `Authorization: Bearer <CODEX_MEDIA_SECRET>` (`/health` hariç). Gövde JSON, ≤ 64 KB.

- `POST /generate` `{ prompt, aspectRatio?, referenceImages?, workspaceId?, clientRef? }` → `202 { jobId, status:"QUEUED", position }`.
  Aynı `clientRef` 10 dk içinde aynı `jobId`'yi döner. Referanslar kuyruğa girmeden indirilir (hata → `400 REFERENCE_FETCH_FAILED`).
- `GET /jobs/:id` → `QUEUED | RUNNING {startedAt} | COMPLETED {url, mime, width, height, revisedPrompt, durationMs} | FAILED {code, message}`.
  İşler bitişten 1 saat sonra unutulur (`404 JOB_NOT_FOUND`).
- `GET /health` → `{ ok, codex: ready|starting|auth_required|down, queue, running, weeklyUsedPercent }`.

Hata kodları sözleşmenin §1.3 tablosundadır; buna ek olarak `413 PAYLOAD_TOO_LARGE` (gövde > 64 KB) ve iş hatası
`CODEX_ERROR` (Codex'in sınıflanmamış tur hatası) döner.

R2 anahtarı `codex-media/<workspaceId|_>/<jobId>.png` (geçici kopya; backend kendi anahtarına yeniden yükler).
Servis bu önekteki 24 saatten eski nesneleri saatte bir siler.

## Güvenlik

- Codex thread'i: `approvalPolicy: untrusted`, `sandbox: read-only`, ephemeral; apps, multi-agent, plugins, memories,
  web araması ve `config.toml`'daki her MCP sunucusu/eklenti kapalı. Sunucudan gelen her onay/elicitation isteği reddedilir;
  ajan komut, dosya değişikliği, MCP ya da web araması başlatırsa iş `POLICY_VIOLATION` olur ve tur kesilir.
- Base64 görsel ve tam istem loga yazılmaz (istem/`revisedPrompt` ilk 200 karakter).
- app-server ağda dinlemez (stdio); süreç ölürse 1 sn → 60 sn üstel beklemeyle yeniden başlar, o anda koşan işler `CODEX_PROCESS_EXITED`.
