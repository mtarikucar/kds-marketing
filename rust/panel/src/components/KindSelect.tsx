import { useTranslation } from 'react-i18next';
import { ANY_CHANNEL, KIND_GROUPS } from '@/api/types';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import { kindsInGroup } from '@/lib/capabilities';

export interface KindSelectProps {
  value: string;
  onChange: (key: string) => void;
  id?: string;
  label?: string;
  placeholder?: string;
  /** Also offer `any`, the channel that stands for any channel (strategy channels). */
  withAny?: boolean;
  /** Only these kind keys (e.g. the strategy's own channels); every kind when left out. */
  only?: readonly string[];
  disabled?: boolean;
  className?: string;
}

/** A capability kind picker, grouped by kind group, each kind with its key beside its name. */
export function KindSelect({
  value,
  onChange,
  id,
  label,
  placeholder,
  withAny,
  only,
  disabled,
  className,
}: KindSelectProps) {
  const { t } = useTranslation();
  const allowed = (key: string) => !only || only.includes(key);
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} aria-label={label} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-80">
        {withAny && allowed(ANY_CHANNEL) && (
          <SelectItem value={ANY_CHANNEL}>{t('strategy.anyChannel')}</SelectItem>
        )}
        {KIND_GROUPS.map((group) => {
          const kinds = kindsInGroup(group).filter((k) => allowed(k.key));
          if (kinds.length === 0) return null;
          return (
            <SelectGroup key={group}>
              <SelectLabel>{t(`capabilities.groups.${group}`)}</SelectLabel>
              {kinds.map((kind) => (
                <SelectItem key={kind.key} value={kind.key}>
                  {t(`capabilities.kinds.${kind.key}`)}
                  <span className="ms-2 font-mono text-micro text-muted-foreground">{kind.key}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          );
        })}
      </SelectContent>
    </Select>
  );
}
