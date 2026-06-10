import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  HomeIcon,
  UserGroupIcon,
  ClipboardDocumentListIcon,
  CalendarIcon,
  DocumentTextIcon,
  ChartBarIcon,
  CurrencyDollarIcon,
  UsersIcon,
  ArrowRightOnRectangleIcon,
  WrenchScrewdriverIcon,
  PhoneIcon,
  PresentationChartLineIcon,
  FlagIcon,
  BeakerIcon,
  CreditCardIcon,
  SparklesIcon,
  BookOpenIcon,
  InboxIcon,
  ChatBubbleLeftRightIcon,
  BoltIcon,
  MegaphoneIcon,
  GlobeAltIcon,
  CalendarDaysIcon,
  StarIcon,
  MicrophoneIcon,
} from '@heroicons/react/24/outline';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';

const navItems = [
  { path: '/dashboard', labelKey: 'nav.dashboard', icon: HomeIcon },
  { path: '/inbox', labelKey: 'nav.inbox', icon: InboxIcon },
  { path: '/leads', labelKey: 'nav.leads', icon: UserGroupIcon },
  { path: '/tasks', labelKey: 'nav.tasks', icon: ClipboardDocumentListIcon },
  { path: '/calendar', labelKey: 'nav.calendar', icon: CalendarIcon },
  { path: '/offers', labelKey: 'nav.offers', icon: DocumentTextIcon },
  { path: '/reports', labelKey: 'nav.reports', icon: ChartBarIcon },
  { path: '/commissions', labelKey: 'nav.commissions', icon: CurrencyDollarIcon },
  { path: '/installations', labelKey: 'nav.installations', icon: WrenchScrewdriverIcon },
  { path: '/calls', labelKey: 'nav.calls', icon: PhoneIcon },
  { path: '/performance', labelKey: 'nav.performance', icon: PresentationChartLineIcon },
];

const aiItems = [
  { path: '/ai/agents', labelKey: 'nav.agentStudio', icon: SparklesIcon },
  { path: '/ai/knowledge', labelKey: 'nav.knowledgeBase', icon: BookOpenIcon },
  { path: '/channels', labelKey: 'nav.channels', icon: ChatBubbleLeftRightIcon },
  { path: '/automations', labelKey: 'nav.automations', icon: BoltIcon },
  { path: '/campaigns', labelKey: 'nav.campaigns', icon: MegaphoneIcon },
  { path: '/sites', labelKey: 'nav.sites', icon: GlobeAltIcon },
  { path: '/booking', labelKey: 'nav.booking', icon: CalendarDaysIcon },
  { path: '/reviews', labelKey: 'nav.reviews', icon: StarIcon },
  { path: '/voice', labelKey: 'nav.voice', icon: MicrophoneIcon },
];

const managerOnlyItems = [
  { path: '/users', labelKey: 'nav.users', icon: UsersIcon },
  { path: '/targets', labelKey: 'nav.targets', icon: FlagIcon },
  { path: '/research', labelKey: 'nav.research', icon: BeakerIcon },
  { path: '/billing', labelKey: 'nav.billing', icon: CreditCardIcon },
];

export default function MarketingSidebar() {
  const { t } = useTranslation('marketing');
  const { user, logout } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 px-4 py-2.5 text-sm font-medium rounded-lg transition-colors ${
      isActive
        ? 'bg-primary/10 text-primary'
        : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
    }`;

  return (
    <aside className="flex flex-col w-64 bg-white border-r border-slate-200 min-h-screen">
      {/* Logo */}
      <div className="flex items-center gap-2 px-6 py-5 border-b border-slate-200">
        <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
          <span className="text-primary-foreground font-bold text-sm">M</span>
        </div>
        <span className="font-semibold text-slate-900">{t('login.title')}</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => (
          <NavLink key={item.path} to={item.path} className={linkClass}>
            <item.icon className="w-5 h-5" />
            {t(item.labelKey)}
          </NavLink>
        ))}

        {isManager && (
          <>
            <div className="pt-4 pb-2 px-4">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                {t('nav.aiGroup', 'AI')}
              </span>
            </div>
            {aiItems.map((item) => (
              <NavLink key={item.path} to={item.path} className={linkClass}>
                <item.icon className="w-5 h-5" />
                {t(item.labelKey)}
              </NavLink>
            ))}

            <div className="pt-4 pb-2 px-4">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                {t('nav.managementGroup')}
              </span>
            </div>
            {managerOnlyItems.map((item) => (
              <NavLink key={item.path} to={item.path} className={linkClass}>
                <item.icon className="w-5 h-5" />
                {t(item.labelKey)}
              </NavLink>
            ))}
          </>
        )}
      </nav>

      {/* User info & logout */}
      <div className="border-t border-slate-200 px-4 py-4">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 bg-primary/10 rounded-full flex items-center justify-center">
            <span className="text-primary font-medium text-sm">
              {user?.firstName?.[0]}{user?.lastName?.[0]}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-900 truncate">
              {user?.firstName} {user?.lastName}
            </p>
            <p className="text-xs text-slate-500 truncate">
              {user?.role === 'OWNER' ? t('role.OWNER', 'Owner') : user?.role === 'MANAGER' ? t('role.MANAGER') : t('role.REP')}
            </p>
          </div>
        </div>
        <button
          onClick={logout}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-slate-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
        >
          <ArrowRightOnRectangleIcon className="w-4 h-4" />
          {t('nav.logout')}
        </button>
      </div>
    </aside>
  );
}
