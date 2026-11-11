import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/auth/useSession';
import { WorkspaceHeader } from '@/components/WorkspaceHeader';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { can } from '@/lib/roles';
import { istanbulDay } from '@/api/materials';
import { ProductionLine } from './ProductionLine';
import { AreaPage } from './AreaPage';
import { ModuleStatusLine } from '@/components/ModuleStatusLine';
import { MaterialsCalendar } from '../materials/MaterialsCalendar';

export function ContentPage() {
  const { t } = useTranslation();
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const tab = ['calendar', 'settings'].includes(params.get('tab') ?? '') ? 'calendar' : 'projects';
  const areaId = params.get('area') ?? params.get('project');
  const year = Number(params.get('year')) || Number(istanbulDay(new Date()).slice(0, 4));
  return <div className="space-y-6">
    <WorkspaceHeader title={t('modulePages.content')} />
    {can(session.data, 'content.work') ? <><ModuleStatusLine module="content" /><Tabs value={tab} onValueChange={tab => setParams({ tab })}>
      <TabsList aria-label={t('modulePages.content')}>
        <TabsTrigger value="projects">{t('contentAreas.line')}</TabsTrigger>
        <TabsTrigger value="calendar">{t('modulePages.settings')}</TabsTrigger>
      </TabsList>
      <TabsContent value="projects"><>{areaId ? <AreaPage key={areaId} id={areaId} manage={can(session.data, 'content.manage')} /> : <ProductionLine manage={can(session.data, 'content.manage')} onOpen={id => setParams({ area: id })} />}</></TabsContent>
      <TabsContent value="calendar"><MaterialsCalendar year={year} onYear={year => setParams({ tab: 'calendar', year: String(year) })} /></TabsContent>
    </Tabs></> : <p role="alert">{t('studio.forbidden')}</p>}
  </div>;
}
