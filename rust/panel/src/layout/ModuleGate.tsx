import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Layers, Lock } from 'lucide-react';
import { QueryState } from '@/components/QueryState';
import { Button, EmptyState } from '@/components/ui';
import { moduleMissing, useModules } from '@/lib/modules';
import { requirementLabel } from '@/lib/requirements';

/**
 * Navigation availability: the module must be installed and its capability requirements met
 * (spec 2026-11-10 module gating). The server refuses the module's use cases on its own too.
 */
export function ModuleGate({ moduleId, children }: { moduleId: string; children: ReactNode }) {
  const query = useModules();
  const { t, i18n } = useTranslation();
  const tr = i18n.language.startsWith('tr');
  if (!query.data) return <QueryState query={query} />;
  const module = query.data.modules.find(m => m.blueprint.id === moduleId);
  if (!module?.installed) return <EmptyState
    headingLevel="h1"
    icon={<Layers className="h-8 w-8" />}
    title={tr ? 'Bu modül çalışma alanına eklenmemiş' : 'This module is not installed'}
    description={tr ? 'Blueprint kataloğundan ekleyerek bu bölümü açabilirsiniz. Daha önce oluşturulan kayıtlar korunur.' : 'Install it from the blueprint catalog to open this section. Existing records are retained.'}
    action={<Button asChild><Link to={`/modules/${encodeURIComponent(moduleId)}`}>{tr ? 'Modülü incele' : 'View module'}</Link></Button>}
  />;
  const missing = moduleMissing(query.data, moduleId);
  if (missing.length) {
    const or = tr ? 'veya' : 'or';
    return <EmptyState
      headingLevel="h1"
      icon={<Lock className="h-8 w-8" />}
      title={tr ? `${module.blueprint.name} için bir yetenek bağlanmalı` : `${module.blueprint.name} needs a connected capability`}
      description={<span className="flex flex-col gap-2">
        <span>{tr ? 'Bu modül, gerekli yetenek bağlanıp doğrulanınca açılır. Mevcut kayıtlar korunur.' : 'This module opens once the capability it needs is connected and verified. Existing records are kept.'}</span>
        <span className="flex flex-col gap-1" data-testid="module-missing">
          {missing.map(line => <span key={line} className="font-medium text-foreground">{requirementLabel(t, line, or)}</span>)}
        </span>
      </span>}
      action={<div className="flex flex-wrap justify-center gap-2">
        <Button asChild><Link to="/connect">{tr ? 'Yetenek bağla' : 'Connect a capability'}</Link></Button>
        <Button asChild variant="outline"><Link to="/capabilities">{tr ? 'Yetenekler' : 'Capabilities'}</Link></Button>
      </div>}
    />;
  }
  return <>{children}</>;
}
