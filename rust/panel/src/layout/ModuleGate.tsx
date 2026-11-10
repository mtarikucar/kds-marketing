import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Layers } from 'lucide-react';
import { QueryState } from '@/components/QueryState';
import { Button, EmptyState } from '@/components/ui';
import { useModules } from '@/lib/modules';

/** Navigation availability only. Server-side permissions still guard every operation. */
export function ModuleGate({ moduleId, children }: { moduleId: string; children: ReactNode }) {
  const query = useModules();
  const { i18n } = useTranslation();
  const tr = i18n.language.startsWith('tr');
  if (!query.data) return <QueryState query={query} />;
  if (query.data.modules.some(m => m.blueprint.id === moduleId && m.installed)) return <>{children}</>;
  return <EmptyState
    headingLevel="h1"
    icon={<Layers className="h-8 w-8" />}
    title={tr ? 'Bu modül çalışma alanına eklenmemiş' : 'This module is not installed'}
    description={tr ? 'Blueprint kataloğundan ekleyerek bu bölümü açabilirsiniz. Daha önce oluşturulan kayıtlar korunur.' : 'Install it from the blueprint catalog to open this section. Existing records are retained.'}
    action={<Button asChild><Link to={`/modules/${encodeURIComponent(moduleId)}`}>{tr ? 'Modülü incele' : 'View module'}</Link></Button>}
  />;
}
