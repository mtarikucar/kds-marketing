# Frontend Redesign — Phase 1: Design System Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the "Console" design-system foundation — tokens (light+dark), fonts, theme switching, and a Radix+cva accessible component library with tests — additively, touching no existing pages.

**Architecture:** CSS-variable design tokens consumed by Tailwind; a Zustand theme store toggles a `.dark` class on `<html>`; UI primitives in `frontend/src/components/ui/` are unstyled Radix behavior + Tailwind styling + `class-variance-authority` variants, each unit-tested with jsdom + Testing Library.

**Tech Stack:** React 18, Tailwind 3.4, Radix UI primitives, class-variance-authority, @tanstack/react-table, react-day-picker, lucide-react, Vitest + @testing-library/react + user-event (jsdom).

**Reference spec:** `docs/superpowers/specs/2026-06-15-frontend-redesign-design.md` (token values, component inventory, a11y/RTL rules).

**Conventions for every component task:**
- File: `frontend/src/components/ui/<Name>.tsx`; co-located test `frontend/src/components/ui/<Name>.test.tsx`.
- Export named (not default). Use `forwardRef` for any control that wraps a DOM node. Spread `...props` and merge `className` via `cn()` (already at `frontend/src/components/ui/cn.ts`).
- Variants via `cva`. Dark mode is automatic (tokens). RTL-safe: prefer logical utilities (`ms-`/`me-`/`ps-`/`pe-`/`start-`/`end-`) and `rtl:` only where needed.
- A11y: real semantics, labelled controls, keyboard + focus-visible ring (`focus-visible:ring-2 focus-visible:ring-[--ring]`).
- After each task: `npm run -s build` (tsc+vite) and `npm test` from `frontend/` must pass, then commit.

---

## File Structure

```
frontend/src/
  index.css                      # MODIFY — token CSS vars (light + :root.dark), base layer
  tailwind.config.js             # MODIFY — map semantic tokens, fonts, radius, shadows, motion
  index.html                     # MODIFY — load Inter + Outfit (swap)
  vitest.config.ts               # MODIFY — jsdom env + setup file
  test/setup.ts                  # CREATE — testing-library/jest-dom + matchMedia/RO mocks
  store/themeStore.ts            # CREATE — Zustand theme (system|light|dark), localStorage
  lib/theme.ts                   # CREATE — applyTheme(), resolveSystemTheme()
  components/theme/ThemeProvider.tsx   # CREATE — subscribes store→<html>.dark + matchMedia
  components/ui/
    cn.ts                        # EXISTS — keep
    Button.tsx IconButton.tsx Spinner.tsx Skeleton.tsx Badge.tsx Tag.tsx Separator.tsx
    Card.tsx Callout.tsx StatCard.tsx EmptyState.tsx Progress.tsx SegmentedControl.tsx
    Label.tsx Field.tsx Input.tsx Textarea.tsx Select.tsx Checkbox.tsx RadioGroup.tsx Switch.tsx
    Combobox.tsx DatePicker.tsx Slider.tsx
    Dialog.tsx Sheet.tsx Popover.tsx DropdownMenu.tsx Tooltip.tsx ConfirmDialog.tsx Toast.tsx
    Tabs.tsx Accordion.tsx ScrollArea.tsx Avatar.tsx Breadcrumbs.tsx Pagination.tsx
    DataTable.tsx Table.tsx
    ThemeToggle.tsx LanguageSwitcher.tsx access-gates.tsx   # RoleGate/FeatureGate
    index.ts                     # CREATE — barrel export
  pages/_dev/UiKitchenSinkPage.tsx  # CREATE — dev-only preview (route gated to import.meta.env.DEV)
```

---

## Task 1: Dependencies + jsdom test infrastructure

**Files:**
- Modify: `frontend/package.json` (deps + devDeps)
- Modify: `frontend/src/vitest.config.ts`
- Create: `frontend/src/test/setup.ts`

- [ ] **Step 1: Install runtime deps**

```bash
cd frontend
npm install @radix-ui/react-dialog @radix-ui/react-dropdown-menu @radix-ui/react-popover \
  @radix-ui/react-tooltip @radix-ui/react-tabs @radix-ui/react-select @radix-ui/react-checkbox \
  @radix-ui/react-switch @radix-ui/react-radio-group @radix-ui/react-accordion \
  @radix-ui/react-scroll-area @radix-ui/react-separator @radix-ui/react-label \
  @radix-ui/react-avatar @radix-ui/react-slot @radix-ui/react-slider \
  class-variance-authority @tanstack/react-table react-day-picker
```

- [ ] **Step 2: Install dev deps (jsdom test stack)**

```bash
npm install -D jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom
```

- [ ] **Step 3: Create `frontend/src/test/setup.ts`**

