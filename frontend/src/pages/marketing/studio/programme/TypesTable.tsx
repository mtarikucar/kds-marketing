import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Switch } from '@/components/ui/Switch';
import { Textarea } from '@/components/ui/Textarea';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/Table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { cn } from '@/components/ui/cn';
import {
  createType,
  programmeKeys,
  updateType,
  type TypeView,
  type UpdateContentTypeInput,
} from '../../../../features/marketing/api/contentProgramme.service';
import { errorMessage } from './SlotEditor';
import { typeColour } from './SlotStrip';

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** A share typed by hand, clamped to what the engine accepts (0..1, two decimals). */
function parseShare(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
}

/**
 * Two thin bars on one row — what the calendar HOLDS for a type right now and
 * what the engine has LEARNED it deserves. When they disagree the next plan
 * sweep moves the first toward the second; seeing both is how an owner tells
 * "the engine wants more of this" from "the engine has not caught up yet".
 */
function ShareBars({ planned, weight, colour }: { planned: number; weight: number; colour: string }) {
  const { t } = useTranslation('marketing');
  return (
    <div className="flex min-w-[8rem] flex-col gap-1" aria-hidden="true">
      <div className="flex items-center gap-2 text-micro text-muted-foreground">
        <span className="w-14 shrink-0">{t('studio.programme.types.planned', 'Planlanan')}</span>
        <div className="h-1.5 flex-1 rounded-full bg-border">
          <div className={cn('h-full rounded-full border', colour)} style={{ width: pct(planned) }} />
        </div>
        <span className="w-9 text-end tabular-nums">{pct(planned)}</span>
      </div>
      <div className="flex items-center gap-2 text-micro text-muted-foreground">
        <span className="w-14 shrink-0">{t('studio.programme.types.learned', 'Öğrenilen')}</span>
        <div className="h-1.5 flex-1 rounded-full bg-border">
          <div className="h-full rounded-full bg-primary" style={{ width: pct(weight) }} />
        </div>
        <span className="w-9 text-end tabular-nums">{pct(weight)}</span>
      </div>
    </div>
  );
}

/**
 * One share field, saved ON BLUR rather than on every keystroke: a share is a
 * number a person types in two or three strokes, and PATCHing "0", then "0.",
 * then "0.1" would log three owner edits for one decision.
 */
function ShareInput({
  value,
  label,
  onCommit,
}: {
  value: number;
  label: string;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [seen, setSeen] = useState(value);
  // A row re-rendered with a fresh server value (someone else saved, or the
  // same person on another tab) resets the draft — the field is not the
  // source of truth, the row is.
  if (seen !== value) {
    setSeen(value);
    setDraft(String(value));
  }
  return (
    <Input
      type="number"
      min={0}
      max={1}
      step={0.05}
      value={draft}
      aria-label={label}
      className="h-8 w-20 px-2 text-xs"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = parseShare(draft);
        if (next === null) return setDraft(String(value));
        if (next !== value) onCommit(next);
      }}
    />
  );
}

export interface TypesTableProps {
  programmeId: string;
  types: TypeView[];
}

/**
 * The formats the programme rotates through, every column of which an owner
 * may change in place: on/off, the floor and ceiling of the calendar a type
 * may take, and — through the small dialog — a new type of their own. The
 * numbers on the right (samples, mean reward) are the engine's and are read
 * only; editing a reward is not a thing.
 */
