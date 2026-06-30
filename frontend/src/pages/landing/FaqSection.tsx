import { useTranslation } from 'react-i18next';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '../../components/ui/Accordion';
import { Eyebrow, Reveal, SHELL } from './landingShared';

const ITEMS = ['1', '2', '3', '4', '5'];

export default function FaqSection() {
  const { t } = useTranslation('marketing');

  return (
    <section id="faq" className="scroll-mt-24 bg-slate-50 py-20 sm:py-28">
      <div className={`${SHELL} max-w-3xl`}>
        <Reveal className="text-center">
          <Eyebrow>{t('landing.nav.faq')}</Eyebrow>
          <h2 className="mt-4 font-display text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            {t('landing.faq.title')}
          </h2>
        </Reveal>

        <Reveal delay={80} className="mt-10">
          <div className="rounded-2xl border border-slate-200 bg-white px-6 shadow-sm">
            <Accordion type="single" collapsible>
              {ITEMS.map((n) => (
                <AccordionItem key={n} value={`faq-${n}`}>
                  <AccordionTrigger className="text-left text-base text-slate-900">
                    {t(`landing.faq.q${n}`)}
                  </AccordionTrigger>
                  <AccordionContent className="text-[15px] leading-relaxed text-slate-500">
                    {t(`landing.faq.a${n}`)}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
