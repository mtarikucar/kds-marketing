import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button, EmptyState } from '@/components/ui';

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <EmptyState
        className="max-w-md bg-surface"
        icon={<img src="/brand/scenes/strategy.svg" alt="" width="160" height="128" />}
        title={t('notFound.title')}
        description={t('notFound.body')}
        action={
          <Button asChild variant="outline">
            <Link to="/">{t('notFound.home')}</Link>
          </Button>
        }
      />
    </div>
  );
}
