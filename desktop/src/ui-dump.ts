/**
 * Turning a screen into something a model can act on.
 *
 * `uiautomator dump` produces a few hundred kilobytes of nested XML describing
 * every node on screen, most of them layout containers with no text and no
 * purpose. Handing that to a language model is the same mistake as handing it
 * a screenshot as base64: it technically contains the answer and it drowns the
 * question. Worse, it invites the model to compute pixel coordinates out of
 * `bounds` strings, which it will sometimes get wrong in ways nobody can debug
 * after the fact.
 *
 * So this reduces the tree to the things a person could actually touch or
 * read, each with the one number that matters — the centre to tap. Everything
 * else is dropped. The result is a few kilobytes and reads like a list of
 * buttons, which is what the screen is.
 */

export interface UiElement {
  /** Stable within one dump, so a caller can say "the third one". */
  i: number;
  text?: string;
  /** `resource-id` minus the package prefix — `com.whatsapp:id/entry` → `entry`. */
  id?: string;
  /** `content-desc`: what a screen reader would say. Often the ONLY label on an
   *  icon button, which is exactly the button a model wants to press. */
  desc?: string;
  /** Short class name — `Button`, `EditText`. Tells a model what it is looking
   *  at when the label alone is ambiguous. */
  cls: string;
  clickable: boolean;
  /** Text can be typed into this one. */
  editable: boolean;
  /** The point to tap. */
  tap: [number, number];
}

export interface UiScreen {
  elements: UiElement[];
  /** Present only when nodes were dropped, so silence never means "that was
   *  everything". */
  truncated?: number;
  size?: { w: number; h: number };
}

const MAX_ELEMENTS = 80;
const MAX_TEXT = 120;

/** `[0,84][1080,231]` → centre. Returns null for the malformed and the
 *  zero-area, both of which are untappable. */
function centre(bounds: string): [number, number] | null {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(bounds);
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1, 5).map(Number);
  if (x2 <= x1 || y2 <= y1) return null;
  return [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function decode(v: string): string {
  return (
    v
      .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m)
      // uiautomator writes newlines and anything else non-ASCII as NUMERIC
      // references (`&#10;`, `&#231;`), not named ones. Leaving those raw was
      // measured on a real screen: a Chrome consent paragraph came back with a
      // literal "&#10;" in the middle of it. A model reading that sees markup
      // where the phone shows a line break, and a TAP_ON matching on the label
      // would be matching against a string the screen never displayed.
      .replace(/&#(\d{1,7});/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]{1,6});/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      // Whatever survives is text somebody typed; collapse the newlines a
      // label cannot show anyway so one element stays one line.
      .replace(/\s+/g, ' ')
      .slice(0, MAX_TEXT)
  );
}

function attr(node: string, name: string): string {
  const m = new RegExp(`${name}="([^"]*)"`).exec(node);
  return m ? m[1] : '';
}

/**
 * Parse with a regex rather than an XML library, deliberately.
 *
 * uiautomator emits flat, self-closing `<node …/>` elements with
 * double-quoted attributes and entity-escaped values — a shape a regex reads
 * correctly and a dependency would only read more slowly. A malformed dump
 * yields fewer elements rather than a thrown parse error, which is the right
 * failure for something a phone produced under load.
 */
export function distillUiDump(xml: string): UiScreen {
  const nodes = xml.match(/<node\b[^>]*>/g) ?? [];
  const elements: UiElement[] = [];
  let size: { w: number; h: number } | undefined;
  let dropped = 0;

  for (const node of nodes) {
    const point = centre(attr(node, 'bounds'));
    if (!point) continue;

    // The root node's bounds are the screen. Worth reporting once: a model
    // that knows the screen is 1080×2400 can tell a mis-scaled coordinate from
    // a plausible one.
    if (!size) {
      const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attr(node, 'bounds'));
      if (m && Number(m[1]) === 0 && Number(m[2]) === 0) {
        size = { w: Number(m[3]), h: Number(m[4]) };
      }
    }

    const text = decode(attr(node, 'text')).trim();
    const desc = decode(attr(node, 'content-desc')).trim();
    const rawId = attr(node, 'resource-id');
    const id = rawId ? rawId.split('/').pop() : '';
    const clickable = attr(node, 'clickable') === 'true';
    const cls = (attr(node, 'class').split('.').pop() || 'View').slice(0, 40);
    const editable = cls === 'EditText' || attr(node, 'focusable') === 'true' && cls.includes('Edit');

    // The filter that does the work: a node is worth listing if a person could
    // press it or read it. A layout container with no label and no handler is
    // scaffolding, and scaffolding is what makes these dumps unreadable.
    if (!clickable && !text && !desc && !editable) continue;

    if (elements.length >= MAX_ELEMENTS) {
      dropped++;
      continue;
    }

    elements.push({
      i: elements.length + 1,
      ...(text ? { text } : {}),
      ...(id ? { id } : {}),
      ...(desc ? { desc } : {}),
      cls,
      clickable,
      editable,
      tap: point,
    });
  }

  return { elements, ...(dropped ? { truncated: dropped } : {}), ...(size ? { size } : {}) };
}

/**
 * Find the element a `TAP_ON` names.
 *
 * Exact match first, then a case-insensitive contains — in that order and not
 * merged, because "Sil" must not hit "Silinenler" while an exact "Sil" is
 * sitting on the same screen. `occurrence` picks among equals for the lists
 * where every row carries the same label.
 */
export function findElement(
  screen: UiScreen,
  selector: { text?: string; id?: string; desc?: string; occurrence?: number },
): UiElement | null {
  const field: keyof UiElement = selector.text ? 'text' : selector.id ? 'id' : 'desc';
  const needle = String(selector.text ?? selector.id ?? selector.desc ?? '');
  const nth = Math.max(1, Number(selector.occurrence ?? 1));

  const value = (e: UiElement) => String(e[field] ?? '');
  const exact = screen.elements.filter((e) => value(e) === needle);
  const loose = screen.elements.filter(
    (e) => value(e).toLowerCase().includes(needle.toLowerCase()) && value(e) !== needle,
  );
  const pool = exact.length ? exact : loose;
  return pool[nth - 1] ?? null;
}
