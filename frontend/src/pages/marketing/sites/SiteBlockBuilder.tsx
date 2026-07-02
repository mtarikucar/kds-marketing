import { useTranslation } from 'react-i18next';
import {
  LayoutTemplate, List, DollarSign, HelpCircle, MousePointerClick, Type, FileText,
  Plus, Trash2, ArrowUp, ArrowDown,
} from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/Select';
import { TokenListInput } from './TokenListInput';

const asArr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/**
 * Normalize a scheme-less button URL to https:// so it doesn't render as a dead
 * `#` link (the site renderer's safeUrl serves only http(s) and relative paths).
 * LEAVE a relative ("/pricing") or anchor ("#…") URL — those are valid internal
 * links the renderer keeps. A value that already has a scheme is left unchanged
 * (javascript:/data: still parse, so they're untouched here and blocked
 * downstream by safeUrl). Run on blur. NOTE: `new URL('https://'+'/x')` parses as
 * host="x", so the relative guard MUST come first.
 */
function normalizeUrl(v: string): string {
  const s = v.trim();
  if (!s || s.startsWith('/') || s.startsWith('#')) return s;
  try { new URL(s); return s; } catch { /* no scheme — try https below */ }
  try { new URL(`https://${s}`); return `https://${s}`; } catch { return s; }
}

export type AnyBlock = Record<string, any> & { type: string };
export interface FormOption { id: string; name: string }

const PALETTE: { type: string; label: string; icon: typeof Type }[] = [
  { type: 'hero', label: 'Hero', icon: LayoutTemplate },
  { type: 'features', label: 'Features', icon: List },
  { type: 'pricing', label: 'Pricing', icon: DollarSign },
  { type: 'faq', label: 'FAQ', icon: HelpCircle },
  { type: 'cta', label: 'Call to action', icon: MousePointerClick },
  { type: 'text', label: 'Text', icon: Type },
  { type: 'form', label: 'Form', icon: FileText },
  { type: 'popup', label: 'Popup', icon: MousePointerClick },
];

const NEW_BLOCK: Record<string, AnyBlock> = {
  hero: { type: 'hero', heading: 'Headline', sub: 'A short supporting subheading.', ctaText: 'Get started', ctaUrl: '/' },
  features: { type: 'features', items: [{ title: 'Feature', text: 'Describe the benefit.' }] },
  pricing: { type: 'pricing', plans: [{ name: 'Pro', price: '$99/mo', features: ['Everything included'], ctaText: 'Choose', ctaUrl: '/' }] },
  faq: { type: 'faq', heading: 'FAQ', items: [{ q: 'A question?', a: 'The answer.' }] },
  cta: { type: 'cta', heading: 'Ready to start?', buttonText: 'Get started', buttonUrl: '/' },
  text: { type: 'text', text: 'Some paragraph text.' },
  form: { type: 'form', formId: '', heading: '', submitText: 'Submit' },
  popup: { type: 'popup', heading: 'Wait — before you go!', text: 'Get 10% off your first order.', ctaText: 'Claim offer', ctaUrl: '/' },
};

function clone<T>(v: T): T {
  return structuredClone(v);
}

export function SiteBlockBuilder({
  blocks, forms, onChange,
}: { blocks: AnyBlock[]; forms: FormOption[]; onChange: (next: AnyBlock[]) => void }) {
  const { t } = useTranslation('marketing');

  const addBlock = (type: string) => onChange([...blocks, clone(NEW_BLOCK[type])]);
  const patch = (i: number, p: Record<string, any>) => onChange(blocks.map((b, idx) => (idx === i ? { ...b, ...p } : b)));
  const del = (i: number) => onChange(blocks.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="space-y-3">
      {/* Palette */}
      <div className="flex flex-wrap gap-1.5">
        {PALETTE.map((p) => (
          <button
            key={p.type}
            type="button"
            onClick={() => addBlock(p.type)}
            className="text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:bg-surface-muted flex items-center gap-1"
          >
            <Plus className="h-3 w-3" /><p.icon className="h-3.5 w-3.5" />{t(`sites.block.${p.type}`, p.label)}
          </button>
        ))}
      </div>

      {/* Block list */}
      <div className="space-y-2 max-h-[55vh] overflow-y-auto pr-1">
        {blocks.map((b, i) => (
          <div key={i} className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold capitalize">
                {i + 1}. {t(`sites.block.${b.type}`, b.type)}
              </span>
              <div className="flex items-center gap-0.5">
                <IconButton variant="ghost" size="sm" aria-label="Up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></IconButton>
                <IconButton variant="ghost" size="sm" aria-label="Down" disabled={i === blocks.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></IconButton>
                <IconButton variant="ghost" size="sm" aria-label="Delete" className="text-danger hover:bg-danger-subtle" onClick={() => del(i)}><Trash2 className="h-4 w-4" /></IconButton>
              </div>
            </div>
            <BlockEditor block={b} forms={forms} onPatch={(p) => patch(i, p)} />
          </div>
        ))}
        {blocks.length === 0 && (
          <p className="text-caption text-muted-foreground text-center py-6">
            {t('sites.builderEmpty', 'Add a section from the palette above.')}
          </p>
        )}
      </div>
    </div>
  );
}

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div className="text-caption text-muted-foreground mb-0.5">{label}</div>{children}</div>;
}

