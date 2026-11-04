import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as m from '@/api/materials';
import * as api from '@/api/studio';
import { ConfirmDialog } from '@/components/ui';
import { useStudioKey } from '../StudioShared';
import {
  CAPTION_CODES,
  MaterialsError,
  findingText,
  primaryClass,
  useDecider,
  useMaterialsMutation,
} from './MaterialsShared';
import { materialsHref } from './StudioMaterials';

function findingsOf(details: unknown): m.HoldFinding[] {
  if (!Array.isArray(details)) return [];
  return details.filter(
    (f): f is m.HoldFinding =>
      typeof f === 'object' && f !== null && typeof (f as { code?: unknown }).code === 'string',
  );
}

const isCaption = (f: m.HoldFinding) =>
  f.kind ? f.kind === 'caption' : (CAPTION_CODES as readonly string[]).includes(f.code);

/**
 * The release of a held piece's caption findings (spec §7, D19): an owner or manager, in person,
 * lets this revision go out with these findings. Offered only while caption findings alone hold
 * it; the digest is the one `studio.slot_get` shows, so a release names exactly what was read.
 */
function CaptionRelease({ slot }: { slot: api.Slot }) {
  const { t } = useTranslation();
  const key = useStudioKey();
  const [open, setOpen] = useState(false);
  const detail = useQuery({ queryKey: [...key, 'slot', slot.id], queryFn: () => api.slotGet(slot.id) });
  const check = (detail.data as (api.SlotDetail & { material_check?: m.MaterialCheck }) | undefined)
    ?.material_check;
  const release = useMaterialsMutation(
    (c: m.MaterialCheck) => m.materialCheckRelease(slot.id, slot.revision, c.digest),
    () => setOpen(false),
  );
  if (!check || check.released || check.hard.length > 0 || check.findings.length === 0) return null;
  return (
    <div className="space-y-2">
      <button type="button" className={primaryClass} onClick={() => setOpen(true)}>
        {t('materials.hold.release')}
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => !release.isPending && setOpen(next)}
        title={t('materials.hold.releaseTitle')}
        description={t('materials.hold.releaseHelp')}
        confirmLabel={t('materials.hold.releaseConfirm')}
        cancelLabel={t('materials.editor.deleteCancel')}
        loading={release.isPending}
        onConfirm={() => {
          if (!release.isPending) release.mutate(check);
        }}
      />
      <MaterialsError error={release.error} />
    </div>
  );
}

/**
 * A slot held by the material check (`material_check_hold`, spec §5.6): each finding in plain
 * words, a way to the material concerned, how many çekim listesi requests are open, and, when only
 * caption findings hold it, an owner's or manager's release.
 */
export function MaterialHold({
  slot,
  details,
  shootCount,
}: {
  slot: api.Slot;
  details: unknown;
  shootCount: number;
}) {
  const { t } = useTranslation();
  const decider = useDecider();
  const findings = findingsOf(details);
  const captionOnly = findings.length > 0 && findings.every(isCaption);
  return (
    <div
      role="group"
      aria-label={t('materials.hold.title')}
      className="space-y-2 rounded-md border border-warning bg-warning-subtle p-3 text-sm"
      data-testid={`material-hold-${slot.id}`}
    >
      <p className="font-medium">{t('materials.hold.title')}</p>
      {findings.length > 0 ? (
        <ul className="list-disc space-y-1 ps-5">
          {findings.map((f, i) => (
            <li key={i} className="break-words">
              {findingText(t, f.code)}
              {f.matched ? ` (“${f.matched}”)` : ''}
              {f.material_id && (
                <>
                  {' '}
                  <Link className="underline" to={materialsHref('olays', { material: f.material_id })}>
                    {t('materials.hold.openMaterial')}
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>{t('materials.hold.noDetails')}</p>
      )}
      <p className="text-muted-foreground">
        {captionOnly ? t('materials.hold.fixCaption') : t('materials.hold.fixMaterial')}
      </p>
      {shootCount > 0 && (
        <p>
          {t('materials.hold.shoots', { count: shootCount })}{' '}
          <Link className="underline" to={materialsHref('shoots')}>
            {t('materials.hold.openShoots')}
          </Link>
        </p>
      )}
      {decider && captionOnly && slot.state === 'ready' && <CaptionRelease slot={slot} />}
    </div>
  );
}
