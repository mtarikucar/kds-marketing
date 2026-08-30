import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  createOpportunity,
  listOpportunities,
  listPipelines,
  moveOpportunity,
  type Opportunity,
} from '../../../features/marketing/api/opportunities.service';
import { fmtDate } from '../../../features/marketing/utils/format';
import { formatMoney } from '../../../lib/money';

const statusTone: Record<string, BadgeProps['tone']> = {
  OPEN: 'info',
  WON: 'success',
  LOST: 'danger',
  ABANDONED: 'neutral',
};

/** The backend's own reason if it gave one; the caller's sentence otherwise. */
function reason(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof message === 'string' && message ? message : fallback;
}

export interface PersonDealsProps {
  /** Whose deals. The record card owns the identity; this section owns the deals. */
  leadId: string;
}

/**
 * `SATIŞ` — the deal, as a FIELD of the person, on their record card.
 *
 * ## Why it is here and not only on the board
 *
 * Measured on the live workspace the day this was written: 363 people, 2 deals,
 * one of them synthetic. The pipeline is not empty because nobody sells; it is
 * empty because it sits away from where the work happens — the same disconnect
 * conversations had before v2.284.0 put messages and activities on one axis.
 * So the deal comes to the person, and the stage moves from here: the selector
 * below writes straight to `POST /opportunities/:id/move`, with no navigation.
 * That is the whole spirit of this surface — everything else on it selects.
 *
 * ## Three deliberate choices
 *
 * 1. **A failed move REVERTS the control and says why.** The selector reads
 *    `pending[id] ?? deal.stageId`, so the optimistic value exists only while
 *    the request is in flight; the error branch drops it and the control snaps
 *    back to where the deal actually is. A selector left showing a stage the
 *    deal is not in is a lie a rep then acts on. The message is the backend's
 *    own where it gave one.
 *
 * 2. **"Hatta ekle" appears when the person has no OPEN deal — not when they
 *    have no deal at all.** That is exactly the predicate behind the board's
 *    "Hatta değil" column (`status = 'OPEN'`, see `not-in-pipeline-leads.ts`).
 *    Reading it as "has never had a deal" would let this card call a person
 *    with one LOST deal "in the pipeline" while the column still lists them —
 *    two surfaces answering one question two ways. The closed deals stay listed
 *    underneath; nothing is hidden to make the button appear.
 *
 * 3. **The two queries fail differently, on purpose.** The deals list IS the
 *    section, so its failure gets the error branch — and it must never be
 *    mistaken for "this person has no deals". The pipelines read only NAMES the
 *    stages (the list endpoint returns a bare `stageId`), so its failure leaves
 *    the deals on screen with an honest "Bilinmeyen aşama" and no selector,
 *    rather than hiding real deals over a cosmetic gap. Same asymmetry as
 *    `SalesTab.tsx`, which reads the same two endpoints.
 *
 * ## Per-deal state is keyed, and the component itself is keyed by person
 *
 * `pending` is a map by deal id, and `LeadContextPane` mounts this with
 * `key={lead.id}`. Both matter: this branch's lineage has already shipped a
 * header that dialled lead A's number under lead B's id, and a pending stage
 * surviving a switch to another person and back would be the same bug wearing
 * a different hat — a control claiming a move that never landed.
 */
