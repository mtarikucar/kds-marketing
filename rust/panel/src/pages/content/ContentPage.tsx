import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { ChevronLeft, Settings, Upload } from 'lucide-react';
import { contentTree } from '@/api/content';
import { useSession } from '@/auth/useSession';
import { WorkspaceHeader } from '@/components/WorkspaceHeader';
import { ModuleStatusLine } from '@/components/ModuleStatusLine';
import { QueryState } from '@/components/QueryState';
import { Button, cn, EmptyState, IconButton } from '@/components/ui';
import { can } from '@/lib/roles';
import { moduleReady, useModules } from '@/lib/modules';
import { ContentTree } from './ContentTree';
import { WaitingStrip } from './WaitingStrip';
import { RootView } from './RootView';
import { OlayView } from './OlayView';
import { QueueView } from './QueueView';
import { UpcomingView } from './UpcomingView';
import { FileDrawer } from './FileDrawer';
import { ContentSettings } from './ContentSettings';
import { OlayDialog } from './OlayForms';
import { UploadProvider, useUploads } from './uploads';
import { isHome, placeHref, placeSearch, readPlace, useContentKey, useContentPlace } from './location';

function UploadButton() {
  const { t } = useTranslation();
  const uploads = useUploads();
  if (!uploads) return null;
  return (
    <Button onClick={uploads.pick}>
      <Upload aria-hidden="true" className="h-4 w-4" />
      {t('content.upload.button')}
    </Button>
  );
}

/**
 * Old addresses of the two pages this one replaced: `?area=` / `?project=` (a production area),
 * `?tab=calendar|settings` (the settings tab). They are rewritten in place.
 */
function legacyTarget(search: string): string | null {
  const params = new URLSearchParams(search);
  const area = params.get('area') ?? params.get('project');
  const tab = params.get('tab');
  if (!area && !tab) return null;
  const place = readPlace(params);
  if (area) place.content = area;
  if (tab === 'calendar' || tab === 'settings') place.settings = true;
  return placeHref(place);
}

/**
 * İçerik: one page for the files and the contents made of them (design 2026-11-18). The root
 * object is the olay, a folder: the tree on the left, the production line or one folder on the
 * right, uploads by a button or a drop anywhere, and only the exceptions under "Sizi bekleyenler".
 */
export function ContentPage() {
  const { t } = useTranslation();
  const session = useSession();
  const location = useLocation();
  const modules = useModules();
  const [place, go] = useContentPlace();
  const key = useContentKey();
  const [newOlay, setNewOlay] = useState(false);
  const materialsWork = can(session.data, 'materials.work');
  const manage = can(session.data, 'content.manage');
  const contentWork = can(session.data, 'content.work') || manage;
  // The page answers whoever works the library or the content; contents need the content module.
  const contentModule = modules.data?.modules.find((m) => m.blueprint.id === 'content');
  const contentOn = !!contentModule?.installed && moduleReady(modules.data, 'content');
  const contents = contentWork && contentOn;
  const allowed = materialsWork || contentWork;
  const tree = useQuery({ queryKey: [...key, 'tree'], queryFn: contentTree, enabled: allowed, refetchInterval: 30_000 });
  const legacy = legacyTarget(location.search);
  if (legacy) return <Navigate replace to={legacy} />;
  if (!allowed) {
    return (
      <div className="space-y-6">
        <WorkspaceHeader title={t('content.title')} />
        <p role="alert">{t('studio.forbidden')}</p>
      </div>
    );
  }
  const home = isHome(place);
  const day = place.day ? tree.data?.upcoming.find((u) => `${u.key}:${u.year}` === place.day) : undefined;
  let main: React.ReactNode = null;
  if (tree.data) {
    if (place.view === 'queue' && materialsWork) main = <QueueView tree={tree.data} />;
    else if (place.olay) main = <OlayView key={place.olay} id={place.olay} contentOn={contentOn} manage={manage && contentOn} materialsWork={materialsWork} contentWork={contentWork} />;
    else if (place.day) main = <UpcomingView day={day} canCreate={materialsWork} />;
    else if (contents) main = <><WaitingStrip tree={tree.data} className="rounded-lg border border-border bg-surface px-3 py-2.5 max-md:hidden" /><RootView tree={tree.data} manage={manage} files={materialsWork} /></>;
    else if (contentWork) {
      main = (
        <EmptyState
          title={t('content.root.moduleOff')}
          description={t('content.root.moduleOffHelp')}
          action={<Button asChild variant="outline"><Link to="/modules/content">{t('content.root.moduleLink')}</Link></Button>}
        />
      );
    } else main = <><WaitingStrip tree={tree.data} className="rounded-lg border border-border bg-surface px-3 py-2.5 max-md:hidden" /><EmptyState title={t('content.root.filesOnly')} description={t('content.root.filesOnlyHelp')} /></>;
  }
  return (
    <UploadProvider enabled={materialsWork}>
      <div className="space-y-4">
        <WorkspaceHeader
          title={t('content.title')}
          description={t('content.help')}
          actions={
            <div className="flex items-center gap-2">
              <IconButton variant="outline" aria-label={t('content.settings.title')} title={t('content.settings.title')} onClick={() => go({ ...place, settings: true })}>
                <Settings className="h-4 w-4" />
              </IconButton>
              <UploadButton />
            </div>
          }
        />
        {/* The queue says the same of its own files. */}
        {contents && place.view !== 'queue' && <ModuleStatusLine module="content" />}
        <QueryState query={tree} keepOnError>
          {tree.data && (
            <div className="grid min-w-0 gap-5 md:grid-cols-[15rem_minmax(0,1fr)] lg:grid-cols-[16.5rem_minmax(0,1fr)]">
              <aside className={cn('min-w-0 md:sticky md:top-4 md:max-h-[calc(100dvh-2rem)] md:self-start md:overflow-y-auto', !home && 'max-md:hidden')}>
                <ContentTree
                  tree={tree.data}
                  place={place}
                  queue={materialsWork}
                  contents={contents}
                  onNewOlay={materialsWork ? () => setNewOlay(true) : undefined}
                  top={<WaitingStrip tree={tree.data} className="mb-2 border-b border-border px-1 pb-3 md:hidden" />}
                />
              </aside>
              <div className={cn('min-w-0 space-y-4', home && 'max-md:hidden')}>
                <Link to={`/content${placeSearch({})}`} className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground md:hidden">
                  <ChevronLeft aria-hidden="true" className="h-4 w-4" />
                  {t('content.tree.back')}
                </Link>
                {main}
              </div>
            </div>
          )}
        </QueryState>
      </div>
      {place.file && <FileDrawer id={place.file} />}
      {place.settings && <ContentSettings />}
      {newOlay && <OlayDialog onClose={() => setNewOlay(false)} onSaved={(olay) => go({ olay: olay.id })} />}
    </UploadProvider>
  );
}
