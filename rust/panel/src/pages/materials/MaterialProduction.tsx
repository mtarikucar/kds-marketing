import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as m from '@/api/materials';
import {
  MaterialsError,
  MaterialsReadStatus,
  cardClass,
  fieldClass,
  primaryClass,
  tapClass,
  useDecider,
  useMaterialsKey,
  useMaterialsMutation,
} from './MaterialsShared';

export function MaterialProduction({
  material,
  onOpen,
}: {
  material: m.Material;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const key = useMaterialsKey();
  const decider = useDecider();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<m.MaterialProductionKind>('edit');
  const [instructions, setInstructions] = useState('');
  const requestKey = useRef<string | null>(null);
  const list = useQuery({
    queryKey: [...key, 'productions', material.id],
    queryFn: () => m.materialProductions(material.id),
    enabled: open,
    refetchInterval: open ? 15_000 : false,
  });
  const create = useMaterialsMutation(
    () => {
      requestKey.current ??= crypto.randomUUID();
      return m.materialProductionRequest({
        request_key: requestKey.current,
        kind,
        instructions: instructions.trim(),
        sources: [{ material_id: material.id, expected_revision: material.revision }],
      });
    },
    () => {
      setInstructions('');
      requestKey.current = null;
    },
  );
  return (
    <details className={cardClass} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="min-h-11 cursor-pointer py-2 font-semibold">
        {t('materials.production.title')}
      </summary>
      <p className="text-sm text-muted-foreground">{t('materials.production.help')}</p>
      {decider && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (instructions.trim() && !create.isPending) create.mutate(undefined);
          }}
        >
          <label className="block space-y-1 text-sm">
            <span>{t('materials.production.kind')}</span>
            <select
              className={fieldClass}
              value={kind}
              disabled={create.isPending}
              onChange={(e) => {
                setKind(e.target.value as m.MaterialProductionKind);
                requestKey.current = null;
              }}
            >
              {(['edit', 'crop', 'poster'] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`materials.production.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            <span>{t('materials.production.instructions')}</span>
            <textarea
              rows={3}
              className={fieldClass}
              maxLength={2000}
              value={instructions}
              disabled={create.isPending}
              onChange={(e) => {
                setInstructions(e.target.value);
                requestKey.current = null;
              }}
            />
          </label>
          <button className={primaryClass} disabled={!instructions.trim() || create.isPending}>
            {t('materials.production.submit')}
          </button>
          <MaterialsError error={create.error} />
        </form>
      )}
      {create.isSuccess && (
        <p role="status" className="text-sm">
          {t('materials.production.queued')}
        </p>
      )}
      <MaterialsReadStatus query={list} />
      <ul className="divide-y divide-border">
        {list.data?.map((job) => (
          <li key={job.id} className="space-y-2 py-3 text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <span className="font-medium">{t(`materials.production.${job.kind}`)}</span>
              <span>{t(`materials.production.status.${job.status}`)}</span>
            </div>
            <p className="whitespace-pre-wrap break-words text-muted-foreground">{job.instructions}</p>
            {job.status === 'failed' && job.last_error_code === 'source_changed' && (
              <p className="text-sm text-warning">{t('materials.production.sourceChanged')}</p>
            )}
            {job.output_material_id && (
              <button type="button" className={tapClass} onClick={() => onOpen(job.output_material_id!)}>
                {t('materials.production.open')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
