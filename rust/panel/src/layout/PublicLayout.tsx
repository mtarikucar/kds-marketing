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
      <main id="main-content" tabIndex={-1} className="mx-auto grid w-full max-w-[1280px] flex-1 items-center gap-12 px-6 pb-10 lg:grid-cols-[1.1fr_1fr] lg:gap-20 lg:px-10 lg:py-12">
        <section className="relative hidden min-h-[600px] self-stretch overflow-hidden rounded-lg bg-brand-navy text-brand-navy-foreground lg:flex lg:flex-col">
          <div className="relative z-10 px-10 pt-10 xl:px-12 xl:pt-12">
            <h2 className="max-w-[16ch] text-[clamp(2.5rem,3.5vw,3.25rem)] font-normal leading-[1.08] tracking-[-0.03em]">{t('publicIntro.title')}</h2>
            <p className="mt-5 max-w-[38ch] text-base leading-7 text-brand-navy-foreground/75">{t('publicIntro.description')}</p>
          </div>
          <picture className="mt-8 flex min-h-0 flex-1 items-end justify-center px-7">
            <source media="(min-width: 1024px)" srcSet="/brand/jeeta-welcome-560.webp 560w, /brand/jeeta-welcome-840.webp 840w" sizes="440px" type="image/webp" />
            <img
              src="/brand/jeeta-mark.png"
              alt=""
              width="1214"
              height="1295"
              className="block max-h-[460px] w-full max-w-[440px] object-contain object-bottom"
              decoding="async"
            />
          </picture>
        </section>
        <div className="mx-auto w-full max-w-[390px] py-10 lg:py-12">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
