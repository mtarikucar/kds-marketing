import { useTranslation } from 'react-i18next';
import { Sparkles, ArrowRight, Check } from 'lucide-react';
import { Btn, SHELL } from './landingShared';
import ProductMock from './ProductMock';

/** Staggered CSS load-in for above-the-fold hero elements. */
function load(delayMs: number): React.CSSProperties {
  return { animationDelay: `${delayMs}ms`, animationFillMode: 'both' };
}

export default function Hero() {
  const { t } = useTranslation('marketing');

  const stats: Array<{ value: string; label: string }> = [
    { value: t('landing.stats.modules'), label: t('landing.stats.modulesLabel') },
    { value: t('landing.stats.channels'), label: t('landing.stats.channelsLabel') },
    { value: t('landing.stats.languages'), label: t('landing.stats.languagesLabel') },
    { value: t('landing.stats.workspace'), label: t('landing.stats.workspaceLabel') },
  ];

  return (
    <section className="relative overflow-hidden bg-[#0a0e1f] pb-16 pt-28 sm:pt-36 lg:pb-24">
      {/* ── Background atmosphere ─────────────────────────────────────────── */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {/* base vertical gradient */}
        <div className="absolute inset-0 bg-gradient-to-b from-[#0a0e1f] via-[#0b1024] to-[#0d1430]" />
        {/* indigo glow top-left */}
        <div className="absolute -left-40 -top-40 h-[36rem] w-[36rem] rounded-full bg-primary-600/25 blur-[120px]" />
        {/* violet glow right */}
        <div className="absolute -right-32 top-10 h-[32rem] w-[32rem] rounded-full bg-violet-600/20 blur-[120px]" />
        {/* fine grid, fading out toward the bottom */}
        <div
          className="absolute inset-0 opacity-[0.18] [mask-image:radial-gradient(ellipse_at_top,black,transparent_72%)]"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.08) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
          }}
        />
      </div>

      {/* ── Content ───────────────────────────────────────────────────────── */}
      <div className={`${SHELL} relative`}>
        <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10">
          {/* Copy */}
          <div className="text-center lg:text-left">
            <span
              className="inline-flex animate-slide-up items-center gap-2 rounded-full bg-white/5 px-3.5 py-1.5 text-xs font-medium text-indigo-200 ring-1 ring-inset ring-white/10 motion-reduce:animate-none"
              style={load(0)}
            >
              <Sparkles className="h-3.5 w-3.5 text-indigo-300" />
              {t('landing.hero.badge')}
            </span>

            <h1
              className="mt-6 animate-slide-up font-display text-4xl font-bold leading-[1.05] tracking-tight text-white motion-reduce:animate-none sm:text-5xl lg:text-6xl"
              style={load(80)}
            >
              {t('landing.hero.titleLead')}{' '}
              <span className="bg-gradient-to-r from-indigo-300 via-primary-400 to-violet-300 bg-clip-text text-transparent">
                {t('landing.hero.titleAccent')}
              </span>
            </h1>

            <p
              className="mx-auto mt-5 max-w-xl animate-slide-up text-lg leading-relaxed text-slate-300 motion-reduce:animate-none lg:mx-0"
              style={load(160)}
            >
              {t('landing.hero.subtitle')}
            </p>

            <div
              className="mt-8 flex animate-slide-up flex-col items-center gap-3 motion-reduce:animate-none sm:flex-row sm:justify-center lg:justify-start"
              style={load(240)}
            >
              <Btn to="/register" variant="primary" size="lg" className="w-full sm:w-auto">
                {t('landing.hero.ctaPrimary')}
                <ArrowRight className="h-4 w-4" />
              </Btn>
              <Btn href="#features" variant="glass" size="lg" className="w-full sm:w-auto">
                {t('landing.hero.ctaSecondary')}
              </Btn>
            </div>

            <p
              className="mt-6 flex animate-slide-up flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-sm text-slate-400 motion-reduce:animate-none lg:justify-start"
              style={load(320)}
            >
              {t('landing.hero.trust')
                .split(' · ')
                .map((part) => (
                  <span key={part} className="inline-flex items-center gap-1.5">
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                    {part}
                  </span>
                ))}
            </p>
          </div>

          {/* Product visual */}
          <div className="animate-scale-in motion-reduce:animate-none lg:[transform:perspective(1600px)_rotateY(-8deg)_rotateX(2deg)]" style={load(360)}>
            <ProductMock />
          </div>
        </div>

        {/* Stat strip */}
        <div className="mt-16 grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-white/10 ring-1 ring-white/10 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="bg-[#0b1024]/60 px-5 py-5 text-center backdrop-blur-sm sm:py-6">
              <div className="font-display text-2xl font-bold text-white sm:text-3xl">{s.value}</div>
              <div className="mt-1 text-xs font-medium text-slate-400">{s.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
