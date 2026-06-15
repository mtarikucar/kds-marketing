import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { extendTailwindMerge } from 'tailwind-merge';
import { clsx, type ClassValue } from 'clsx';
import { cn as cnBase } from './cn';

/**
 * Custom tailwind-merge that knows our semantic text-color tokens are color
 * utilities, not font-size utilities — prevents twMerge from treating
 * `text-success` as conflicting with `text-caption` (a custom font-size token).
 */
const twMerge = extendTailwindMerge({
  override: {
    classGroups: {
      // Register semantic color tokens so they aren't treated as font-size
      // utilities and don't get stripped by twMerge when combined with
      // custom size tokens like `text-caption` / `text-micro`.
      'text-color': [
        'text-success', 'text-warning', 'text-danger', 'text-info',
        'text-primary', 'text-muted-foreground', 'text-foreground', 'text-accent',
      ],
    },
  },
});

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const tag = cva('inline-flex items-center gap-1 rounded-full font-medium', {
  variants: {
    tone: {
      neutral: 'bg-surface-muted text-muted-foreground',
      primary: 'bg-primary/10 text-primary',
      success: 'bg-success-subtle text-success',
      warning: 'bg-warning-subtle text-warning',
      danger: 'bg-danger-subtle text-danger',
      info: 'bg-info-subtle text-info',
    },
    size: { sm: 'px-2 py-0.5 text-micro', md: 'px-2.5 py-0.5 text-caption' },
  },
  defaultVariants: { tone: 'neutral', size: 'md' },
});

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof tag> {
  label: string;
  onRemove?: () => void;
}

export function Tag({ className, tone, size, label, onRemove, ...props }: TagProps) {
  return (
    <span className={cn(tag({ tone, size }), className)} {...props}>
      {label}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
          className={cnBase(
            'ms-0.5 inline-flex items-center justify-center rounded-full hover:opacity-70',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
