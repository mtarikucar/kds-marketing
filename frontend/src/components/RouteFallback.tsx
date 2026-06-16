import { Spinner } from '@/components/ui';

/**
 * Full-area centered loading fallback used as the Suspense boundary for all
 * route-level lazy-loaded page components.
 */
export function RouteFallback() {
  return (
    <div className="flex h-full min-h-[40vh] w-full items-center justify-center">
      <Spinner className="h-6 w-6 text-muted-foreground" />
    </div>
  );
}
