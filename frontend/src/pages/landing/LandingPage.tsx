import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import LandingNav from './LandingNav';
import Hero from './Hero';
import FeatureGrid from './FeatureGrid';
import HowItWorks from './HowItWorks';
import Highlights from './Highlights';
import FaqSection from './FaqSection';
import FinalCta from './FinalCta';
import LandingFooter from './LandingFooter';
import { usePrefersReducedMotion } from './landingShared';

/**
 * Public marketing home for Jeeta, served at `/`. Theme-independent (always its
 * own light/dark palette regardless of the console's dark-mode setting) and
 * bilingual via the existing i18n `landing.*` keys (TR/EN toggle in the nav).
 */
export default function LandingPage() {
  const { t, i18n } = useTranslation('marketing');
  const reduced = usePrefersReducedMotion();

  // Brand the tab from the active locale.
  useEffect(() => {
    document.title = `Jeeta — ${t('landing.hero.titleLead')} ${t('landing.hero.titleAccent')}`;
  }, [t, i18n.language]);

  // Smooth in-page anchor scrolling (respecting reduced-motion).
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
        {t('landing.a11y.skipToContent')}
      </a>
      <LandingNav />
      <main id="main" tabIndex={-1} className="outline-none">
        <Hero />
        <FeatureGrid />
        <HowItWorks />
        <Highlights />
        <FaqSection />
        <FinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}
