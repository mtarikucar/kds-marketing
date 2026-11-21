import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';
import { listBudgetItems } from '@/api/budget';
import { CAP_PERIODS, LIMITS, saveRules, type ApprovalAccount, type AutoReplyView, type CapInput, type CapPeriod, type RulesInput, type RulesOut } from '@/api/knowledge';
import { useSession } from '@/auth/useSession';
import { MoneyInput } from '@/components/forms';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  toast,
} from '@/components/ui';
import { can, isOwnerOrManager } from '@/lib/roles';
import { isStale, useKnowledgeMutation } from './queries';
import { adLine, approvalLine, autoReplyLine, knowledgeError, listedNames, messageLine, notifyLine } from './words';

/** How many prohibitions the box shows before "{n} kural daha". */
const SHOWN = 2;

/** A line of an editable list, with a key of its own so removing one keeps the others' focus. */
interface Line {
  key: number;
  text: string;
}

/** An editable list of lines ("Yasak ekle", a × per line), shared by Kurallar and Hedefler. */
export function LinesEditor({
  lines,
  onChange,
  max,
  maxLength,
  addLabel,
  itemLabel,
  removeLabel,
}: {
  lines: Line[];
  onChange: (next: Line[]) => void;
  max: number;
  maxLength: number;
  addLabel: string;
  itemLabel: (n: number) => string;
  removeLabel: (n: number) => string;
}) {
  const added = useRef<number | null>(null);
  const refs = useRef(new Map<number, HTMLInputElement>());
  useEffect(() => {
    if (added.current === null) return;
    refs.current.get(added.current)?.focus();
    added.current = null;
  });
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {lines.map((line, i) => (
          <li key={line.key} className="flex items-center gap-2">
            <Input
              ref={(el) => {
                if (el) refs.current.set(line.key, el);
                else refs.current.delete(line.key);
              }}
              aria-label={itemLabel(i + 1)}
              value={line.text}
              maxLength={maxLength}
              onChange={(e) => onChange(lines.map((l) => (l.key === line.key ? { ...l, text: e.target.value } : l)))}
            />
            <IconButton
              type="button"
              variant="ghost"
              size="sm"
              aria-label={removeLabel(i + 1)}
              onClick={() => onChange(lines.filter((l) => l.key !== line.key))}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </li>
        ))}
      </ul>
      {lines.length < max && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => {
            const key = Math.max(0, ...lines.map((l) => l.key)) + 1;
            added.current = key;
            onChange([...lines, { key, text: '' }]);
          }}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {addLabel}
        </Button>
      )}
    </div>
  );
}

/** `texts` as editable lines. */
export function toLines(texts: readonly string[]): Line[] {
  return texts.map((text, i) => ({ key: i + 1, text }));
}

/** The lines as saved: trimmed, the empty ones dropped. */
export function fromLines(lines: readonly Line[]): string[] {
  return lines.map((l) => l.text.trim()).filter(Boolean);
}

