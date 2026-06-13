import { twMerge } from 'tailwind-merge';

/**
 * Class-name merge helper. Joins truthy class strings and lets later Tailwind
 * utilities win over earlier conflicting ones (twMerge), so callers can pass a
 * `className` override without fighting the component's defaults.
 */
export function cn(...inputs: Array<string | false | null | undefined>): string {
  return twMerge(inputs.filter(Boolean).join(' '));
}
