import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * Class-name merge helper. `clsx` flattens conditional/array/object inputs into
 * a class string; `twMerge` then lets later Tailwind utilities win over earlier
 * conflicting ones, so callers can pass a `className` override without fighting
 * a component's defaults.
 *
 * twMerge is extended to know the Console design system's custom font-size
 * tokens (`text-caption`, `text-micro`, `text-h1`, …). Without this, twMerge
 * misclassifies them as text-COLOR utilities and strips a sibling semantic color
 * like `text-success` (e.g. on a Badge), silently dropping the color. Registering
 * them in the `font-size` group keeps size and color independent. Standard
 * Tailwind color/size recognition is preserved (we `extend`, never `override`).
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['micro', 'caption', 'body-lg', 'h1', 'h2', 'h3', 'display'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
