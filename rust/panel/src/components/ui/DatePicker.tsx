import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { DayPicker } from 'react-day-picker';
import { format } from 'date-fns';
import { CalendarIcon } from 'lucide-react';
import { cn } from './cn';

export interface DatePickerProps {
  value: Date | null;
  onChange: (date: Date) => void;
  placeholder?: string;
  'aria-label'?: string;
  className?: string;
}

export function DatePicker({
  value,
  onChange,
  placeholder = 'Pick a date',
  'aria-label': ariaLabel = 'Date',
  className,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);

  const handleSelect = (date: Date | undefined) => {
    if (date) {
      onChange(date);
      setOpen(false);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            'inline-flex h-9 w-full items-center gap-2 rounded-lg border border-border-strong bg-surface px-3 text-sm',
            'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-primary',
            'disabled:cursor-not-allowed disabled:opacity-50',
            !value && 'text-muted-foreground',
            className,
          )}
        >
          <CalendarIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>{value ? format(value, 'PPP') : placeholder}</span>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className={cn(
            'z-50 rounded-lg border border-border bg-surface-raised p-3 shadow-md',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          )}
        >
          <DayPicker
            mode="single"
            selected={value ?? undefined}
            onSelect={handleSelect}
            defaultMonth={value ?? new Date()}
            classNames={{
              months: 'flex flex-col',
              month: 'space-y-3',
              month_caption: 'flex items-center justify-between px-1 py-1',
              caption_label: 'text-sm font-medium text-foreground',
              nav: 'flex items-center gap-1',
              button_previous: cn(
                'inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-muted-foreground',
                'hover:bg-surface-muted hover:text-foreground transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:opacity-50 disabled:pointer-events-none',
              ),
              button_next: cn(
                'inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-muted-foreground',
                'hover:bg-surface-muted hover:text-foreground transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:opacity-50 disabled:pointer-events-none',
              ),
              month_grid: 'w-full border-collapse',
              weekdays: 'flex',
              weekday: 'w-8 text-center text-micro font-medium text-muted-foreground pb-1',
              weeks: 'flex flex-col gap-0.5',
              week: 'flex',
              day: 'w-8 h-8 p-0 text-center relative',
              day_button: cn(
                'h-8 w-8 rounded-md text-sm font-normal text-foreground transition-colors',
                'hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              ),
              selected:
                '[&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary-hover',
              today: '[&>button]:font-semibold [&>button]:underline',
              outside: '[&>button]:text-muted-foreground [&>button]:opacity-40',
              disabled: '[&>button]:opacity-30 [&>button]:pointer-events-none',
              hidden: 'invisible',
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
