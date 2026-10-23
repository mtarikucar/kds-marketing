import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  declareCapability,
  linkBudget,
  markUnreachable,
  setPolicy,
  updateCapability,
  verifyCapability,
} from '@/api/capabilities';
import {
  DEFAULT_VERIFY_MAX_AGE_DAYS,
  type BudgetItemOut,
  type CapabilityOut,
  type Policy,
  type UpdateCapabilityInput,
} from '@/api/types';
import { ErrorCallout } from '@/components/ErrorCallout';
import { GapList } from '@/components/GapList';
import { KindSelect } from '@/components/KindSelect';
import { ListRows, WholeNumberInput } from '@/components/forms';
import {
  Button,
  Callout,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  toast,
} from '@/components/ui';
import { canLinkBudget, requiresKeyDetail } from '@/lib/capabilities';
import { gapsOf } from '@/lib/errors';
import { formatHour, weekdayName } from '@/lib/format';
import { invalidateCapabilities } from './queries';

/** The frame every capability dialog shares: title, description, error with its gaps, buttons. */
function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  error,
  submitLabel,
  submitting,
  submitDisabled,
  onSubmit,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  error: unknown;
  submitLabel: string;
  submitting: boolean;
  submitDisabled?: boolean;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const gaps = gapsOf(error);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <ErrorCallout error={error} />
          {gaps.length > 0 && <GapList gaps={gaps} />}
          {children}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={submitting} disabled={submitDisabled}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A mutation that, once done, refreshes everything capabilities feed and closes its dialog. */
function useCapabilityMutation<I>(
  fn: (input: I) => Promise<unknown>,
  done: string,
  close: () => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      toast.success(done);
      close();
      await invalidateCapabilities(queryClient);
    },
  });
}

