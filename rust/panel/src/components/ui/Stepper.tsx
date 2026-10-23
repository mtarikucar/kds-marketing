import { cn } from './cn';

export interface StepperStep {
  id: string;
  label: string;
}

export interface StepperProps {
  steps: StepperStep[];
  current: number;
  onStepClick?: (index: number) => void;
  className?: string;
  'aria-label': string;
}

export function Stepper({
  steps,
  current,
  onStepClick,
  className,
  'aria-label': ariaLabel,
}: StepperProps) {
  return (
    <nav aria-label={ariaLabel} className={cn('w-full', className)}>
      <ol role="list" className="flex items-center gap-2">
        {steps.map((step, index) => {
          const isActive = index === current;
          const isComplete = index < current;
          const canNavigate = isComplete && !!onStepClick;
          return (
            <li key={step.id} className="flex flex-1 items-center gap-2">
              <button
                type="button"
                aria-current={isActive ? 'step' : undefined}
                disabled={!canNavigate}
                onClick={() => canNavigate && onStepClick!(index)}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1 text-sm font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isActive
                    ? 'text-foreground'
                    : isComplete
                      ? 'text-muted-foreground hover:text-foreground'
                      : 'cursor-default text-muted-foreground/60',
                )}
              >
                <span
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs',
                    isActive
                      ? 'border-primary bg-primary text-primary-foreground'
                      : isComplete
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border',
                  )}
                >
                  {index + 1}
                </span>
                <span className="hidden sm:inline">{step.label}</span>
              </button>
              {index < steps.length - 1 && <span aria-hidden className="h-px flex-1 bg-border" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
