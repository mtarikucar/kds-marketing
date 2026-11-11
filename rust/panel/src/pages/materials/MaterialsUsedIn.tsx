import { useTranslation } from 'react-i18next';
import type * as m from '@/api/materials';
import { formatInstant } from './MaterialsShared';

/**
 * Kullanıldığı yerler: each piece that showed the material, its slot (opened in Studio) and the
 * posts it was published as. Deleting a material never deletes a post on its provider (spec §9.3):
 * these links are how the owner finds and removes them there.
 */
export function UsedInList({
  uses,
  onOpenSlot,
}: {
  uses: m.UsedIn[];
  onOpenSlot: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  if (!uses.length) return <p className="text-sm text-muted-foreground">{t('materials.usedIn.none')}</p>;
  return (
    <ul className="divide-y divide-border">
      {uses.map((u) => (
        <li
          key={`${u.piece_id}-${u.revision}`}
          className="min-w-0 space-y-2 break-words py-4 text-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {t(`materials.role.${u.role}`)}
              {u.scheduled_at ? ` · ${formatInstant(u.scheduled_at, i18n.language)}` : ''}
              {u.slot_state ? ` · ${t(`studio.${u.slot_state}`)}` : ''}
            </span>
            <button
              type="button"
              className="min-h-11 px-2 underline"
              onClick={() => onOpenSlot(u.slot_id)}
            >
              {t('materials.usedIn.openSlot')}
            </button>
          </div>
          {u.publications.map((p) =>
            p.url ? (
              <a
                key={p.publication_id}
                href={p.url}
                target="_blank"
                rel="noreferrer noopener"
                className="block min-h-11 py-2 underline"
              >
                {t('materials.usedIn.post', { at: formatInstant(p.published_at, i18n.language) })}
              </a>
            ) : (
              <p key={p.publication_id}>
                {t('materials.usedIn.postNoLink', {
                  at: formatInstant(p.published_at, i18n.language),
                  id: p.external_id,
                })}
              </p>
            ),
          )}
        </li>
      ))}
    </ul>
  );
}
