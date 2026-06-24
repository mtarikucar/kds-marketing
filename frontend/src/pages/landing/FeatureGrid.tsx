import { useTranslation } from 'react-i18next';
import type { LucideIcon } from 'lucide-react';
import {
  Users,
  Inbox,
  Megaphone,
  Workflow,
  LayoutTemplate,
  CalendarClock,
  PhoneCall,
  CreditCard,
  BarChart3,
  Sparkles,
  GraduationCap,
  Star,
  Gift,
  Building2,
  ShieldCheck,
  Code2,
} from 'lucide-react';
import { Eyebrow, Reveal, SHELL } from './landingShared';

interface Feature {
  key: string;
  icon: LucideIcon;
}

const FEATURES: Feature[] = [
  { key: 'crm', icon: Users },
  { key: 'inbox', icon: Inbox },
  { key: 'campaigns', icon: Megaphone },
  { key: 'automation', icon: Workflow },
  { key: 'funnels', icon: LayoutTemplate },
  { key: 'social', icon: CalendarClock },
  { key: 'voice', icon: PhoneCall },
  { key: 'billing', icon: CreditCard },
];

const MORE: Array<{ key: string; icon: LucideIcon }> = [
  { key: 'analytics', icon: BarChart3 },
  { key: 'ai', icon: Sparkles },
  { key: 'memberships', icon: GraduationCap },
  { key: 'reviews', icon: Star },
  { key: 'affiliate', icon: Gift },
  { key: 'agency', icon: Building2 },
  { key: 'security', icon: ShieldCheck },
  { key: 'api', icon: Code2 },
];

export default function FeatureGrid() {
  const { t } = useTranslation('marketing');

  return (
    <section id="features" className="scroll-mt-24 bg-white py-20 sm:py-28">
      <div className={SHELL}>
        <Reveal className="mx-auto max-w-2xl text-center">
          <Eyebrow>{t('landing.nav.features')}</Eyebrow>
          <h2 className="mt-4 font-display text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            {t('landing.features.title')}
          </h2>
          <p className="mt-4 text-lg text-slate-500">{t('landing.features.subtitle')}</p>
        </Reveal>

        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f, i) => {
            const Icon = f.icon;
            return (
              <Reveal key={f.key} delay={(i % 4) * 70}>
                <div className="group h-full rounded-2xl border border-slate-200 bg-white p-6 transition-all duration-300 hover:-translate-y-1 hover:border-primary-200 hover:shadow-xl hover:shadow-primary-600/5">
                  <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary-50 text-primary-600 ring-1 ring-inset ring-primary-100 transition-colors duration-300 group-hover:bg-primary-600 group-hover:text-white">
                    <Icon className="h-6 w-6" />
                  </span>
                  <h3 className="mt-5 font-display text-lg font-semibold text-slate-900">
                    {t(`landing.features.${f.key}Title`)}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-500">
                    {t(`landing.features.${f.key}Desc`)}
                  </p>
                </div>
              </Reveal>
            );
          })}
        </div>

        {/* And more */}
        <Reveal className="mt-14 text-center" delay={80}>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
            {t('landing.more.title')}
          </p>
          <div className="mx-auto mt-5 flex max-w-4xl flex-wrap items-center justify-center gap-2.5">
            {MORE.map((m) => {
              const Icon = m.icon;
              return (
                <span
                  key={m.key}
                  className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:border-primary-200 hover:bg-primary-50 hover:text-primary-700"
                >
                  <Icon className="h-4 w-4 text-primary-500" />
                  {t(`landing.more.${m.key}`)}
                </span>
              );
            })}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
