import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Button, EmptyState } from '@/components/ui';
import { useEntryCopy } from './entryCopy';

export function NotFoundPage() {
  const { t } = useTranslation();
  const copy = useEntryCopy();
  const navigate = useNavigate();
  return (
    <main id="main-content" tabIndex={-1} className="flex min-h-screen items-center justify-center bg-background p-4">
      <EmptyState
        className="max-w-md bg-surface"
        headingLevel="h1"
        title={t('notFound.title')}
        description={copy('notFoundHint')}
        action={
          <div className="flex flex-wrap justify-center gap-2">
          <Button asChild variant="outline">
            <Link to="/">{t('notFound.home')}</Link>
          </Button>
          {window.history.length > 1 && <Button variant="ghost" onClick={() => navigate(-1)}>{copy('previousPage')}</Button>}
          </div>
        }
      />
    </main>
  );
}
