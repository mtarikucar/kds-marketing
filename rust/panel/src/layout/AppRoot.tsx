import { useTranslation } from 'react-i18next';
import { Outlet } from 'react-router-dom';
import { Toaster } from '@/components/ui';

/** Above every page: the toast host. */
export function AppRoot() {
  const { t } = useTranslation();
  return (
    <>
      <Outlet />
      <Toaster containerAriaLabel={t('kit.notifications')} />
    </>
  );
}
