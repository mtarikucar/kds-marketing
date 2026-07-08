import { useTranslation } from 'react-i18next';
import {
  LayoutDashboard,
  Inbox,
  Users,
  Megaphone,
  BarChart3,
  Settings,
  TrendingUp,
  MessageCircle,
} from 'lucide-react';
import { cn } from '../../components/ui/cn';

/**
 * A hand-built mock of the Jeeta console used as the hero visual. It renders as
 * a light "app window" so it pops against the dark hero — no real screenshot or
 * seeded data required. All copy is driven from `landing.mock.*` so the mock
 * follows the TR/EN toggle just like the surrounding hero.
 */

const SIDEBAR_ICONS = [LayoutDashboard, Inbox, Users, Megaphone, BarChart3, Settings];
const BARS = [42, 58, 47, 72, 64, 88, 76];

export default function ProductMock() {
  const { t } = useTranslation('marketing');

  const kpis = [
    { label: t('landing.mock.leadLabel'), value: t('landing.mock.leadValue'), delta: '+12%' },
    { label: t('landing.mock.revenueLabel'), value: t('landing.mock.revenueValue'), delta: '+8%' },
    { label: t('landing.mock.convLabel'), value: t('landing.mock.convValue'), delta: '+5%' },
  ];

  const inboxRows = [
    { initials: 'AY', name: t('landing.mock.row1Name'), msg: t('landing.mock.row1Msg'), tone: 'bg-emerald-500', tag: 'WA' },
    { initials: 'MK', name: t('landing.mock.row2Name'), msg: t('landing.mock.row2Msg'), tone: 'bg-pink-500', tag: 'IG' },
    { initials: 'SD', name: t('landing.mock.row3Name'), msg: t('landing.mock.row3Msg'), tone: 'bg-sky-500', tag: 'Web' },
  ];

  return (
    <div className="relative">
      {/* Glow behind the window — radial gradient, not filter:blur (iOS Safari perf). */}
      <div
        aria-hidden
        className="absolute -inset-6 -z-10 rounded-[2rem]"
        style={{ background: 'radial-gradient(closest-side, rgba(36,88,230,0.22), transparent)' }}
      />

      <div className="overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/10">
        {/* Title bar */}
        <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2.5">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
          <div className="mx-auto flex items-center gap-1.5 rounded-md bg-white px-3 py-1 text-[11px] font-medium text-slate-400 ring-1 ring-slate-200">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            app.jeetagrowth.com/dashboard
          </div>
        </div>

        {/* Body */}
        <div className="flex">
          {/* Sidebar */}
          <div className="flex w-12 flex-col items-center gap-1 border-r border-slate-100 bg-slate-50/80 py-3 sm:w-14">
            <div className="mb-1 h-7 w-7 rounded-lg bg-gradient-to-br from-primary-500 to-primary-700" />
            {SIDEBAR_ICONS.map((Icon, i) => (
              <div
                key={i}
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-lg',
                  i === 0 ? 'bg-primary-50 text-primary-600' : 'text-slate-400',
                )}
              >
                <Icon className="h-4 w-4" />
              </div>
            ))}
          </div>

          {/* Main */}
          <div className="flex-1 space-y-3 p-3.5 sm:p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-semibold text-slate-900">{t('landing.mock.panel')}</div>
                <div className="text-[10px] text-slate-400">{t('landing.mock.last7')}</div>
              </div>
              <div className="h-7 w-7 rounded-full bg-gradient-to-br from-amber-300 to-orange-400 ring-2 ring-white" />
            </div>

            {/* KPI cards */}
            <div className="grid grid-cols-3 gap-2">
              {kpis.map((k) => (
                <div key={k.label} className="rounded-lg border border-slate-100 bg-white p-2.5 shadow-xs">
                  <div className="text-[10px] font-medium text-slate-400">{k.label}</div>
                  <div className="mt-0.5 text-sm font-bold text-slate-900">{k.value}</div>
                  <div className="mt-0.5 flex items-center gap-0.5 text-[10px] font-semibold text-emerald-600">
                    <TrendingUp className="h-2.5 w-2.5" />
                    {k.delta}
                  </div>
                </div>
              ))}
            </div>

            {/* Chart */}
            <div className="rounded-lg border border-slate-100 bg-white p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-700">{t('landing.mock.chartTitle')}</span>
                <span className="rounded bg-primary-50 px-1.5 py-0.5 text-[9px] font-semibold text-primary-600">
                  {t('landing.mock.chartBadge')}
                </span>
              </div>
              <div className="flex h-20 items-end gap-1.5">
                {BARS.map((h, i) => (
                  <div
                    key={i}
                    style={{ height: `${h}%` }}
                    className={cn(
                      'flex-1 rounded-t-sm',
                      i === BARS.length - 2 ? 'bg-gradient-to-t from-primary-600 to-primary-400' : 'bg-primary-100',
                    )}
                  />
                ))}
              </div>
            </div>

            {/* Inbox preview */}
            <div className="rounded-lg border border-slate-100 bg-white p-1.5">
              {inboxRows.map((r) => (
                <div key={r.initials} className="flex items-center gap-2 rounded-md px-1.5 py-1.5">
                  <div
                    className={cn(
                      'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white',
                      r.tone,
                    )}
                  >
                    {r.initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-semibold text-slate-800">{r.name}</div>
                    <div className="truncate text-[10px] text-slate-400">{r.msg}</div>
                  </div>
                  <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[8px] font-semibold text-slate-500">
                    {r.tag}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Floating accent chips */}
      <div className="absolute -left-4 bottom-16 hidden animate-float rounded-xl bg-white px-3 py-2 shadow-xl ring-1 ring-slate-900/5 motion-reduce:animate-none sm:flex sm:items-center sm:gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
          <MessageCircle className="h-4 w-4" />
        </span>
        <div className="leading-tight">
          <div className="text-[11px] font-bold text-slate-900">{t('landing.mock.chip1Title')}</div>
          <div className="text-[9px] text-slate-400">{t('landing.mock.chip1Sub')}</div>
        </div>
      </div>

      <div
        className="absolute -right-3 top-20 hidden animate-float rounded-xl bg-white px-3 py-2 shadow-xl ring-1 ring-slate-900/5 motion-reduce:animate-none sm:flex sm:items-center sm:gap-2"
        style={{ animationDelay: '1.2s' }}
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
          <TrendingUp className="h-4 w-4" />
        </span>
        <div className="leading-tight">
          <div className="text-[11px] font-bold text-slate-900">{t('landing.mock.chip2Title')}</div>
          <div className="text-[9px] text-slate-400">{t('landing.mock.chip2Sub')}</div>
        </div>
      </div>
    </div>
  );
}