export function TypesTable({ programmeId, types }: TypesTableProps) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: programmeKeys.root });
  const fallback = t('studio.programme.types.saveFailed', 'Tür kaydedilemedi.');

  const patch = useMutation({
    mutationFn: ({ typeId, body }: { typeId: string; body: UpdateContentTypeInput }) =>
      updateType(programmeId, typeId, body),
    onSuccess: invalidate,
    onError: (e) => toast.error(errorMessage(e, fallback)),
  });

  const [adding, setAdding] = useState(false);

  return (
    <div className="flex flex-col gap-3" data-testid="programme-types">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t(
            'studio.programme.types.hint',
            'Taban ve tavan, öğrenme başladıktan sonra bir türün takvimden alabileceği payı sınırlar. Kaydetmek için alandan çıkın.',
          )}
        </p>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus className="me-1.5 h-4 w-4" aria-hidden="true" />
          {t('studio.programme.types.add', 'Tür ekle')}
        </Button>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <THead>
            <TR>
              <TH>{t('studio.programme.types.name', 'Tür')}</TH>
              <TH>{t('studio.programme.types.active', 'Aktif')}</TH>
              <TH>{t('studio.programme.types.share', 'Pay: planlanan / öğrenilen')}</TH>
              <TH numeric>{t('studio.programme.types.minShare', 'Taban')}</TH>
              <TH numeric>{t('studio.programme.types.maxShare', 'Tavan')}</TH>
              <TH numeric>{t('studio.programme.types.samples', 'Örnek')}</TH>
              <TH numeric>{t('studio.programme.types.meanReward', 'Ort. ödül')}</TH>
            </TR>
          </THead>
          <TBody>
            {types.map((ty) => (
              <TR key={ty.id} data-testid="programme-type-row" className={cn(!ty.active && 'opacity-60')}>
                <TD>
                  <div className="flex items-center gap-2">
                    <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full border', typeColour(ty.key))} aria-hidden="true" />
                    <div className="flex flex-col">
                      <span className="font-medium">{ty.name}</span>
                      <span className="text-micro text-muted-foreground">
                        {ty.key} · {ty.defaultDurationSec}s
                        {ty.networks.length > 0 && ` · ${ty.networks.join(', ')}`}
                      </span>
                    </div>
                  </div>
                </TD>
                <TD>
                  <Switch
                    checked={ty.active}
                    aria-label={t('studio.programme.types.activeFor', '{{name}} aktif', { name: ty.name })}
                    onCheckedChange={(active) => patch.mutate({ typeId: ty.id, body: { active } })}
                  />
                </TD>
                <TD>
                  <ShareBars planned={ty.plannedShare} weight={ty.weight} colour={typeColour(ty.key)} />
                </TD>
                <TD numeric>
                  <ShareInput
                    value={ty.minShare}
                    label={t('studio.programme.types.minShareFor', '{{name}} taban payı', { name: ty.name })}
                    onCommit={(minShare) => patch.mutate({ typeId: ty.id, body: { minShare } })}
                  />
                </TD>
                <TD numeric>
                  <ShareInput
                    value={ty.maxShare}
                    label={t('studio.programme.types.maxShareFor', '{{name}} tavan payı', { name: ty.name })}
                    onCommit={(maxShare) => patch.mutate({ typeId: ty.id, body: { maxShare } })}
                  />
                </TD>
                <TD numeric>{ty.samples}</TD>
                <TD numeric>{ty.meanReward == null ? '—' : ty.meanReward.toFixed(2)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>

      <AddTypeDialog programmeId={programmeId} open={adding} onOpenChange={setAdding} />
    </div>
  );
}

function AddTypeDialog({
  programmeId,
  open,
  onOpenChange,
}: {
  programmeId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const id = useId();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [duration, setDuration] = useState('15');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      createType(programmeId, {
        key: key.trim(),
        name: name.trim(),
        description: description.trim() || undefined,
        defaultDurationSec: Number(duration) || 15,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: programmeKeys.root });
      setKey('');
      setName('');
      setDescription('');
      setDuration('15');
      onOpenChange(false);
    },
    onError: (e) => setError(errorMessage(e, t('studio.programme.types.addFailed', 'Tür eklenemedi.'))),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('studio.programme.types.addTitle', 'Yeni içerik türü')}</DialogTitle>
          <DialogDescription>
            {t('studio.programme.types.addDescription', 'Yeni tür tohum evresinde sıraya girer; pay sınırları varsayılan %5–%40 ile başlar.')}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (!key.trim() || !name.trim()) {
              setError(t('studio.programme.types.needKeyName', 'Anahtar ve ad zorunlu.'));
              return;
            }
            create.mutate();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-key`}>{t('studio.programme.types.key', 'Anahtar (slug)')}</Label>
            <Input id={`${id}-key`} value={key} onChange={(e) => setKey(e.target.value)} placeholder="behind-the-scenes" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-name`}>{t('studio.programme.types.name', 'Tür')}</Label>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-desc`}>{t('studio.programme.types.description', 'Açıklama')}</Label>
            <Textarea id={`${id}-desc`} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-dur`}>{t('studio.programme.types.duration', 'Süre (saniye)')}</Label>
            <Input id={`${id}-dur`} type="number" min={3} max={120} value={duration} onChange={(e) => setDuration(e.target.value)} />
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel', 'Vazgeç')}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t('studio.programme.types.add', 'Tür ekle')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default TypesTable;
