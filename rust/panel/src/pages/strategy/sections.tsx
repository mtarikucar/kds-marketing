import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { writeSection } from '@/api/strategy';
import {
  LANE_KINDS,
  LANE_PERIODS,
  type BudgetFrame,
  type Cadence,
  type ChannelChoice,
  type GroupOut,
  type Goals,
  type Identity,
  type LaneKind,
  type LanePeriod,
  type SectionKey,
  type Sections,
  type Segment,
} from '@/api/types';
import { ErrorCallout } from '@/components/ErrorCallout';
import { GapList } from '@/components/GapList';
import { useChannelLabel } from '@/components/HypothesisTable';
import { KindSelect } from '@/components/KindSelect';
import { ListRows, MoneyInput, WholeNumberInput } from '@/components/forms';
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
  Switch,
  Textarea,
  toast,
} from '@/components/ui';
import { gapsOf } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import { invalidateStrategy } from './queries';

const NO_GROUP = '__none__';

/** Writes one section of the draft; the strategy and the pending work are read again after. */
function useSectionWriter<K extends SectionKey>(key: K) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (value: Sections[K]) => writeSection(key, value),
    onSuccess: async () => {
      toast.success(t('strategy.sectionSaved'));
      await invalidateStrategy(queryClient);
    },
  });
}

function Empty() {
  const { t } = useTranslation();
  return <p className="text-sm text-muted-foreground">{t('strategy.empty')}</p>;
}

function Dl({ rows }: { rows: { label: string; value: string }[] }) {
  const { t } = useTranslation();
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      {rows.map((row) => (
        <div key={row.label} className="flex flex-col gap-0.5">
          <dt className="text-caption text-muted-foreground">{row.label}</dt>
          <dd className="whitespace-pre-wrap break-words text-foreground">{row.value || t('common.none')}</dd>
        </div>
      ))}
    </dl>
  );
}

type EditableKey = Exclude<SectionKey, 'paid_enabled'>;

/**
 * One section of a version: read-only, or for the open draft and someone who may run the
 * consultation, an inline form that writes the whole section (`PUT …/sections/{key}`). A refusal
 * lists its gaps under the form.
 */
function EditableSection<K extends EditableKey>({
  sectionKey,
  value,
  editable,
  view,
  editor,
}: {
  sectionKey: K;
  value: Sections[K];
  editable: boolean;
  view: (value: Sections[K]) => ReactNode;
  editor: (value: Sections[K], onChange: (next: Sections[K]) => void) => ReactNode;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<Sections[K] | null>(null);
  const writer = useSectionWriter(sectionKey);
  const title = t(`strategy.sections.${sectionKey}`);
  const cancel = () => {
    setEditing(null);
    writer.reset();
  };
  const gaps = gapsOf(writer.error);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        {editable && editing === null && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(JSON.parse(JSON.stringify(value)) as Sections[K])}>
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            {t('common.edit')}
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {editing === null ? (
          view(value)
        ) : (
          <form
            className="flex flex-col gap-3"
            aria-label={title}
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              writer.mutate(editing, { onSuccess: () => setEditing(null) });
            }}
          >
            {editor(editing, setEditing)}
            <ErrorCallout error={writer.error} />
            <GapList gaps={gaps} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={cancel}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" loading={writer.isPending}>
                {t('common.save')}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// --- identity ---------------------------------------------------------------------------------

function IdentityEditor({ value, onChange }: { value: Identity; onChange: (v: Identity) => void }) {
  const { t } = useTranslation();
  const set = (patch: Partial<Identity>) => onChange({ ...value, ...patch });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('strategy.fields.product')} required>
        {(ids) => <Input id={ids.id} value={value.product} onChange={(e) => set({ product: e.target.value })} />}
      </Field>
      <Field label={t('strategy.fields.voice')}>
        {(ids) => <Input id={ids.id} value={value.voice} onChange={(e) => set({ voice: e.target.value })} />}
      </Field>
      <Field label={t('strategy.fields.positioning')}>
        {(ids) => (
          <Textarea id={ids.id} rows={2} value={value.positioning} onChange={(e) => set({ positioning: e.target.value })} />
        )}
      </Field>
      <Field label={t('strategy.fields.usp')}>
        {(ids) => <Textarea id={ids.id} rows={2} value={value.usp} onChange={(e) => set({ usp: e.target.value })} />}
      </Field>
    </div>
  );
}

// --- channels ---------------------------------------------------------------------------------

