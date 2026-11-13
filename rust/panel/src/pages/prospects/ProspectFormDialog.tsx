import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { isApiError } from '@/api/client';
import { createProspect, updateProspect } from '@/api/prospects';
import type { EntityKind, Prospect } from '@/api/types';
import { ErrorCallout } from '@/components/ErrorCallout';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Textarea,
  toast,
} from '@/components/ui';
import { useInFlight } from '@/lib/leads';
import { selectClass } from '../InboxShared';
import { useLeadsRefresh } from '../LeadsShared';
import { usePoolCopy, type PoolCopyKey } from './copy';
import {
  CONTACT_FIELDS,
  createBody,
  draftOf,
  problemsOf,
  updateBody,
  type ContactField,
  type DraftField,
  type DraftProblem,
  type ProspectDraft,
} from './form';
import type { SegmentOption } from './segments';

const ENTITY_KINDS: readonly EntityKind[] = ['unknown_business', 'legal_entity', 'sole_trader'];

const PROBLEM_COPY: Record<DraftProblem, PoolCopyKey> = {
  required: 'pRequired',
  tooLong: 'pTooLong',
  email: 'pEmail',
  tooManyLabels: 'pTooManyLabels',
  labelTooLong: 'pLabelTooLong',
  nameFirst: 'pNameFirst',
};

/** The form field a server refusal's `details.field` names (`jt_prospects` field names). */
const SERVER_FIELD: Record<string, DraftField> = {
  business_name: 'business_name',
  segment_key: 'segment_key',
  sector: 'sector',
  city: 'city',
  district: 'district',
  labels: 'labels',
  phone: 'phone',
  email: 'email',
  website: 'website',
  instagram: 'instagram',
  tiktok: 'tiktok',
  address: 'address',
  contact_person: 'contact_name',
  notes: 'notes',
  discovered_at: 'source',
};

const CONTACT_HINT: Partial<Record<ContactField, PoolCopyKey>> = {
  website: 'fWebsiteHint',
  instagram: 'fHandleHint',
  tiktok: 'fHandleHint',
};

