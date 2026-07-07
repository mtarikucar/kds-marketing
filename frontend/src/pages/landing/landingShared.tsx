import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '../../components/ui/cn';

/**
 * Shared primitives for the public Jeeta landing page.
 *
 * The landing is intentionally THEME-INDEPENDENT: it uses the Jeeta brand blue
 * (`primary-50/600/700`, which are hard-coded hex in tailwind.config) + slate +
 * white, never the app's `--background`/`--foreground` CSS-var tokens. That way
 * the marketing page looks identical regardless of whether a returning, signed-in
 * visitor has dark mode toggled inside the console.
 */

/** Page-width shell — keep horizontal rhythm consistent across sections. */
export const SHELL = 'mx-auto w-full max-w-7xl px-5 sm:px-8';

/** True once the window has scrolled past `threshold` px. */
export function useScrolled(threshold = 24): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [threshold]);
  return scrolled;
}

/** Respect the user's reduced-motion preference for all reveal/float effects. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return reduced;
}

/** Fades + lifts its children into view the first time they intersect. */
export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced) {
      setShown(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            io.disconnect();
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduced]);

  return (
    <div
      ref={ref}
      style={{ transitionDelay: shown ? `${delay}ms` : '0ms' }}
      className={cn(
        // transition only transform+opacity (not `all`), and NO permanent
        // will-change — dozens of reveal blocks each holding a compositor layer
        // exhausts iOS Safari's GPU memory and causes scroll jank.
        'transition-[transform,opacity] duration-700 ease-standard motion-reduce:transition-none',
        shown ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Small uppercase eyebrow that sits above a section title. */
export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary-600',
        className,
      )}
    >
      {children}
    </span>
  );
}

type Variant = 'primary' | 'glass' | 'light' | 'ghostDark' | 'ghostLight';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-primary-600 text-white shadow-lg shadow-primary-600/30 hover:bg-primary-700 hover:shadow-primary-600/40 hover:-translate-y-0.5',
  glass:
    'bg-white/10 text-white ring-1 ring-inset ring-white/15 sm:backdrop-blur-sm hover:bg-white/15 hover:-translate-y-0.5',
  light:
    'bg-white text-slate-900 ring-1 ring-inset ring-slate-200 shadow-sm hover:bg-slate-50 hover:-translate-y-0.5',
  ghostDark: 'text-slate-200 hover:bg-white/10 hover:text-white',
  ghostLight: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
};

const SIZES: Record<Size, string> = {
  sm: 'h-9 px-3.5 text-sm',
  md: 'h-11 px-5 text-sm',
  lg: 'h-12 px-6 text-base',
};

const BTN_BASE =
  'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-all duration-200 ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/70 focus-visible:ring-offset-2 motion-reduce:transform-none';

interface BtnProps {
  /** Internal route — renders a react-router <Link>. */
  to?: string;
  /** Anchor/external target — renders an <a>. */
  href?: string;
  variant?: Variant;
  size?: Size;
  className?: string;
  children: React.ReactNode;
  onClick?: () => void;
}

/** Theme-independent button used across the landing (Link or anchor). */
export function Btn({ to, href, variant = 'primary', size = 'md', className, children, onClick }: BtnProps) {
  const cls = cn(BTN_BASE, VARIANTS[variant], SIZES[size], className);
  if (to) {
    return (
      <Link to={to} className={cls} onClick={onClick}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={cls} onClick={onClick}>
      {children}
    </a>
  );
}

/** TR / EN segmented language toggle, wired to i18next. */
export function LangToggle({ tone = 'dark', className }: { tone?: 'dark' | 'light'; className?: string }) {
  const { i18n } = useTranslation();
  const current = (i18n.language || 'tr').slice(0, 2);
  const options: Array<'tr' | 'en'> = ['tr', 'en'];

  return (
    <div
      role="group"
      aria-label="Language"
      className={cn(
        'inline-flex items-center rounded-lg p-0.5 text-xs font-semibold',
        tone === 'dark' ? 'bg-white/10 ring-1 ring-inset ring-white/15' : 'bg-slate-100 ring-1 ring-inset ring-slate-200',
        className,
      )}
    >
      {options.map((opt) => {
        // The landing ships TR/EN; if the app booted in another locale (ru/uz/ar)
        // the EN pill stays selected so the control is never in a no-active state.
        const active = opt === 'tr' ? current === 'tr' : current !== 'tr';
        return (
          <button
            key={opt}
            type="button"
            onClick={() => i18n.changeLanguage(opt)}
            aria-pressed={active}
            className={cn(
              'rounded-md px-2.5 py-1 uppercase transition-colors duration-150',
              active
                ? 'bg-white text-slate-900 shadow-sm'
                : tone === 'dark'
                  ? 'text-slate-300 hover:text-white'
                  : 'text-slate-500 hover:text-slate-900',
            )}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}
