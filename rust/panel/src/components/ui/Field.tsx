import { useId } from 'react';
import { Label } from './Label';
import { cn } from './cn';

export interface FieldProps {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  /** render-prop receives the ids to attach to the control */
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => React.ReactNode;
}

export function Field({ label, hint, error, required, className, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <Label htmlFor={id}>
          {label}
          {required && (
            <span className="ms-0.5 text-danger" aria-hidden="true">
              *
            </span>
          )}
        </Label>
      )}
      {children({ id, describedBy, invalid: !!error })}
      {hint && !error && (
        <p id={hintId} className="text-caption text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-caption text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
