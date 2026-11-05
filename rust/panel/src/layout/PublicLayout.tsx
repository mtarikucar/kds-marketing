import { Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher, ThemeToggle } from '@/components/ui';
import { Brand } from './Brand';

/** Public account screens share a quiet product introduction and a focused form. */
export function PublicLayout() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-20 shrink-0 items-center justify-between px-6 sm:px-10">
        <Brand />
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto grid w-full max-w-[1280px] flex-1 items-center gap-12 px-6 pb-10 lg:grid-cols-[1.1fr_1fr] lg:gap-20 lg:px-10 lg:py-12">
        <section className="hidden self-stretch rounded-2xl bg-brand-navy px-10 py-12 text-brand-navy-foreground lg:flex lg:flex-col lg:justify-between xl:px-14">
          <div>
            <div className="mb-12 h-1 w-10 rounded-full bg-brand-accent" />
            <h2 className="max-w-[10ch] text-[clamp(2.75rem,4vw,4.25rem)] font-semibold leading-[1.08] tracking-[-0.045em]">{t('publicIntro.title')}</h2>
            <p className="mt-7 max-w-sm text-base leading-7 text-brand-navy-foreground/75">{t('publicIntro.description')}</p>
          </div>
          <div className="mt-16 space-y-6">
            {(['people', 'work', 'results'] as const).map((item) => (
              <div key={item} className="border-t border-white/20 pt-4">
                <h2 className="text-sm font-medium">{t(`publicIntro.${item}.title`)}</h2>
                <p className="mt-1 text-sm leading-6 text-brand-navy-foreground/65">{t(`publicIntro.${item}.description`)}</p>
              </div>
            ))}
          </div>
        </section>
        <div className="mx-auto w-full max-w-[390px] py-10 lg:py-12">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
