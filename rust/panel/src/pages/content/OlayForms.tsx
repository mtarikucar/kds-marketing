import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as m from '@/api/materials';
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui';
import {
  MaterialsError,
  OlayFields,
  draftOf,
  emptyOlay,
  olayDraftProblem,
  olayInput,
  useMaterialsKey,
  useMaterialsMutation,
  type OlayDraft,
} from '../materials/MaterialsShared';

/** An owner or manager confirms a proposed olay: from then on its materials may be used (D3). */
export function ConfirmOlay({ olay }: { olay: m.Olay }) {
  const { t } = useTranslation();
  const confirm = useMaterialsMutation(() => m.olayConfirm(olay.id, olay.revision));
  return (
    <div className="space-y-1">
      <Button loading={confirm.isPending} onClick={() => { if (!confirm.isPending) confirm.mutate(undefined); }}>
        {t('materials.olay.confirm')}
      </Button>
      <MaterialsError error={confirm.error} />
    </div>
  );
}

/**
 * Creates an olay (`initial` may prefill it, e.g. from a coming special day), or changes one at
 * its revision. A person who is an owner or manager creates it confirmed; anyone else proposes it.
 */
export function OlayDialog({
  olay,
  initial,
  onClose,
  onSaved,
}: {
  olay?: m.Olay;
  initial?: OlayDraft;
  onClose: () => void;
  onSaved?: (olay: m.Olay) => void;
}) {
  const { t } = useTranslation();
  const key = useMaterialsKey();
  const [draft, setDraft] = useState<OlayDraft>(() => (olay ? draftOf(olay) : initial ?? emptyOlay()));
  const [problem, setProblem] = useState<'title' | 'dates' | 'occasion' | null>(null);
  const requestKey = useRef<string | null>(null);
  const year = Number((draft.starts_on || m.istanbulDay(new Date())).slice(0, 4));
  const calendar = useQuery({
    queryKey: [...key, 'calendar', year],
    queryFn: () => m.calendarList(year),
    enabled: m.isSeasonal(draft.kind),
  });
  const save = useMaterialsMutation(
    () => {
      const input = olayInput(draft, olay?.client);
      if (olay) return m.olayUpdate(olay.id, olay.revision, input);
      requestKey.current ??= crypto.randomUUID();
      return m.olayCreate({ ...input, request_key: requestKey.current });
    },
    (saved) => {
      onSaved?.(saved);
      onClose();
    },
  );
  const title = t(olay ? 'materials.olay.edit' : 'materials.olay.new');
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !save.isPending) onClose(); }}>
      <DialogContent dismissible={!save.isPending} className="max-w-2xl">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{t(olay ? 'content.olay.editHelp' : 'content.olay.newHelp')}</DialogDescription>
        <form
          aria-label={title}
          className="min-w-0 space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (save.isPending) return;
            const p = olayDraftProblem(draft);
            setProblem(p);
            if (!p) save.mutate(undefined);
          }}
        >
          <OlayFields
            value={draft}
            onChange={(d) => {
              setDraft(d);
              requestKey.current = null;
            }}
            occasions={calendar.data?.entries ?? []}
          />
          {problem && <p role="alert" className="text-sm text-danger">{t(`content.olay.problem.${problem}`)}</p>}
          <MaterialsError error={save.error} />
          <Button type="submit" loading={save.isPending}>{olay ? t('materials.olay.save') : t('materials.olay.create')}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
