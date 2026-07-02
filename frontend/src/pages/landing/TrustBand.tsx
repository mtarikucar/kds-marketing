import { useTranslation } from 'react-i18next';
import type { LucideIcon } from 'lucide-react';
import { ShieldCheck, KeyRound, Lock, ScrollText } from 'lucide-react';
import { Eyebrow, Reveal, SHELL } from './landingShared';

/**
 * Trust / security-and-compliance band. Uses ONLY real product facts (2FA,
 * role-based access, KVKK/GDPR tooling, encryption) — no fabricated customer
 * logos or testimonials. Sits between the deep-dive Highlights and the FAQ to
 * add a credibility beat before the final CTA.
 */
const ITEMS: { key: string; icon: LucideIcon }[] = [
  { key: 'compliance', icon: ShieldCheck },
  { key: 'auth', icon: KeyRound },
  { key: 'encryption', icon: Lock },
  { key: 'audit', icon: ScrollText },
];

export default function TrustBand() {
  const { t } = useTranslation('marketing');

  return (
    <section className="bg-slate-50 py-16 sm:py-20">
      <div className={SHELL}>
        <Reveal className="mx-auto max-w-2xl text-center">
          <Eyebrow>{t('landing.trust.eyebrow', 'Security & compliance')}</Eyebrow>
          <h2 className="mt-4 font-display text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            {t('landing.trust.title', 'Trust built in, from day one')}
          </h2>
        </Reveal>
        <div className="mx-auto mt-10 grid max-w-4xl gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {ITEMS.map((it, i) => {
            const Icon = it.icon;
            return (
              <Reveal key={it.key} delay={(i % 4) * 70}>
                <div className="flex h-full flex-col items-center rounded-2xl border border-slate-200 bg-white p-6 text-center">
                  <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-primary-50 text-primary-600 ring-1 ring-inset ring-primary-100">
                    <Icon className="h-5 w-5" />
                  </span>
                  <h3 className="mt-4 font-display text-base font-semibold text-slate-900">
                    {t(`landing.trust.${it.key}Title`)}
                  </h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-500">
                    {t(`landing.trust.${it.key}Desc`)}
                  </p>
                </div>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
