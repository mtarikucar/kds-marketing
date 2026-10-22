import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { setHypotheses } from '@/api/strategy';
import { ANY_CHANNEL, type Hypothesis, type HypothesisInput, type HypothesisState, type Segment } from '@/api/types';
import { ErrorCallout } from '@/components/ErrorCallout';
import { GapList } from '@/components/GapList';
import { HypothesisTable } from '@/components/HypothesisTable';
import { KindSelect } from '@/components/KindSelect';
import { HypothesisStateBadge } from '@/components/StatusBadges';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
  toast,
} from '@/components/ui';
import { gapsOf } from '@/lib/errors';
import { invalidateStrategy } from './queries';

/** One hypothesis as edited: `id` when it already exists, `retired` when left out of the write. */
interface Row {
  id?: string;
  state?: HypothesisState;
  title: string;
  segment_key: string;
  angle: string;
  channel: string;
  metric: string;
  /** As typed; read as a number between 0 and 1 on save. */
  confidence: string;
  retired: boolean;
}

function toRow(h: Hypothesis): Row {
  return {
    id: h.id,
    state: h.state,
    title: h.title,
    segment_key: h.segment_key,
    angle: h.angle,
    channel: h.channel,
    metric: h.metric,
    confidence: String(h.confidence),
    retired: h.state === 'retired',
  };
}

/**
 * The write: every row not retired, each kept one with its `id`, each new one without. The server
 * retires what the approved version had and the list leaves out, and drops a new one left out.
 */
function toInputs(rows: readonly Row[]): HypothesisInput[] {
  return rows
    .filter((r) => !r.retired)
    .map((r) => {
      const input: HypothesisInput = {
        title: r.title,
        segment_key: r.segment_key,
        angle: r.angle,
        channel: r.channel,
        metric: r.metric,
        confidence: Number(r.confidence.replace(',', '.')) || 0,
      };
      return r.id ? { id: r.id, ...input } : input;
    });
}

export function HypothesesSection({
  hypotheses,
  segments,
  channels,
  editable,
}: {
  hypotheses: readonly Hypothesis[];
  segments: readonly Segment[];
  /** The strategy's channel keys, offered first for a hypothesis. */
  channels: readonly string[];
  editable: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Row[] | null>(null);
  const save = useMutation({
    mutationFn: setHypotheses,
    onSuccess: async () => {
      setRows(null);
      toast.success(t('strategy.hypotheses.saved'));
      await invalidateStrategy(queryClient);
    },
  });
  const update = (index: number, patch: Partial<Row>) =>
    setRows((current) => current && current.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const channelChoices = channels.length > 0 ? [...channels, ANY_CHANNEL] : undefined;
  const gaps = gapsOf(save.error);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>{t('strategy.sections.hypotheses')}</CardTitle>
        {editable && rows === null && (
          <Button variant="ghost" size="sm" onClick={() => setRows(hypotheses.map(toRow))}>
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            {t('strategy.hypotheses.edit')}
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {rows === null ? (
          <HypothesisTable hypotheses={hypotheses} segments={segments} />
        ) : (
          <form
            className="flex flex-col gap-3"
            aria-label={t('strategy.sections.hypotheses')}
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(toInputs(rows));
            }}
          >
            {rows.map((row, index) => (
              <fieldset
                key={row.id ?? `new-${index}`}
                className={cn('flex flex-col gap-3 rounded-lg border border-border p-3', row.retired && 'opacity-60')}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <HypothesisStateBadge state={row.retired ? 'retired' : (row.state ?? 'added')} />
                  {row.id ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => update(index, { retired: !row.retired })}
                    >
                      {row.retired ? (
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      {row.retired ? t('strategy.hypotheses.restore') : t('strategy.hypotheses.retire')}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setRows(rows.filter((_, i) => i !== index))}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('strategy.remove')}
                    </Button>
                  )}
                </div>
                {!row.retired && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t('strategy.hypotheses.columns.title')} required className="sm:col-span-2">
                      {(ids) => <Input id={ids.id} value={row.title} onChange={(e) => update(index, { title: e.target.value })} />}
                    </Field>
                    <Field label={t('strategy.hypotheses.columns.segment')} required>
                      {(ids) => (
                        <Select value={row.segment_key} onValueChange={(segment_key) => update(index, { segment_key })}>
                          <SelectTrigger id={ids.id}>
                            <SelectValue placeholder={t('strategy.hypotheses.segmentPlaceholder')} />
                          </SelectTrigger>
                          <SelectContent>
                            {segments.map((s) => (
                              <SelectItem key={s.key} value={s.key}>
                                {s.name || s.key}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </Field>
                    <Field label={t('strategy.hypotheses.columns.channel')} required>
                      {(ids) => (
                        <KindSelect
                          id={ids.id}
                          withAny
                          only={channelChoices}
                          value={row.channel}
                          placeholder={t('strategy.channelPlaceholder')}
                          onChange={(channel) => update(index, { channel })}
                        />
                      )}
                    </Field>
                    <Field label={t('strategy.hypotheses.columns.angle')} required>
                      {(ids) => <Input id={ids.id} value={row.angle} onChange={(e) => update(index, { angle: e.target.value })} />}
                    </Field>
                    <Field label={t('strategy.hypotheses.columns.metric')} required>
                      {(ids) => <Input id={ids.id} value={row.metric} onChange={(e) => update(index, { metric: e.target.value })} />}
                    </Field>
                    <Field label={t('strategy.hypotheses.columns.confidence')} hint={t('strategy.hypotheses.confidenceHint')}>
                      {(ids) => (
                        <Input
                          id={ids.id}
                          aria-describedby={ids.describedBy}
                          type="number"
                          inputMode="decimal"
                          min={0}
                          max={1}
                          step={0.05}
                          value={row.confidence}
                          onChange={(e) => update(index, { confidence: e.target.value })}
                        />
                      )}
                    </Field>
                  </div>
                )}
              </fieldset>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() =>
                setRows([
                  ...rows,
                  {
                    title: '',
                    segment_key: segments[0]?.key ?? '',
                    angle: '',
                    channel: channels[0] ?? ANY_CHANNEL,
                    metric: '',
                    confidence: '0.5',
                    retired: false,
                  },
                ])
              }
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('strategy.hypotheses.add')}
            </Button>
            <ErrorCallout error={save.error} />
            <GapList gaps={gaps} />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setRows(null);
                  save.reset();
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button type="submit" loading={save.isPending}>
                {t('common.save')}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
