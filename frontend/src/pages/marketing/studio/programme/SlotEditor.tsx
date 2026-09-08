import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { BarChart3, Clapperboard, RefreshCw, Save, SkipForward } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Textarea } from '@/components/ui/Textarea';
import { Badge } from '@/components/ui/Badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import type { SlotPatch, SlotView, TypeView } from '../../../../features/marketing/api/contentProgramme.service';

/**
 * What the API said went wrong, or the fallback. Nest returns `message` as a
 * string or, from a validation pipe, as an array of strings — both are read.
 */
export const errorMessage = (e: unknown, fallback: string): string => {
  const err = e as { response?: { data?: { message?: unknown } }; message?: unknown };
  const fromApi = err?.response?.data?.message;
  if (typeof fromApi === 'string' && fromApi) return fromApi;
  if (Array.isArray(fromApi) && fromApi.length) return fromApi.map(String).join(' ');
  return fallback;
};

/** `<input type="datetime-local">` wants local wall-clock time with no zone. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** …and back: the local wall-clock the person typed, as the instant it names. */
export function fromLocalInput(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Only what CHANGED, trimmed. The backend treats every present field as an
 * override and logs each one as an owner edit, so re-sending an unchanged
 * type would write "owner override" over a selection reason that was the
 * engine's — and that reason is what the learning tab audits.
 */
export function slotDiff(slot: SlotView, draft: { contentTypeKey: string; idea: string; local: string }): SlotPatch {
  const patch: SlotPatch = {};
  if (draft.contentTypeKey && draft.contentTypeKey !== slot.contentTypeKey) patch.contentTypeKey = draft.contentTypeKey;
  const idea = draft.idea.trim();
  if (idea && idea !== slot.idea.trim()) patch.idea = idea;
  const when = fromLocalInput(draft.local);
  if (when && when !== new Date(slot.scheduledFor).toISOString()) patch.scheduledFor = when;
  return patch;
}

/** Hours left in the edit window, rounded up; 0 once it has closed. */
export function hoursLeft(editableUntil: string, now: Date): number {
  const ms = new Date(editableUntil).getTime() - now.getTime();
  return ms > 0 ? Math.ceil(ms / (60 * 60 * 1000)) : 0;
}

export interface SlotEditorProps {
  slot: SlotView;
  types: TypeView[];
  now: Date;
  busy?: boolean;
  onSave: (patch: SlotPatch) => void;
  onSkip: () => void;
  onRegenerate: () => void;
  onMetrics: () => void;
  onClose: () => void;
}

/**
 * The inline editor under the strip: type, idea, time, and the three actions.
 *
 * Nothing here asks for approval — the programme is autonomous by design
 * (K3) — so the editor's job is to make the WINDOW visible: how long the slot
 * can still be changed, and which fields. A READY slot has its clips in hand,
 * so changing its type or idea would mean throwing them away; only the time
 * is still open there, and the form says so rather than greying out silently.
 */
export function SlotEditor({ slot, types, now, busy, onSave, onSkip, onRegenerate, onMetrics, onClose }: SlotEditorProps) {
  const { t } = useTranslation('marketing');
  const id = useId();
  const [contentTypeKey, setType] = useState(slot.contentTypeKey);
  const [idea, setIdea] = useState(slot.idea);
  const [local, setLocal] = useState(toLocalInput(slot.scheduledFor));

  // A fresh slot is a fresh draft: a half-typed idea for Tuesday must not
  // survive a click on Thursday's chip.
  useEffect(() => {
    setType(slot.contentTypeKey);
    setIdea(slot.idea);
    setLocal(toLocalInput(slot.scheduledFor));
  }, [slot.id, slot.contentTypeKey, slot.idea, slot.scheduledFor]);

  const ready = slot.status === 'READY';
  const editable = slot.editable;
  const textLocked = !editable || ready;
  const left = hoursLeft(slot.editableUntil, now);
  const patch = slotDiff(slot, { contentTypeKey, idea, local });
  const dirty = Object.keys(patch).length > 0;
  const activeTypes = types.filter((ty) => ty.active || ty.key === slot.contentTypeKey);

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-muted/40 p-3"
      data-testid="programme-slot-editor"
      aria-label={t('studio.programme.editor.title', 'Slot düzenleyici')}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone="neutral">{t(`studio.programme.slotStatus.${slot.status}`, slot.status)}</Badge>
        {slot.trendTitle && (
          <Badge tone="info" title={t('studio.programme.editor.trend', 'Trend kancası')}>
            {slot.trendTitle}
          </Badge>
        )}
        <span className="text-muted-foreground" data-testid="programme-slot-window">
          {editable
            ? t('studio.programme.editor.window', 'Düzenleme penceresi: {{hours}} saat kaldı', { hours: left })
            : t('studio.programme.editor.frozen', 'Düzenleme penceresi kapandı; slot olduğu gibi yayınlanır.')}
        </span>
        {ready && editable && (
          <span className="text-muted-foreground">
            {t('studio.programme.editor.readyHint', 'Klipler hazır: yalnızca saat değişebilir.')}
          </span>
        )}
        <Button variant="ghost" size="sm" className="ms-auto" onClick={onClose}>
          {t('common.close', 'Kapat')}
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-[minmax(10rem,14rem)_1fr_minmax(10rem,14rem)]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-type`}>{t('studio.programme.editor.type', 'Tür')}</Label>
          <Select value={contentTypeKey} onValueChange={setType} disabled={textLocked}>
            <SelectTrigger id={`${id}-type`} aria-label={t('studio.programme.editor.type', 'Tür')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {activeTypes.map((ty) => (
                <SelectItem key={ty.id} value={ty.key}>
                  {ty.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-idea`}>{t('studio.programme.editor.idea', 'Fikir')}</Label>
          <Textarea
            id={`${id}-idea`}
            rows={3}
            value={idea}
            disabled={textLocked}
            onChange={(e) => setIdea(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-when`}>{t('studio.programme.editor.when', 'Yayın zamanı')}</Label>
          <Input
            id={`${id}-when`}
            type="datetime-local"
            value={local}
            disabled={!editable}
            onChange={(e) => setLocal(e.target.value)}
          />
        </div>
      </div>

      {slot.concept && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{slot.concept.title}</span>
          {' — '}
          {slot.concept.hook}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!editable || !dirty || busy} onClick={() => onSave(patch)}>
          <Save className="me-1.5 h-4 w-4" aria-hidden="true" />
          {t('studio.programme.editor.save', 'Kaydet')}
        </Button>
        <Button size="sm" variant="outline" disabled={!editable || busy} onClick={onSkip}>
          <SkipForward className="me-1.5 h-4 w-4" aria-hidden="true" />
          {t('studio.programme.editor.skip', 'Atla')}
        </Button>
        <Button size="sm" variant="outline" disabled={!editable || busy} onClick={onRegenerate}>
          <RefreshCw className="me-1.5 h-4 w-4" aria-hidden="true" />
          {t('studio.programme.editor.regenerate', 'Yeniden üret')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onMetrics}>
          <BarChart3 className="me-1.5 h-4 w-4" aria-hidden="true" />
          {t('studio.programme.editor.metrics', 'Metrikler')}
        </Button>
        {slot.conceptId && (
          // The storyboard is edited in the content line's own editor; the
          // panel deep-links there rather than growing a second one.
          <Button size="sm" variant="ghost" asChild>
            <Link to="/studio?tool=line">
              <Clapperboard className="me-1.5 h-4 w-4" aria-hidden="true" />
              {t('studio.programme.editor.storyboard', "Storyboard'u aç")}
            </Link>
          </Button>
        )}
        <span className="ms-auto text-xs text-muted-foreground">
          {t('studio.programme.editor.noApproval', 'Her şey düzenlenebilir; hiçbir adım onay beklemez.')}
        </span>
      </div>
    </div>
  );
}

export default SlotEditor;
