import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Menu, X, ArrowRight } from 'lucide-react';
import { cn } from '../../components/ui/cn';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import { Btn, LangToggle, SHELL, useScrolled } from './landingShared';

function Brand({ dark }: { dark: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-2.5" aria-label="Jeeta">
      <img src="/logo.png" alt="" className="h-9 w-9 rounded-xl object-cover shadow-sm ring-1 ring-black/5" />
      <span className={cn('font-display text-xl font-bold tracking-tight', dark ? 'text-white' : 'text-slate-900')}>
        Jeeta
      </span>
    </Link>
  );
}

export default function LandingNav() {
  const { t } = useTranslation('marketing');
  const scrolled = useScrolled(16);
  const [open, setOpen] = useState(false);
  const isAuthenticated = useMarketingAuthStore((s) => s.isAuthenticated);

  const links = [
    { href: '#features', label: t('landing.nav.features') },
    { href: '#how', label: t('landing.nav.how') },
    { href: '#faq', label: t('landing.nav.faq') },
  ];

  // At the very top the nav floats transparently over the dark hero; once
  // scrolled it turns into a solid, light, blurred bar.
  const onDark = !scrolled;

  return (
    <header
      className={cn(
        'fixed inset-x-0 top-0 z-50 transition-all duration-300 ease-standard',
        scrolled
          ? 'border-b border-slate-200/80 bg-white/85 backdrop-blur-md'
          : 'border-b border-transparent bg-transparent',
      )}
    >
      <nav className={cn(SHELL, 'flex h-16 items-center justify-between sm:h-[4.5rem]')}>
        <Brand dark={onDark} />

        {/* Center links */}
        <div className="hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className={cn(
                'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                onDark ? 'text-slate-200 hover:bg-white/10 hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
              )}
            >
              {l.label}
            </a>
          ))}
        </div>

        {/* Right cluster */}
        <div className="flex items-center gap-2 sm:gap-3">
          <LangToggle tone={onDark ? 'dark' : 'light'} className="hidden sm:inline-flex" />

          {isAuthenticated ? (
            <Btn to="/dashboard" variant="primary" size="sm" className="hidden sm:inline-flex">
              {t('landing.nav.openApp')}
              <ArrowRight className="h-4 w-4" />
            </Btn>
          ) : (
            <>
              <Btn to="/login" variant={onDark ? 'ghostDark' : 'ghostLight'} size="sm" className="hidden sm:inline-flex">
                {t('landing.nav.login')}
              </Btn>
              <Btn to="/register" variant="primary" size="sm" className="hidden sm:inline-flex">
                {t('landing.nav.getStarted')}
              </Btn>
            </>
          )}

          {/* Mobile menu toggle */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={t('landing.nav.menu')}
            aria-expanded={open}
            aria-controls="landing-mobile-menu"
            className={cn(
              'inline-flex h-10 w-10 items-center justify-center rounded-lg transition-colors md:hidden',
              onDark ? 'text-white hover:bg-white/10' : 'text-slate-700 hover:bg-slate-100',
            )}
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </nav>

      {/* Mobile panel */}
      {open && (
        <div id="landing-mobile-menu" className="mx-3 mb-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-xl md:hidden">
          <div className="flex flex-col">
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                {l.label}
              </a>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
            <LangToggle tone="light" />
            {isAuthenticated ? (
              <Btn to="/dashboard" variant="primary" size="sm" onClick={() => setOpen(false)}>
                {t('landing.nav.openApp')}
                <ArrowRight className="h-4 w-4" />
              </Btn>
            ) : (
              <div className="flex items-center gap-2">
                <Btn to="/login" variant="ghostLight" size="sm" onClick={() => setOpen(false)}>
                  {t('landing.nav.login')}
                </Btn>
                <Btn to="/register" variant="primary" size="sm" onClick={() => setOpen(false)}>
                  {t('landing.nav.getStarted')}
                </Btn>
              </div>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
