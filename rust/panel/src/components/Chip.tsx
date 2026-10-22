import { X } from 'lucide-react';
import { cn } from '@/components/ui';

/** A small named chip, with a remove button when `onRemove` is given (labelled for screen readers). */
export function Chip({
  label,
  onRemove,
  removeLabel,
  disabled,
  className,
}: {
  label: string;
  onRemove?: () => void;
  removeLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full bg-surface-muted px-2.5 py-0.5 text-caption text-foreground',
        className,
      )}
    >
      <span className="truncate">{label}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel ?? label}
          onClick={onRemove}
          disabled={disabled}
          className={cn(
            'inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
          )}
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
