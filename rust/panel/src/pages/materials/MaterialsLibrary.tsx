import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as m from '@/api/materials';
import { MaterialTile, MaterialsReadStatus, fieldClass, gridClass, useMaterialsKey } from './MaterialsShared';

/** A business's actual groups and labels, with no fixed product categories. */
export function MaterialsLibrary({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const key = useMaterialsKey();
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('');
  const query = useQuery({ queryKey: [...key, 'intelligence-list'], queryFn: m.materialIntelligenceList });
  const groups = useMemo(
    () =>
      [
        ...new Set(
          query.data?.flatMap((row) => (row.intelligence?.group_name ? [row.intelligence.group_name] : [])) ??
            [],
        ),
      ].sort((a, b) => a.localeCompare(b, 'tr')),
    [query.data],
  );
  const needle = search.trim().toLocaleLowerCase('tr');
  const rows = query.data?.filter(
    ({ material, intelligence }) =>
      !material.erased_at &&
      (!group || intelligence?.group_name === group) &&
      (!needle ||
        [material.title, intelligence?.description, ...(material.tags.labels ?? [])]
          .join(' ')
          .toLocaleLowerCase('tr')
          .includes(needle)),
  );
  const grouped = new Map<string, m.MaterialIntelligenceOut[]>();
  for (const row of rows ?? []) {
    const name = row.intelligence?.group_name || t('materials.intelligence.ungrouped');
    grouped.set(name, [...(grouped.get(name) ?? []), row]);
  }
  return (
    <div className="space-y-5">
      <p className="max-w-2xl text-sm text-muted-foreground">{t('materials.intelligence.libraryHelp')}</p>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.4fr)]">
        <label className="space-y-1 text-sm">
          <span>{t('materials.intelligence.search')}</span>
          <input
            type="search"
            className={fieldClass}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span>{t('materials.intelligence.group')}</span>
          <select className={fieldClass} value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">{t('materials.intelligence.allGroups')}</option>
            {groups.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <MaterialsReadStatus query={query} />
      {rows?.length === 0 && (
        <p role="status" className="py-8 text-sm text-muted-foreground">
          {t(query.data?.length ? 'materials.intelligence.noResults' : 'materials.noMaterials')}
        </p>
      )}
      {[...grouped].map(([name, entries]) => (
        <section key={name} className="space-y-3">
          <h3 className="border-b border-border pb-2 text-base font-medium">
            {name} <span className="text-muted-foreground">{entries.length}</span>
          </h3>
          <ul className={gridClass}>
            {entries.map(({ material }) => (
              <MaterialTile key={material.id} material={material} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
