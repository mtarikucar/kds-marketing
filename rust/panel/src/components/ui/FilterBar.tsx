import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { cn } from './cn';
import { Input } from './Input';

export interface FilterBarSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /**
   * Debounce (ms) before a keystroke propagates to `onChange`. Defaults to 250.
   * Pass 0 for the old instant behaviour. Every consumer feeds `onChange` into a
   * server-side query key, so debouncing turns "istanbul" from 8 backend requests
   * (+ result flicker) into one.
   */
  debounceMs?: number;
}

export interface FilterBarProps {
  search?: FilterBarSearchProps;
  children?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}

/**
 * The search box keeps its own `text` state so typing stays instant, but only
 * propagates to `onChange` (which drives the query) after `debounceMs` of quiet.
 * The `text === value` guard skips the parent's echo-back and any external reset,
 * so this never loops against the controlled `value`.
 */
function SearchInput({ value, onChange, placeholder, debounceMs = 250 }: FilterBarSearchProps) {
  const [text, setText] = useState(value);

  // Mirror an external value change (filter reset, deep-link) into the box,
  // without clobbering what the user is mid-typing.
  useEffect(() => {
    setText(value);
  }, [value]);

  useEffect(() => {
    if (text === value) return; // nothing new (incl. the echo-back / external sync)
    const id = setTimeout(() => onChange(text), debounceMs);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, debounceMs]);

  return (
    <div className="relative flex items-center">
      <Search
        className="absolute start-2.5 h-4 w-4 text-muted-foreground pointer-events-none"
        aria-hidden="true"
      />
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder ?? 'Search…'}
        className="ps-8 w-60"
        aria-label={placeholder ?? 'Search'}
      />
    </div>
  );
}

export function FilterBar({ search, children, right, className }: FilterBarProps) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {search && <SearchInput {...search} />}
      {children}
      {right && (
        <div className="ms-auto flex items-center gap-2">
          {right}
        </div>
      )}
    </div>
  );
}
