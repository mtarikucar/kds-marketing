import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { KINDS } from '@/api/types';
import { cn } from '@/components/ui';
import { CAPABILITY_GROUPS, requirementLabel, requirementTerms } from '@/lib/requirements';

/**
 * A blueprint's required capabilities, chosen from the capability groups and kinds the system
 * knows (spec 2026-11-10 module gating). Each chosen line must be connected before the module
 * opens. Free-text lines (an imported legacy blueprint) are kept as notes that never gate.
 */
export function RequirementPicker({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const { t, i18n } = useTranslation();
  const tr = i18n.language.startsWith('tr');
  const or = tr ? 'veya' : 'or';
  const toggle = (line: string) => onChange(value.includes(line) ? value.filter(v => v !== line) : [...value, line]);
  const gating = value.filter(line => requirementTerms(line));
  const notes = value.filter(line => !requirementTerms(line));
  return <div className="flex flex-col gap-3">
    <div role="group" aria-label={tr ? 'Yetenek grupları' : 'Capability groups'} className="flex flex-wrap gap-1.5">
      {CAPABILITY_GROUPS.map(group => <button key={group} type="button" aria-pressed={value.includes(group)} onClick={() => toggle(group)}
        className={cn('rounded-full border px-3 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          value.includes(group) ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-surface text-muted-foreground hover:text-foreground')}>
        {t(`capabilities.groups.${group}`)}
      </button>)}
    </div>
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {tr ? 'Belirli bir tür ekle' : 'Add a specific kind'}
      <select className="min-w-0 rounded-md border border-input bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        value="" onChange={event => { const kind = event.target.value; if (kind && !value.includes(kind)) onChange([...value, kind]); }}>
        <option value="">{tr ? 'Tür seç…' : 'Choose a kind…'}</option>
        {CAPABILITY_GROUPS.map(group => <optgroup key={group} label={t(`capabilities.groups.${group}`)}>
          {KINDS.filter(kind => kind.group === group).map(kind => <option key={kind.key} value={kind.key} disabled={value.includes(kind.key)}>{t(`capabilities.kinds.${kind.key}` as never)}</option>)}
        </optgroup>)}
      </select>
    </label>
    {(gating.length > 0 || notes.length > 0) && <ul className="flex flex-col gap-1.5" aria-label={tr ? 'Seçilen gereksinimler' : 'Chosen requirements'}>
      {gating.map(line => <li key={line} className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-muted/50 px-3 py-1.5 text-sm">
        <span>{requirementLabel(t, line, or)}</span>
        <button type="button" onClick={() => toggle(line)} aria-label={`${tr ? 'Kaldır' : 'Remove'}: ${requirementLabel(t, line, or)}`} className="rounded p-0.5 text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
      </li>)}
      {notes.map(line => <li key={line} className="flex items-center justify-between gap-2 rounded-md border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground">
        <span><span className="me-1 text-xs uppercase">{tr ? 'Not' : 'Note'}</span>{line}</span>
        <button type="button" onClick={() => toggle(line)} aria-label={`${tr ? 'Kaldır' : 'Remove'}: ${line}`} className="rounded p-0.5 hover:text-foreground"><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
      </li>)}
    </ul>}
    <p className="text-xs leading-5 text-muted-foreground">{tr ? 'Her satır ayrı bir ihtiyaçtır; modül, hepsi için bağlı ve doğrulanmış bir yetenek olunca açılır. Grup seçersen o gruptaki herhangi bir yetenek yeter.' : 'Each line is a separate need; the module opens once each has a connected, verified capability. A group accepts any capability of that group.'}</p>
  </div>;
}
