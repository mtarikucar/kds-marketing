import { useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { Material } from '@/api/materials';
import { isApiError } from '@/api/client';
import { MaterialsError, MaterialPreview, materialLabel, tapClass } from '../materials/MaterialsShared';

/** Reuse a key after a lost response, but not after the user changes the requested operation. */
export function useRequestKey() {
  const value = useRef<{ payload: string; key: string }>();
  return (payload: unknown) => {
    const text = JSON.stringify(payload);
    if (value.current?.payload !== text) value.current = { payload: text, key: crypto.randomUUID() };
    return value.current.key;
  };
}

export function ProjectError({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  const known = [
    'project_source_changed',
    'lead_too_short',
    'channel_unavailable',
    'material_refused',
    'no_eligible_material',
    'format_unsupported',
    'project_output_changed',
    'project_output_incomplete',
    'project_archived',
    'project_has_open_requests',
  ] as const;
  const reasons = isApiError(error)
    ? [
        error.details.reason,
        ...(Array.isArray(error.details.items)
          ? error.details.items.map((item) =>
              typeof item === 'object' && item !== null ? (item as { reason?: unknown }).reason : null,
            )
          : []),
      ].filter(
        (v): v is (typeof known)[number] => typeof v === 'string' && (known as readonly string[]).includes(v),
      )
    : [];
  return (
    <div className="space-y-2" role="alert">
      {reasons.length ? (
        [...new Set(reasons)].map((reason) => (
          <p key={reason} className="text-sm text-danger">
            {t(`projects.errors.${reason}`)}
          </p>
        ))
      ) : (
        <MaterialsError error={error} />
      )}
      {isApiError(error) && error.code === 'CONFLICT' && (
        <p className="text-sm text-muted-foreground">{t('projects.conflictHelp')}</p>
      )}
    </div>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="border-s-2 border-border py-2 ps-4 text-sm leading-6 text-muted-foreground">{children}</p>
  );
}

export function MaterialChoice({
  material,
  checked,
  onChange,
}: {
  material: Material;
  checked: boolean;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  return (
    <label
      className={`flex min-w-0 cursor-pointer gap-3 rounded-md border p-3 ${checked ? 'border-primary bg-primary/5' : 'border-border'}`}
    >
      <input type="checkbox" checked={checked} onChange={onChange} className="mt-1 h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 space-y-2">
        <span className="block truncate text-sm font-medium">{materialLabel(t, material)}</span>
        <MaterialPreview material={material} />
      </span>
    </label>
  );
}

export function OpenMaterial({ material }: { material: Material }) {
  const { t } = useTranslation();
  return (
    <Link
      className={tapClass}
      to={`/materials?view=library&material=${encodeURIComponent(material.id)}`}
    >
      {t('projects.openMaterial')}
    </Link>
  );
}
