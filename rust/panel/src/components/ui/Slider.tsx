import { forwardRef } from 'react';
import * as RadixSlider from '@radix-ui/react-slider';
import { cn } from './cn';

export interface SliderProps
  extends Omit<
    React.ComponentPropsWithoutRef<typeof RadixSlider.Root>,
    'onChange'
  > {
  className?: string;
}

export const Slider = forwardRef<
  React.ElementRef<typeof RadixSlider.Root>,
  SliderProps
>(({ className, ...props }, ref) => (
  <RadixSlider.Root
    ref={ref}
    className={cn(
      'relative flex w-full touch-none select-none items-center',
      className,
    )}
    {...props}
  >
    <RadixSlider.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-surface-muted">
      <RadixSlider.Range className="absolute h-full bg-primary" />
    </RadixSlider.Track>

    {/* Render a thumb for each value in the array (supports multi-handle) */}
    {(props.value ?? props.defaultValue ?? [0]).map((_, i) => (
      <RadixSlider.Thumb
        key={i}
        className={cn(
          'block h-4 w-4 rounded-full border-2 border-primary bg-surface shadow-sm',
          'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      />
    ))}
  </RadixSlider.Root>
));
Slider.displayName = 'Slider';
