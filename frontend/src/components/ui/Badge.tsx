import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

const badge = cva('inline-flex items-center gap-1 rounded-full font-medium', {
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

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badge> {}

export function Badge({ className, tone, size, ...props }: BadgeProps) {
  return <span className={cn(badge({ tone, size }), className)} {...props} />;
}