/** One money ceiling of the dialog: the amount, and a switch that turns the ceiling off. */
function CapField({
  id,
  label,
  offLabel,
  currency,
  amount,
  off,
  period,
  onAmount,
  onOff,
  onPeriod,
  readOnly,
}: {
  id: string;
  label: string;
  offLabel: string;
  currency: string;
  amount: number | null;
  off: boolean;
  period?: CapPeriod;
  onAmount: (minor: number | null) => void;
  onOff: (off: boolean) => void;
  onPeriod?: (period: CapPeriod) => void;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="flex flex-col gap-2" disabled={readOnly}>
      <legend className="sr-only">{label}</legend>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Label htmlFor={id}>{label}</Label>
        {onPeriod ? (
          <Select value={period} onValueChange={(v) => onPeriod(v as CapPeriod)} disabled={readOnly || off}>
            <SelectTrigger aria-label={t('knowledge.rules.dialog.period')} className="h-9 w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CAP_PERIODS.map((p) => (
                <SelectItem key={p} value={p}>
                  {t(`knowledge.rules.dialog.${p}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span>{t(`knowledge.rules.dialog.${period ?? 'monthly'}`)}</span>
        )}
        <span>{t('knowledge.rules.dialog.atMost')}</span>
        <div className="w-36">
          <MoneyInput id={id} currency={currency} minor={off ? null : amount} onChange={onAmount} disabled={readOnly || off} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={off} onCheckedChange={onOff} disabled={readOnly} />
        {offLabel}
      </label>
    </fieldset>
  );
}

/**
 * The automatic replies in the Kurallar dialog: a switch for each WhatsApp number, and the range
 * of their quotes ("En az", "En çok"). Without a model on the server the switches are disabled
 * and the section says so.
 */
function AutoReplyField({
  auto,
  ids,
  min,
  max,
  onIds,
  onMin,
  onMax,
  notify,
  onNotify,
  discount,
  onDiscount,
  invalid,
}: {
  auto: AutoReplyView;
  ids: string[];
  min: number | null;
  max: number | null;
  onIds: (ids: string[]) => void;
  onMin: (minor: number | null) => void;
  onMax: (minor: number | null) => void;
  notify: boolean;
  onNotify: (on: boolean) => void;
  discount: [number, number];
  onDiscount: (discount: [number, number]) => void;
  invalid: boolean;
}) {
  const { t } = useTranslation();
  const currency = auto.price?.currency ?? 'TRY';
  const on = ids.length > 0;
  return (
    <section className="flex flex-col gap-2" aria-label={t('knowledge.rules.dialog.autoReply')}>
      <h3 className="text-sm font-medium">{t('knowledge.rules.dialog.autoReply')}</h3>
      {!auto.available && <p className="text-caption text-muted-foreground">{t('knowledge.rules.dialog.autoReplyNoKey')}</p>}
      {auto.accounts.map((a) => (
        <label key={a.capability_id} className="flex items-center gap-2 text-sm">
          <Switch
            checked={ids.includes(a.capability_id)}
            disabled={!auto.available}
            onCheckedChange={(checked) => onIds(checked ? [...ids, a.capability_id] : ids.filter((id) => id !== a.capability_id))}
          />
          {a.name}
        </label>
      ))}
      {(on || auto.price) && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Label htmlFor="knowledge-auto-min">{t('knowledge.rules.dialog.autoReplyMin')}</Label>
          <div className="w-32">
            <MoneyInput id="knowledge-auto-min" currency={currency} minor={min} onChange={onMin} disabled={!auto.available} />
          </div>
          <Label htmlFor="knowledge-auto-max">{t('knowledge.rules.dialog.autoReplyMax')}</Label>
          <div className="w-32">
            <MoneyInput id="knowledge-auto-max" currency={currency} minor={max} onChange={onMax} disabled={!auto.available} />
          </div>
          <span>{t('knowledge.rules.dialog.discount')}</span>
          <Label htmlFor="knowledge-discount-preferred">{t('knowledge.rules.dialog.discountPreferred')}</Label>
          <Input
            id="knowledge-discount-preferred"
            className="w-16"
            type="number"
            min={0}
            max={50}
            value={discount[0]}
            disabled={!auto.available || !on}
            onChange={(e) => onDiscount([percent(e.target.value), discount[1]])}
          />
          <Label htmlFor="knowledge-discount-max">{t('knowledge.rules.dialog.discountMax')}</Label>
          <Input
            id="knowledge-discount-max"
            className="w-16"
            type="number"
            min={0}
            max={50}
            value={discount[1]}
            disabled={!auto.available || !on}
            onChange={(e) => onDiscount([discount[0], percent(e.target.value)])}
          />
        </div>
      )}
      {on && <p className="text-caption text-muted-foreground">{t('knowledge.rules.dialog.autoReplyHelp')}</p>}
      {on && auto.notify.available && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={notify} onCheckedChange={(v) => onNotify(v === true)} />
          {t('knowledge.rules.dialog.notify')}
        </label>
      )}
      {invalid && <p role="alert" className="text-caption text-danger">{t('knowledge.rules.dialog.autoReplyInvalid')}</p>}
    </section>
  );
}

/** A percent field's value: a whole number, 0 when empty. */
function percent(raw: string): number {
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Whether two lists hold the same ids, in any order. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * "Düzenle" of Kurallar: the prohibitions, the two ceilings and post approval, saved whole over
 * the rules as they were when the dialog opened (`base`; the page reads again on its own
 * meanwhile). A stale save shows the rules as they now are, under the sentence that says so.
 */
function RulesDialog({ rules, open, onOpenChange }: { rules: RulesOut; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const session = useSession();
  const money = can(session.data, 'budget.manage');
  // Lowering post approval (the switch off, an account off the list) is an owner's or a
  // manager's (`strategy.rules_save` refuses `owner_or_manager` otherwise).
  const lowers = isOwnerOrManager(session.data);
  const [base, setBase] = useState(rules);
  // A new ad budget is counted in the general ad budget's currency, else TRY (`rules_save`); a
  // ceiling in force keeps its own.
  const items = useQuery({
    queryKey: ['budget-items', session.data?.current_workspace],
    queryFn: listBudgetItems,
    enabled: open && money && !base.ad_cap,
    retry: false,
  });
  const generalUnit = items.data?.find((b) => b.item.general && b.item.kind === 'ad_budget' && !b.item.retired_at)?.item.unit;
  const adCurrency = base.ad_cap?.currency ?? (generalUnit?.kind === 'currency' ? generalUnit.value : 'TRY');
  const [reload, setReload] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [adOff, setAdOff] = useState(false);
  const [adAmount, setAdAmount] = useState<number | null>(null);
  const [adPeriod, setAdPeriod] = useState<CapPeriod>('monthly');
  const [msgOff, setMsgOff] = useState(false);
  const [msgAmount, setMsgAmount] = useState<number | null>(null);
  const [approval, setApproval] = useState(false);
  const [accounts, setAccounts] = useState<ApprovalAccount[]>([]);
  const [invalid, setInvalid] = useState(false);
  const [autoIds, setAutoIds] = useState<string[]>([]);
  const [autoMin, setAutoMin] = useState<number | null>(null);
  const [autoMax, setAutoMax] = useState<number | null>(null);
  const [autoInvalid, setAutoInvalid] = useState(false);
  const [notify, setNotify] = useState(true);
  const [discount, setDiscount] = useState<[number, number]>([0, 0]);
  const showMessage = !!base.message_cap || base.metered;

  const save = useKnowledgeMutation(
    saveRules,
    (out) => {
      toast.success(t('knowledge.saved'));
      if (out.stopped_campaigns) toast.warning(t('knowledge.rules.stopped', { n: out.stopped_campaigns }));
      onOpenChange(false);
    },
    (err) => {
      if (isStale(err)) setReload(true);
    },
  );

  const load = (from: RulesOut) => {
    setBase(from);
    setLines(toLines(from.prohibitions));
    setAdOff(!from.ad_cap);
    setAdAmount(from.ad_cap?.amount_minor ?? null);
    setAdPeriod(from.ad_cap?.period ?? 'monthly');
    setMsgOff(!from.message_cap);
    setMsgAmount(from.message_cap?.amount_minor ?? null);
    setApproval(from.post_approval);
    setAccounts(from.post_approval_accounts);
    setAutoIds(from.auto_reply.capability_ids);
    setAutoMin(from.auto_reply.price?.min_minor ?? null);
    setAutoMax(from.auto_reply.price?.max_minor ?? null);
    setNotify(from.auto_reply.notify.on);
    setDiscount([from.auto_reply.discount_preferred_pct, from.auto_reply.discount_max_pct]);
  };

  // The rules as read each time the dialog opens; a later read leaves the person's edits alone.
  useEffect(() => {
    if (!open) return;
    load(rules);
    setInvalid(false);
    setAutoInvalid(false);
    setReload(false);
    save.reset();
  }, [open]);

  // After a stale save, the rules as they now are once the read has them.
  useEffect(() => {
    if (!open || !reload || rules.revision === base.revision) return;
    load(rules);
    setReload(false);
  }, [rules.revision, reload]);

  const current = (cap: RulesOut['ad_cap']): CapInput | null => (cap ? { amount_minor: cap.amount_minor, period: cap.period } : null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const adMissing = money && !adOff && adAmount === null;
    const msgMissing = money && showMessage && !msgOff && msgAmount === null;
    const autoBad =
      (autoIds.length > 0 && (autoMin === null || autoMax === null || autoMin <= 0 || autoMin > autoMax)) ||
      discount[1] > 50 ||
      discount[0] > discount[1];
    setInvalid(adMissing || msgMissing);
    setAutoInvalid(autoBad);
    if (adMissing || msgMissing || autoBad) return;
    const input: RulesInput = {
      expected_revision: base.revision,
      prohibitions: fromLines(lines),
      ad_budget: !money ? current(base.ad_cap) : adOff ? null : { amount_minor: adAmount ?? 0, period: adPeriod },
      message_budget:
        !money || !showMessage
          ? current(base.message_cap)
          : msgOff
            ? null
            : { amount_minor: msgAmount ?? 0, period: base.message_cap?.period ?? 'monthly' },
      post_approval: approval,
    };
    if (accounts.length !== base.post_approval_accounts.length) input.post_approval_accounts = accounts.map((a) => a.capability_id);
    const stored = base.auto_reply;
    const rangeMoved = autoMin !== (stored.price?.min_minor ?? null) || autoMax !== (stored.price?.max_minor ?? null);
    if (!sameIds(autoIds, stored.capability_ids) || rangeMoved) {
      input.auto_reply = { capability_ids: autoIds };
      if (autoMin !== null && autoMax !== null) {
        input.auto_reply.min_minor = autoMin;
        input.auto_reply.max_minor = autoMax;
      }
    }
    if (notify !== stored.notify.on) {
      input.auto_reply = { ...(input.auto_reply ?? { capability_ids: autoIds }), notify_email: notify };
    }
    if (discount[0] !== stored.discount_preferred_pct || discount[1] !== stored.discount_max_pct) {
      input.auto_reply = {
        ...(input.auto_reply ?? { capability_ids: autoIds }),
        discount_preferred_pct: discount[0],
        discount_max_pct: discount[1],
      };
    }
    save.mutate(input);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-dvh max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('knowledge.rules.title')}</DialogTitle>
          <DialogDescription>{t('knowledge.rules.dialog.help')}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
          <section className="flex flex-col gap-2" aria-label={t('knowledge.rules.dialog.prohibitions')}>
            <h3 className="text-sm font-medium">{t('knowledge.rules.dialog.prohibitions')}</h3>
            <LinesEditor
              lines={lines}
              onChange={setLines}
              max={LIMITS.prohibitions}
              maxLength={LIMITS.prohibition}
              addLabel={t('knowledge.rules.dialog.add')}
              itemLabel={(n) => t('knowledge.rules.dialog.item', { n })}
              removeLabel={(n) => t('knowledge.rules.dialog.remove', { n })}
            />
          </section>
          <section className="flex flex-col gap-4" aria-label={t('knowledge.rules.dialog.money')}>
            <CapField
              id="knowledge-ad-cap"
              label={t('knowledge.rules.dialog.ad')}
              offLabel={t('knowledge.rules.dialog.noAds')}
              currency={adCurrency}
              amount={adAmount}
              off={adOff}
              period={adPeriod}
              onAmount={setAdAmount}
              onOff={setAdOff}
              onPeriod={setAdPeriod}
              readOnly={!money}
            />
            {showMessage && (
              <CapField
                id="knowledge-message-cap"
                label={t('knowledge.rules.dialog.message')}
                offLabel={t('knowledge.rules.dialog.noLimit')}
                currency={base.message_cap?.currency ?? 'TRY'}
                amount={msgAmount}
                off={msgOff}
                period={base.message_cap?.period ?? 'monthly'}
                onAmount={setMsgAmount}
                onOff={setMsgOff}
                readOnly={!money}
              />
            )}
            {!money && <p className="text-caption text-muted-foreground">{t('knowledge.rules.dialog.noBudget')}</p>}
            {invalid && <p role="alert" className="text-caption text-danger">{t('knowledge.rules.dialog.amountInvalid')}</p>}
          </section>
          <section className="flex flex-col gap-2" aria-label={t('knowledge.rules.dialog.approval')}>
            <label className="flex items-center gap-2 text-sm font-medium">
              <Switch checked={approval} onCheckedChange={setApproval} disabled={base.post_approval && !lowers} />
              {t('knowledge.rules.dialog.approval')}
            </label>
            {base.post_approval && !lowers && <p className="text-caption text-muted-foreground">{t('knowledge.rules.dialog.approvalOwnerOnly')}</p>}
            {!approval && listedNames(accounts).length > 0 && (
              <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                {t('knowledge.rules.dialog.stillWaits', { accounts: listedNames(accounts).join(', ') })}
                {lowers && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setAccounts([])}>
                    {t('knowledge.rules.dialog.clearAccounts')}
                  </Button>
                )}
              </p>
            )}
          </section>
          {base.auto_reply.accounts.length > 0 && (
            <AutoReplyField
              auto={base.auto_reply}
              ids={autoIds}
              min={autoMin}
              max={autoMax}
              onIds={setAutoIds}
              onMin={setAutoMin}
              onMax={setAutoMax}
              notify={notify}
              onNotify={setNotify}
              discount={discount}
              onDiscount={setDiscount}
              invalid={autoInvalid}
            />
          )}
          {save.error && <p role="alert" className="text-sm text-danger">{knowledgeError(t, save.error)}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('knowledge.cancel')}
            </Button>
            <Button type="submit" loading={save.isPending}>
              {t('knowledge.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Kurallar" (§4.11.3): the first two prohibitions, the ad line, the message line while a limit
 * is set, the approval line built from the effective gates, then the rest folded. `editable`:
 * the viewer may change the knowledge base.
 */
export function RulesBox({ rules, editable }: { rules: RulesOut; editable: boolean }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const message = messageLine(t, rules.message_cap, i18n.language);
  const auto = autoReplyLine(t, rules.auto_reply, i18n.language);
  const notify = notifyLine(t, rules.auto_reply);
  const first = rules.prohibitions.slice(0, SHOWN);
  const rest = rules.prohibitions.slice(SHOWN);
  return (
    <section id="kurallar" aria-labelledby="knowledge-rules" className="flex min-w-0 flex-[1_1_22rem] scroll-mt-6 flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="knowledge-rules" className="flex-1 text-base font-semibold">{t('knowledge.rules.title')}</h2>
        <span className="text-caption text-muted-foreground">{t('knowledge.rules.aside')}</span>
        {editable && (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)} aria-label={t('knowledge.rules.editLabel')}>
            {t('knowledge.edit')}
          </Button>
        )}
      </div>
      <ul className="flex list-disc flex-col gap-1.5 ps-5 text-sm leading-relaxed [overflow-wrap:anywhere]">
        {first.length === 0 && <li className="list-none -ms-5 text-muted-foreground">{t('knowledge.rules.none')}</li>}
        {first.map((line, i) => <li key={`p-${i}`}>{line}</li>)}
        {expanded && rest.map((line, i) => <li key={`r-${i}`}>{line}</li>)}
        <li>{adLine(t, rules.ad_cap, i18n.language)}</li>
        {message && <li>{message}</li>}
        <li>{approvalLine(t, rules)}</li>
        {auto && <li>{auto}</li>}
        {notify && <li>{notify}</li>}
      </ul>
      {rest.length > 0 && (
        <button type="button" className="self-start text-sm text-muted-foreground underline-offset-4 hover:underline" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)}>
          {expanded ? t('knowledge.less') : t('knowledge.rules.more', { n: rest.length })}
        </button>
      )}
      {editable && <RulesDialog rules={rules} open={open} onOpenChange={setOpen} />}
    </section>
  );
}
