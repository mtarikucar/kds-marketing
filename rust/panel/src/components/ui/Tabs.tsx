import { forwardRef } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from './cn';

/**
 * Tabs built on @radix-ui/react-tabs. Underline-style triggers: active tab
 * gets `text-foreground` + a bottom `border-primary` indicator.
 */
export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'inline-flex items-end border-b border-border w-full gap-0',
      className,
    )}
    {...props}
  />
));
TabsList.displayName = 'TabsList';

export const TabsTrigger = forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      // Base layout
      'relative inline-flex items-center justify-center whitespace-nowrap px-4 pb-2.5 pt-2 text-sm font-medium',
      // Transition
      'transition-colors duration-fast',
      // Focus
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--ring] focus-visible:ring-offset-0',
      // Disabled
      'disabled:pointer-events-none disabled:opacity-50',
      // Inactive
      'text-muted-foreground hover:text-foreground',
      // Active — bottom border indicator
      'data-[state=active]:text-foreground',
      'data-[state=active]:after:absolute data-[state=active]:after:inset-x-0 data-[state=active]:after:bottom-0',
      'data-[state=active]:after:block data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-primary',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent = forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'mt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--ring]',
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = 'TabsContent';
