import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { LangToggle, SHELL } from './landingShared';

export default function LandingFooter() {
  const { t } = useTranslation('marketing');
  const year = new Date().getFullYear();

  const columns: Array<{ title: string; links: Array<{ label: string; href?: string; to?: string }> }> = [
    {
      title: t('landing.footer.productCol'),
      links: [
        { label: t('landing.footer.linkFeatures'), href: '/#features' },
        { label: t('landing.footer.linkHow'), href: '/#how' },
        { label: t('landing.footer.linkFaq'), href: '/#faq' },
      ],
    },
    {
      title: t('landing.footer.companyCol'),
      links: [
        { label: t('landing.footer.linkLogin'), to: '/login' },
        { label: t('landing.footer.linkRegister'), to: '/register' },
      ],
    },
    {
      title: t('landing.footer.legalCol'),
      links: [
        { label: t('landing.footer.linkPrivacy'), to: '/privacy' },
        { label: t('landing.footer.linkTerms'), to: '/terms' },
      ],
    },
  ];

  const linkCls = 'text-sm text-slate-400 transition-colors hover:text-white';

  return (
    <footer className="bg-[#0a0e1f] text-slate-300">
      <div className={`${SHELL} py-14`}>
        <div className="grid gap-10 md:grid-cols-[1.4fr_2fr]">
          {/* Brand */}
          <div>
            <Link to="/" className="flex items-center gap-2.5" aria-label="Jeeta">
              <img src="/logo-mark.png" alt="" className="h-9 w-9 rounded-xl object-cover ring-1 ring-white/10" />
              <span className="font-display text-xl font-bold tracking-tight text-white">Jeeta</span>
            </Link>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-slate-400">
              {t('landing.footer.tagline')}
            </p>
            <div className="mt-5">
              <LangToggle tone="dark" />
            </div>
          </div>

          {/* Link columns */}
          <nav aria-label={t('landing.footer.navLabel')} className="grid grid-cols-2 gap-8 sm:grid-cols-3">
            {columns.map((col) => (
              <div key={col.title}>
                <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{col.title}</h3>
                <ul className="mt-4 space-y-3">
                  {col.links.map((l) => (
                    <li key={l.label}>
                      {l.to ? (
                        <Link to={l.to} className={linkCls}>
                          {l.label}
                        </Link>
                      ) : (
                        <a href={l.href} className={linkCls}>
                          {l.label}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-white/10 pt-6 sm:flex-row">
          <p className="text-sm text-slate-500">© {year} Jeeta. {t('landing.footer.rights')}</p>
          <p className="text-sm text-slate-500">{t('landing.footer.madeIn')}</p>
        </div>
      </div>
    </footer>
  );
}
