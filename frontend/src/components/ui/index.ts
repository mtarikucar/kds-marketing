/**
 * Shared UI kit (M2 design-system foundation).
 *
 * The audit found the panel rebuilds Button/Card/Badge/loading states inline on
 * every page with duplicated Tailwind strings — the main driver of the
 * "inconsistent / unfinished" feel. These primitives are the single source of
 * truth pages migrate onto incrementally. Additive: importing them is opt-in,
 * so existing pages keep working untouched until migrated.
 */
export { Button, type ButtonProps } from './Button';
export { Card, CardHeader, CardTitle, CardContent } from './Card';
export { Badge } from './Badge';
export { Skeleton } from './Skeleton';
export { Spinner } from './Spinner';
export { cn } from './cn';
