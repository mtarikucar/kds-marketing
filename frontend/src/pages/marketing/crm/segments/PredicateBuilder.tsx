import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import {
  Button,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SegmentedControl,
} from '@/components/ui';
import { useTags } from '../hooks';
import {
  buildFieldChoices,
  comparatorsFor,
  reshapeValueForCmp,
  CMP_LABELS,
  LIST_CMP,
  RANGE_CMP,
  VALUELESS_CMP,
  type FieldChoice,
} from '../segmentDsl';
import type { CustomFieldDef, SegmentGroup, SegmentLeaf, SegmentNode } from '../types';
import { isSegmentGroup } from '../types';

/**
 * Visual builder for the segment predicate tree. The root is always a group
 * (`{ op, children }`); each child is either a leaf row (`{ field, cmp, value }`)
 * or a nested group. The serialized shape is exactly what
 * SegmentCompilerService.validate accepts. Common operators are covered; the
 * SegmentDialog provides a raw-JSON escape hatch for anything this doesn't model.
 */

interface BuilderProps {
  defs: CustomFieldDef[];
  value: SegmentGroup;
  onChange: (next: SegmentGroup) => void;
  /** Nesting depth, for the MAX_DEPTH guard styling. */
  depth?: number;
}

function emptyLeaf(): SegmentLeaf {
  return { field: 'status', cmp: 'eq', value: '' };
}

export function PredicateBuilder({ defs, value, onChange, depth = 0 }: BuilderProps) {
  const { t } = useTranslation('marketing');
  const { data: tags } = useTags();
  const choices = buildFieldChoices(defs);
  const choiceFor = (field: string): FieldChoice | undefined => choices.find((c) => c.value === field);

  const setChild = (i: number, child: SegmentNode) => {
    const next = { ...value, children: value.children.map((c, idx) => (idx === i ? child : c)) };
    onChange(next);
  };
  const removeChild = (i: number) => {
    onChange({ ...value, children: value.children.filter((_, idx) => idx !== i) });
  };
  const addLeaf = () => onChange({ ...value, children: [...value.children, emptyLeaf()] });
  const addGroup = () =>
    onChange({ ...value, children: [...value.children, { op: 'and', children: [emptyLeaf()] }] });

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-muted/40 p-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {t('crm.seg.matchLabel', { defaultValue: 'Match' })}
        </span>
        <SegmentedControl<'and' | 'or'>
          aria-label={t('crm.seg.matchLabel', { defaultValue: 'Match' })}
          value={value.op}
          onChange={(op) => onChange({ ...value, op })}
          options={[
            { value: 'and', label: t('crm.seg.all', { defaultValue: 'ALL' }) },
            { value: 'or', label: t('crm.seg.any', { defaultValue: 'ANY' }) },
          ]}
        />
        <span className="text-xs text-muted-foreground">
          {t('crm.seg.ofTheFollowing', { defaultValue: 'of the following' })}
        </span>
      </div>

      <div className="space-y-2">
        {value.children.map((child, i) =>
          isSegmentGroup(child) ? (
            <div key={i} className="flex items-start gap-2">
              <div className="flex-1">
                <PredicateBuilder
                  defs={defs}
                  value={child}
                  depth={depth + 1}
                  onChange={(g) => setChild(i, g)}
                />
              </div>
              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t('common.delete', { defaultValue: 'Delete' })}
                onClick={() => removeChild(i)}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            </div>
          ) : (
            <LeafRow
              key={i}
              leaf={child}
              choices={choices}
              choiceFor={choiceFor}
              tags={(tags ?? []).map((tg) => ({ value: tg.id, label: tg.name }))}
              onChange={(l) => setChild(i, l)}
              onRemove={() => removeChild(i)}
            />
          ),
        )}
        {value.children.length === 0 && (
          <p className="py-2 text-center text-xs text-muted-foreground">
            {t('crm.seg.noRules', { defaultValue: 'No rules — this matches every lead.' })}
          </p>
        )}
      </div>

      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={addLeaf}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('crm.seg.addRule', { defaultValue: 'Add rule' })}
        </Button>
        {depth < 4 && (
          <Button type="button" variant="ghost" size="sm" onClick={addGroup}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('crm.seg.addGroup', { defaultValue: 'Add group' })}
          </Button>
        )}
      </div>
    </div>
  );
}

interface LeafRowProps {
  leaf: SegmentLeaf;
  choices: FieldChoice[];
  choiceFor: (field: string) => FieldChoice | undefined;
  tags: { value: string; label: string }[];
  onChange: (leaf: SegmentLeaf) => void;
  onRemove: () => void;
}

