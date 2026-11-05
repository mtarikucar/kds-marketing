import type { ReactNode } from 'react';
import { PageHeader, cn } from '@/components/ui';

export type WorkspaceScene = 'strategy' | 'studio' | 'connections' | 'research';

/** A small editorial photograph belongs to the page introduction, not the work queue. */
export function WorkspaceHeader({
  title,
  description,
  actions,
  scene,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  scene?: WorkspaceScene;
}) {
  if (!scene) return <PageHeader title={title} description={description} actions={actions} />;

  return (
    <header className="grid min-w-0 grid-cols-[minmax(0,1fr)_80px] items-center gap-x-4 gap-y-2 sm:grid-cols-[minmax(0,1fr)_224px] sm:gap-x-8">
      <h1 className="min-w-0 break-words font-display text-h1 text-foreground [overflow-wrap:anywhere] sm:self-end">
        {title}
      </h1>
      <picture
        className={cn(
          'col-start-2 row-start-1 block overflow-hidden rounded-md bg-[#e9e9e6]',
          actions ? 'sm:row-span-3' : 'sm:row-span-2',
        )}
      >
        <source media="(max-width: 639px)" srcSet={`/brand/editorial/${scene}-320.webp`} />
        <img
          src={`/brand/editorial/${scene}-640.webp`}
          alt=""
          aria-hidden="true"
          width={640}
          height={426}
          decoding="async"
          className={cn('h-20 w-20 object-cover sm:w-56', actions ? 'sm:h-36' : 'sm:h-28')}
        />
      </picture>
      {description && (
        <p className="col-span-2 max-w-3xl text-sm leading-6 text-muted-foreground sm:col-span-1 sm:col-start-1 sm:row-start-2 sm:self-start">
          {description}
        </p>
      )}
      {actions && (
        <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-2 pt-1 sm:col-span-1 sm:col-start-1 sm:row-start-3 sm:self-start">
          {actions}
        </div>
      )}
    </header>
  );
}
