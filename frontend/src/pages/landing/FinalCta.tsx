import { useTranslation } from 'react-i18next';
import { ArrowRight } from 'lucide-react';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import { Btn, Reveal, SHELL } from './landingShared';

export default function FinalCta() {
  const { t } = useTranslation('marketing');
  const isAuthenticated = useMarketingAuthStore((s) => s.isAuthenticated);

  return (
    <section className="bg-white py-20 sm:py-24">
      <div className={SHELL}>
        <Reveal>
          <div className="relative overflow-hidden rounded-3xl bg-[#0a0e1f] px-6 py-16 text-center sm:px-12 sm:py-20">
            {/* glow */}
            <div aria-hidden className="pointer-events-none absolute inset-0">
              <div className="absolute left-1/2 top-0 h-72 w-72 -translate-x-1/2 rounded-full bg-primary-600/30 blur-[100px]" />
              <div className="absolute bottom-0 right-10 h-56 w-56 rounded-full bg-violet-600/20 blur-[100px]" />
            </div>

            <div className="relative">
              <h2 className="mx-auto max-w-2xl font-display text-3xl font-bold tracking-tight text-white sm:text-4xl">
                {t('landing.finalCta.title')}
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-lg text-slate-300">{t('landing.finalCta.subtitle')}</p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <Btn to={isAuthenticated ? '/dashboard' : '/register'} variant="primary" size="lg" className="w-full sm:w-auto">
                  {isAuthenticated ? t('landing.nav.openApp') : t('landing.finalCta.cta')}
                  <ArrowRight className="h-4 w-4" />
                </Btn>
                {!isAuthenticated && (
                  <Btn to="/login" variant="glass" size="lg" className="w-full sm:w-auto">
                    {t('landing.nav.login')}
                  </Btn>
                )}
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
