import { useTranslation } from 'react-i18next';
import type { LucideIcon } from 'lucide-react';
import { UserPlus, Link2, Rocket } from 'lucide-react';
import { Eyebrow, Reveal, SHELL } from './landingShared';

const STEPS: Array<{ key: string; icon: LucideIcon }> = [
  { key: 'step1', icon: UserPlus },
  { key: 'step2', icon: Link2 },
  { key: 'step3', icon: Rocket },
];

export default function HowItWorks() {
  const { t } = useTranslation('marketing');

  return (
    <section id="how" className="scroll-mt-24 bg-slate-50 py-20 sm:py-28">
      <div className={SHELL}>
        <Reveal className="mx-auto max-w-2xl text-center">
          <Eyebrow>{t('landing.nav.how')}</Eyebrow>
          <h2 className="mt-4 font-display text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            {t('landing.how.title')}
          </h2>
          <p className="mt-4 text-lg text-slate-500">{t('landing.how.subtitle')}</p>
        </Reveal>

        <div className="relative mt-16 grid gap-10 sm:grid-cols-3 sm:gap-6">
          {/* connecting line (sm+) */}
          <div
            aria-hidden
            className="absolute left-[16.66%] right-[16.66%] top-8 hidden border-t-2 border-dashed border-slate-200 sm:block"
          />

          {STEPS.map((s, i) => {
            const Icon = s.icon;
            return (
              <Reveal key={s.key} delay={i * 110} className="relative text-center">
                <div className="relative mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-white text-primary-600 shadow-lg shadow-primary-600/10 ring-1 ring-slate-200">
                  <Icon className="h-7 w-7" />
                  <span className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-primary-600 text-[11px] font-bold text-white shadow-sm">
                    {i + 1}
                  </span>
                </div>
                <h3 className="mt-5 font-display text-xl font-semibold text-slate-900">
                  {t(`landing.how.${s.key}Title`)}
                </h3>
                <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-slate-500">
                  {t(`landing.how.${s.key}Desc`)}
                </p>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