export function PersonDeals({ leadId }: PersonDealsProps) {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();

  // Same key as the lead detail's Satış tab, so the two read one cache and a
  // move made here is not stale over there.
  const dealsQuery = useQuery({
    queryKey: ['marketing', 'opportunities', 'lead', leadId],
    queryFn: () => listOpportunities({ leadId }),
  });

  const pipelinesQuery = useQuery({
    queryKey: ['marketing', 'pipelines'],
    queryFn: listPipelines,
    staleTime: 60_000,
  });

  /** pipelineId → its ordered stages. A deal is only movable within its own. */
  const stagesByPipeline = useMemo(() => {
    const map = new Map<string, { id: string; name: string }[]>();
    for (const p of pipelinesQuery.data ?? []) {
      if (p.stages?.length) map.set(p.id, p.stages.map((s) => ({ id: s.id, name: s.name })));
    }
    return map;
  }, [pipelinesQuery.data]);

  // Optimistic stage per DEAL id — see the docstring. Never a single scalar:
  // a person may have several deals and one of them moving must not repaint
  // the others.
  const [pending, setPending] = useState<Record<string, string>>({});
  const settle = (id: string) =>
    setPending((p) => {
      if (!(id in p)) return p;
      const next = { ...p };
      delete next[id];
      return next;
    });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['marketing', 'opportunities'] });
    // The move writes a STATUS_CHANGE on the person, so their stream is stale.
    queryClient.invalidateQueries({ queryKey: ['marketing', 'lead', leadId] });
  };

  const moveMutation = useMutation({
    mutationFn: ({ id, stageId }: { id: string; stageId: string }) => moveOpportunity(id, stageId),
    onSuccess: async (_data, variables) => {
      // Hold the optimistic value until the refetch that confirms it has
      // landed — clearing first would flash the OLD stage back for a beat,
      // which reads exactly like a move that failed.
      await queryClient.invalidateQueries({ queryKey: ['marketing', 'opportunities'] });
      queryClient.invalidateQueries({ queryKey: ['marketing', 'lead', leadId] });
      settle(variables.id);
    },
    onError: (err, variables) => {
      settle(variables.id);
      toast.error(reason(err, t('surface.sales.moveFailed', 'Aşama taşınamadı.')));
    },
  });

  const addMutation = useMutation({
    // No `name`: the person's own is the deal's, and the BACKEND supplies it
    // (`create()` falls back to `contactPerson || businessName`). Inventing one
    // here would be a second answer to "what is this person called".
    mutationFn: () => createOpportunity({ leadId }),
    onSuccess: refresh,
    onError: (err) => toast.error(reason(err, t('surface.sales.addFailed', 'Hatta eklenemedi.'))),
  });

  const deals: Opportunity[] = dealsQuery.data?.data ?? [];
  // "In the pipeline" is `status = 'OPEN'` and nothing else — the board's own
  // definition. See choice 2 in the docstring.
  const hasOpenDeal = deals.some((d) => d.status === 'OPEN');

  return (
    <section data-testid="record-sales" className="space-y-2 border-t border-border pt-3">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t('surface.sales.title', 'Satış')}
      </h4>

      {/* A broken read and a person with no deals are different screens. */}
      <QueryStateBoundary
        isLoading={dealsQuery.isLoading}
        isError={dealsQuery.isError}
        onRetry={() => dealsQuery.refetch()}
        errorMessage={t('surface.sales.failed', 'Fırsatlar yüklenemedi.')}
        retryLabel={t('common.retry', 'Tekrar dene')}
        loading={<Skeleton className="h-12 rounded-md" />}
      >
        {deals.length > 0 && (
          <ul className="space-y-2">
            {deals.map((o) => {
              const stages = stagesByPipeline.get(o.pipelineId);
              return (
                <li
                  key={o.id}
                  data-testid={`deal-${o.id}`}
                  className="space-y-1.5 rounded-md border border-border p-2"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-xs font-medium text-foreground">
                      {o.name}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-foreground">
                      {formatMoney(o.value, o.currency)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <Badge tone={statusTone[o.status] ?? 'neutral'} size="sm">
                      {o.status}
                    </Badge>
                    {/* An absent close date says so rather than leaving a blank
                        that reads as "today" to a hurried eye. */}
                    <span data-testid={`deal-close-${o.id}`} className="truncate">
                      {o.expectedCloseDate
                        ? fmtDate(o.expectedCloseDate)
                        : t('surface.sales.noClose', 'Kapanış tarihi yok')}
                    </span>
                  </div>
                  {stages ? (
                    <Select
                      value={pending[o.id] ?? o.stageId}
                      onValueChange={(stageId) => {
                        if (stageId === o.stageId) return; // no-op, not a request
                        setPending((p) => ({ ...p, [o.id]: stageId }));
                        moveMutation.mutate({ id: o.id, stageId });
                      }}
                    >
                      <SelectTrigger
                        data-testid={`deal-stage-${o.id}`}
                        aria-label={t('surface.sales.stage', 'Aşama')}
                        className="h-8 text-xs"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {stages.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    // "We could not name the stage" and "this deal has no
                    // stage" must not look the same.
                    <p
                      data-testid={`deal-stage-${o.id}`}
                      className="text-[11px] italic text-muted-foreground"
                    >
                      {t('surface.sales.unknownStage', 'Bilinmeyen aşama')}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {deals.length === 0 && (
          <p data-testid="deals-empty" className="text-[11px] text-muted-foreground">
            {t('surface.sales.none', 'Bu kişi hatta değil.')}
          </p>
        )}

        {!hasOpenDeal && (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={addMutation.isPending}
            onClick={() => addMutation.mutate()}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('surface.sales.add', 'Hatta ekle')}
          </Button>
        )}
      </QueryStateBoundary>
    </section>
  );
}