```ts
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());

// jsdom lacks matchMedia + ResizeObserver/PointerEvent bits Radix needs.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList;
}
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
// Radix uses these in jsdom-unsupported ways.
if (!(Element.prototype as unknown as { hasPointerCapture?: unknown }).hasPointerCapture) {
  (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () => false;
  (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  (Element.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {};
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
}
```

- [ ] **Step 4: Update `frontend/src/vitest.config.ts` to jsdom + setup**

Set `test.environment` to `'jsdom'`, add `setupFiles: ['./src/test/setup.ts']`, keep the existing `@/` alias. Resulting config:

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, '..', 'src') } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
```

(Adjust the alias `path.resolve` base to match the existing file's location — verify against the current `vitest.config.ts` before writing.)

- [ ] **Step 5: Smoke test the jsdom stack**

Create a throwaway `frontend/src/test/smoke.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

describe('jsdom smoke', () => {
  it('renders into the DOM', () => {
    render(<button>hi</button>);
    expect(screen.getByRole('button', { name: 'hi' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run tests — expect green**

```bash
npm test
```
Expected: smoke test + existing `money`/`navigation` tests pass.

- [ ] **Step 7: Delete the smoke test, commit**

```bash
rm src/test/smoke.test.tsx
git add package.json package-lock.json src/vitest.config.ts src/test/setup.ts
git commit -m "build(frontend): add Radix/cva/table deps + jsdom test infra"
```

---

## Task 2: Design tokens (CSS vars) + Tailwind config + fonts

**Files:**
- Modify: `frontend/src/index.css` (replace `:root` vars block; add `.dark` block; keep existing utility classes)
- Modify: `frontend/tailwind.config.js`
- Modify: `frontend/index.html`

- [ ] **Step 1: Replace token variables in `frontend/src/index.css`**

In the `@layer base` `:root` block, define semantic tokens as raw hex (Tailwind will consume via `rgb`-less direct values using `colors` mapping that references `var()`). Use this exact set, then add the dark override:

```css
@layer base {
  :root {
    --background: #fbfbfc;
    --surface: #ffffff;
    --surface-muted: #f4f5f7;
    --surface-raised: #ffffff;
    --border: #e7e8ec;
    --border-strong: #d5d7de;
    --foreground: #14151a;
    --muted-foreground: #5b5e68;
    --primary: #4f46e5;
    --primary-hover: #4338ca;
    --primary-foreground: #ffffff;
    --accent: #f59e0b;
    --accent-foreground: #1a1205;
    --ring: #4f46e5;
    --success: #059669; --success-subtle: #ecfdf5; --success-foreground: #ffffff;
    --warning: #d97706; --warning-subtle: #fffbeb; --warning-foreground: #ffffff;
    --danger:  #e11d48; --danger-subtle:  #fff1f2; --danger-foreground:  #ffffff;
    --info:    #0284c7; --info-subtle:    #f0f9ff; --info-foreground:    #ffffff;
    --chart-1:#4f46e5;--chart-2:#059669;--chart-3:#f59e0b;--chart-4:#e11d48;
    --chart-5:#0284c7;--chart-6:#7c3aed;--chart-7:#0d9488;--chart-8:#64748b;
    --radius: 0.625rem;
  }
  :root.dark {
    --background: #0b0c11;
    --surface: #12131a;
    --surface-muted: #171922;
    --surface-raised: #1b1d27;
    --border: #262936;
    --border-strong: #343847;
    --foreground: #ecedf1;
    --muted-foreground: #9498a6;
    --primary: #6e68f2;
    --primary-hover: #837cf6;
    --primary-foreground: #ffffff;
    --accent: #fbbf24;
    --accent-foreground: #1a1205;
    --ring: #6e68f2;
    --success:#10b981;--success-subtle:#06281f;--success-foreground:#06281f;
    --warning:#f59e0b;--warning-subtle:#2a1e05;--warning-foreground:#2a1e05;
    --danger: #fb7185;--danger-subtle: #2a0f16;--danger-foreground: #2a0f16;
    --info:   #38bdf8;--info-subtle:   #06222e;--info-foreground:   #06222e;
  }
  html { color-scheme: light; }
  html.dark { color-scheme: dark; }
  body { background-color: var(--background); color: var(--foreground); }
  * { border-color: var(--border); }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
  }
}
```

Keep the file's existing global utility classes (`.focus-ring`, `.glass`, animations, RTL rules, scrollbar) below this block. Remove any now-duplicated old `--background`/`--primary` HSL vars to avoid conflicts.

- [ ] **Step 2: Rewrite `frontend/tailwind.config.js` color/theme mapping**

Map Tailwind color names to the CSS vars (direct `var()` references, no opacity channel trickery), plus fonts, radius, shadow, motion:

```js
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        surface: { DEFAULT: 'var(--surface)', muted: 'var(--surface-muted)', raised: 'var(--surface-raised)' },
        border: { DEFAULT: 'var(--border)', strong: 'var(--border-strong)' },
        foreground: 'var(--foreground)',
        muted: { foreground: 'var(--muted-foreground)' },
        primary: { DEFAULT: 'var(--primary)', hover: 'var(--primary-hover)', foreground: 'var(--primary-foreground)' },
        accent: { DEFAULT: 'var(--accent)', foreground: 'var(--accent-foreground)' },
        ring: 'var(--ring)',
        success: { DEFAULT: 'var(--success)', subtle: 'var(--success-subtle)', foreground: 'var(--success-foreground)' },
        warning: { DEFAULT: 'var(--warning)', subtle: 'var(--warning-subtle)', foreground: 'var(--warning-foreground)' },
        danger: { DEFAULT: 'var(--danger)', subtle: 'var(--danger-subtle)', foreground: 'var(--danger-foreground)' },
        info: { DEFAULT: 'var(--info)', subtle: 'var(--info-subtle)', foreground: 'var(--info-foreground)' },
        chart: { 1:'var(--chart-1)',2:'var(--chart-2)',3:'var(--chart-3)',4:'var(--chart-4)',5:'var(--chart-5)',6:'var(--chart-6)',7:'var(--chart-7)',8:'var(--chart-8)' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Outfit', 'Inter', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        micro: ['0.75rem', { lineHeight: '1rem', letterSpacing: '0.04em' }],
        caption: ['0.8125rem', { lineHeight: '1.125rem' }],
        sm: ['0.875rem', { lineHeight: '1.25rem' }],
        base: ['0.9375rem', { lineHeight: '1.4rem' }],
        'body-lg': ['1.0625rem', { lineHeight: '1.6rem' }],
        h3: ['1.125rem', { lineHeight: '1.5rem', fontWeight: '600' }],
        h2: ['1.375rem', { lineHeight: '1.75rem', fontWeight: '650' }],
        h1: ['1.75rem', { lineHeight: '2.1rem', fontWeight: '700' }],
        display: ['2.25rem', { lineHeight: '2.5rem', letterSpacing: '-0.02em', fontWeight: '700' }],
      },
      borderRadius: { sm:'6px', DEFAULT:'8px', md:'8px', lg:'var(--radius)', xl:'14px', '2xl':'20px' },
      boxShadow: {
        xs:'0 1px 2px 0 rgb(20 21 26 / 0.04)',
        sm:'0 1px 3px 0 rgb(20 21 26 / 0.06), 0 1px 2px -1px rgb(20 21 26 / 0.06)',
        md:'0 4px 12px -2px rgb(20 21 26 / 0.08), 0 2px 6px -2px rgb(20 21 26 / 0.06)',
        lg:'0 12px 28px -6px rgb(20 21 26 / 0.12), 0 4px 10px -4px rgb(20 21 26 / 0.08)',
        xl:'0 24px 48px -12px rgb(20 21 26 / 0.18)',
      },
      transitionTimingFunction: { standard: 'cubic-bezier(.2,.8,.2,1)' },
      transitionDuration: { fast:'120ms', base:'180ms', slow:'240ms' },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
```

- [ ] **Step 3: Load fonts in `frontend/index.html`**

Replace the Inter `<link>` with Inter + Outfit, `display=swap`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@500;600;700&display=swap" rel="stylesheet" />
```

- [ ] **Step 4: Verify build compiles with new tokens**

```bash
npm run -s build
```
Expected: tsc + vite build succeed (no Tailwind class errors).

- [ ] **Step 5: Commit**

```bash
git add src/index.css tailwind.config.js index.html
git commit -m "feat(frontend): Console design tokens (light+dark), fonts, tailwind mapping"
```

---

## Task 3: Theme store + provider + ThemeToggle

**Files:**
- Create: `frontend/src/lib/theme.ts`, `frontend/src/store/themeStore.ts`, `frontend/src/components/theme/ThemeProvider.tsx`, `frontend/src/components/ui/ThemeToggle.tsx`
- Create tests: `frontend/src/store/themeStore.test.ts`, `frontend/src/components/ui/ThemeToggle.test.tsx`
- Modify: `frontend/src/main.tsx` (wrap app in `<ThemeProvider>`)

- [ ] **Step 1: Write `frontend/src/lib/theme.ts`**

```ts
export type ThemePref = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export function resolveSystemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
export function resolveTheme(pref: ThemePref): ResolvedTheme {
  return pref === 'system' ? resolveSystemTheme() : pref;
}
export function applyTheme(pref: ThemePref): void {
  document.documentElement.classList.toggle('dark', resolveTheme(pref) === 'dark');
}
```

- [ ] **Step 2: Write `frontend/src/store/themeStore.ts`**

```ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ThemePref } from '@/lib/theme';

interface ThemeState {
  pref: ThemePref;
  setPref: (pref: ThemePref) => void;
}
export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({ pref: 'system', setPref: (pref) => set({ pref }) }),
    { name: 'kds-theme', storage: undefined }, // default localStorage
  ),
);
```

- [ ] **Step 3: Write its test `frontend/src/store/themeStore.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useThemeStore } from './themeStore';

describe('themeStore', () => {
  beforeEach(() => useThemeStore.setState({ pref: 'system' }));
  it('defaults to system', () => {
    expect(useThemeStore.getState().pref).toBe('system');
  });
  it('setPref updates and persists to localStorage', () => {
    useThemeStore.getState().setPref('dark');
    expect(useThemeStore.getState().pref).toBe('dark');
    expect(localStorage.getItem('kds-theme')).toContain('dark');
  });
});
```

- [ ] **Step 4: Write `frontend/src/components/theme/ThemeProvider.tsx`**

```tsx
import { useEffect } from 'react';
import { useThemeStore } from '@/store/themeStore';
import { applyTheme } from '@/lib/theme';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const pref = useThemeStore((s) => s.pref);
  useEffect(() => {
    applyTheme(pref);
    if (pref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);
  return <>{children}</>;
}
```

- [ ] **Step 5: Write `frontend/src/components/ui/ThemeToggle.tsx`**

A 3-way segmented toggle (System/Light/Dark) using buttons with `aria-pressed`; icons from lucide (`Monitor`, `Sun`, `Moon`). `aria-label` on each.

```tsx
import { Monitor, Sun, Moon } from 'lucide-react';
import { useThemeStore } from '@/store/themeStore';
import type { ThemePref } from '@/lib/theme';
import { cn } from './cn';

const OPTIONS: { value: ThemePref; label: string; Icon: typeof Sun }[] = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
];

export function ThemeToggle() {
  const { pref, setPref } = useThemeStore();
  return (
    <div role="group" aria-label="Theme" className="inline-flex rounded-lg border border-border bg-surface-muted p-0.5">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-label={label}
          aria-pressed={pref === value}
          onClick={() => setPref(value)}
          className={cn(
            'inline-flex h-7 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            pref === value && 'bg-surface text-foreground shadow-xs',
          )}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Write `frontend/src/components/ui/ThemeToggle.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach } from 'vitest';
import { ThemeToggle } from './ThemeToggle';
import { useThemeStore } from '@/store/themeStore';

describe('ThemeToggle', () => {
  beforeEach(() => useThemeStore.setState({ pref: 'system' }));
  it('marks the active pref with aria-pressed', () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('button', { name: 'System', pressed: true })).toBeInTheDocument();
  });
  it('switches pref on click and toggles <html>.dark', async () => {
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(useThemeStore.getState().pref).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');
  });
});
```

- [ ] **Step 7: Wrap app in `<ThemeProvider>` in `frontend/src/main.tsx`**

Import `ThemeProvider` and wrap the existing top-level `<App/>`/router tree (inside the QueryClientProvider, around the router). Keep all existing providers.

- [ ] **Step 8: Run tests + build — expect green**

```bash
npm test && npm run -s build
```

- [ ] **Step 9: Commit**

```bash
git add src/lib/theme.ts src/store/themeStore.ts src/store/themeStore.test.ts \
  src/components/theme/ThemeProvider.tsx src/components/ui/ThemeToggle.tsx \
  src/components/ui/ThemeToggle.test.tsx src/main.tsx
git commit -m "feat(frontend): theme store + provider + ThemeToggle (system/light/dark)"
```

---

## Task 4: Core atoms — Button, IconButton, Spinner, Skeleton, Badge, Tag, Separator

**Files:** create each `.tsx` + `.test.tsx` under `components/ui/`. Spinner/Skeleton already exist — replace to use tokens.

**Canonical cva pattern (Button) — follow this exact shape for all variant components:**

- [ ] **Step 1: Write `frontend/src/components/ui/Button.tsx`**

```tsx
import { forwardRef } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';
import { Spinner } from './Spinner';

const button = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-colors duration-fast ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary-hover shadow-xs',
        secondary: 'bg-surface-muted text-foreground hover:bg-border',
        outline: 'border border-border-strong bg-surface text-foreground hover:bg-surface-muted',
        ghost: 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
        destructive: 'bg-danger text-danger-foreground hover:opacity-90 shadow-xs',
      },
      size: { sm: 'h-8 px-3 text-sm', md: 'h-9 px-4 text-sm', lg: 'h-10 px-5 text-base' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, loading, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp ref={ref} className={cn(button({ variant, size }), className)} disabled={disabled || loading} {...props}>
        {loading && <Spinner className="h-4 w-4" />}
        {children}
      </Comp>
    );
  },
);
Button.displayName = 'Button';
```

- [ ] **Step 2: Write `Button.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('renders text and is a button by default', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
  it('disables and shows spinner when loading', () => {
    render(<Button loading>Save</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });
  it('renders as child element with asChild', () => {
    render(<Button asChild><a href="/x">Link</a></Button>);
    expect(screen.getByRole('link', { name: 'Link' })).toHaveClass('bg-primary');
  });
});
```

- [ ] **Step 3: `Spinner.tsx` (replace)** — SVG spinner inheriting `currentColor`, `role="status"`, `aria-label="Loading"`, `<span class="sr-only">`. Test: `getByRole('status')` present.

- [ ] **Step 4: `Skeleton.tsx` (replace)** — `<div role="presentation" className={cn('animate-pulse rounded-md bg-surface-muted', className)} />`. Test: renders with the pulse class.

- [ ] **Step 5: `IconButton.tsx`** — like Button but square sizes (`h-8 w-8`/`h-9 w-9`), **requires** `aria-label` (TS: `aria-label: string` in props). Test: throws type-less at runtime is N/A; test that `getByRole('button', {name})` works and icon child has `aria-hidden`.

- [ ] **Step 6: `Badge.tsx`** — cva `tone: neutral|primary|success|warning|danger|info`, `size: sm|md`; uses `*-subtle` bg + colored text. Test: each tone renders correct text; role not required (decorative span). 

```tsx
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';
const badge = cva('inline-flex items-center gap-1 rounded-full font-medium', {
  variants: {
    tone: {
      neutral: 'bg-surface-muted text-muted-foreground',
      primary: 'bg-primary/10 text-primary',
      success: 'bg-success-subtle text-success',
      warning: 'bg-warning-subtle text-warning',
      danger: 'bg-danger-subtle text-danger',
      info: 'bg-info-subtle text-info',
    },
    size: { sm: 'px-2 py-0.5 text-micro', md: 'px-2.5 py-0.5 text-caption' },
  },
  defaultVariants: { tone: 'neutral', size: 'md' },
});
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badge> {}
export function Badge({ className, tone, size, ...props }: BadgeProps) {
  return <span className={cn(badge({ tone, size }), className)} {...props} />;
}
```

- [ ] **Step 7: `Tag.tsx`** — like Badge but with optional `onRemove` (renders an `X` IconButton with `aria-label="Remove {label}"`). Test: clicking remove fires callback.

- [ ] **Step 8: `Separator.tsx`** — wrap `@radix-ui/react-separator` (`orientation`, decorative default). Test: renders with `role="none"` when decorative, `role="separator"` when `decorative={false}`.

- [ ] **Step 9: Run tests + build, commit**

```bash
npm test && npm run -s build
git add src/components/ui/{Button,IconButton,Spinner,Skeleton,Badge,Tag,Separator}.tsx \
  src/components/ui/{Button,IconButton,Spinner,Skeleton,Badge,Tag,Separator}.test.tsx
git commit -m "feat(frontend/ui): core atoms — Button, IconButton, Spinner, Skeleton, Badge, Tag, Separator"
```

---

## Task 5: Containers — Card, Callout, StatCard, EmptyState, Progress, SegmentedControl

**Files:** each `.tsx` + `.test.tsx`.

- [ ] **Step 1: `Card.tsx`** — `Card`, `CardHeader`, `CardTitle` (`<h3 className="font-display text-h3">`), `CardDescription`, `CardContent`, `CardFooter`. Base: `rounded-xl border border-border bg-surface shadow-sm`. Test: composition renders heading + content.

```tsx
import { cn } from './cn';
export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-border bg-surface shadow-sm', className)} {...p} />;
}
export function CardHeader({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 p-5', className)} {...p} />;
}
export function CardTitle({ className, ...p }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('font-display text-h3 text-foreground', className)} {...p} />;
}
export function CardDescription({ className, ...p }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...p} />;
}
export function CardContent({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5 pt-0', className)} {...p} />;
}
export function CardFooter({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center gap-2 p-5 pt-0', className)} {...p} />;
}
```

- [ ] **Step 2: `Callout.tsx`** — `tone: info|success|warning|danger`, `role="status"` (or `role="alert"` for danger/warning), icon + title + children, `*-subtle` bg + colored left border. Test: danger callout has `role="alert"`.

- [ ] **Step 3: `StatCard.tsx`** — props `{ label, value, icon?, delta?: { value: string; direction: 'up'|'down'|'flat' }, tone? }`. Renders KPI tile: label (micro uppercase muted), value (font-display text-h1 tabular-nums), optional delta with arrow + success/danger color. Test: shows label + value; up-delta has success class.

- [ ] **Step 4: `EmptyState.tsx`** — props `{ icon?, title, description?, action? }`. Centered dashed-border panel. Test: renders title + action.

- [ ] **Step 5: `Progress.tsx`** — wraps a div bar; props `{ value: 0-100, tone? }`, `role="progressbar"` with `aria-valuenow/min/max`. Test: `getByRole('progressbar')` has `aria-valuenow`.

- [ ] **Step 6: `SegmentedControl.tsx`** — generic `{ options: {value,label}[], value, onChange, 'aria-label' }`, `role="group"`, buttons with `aria-pressed`. (ThemeToggle is a specialized instance; this is the reusable one.) Test: click changes selection.

- [ ] **Step 7: Run tests + build, commit**

```bash
npm test && npm run -s build
git add src/components/ui/{Card,Callout,StatCard,EmptyState,Progress,SegmentedControl}.tsx \
  src/components/ui/{Card,Callout,StatCard,EmptyState,Progress,SegmentedControl}.test.tsx
git commit -m "feat(frontend/ui): containers — Card, Callout, StatCard, EmptyState, Progress, SegmentedControl"
```

---

## Task 6: Form primitives — Label, Field, Input, Textarea, Select, Checkbox, RadioGroup, Switch

**Files:** each `.tsx` + `.test.tsx`. These must integrate cleanly with `react-hook-form` (accept `ref` + standard input props; `Field` provides id/aria wiring).

- [ ] **Step 1: `Label.tsx`** — wrap `@radix-ui/react-label`, `text-sm font-medium text-foreground`. Test: clicking label focuses associated input via `htmlFor`.

- [ ] **Step 2: `Field.tsx` (canonical form wrapper)** — composes label + control + hint + error and wires ARIA. This is the contract every form control plugs into.

```tsx
import { useId } from 'react';
import { Label } from './Label';
import { cn } from './cn';

export interface FieldProps {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  /** render-prop receives the ids to attach to the control */
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => React.ReactNode;
}
export function Field({ label, hint, error, required, className, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <Label htmlFor={id}>
          {label}
          {required && <span className="ms-0.5 text-danger" aria-hidden="true">*</span>}
        </Label>
      )}
      {children({ id, describedBy, invalid: !!error })}
      {hint && !error && <p id={hintId} className="text-caption text-muted-foreground">{hint}</p>}
      {error && <p id={errorId} className="text-caption text-danger" role="alert">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: `Input.tsx`** — `forwardRef`, base `h-9 rounded-lg border border-border-strong bg-surface px-3 text-sm`, focus ring, `aria-invalid` styling (`aria-invalid:border-danger`). Accepts all input props. Test: typing updates value; `aria-invalid` adds danger border class.

```tsx
import { forwardRef } from 'react';
import { cn } from './cn';
export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-9 w-full rounded-lg border border-border-strong bg-surface px-3 text-sm text-foreground placeholder:text-muted-foreground',
        'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-primary',
        'disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/30',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
```

- [ ] **Step 4: `Textarea.tsx`** — same styling, `min-h-[80px]`, `forwardRef`. Test: typing works.

- [ ] **Step 5: `Select.tsx`** — wrap `@radix-ui/react-select` (Trigger/Content/Item/Value) styled to match Input; chevron icon; `forwardRef` on trigger. Test: open, pick an option, value updates (use userEvent + `getByRole('option')`).

- [ ] **Step 6: `Checkbox.tsx`** — wrap `@radix-ui/react-checkbox` + `Check` icon; controlled/uncontrolled. Test: `getByRole('checkbox')` toggles `aria-checked` on click.

- [ ] **Step 7: `RadioGroup.tsx`** — wrap `@radix-ui/react-radio-group` (`RadioGroup`, `RadioGroupItem`). Test: selecting an item sets `aria-checked`.

- [ ] **Step 8: `Switch.tsx`** — wrap `@radix-ui/react-switch`, `role="switch"`. Test: toggles `aria-checked`.

- [ ] **Step 9: RHF integration test** — `frontend/src/components/ui/Field.rhf.test.tsx`: a tiny component using `useForm` + `Input` inside `Field`, submit empty → shows error via `role="alert"`; type valid → submits values. Confirms the `Field`+`Input` contract works with react-hook-form register.

- [ ] **Step 10: Run tests + build, commit**

```bash
npm test && npm run -s build
git add src/components/ui/{Label,Field,Input,Textarea,Select,Checkbox,RadioGroup,Switch}.tsx \
  src/components/ui/*.test.tsx
git commit -m "feat(frontend/ui): form primitives — Field, Input, Textarea, Select, Checkbox, RadioGroup, Switch (RHF-ready)"
```

---

## Task 7: Combobox, DatePicker, Slider

**Files:** each `.tsx` + `.test.tsx`.

- [ ] **Step 1: `Combobox.tsx`** — searchable single-select built on `@radix-ui/react-popover` + a filtered list (`role="listbox"`/`option`, arrow-key nav, `aria-activedescendant`). Props `{ options:{value,label}[], value, onChange, placeholder, 'aria-label' }`. Test: type to filter, click option, value updates.
- [ ] **Step 2: `DatePicker.tsx`** — `@radix-ui/react-popover` trigger (Input-styled, shows formatted date via `date-fns`) + `react-day-picker` calendar in content. Props `{ value: Date|null, onChange, ... }`. Style DayPicker with token classes. Test: open, pick a day, `onChange` called with a Date.
- [ ] **Step 3: `Slider.tsx`** — wrap `@radix-ui/react-slider`. Test: renders `role="slider"` with `aria-valuenow`.
- [ ] **Step 4: tests + build + commit** (`feat(frontend/ui): Combobox, DatePicker, Slider`).

---

## Task 8: Overlays — Dialog, Sheet, Popover, DropdownMenu, Tooltip, ConfirmDialog, Toast

**Files:** each `.tsx` + `.test.tsx`.

**Canonical overlay pattern (Dialog) — follow for Sheet:**

- [ ] **Step 1: `Dialog.tsx`** — re-export `@radix-ui/react-dialog` parts styled: overlay (`fixed inset-0 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in fade-in`), content (`fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface-raised shadow-xl p-6 w-full max-w-lg`), `DialogTitle` (font-display), `DialogDescription`, close `IconButton` with `aria-label="Close"`. Radix gives `role="dialog"`, `aria-modal`, focus-trap, Esc. Test: trigger opens dialog (`getByRole('dialog')`), Esc closes it, focus moves into dialog.

- [ ] **Step 2: `Sheet.tsx`** — same Radix dialog primitive, content slides from `side: left|right|top|bottom` (cva), full-height side panels for mobile nav/drawers. Test: opens with `role="dialog"`.

- [ ] **Step 3: `Popover.tsx`** — wrap `@radix-ui/react-popover` styled content (`rounded-lg border bg-surface-raised shadow-lg p-2`). Test: trigger opens, click-outside closes.

- [ ] **Step 4: `DropdownMenu.tsx`** — wrap `@radix-ui/react-dropdown-menu` (Trigger/Content/Item/Separator/Label/CheckboxItem). Styled items (`focus:bg-surface-muted`). Test: open, arrow-down highlights, Enter fires item `onSelect`.

- [ ] **Step 5: `Tooltip.tsx`** — wrap `@radix-ui/react-tooltip` (+ `TooltipProvider` exported). Test: hover/focus shows `role="tooltip"`.

- [ ] **Step 6: `ConfirmDialog.tsx`** — composes `Dialog` into a controlled confirm (`{ open, onOpenChange, title, description, confirmLabel, tone?, onConfirm, loading? }`). Danger tone → destructive confirm button. Test: clicking confirm fires `onConfirm`.

- [ ] **Step 7: `Toast.tsx`** — thin module that re-exports a themed `toast` from `sonner` + a `<Toaster>` preset (position top-right, token colors, `richColors` off, custom class). Test: `toast` is a function (smoke import).

- [ ] **Step 8: tests + build + commit** (`feat(frontend/ui): overlays — Dialog, Sheet, Popover, DropdownMenu, Tooltip, ConfirmDialog, Toast`).

---

## Task 9: Tabs, Accordion, ScrollArea, Avatar, Breadcrumbs, Pagination

**Files:** each `.tsx` + `.test.tsx`.

- [ ] **Step 1: `Tabs.tsx`** — wrap `@radix-ui/react-tabs`, underline-style triggers (active: `text-foreground` + bottom border `border-primary`). Test: clicking a tab shows its panel (`role="tabpanel"`).
- [ ] **Step 2: `Accordion.tsx`** — wrap `@radix-ui/react-accordion` (single/multiple), chevron rotates on open. Test: click expands content.
- [ ] **Step 3: `ScrollArea.tsx`** — wrap `@radix-ui/react-scroll-area`. Test: renders children.
- [ ] **Step 4: `Avatar.tsx`** — wrap `@radix-ui/react-avatar` (image + fallback initials); `AvatarGroup` stacks with `-ms-2` overlap and `+N` overflow. Test: fallback initials show when no src.
- [ ] **Step 5: `Breadcrumbs.tsx`** — `<nav aria-label="Breadcrumb">` + ordered list, last item `aria-current="page"`. Props `{ items: {label, href?}[] }`. (Supersedes the existing marketing Breadcrumbs in Phase 2.) Test: last crumb has `aria-current`.
- [ ] **Step 6: `Pagination.tsx`** — `{ page, pageCount, onPage }`, prev/next IconButtons (`aria-label`) + page buttons with `aria-current`. Test: next button calls `onPage(page+1)`, disabled on last page.
- [ ] **Step 7: tests + build + commit** (`feat(frontend/ui): Tabs, Accordion, ScrollArea, Avatar, Breadcrumbs, Pagination`).

---

## Task 10: DataTable + Table primitives

**Files:** `Table.tsx`, `DataTable.tsx` + tests.

- [ ] **Step 1: `Table.tsx`** — styled primitives `Table/THead/TBody/TR/TH/TD` (`text-sm`, header `bg-surface-muted text-micro uppercase text-muted-foreground`, row `border-b border-border hover:bg-surface-muted/50`, tabular-nums on numeric cells via a `numeric` prop). Test: renders a basic table with `role` cells.

- [ ] **Step 2: `DataTable.tsx`** — generic, built on `@tanstack/react-table`. Props:

```ts
interface DataTableProps<T> {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  isLoading?: boolean;
  emptyState?: React.ReactNode;
  onRowClick?: (row: T) => void;
  sorting?: SortingState;
  onSortingChange?: (s: SortingState) => void;
}
```
Renders header (sortable: click toggles, shows chevron, `aria-sort`), body, skeleton rows when `isLoading`, `emptyState` when `data.length === 0`. Memoize the table model. Test: renders rows from data; clicking a sortable header toggles `aria-sort`; shows empty state when no data; shows skeletons when loading.

- [ ] **Step 3: tests + build + commit** (`feat(frontend/ui): Table + DataTable (TanStack)`).

---

## Task 11: App primitives — PageHeader, FilterBar, LanguageSwitcher, access gates

**Files:** `PageHeader.tsx`, `FilterBar.tsx`, `LanguageSwitcher.tsx`, `access-gates.tsx` + tests.

- [ ] **Step 1: `PageHeader.tsx`** — `{ title, description?, breadcrumbs?, actions? }`. Renders breadcrumbs (uses `Breadcrumbs`), `h1` title (font-display text-h1), description, right-aligned actions slot. Responsive (stacks on mobile). Test: renders title + actions.
- [ ] **Step 2: `FilterBar.tsx`** — layout primitive: a `flex flex-wrap gap-2 items-center` row with a `search` slot (Input + Search icon) + `children` for filter controls + optional `right` slot. Test: renders search + children.
- [ ] **Step 3: `LanguageSwitcher.tsx`** — DropdownMenu listing the 5 locales (en/ar/ru/tr/uz) from existing i18n config; calls `i18n.changeLanguage`; current has check. Test: renders all 5 options (mock i18n).
- [ ] **Step 4: `access-gates.tsx`** — `RoleGate` (`{ role: MarketingRole, children, fallback? }` using existing `hasMarketingRole`) and `FeatureGate` (`{ feature: FeatureKey, children, fallback? }` using existing `useEntitlements`). Declarative UI gating. Tests: RoleGate hides children for insufficient role; FeatureGate hides when entitlement false (mock the hook).
- [ ] **Step 5: tests + build + commit** (`feat(frontend/ui): app primitives — PageHeader, FilterBar, LanguageSwitcher, access gates`).

---

## Task 12: Barrel export + dev kitchen-sink preview + final gate

**Files:** `components/ui/index.ts`, `pages/_dev/UiKitchenSinkPage.tsx`, modify `App.tsx` (dev-only route).

- [ ] **Step 1: `components/ui/index.ts`** — re-export every primitive (named). One import site for consumers: `import { Button, Card, Dialog } from '@/components/ui'`.
- [ ] **Step 2: `UiKitchenSinkPage.tsx`** — a single page rendering every component in light context (buttons in all variants/sizes, badges, a form with Field+Input+Select+Checkbox+Switch, a Dialog, a DropdownMenu, a DataTable with sample rows, StatCards, Callouts, Tabs, ThemeToggle). Purpose: visual QA + a render smoke test.
- [ ] **Step 3: Dev-only route** — in `App.tsx`, add `{import.meta.env.DEV && <Route path="/_dev/ui" element={<UiKitchenSinkPage />} />}` (lazy import). Never shipped in prod builds (guard keeps it out of the tree; also fine if tree-shaken).
- [ ] **Step 4: Kitchen-sink render test** — `UiKitchenSinkPage.test.tsx`: render the page inside required providers (ThemeProvider, a QueryClientProvider if needed) and assert it mounts without throwing and a known heading is present. This is the integration smoke for the whole library.
- [ ] **Step 5: Full gate**

```bash
npm run lint && npm test && npm run -s build
```
Expected: lint clean (≤500 warnings ceiling), all tests pass, production build succeeds.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(frontend/ui): barrel export + dev kitchen-sink + Phase 1 gate green"
```

---

## Phase 1 Done — Definition of Done
- Tokens (light+dark) live; `.dark` toggles via ThemeToggle; fonts loaded.
- ~30 accessible, tested primitives in `components/ui/`, exported from one barrel.
- No existing page modified except `main.tsx` (ThemeProvider) and `App.tsx` (dev route).
- `lint` + `test` + `build` green. App runs unchanged visually (pages not yet migrated).
- **Next:** Phase 2 plan (App Shell & Navigation) consumes these primitives.
