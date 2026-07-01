import { useTranslation } from 'react-i18next';
import {
  Heading, Type, Image as ImageIcon, MousePointerClick, Minus, MoveVertical, Columns2,
  Plus, Trash2, ArrowUp, ArrowDown,
} from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/Select';

export type EmailBlock = Record<string, any> & { type: string };
const asArr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const clone = <T,>(v: T): T => structuredClone(v);

/**
 * Prepend `https://` to a scheme-less URL so a button/image doesn't render as a
 * dead `#` link — the email renderer's safeUrl keeps only http(s) and drops
 * anything else to `#` silently. A value that already parses as a URL (any
 * scheme) is left unchanged; a `javascript:`/`data:` scheme still parses, so it
 * isn't "fixed" here and is blocked downstream by safeUrl. Run on blur.
 */
function normalizeUrl(v: string): string {
  const s = v.trim();
  if (!s) return s;
  try { new URL(s); return s; } catch { /* no scheme — try https below */ }
  try { new URL(`https://${s}`); return `https://${s}`; } catch { return s; }
}

const PALETTE: { type: string; label: string; icon: typeof Type }[] = [
  { type: 'heading', label: 'Heading', icon: Heading },
  { type: 'text', label: 'Text', icon: Type },
  { type: 'image', label: 'Image', icon: ImageIcon },
  { type: 'button', label: 'Button', icon: MousePointerClick },
  { type: 'divider', label: 'Divider', icon: Minus },
  { type: 'spacer', label: 'Spacer', icon: MoveVertical },
  { type: 'columns', label: 'Columns', icon: Columns2 },
];

const NEW_BLOCK: Record<string, EmailBlock> = {
  heading: { type: 'heading', text: 'Heading' },
  text: { type: 'text', text: 'Some text.' },
  image: { type: 'image', url: '', alt: '' },
  button: { type: 'button', text: 'Click here', url: 'https://', align: 'center' },
  divider: { type: 'divider' },
  spacer: { type: 'spacer', height: 24 },
  columns: { type: 'columns', columns: [{ text: 'Left' }, { text: 'Right' }] },
};

export function EmailBlockBuilder({ blocks, onChange }: { blocks: EmailBlock[]; onChange: (next: EmailBlock[]) => void }) {
  const { t } = useTranslation('marketing');
  const add = (type: string) => onChange([...blocks, clone(NEW_BLOCK[type])]);
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
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {PALETTE.map((p) => (
          <button key={p.type} type="button" onClick={() => add(p.type)}
            className="text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:bg-surface-muted flex items-center gap-1">
            <Plus className="h-3 w-3" /><p.icon className="h-3.5 w-3.5" />{t(`email.block.${p.type}`, p.label)}
          </button>
        ))}
      </div>
      <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
        {blocks.map((b, i) => (
          <div key={i} className="rounded-lg border border-border p-2.5">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-semibold capitalize">{i + 1}. {t(`email.block.${b.type}`, b.type)}</span>
              <div className="flex items-center gap-0.5">
                <IconButton variant="ghost" size="sm" aria-label="Up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></IconButton>
                <IconButton variant="ghost" size="sm" aria-label="Down" disabled={i === blocks.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></IconButton>
                <IconButton variant="ghost" size="sm" aria-label="Delete" className="text-danger hover:bg-danger-subtle" onClick={() => del(i)}><Trash2 className="h-4 w-4" /></IconButton>
              </div>
            </div>
            <Editor block={b} onPatch={(p) => patch(i, p)} />
          </div>
        ))}
        {blocks.length === 0 && <p className="text-caption text-muted-foreground text-center py-4">{t('email.empty', 'Add a block from the palette.')}</p>}
      </div>
    </div>
  );
}

function Editor({ block, onPatch }: { block: EmailBlock; onPatch: (p: Record<string, any>) => void }) {
  const { t } = useTranslation('marketing');
  switch (block.type) {
    case 'heading':
      return <Input value={block.text ?? ''} onChange={(e) => onPatch({ text: e.target.value })} placeholder={t('email.headingText', 'Heading text')} />;
    case 'text':
      return <Textarea className="min-h-16" value={block.text ?? ''} onChange={(e) => onPatch({ text: e.target.value })} placeholder={t('email.bodyText', 'Body text')} />;
    case 'image':
      return (
        <div className="grid grid-cols-2 gap-2">
          <Input value={block.url ?? ''} onChange={(e) => onPatch({ url: e.target.value })} onBlur={(e) => onPatch({ url: normalizeUrl(e.target.value) })} placeholder="https://…/image.png" />
          <Input value={block.alt ?? ''} onChange={(e) => onPatch({ alt: e.target.value })} placeholder={t('email.alt', 'Alt text')} />
        </div>
      );
    case 'button':
      return (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Input value={block.text ?? ''} onChange={(e) => onPatch({ text: e.target.value })} placeholder={t('email.btnText', 'Button text')} />
            <Input value={block.url ?? ''} onChange={(e) => onPatch({ url: e.target.value })} onBlur={(e) => onPatch({ url: normalizeUrl(e.target.value) })} placeholder="https://…" />
          </div>
          <Select value={block.align ?? 'center'} onValueChange={(v) => onPatch({ align: v })}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="left">left</SelectItem>
              <SelectItem value="center">center</SelectItem>
              <SelectItem value="right">right</SelectItem>
            </SelectContent>
          </Select>
        </div>
      );
    case 'spacer':
      return (
        <Input type="number" className="w-32" value={block.height ?? 24}
          onChange={(e) => onPatch({ height: Math.min(200, Math.max(0, Math.round(Number(e.target.value) || 0))) })} />
      );
    case 'divider':
      return <p className="text-caption text-muted-foreground">{t('email.dividerHint', 'A horizontal rule.')}</p>;
    case 'columns': {
      const cols = asArr(block.columns).slice(0, 2);
      return (
        <div className="grid grid-cols-2 gap-2">
          {[0, 1].map((ci) => (
            <Textarea key={ci} className="min-h-16" placeholder={t('email.column', 'Column {{n}}', { n: ci + 1 })}
              value={cols[ci]?.text ?? ''}
              onChange={(e) => {
                const next = [...cols];
                while (next.length < 2) next.push({ text: '' });
                next[ci] = { ...next[ci], text: e.target.value };
                onPatch({ columns: next });
              }} />
          ))}
        </div>
      );
    }
    default:
      return <p className="text-caption text-muted-foreground">{t('email.unknown', 'Unknown block — edit in JSON.')}</p>;
  }
}
