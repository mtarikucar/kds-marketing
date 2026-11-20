import { BreakdownPeriod, ItemSpending, SpendingStops, useBudgetBreakdown } from './budget/BudgetBreakdown';
import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Receipt } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { Cap } from '@/api/knowledge';
import {
  SPEND_PAGE_SIZE,
  createBudgetItem,
  listBudgetItems,
  listSpend,
  recordSpend,
  retireBudgetItem,
  updateBudgetItem,
} from '@/api/budget';
import {
  BUDGET_KINDS,
  BUDGET_PERIODS,
  type BudgetItemOut,
  type BudgetKind,
  type BudgetPeriod,
  type Unit,
  type UnitKind,
  type UpdateBudgetItemInput,
} from '@/api/types';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import { MoneyInput, WholeNumberInput } from '@/components/forms';
import {
  Badge,
  Button,
  ConfirmDialog,
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
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { can } from '@/lib/roles';
import { useKnowledge } from './knowledge/queries';
import { capMoney } from './knowledge/words';

const ITEMS_KEY = ['budget', 'items'] as const;
/** The capability lists show each capability's budget items, so an item's change refreshes them. */
const CAPABILITIES_KEY = ['capabilities'] as const;

const PERIOD_DAYS: Record<BudgetPeriod, number | null> = { daily: 1, weekly: 7, monthly: 30, total: null };

/**
 * Kurallar's ad budget brought to an item's `period` and `currency` as the server's
 * `check_general` prorates it (rounded down); `null` where it binds nothing: no ceiling (no
 * ads), another currency, or a total.
 */
export function ceilingIn(cap: Cap | null | undefined, period: BudgetPeriod, currency: string | null): number | null {
  const days = PERIOD_DAYS[period];
  if (!cap || days === null || currency !== cap.currency) return null;
  return Math.floor((cap.amount_minor * days) / (cap.period === 'weekly' ? 7 : 30));
}

/** "Kurallar'daki reklam sınırı: ayda ₺5.000 · Kurallar'da değiştir" (design 2026-11-19 §4.6.2). */
function RulesCeiling() {
  const { t, i18n } = useTranslation();
  const cap = useKnowledge().data?.rules.ad_cap;
  if (cap === undefined) return null;
  const text = !cap
    ? t('budget.rulesNone')
    : t(cap.period === 'weekly' ? 'budget.rulesCeilingWeekly' : 'budget.rulesCeilingMonthly', {
        amount: capMoney(cap.amount_minor, cap.currency, i18n.language),
      });
  return (
    <span className="text-xs font-normal text-muted-foreground">
      {text} ·{' '}
      <Link className="text-primary underline underline-offset-4" to="/knowledge#kurallar">
        {t('budget.rulesChange')}
      </Link>
    </span>
  );
}

/** Under the general item's cap: the ceiling, and whether the amount typed goes over it. */
function CeilingCheck({ ceiling, cap, currency }: { ceiling: number | null; cap: number | null; currency: string }) {
  const { t, i18n } = useTranslation();
  if (ceiling === null) return null;
  return (
    <div className="flex flex-col gap-1">
      <RulesCeiling />
      {cap !== null && cap > ceiling && (
        <p role="alert" className="text-caption text-danger">
          {t('budget.aboveRulesCeiling', { amount: capMoney(ceiling, currency, i18n.language) })}
        </p>
      )}
    </div>
  );
}

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
  const [general, setGeneral] = useState(false);
  const adCap = useKnowledge().data?.rules.ad_cap;
  const create = useMutation({
    mutationFn: createBudgetItem,
    onSuccess: async () => {
      toast.success(t('budget.dialog.created'));
      onOpenChange(false);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ITEMS_KEY }), queryClient.invalidateQueries({ queryKey: ['budget-items'] }), queryClient.invalidateQueries({ queryKey: ['budget', 'breakdown'] })]);
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
      setGeneral(false);
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

  const generalItem = kind === 'ad_budget' && unit.kind === 'currency' && period !== 'total' && general;
  const ceiling = generalItem && unit.kind === 'currency' ? ceilingIn(adCap, period, unit.value) : null;
  const above = ceiling !== null && cap !== null && cap > ceiling;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (above) return;
    create.mutate({ name: name.trim(), kind, unit, cap: cap ?? 0, period, ...(kind === 'ad_budget' && unit.kind === 'currency' && period !== 'total' ? { general } : {}) });
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
          {kind === 'ad_budget' && unit.kind === 'currency' && period !== 'total' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={general} onChange={e => setGeneral(e.target.checked)} />{t('budgetSpending.general')}</label>}
          {unit.kind === 'currency' && <CeilingCheck ceiling={ceiling} cap={cap} currency={unit.value} />}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={create.isPending} disabled={name.trim() === '' || cap === null || above}>
              {t('budget.dialog.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What an edit of `item` sends: each field that differs from the stored one, the name compared
 * trimmed on both sides (the server trims it).
 */
function budgetItemEdit(
  item: BudgetItemOut['item'],
  form: { name: string; cap: number | null; period: BudgetPeriod; general: boolean },
): UpdateBudgetItemInput {
  const input: UpdateBudgetItemInput = {};
  const name = form.name.trim();
  if (name !== item.name.trim()) input.name = name;
  if (form.cap !== null && form.cap !== item.cap) input.cap = form.cap;
  if (form.period !== item.period) input.period = form.period;
  const general = item.kind === 'ad_budget' && item.unit.kind === 'currency' && form.period !== 'total' && form.general;
  if (general !== Boolean(item.general)) input.general = general;
  return input;
}

/** Edits an item's name, cap and period; its kind and unit never change. */
function EditItemDialog({ entry, onClose }: { entry: BudgetItemOut | null; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [cap, setCap] = useState<number | null>(null);
  const [period, setPeriod] = useState<BudgetPeriod>('monthly');
  const [general, setGeneral] = useState(false);
  const adCap = useKnowledge().data?.rules.ad_cap;
  const save = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateBudgetItemInput }) => updateBudgetItem(id, input),
    onSuccess: async () => {
      toast.success(t('budget.editDialog.saved'));
      onClose();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ITEMS_KEY }),
        queryClient.invalidateQueries({ queryKey: CAPABILITIES_KEY }),
        queryClient.invalidateQueries({ queryKey: ['budget-items'] }),
        queryClient.invalidateQueries({ queryKey: ['budget', 'breakdown'] }),
      ]);
    },
  });

  useEffect(() => {
    setName(entry?.item.name ?? '');
    setCap(entry?.item.cap ?? null);
    setPeriod(entry?.item.period ?? 'monthly');
    setGeneral(Boolean(entry?.item.general));
    save.reset();
  }, [entry?.item.id]);

  if (!entry) return null;
  const { item } = entry;
  const input = budgetItemEdit(item, { name, cap, period, general });
  const changed = Object.keys(input).length > 0;
  const generalItem = item.kind === 'ad_budget' && item.unit.kind === 'currency' && period !== 'total' && general;
  const ceiling = generalItem && item.unit.kind === 'currency' ? ceilingIn(adCap, period, item.unit.value) : null;
  const above = ceiling !== null && cap !== null && cap > ceiling;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (changed && !above) save.mutate({ id: item.id, input });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('budget.editDialog.title', { name: item.name })}</DialogTitle>
          <DialogDescription>{t('budget.editDialog.description')}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          <ErrorCallout error={save.error} />
          <Field label={t('fields.name')} required>
            {(ids) => <Input id={ids.id} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t('budget.dialog.cap')}
              hint={
                item.unit.kind === 'currency'
                  ? t('budget.dialog.capHintCurrency', { currency: item.unit.value })
                  : undefined
              }
              required
            >
              {(ids) => (
                <AmountInput id={ids.id} unit={item.unit} value={cap} onChange={setCap} describedBy={ids.describedBy} />
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
          {item.kind === 'ad_budget' && item.unit.kind === 'currency' && period !== 'total' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={general} onChange={e => setGeneral(e.target.checked)} />{t('budgetSpending.general')}</label>}
          {item.unit.kind === 'currency' && <CeilingCheck ceiling={ceiling} cap={cap} currency={item.unit.value} />}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              loading={save.isPending}
              disabled={!changed || name.trim() === '' || cap === null || above}
            >
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One item's spend, newest first and paged by keyset, with the form that records a spend; a
 * retired item shows its spend but takes no more.
 */
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
        {item.retired_at !== null ? (
          <p className="text-sm text-muted-foreground">{t('budget.spendSheet.retired')}</p>
        ) : (
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
        )}
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
  const queryClient = useQueryClient();
  const session = useSession();
  const canManage = can(session.data, 'budget.manage');
  const breakdown = useBudgetBreakdown();
  const items = useQuery({ queryKey: ITEMS_KEY, queryFn: listBudgetItems });
  const [creating, setCreating] = useState(false);
  const [spendFor, setSpendFor] = useState<BudgetItemOut | null>(null);
  const [editing, setEditing] = useState<BudgetItemOut | null>(null);
  const [retiring, setRetiring] = useState<BudgetItemOut | null>(null);
  const retire = useMutation({
    mutationFn: (id: string) => retireBudgetItem(id),
    onSuccess: async () => {
      setRetiring(null);
      toast.success(t('budget.retireDialog.retired'));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ITEMS_KEY }),
        queryClient.invalidateQueries({ queryKey: CAPABILITIES_KEY }),
        queryClient.invalidateQueries({ queryKey: ['budget-items'] }),
        queryClient.invalidateQueries({ queryKey: ['budget', 'breakdown'] }),
      ]);
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });
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
      <BreakdownPeriod view={breakdown} />
      <QueryState query={items}>
        {(items.data ?? []).length === 0 ? (
          <EmptyState title={t('budget.empty')} description={t('budget.emptyBody')} />
        ) : (
          <div className="min-w-0 space-y-2">
            <p className="text-caption text-muted-foreground md:hidden">{t('budget.workbench.scrollHint', { defaultValue: 'Diğer sütunları görmek için tabloyu yatay kaydırın.' })}</p>
            <div role="region" aria-label={t('budget.title')} tabIndex={0} className="relative w-full min-w-0 overflow-x-auto rounded-xl border border-border bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
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
                  const retired = item.retired_at !== null;
                  return (
                    <Fragment key={item.id}><TR
                      data-retired={retired || undefined}
                      className={cn(retired && 'text-muted-foreground opacity-60')}
                    >
                      <TD className={cn('font-medium', retired ? 'text-muted-foreground' : 'text-foreground')}>
                        <span className="flex flex-col gap-0.5">
                          {item.name}
                          {item.general && <span className="text-xs text-muted-foreground">{t('budgetSpending.general')}</span>}
                          {item.general && !retired && <RulesCeiling />}
                          {retired && (
                            <span className="text-caption font-normal">
                              {t('budget.retiredOn', { date: formatDateTime(item.retired_at, i18n.language) })}
                            </span>
                          )}
                        </span>
                      </TD>
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
                        <span className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => setSpendFor(entry)}>
                            <Receipt className="h-3.5 w-3.5" aria-hidden="true" />
                            {t('budget.spend')}
                          </Button>
                          {canManage && !retired && (
                            <>
                              <Button variant="ghost" size="sm" onClick={() => setEditing(entry)}>
                                {t('budget.actions.edit')}
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => setRetiring(entry)}>
                                {t('budget.actions.retire')}
                              </Button>
                            </>
                          )}
                        </span>
                      </TD>
                    </TR>
                    {breakdown.valid && breakdown.query.data && <TR><TD colSpan={8}><ItemSpending unit={item.unit} item={breakdown.query.data.items.find(b => b.item_id === item.id)} /></TD></TR>}
                    </Fragment>
                  );
                })}
              </TBody>
            </Table>
            </div>
          </div>
        )}
      </QueryState>
      {breakdown.query.data && <SpendingStops stop={breakdown.query.data.stop} manage={canManage} />}
      {canManage && (
        <>
          <CreateItemDialog open={creating} onOpenChange={setCreating} />
          <EditItemDialog entry={editing} onClose={() => setEditing(null)} />
          <ConfirmDialog
            open={retiring !== null}
            onOpenChange={(open) => !open && setRetiring(null)}
            title={t('budget.retireDialog.title')}
            description={retiring ? t('budget.retireDialog.body', { name: retiring.item.name }) : undefined}
            confirmLabel={t('budget.actions.retire')}
            cancelLabel={t('common.cancel')}
            tone="danger"
            loading={retire.isPending}
            onConfirm={() => retiring && retire.mutate(retiring.item.id)}
          />
        </>
      )}
      <SpendSheet entry={current} onClose={() => setSpendFor(null)} />
    </>
  );
}
