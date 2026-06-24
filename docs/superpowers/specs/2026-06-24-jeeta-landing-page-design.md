# Jeeta — Tanıtım Anasayfası (Landing Page) · Tasarım

**Tarih:** 2026-06-24
**Durum:** Onaylandı (brainstorming → implementation)

## Amaç
Projeye public bir tanıtım anasayfası kazandırmak. Bugün `/` doğrudan `/dashboard`'a
(korumalı) yönleniyor; public bir tanıtım yüzeyi yok. Ziyaretçiyi ürünle tanıştıran,
kayıt/giriş'e yönlendiren tek-sayfa kaydırmalı landing.

## Kararlar (kullanıcı onayı)
- **Marka:** **Jeeta** (sistemin adı).
- **Dil:** Türkçe + İngilizce — üstte TR/EN geçişi (mevcut i18n `changeLanguage`).
- **Yerleşim:** Public `/` rotası. Nav CTA auth-duyarlı (girişliyse "Panele git").
- **Görsel ton:** Modern SaaS — koyu lacivert hero + indigo aksan; mevcut Console
  tasarım diliyle tutarlı (Outfit display + Inter body, indigo `primary` ramp).

## Mimari
- `frontend/src/pages/landing/` altında bölüm bileşenleri:
  `LandingPage.tsx` (orkestratör), `LandingNav.tsx`, `Hero.tsx`, `ProductMock.tsx`,
  `FeatureGrid.tsx`, `HowItWorks.tsx`, `Highlights.tsx`, `FaqSection.tsx`,
  `FinalCta.tsx`, `LandingFooter.tsx`, `landingShared.tsx` (Btn, Reveal, LangToggle).
- İçerik metni i18n'de (`tr/marketing.json` + `en/marketing.json` → `landing.*`);
  ikon/yapı kodda. SSS için Radix `Accordion` yeniden kullanılır.
- **Tema-bağımsız renkler:** landing, app dark/light ayarından etkilenmesin diye
  explicit indigo (`primary-600/700/50`) + `slate` + `white` kullanır; `bg-background`
  gibi tema token'ları landing'de kullanılmaz.

## Routing
- `App.tsx`: `/` public landing olur (login/register ile aynı public blokta).
  Korumalı bloktaki `/`→`/dashboard` yönlendirmesi kaldırılır. Catch-all `*` aynı kalır.
- `index.html`: title→"Jeeta…", `robots`→`index,follow`, meta description eklenir.

## Sayfa kurgusu
1. Sticky Nav (logo+Jeeta, bölüm linkleri, TR/EN toggle, auth-duyarlı CTA)
2. Hero (koyu) + stat şeridi + stilize ürün mockup'ı
3. Özellik gridi (8 kart) + "ve dahası" rozetleri
4. Nasıl çalışır (3 adım)
5. Öne çıkan 2 dönüşümlü blok (Inbox, Otomasyon)
6. SSS (accordion)
7. Final CTA bandı (koyu)
8. Footer (koyu)

## Erişilebilirlik / kalite
- Semantik landmark'lar, focus ring'leri, alt metinler, `prefers-reduced-motion`
  saygılı IntersectionObserver scroll-reveal. Responsive (mobil tek kolon).
- Yeni bağımlılık yok. Mevcut UI primitive'leri (Accordion) ve lucide ikonları.
