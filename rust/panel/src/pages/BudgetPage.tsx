import { useEffect, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Receipt } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SPEND_PAGE_SIZE, createBudgetItem, listBudgetItems, listSpend, recordSpend } from '@/api/budget';
import {
  BUDGET_KINDS,
  BUDGET_PERIODS,
  type BudgetItemOut,
  type BudgetKind,
  type BudgetPeriod,
  type Unit,
  type UnitKind,
} from '@/api/types';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import { MoneyInput, WholeNumberInput } from '@/components/forms';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  cn,
  toast,
} from '@/components/ui';
import { formatAmount, sourceLabel, unitLabel } from '@/lib/budget';
import { unitKindsFor } from '@/lib/capabilities';
import { formatDateTime } from '@/lib/format';
import { can } from '@/lib/roles';

const ITEMS_KEY = ['budget', 'items'] as const;

function spendKey(itemId: string) {
  return ['budget', 'spend', itemId] as const;
}

/** The amount field for `unit`: money typed in major units, anything else as a whole number. */
function AmountInput({
  id,
  unit,
  value,
  onChange,
  describedBy,
}: {
  id: string;
  unit: Unit;
  value: number | null;
  onChange: (next: number | null) => void;
  describedBy?: string;
}) {
  if (unit.kind === 'currency') {
    return <MoneyInput id={id} currency={unit.value} minor={value} onChange={onChange} describedBy={describedBy} />;
  }
  return <WholeNumberInput id={id} min={0} value={value} onChange={onChange} describedBy={describedBy} />;
}

function CreateItemDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<BudgetKind>('cash');
  const [unitKind, setUnitKind] = useState<UnitKind>('currency');
  const [currency, setCurrency] = useState('TRY');
  const [countLabel, setCountLabel] = useState('');
  const [cap, setCap] = useState<number | null>(null);
  const [period, setPeriod] = useState<BudgetPeriod>('monthly');
  const create = useMutation({
    mutationFn: createBudgetItem,
    onSuccess: async () => {
      toast.success(t('budget.dialog.created'));
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: ITEMS_KEY });
    },
  });

  useEffect(() => {
    if (!open) {
      setName('');
      setKind('cash');
      setUnitKind('currency');
      setCurrency('TRY');
      setCountLabel('');
      setCap(null);
      setPeriod('monthly');
      create.reset();
    }
    // Reset only when the dialog closes.
  }, [open]);

  // The units a kind may be counted in (`unit_fits`); a new kind picks its first.
  const unitKinds = unitKindsFor(kind);
  const onKind = (next: BudgetKind) => {
    setKind(next);
    const allowed = unitKindsFor(next);
    if (!allowed.includes(unitKind)) setUnitKind(allowed[0]);
  };
  const unit: Unit =
    unitKind === 'currency'
      ? { kind: 'currency', value: currency.trim().toUpperCase() }
      : unitKind === 'count'
        ? { kind: 'count', value: countLabel.trim() }
        : { kind: 'minutes' };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ name: name.trim(), kind, unit, cap: cap ?? 0, period });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('budget.dialog.title')}</DialogTitle>
          <DialogDescription>{t('budget.dialog.description')}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          <ErrorCallout error={create.error} />
          <Field label={t('fields.name')} required>
            {(ids) => <Input id={ids.id} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('fields.kind')} required>
              {(ids) => (
                <Select value={kind} onValueChange={(v) => onKind(v as BudgetKind)}>
                  <SelectTrigger id={ids.id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BUDGET_KINDS.map((k) => (
                      <SelectItem key={k} value={k}>
                        {t(`budget.kinds.${k}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field label={t('budget.dialog.unitKind')} required>
              {(ids) => (
                <Select value={unitKind} onValueChange={(v) => setUnitKind(v as UnitKind)} disabled={unitKinds.length < 2}>
                  <SelectTrigger id={ids.id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {unitKinds.map((u) => (
                      <SelectItem key={u} value={u}>
                        {t(`budget.units.${u}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
          </div>
          {unitKind === 'currency' && (
            <Field label={t('budget.dialog.currency')} hint={t('budget.dialog.currencyHint')} required>
              {(ids) => (
                <Input
                  id={ids.id}
                  aria-describedby={ids.describedBy}
                  className="font-mono uppercase"
                  maxLength={3}
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                />
              )}
            </Field>
          )}
          {unitKind === 'count' && (
            <Field label={t('budget.dialog.countLabel')} hint={t('budget.dialog.countLabelHint')} required>
              {(ids) => (
                <Input
                  id={ids.id}
                  aria-describedby={ids.describedBy}
                  maxLength={32}
                  value={countLabel}
                  onChange={(e) => setCountLabel(e.target.value)}
                />
              )}
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t('budget.dialog.cap')}
              hint={unit.kind === 'currency' ? t('budget.dialog.capHintCurrency', { currency: unit.value }) : undefined}
              required
            >
              {(ids) => (
                <AmountInput id={ids.id} unit={unit} value={cap} onChange={setCap} describedBy={ids.describedBy} />
              )}
            </Field>
            <Field label={t('fields.period')} required>
              {(ids) => (
                <Select value={period} onValueChange={(v) => setPeriod(v as BudgetPeriod)}>
                  <SelectTrigger id={ids.id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BUDGET_PERIODS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {t(`budget.periods.${p}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={create.isPending} disabled={name.trim() === '' || cap === null}>
              {t('budget.dialog.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One item's spend, newest first and paged by keyset, with the form that records a spend. */
function SpendSheet({ entry, onClose }: { entry: BudgetItemOut | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const itemId = entry?.item.id ?? '';
  const [amount, setAmount] = useState<number | null>(null);
  const [reference, setReference] = useState('');
  const spend = useInfiniteQuery({
    queryKey: spendKey(itemId),
    queryFn: ({ pageParam }) =>
      listSpend(itemId, { limit: SPEND_PAGE_SIZE, before_at: pageParam?.at, before_id: pageParam?.id }),
    initialPageParam: undefined as { at: string; id: string } | undefined,
    getNextPageParam: (last) => {
      if (last.length < SPEND_PAGE_SIZE) return undefined;
      const oldest = last[last.length - 1];
      return { at: oldest.at, id: oldest.id };
    },
    enabled: entry !== null,
  });
  const record = useMutation({
    mutationFn: (input: { amount: number; reference?: string }) => recordSpend(itemId, input),
    onSuccess: async () => {
      setAmount(null);
      setReference('');
      toast.success(t('budget.spendSheet.recorded'));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: spendKey(itemId) }),
        queryClient.invalidateQueries({ queryKey: ITEMS_KEY }),
      ]);
    },
  });

  useEffect(() => {
    setAmount(null);
    setReference('');
    record.reset();
  }, [itemId]);

  if (!entry) return null;
  const { item } = entry;
  const rows = spend.data?.pages.flat() ?? [];
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (amount === null || amount <= 0) return;
    record.mutate({ amount, reference: reference.trim() || undefined });
  };

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full max-w-lg overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t('budget.spendSheet.title', { name: item.name })}</SheetTitle>
          <SheetDescription>{t('budget.spendSheet.description')}</SheetDescription>
        </SheetHeader>
        <p className={cn('text-sm', entry.remaining < 0 ? 'text-danger' : 'text-foreground')}>
          {t('budget.spendSheet.summary', {
            spent: formatAmount(t, entry.spent_in_period, item.unit, i18n.language),
            remaining: formatAmount(t, entry.remaining, item.unit, i18n.language),
          })}
        </p>
        <form className="flex flex-col gap-3 rounded-lg border border-border p-3" onSubmit={onSubmit} noValidate>
          <ErrorCallout error={record.error} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t('fields.amount')}
              hint={t('budget.spendSheet.amountHint', { unit: unitLabel(t, item.unit) })}
              required
            >
              {(ids) => (
                <AmountInput
                  id={ids.id}
                  unit={item.unit}
                  value={amount}
                  onChange={setAmount}
                  describedBy={ids.describedBy}
                />
              )}
            </Field>
            <Field label={t('fields.reference')} hint={t('budget.spendSheet.referenceHint')}>
              {(ids) => (
                <Input
                  id={ids.id}
                  aria-describedby={ids.describedBy}
                  maxLength={256}
                  autoComplete="off"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              )}
            </Field>
          </div>
          <Button
            type="submit"
            className="self-end"
            loading={record.isPending}
            disabled={amount === null || amount <= 0}
          >
            {t('budget.spendSheet.record')}
          </Button>
        </form>
        <QueryState query={spend}>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('budget.spendSheet.empty')}</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table>
                <THead>
                  <TR>
                    <TH>{t('budget.spendSheet.columns.at')}</TH>
                    <TH className="text-end">{t('budget.spendSheet.columns.amount')}</TH>
                    <TH>{t('budget.spendSheet.columns.source')}</TH>
                    <TH>{t('budget.spendSheet.columns.reference')}</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((s) => (
                    <TR key={s.id}>
                      <TD className="whitespace-nowrap text-muted-foreground">{formatDateTime(s.at, i18n.language)}</TD>
                      <TD className="whitespace-nowrap text-end tabular-nums">
                        {formatAmount(t, s.amount, item.unit, i18n.language)}
                      </TD>
                      <TD>
                        <Badge size="sm">{sourceLabel(t, s.source)}</Badge>
                      </TD>
                      <TD className="font-mono text-micro">{s.reference ?? t('common.none')}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
          {spend.hasNextPage && (
            <Button
              variant="outline"
              className="self-center"
              onClick={() => void spend.fetchNextPage()}
              loading={spend.isFetchingNextPage}
            >
              {t('budget.spendSheet.loadMore')}
            </Button>
          )}
        </QueryState>
      </SheetContent>
    </Sheet>
  );
}

export function BudgetPage() {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const canManage = can(session.data, 'budget.manage');
  const items = useQuery({ queryKey: ITEMS_KEY, queryFn: listBudgetItems });
  const [creating, setCreating] = useState(false);
  const [spendFor, setSpendFor] = useState<BudgetItemOut | null>(null);
  // The open sheet follows the list as it is read again (after a spend is recorded).
  const current = spendFor ? (items.data?.find((e) => e.item.id === spendFor.item.id) ?? spendFor) : null;

  return (
    <>
      <PageHeader
        title={t('budget.title')}
        description={t('budget.description')}
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('budget.create')}
            </Button>
          ) : null
        }
      />
      <QueryState query={items}>
        {(items.data ?? []).length === 0 ? (
          <EmptyState title={t('budget.empty')} description={t('budget.emptyBody')} />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-surface">
            <Table>
              <THead>
                <TR>
                  <TH>{t('budget.columns.name')}</TH>
                  <TH>{t('budget.columns.kind')}</TH>
                  <TH>{t('budget.columns.unit')}</TH>
                  <TH className="text-end">{t('budget.columns.cap')}</TH>
                  <TH>{t('budget.columns.period')}</TH>
                  <TH className="text-end">{t('budget.columns.spent')}</TH>
                  <TH className="text-end">{t('budget.columns.remaining')}</TH>
                  <TH>
                    <span className="sr-only">{t('common.actions')}</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {items.data?.map((entry) => {
                  const { item } = entry;
                  const over = entry.remaining < 0;
                  return (
                    <TR key={item.id}>
                      <TD className="font-medium text-foreground">{item.name}</TD>
                      <TD>{t(`budget.kinds.${item.kind}`)}</TD>
                      <TD className="font-mono text-caption">{unitLabel(t, item.unit)}</TD>
                      <TD className="whitespace-nowrap text-end tabular-nums">
                        {formatAmount(t, item.cap, item.unit, i18n.language)}
                      </TD>
                      <TD>{t(`budget.periods.${item.period}`)}</TD>
                      <TD className="whitespace-nowrap text-end tabular-nums">
                        {formatAmount(t, entry.spent_in_period, item.unit, i18n.language)}
                      </TD>
                      <TD
                        className={cn('whitespace-nowrap text-end tabular-nums', over && 'font-medium text-danger')}
                        data-over-cap={over || undefined}
                      >
                        <span className="flex flex-col items-end gap-0.5">
                          {formatAmount(t, entry.remaining, item.unit, i18n.language)}
                          {over && (
                            <Badge tone="danger" size="sm">
                              {t('budget.overCap')}
                            </Badge>
                          )}
                        </span>
                      </TD>
                      <TD className="text-end">
                        <Button variant="ghost" size="sm" onClick={() => setSpendFor(entry)}>
                          <Receipt className="h-3.5 w-3.5" aria-hidden="true" />
                          {t('budget.spend')}
                        </Button>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
        )}
      </QueryState>
      {canManage && <CreateItemDialog open={creating} onOpenChange={setCreating} />}
      <SpendSheet entry={current} onClose={() => setSpendFor(null)} />
    </>
  );
}
