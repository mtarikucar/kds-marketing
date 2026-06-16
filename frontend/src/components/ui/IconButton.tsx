import { forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

const iconButton = cva(
  'inline-flex items-center justify-center rounded-lg font-medium transition-colors duration-fast ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary-hover shadow-xs',
        secondary: 'bg-surface-muted text-foreground hover:bg-border',
        outline: 'border border-border-strong bg-surface text-foreground hover:bg-surface-muted',
        ghost: 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
        destructive: 'bg-danger text-danger-foreground hover:opacity-90 shadow-xs',
      },
      size: { sm: 'h-8 w-8', md: 'h-9 w-9', lg: 'h-10 w-10' },
    },
    defaultVariants: { variant: 'ghost', size: 'md' },
  },
);

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButton> {
  /** Required: announces button purpose to screen readers. */
  'aria-label': string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant, size, children, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      className={cn(iconButton({ variant, size }), className)}
      {...props}
    >
      {/* Wrap child icon with aria-hidden so the aria-label is the sole SR announcement */}
      <span aria-hidden="true">{children}</span>
    </button>
  ),
);
IconButton.displayName = 'IconButton';
