import { forwardRef } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { cn } from './cn';
import { IconButton } from './IconButton';

/**
 * Sheet — a slide-in panel (drawer) built on the same accessible
 * @radix-ui/react-dialog primitive as Dialog, so it inherits role="dialog",
 * aria-modal, focus-trap and Escape-to-close. The panel slides from one of four
 * edges via the `side` cva variant; ideal for mobile navigation and side drawers.
 */
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetPortal = DialogPrimitive.Portal;
export const SheetClose = DialogPrimitive.Close;

export const SheetOverlay = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/50 backdrop-blur-sm',
      'data-[state=open]:animate-in data-[state=closed]:animate-out',
      'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
));
SheetOverlay.displayName = 'SheetOverlay';

const sheet = cva(
  cn(
    'fixed z-50 flex flex-col gap-4 border-border bg-surface-raised p-6 shadow-xl',
    'data-[state=open]:animate-in data-[state=closed]:animate-out',
    'data-[state=open]:duration-slow data-[state=closed]:duration-base data-[state=closed]:ease-standard data-[state=open]:ease-standard',
  ),
  {
    variants: {
      side: {
        top: 'inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
        bottom:
          'inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
        left: 'inset-y-0 start-0 h-full w-3/4 max-w-sm border-e data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left',
        right:
          'inset-y-0 end-0 h-full w-3/4 max-w-sm border-s data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
      },
    },
    defaultVariants: { side: 'right' },
  },
);

export interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
    VariantProps<typeof sheet> {
  /** Hide the built-in top-end close button (e.g. when the panel's own content
   *  provides dismissal, like a nav drawer that closes on item select). The
   *  panel is still closable via Escape and overlay click. */
  hideClose?: boolean;
}

export const SheetContent = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(({ side = 'right', className, children, hideClose, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <DialogPrimitive.Content ref={ref} className={cn(sheet({ side }), className)} {...props}>
      {children}
      {!hideClose && (
        <DialogPrimitive.Close asChild>
          <IconButton aria-label="Close" variant="ghost" size="sm" className="absolute end-4 top-4">
            <X className="h-4 w-4" />
          </IconButton>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = 'SheetContent';

export function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5 text-start', className)} {...props} />;
}
SheetHeader.displayName = 'SheetHeader';

export function SheetFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('mt-auto flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}
SheetFooter.displayName = 'SheetFooter';

export const SheetTitle = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('font-display text-h3 text-foreground', className)}
    {...props}
  />
));
SheetTitle.displayName = 'SheetTitle';

export const SheetDescription = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
SheetDescription.displayName = 'SheetDescription';
