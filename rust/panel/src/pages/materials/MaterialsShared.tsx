import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Film, File as FileIcon, Image as ImageIcon } from 'lucide-react';
import { isApiError } from '@/api/client';
import * as m from '@/api/materials';
import { useSession } from '@/auth/useSession';
import { Badge } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { can, isOwnerOrManager } from '@/lib/roles';
import { useStudioKey } from '../StudioShared';

/** Inputs and buttons a thumb can hit on a phone (44 px). */
export const fieldClass =
  'min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
export const tapClass =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
export const primaryClass =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
export const cardClass = 'min-w-0 space-y-3 rounded-lg border border-border bg-surface p-4';

/** The query key of everything the library reads, under Studio's (so Studio refreshes it too). */
export function useMaterialsKey() {
  return [...useStudioKey(), 'materials'] as const;
}

/**
 * Whether the session may take the library's consent decisions (D4): an owner or manager with
 * `studio.manage`. The server checks again and refuses an agent whatever its role.
 */
export function useDecider(): boolean {
  const session = useSession();
  return can(session.data, 'studio.manage') && isOwnerOrManager(session.data);
}

/**
 * A library write. Its success refreshes Studio's queries (holds, the çekim listesi and the
 * ledger read the library) and the pending work. Each row of a list owns its own mutation, so
 * one row's pending state never disables another's.
 */
export function useMaterialsMutation<T, R>(
  fn: (value: T) => Promise<R>,
  onSuccess?: (result: R, value: T) => void,
) {
  const client = useQueryClient();
  const key = useStudioKey();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result, value) => {
      onSuccess?.(result, value);
      await Promise.all([
        client.invalidateQueries({ queryKey: key }),
        client.invalidateQueries({ queryKey: ['work'] }),
      ]);
    },
  });
}

/** The closed codes a material check names: eligibility refusals, piece-level and caption ones. */
export const FINDING_CODES = [
  'erased',
  'share_unset',
  'not_shareable',
  'sensitive_needs_human',
  'product_only_shows_person',
  'quality',
  'olay_missing',
  'olay_unconfirmed',
  'out_of_season',
  'use_archive',
  'archive_not_season',
  'not_freed',
  'other_olay',
  'genel_generic_only',
  'ai_not_anchor',
  'ai_olay_past',
  'no_material',
  'no_eligible_material',
  'names_other_olay',
  'names_material_context',
  'date_outside_olay',
  'date_in_generic',
  'archive_year_missing',
  'client_named_product_only',
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];
const isFindingCode = (code: unknown): code is FindingCode =>
  typeof code === 'string' && (FINDING_CODES as readonly string[]).includes(code);
/** The caption findings (spec §7): the only ones a person may release (D19). */
export const CAPTION_CODES: readonly FindingCode[] = [
  'names_other_olay',
  'names_material_context',
  'date_outside_olay',
  'date_in_generic',
  'archive_year_missing',
  'client_named_product_only',
];

/** A material check's finding as one Turkish (or English) sentence. */
export function findingText(t: TFunction, code: unknown): string {
  return isFindingCode(code)
    ? t(`materials.finding.${code}`)
    : t('materials.finding.unknown', { code: String(code) });
}

/** The library's refusals the panel words itself (`details.reason`). */
const REASONS = [
  'owner_or_manager_human',
  'human_required',
  'share_required',
  'olay_or_genel',
  'file_has_material',
  'duplicate_material_file',
  'material_erased',
  'genel_stays_freed',
  'ai_material',
  'already_confirmed',
  'already_resolved',
  'closes_itself',
  'not_a_monday',
  'request_key_taken',
  'depicts_required',
  'not_a_material',
  'no_eligible_material',
  'subject_required',
  'material_refused',
  'out_of_range',
  'revision_changed',
  'slot_not_ready',
  'hard_findings_not_releasable',
  'no_caption_findings',
  'findings_changed',
  // A story's one medium (Instagram's STORIES): what to fix.
  'story_image_jpeg_only',
  'story_image_too_large',
  'story_video_too_large',
  'story_video_length',
  'story_video_length_unknown',
  'story_video_not_fast_start',
] as const;
type ReasonCode = (typeof REASONS)[number];
const isReason = (r: unknown): r is ReasonCode =>
  typeof r === 'string' && (REASONS as readonly string[]).includes(r);
/** The fields a library refusal names (`details.field`) that the panel words itself. */
const FIELDS = [
  'media',
  'title',
  'dates',
  'place',
  'notes',
  'client',
  'occasion',
  'window',
  'key',
  'name',
  'lead_days',
  'policy',
  'text',
  'week_start',
  'year',
  'people',
  'binding',
  'share',
  'revision',
  'request_key',
] as const;
type FieldCode = (typeof FIELDS)[number];
const isField = (f: unknown): f is FieldCode =>
  typeof f === 'string' && (FIELDS as readonly string[]).includes(f);