/** A key that lets the server replay a create sent twice (a retry after a lost answer). */
function newRequestKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `panel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * A person's own form for the pool: with no `prospect` it records a new one
 * (`POST /api/prospects`), with one it changes its details (`PATCH /api/prospects/{id}`). The
 * business name and kind are fixed once recorded (`jt_prospects::UpdateInput`). Every contact
 * value the person types carries their one source note as its evidence.
 */
export function ProspectFormDialog({
  prospect,
  segments,
  onClose,
  onSaved,
}: {
  prospect?: Prospect;
  segments: readonly SegmentOption[];
  onClose: () => void;
  onSaved?: (saved: Prospect) => void;
}) {
  const { t } = useTranslation();
  const copy = usePoolCopy();
  const refresh = useLeadsRefresh();
  const guard = useInFlight();
  const mode = prospect ? 'edit' : 'create';
  const [draft, setDraft] = useState<ProspectDraft>(() => draftOf(prospect, copy('sourceDefault')));
  const [tried, setTried] = useState(false);
  const [requestKey] = useState(newRequestKey);

  const save = useMutation({
    mutationFn: async () => {
      // A minute back: the server refuses a capture time ahead of its own clock.
      const at = new Date(Date.now() - 60_000).toISOString();
      if (!prospect) return createProspect(createBody(draft, at, requestKey));
      const body = updateBody(prospect, draft, at);
      return body ? updateProspect(prospect.id, body) : null;
    },
    onSuccess: async (out) => {
      if (out) {
        toast.success(copy(prospect ? 'detailsSaved' : 'added'));
        if (out.flags.length > 0) toast.info(copy('similar'));
        await refresh();
        onSaved?.(out.prospect);
      }
      onClose();
    },
  });

  const problems = problemsOf(draft, mode);
  const changed = !prospect || updateBody(prospect, draft, '') !== null;
  const refusal = isApiError(save.error) ? save.error : null;
  const refusedField = refusal?.code === 'VALIDATION' && typeof refusal.details.field === 'string' ? SERVER_FIELD[refusal.details.field] : undefined;
  const holder = refusal?.details.reason === 'duplicate' && typeof refusal.details.prospect_id === 'string' ? refusal.details.prospect_id : null;

  const errorOf = (name: DraftField): string | undefined => {
    const problem = tried ? problems[name] : undefined;
    if (problem) return copy(PROBLEM_COPY[problem]);
    return refusedField === name ? copy('pServer') : undefined;
  };
  const change = (name: DraftField, value: string) => {
    setDraft((d) => ({ ...d, [name]: value }));
    if (save.error) save.reset();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (Object.keys(problems).length > 0 || !changed) return;
    guard((release) => save.mutate(undefined, { onSettled: release }));
  };

  const text = (name: DraftField, label: string, opts: { required?: boolean; hint?: string; type?: string; autoFocus?: boolean } = {}) => (
    <Field label={label} required={opts.required} hint={opts.hint} error={errorOf(name)}>
      {({ id, describedBy, invalid }) => (
        <Input
          id={id}
          type={opts.type}
          autoComplete="off"
          autoFocus={opts.autoFocus}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          value={draft[name]}
          onChange={(e) => change(name, e.target.value)}
        />
      )}
    </Field>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{prospect ? copy('editTitle', { name: prospect.business_name }) : copy('addTitle')}</DialogTitle>
          <DialogDescription>{copy(prospect ? 'editBody' : 'addBody')}</DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-col gap-4" onSubmit={submit} noValidate aria-label={copy(prospect ? 'editDetails' : 'addTitle')}>
          <div className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto pe-1">
            <fieldset className="grid gap-3 sm:grid-cols-2">
              <legend className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{copy('business')}</legend>
              {!prospect && (
                <>
                  {text('business_name', copy('fName'), { required: true, autoFocus: true })}
                  <Field label={copy('fKind')}>
                    {({ id }) => (
                      <select id={id} className={selectClass} value={draft.entity_kind} onChange={(e) => change('entity_kind', e.target.value)}>
                        {ENTITY_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {t(`leads.entityKinds.${k}`)}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                </>
              )}
              <Field label={copy('fSegment')} error={errorOf('segment_key')}>
                {({ id }) => (
                  <select id={id} className={selectClass} value={draft.segment_key} onChange={(e) => change('segment_key', e.target.value)}>
                    <option value="">{copy('fNoSegment')}</option>
                    {segments.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {text('sector', copy('fSector'))}
              {text('city', copy('fCity'))}
              {text('district', copy('fDistrict'))}
              <div className="sm:col-span-2">{text('labels', t('leads.prospect.labels'), { hint: copy('fLabelsHint') })}</div>
            </fieldset>

            <fieldset className="grid gap-3 sm:grid-cols-2">
              <legend className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{copy('contact')}</legend>
              {CONTACT_FIELDS.map((k) => {
                const hint = CONTACT_HINT[k];
                return (
                  <div key={k} className={k === 'address' ? 'sm:col-span-2' : undefined}>
                    {text(k, t(`leads.fields.${k}`), { hint: hint && copy(hint), type: k === 'email' ? 'email' : k === 'phone' ? 'tel' : undefined })}
                  </div>
                );
              })}
              {text('contact_name', copy('fContactName'))}
              {text('contact_role', copy('fContactRole'))}
              <div className="sm:col-span-2">{text('source', copy('fSource'), { required: true, hint: copy('fSourceHint') })}</div>
            </fieldset>

            {!prospect && (
              <Field label={copy('notes')} error={errorOf('notes')}>
                {({ id, describedBy, invalid }) => (
                  <Textarea
                    id={id}
                    rows={3}
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    value={draft.notes}
                    onChange={(e) => change('notes', e.target.value)}
                  />
                )}
              </Field>
            )}
          </div>

          {refusal && !refusedField && (
            <div className="flex flex-col gap-1.5">
              <ErrorCallout error={save.error} />
              {holder && (
                <Link className="text-sm text-primary hover:underline" to={`/prospects/${encodeURIComponent(holder)}`} onClick={onClose}>
                  {copy('openExisting')}
                </Link>
              )}
            </div>
          )}
          {!refusal && save.error ? <ErrorCallout error={save.error} /> : null}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>
              {copy('cancel')}
            </Button>
            <Button type="submit" disabled={!changed} loading={save.isPending}>
              {prospect ? copy('save') : copy('addProspect')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
