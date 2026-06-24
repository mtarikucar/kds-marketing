import { useTranslation } from 'react-i18next';
import { Check, Zap, GitBranch, Send, MessageSquare } from 'lucide-react';
import { cn } from '../../components/ui/cn';
import { Eyebrow, Reveal, SHELL } from './landingShared';

/** Mini conversation panel for the Inbox highlight. */
function InboxVisual() {
  const { t } = useTranslation('marketing');
  return (
    <div className="relative rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
      <div className="mb-3 flex items-center gap-2 border-b border-slate-100 pb-3">
        <div className="h-8 w-8 rounded-full bg-gradient-to-br from-emerald-400 to-teal-500" />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900">{t('landing.mock.row1Name')}</div>
          <div className="flex items-center gap-1 text-[11px] text-emerald-600">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> {t('landing.mock.inboxStatus')}
          </div>
        </div>
        <span className="ml-auto rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
          {t('landing.mock.inboxAssigned')}
        </span>
      </div>
      <div className="space-y-2.5">
        <div className="max-w-[78%] rounded-2xl rounded-tl-sm bg-slate-100 px-3.5 py-2 text-[13px] text-slate-700">
          {t('landing.mock.bubble1')}
        </div>
        <div className="ml-auto max-w-[78%] rounded-2xl rounded-tr-sm bg-primary-600 px-3.5 py-2 text-[13px] text-white">
          {t('landing.mock.bubble2')}
        </div>
        <div className="max-w-[78%] rounded-2xl rounded-tl-sm bg-slate-100 px-3.5 py-2 text-[13px] text-slate-700">
          {t('landing.mock.bubble3')}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-[13px] text-slate-400">
        {t('landing.mock.replyPlaceholder')}
        <span className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg bg-primary-600 text-white">
          <Send className="h-3.5 w-3.5" />
        </span>
      </div>
    </div>
  );
}

/** Mini trigger→condition→action flow for the Automation highlight. */
function AutomationVisual() {
  const { t } = useTranslation('marketing');
  const nodes = [
    { icon: Zap, label: t('landing.mock.trigger'), sub: t('landing.mock.triggerSub'), tone: 'text-amber-600 bg-amber-50 ring-amber-100' },
    { icon: GitBranch, label: t('landing.mock.condition'), sub: t('landing.mock.conditionSub'), tone: 'text-violet-600 bg-violet-50 ring-violet-100' },
    { icon: MessageSquare, label: t('landing.mock.action'), sub: t('landing.mock.actionSub'), tone: 'text-emerald-600 bg-emerald-50 ring-emerald-100' },
  ];
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-900">{t('landing.mock.flowTitle')}</span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-600">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> {t('landing.mock.flowActive')}
        </span>
      </div>
      <div className="space-y-0">
        {nodes.map((n, i) => {
          const Icon = n.icon;
          return (
            <div key={n.label}>
              <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-xs">
                <span className={cn('flex h-9 w-9 items-center justify-center rounded-lg ring-1 ring-inset', n.tone)}>
                  <Icon className="h-4.5 w-4.5" />
                </span>
                <div>
                  <div className="text-[13px] font-semibold text-slate-800">{n.label}</div>
                  <div className="text-[11px] text-slate-400">{n.sub}</div>
                </div>
              </div>
              {i < nodes.length - 1 && <div className="ml-[2.1rem] h-5 w-px bg-slate-200" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Block({
  tag,
  title,
  desc,
  bullets,
  visual,
  reverse,
}: {
  tag: string;
  title: string;
  desc: string;
  bullets: string[];
  visual: React.ReactNode;
  reverse?: boolean;
}) {
  return (
    <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
      <Reveal className={cn(reverse && 'lg:order-2')}>
        <Eyebrow>{tag}</Eyebrow>
        <h2 className="mt-4 font-display text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{title}</h2>
        <p className="mt-4 text-lg leading-relaxed text-slate-500">{desc}</p>
        <ul className="mt-6 space-y-3">
          {bullets.map((b) => (
            <li key={b} className="flex items-start gap-3 text-slate-700">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-100 text-primary-700">
                <Check className="h-3.5 w-3.5" />
              </span>
              <span className="text-[15px]">{b}</span>
            </li>
          ))}
        </ul>
      </Reveal>
      <Reveal delay={120} className={cn(reverse && 'lg:order-1')}>
        {visual}
      </Reveal>
    </div>
  );
}

export default function Highlights() {
  const { t } = useTranslation('marketing');

  return (
    <section className="bg-white py-20 sm:py-28">
      <div className={`${SHELL} space-y-24`}>
        <Block
          tag={t('landing.highlights.inboxTag')}
          title={t('landing.highlights.inboxTitle')}
          desc={t('landing.highlights.inboxDesc')}
          bullets={[
            t('landing.highlights.inboxB1'),
            t('landing.highlights.inboxB2'),
            t('landing.highlights.inboxB3'),
          ]}
          visual={<InboxVisual />}
        />
        <Block
          reverse
          tag={t('landing.highlights.autoTag')}
          title={t('landing.highlights.autoTitle')}
          desc={t('landing.highlights.autoDesc')}
          bullets={[
            t('landing.highlights.autoB1'),
            t('landing.highlights.autoB2'),
            t('landing.highlights.autoB3'),
          ]}
          visual={<AutomationVisual />}
        />
      </div>
    </section>
  );
}