/** A library request's failure in the owner's words; else the panel's general wording. */
export function materialsErrorText(t: TFunction, error: unknown): string {
  if (!isApiError(error)) return errorMessage(t, error);
  const { reason, field } = error.details;
  if (reason === 'material_refused' && Array.isArray(error.details.refusals)) {
    const codes = (error.details.refusals as { code?: unknown }[]).map((r) => findingText(t, r.code));
    return [t('materials.error.material_refused'), ...new Set(codes)].join(' ');
  }
  if (isReason(reason)) return t(`materials.error.${reason}`);
  if (error.code === 'CONFLICT' && /revision/.test(error.message)) return t('materials.error.stale');
  if (error.code === 'VALIDATION' && isField(field)) return t(`materials.invalid.${field}`);
  return errorMessage(t, error);
}

export function MaterialsError({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <p role="alert" className="rounded-md bg-danger-subtle p-3 text-sm">
      {materialsErrorText(t, error)}
    </p>
  );
}

/** `YYYY-MM-DD` as the reader's date (the day itself, whatever the browser's zone). */
export function formatDay(day: string, lang: string, withYear = true): string {
  const at = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return day;
  return at.toLocaleDateString(lang, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

/** An olay's or a window's days: one day, or "start – end". */
export function formatRange(start: string, end: string, lang: string): string {
  if (start === end) return formatDay(start, lang);
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return `${formatDay(start, lang, !sameYear)} – ${formatDay(end, lang)}`;
}

/** An instant as Istanbul date and time. */
export function formatInstant(at: string, lang: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toLocaleString(lang, {
    timeZone: 'Europe/Istanbul',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The material's own words, else what it is. */
export function materialLabel(t: TFunction, material: m.Material): string {
  if (material.title.trim()) return material.title;
  return material.mime.startsWith('video/')
    ? t('materials.untitledVideo')
    : t('materials.untitledPhoto');
}

/** A photo, a video or another file: the medium's icon when no picture of it can be shown. */
export function MediaIcon({ mime, className = 'h-8 w-8' }: { mime: string; className?: string }) {
  const Icon = mime.startsWith('image/') ? ImageIcon : mime.startsWith('video/') ? Film : FileIcon;
  return <Icon aria-hidden="true" className={`${className} text-muted-foreground`} />;
}

/**
 * The picture of a medium: `url` when there is one (a file picked on this device), else its
 * icon. The server serves no material bytes to the panel, so stored materials show their icon.
 */
export function MediaThumb({ mime, url, alt }: { mime: string; url?: string | null; alt: string }) {
  if (url && mime.startsWith('image/')) {
    return (
      <img src={url} alt={alt} className="h-24 w-full rounded-md object-cover" loading="lazy" />
    );
  }
  return (
    <span
      role="img"
      aria-label={alt}
      className="flex h-24 w-full items-center justify-center rounded-md bg-surface-muted"
    >
      <MediaIcon mime={mime} />
    </span>
  );
}

/** What a person has to know of a material at a glance: permission, quality, origin, erasure. */
export function MaterialBadges({ material }: { material: m.Material }) {
  const { t } = useTranslation();
  if (material.erased_at) return <Badge tone="danger">{t('materials.erased')}</Badge>;
  return (
    <span className="flex flex-wrap gap-1">
      {material.share ? (
        <Badge tone={material.share.permission === 'not_shareable' ? 'danger' : 'success'}>
          {t(`materials.share.${material.share.permission}`)}
        </Badge>
      ) : (
        <Badge tone="warning">{t('materials.noPermission')}</Badge>
      )}
      {material.tags.quality && material.tags.quality !== 'publishable' && (
        <Badge tone="warning">{t(`materials.quality.${material.tags.quality}`)}</Badge>
      )}
      {material.origin.kind === 'ai_generated' && <Badge tone="info">{t('materials.ai')}</Badge>}
      {material.freed && material.binding.kind === 'olay' && (
        <Badge tone="primary">{t('materials.freedBadge')}</Badge>
      )}
      {!material.tags_reviewed_by && <Badge tone="neutral">{t('materials.suggestedBadge')}</Badge>}
    </span>
  );
}

/** A material as a tile of a grid: its picture or icon, its name and badges. */
export function MaterialTile({
  material,
  onOpen,
}: {
  material: m.Material;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const label = materialLabel(t, material);
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={() => onOpen(material.id)}
        className="flex w-full min-w-0 flex-col gap-2 rounded-md border border-border p-2 text-start hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MediaThumb mime={material.mime} alt={label} />
        <span className="truncate text-sm font-medium">{label}</span>
        <MaterialBadges material={material} />
      </button>
    </li>
  );
}

/** One column on a phone, two on a small tablet, more on a desk. */
export const gridClass = 'grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4';

/** One choice among a closed set, as large tappable chips. */
function Chips<T extends string>({
  legend,
  options,
  selected,
  onToggle,
  label,
  suggested,
}: {
  legend: string;
  options: readonly T[];
  selected: readonly T[];
  onToggle: (value: T) => void;
  label: (value: T) => string;
  suggested: boolean;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const on = selected.includes(o);
          return (
            <label
              key={o}
              className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm ${
                on ? 'border-primary bg-primary/10' : 'border-border'
              }`}
            >
              <input type="checkbox" checked={on} onChange={() => onToggle(o)} />
              {label(o)}
              {on && suggested && (
                <>
                  {' '}
                  <span className="text-micro text-muted-foreground">{t('materials.suggested')}</span>
                </>
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export const emptyTags = (): m.Tags => ({
  product_groups: [],
  doors: [],
  content_types: [],
  quality: null,
  depicts: [],
});

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/**
 * The tag groups of a material (spec §4.2). `suggested`: the values are an agent's suggestion no
 * person has reviewed yet, and each chosen one says so.
 */
export function TagsFields({
  value,
  onChange,
  suggested = false,
}: {
  value: m.Tags;
  onChange: (tags: m.Tags) => void;
  suggested?: boolean;
}) {
  const { t } = useTranslation();
  const qualityName = `quality-${suggested ? 's' : 'h'}`;
  return (
    <div className="space-y-4">
      <Chips
        legend={t('materials.tags.productGroups')}
        options={m.PRODUCT_GROUPS}
        selected={value.product_groups}
        onToggle={(v) => onChange({ ...value, product_groups: toggle(value.product_groups, v) })}
        label={(v) => t(`materials.productGroup.${v}`)}
        suggested={suggested}
      />
      <Chips
        legend={t('materials.tags.doors')}
        options={m.DOORS}
        selected={value.doors}
        onToggle={(v) => onChange({ ...value, doors: toggle(value.doors, v) })}
        label={(v) => t(`materials.door.${v}`)}
        suggested={suggested}
      />
      <Chips
        legend={t('materials.tags.contentTypes')}
        options={m.CONTENT_TYPES}
        selected={value.content_types}
        onToggle={(v) => onChange({ ...value, content_types: toggle(value.content_types, v) })}
        label={(v) => t(`materials.contentType.${v}`)}
        suggested={suggested}
      />
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('materials.tags.quality')}</legend>
        <div className="flex flex-wrap gap-2">
          {[...m.QUALITIES, null].map((q) => (
            <label
              key={q ?? 'none'}
              className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm ${
                value.quality === q ? 'border-primary bg-primary/10' : 'border-border'
              }`}
            >
              <input
                type="radio"
                name={qualityName}
                checked={value.quality === q}
                onChange={() => onChange({ ...value, quality: q })}
              />
              {q ? t(`materials.quality.${q}`) : t('materials.quality.none')}
              {q && value.quality === q && suggested && (
                <>
                  {' '}
                  <span className="text-micro text-muted-foreground">{t('materials.suggested')}</span>
                </>
              )}
            </label>
          ))}
        </div>
      </fieldset>
      <Chips
        legend={t('materials.tags.depicts')}
        options={m.DEPICTS}
        selected={value.depicts}
        onToggle={(v) => onChange({ ...value, depicts: toggle(value.depicts, v) })}
        label={(v) => t(`materials.depicts.${v}`)}
        suggested={suggested}
      />
    </div>
  );
}

/** What the olay fields hold while a person types them. */
export interface OlayDraft {
  kind: m.OlayKind;
  title: string;
  starts_on: string;
  /** Empty: a one-day olay. */
  ends_on: string;
  place: string;
  organization: string;
  notes: string;
  occasion: string;
}
export const emptyOlay = (day = ''): OlayDraft => ({
  kind: 'workshop',
  title: '',
  starts_on: day,
  ends_on: '',
  place: '',
  organization: '',
  notes: '',
  occasion: '',
});
export const draftOf = (o: m.Olay): OlayDraft => ({
  kind: o.kind,
  title: o.title,
  starts_on: o.starts_on,
  ends_on: o.ends_on === o.starts_on ? '' : o.ends_on,
  place: o.place ?? '',
  organization: o.client?.organization ?? '',
  notes: o.notes,
  occasion: o.occasion ?? '',
});

/** What is wrong with a draft before it is sent (the server checks the same and more). */
export function olayDraftProblem(d: OlayDraft): 'title' | 'dates' | 'occasion' | null {
  if (!d.title.trim()) return 'title';
  if (!d.starts_on || (d.ends_on && d.ends_on < d.starts_on)) return 'dates';
  if (m.isSeasonal(d.kind) && !d.occasion) return 'occasion';
  return null;
}

/** The draft as the server takes it. A client person link stays as it was (not edited here). */
export function olayInput(d: OlayDraft, client?: m.OlayClient | null): m.OlayInput {
  const organization = d.organization.trim();
  const person = client?.person_id ?? null;
  return {
    kind: d.kind,
    title: d.title.trim(),
    starts_on: d.starts_on,
    ends_on: d.ends_on || d.starts_on,
    place: d.place.trim() || null,
    client: organization || person ? { person_id: person, organization: organization || null } : null,
    notes: d.notes.trim(),
    occasion: m.isSeasonal(d.kind) ? d.occasion : null,
  };
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span>{label}</span>
      {children}
    </label>
  );
}

/**
 * An olay's fields (type, title, one day or a range, place, client, notes; the calendar occasion
 * of a season or special day). `occasions` are the calendar's entries to choose from.
 */
export function OlayFields({
  value,
  onChange,
  occasions,
}: {
  value: OlayDraft;
  onChange: (draft: OlayDraft) => void;
  occasions: m.CalendarEntry[];
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<OlayDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Labelled label={t('materials.olay.kind')}>
        <select
          className={fieldClass}
          value={value.kind}
          onChange={(e) => set({ kind: e.target.value as m.OlayKind })}
        >
          {m.OLAY_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`materials.kind.${k}`)}
            </option>
          ))}
        </select>
      </Labelled>
      <Labelled label={t('materials.olay.title')}>
        <input
          className={fieldClass}
          value={value.title}
          maxLength={120}
          onChange={(e) => set({ title: e.target.value })}
        />
      </Labelled>
      <Labelled label={t('materials.olay.startsOn')}>
        <input
          className={fieldClass}
          type="date"
          value={value.starts_on}
          onChange={(e) => set({ starts_on: e.target.value })}
        />
      </Labelled>
      <Labelled label={t('materials.olay.endsOn')}>
        <input
          className={fieldClass}
          type="date"
          value={value.ends_on}
          min={value.starts_on || undefined}
          onChange={(e) => set({ ends_on: e.target.value })}
        />
      </Labelled>
      {m.isSeasonal(value.kind) && (
        <Labelled label={t('materials.olay.occasion')}>
          <select
            className={fieldClass}
            value={value.occasion}
            onChange={(e) => set({ occasion: e.target.value })}
          >
            <option value="">{t('materials.olay.chooseOccasion')}</option>
            {occasions.map((o) => (
              <option key={o.key} value={o.key}>
                {o.name}
              </option>
            ))}
          </select>
        </Labelled>
      )}
      <Labelled label={t('materials.olay.place')}>
        <input
          className={fieldClass}
          value={value.place}
          maxLength={120}
          onChange={(e) => set({ place: e.target.value })}
        />
      </Labelled>
      <Labelled label={t('materials.olay.organization')}>
        <input
          className={fieldClass}
          value={value.organization}
          maxLength={120}
          onChange={(e) => set({ organization: e.target.value })}
        />
      </Labelled>
      <div className="sm:col-span-2">
        <Labelled label={t('materials.olay.notes')}>
          <textarea
            className={fieldClass}
            rows={3}
            value={value.notes}
            maxLength={2000}
            onChange={(e) => set({ notes: e.target.value })}
          />
        </Labelled>
      </div>
      <p className="text-xs text-muted-foreground sm:col-span-2">{t('materials.olay.oneDayHint')}</p>
    </div>
  );
}

/** The olay's type, days and place, on one line. */
export function OlayLine({ olay }: { olay: m.Olay }) {
  const { t, i18n } = useTranslation();
  return (
    <span className="text-sm text-muted-foreground">
      {t(`materials.kind.${olay.kind}`)} · {formatRange(olay.starts_on, olay.ends_on, i18n.language)}
      {olay.place ? ` · ${olay.place}` : ''}
    </span>
  );
}

/** "Onay bekliyor" for a proposed olay. */
export function ProposedBadge({ olay }: { olay: m.Olay }) {
  const { t } = useTranslation();
  if (olay.status !== 'proposed') return null;
  return <Badge tone="warning">{t('materials.olay.awaiting')}</Badge>;
}
