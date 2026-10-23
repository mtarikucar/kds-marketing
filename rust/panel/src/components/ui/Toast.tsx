import { Toaster as SonnerToaster, type ToasterProps } from 'sonner';

/**
 * Toast — thin themed wrapper over `sonner`. Re-exports `toast` so callers import
 * everything toast-related from the UI kit (`import { toast } from '@/components/ui'`),
 * and provides a `<Toaster>` preset wired to Console design tokens: top-right
 * placement, surface/border/foreground colours, and our shadow. `richColors` is
 * off so toasts inherit the design-system palette rather than sonner's defaults.
 */
export { toast } from 'sonner';
export type { ExternalToast, ToasterProps } from 'sonner';

export function Toaster(props: ToasterProps) {
  return (
    <SonnerToaster
      position="top-right"
      richColors={false}
      closeButton
      toastOptions={{
        classNames: {
          toast:
            'group rounded-lg border border-border bg-surface-raised text-foreground shadow-lg',
          title: 'text-sm font-medium text-foreground',
          description: 'text-caption text-muted-foreground',
          actionButton: 'bg-primary text-primary-foreground rounded-md',
          cancelButton: 'bg-surface-muted text-foreground rounded-md',
          closeButton: 'border-border bg-surface-raised text-muted-foreground',
        },
      }}
      {...props}
    />
  );
}
Toaster.displayName = 'Toaster';
