import { distillUiDump, findElement } from './ui-dump';

/**
 * A real-shaped WhatsApp chat list, cut down: the root, two layout containers
 * that carry nothing, an icon button labelled only by content-desc, two rows
 * with the SAME label (the case `occurrence` exists for), a text field, and a
 * zero-area node of the sort a collapsed view leaves behind.
 */
const XML = `<?xml version='1.0' encoding='UTF-8'?>
<hierarchy rotation="0">
<node index="0" class="android.widget.FrameLayout" text="" resource-id="" content-desc="" clickable="false" bounds="[0,0][1080,2400]">
<node index="0" class="android.widget.LinearLayout" text="" resource-id="" content-desc="" clickable="false" bounds="[0,0][1080,200]">
<node index="0" class="android.widget.ImageButton" text="" resource-id="com.whatsapp:id/search" content-desc="Ara" clickable="true" bounds="[880,60][980,160]" />
<node index="1" class="android.widget.EditText" text="" resource-id="com.whatsapp:id/entry" content-desc="" clickable="true" focusable="true" bounds="[40,220][1000,320]" />
</node>
<node index="1" class="android.widget.TextView" text="Ayşe Yılmaz" resource-id="com.whatsapp:id/name" content-desc="" clickable="true" bounds="[0,400][1080,540]" />
<node index="2" class="android.widget.TextView" text="Ayşe Yılmaz" resource-id="com.whatsapp:id/name" content-desc="" clickable="true" bounds="[0,540][1080,680]" />
<node index="3" class="android.widget.TextView" text="Ayşe Yılmazlar Ltd." resource-id="com.whatsapp:id/name" clickable="true" bounds="[0,680][1080,820]" />
<node index="4" class="android.view.View" text="" resource-id="" content-desc="" clickable="false" bounds="[0,900][0,900]" />
<node index="5" class="android.widget.TextView" text="Kabul &amp; devam" resource-id="" content-desc="" clickable="true" bounds="[100,1000][500,1100]" />
</node>
</hierarchy>`;

describe('distillUiDump', () => {
  const screen = distillUiDump(XML);

  it('drops the scaffolding a person cannot touch or read', () => {
    // The root and the two empty layouts are the bulk of a real dump and none
    // of them is a thing anybody presses.
    expect(screen.elements.map((e) => e.cls)).not.toContain('FrameLayout');
    expect(screen.elements.map((e) => e.cls)).not.toContain('LinearLayout');
  });

  it('drops a zero-area node rather than offering a tap that lands nowhere', () => {
    expect(screen.elements.some((e) => e.tap[0] === 0 && e.tap[1] === 900)).toBe(false);
  });

  it('gives every element the one number a caller needs', () => {
    const search = screen.elements.find((e) => e.desc === 'Ara')!;
    expect(search.tap).toEqual([930, 110]);
  });

  it('keeps an icon button that has no text but does have a description', () => {
    // The only label on most icon buttons — and usually the button a model
    // actually wants.
    expect(screen.elements.some((e) => e.desc === 'Ara' && e.clickable)).toBe(true);
  });

  it('strips the package prefix off a resource id', () => {
    expect(screen.elements.some((e) => e.id === 'entry')).toBe(true);
    expect(screen.elements.some((e) => String(e.id).includes('com.whatsapp'))).toBe(false);
  });

  it('decodes XML entities so the text reads as the phone shows it', () => {
    expect(screen.elements.some((e) => e.text === 'Kabul & devam')).toBe(true);
  });

  it('decodes NUMERIC references too — the kind uiautomator actually emits', () => {
    // Measured on a real Android 13 screen: Chrome's consent paragraph came
    // back carrying a literal "&#10;" where the line break was. A model
    // reading that sees markup, and a TAP_ON matching that label would be
    // matching a string the screen never displayed.
    const xml =
      '<hierarchy><node class="android.widget.TextView" text="Devam&#10;edin &#231;ay" clickable="true" bounds="[0,0][100,50]" /></hierarchy>';
    expect(distillUiDump(xml).elements[0].text).toBe('Devam edin çay');
  });

  it('reports the screen size once, from the root', () => {
    expect(screen.size).toEqual({ w: 1080, h: 2400 });
  });

  it('marks a text field as editable so a caller knows where TEXT lands', () => {
    expect(screen.elements.find((e) => e.id === 'entry')!.editable).toBe(true);
  });
});

describe('findElement', () => {
  const screen = distillUiDump(XML);

  it('prefers an exact label over one that merely contains it', () => {
    // "Ayşe Yılmaz" must not open "Ayşe Yılmazlar Ltd." while the exact row is
    // right there. This is the difference between messaging a person and
    // messaging a company with a similar name.
    expect(findElement(screen, { text: 'Ayşe Yılmaz' })!.tap).toEqual([540, 470]);
  });

  it('picks among equals by occurrence, for the lists where every row reads alike', () => {
    expect(findElement(screen, { text: 'Ayşe Yılmaz', occurrence: 2 })!.tap).toEqual([540, 610]);
  });

  it('falls back to a contains match when nothing matches exactly', () => {
    expect(findElement(screen, { text: 'Yılmazlar' })!.text).toBe('Ayşe Yılmazlar Ltd.');
  });

  it('finds by description and by id, not only by text', () => {
    expect(findElement(screen, { desc: 'Ara' })!.cls).toBe('ImageButton');
    expect(findElement(screen, { id: 'entry' })!.editable).toBe(true);
  });

  it('returns null rather than a nearby guess', () => {
    expect(findElement(screen, { text: 'Gönder' })).toBeNull();
  });
});

describe('a dump the phone produced badly', () => {
  it('yields fewer elements instead of throwing', () => {
    // A truncated dump is what a phone under load actually returns. Throwing
    // here would turn a degraded read into a failed command.
    expect(() => distillUiDump('<hierarchy><node class="a.b.C" text="yarım')).not.toThrow();
    expect(distillUiDump('not xml at all').elements).toEqual([]);
  });

  it('says how many it dropped rather than going quiet', () => {
    const many = Array.from(
      { length: 100 },
      (_, i) => `<node class="android.widget.Button" text="B${i}" clickable="true" bounds="[0,${i * 10}][100,${i * 10 + 9}]" />`,
    ).join('');
    const screen = distillUiDump(`<hierarchy>${many}</hierarchy>`);
    expect(screen.elements).toHaveLength(80);
    expect(screen.truncated).toBe(20);
  });
});