/** A public setting's value: JSON when it reads as a list or an object, else the text itself. */
function settingValue(raw: string): unknown {
  const text = raw.trim();
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

// --- declare ----------------------------------------------------------------------------------

export function DeclareDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState('');
  const [keyDetail, setKeyDetail] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [externalId, setExternalId] = useState('');
  const [settings, setSettings] = useState<{ key: string; value: string }[]>([]);
  const close = () => onOpenChange(false);
  const declare = useCapabilityMutation(declareCapability, t('capabilities.declareDialog.declared'), close);

  useEffect(() => {
    if (!open) {
      setKind('');
      setKeyDetail('');
      setName('');
      setDescription('');
      setExternalId('');
      setSettings([]);
      declare.reset();
    }
    // Reset only when the dialog closes.
  }, [open]);

  const needsDetail = requiresKeyDetail(kind);
  const submit = () => {
    const publicSettings = Object.fromEntries(
      settings.filter((s) => s.key.trim() !== '').map((s) => [s.key.trim(), settingValue(s.value)]),
    );
    declare.mutate({
      kind_key: kind,
      key_detail: needsDetail ? keyDetail.trim() : undefined,
      name: name.trim(),
      description: description.trim() || undefined,
      external_id: externalId.trim() || undefined,
      connector_public: Object.keys(publicSettings).length > 0 ? publicSettings : undefined,
    });
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('capabilities.declareDialog.title')}
      description={t('capabilities.declareDialog.description')}
      error={declare.error}
      submitLabel={t('capabilities.declareDialog.submit')}
      submitting={declare.isPending}
      submitDisabled={kind === '' || name.trim() === ''}
      onSubmit={submit}
    >
      <Field label={t('fields.kind_key')} required>
        {(ids) => (
          <KindSelect
            id={ids.id}
            value={kind}
            placeholder={t('capabilities.declareDialog.kindPlaceholder')}
            onChange={setKind}
          />
        )}
      </Field>
      {needsDetail && (
        <Field label={t('fields.key_detail')} hint={t('capabilities.declareDialog.keyDetailHint')} required>
          {(ids) => (
            <Input
              id={ids.id}
              aria-describedby={ids.describedBy}
              className="font-mono"
              spellCheck={false}
              autoCapitalize="off"
              value={keyDetail}
              onChange={(e) => setKeyDetail(e.target.value)}
            />
          )}
        </Field>
      )}
      <Field label={t('fields.name')} required>
        {(ids) => <Input id={ids.id} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label={t('fields.description')}>
        {(ids) => <Textarea id={ids.id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}
      </Field>
      <Field label={t('fields.external_id')} hint={t('capabilities.declareDialog.externalIdHint')}>
        {(ids) => (
          <Input
            id={ids.id}
            aria-describedby={ids.describedBy}
            autoComplete="off"
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
          />
        )}
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-foreground">
          {t('capabilities.declareDialog.connectorPublic')}
        </legend>
        <p className="text-caption text-muted-foreground">{t('capabilities.declareDialog.connectorPublicHint')}</p>
        <ListRows<{ key: string; value: string }>
          items={settings}
          onChange={setSettings}
          makeItem={() => ({ key: '', value: '' })}
          addLabel={t('capabilities.declareDialog.addSetting')}
          removeLabel={t('strategy.remove')}
          renderRow={(item, update) => (
            <>
              <Field label={t('capabilities.declareDialog.settingKey')}>
                {(ids) => (
                  <Input
                    id={ids.id}
                    className="font-mono"
                    spellCheck={false}
                    autoCapitalize="off"
                    value={item.key}
                    onChange={(e) => update({ key: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t('capabilities.declareDialog.settingValue')}>
                {(ids) => <Input id={ids.id} value={item.value} onChange={(e) => update({ value: e.target.value })} />}
              </Field>
            </>
          )}
        />
      </fieldset>
    </FormDialog>
  );
}

// --- edit -------------------------------------------------------------------------------------

/**
 * What an edit of `capability` sends: each field that differs from it, trimmed. `null` when the
 * account would be emptied (an external id is changed, never removed).
 */
function capabilityEdit(
  capability: CapabilityOut['capability'],
  form: { name: string; description: string; externalId: string },
): UpdateCapabilityInput | null {
  const input: UpdateCapabilityInput = {};
  const name = form.name.trim();
  const description = form.description.trim();
  const account = form.externalId.trim();
  if (name !== capability.name) input.name = name;
  if (description !== capability.description) input.description = description;
  if (account === '' && capability.external_id !== null) return null;
  if (account !== '' && account !== capability.external_id) input.external_id = account;
  return input;
}

export function EditDialog({ target, onClose }: { target: CapabilityOut | null; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [externalId, setExternalId] = useState('');
  const save = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateCapabilityInput }) => updateCapability(id, input),
    onSuccess: async (out) => {
      // A connector bound to another account must be connected again: say so.
      toast.success(t(out.verification_reset ? 'capabilities.editDialog.savedReset' : 'capabilities.editDialog.saved'));
      onClose();
      await invalidateCapabilities(queryClient);
    },
  });
  useEffect(() => {
    const c = target?.capability;
    setName(c?.name ?? '');
    setDescription(c?.description ?? '');
    setExternalId(c?.external_id ?? '');
    save.reset();
  }, [target?.capability.id]);
  if (!target) return null;
  const c = target.capability;
  const input = capabilityEdit(c, { name, description, externalId });
  const changed = input !== null && Object.keys(input).length > 0;
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('capabilities.editDialog.title', { name: c.name })}
      description={t('capabilities.editDialog.description')}
      error={save.error}
      submitLabel={t('common.save')}
      submitting={save.isPending}
      submitDisabled={!changed || name.trim() === ''}
      onSubmit={() => input && save.mutate({ id: c.id, input })}
    >
      <Field label={t('fields.name')} required>
        {(ids) => <Input id={ids.id} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label={t('fields.description')}>
        {(ids) => <Textarea id={ids.id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}
      </Field>
      <Field label={t('fields.external_id')} hint={t('capabilities.editDialog.externalIdHint')}>
        {(ids) => (
          <Input
            id={ids.id}
            aria-describedby={ids.describedBy}
            autoComplete="off"
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
          />
        )}
      </Field>
      {c.reach === 'connector' && <Callout tone="warning">{t('capabilities.editDialog.connectorWarning')}</Callout>}
    </FormDialog>
  );
}

// --- verify -----------------------------------------------------------------------------------

export function VerifyDialog({ target, onClose }: { target: CapabilityOut | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [refs, setRefs] = useState<{ ref: string }[]>([]);
  const verify = useCapabilityMutation(
    ({ id, text, refs }: { id: string; text: string; refs: string[] }) => verifyCapability(id, { text, refs }),
    t('capabilities.verifyDialog.verified'),
    onClose,
  );
  useEffect(() => {
    setText('');
    setRefs([]);
    verify.reset();
  }, [target?.capability.id]);
  if (!target) return null;
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('capabilities.verifyDialog.title', { name: target.capability.name })}
      description={t('capabilities.verifyDialog.description')}
      error={verify.error}
      submitLabel={t('capabilities.verifyDialog.submit')}
      submitting={verify.isPending}
      submitDisabled={text.trim() === ''}
      onSubmit={() =>
        verify.mutate({
          id: target.capability.id,
          text: text.trim(),
          refs: refs.map((r) => r.ref.trim()).filter((r) => r !== ''),
        })
      }
    >
      <Field label={t('capabilities.verifyDialog.evidence')} hint={t('capabilities.verifyDialog.evidenceHint')} required>
        {(ids) => (
          <Textarea
            id={ids.id}
            aria-describedby={ids.describedBy}
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-foreground">{t('capabilities.verifyDialog.refs')}</legend>
        <p className="text-caption text-muted-foreground">{t('capabilities.verifyDialog.refsHint')}</p>
        <ListRows<{ ref: string }>
          items={refs}
          onChange={setRefs}
          makeItem={() => ({ ref: '' })}
          addLabel={t('capabilities.verifyDialog.addRef')}
          removeLabel={t('strategy.remove')}
          renderRow={(item, update) => (
            <Field label={t('capabilities.verifyDialog.ref')} className="sm:col-span-2">
              {(ids) => (
                <Input
                  id={ids.id}
                  className="font-mono"
                  spellCheck={false}
                  value={item.ref}
                  onChange={(e) => update({ ref: e.target.value })}
                />
              )}
            </Field>
          )}
        />
      </fieldset>
    </FormDialog>
  );
}

// --- policy -----------------------------------------------------------------------------------

const HOURS_FROM = Array.from({ length: 24 }, (_, h) => h);
const HOURS_TO = Array.from({ length: 24 }, (_, h) => h + 1);
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function HourSelect({
  id,
  hours,
  value,
  onChange,
}: {
  id: string;
  hours: readonly number[];
  value: number;
  onChange: (hour: number) => void;
}) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {hours.map((h) => (
          <SelectItem key={h} value={String(h)}>
            {formatHour(h)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function PolicyDialog({ target, onClose }: { target: CapabilityOut | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const daysId = useId();
  const [hoursOn, setHoursOn] = useState(false);
  const [tz, setTz] = useState('UTC');
  const [from, setFrom] = useState(9);
  const [to, setTo] = useState(18);
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [dailyCap, setDailyCap] = useState<number | null>(null);
  const [spendCap, setSpendCap] = useState<number | null>(null);
  const [human, setHuman] = useState(false);
  const [maxAge, setMaxAge] = useState<number | null>(DEFAULT_VERIFY_MAX_AGE_DAYS);
  const save = useCapabilityMutation(
    ({ id, policy }: { id: string; policy: Policy }) => setPolicy(id, policy),
    t('capabilities.policyDialog.saved'),
    onClose,
  );

  useEffect(() => {
    const p = target?.capability.policy;
    if (!p) return;
    setHoursOn(p.active_hours !== null);
    setTz(p.active_hours?.tz ?? localZone());
    setFrom(p.active_hours?.from ?? 9);
    setTo(p.active_hours?.to ?? 18);
    setDays(p.active_hours?.days ?? [1, 2, 3, 4, 5]);
    setDailyCap(p.daily_ops_cap);
    setSpendCap(p.spend_cap_minor);
    setHuman(p.requires_human_approval);
    setMaxAge(p.verify_max_age_days);
    save.reset();
  }, [target?.capability.id]);

  if (!target) return null;
  const toggleDay = (day: number, on: boolean) =>
    setDays((current) => (on ? [...new Set([...current, day])] : current.filter((d) => d !== day)).sort((a, b) => a - b));
  const policy: Policy = {
    active_hours: hoursOn ? { tz: tz.trim(), from, to, days } : null,
    daily_ops_cap: dailyCap,
    spend_cap_minor: spendCap,
    requires_human_approval: human,
    // An emptied field means the default, never "no expiry" (that is an explicit 0).
    verify_max_age_days: maxAge ?? DEFAULT_VERIFY_MAX_AGE_DAYS,
  };

  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('capabilities.policyDialog.title', { name: target.capability.name })}
      description={t('capabilities.policyDialog.description')}
      error={save.error}
      submitLabel={t('common.save')}
      submitting={save.isPending}
      onSubmit={() => save.mutate({ id: target.capability.id, policy })}
    >
      <div className="flex items-center gap-3">
        <Switch id={`${daysId}-hours`} checked={hoursOn} onCheckedChange={setHoursOn} />
        <Label htmlFor={`${daysId}-hours`} className="font-normal">
          {t('capabilities.policyDialog.hoursEnabled')}
        </Label>
      </div>
      {hoursOn && (
        <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
          <Field label={t('capabilities.policyDialog.tz')} hint={t('capabilities.policyDialog.tzHint')} className="sm:col-span-2">
            {(ids) => (
              <Input
                id={ids.id}
                aria-describedby={ids.describedBy}
                className="font-mono"
                spellCheck={false}
                value={tz}
                onChange={(e) => setTz(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('capabilities.policyDialog.from')}>
            {(ids) => <HourSelect id={ids.id} hours={HOURS_FROM} value={from} onChange={setFrom} />}
          </Field>
          <Field label={t('capabilities.policyDialog.to')} hint={t('capabilities.policyDialog.toHint')}>
            {(ids) => <HourSelect id={ids.id} hours={HOURS_TO} value={to} onChange={setTo} />}
          </Field>
          <fieldset className="flex flex-col gap-2 sm:col-span-2">
            <legend className="mb-1 text-sm font-medium text-foreground">{t('capabilities.policyDialog.days')}</legend>
            <div className="flex flex-wrap gap-3">
              {WEEKDAYS.map((day) => (
                <div key={day} className="flex items-center gap-1.5">
                  <Checkbox
                    id={`${daysId}-${day}`}
                    checked={days.includes(day)}
                    onCheckedChange={(checked) => toggleDay(day, checked === true)}
                  />
                  <Label htmlFor={`${daysId}-${day}`} className="font-normal">
                    {weekdayName(day, i18n.language)}
                  </Label>
                </div>
              ))}
            </div>
          </fieldset>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('capabilities.policyDialog.dailyOpsCap')} hint={t('capabilities.policyDialog.capHint')}>
          {(ids) => (
            <WholeNumberInput id={ids.id} describedBy={ids.describedBy} min={0} value={dailyCap} onChange={setDailyCap} />
          )}
        </Field>
        <Field label={t('capabilities.policyDialog.spendCap')} hint={t('capabilities.policyDialog.capHint')}>
          {(ids) => (
            <WholeNumberInput id={ids.id} describedBy={ids.describedBy} min={0} value={spendCap} onChange={setSpendCap} />
          )}
        </Field>
        <Field label={t('capabilities.policyDialog.verifyMaxAge')} hint={t('capabilities.policyDialog.verifyMaxAgeHint')}>
          {(ids) => (
            <WholeNumberInput id={ids.id} describedBy={ids.describedBy} min={0} max={65535} value={maxAge} onChange={setMaxAge} />
          )}
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Switch id={`${daysId}-human`} checked={human} onCheckedChange={setHuman} />
        <Label htmlFor={`${daysId}-human`} className="font-normal">
          {t('capabilities.policyDialog.humanApproval')}
        </Label>
      </div>
    </FormDialog>
  );
}

// --- unreachable ------------------------------------------------------------------------------

export function UnreachableDialog({ target, onClose }: { target: CapabilityOut | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const mark = useCapabilityMutation(
    ({ id, reason }: { id: string; reason: string }) => markUnreachable(id, reason),
    t('capabilities.unreachableDialog.marked'),
    onClose,
  );
  useEffect(() => {
    setReason('');
    mark.reset();
  }, [target?.capability.id]);
  if (!target) return null;
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('capabilities.unreachableDialog.title', { name: target.capability.name })}
      description={t('capabilities.unreachableDialog.description')}
      error={mark.error}
      submitLabel={t('capabilities.unreachableDialog.submit')}
      submitting={mark.isPending}
      submitDisabled={reason.trim() === ''}
      onSubmit={() => mark.mutate({ id: target.capability.id, reason: reason.trim() })}
    >
      <Field label={t('fields.reason')} required>
        {(ids) => <Textarea id={ids.id} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
    </FormDialog>
  );
}

// --- link a budget item -----------------------------------------------------------------------

export function LinkBudgetDialog({
  target,
  budgetItems,
  onClose,
}: {
  target: CapabilityOut | null;
  budgetItems: readonly BudgetItemOut[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [itemId, setItemId] = useState('');
  const link = useCapabilityMutation(
    ({ id, itemId }: { id: string; itemId: string }) => linkBudget(id, itemId),
    t('capabilities.linkDialog.linked'),
    onClose,
  );
  useEffect(() => {
    setItemId('');
    link.reset();
  }, [target?.capability.id]);
  if (!target) return null;
  const c = target.capability;
  // A retired item takes no links.
  const fitting = budgetItems.filter(
    (b) =>
      b.item.retired_at === null && canLinkBudget(c.kind_key, b.item.kind) && !c.budget_item_ids.includes(b.item.id),
  );
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('capabilities.linkDialog.title', { name: c.name })}
      description={t('capabilities.linkDialog.description')}
      error={link.error}
      submitLabel={t('capabilities.linkDialog.submit')}
      submitting={link.isPending}
      submitDisabled={itemId === ''}
      onSubmit={() => link.mutate({ id: c.id, itemId })}
    >
      {fitting.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('capabilities.linkDialog.none')}</p>
      ) : (
        <Field label={t('fields.budget_item_id')} required>
          {(ids) => (
            <Select value={itemId} onValueChange={setItemId}>
              <SelectTrigger id={ids.id}>
                <SelectValue placeholder={t('capabilities.linkDialog.placeholder')} />
              </SelectTrigger>
              <SelectContent>
                {fitting.map((b) => (
                  <SelectItem key={b.item.id} value={b.item.id}>
                    {b.item.name}
                    <span className="ms-2 text-micro text-muted-foreground">{t(`budget.kinds.${b.item.kind}`)}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      )}
    </FormDialog>
  );
}
