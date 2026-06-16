import { forwardRef } from 'react';
import * as AvatarPrimitive from '@radix-ui/react-avatar';
import { cn } from './cn';

/**
 * Avatar built on @radix-ui/react-avatar. Shows an image when available;
 * falls back to initials when the image fails or is not provided.
 *
 * Also exports `AvatarGroup` which stacks multiple avatars with `-ms-2` overlap
 * and renders a `+N` bubble when maxVisible is exceeded.
 */
export const AvatarRoot = forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn(
      'relative flex h-9 w-9 shrink-0 overflow-hidden rounded-full',
      className,
    )}
    {...props}
  />
));
AvatarRoot.displayName = 'AvatarRoot';

export const AvatarImage = forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image
    ref={ref}
    className={cn('aspect-square h-full w-full object-cover', className)}
    {...props}
  />
));
AvatarImage.displayName = 'AvatarImage';

export const AvatarFallback = forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn(
      'flex h-full w-full items-center justify-center rounded-full',
      'bg-surface-muted text-sm font-medium text-muted-foreground',
      className,
    )}
    {...props}
  />
));
AvatarFallback.displayName = 'AvatarFallback';

/** High-level Avatar that composes image + fallback initials. */
export interface AvatarProps extends React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root> {
  src?: string;
  alt?: string;
  /** Initials to show in fallback (e.g. "JD"). Max 2 chars recommended. */
  initials?: string;
  size?: 'sm' | 'md' | 'lg';
}

const sizeClasses = {
  sm: 'h-7 w-7 text-xs',
  md: 'h-9 w-9 text-sm',
  lg: 'h-12 w-12 text-base',
};

export const Avatar = forwardRef<React.ElementRef<typeof AvatarPrimitive.Root>, AvatarProps>(
  ({ src, alt, initials, size = 'md', className, ...props }, ref) => (
    <AvatarRoot ref={ref} className={cn(sizeClasses[size], className)} {...props}>
      {src && <AvatarImage src={src} alt={alt ?? ''} />}
      {/*
        No delayMs: canRender starts true immediately.
        Fallback renders whenever imageLoadingStatus !== "loaded" — which is always
        the case in jsdom (image never fires onLoad). In production the image loads
        and Fallback is hidden; in jsdom tests the Fallback is always visible.
      */}
      <AvatarFallback>
        {initials ?? '?'}
      </AvatarFallback>
    </AvatarRoot>
  ),
);
Avatar.displayName = 'Avatar';

// ─── AvatarGroup ──────────────────────────────────────────────────────────────

export interface AvatarGroupProps {
  /** Avatar data for each member of the group. */
  avatars: Array<{ src?: string; alt?: string; initials?: string }>;
  /** Max number of avatars to show before collapsing to "+N". Default 3. */
  maxVisible?: number;
  size?: AvatarProps['size'];
  className?: string;
}

export function AvatarGroup({ avatars, maxVisible = 3, size = 'md', className }: AvatarGroupProps) {
  const visible = avatars.slice(0, maxVisible);
  const overflow = avatars.length - visible.length;

  return (
    <div className={cn('flex items-center', className)} aria-label={`${avatars.length} members`}>
      {visible.map((av, i) => (
        <Avatar
          key={i}
          src={av.src}
          alt={av.alt}
          initials={av.initials}
          size={size}
          className={cn(
            'ring-2 ring-surface',
            i !== 0 && '-ms-2',
          )}
        />
      ))}
      {overflow > 0 && (
        <span
          aria-label={`+${overflow} more`}
          className={cn(
            'inline-flex shrink-0 items-center justify-center rounded-full',
            'ring-2 ring-surface -ms-2',
            'bg-surface-muted text-sm font-medium text-muted-foreground',
            sizeClasses[size],
          )}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