function BlockEditor({ block, forms, onPatch }: { block: AnyBlock; forms: FormOption[]; onPatch: (p: Record<string, any>) => void }) {
  const { t } = useTranslation('marketing');
  switch (block.type) {
    case 'hero':
      return (
        <div className="space-y-2">
          <L label={t('sites.heading', 'Heading')}><Input value={block.heading ?? ''} onChange={(e) => onPatch({ heading: e.target.value })} /></L>
          <L label={t('sites.sub', 'Subheading')}><Input value={block.sub ?? ''} onChange={(e) => onPatch({ sub: e.target.value })} /></L>
          <div className="grid grid-cols-2 gap-2">
            <L label={t('sites.ctaText', 'Button text')}><Input value={block.ctaText ?? ''} onChange={(e) => onPatch({ ctaText: e.target.value })} /></L>
            <L label={t('sites.ctaUrl', 'Button URL')}><Input value={block.ctaUrl ?? ''} onChange={(e) => onPatch({ ctaUrl: e.target.value })} onBlur={(e) => onPatch({ ctaUrl: normalizeUrl(e.target.value) })} /></L>
          </div>
        </div>
      );
    case 'cta':
      return (
        <div className="space-y-2">
          <L label={t('sites.heading', 'Heading')}><Input value={block.heading ?? ''} onChange={(e) => onPatch({ heading: e.target.value })} /></L>
          <div className="grid grid-cols-2 gap-2">
            <L label={t('sites.ctaText', 'Button text')}><Input value={block.buttonText ?? ''} onChange={(e) => onPatch({ buttonText: e.target.value })} /></L>
            <L label={t('sites.ctaUrl', 'Button URL')}><Input value={block.buttonUrl ?? ''} onChange={(e) => onPatch({ buttonUrl: e.target.value })} onBlur={(e) => onPatch({ buttonUrl: normalizeUrl(e.target.value) })} /></L>
          </div>
        </div>
      );
    case 'text':
      return <L label={t('sites.text', 'Text')}><Textarea className="min-h-20" value={block.text ?? ''} onChange={(e) => onPatch({ text: e.target.value })} /></L>;
    case 'popup':
      return (
        <div className="space-y-2">
          <p className="text-[11px] text-muted-foreground">{t('sites.popupHint', 'Shows on page load; visitors close it with the × (no JavaScript).')}</p>
          <L label={t('sites.heading', 'Heading')}><Input value={block.heading ?? ''} onChange={(e) => onPatch({ heading: e.target.value })} /></L>
          <L label={t('sites.text', 'Text')}><Textarea className="min-h-16" value={block.text ?? ''} onChange={(e) => onPatch({ text: e.target.value })} /></L>
          <div className="grid grid-cols-2 gap-2">
            <L label={t('sites.ctaText', 'Button text')}><Input value={block.ctaText ?? ''} onChange={(e) => onPatch({ ctaText: e.target.value })} /></L>
            <L label={t('sites.ctaUrl', 'Button URL')}><Input value={block.ctaUrl ?? ''} onChange={(e) => onPatch({ ctaUrl: e.target.value })} onBlur={(e) => onPatch({ ctaUrl: normalizeUrl(e.target.value) })} /></L>
          </div>
        </div>
      );
    case 'features':
      return (
        <Repeater
          items={asArr(block.items)}
          onChange={(items) => onPatch({ items })}
          blank={{ title: 'Feature', text: 'Description' }}
          addLabel={t('sites.addFeature', 'Add feature')}
          render={(it, set) => (
            <div className="grid grid-cols-2 gap-2 flex-1">
              <Input placeholder={t('sites.title', 'Title')} value={it.title ?? ''} onChange={(e) => set({ ...it, title: e.target.value })} />
              <Input placeholder={t('sites.text', 'Text')} value={it.text ?? ''} onChange={(e) => set({ ...it, text: e.target.value })} />
            </div>
          )}
        />
      );
    case 'faq':
      return (
        <div className="space-y-2">
          <L label={t('sites.heading', 'Heading')}><Input value={block.heading ?? ''} onChange={(e) => onPatch({ heading: e.target.value })} /></L>
          <Repeater
            items={asArr(block.items)}
            onChange={(items) => onPatch({ items })}
            blank={{ q: 'Question?', a: 'Answer.' }}
            addLabel={t('sites.addFaq', 'Add Q&A')}
            render={(it, set) => (
              <div className="grid grid-cols-2 gap-2 flex-1">
                <Input placeholder="Q" value={it.q ?? ''} onChange={(e) => set({ ...it, q: e.target.value })} />
                <Input placeholder="A" value={it.a ?? ''} onChange={(e) => set({ ...it, a: e.target.value })} />
              </div>
            )}
          />
        </div>
      );
    case 'pricing':
      return (
        <Repeater
          items={asArr(block.plans)}
          onChange={(plans) => onPatch({ plans })}
          blank={{ name: 'Plan', price: '$0/mo', features: [] as string[], ctaText: 'Choose', ctaUrl: '/' }}
          addLabel={t('sites.addPlan', 'Add plan')}
          render={(p, set) => (
            <div className="space-y-1.5 flex-1">
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder={t('sites.planName', 'Name')} value={p.name ?? ''} onChange={(e) => set({ ...p, name: e.target.value })} />
                <Input placeholder={t('sites.price', 'Price')} value={p.price ?? ''} onChange={(e) => set({ ...p, price: e.target.value })} />
              </div>
              <TokenListInput
                multiline
                separator={'\n'}
                className="min-h-14 text-xs"
                placeholder={t('sites.featuresHint', 'One feature per line')}
                value={asArr(p.features)}
                onChange={(features) => set({ ...p, features })}
              />
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder={t('sites.ctaText', 'Button text')} value={p.ctaText ?? ''} onChange={(e) => set({ ...p, ctaText: e.target.value })} />
                <Input placeholder={t('sites.ctaUrl', 'Button URL')} value={p.ctaUrl ?? ''} onChange={(e) => set({ ...p, ctaUrl: e.target.value })} onBlur={(e) => set({ ...p, ctaUrl: normalizeUrl(e.target.value) })} />
              </div>
            </div>
          )}
        />
      );
    case 'form':
      return (
        <div className="space-y-2">
          <L label={t('sites.form', 'Form')}>
            <Select value={block.formId || ''} onValueChange={(v) => onPatch({ formId: v })}>
              <SelectTrigger><SelectValue placeholder={t('sites.selectForm', 'Select a form')} /></SelectTrigger>
              <SelectContent>
                {forms.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </L>
          <div className="grid grid-cols-2 gap-2">
            <L label={t('sites.heading', 'Heading')}><Input value={block.heading ?? ''} onChange={(e) => onPatch({ heading: e.target.value })} /></L>
            <L label={t('sites.submitText', 'Submit text')}><Input value={block.submitText ?? ''} onChange={(e) => onPatch({ submitText: e.target.value })} /></L>
          </div>
          {forms.length === 0 && <p className="text-[11px] text-amber-600">{t('sites.formBlockNeedsForm', 'Create a form first to use this block.')}</p>}
        </div>
      );
    default:
      return <p className="text-caption text-muted-foreground">{t('sites.unknownBlock', 'Unknown block — edit in JSON view.')}</p>;
  }
}

/** Generic add/remove repeater for an array-of-objects block field. */
function Repeater<T>({
  items, onChange, blank, addLabel, render,
}: {
  items: T[];
  onChange: (next: T[]) => void;
  blank: T;
  addLabel: string;
  render: (item: T, set: (next: T) => void) => React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      {items.map((it, i) => (
        <div key={i} className="flex items-start gap-1.5">
          {render(it, (next) => onChange(items.map((x, idx) => (idx === i ? next : x))))}
          <IconButton variant="ghost" size="sm" aria-label="Remove" className="text-danger hover:bg-danger-subtle shrink-0" onClick={() => onChange(items.filter((_, idx) => idx !== i))}>
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...items, clone(blank)])}>
        <Plus className="h-3.5 w-3.5" />{addLabel}
      </Button>
    </div>
  );
}
