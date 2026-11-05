import { useTranslation } from 'react-i18next';
import { Outlet } from 'react-router-dom';
import { Toaster } from '@/components/ui';

/** Above every page: the toast host. */
export function AppRoot() {
  const { t } = useTranslation();
  return (
    <>
      <a href="#main-content" className="fixed start-4 top-4 z-[100] -translate-y-24 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground focus-visible:translate-y-0">
        {t('kit.skipContent')}
      </a>
      <Outlet />
      <Toaster containerAriaLabel={t('kit.notifications')} />
    </>
  );
}