function LeafRow({ leaf, choices, choiceFor, tags, onChange, onRemove }: LeafRowProps) {
  const { t } = useTranslation('marketing');
  const choice = choiceFor(leaf.field);
  const cmps = comparatorsFor(choice);
  const isTag = choice?.group === 'tag';
  const isBool = choice?.dataType === 'bool';
  const hasOptions = !!choice?.options?.length;

  const onFieldChange = (field: string) => {
    const c = choiceFor(field);
    const nextCmps = comparatorsFor(c);
    const nextCmp = nextCmps.includes(leaf.cmp) ? leaf.cmp : nextCmps[0];
    // A bool field needs a CONCRETE value so its Yes/No dropdown shows a selection
    // — an '' renders as an empty (placeholder-less) dropdown yet silently coerces
    // to `false` on the backend, inverting an intended suppression audience.
    const value = c?.dataType === 'bool' ? false : '';
    onChange({ field, cmp: nextCmp, value });
  };

  const onCmpChange = (cmp: string) => {
    if (VALUELESS_CMP.has(cmp)) {
      const { value: _omit, ...rest } = leaf;
      void _omit;
      onChange({ ...rest, cmp });
      return;
    }
    // Reset the value to the shape the NEW comparator expects when the
    // list-vs-scalar category changes, so the builder never serializes a stale
    // array under a scalar `eq` (which the compiler rejects) or vice-versa.
    onChange({ ...leaf, cmp, value: reshapeValueForCmp(cmp, leaf.value) });
  };

  const valueless = VALUELESS_CMP.has(leaf.cmp);
  const isList = LIST_CMP.has(leaf.cmp);
  const isRange = RANGE_CMP.has(leaf.cmp);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface p-2">
      {/* Field */}
      <Select value={leaf.field} onValueChange={onFieldChange}>
        <SelectTrigger className="w-44" aria-label={t('crm.seg.field', { defaultValue: 'Field' })}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((c) => (
            <SelectItem key={c.value} value={c.value}>
              {c.group === 'custom' ? `★ ${c.label}` : c.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Comparator */}
      <Select value={leaf.cmp} onValueChange={onCmpChange}>
        <SelectTrigger className="w-40" aria-label={t('crm.seg.operator', { defaultValue: 'Operator' })}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {cmps.map((c) => (
            <SelectItem key={c} value={c}>
              {t(`crm.seg.cmp.${c}`, { defaultValue: CMP_LABELS[c] ?? c })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Value */}
      {!valueless && (
        <div className="flex flex-1 items-center gap-2">
          {isTag ? (
            <Select
              value={typeof leaf.value === 'string' ? leaf.value : ''}
              onValueChange={(v) => onChange({ ...leaf, value: v })}
            >
              <SelectTrigger className="min-w-40 flex-1" aria-label={t('crm.seg.value', { defaultValue: 'Value' })}>
                <SelectValue placeholder={t('crm.seg.pickTag', { defaultValue: 'Pick a tag' })} />
              </SelectTrigger>
              <SelectContent>
                {tags.map((tg) => (
                  <SelectItem key={tg.value} value={tg.value}>
                    {tg.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : isBool ? (
            <Select
              value={String(leaf.value)}
              onValueChange={(v) => onChange({ ...leaf, value: v === 'true' })}
            >
              <SelectTrigger className="w-32" aria-label={t('crm.seg.value', { defaultValue: 'Value' })}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="true">{t('common.yes', { defaultValue: 'Yes' })}</SelectItem>
                <SelectItem value="false">{t('common.no', { defaultValue: 'No' })}</SelectItem>
              </SelectContent>
            </Select>
          ) : hasOptions && !isList ? (
            <Select
              value={typeof leaf.value === 'string' ? leaf.value : ''}
              onValueChange={(v) => onChange({ ...leaf, value: v })}
            >
              <SelectTrigger className="min-w-40 flex-1" aria-label={t('crm.seg.value', { defaultValue: 'Value' })}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choice!.options!.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : isRange ? (
            <>
              <Input
                aria-label={t('crm.seg.min', { defaultValue: 'Min' })}
                placeholder={t('crm.seg.min', { defaultValue: 'Min' })}
                value={Array.isArray(leaf.value) ? String(leaf.value[0] ?? '') : ''}
                onChange={(e) => {
                  const arr = Array.isArray(leaf.value) ? [...leaf.value] : ['', ''];
                  arr[0] = e.target.value;
                  onChange({ ...leaf, value: arr });
                }}
              />
              <span className="text-xs text-muted-foreground">–</span>
              <Input
                aria-label={t('crm.seg.max', { defaultValue: 'Max' })}
                placeholder={t('crm.seg.max', { defaultValue: 'Max' })}
                value={Array.isArray(leaf.value) ? String(leaf.value[1] ?? '') : ''}
                onChange={(e) => {
                  const arr = Array.isArray(leaf.value) ? [...leaf.value] : ['', ''];
                  arr[1] = e.target.value;
                  onChange({ ...leaf, value: arr });
                }}
              />
            </>
          ) : (
            <Input
              aria-label={t('crm.seg.value', { defaultValue: 'Value' })}
              placeholder={
                isList
                  ? t('crm.seg.commaSeparated', { defaultValue: 'Comma-separated values' })
                  : t('crm.seg.value', { defaultValue: 'Value' })
              }
              value={
                isList
                  ? Array.isArray(leaf.value)
                    ? leaf.value.join(', ')
                    : ''
                  : leaf.value == null
                    ? ''
                    : String(leaf.value)
              }
              onChange={(e) =>
                onChange({
                  ...leaf,
                  value: isList
                    ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
                    : e.target.value,
                })
              }
            />
          )}
        </div>
      )}

      <IconButton
        type="button"
        variant="ghost"
        size="sm"
        aria-label={t('common.delete', { defaultValue: 'Delete' })}
        onClick={onRemove}
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </IconButton>
    </div>
  );
}
