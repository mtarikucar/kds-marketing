import type { ReactNode } from 'react';
export function FormField({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-2"><label htmlFor={htmlFor} className="text-sm font-medium">{label}</label>{children}{hint && <p className="text-xs leading-5 text-muted-foreground">{hint}</p>}</div>;
}
