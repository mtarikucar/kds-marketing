import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { ProjectDetail } from '@/api/projects';
import { ProjectMaterials } from '../projects/ProjectMaterials';

/** Earlier work stays accessible even when an area predates content packages. */
export function AreaHistory({ detail }: { detail: ProjectDetail }) {
  const { t } = useTranslation();
  const { project, materials, productions } = detail;
  if (!project.sources.length && !project.outputs.length && !productions.length) return null;
  return (
    <details className="border-t border-border pt-4">
      <summary className="cursor-pointer py-2 font-medium">{t('contentAreas.existing')}</summary>
      <div className="mt-4 space-y-5">
        {project.sources.length > 0 && <ProjectMaterials project={project} materials={materials} writable={false} />}
        {productions.length > 0 && <ul className="space-y-3">
          {productions.map(production => <li key={production.id} className="space-y-1 break-words text-sm">
            <p>{production.instructions}</p>
            <p className="text-muted-foreground">{t(`materials.production.status.${production.status}`)}</p>
            {production.output_material_id && <Link className="underline" to={`/materials?view=library&material=${encodeURIComponent(production.output_material_id)}`}>{t('projects.openMaterial')}</Link>}
          </li>)}
        </ul>}
        {project.outputs.length > 0 && <ul className="space-y-3">
          {project.outputs.map(output => <li key={output.id} className="break-words text-sm">
            {output.slot_id
              ? <Link className="underline" to={`/social?slot=${encodeURIComponent(output.slot_id)}`}>{output.title} · {t(`posts.format.${output.format}`)}</Link>
              : <span>{output.title} · {t(`posts.format.${output.format}`)}</span>}
          </li>)}
        </ul>}
      </div>
    </details>
  );
}
