# Jeeta paneli

Rust sunucusunun tarayıcı yüzü: React 18 + TypeScript (strict), Vite 5, Tailwind 3, React Router 6,
TanStack Query 5, i18next. `pnpm build` çıktısı `dist/` klasörüdür; `jeeta` ikilisi bu klasörü
`JEETA_PANEL_DIR` ile sunar. Panel yalnızca `/api/*` uçlarıyla konuşur; v1 ön yüzüne (`frontend/`)
hiçbir şekilde bağlı değildir, tasarım kiti oradan **kopyalanmıştır**.

## Önkoşullar

Node 24 ve pnpm 9 (`packageManager` alanı sürümü sabitler).

## Komutlar

```sh
cd rust/panel
pnpm install      # pnpm-lock.yaml'a göre
pnpm dev          # geliştirme sunucusu (http://localhost:5173)
pnpm test         # vitest (jsdom)
pnpm typecheck    # tsc --noEmit
pnpm build        # tsc --noEmit && vite build → dist/
```

`rust/` içinden aynısı: `make panel-install`, `make panel-test`, `make panel-build`.

## Çıktı ve sunum

- `pnpm build` → `rust/panel/dist/` (git'e girmez). İçinde `index.html` ve içerik özetli adlarla
  `assets/*.js|css` bulunur; kütüphaneler ayrı parçalardadır (`react`, `router`, `tanstack`, `i18n`,
  `vendor`), böylece bir panel sürümü yalnızca kendi parçasını yeniden indirtir.
- Sunucu (`jt_panel_http::static_files`): `/assets/*` → `Cache-Control: public, max-age=31536000,
  immutable`, eksik bir varlık `404`; geri kalan her yol (`/team`, `/invite/…` …) → `index.html`,
  `Cache-Control: no-cache`. `/api`, `/mcp` ve `/healthz` hiçbir zaman panele düşmez. Bu davranış
  `crates/adapters/jt_panel_http/tests/auth_http.rs` içindeki `static_index_served_when_panel_dir_set`
  testiyle sabitlenmiştir.

### Yerel sunucuya karşı çalıştırma

İkili göreli bir `JEETA_PANEL_DIR`'i **çalışılan dizine** göre okur: `rust/` içinden başlatılınca
`panel/dist`, depo kökünden başlatılınca `rust/panel/dist`. Dizinde `index.html` yoksa açılış günlüğü
bunu söyler (`panel=missing: …`).

```sh
cd rust/panel && pnpm build
cd .. && JEETA_PANEL_DIR=panel/dist JEETA_COOKIE_SECURE=false JEETA_DATABASE_URL=… JEETA_SECRET_KEY=… \
  cargo run -p jeeta -- serve
# http://127.0.0.1:8080/ → panel
```

Eksik ya da hatalı bir değişken tek satırlık bir hatayla durdurur, ör.
`jeeta: configuration: JEETA_SECRET_KEY: must be 64 hexadecimal characters …`.

Değişkenlerin tamamı ve yerel kurulum: `rust/README.md`. Panel ilk yazıldığında derlenmiş paket
`vite preview` ile sunulup başsız bir tarayıcıda, sahte bir `/api` ile açıldı: giriş, ana sayfa, ekip ve
günlük sayfaları çizildi; dil (TR → EN) ve tema (koyu) değişti; davet isteği
`X-Requested-With: jeeta-panel` başlığıyla gitti, `GET` istekleri başlıksız gitti.

Geliştirmede `pnpm dev`, `/api` ve `/healthz` isteklerini çalışan bir `jeeta serve`'e aktarır
(varsayılan `http://127.0.0.1:8080`, değiştirmek için `JEETA_PANEL_API`); oturum çerezi böylece aynı
kökende kalır.

## API istemcisi (`src/api/`)

- `client.ts`: tek `fetch` noktası. `credentials: "same-origin"`, JSON; her `POST`/`PATCH`/`PUT`/`DELETE`
  isteğine `X-Requested-With: jeeta-panel` eklenir (sunucu bu başlık olmadan kimlik doğrulamaya bile
  geçmez). Hata gövdesi `{ code, message, details }` → `ApiError { code, message, details, status }`;
  ağ hatası `NETWORK` (status 0). Bir `401` tarayıcıyı `/login`'e, `/api/platform/*` için
  `/platform/login`'e gönderir; giriş formları ve "oturum var mı?" yoklaması bunu `redirectOn401: false`
  ile kendisi ele alır. Girişten sonra gelinen sayfaya dönülür (yalnızca yönlendirici durumunda, URL'de
  değil; panel dışına işaret edemez).
- `types.ts`: Rust çıktı yapılarının karşılıkları (`MeOut`, `WorkspaceOut`, `MemberOut`, `InviteOut`,
  `AcceptOut`, `RoleDef`, `KeyOut`, `KeySummary`, `AgentConnectionOut`, `WhoAmI`, `LedgerEntryOut`,
  `WorkspaceAdminOut`, `PlatformSessionOut`; strateji: `StrategyOut`, `VersionOut`, `Sections`, `Hypothesis`,
  `Gap`, `ConsultationEntry`, `VersionSummary`; kabiliyetler: `CapabilityOut`, `Policy`, `GroupOut`, kapalı tür
  listesi `KINDS`; bütçe: `BudgetItemOut`, `BudgetSpend`, etiketli `Unit` ve `SpendSource`; bekleyen işler:
  `PendingOut`, `StrategyState` (`"missing"`, `"submitted"`, `{draft_open: {gaps}}`, `{approved: {number}}`),
  `kind` ile etiketli `WorkItem`, `AgentState`).
- Rota başına sarmalayıcılar: `auth.ts`, `workspace.ts`, `team.ts`, `roles.ts`, `apiKeys.ts`, `agents.ts`,
  `ledger.ts`, `platform.ts`, `strategy.ts`, `capabilities.ts`, `budget.ts`, `work.ts`. Sunucu bilinmeyen
  sorgu parametresini `422` ile reddettiği için liste sarmalayıcıları yalnızca bilinen parametreleri gönderir
  (`group`/`kind`/`status`/`group_id`; sayfalı listelerde `limit` + `before_at`/`before_id`); kabiliyet
  silme rotaları gövdeli `200` döner (`CapabilityOut`, `GroupOut`, `{group_id, deleted}`). Oturum çerezleri (`jt_session`, `jt_platform`) `HttpOnly`'dir; panel onları
  hiç okumaz.
- `agents.ts` ayrıca `whoami()` (`GET /api/whoami`) sunar: ajanın `jeeta.agent.whoami` ile aldığı yanıtın
  insan için ikizi; arayüz henüz kullanmıyor.
- Tek seferlik sırlar (davet jetonu, API anahtarının düz metni) yalnızca açık diyalogun durumunda
  tutulur; mutasyon önbelleğe yazılmaz (`gcTime: 0`) ve diyalog kapanınca silinir. Sır gösterilirken
  diyalog ne Escape ile ne dışına tıklanarak kapanır, köşedeki kapatma simgesi de gizlenir: yalnızca
  açık "Kapat" düğmesi kapatır (`DialogContent`'in `dismissible={false}` kipi).

## Diller (`src/i18n/`)

`tr.json` ve `en.json` aynı anahtar kümesini taşır; varsayılan dil Türkçedir (seçim `localStorage`'da
hatırlanır, `<html lang>` izler). `parity.test.ts` iki dosyayı düzleştirip anahtar kümelerinin aynı ve hiçbir
değerin boş olmadığını doğrular. `i18next.d.ts` anahtarları derleme anında Türkçe kataloğa göre denetler;
bileşenlerde sabit metin yoktur.

## Sayfalar

| Yol | Sayfa |
|---|---|
| `/login`, `/register` | giriş, kayıt (hesap + ilk çalışma alanı) |
| `/invite/:token` | daveti kabul: oturum varsa tek tık, ardından oturum katılınan çalışma alanına geçer; yoksa ad + parola ile hesap; e-posta zaten kayıtlıysa giriş bağlantısı |
| `/` | çalışma alanı kartı; `GET /api/work/pending`'den strateji kartı (yok → istişareyi başlat, taslak → eksikler, onayda → yetkiliye onay kısayolu, onaylı → sürüm), ajan kartı (son görülme, yoklama aralığı ve düzenleyici, gecikince kırmızı uyarı ve zamanlayıcının kiracıda olduğu notu), bekleyen işler listesi |
| `/strategy` | Onaylı / Taslak sekmeleri: bölümler (taslakta `team.manage` ile yerinde düzenleme), hipotez tablosu ve düzenleyicisi, istişare kaydı ("daha fazla", not ekleme), eksikler, onaya sun (reddin eksikleri), onayla (sahip/yönetici), sürüm numarası yazılarak arşivleme, sürümler çekmecesi |
| `/capabilities` | tür grubu süzgeci, kartlar (tür, ulaşım, beş durumlu rozet, son doğrulama, politika özeti, bütçe bağları, gruplar); bildir, düzenle (ad, açıklama, dış hesap kimliği; bağlayıcıda hesap değişince doğrulamanın sıfırlanacağı ve kimlik bilgilerinin silineceği uyarısı), doğrula, politika, ulaşılamıyor, bütçe bağla/çöz, emekliye ayır; gruplar paneli |
| `/budget` | kalemler (kalan sınırı aşınca kırmızı; emekliye ayrılan kalem soluk ve tarihiyle), oluşturma ve düzenleme (ad, sınır, dönem) diyalogları, onaylı emekliye ayırma, harcama çekmecesi ve harcama kaydı (emekliye ayrılan kalemde kayıt yok) |
| `/team` | üyeler, rol seçimi, çıkarma (onaylı), davet diyaloğu: tek seferlik `/invite/<token>` bağlantısı + kopyala |
| `/roles` | sistem ve özel roller; özel rol oluşturma/düzenleme (sabit izin listesi), silme |
| `/api-keys` | anahtarlar; oluşturma diyaloğu düz metni bir kez gösterir (uyarı + kopyala); iptal |
| `/agents` | bağlanan istemciler: ad, sürüm, protokol, anahtar, ilk/son görülme, araç çağrısı |
| `/ledger` | eylem filtresi, yapan rozeti (insan/ajan/sistem), açılır maskeli ayrıntı, `before_id` ile "daha fazla" |
| `/platform/login`, `/platform/workspaces` | işletmen girişi; tüm çalışma alanları, etkinleştir/askıya al |

Kabuk (`src/layout/Shell.tsx`): üstte çalışma alanı seçici (`me.memberships`; birden çok üyelik varken, ya da
üyelik olup geçerli çalışma alanı yokken görünür, böylece kullanıcı çıkmazda kalmaz), durum rozeti
(`pending_payment` → "Ödeme bekleniyor", `active` → "Etkin", `suspended` → "Askıda"), dil seçici, tema
düğmesi ve çıkış; solda menü (dar ekranda üstte yatay).

## Tasarım kiti (`src/components/ui/`)

`frontend/src/components/ui/` içindeki bileşen dosyaları (testler hariç), `cn.ts` ve `index.ts` kopyalandı;
tasarım belirteçleri `frontend/src/index.css`'ten `src/index.css`'e, tema `frontend/tailwind.config.js`'ten
`tailwind.config.js`'e alındı (yalnızca `content` yolları uyarlandı). Görsel dil değişmedi.

Uyarlamalar (kitin dışına çıkan içe aktarmalar ve sabit İngilizce etiketler):

- `LanguageSwitcher`: v1'in `@/i18n/localeMap` ve `@/i18n/localeCompleteness` bağımlılıkları yerine
  yerel `@/i18n/languages` (tr, en); düğme etiketi çevrildi.
- `ThemeToggle`: v1'in zustand tabanlı `@/store/themeStore`'u ve `@/lib/theme`'i yerine yerel
  `@/lib/theme` (aynı `useThemeStore()` biçimi, zustand yok, tercih `localStorage`'da); etiketler çevrildi.
- `Disclosure`: `marketing` ad alanı yerine varsayılan ad alanı, anahtarlar `kit.disclosure.*`.
- `Dialog`, `Sheet`, `Spinner`: sabit "Close" / "Loading" etiketleri `kit.close` / `kit.loading` oldu.
- `index.ts`: `RoleGate`/`FeatureGate` dışa aktarımı kaldırıldı, `Disclosure` eklendi.

Çıkarılan bileşenler:

| Bileşen | Neden |
|---|---|
| `access-gates.tsx` (`RoleGate`, `FeatureGate`) | v1 uygulama durumuna bağlı: `@/store/marketingAuthStore`, `@/features/marketing/types`, `useEntitlements`, `@/features/marketing/navigation`; panelde karşılığı yok (yetkiyi sunucu denetler, panel `me.memberships` izinlerine bakar). |

Bilinen sınırlar: panelin kullanmadığı kit bileşenlerinde v1'in İngilizce varsayılanları duruyor
(`Breadcrumbs`, `Pagination`, `Combobox`, `DatePicker`, `PhoneInput`, `DataTable`'ın varsayılan boş
durumu, `ConfirmDialog`/`QueryStateBoundary` varsayılan etiketleri); panel bunların hepsini prop ile
kendi metniyle geçer, ilk kullanımda çevrilmeleri gerekir. `sonner`'ın bildirim kapatma düğmesi etiketi
("Close toast") 1.7.4'te `Toaster` üzerinden değiştirilemiyor. Inter/Outfit yazı tipleri dışarıdan
yüklenmez (üçüncü taraf istek yok); `system-ui` ile çizilir. Paket `sideEffects` ile işaretlidir, böylece
kullanılmayan kit bileşenleri pakete girmez.

## Testler

- `src/i18n/parity.test.ts`: TR/EN anahtar eşitliği, boş değer yok.
- `src/api/client.test.ts`: başlık yalnızca değiştiren isteklerde, yapısal hata gövdesi, 401 yönlendirmesi,
  `whoami()`.
- `src/api/wrappers.test.ts`: liste sarmalayıcıları yalnızca bilinen sorgu parametrelerini gönderir; arşiv,
  emekliye ayırma ve kabiliyet silme rotalarının gövdeleri ve yanıtları; düzenlemeler yalnız verilen alanları
  gönderir.
- `src/pages/**/*.test.tsx`: her sayfa için sahte `fetch` ile çizim (başlık + listelerde bir satır); ana sayfada
  gecikme uyarısı ve her bekleyen işin kendi metni; strateji sayfasında eksikler, temsilci için kapalı onay,
  reddedilen gönderimin eksikleri, yazılı onaylı arşiv; kabiliyetlerde beş durum rozeti, `group` süzgeci,
  yalnız değişeni gönderen düzenleme ve bağlayıcı hesabı uyarısı; bütçede sınır aşımı, küçük birimle harcama
  kaydı, düzenleme, onaylı emekliye ayırma ve soluk gösterilen emekliye ayrılmış kalem;
  API anahtarı düz metninin bir kez gösterilmesi, davet bağlantısı, ikisinin yalnız "Kapat" ile kapanması;
  oturum açıkken kabul edilen davetin ardından çalışma alanı geçişi.
- `src/layout/Shell.test.tsx`: menü, varsayılan dil, oturumsuz ziyaretçinin giriş sayfasına gönderilmesi,
  geçerli çalışma alanı yokken seçicinin görünmesi.
- `src/lib/errors.test.ts`: hata kodlarının panel metnine çevrilmesi.
