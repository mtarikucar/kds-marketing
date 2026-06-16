import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox, Tag } from '@/components/ui';
import { useTags } from '../hooks';

interface TagPickerProps {
  /** Selected tag names (the backend assigns/creates tags by name). */
  value: string[];
  onChange: (names: string[]) => void;
  /** Allow creating a new tag by typing a name not yet in the list. */
  allowCreate?: boolean;
  className?: string;
}

/**
 * Reusable multi-select tag picker. Backed by the `/tags` list; selection is by
 * tag NAME because the lead-tagging endpoints (`bulk-assign`, lead assign) take
 * names and auto-create unknown ones — so this composes with both saved tags and
 * ad-hoc ones. Drop it into the leads UI to tag a lead.
 */
export function TagPicker({ value, onChange, allowCreate = true, className }: TagPickerProps) {
  const { t } = useTranslation('marketing');
  const { data: tags } = useTags();

  const options = useMemo(() => {
    const fromApi = (tags ?? []).map((tg) => ({ value: tg.name, label: tg.name }));
    // Surface any selected names that aren't (yet) in the workspace taxonomy.
    const extra = value
      .filter((name) => !fromApi.some((o) => o.value === name))
      .map((name) => ({ value: name, label: name }));
    return [...fromApi, ...extra].filter((o) => !value.includes(o.value));
  }, [tags, value]);

  const colorFor = (name: string) => (tags ?? []).find((tg) => tg.name === name)?.color ?? undefined;

  return (
    <div className={className}>
      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {value.map((name) => {
            const color = colorFor(name);
            return (
              <Tag
                key={name}
                label={name}
                onRemove={() => onChange(value.filter((n) => n !== name))}
                style={color ? { backgroundColor: `${color}1a`, color } : undefined}
              />
            );
          })}
        </div>
      )}
      <Combobox
        aria-label={t('crm.tags.pickerLabel', { defaultValue: 'Add tag' })}
        placeholder={
          allowCreate
            ? t('crm.tags.pickerCreate', { defaultValue: 'Add or create a tag…' })
            : t('crm.tags.pickerPlaceholder', { defaultValue: 'Add a tag…' })
        }
        options={options}
        value=""
        onChange={(name) => {
          if (name && !value.includes(name)) onChange([...value, name]);
        }}
      />
    </div>
  );
}
