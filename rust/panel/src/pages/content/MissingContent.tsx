import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { projectGet } from '@/api/projects';
import { useMaterialsKey } from '../materials/MaterialsShared';
import { AreaDetail } from './AreaDetail';
import { openedBy } from './AreaShared';
import { placeHref, useContentPlace } from './location';

/**
 * A content the link names that is not on the list shown (an archived one, one of another
 * folder): opened on its own above the list, with everything a person may do to it.
 */
export function MissingContent({ id, manage, files }: { id: string; manage: boolean; files: boolean }) {
  const { t } = useTranslation();
  const key = useMaterialsKey();
  const [place] = useContentPlace();
  const detail = useQuery({ queryKey: [...key, 'areas', id], queryFn: () => projectGet(id), refetchInterval: 15_000 });
  const project = detail.data?.project;
  return (
    <article id={`content-${id}`} aria-label={project?.title ?? t('content.detail.label')} className="min-w-0 space-y-4 rounded-lg border border-primary/40 bg-surface p-4 shadow-xs">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {project && <h3 className="break-words font-medium">{project.title}</h3>}
          {project && <p className="text-xs text-muted-foreground">{openedBy(t, project.opened_by)}</p>}
        </div>
        <Link to={placeHref({ ...place, content: undefined })} aria-label={t('kit.close')} className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <X aria-hidden="true" className="h-4 w-4" />
        </Link>
      </div>
      <AreaDetail id={id} manage={manage} files={files} />
    </article>
  );
}
