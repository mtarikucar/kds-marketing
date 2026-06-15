import { useState, useRef, useCallback, useId } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, X, Search } from 'lucide-react';
import { cn } from './cn';

export interface ComboboxOption {
  value: string;
  label: string;
}

export interface ComboboxProps {
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  'aria-label': string;
  className?: string;
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  'aria-label': ariaLabel,
  className,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedLabel = options.find((o) => o.value === value)?.label ?? '';

  const filtered = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  const activeId =
    activeIndex >= 0 && filtered[activeIndex]
      ? `${listboxId}-option-${filtered[activeIndex].value}`
      : undefined;

  const handleOpen = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery('');
      setActiveIndex(-1);
    }
  }, []);

  const handleSelect = useCallback(
    (optValue: string) => {
      onChange(optValue);
      handleOpen(false);
    },
    [onChange, handleOpen],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Keyboard-clear the selection (the X affordance is mouse-only and
      // aria-hidden, since it can't be a nested <button> inside the trigger).
      if ((e.key === 'Backspace' || e.key === 'Delete') && value && !query) {
        e.preventDefault();
        onChange('');
        return;
      }
      if (!open) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
          e.preventDefault();
          setOpen(true);
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (activeIndex >= 0 && filtered[activeIndex]) {
            handleSelect(filtered[activeIndex].value);
          }
          break;
        case 'Escape':
          e.preventDefault();
          handleOpen(false);
          break;
        case 'Tab':
          handleOpen(false);
          break;
      }
    },
    [open, activeIndex, filtered, handleSelect, handleOpen, value, query, onChange],
  );

  const handleClear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onChange('');
    },
    [onChange],
  );

  return (
    <Popover.Root open={open} onOpenChange={handleOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={activeId}
          aria-haspopup="listbox"
          onKeyDown={handleKeyDown}
          className={cn(
            'inline-flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-border-strong bg-surface px-3 text-sm',
            'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-primary',
            'disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          <span className={cn('truncate', !selectedLabel && 'text-muted-foreground')}>
            {selectedLabel || placeholder}
          </span>
          <span className="flex items-center gap-1">
            {value && (
              <X
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground hover:text-foreground"
                aria-hidden="true"
                onClick={handleClear}
              />
            )}
            <ChevronDown
              className={cn(
                'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-fast',
                open && 'rotate-180',
              )}
              aria-hidden="true"
            />
          </span>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className={cn(
            'z-50 min-w-[var(--radix-popover-trigger-width)] rounded-lg border border-border bg-surface-raised shadow-md',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          )}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          {/* Search input */}
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              placeholder="Search…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(-1);
              }}
              onKeyDown={handleKeyDown}
              className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              aria-label="Search options"
            />
          </div>

          {/* Options list */}
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            className="max-h-60 overflow-y-auto p-1"
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-muted-foreground">No options found</li>
            ) : (
              filtered.map((option, index) => {
                const isSelected = option.value === value;
                const isActive = index === activeIndex;
                return (
                  <li
                    key={option.value}
                    id={`${listboxId}-option-${option.value}`}
                    role="option"
                    aria-selected={isSelected}
                    onMouseDown={(e) => {
                      // prevent blur before click registers
                      e.preventDefault();
                      handleSelect(option.value);
                    }}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={cn(
                      'flex cursor-pointer select-none items-center rounded-md px-3 py-2 text-sm transition-colors',
                      isActive && 'bg-surface-muted',
                      isSelected && 'text-primary font-medium',
                      !isActive && !isSelected && 'text-foreground hover:bg-surface-muted',
                    )}
                  >
                    {option.label}
                  </li>
                );
              })
            )}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
