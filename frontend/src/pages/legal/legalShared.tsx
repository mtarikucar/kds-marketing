import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight } from 'lucide-react';
import { usePrefersReducedMotion, SHELL } from '../landing/landingShared';
import LandingNav from '../landing/LandingNav';
import LandingFooter from '../landing/LandingFooter';

/**
 * Company / legal identity used across the Privacy Policy and Terms of Service.
 * Confirmed by the operator (2026-06-24). Update here to keep both documents in sync.
 */
export const LEGAL = {
  brand: 'Jeeta',
  entity: 'Jeeta',
  email: 'admin@hummytummy.com',
  city: 'Ankara',
  countryTr: 'Türkiye',
  countryEn: 'Türkiye',
  /** Courts / governing law seat. */
  jurisdiction: 'Ankara',
  effectiveDateTr: '24 Haziran 2026',
  effectiveDateEn: 'June 24, 2026',
} as const;

export interface LegalSection {
  id: string;
  heading: string;
  body?: string[];
  items?: string[];
}

export interface LegalDoc {
  title: string;
  subtitle: string;
  lastUpdatedLabel: string;
  effectiveDate: string;
  tocLabel: string;
  intro: string[];
  sections: LegalSection[];
}

export interface LegalContent {
  tr: LegalDoc;
  en: LegalDoc;
}

/** Pick the right locale variant (landing ships TR/EN; anything else → EN). */
function pickLang(lng: string): 'tr' | 'en' {
  return (lng || 'tr').slice(0, 2) === 'tr' ? 'tr' : 'en';
}

/**
 * Shared chrome + reader layout for the legal pages. Reuses the landing nav
 * (forced solid, section anchors hidden) and footer for brand consistency, and
 * renders the document as an accessible article with a sticky table of contents.
 */
export function LegalLayout({ content }: { content: LegalContent }) {
  const { t, i18n } = useTranslation('marketing');
  const doc = content[pickLang(i18n.language)];
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    document.title = `${doc.title} — Jeeta`;
  }, [doc.title]);

  useEffect(() => {
    if (reduced) return;
    const html = document.documentElement;
    const prev = html.style.scrollBehavior;
    html.style.scrollBehavior = 'smooth';
    return () => {
      html.style.scrollBehavior = prev;
    };
  }, [reduced]);

  return (
    <div className="min-h-screen bg-white font-sans text-slate-900 antialiased selection:bg-primary-600 selection:text-white">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-primary-600 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white focus:shadow-lg"
      >
        {/* Reuse the landing skip label. */}
        {t('landing.a11y.skipToContent')}
      </a>

      <LandingNav solid showSectionLinks={false} />

      <main id="main" tabIndex={-1} className="outline-none">
        {/* Header band */}
        <header className="border-b border-slate-200 bg-slate-50 pb-10 pt-28 sm:pt-32">
          <div className={SHELL}>
            <h1 className="font-display text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
              {doc.title}
            </h1>
            <p className="mt-3 max-w-2xl text-lg text-slate-500">{doc.subtitle}</p>
            <p className="mt-4 text-sm font-medium text-slate-400">
              {doc.lastUpdatedLabel}: {doc.effectiveDate}
            </p>
          </div>
        </header>

        <div className={`${SHELL} py-12 sm:py-16`}>
          <div className="grid gap-10 lg:grid-cols-[260px_1fr] lg:gap-16">
            {/* Table of contents */}
            <aside className="lg:sticky lg:top-28 lg:self-start">
              <nav aria-label={doc.tocLabel}>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">{doc.tocLabel}</p>
                <ol className="mt-4 space-y-2 border-l border-slate-200">
                  {doc.sections.map((s, i) => (
                    <li key={s.id}>
                      <a
                        href={`#${s.id}`}
                        className="-ml-px flex gap-2 border-l-2 border-transparent py-1 pl-4 text-sm text-slate-500 transition-colors hover:border-primary-500 hover:text-primary-700"
                      >
                        <span className="tabular-nums text-slate-400">{String(i + 1).padStart(2, '0')}</span>
                        <span>{s.heading}</span>
                      </a>
                    </li>
                  ))}
                </ol>
              </nav>
            </aside>

            {/* Document body */}
            <article className="max-w-3xl">
              {doc.intro.map((p, i) => (
                <p key={i} className="mb-4 text-[15px] leading-relaxed text-slate-600">
                  {p}
                </p>
              ))}

              {doc.sections.map((s, i) => (
                <section key={s.id} id={s.id} className="scroll-mt-28 pt-8">
                  <h2 className="font-display text-xl font-semibold text-slate-900 sm:text-2xl">
                    <span className="mr-2 text-primary-500">{String(i + 1).padStart(2, '0')}.</span>
                    {s.heading}
                  </h2>
                  {s.body?.map((p, j) => (
                    <p key={j} className="mt-4 text-[15px] leading-relaxed text-slate-600">
                      {p}
                    </p>
                  ))}
                  {s.items && (
                    <ul className="mt-4 space-y-2">
                      {s.items.map((it, j) => (
                        <li key={j} className="flex gap-3 text-[15px] leading-relaxed text-slate-600">
                          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary-400" />
                          <span>{it}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}

              {/* Contact card */}
              <div className="mt-12 rounded-2xl border border-slate-200 bg-slate-50 p-6">
                <p className="text-[15px] text-slate-600">
                  {pickLang(i18n.language) === 'tr'
                    ? 'Bu belge hakkında sorularınız için bize ulaşın:'
                    : 'For questions about this document, contact us:'}
                </p>
                <a
                  href={`mailto:${LEGAL.email}`}
                  className="mt-2 inline-flex items-center gap-1.5 font-semibold text-primary-700 hover:text-primary-600"
                >
                  {LEGAL.email}
                  <ArrowUpRight className="h-4 w-4" />
                </a>
              </div>
            </article>
          </div>
        </div>
      </main>

      <LandingFooter />
    </div>
  );
}