function GroupSelect({
  id,
  groups,
  value,
  onChange,
}: {
  id: string;
  groups: readonly GroupOut[];
  value: string | null;
  onChange: (groupId: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <Select value={value ?? NO_GROUP} onValueChange={(v) => onChange(v === NO_GROUP ? null : v)}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_GROUP}>{t('strategy.fields.noGroup')}</SelectItem>
        {groups.map((g) => (
          <SelectItem key={g.group.id} value={g.group.id}>
            {g.group.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// --- the sections -----------------------------------------------------------------------------

export interface SectionsViewProps {
  sections: Sections;
  /** The open draft, for someone who may run the consultation. */
  editable: boolean;
  groups: readonly GroupOut[];
}

/** Every section of a version, each read-only or editable in place. */
export function SectionsView({ sections, editable, groups }: SectionsViewProps) {
  const { t, i18n } = useTranslation();
  const channelLabel = useChannelLabel();
  const groupName = (id: string | null) => (id ? groups.find((g) => g.group.id === id)?.group.name ?? id : null);
  const channelKeys = sections.channels.map((c) => c.channel);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <EditableSection
        sectionKey="identity"
        value={sections.identity}
        editable={editable}
        view={(v) => (
          <Dl
            rows={[
              { label: t('strategy.fields.product'), value: v.product },
              { label: t('strategy.fields.voice'), value: v.voice },
              { label: t('strategy.fields.positioning'), value: v.positioning },
              { label: t('strategy.fields.usp'), value: v.usp },
            ]}
          />
        )}
        editor={(v, on) => <IdentityEditor value={v} onChange={on} />}
      />

      <EditableSection
        sectionKey="audience"
        value={sections.audience}
        editable={editable}
        view={(v) =>
          v.length === 0 ? (
            <Empty />
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {v.map((s) => (
                <li key={s.key}>
                  <span className="font-medium text-foreground">{s.name || s.key}</span>{' '}
                  <code className="font-mono text-micro text-muted-foreground">{s.key}</code>
                  {s.description && <p className="text-muted-foreground">{s.description}</p>}
                </li>
              ))}
            </ul>
          )
        }
        editor={(v, on) => (
          <ListRows<Segment>
            items={v}
            onChange={on}
            makeItem={() => ({ key: '', name: '', description: '' })}
            addLabel={t('strategy.add')}
            removeLabel={t('strategy.remove')}
            renderRow={(item, update) => (
              <>
                <Field label={t('strategy.fields.segmentKey')} hint={t('strategy.fields.segmentKeyHint')} required>
                  {(ids) => (
                    <Input
                      id={ids.id}
                      aria-describedby={ids.describedBy}
                      className="font-mono"
                      spellCheck={false}
                      autoCapitalize="off"
                      value={item.key}
                      onChange={(e) => update({ key: e.target.value })}
                    />
                  )}
                </Field>
                <Field label={t('strategy.fields.segmentName')}>
                  {(ids) => <Input id={ids.id} value={item.name} onChange={(e) => update({ name: e.target.value })} />}
                </Field>
                <Field label={t('strategy.fields.segmentDescription')} className="sm:col-span-2">
                  {(ids) => (
                    <Textarea
                      id={ids.id}
                      rows={2}
                      value={item.description}
                      onChange={(e) => update({ description: e.target.value })}
                    />
                  )}
                </Field>
              </>
            )}
          />
        )}
      />

      <EditableSection
        sectionKey="channels"
        value={sections.channels}
        editable={editable}
        view={(v) =>
          v.length === 0 ? (
            <Empty />
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {v.map((c, i) => (
                <li key={`${c.channel}-${i}`}>
                  <span className="font-medium text-foreground">{channelLabel(c.channel)}</span>
                  {groupName(c.group_id) && (
                    <span className="ms-2 text-caption text-muted-foreground">· {groupName(c.group_id)}</span>
                  )}
                  {c.rationale && <p className="text-muted-foreground">{c.rationale}</p>}
                </li>
              ))}
            </ul>
          )
        }
        editor={(v, on) => (
          <ListRows<ChannelChoice>
            items={v}
            onChange={on}
            makeItem={() => ({ channel: '', rationale: '', group_id: null })}
            addLabel={t('strategy.add')}
            removeLabel={t('strategy.remove')}
            renderRow={(item, update) => (
              <>
                <Field label={t('strategy.fields.channel')} required>
                  {(ids) => (
                    <KindSelect
                      id={ids.id}
                      withAny
                      value={item.channel}
                      placeholder={t('strategy.channelPlaceholder')}
                      onChange={(channel) => update({ channel })}
                    />
                  )}
                </Field>
                <Field label={t('strategy.fields.group')}>
                  {(ids) => (
                    <GroupSelect id={ids.id} groups={groups} value={item.group_id} onChange={(group_id) => update({ group_id })} />
                  )}
                </Field>
                <Field label={t('strategy.fields.rationale')} className="sm:col-span-2">
                  {(ids) => (
                    <Textarea id={ids.id} rows={2} value={item.rationale} onChange={(e) => update({ rationale: e.target.value })} />
                  )}
                </Field>
              </>
            )}
          />
        )}
      />

      <EditableSection
        sectionKey="goals"
        value={sections.goals}
        editable={editable}
        view={(v) => (
          <div className="flex flex-col gap-2 text-sm">
            <p className="whitespace-pre-wrap text-foreground">{v.objective || t('common.none')}</p>
            {v.kpis.length > 0 && (
              <ul className="flex flex-col gap-1">
                {v.kpis.map((k, i) => (
                  <li key={`${k.name}-${i}`} className="text-muted-foreground">
                    <span className="text-foreground">{k.name}</span>: {k.target}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        editor={(v, on) => (
          <div className="flex flex-col gap-3">
            <Field label={t('strategy.fields.objective')}>
              {(ids) => (
                <Textarea id={ids.id} rows={2} value={v.objective} onChange={(e) => on({ ...v, objective: e.target.value })} />
              )}
            </Field>
            <p className="text-sm font-medium text-foreground">{t('strategy.fields.kpis')}</p>
            <ListRows<Goals['kpis'][number]>
              items={v.kpis}
              onChange={(kpis) => on({ ...v, kpis })}
              makeItem={() => ({ name: '', target: '' })}
              addLabel={t('strategy.add')}
              removeLabel={t('strategy.remove')}
              renderRow={(item, update) => (
                <>
                  <Field label={t('strategy.fields.kpiName')}>
                    {(ids) => <Input id={ids.id} value={item.name} onChange={(e) => update({ name: e.target.value })} />}
                  </Field>
                  <Field label={t('strategy.fields.kpiTarget')}>
                    {(ids) => <Input id={ids.id} value={item.target} onChange={(e) => update({ target: e.target.value })} />}
                  </Field>
                </>
              )}
            />
          </div>
        )}
      />

      <EditableSection
        sectionKey="budget_frame"
        value={sections.budget_frame}
        editable={editable}
        view={(v: BudgetFrame) =>
          v.lanes.length === 0 ? (
            <Empty />
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {v.lanes.map((lane, i) => (
                <li key={`${lane.lane}-${i}`} className="text-foreground">
                  {t(`strategy.lanes.${lane.lane}`)} · {t(`strategy.periods.${lane.period}`)} ·{' '}
                  <span className="tabular-nums">{formatMoney(lane.cap_minor, lane.currency, i18n.language)}</span>
                </li>
              ))}
            </ul>
          )
        }
        editor={(v, on) => (
          <ListRows<BudgetFrame['lanes'][number]>
            items={v.lanes}
            onChange={(lanes) => on({ lanes })}
            makeItem={() => ({ lane: 'organic', period: 'monthly', cap_minor: 0, currency: 'TRY' })}
            addLabel={t('strategy.add')}
            removeLabel={t('strategy.remove')}
            renderRow={(item, update) => (
              <>
                <Field label={t('strategy.fields.lane')}>
                  {(ids) => (
                    <Select value={item.lane} onValueChange={(lane) => update({ lane: lane as LaneKind })}>
                      <SelectTrigger id={ids.id}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LANE_KINDS.map((k) => (
                          <SelectItem key={k} value={k}>
                            {t(`strategy.lanes.${k}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Field>
                <Field label={t('strategy.fields.period')}>
                  {(ids) => (
                    <Select value={item.period} onValueChange={(period) => update({ period: period as LanePeriod })}>
                      <SelectTrigger id={ids.id}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LANE_PERIODS.map((p) => (
                          <SelectItem key={p} value={p}>
                            {t(`strategy.periods.${p}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Field>
                <Field label={t('strategy.fields.cap')}>
                  {(ids) => (
                    <MoneyInput
                      id={ids.id}
                      minor={item.cap_minor}
                      currency={item.currency}
                      onChange={(minor) => update({ cap_minor: minor ?? 0 })}
                    />
                  )}
                </Field>
                <Field label={t('strategy.fields.currency')}>
                  {(ids) => (
                    <Input
                      id={ids.id}
                      className="font-mono uppercase"
                      maxLength={3}
                      value={item.currency}
                      onChange={(e) => update({ currency: e.target.value.toUpperCase() })}
                    />
                  )}
                </Field>
              </>
            )}
          />
        )}
      />

      <EditableSection
        sectionKey="prohibitions"
        value={sections.prohibitions}
        editable={editable}
        view={(v) =>
          v.length === 0 ? (
            <Empty />
          ) : (
            <ul className="flex list-disc flex-col gap-1 ps-5 text-sm text-foreground">
              {v.map((p, i) => (
                <li key={`${p}-${i}`}>{p}</li>
              ))}
            </ul>
          )
        }
        editor={(v, on) => (
          <ListRows<{ text: string }>
            items={v.map((text) => ({ text }))}
            onChange={(rows) => on(rows.map((r) => r.text))}
            makeItem={() => ({ text: '' })}
            addLabel={t('strategy.add')}
            removeLabel={t('strategy.remove')}
            renderRow={(item, update) => (
              <Field label={t('strategy.fields.prohibition')} className="sm:col-span-2">
                {(ids) => <Input id={ids.id} value={item.text} onChange={(e) => update({ text: e.target.value })} />}
              </Field>
            )}
          />
        )}
      />

      <EditableSection
        sectionKey="cadence"
        value={sections.cadence}
        editable={editable}
        view={(v: Cadence) => (
          <div className="flex flex-col gap-2 text-sm">
            <p className="text-foreground">
              {t('strategy.fields.perWeek')}: <span className="tabular-nums">{v.per_week}</span>
            </p>
            {v.channel_mix.length > 0 && (
              <ul className="flex flex-col gap-1">
                {v.channel_mix.map((m, i) => (
                  <li key={`${m.channel}-${i}`} className="text-muted-foreground">
                    <span className="text-foreground">{channelLabel(m.channel)}</span>{' '}
                    <span className="tabular-nums">%{m.share_pct}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        editor={(v, on) => {
          const total = v.channel_mix.reduce((sum, m) => sum + (m.share_pct || 0), 0);
          return (
            <div className="flex flex-col gap-3">
              <Field label={t('strategy.fields.perWeek')}>
                {(ids) => (
                  <WholeNumberInput
                    id={ids.id}
                    min={0}
                    max={70}
                    value={v.per_week}
                    onChange={(n) => on({ ...v, per_week: n ?? 0 })}
                  />
                )}
              </Field>
              <p className="text-sm font-medium text-foreground">{t('strategy.fields.channelMix')}</p>
              <ListRows<Cadence['channel_mix'][number]>
                items={v.channel_mix}
                onChange={(channel_mix) => on({ ...v, channel_mix })}
                makeItem={() => ({ channel: channelKeys[0] ?? '', share_pct: 0 })}
                addLabel={t('strategy.add')}
                removeLabel={t('strategy.remove')}
                renderRow={(item, update) => (
                  <>
                    <Field label={t('strategy.fields.channel')}>
                      {(ids) => (
                        <KindSelect
                          id={ids.id}
                          withAny
                          only={channelKeys.length > 0 ? channelKeys : undefined}
                          value={item.channel}
                          placeholder={t('strategy.channelPlaceholder')}
                          onChange={(channel) => update({ channel })}
                        />
                      )}
                    </Field>
                    <Field label={t('strategy.fields.sharePct')}>
                      {(ids) => (
                        <WholeNumberInput
                          id={ids.id}
                          min={0}
                          max={100}
                          value={item.share_pct}
                          onChange={(n) => update({ share_pct: n ?? 0 })}
                        />
                      )}
                    </Field>
                  </>
                )}
              />
              {v.channel_mix.length > 0 && (
                <p className={total === 100 ? 'text-caption text-muted-foreground' : 'text-caption text-danger'}>
                  {t('strategy.fields.mixTotal', { total })}
                </p>
              )}
            </div>
          );
        }}
      />

      <PaidSection value={sections.paid_enabled} editable={editable} />
    </div>
  );
}

/** Whether paid channels are used: a switch written at once for the open draft. */
function PaidSection({ value, editable }: { value: boolean; editable: boolean }) {
  const { t } = useTranslation();
  const writer = useSectionWriter('paid_enabled');
  const label = t('strategy.fields.paidEnabled');
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('strategy.sections.paid_enabled')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          {editable ? (
            <Switch
              checked={value}
              aria-label={label}
              disabled={writer.isPending}
              onCheckedChange={(checked) => writer.mutate(checked)}
            />
          ) : null}
          <span className="text-sm text-foreground">
            {label}: {value ? t('strategy.on') : t('strategy.off')}
          </span>
        </div>
        <ErrorCallout error={writer.error} />
      </CardContent>
    </Card>
  );
}
