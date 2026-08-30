import { describe, it, expect } from 'vitest';
import en from './locales/en/marketing.json';
import tr from './locales/tr/marketing.json';

type Json = Record<string, unknown>;
const flat = (o: Json, p = ''): string[] =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? flat(v as Json, `${p}${k}.`)
      : [`${p}${k}`],
  );

describe('marketing i18n — AI Studio / Brand Kit', () => {
  it('en defines the new namespaces and nav keys', () => {
    expect((en as Json).aiStudio).toBeTruthy();
    expect((en as Json).brandKit).toBeTruthy();
    expect(flat(en as Json)).toEqual(expect.arrayContaining(['nav.aiStudio', 'nav.brandKit']));
  });

  it('tr mirrors every aiStudio / brandKit / social.composer key in en', () => {
    const want = flat(en as Json).filter((k) =>
      /^(aiStudio|brandKit|social\.composer)\./.test(k),
    );
    const have = new Set(flat(tr as Json));
    expect(want.filter((k) => !have.has(k))).toEqual([]);
  });
});

describe('marketing i18n — MCP connector console (Faz 4)', () => {
  it('en defines the mcpConsole namespace and its nav entry', () => {
    expect((en as Json).mcpConsole).toBeTruthy();
    expect(flat(en as Json)).toEqual(expect.arrayContaining(['nav.mcpConsole']));
  });

  it('tr mirrors every mcpConsole key in en (and vice versa)', () => {
    const enKeys = flat(en as Json).filter((k) => /^(mcpConsole\.|nav\.mcpConsole$)/.test(k));
    const trKeys = flat(tr as Json).filter((k) => /^(mcpConsole\.|nav\.mcpConsole$)/.test(k));
    const trSet = new Set(trKeys);
    const enSet = new Set(enKeys);
    expect(enKeys.filter((k) => !trSet.has(k))).toEqual([]);
    expect(trKeys.filter((k) => !enSet.has(k))).toEqual([]);
  });
});

describe('marketing i18n — home timeline panel', () => {
  // i18next resolves lng -> fallbackLng -> the call's inline defaultValue, and
  // config.ts sets `fallbackLng: 'en'`. So a locale merely MISSING these keys
  // neither throws nor shows a raw key: a ru/ar/uz operator is quietly served
  // ENGLISH. TimelinePanel's Turkish inline defaults are reachable only if `en`
  // lacks the key too — which is why the en catalogue is in the loop below
  // rather than assumed.
  //
  // Silent English is exactly as invisible as a raw key is loud, and nothing
  // else catches it: `missingKeyHandler` is dev-only (`saveMissing` is gated on
  // import.meta.env.DEV, so prod is silent), and localeCompleteness's >=95%
  // offer gate would not notice seven missing keys in a catalogue this size.
  it('every offered locale defines the timeline namespace, not just tr', async () => {
    const want = flat((tr as Json).timeline as Json).map((k) => `timeline.${k}`);
    expect(want.length).toBeGreaterThan(0);
    for (const locale of ['en', 'tr', 'ar', 'ru', 'uz']) {
      const cat = (await import(`./locales/${locale}/marketing.json`)).default as Json;
      const have = new Set(flat(cat));
      expect({ locale, missing: want.filter((k) => !have.has(k)) }).toEqual({ locale, missing: [] });
    }
  });
});

describe('marketing i18n — home left-column tabs', () => {
  // Same trap as the timeline panel, one level worse: these two words ARE the
  // navigation. A ru/ar/uz operator who is quietly served the Turkish default
  // sees a column whose two tabs are labelled in a language they did not pick,
  // and `fallbackLng: 'en'` means nothing throws and no raw key ever appears.
  // The failure-count label is in the same set because a badge announced only
  // as a bare number tells a screen-reader user nothing about what it counts.
  it('every offered locale defines the command.tabs namespace, not just tr', async () => {
    const want = flat((tr as Json).command as Json)
      .filter((k) => k.startsWith('tabs.'))
      .map((k) => `command.${k}`);
    expect(want).toEqual(
      expect.arrayContaining(['command.tabs.timeline', 'command.tabs.flow', 'command.tabs.failures']),
    );
    for (const locale of ['en', 'tr', 'ar', 'ru', 'uz']) {
      const cat = (await import(`./locales/${locale}/marketing.json`)).default as Json;
      const have = new Set(flat(cat));
      expect({ locale, missing: want.filter((k) => !have.has(k)) }).toEqual({ locale, missing: [] });
    }
  });

  // The badge's whole content is the number, and it reaches a screen reader
  // only through this placeholder. A translator dropping `{{count}}` costs
  // nothing at runtime — i18next just renders the sentence without it — and
  // leaves the tab announcing "başarısız iş" with no idea how many.
  it('keeps the {{count}} placeholder in every failure label, in every locale', async () => {
    for (const locale of ['en', 'tr', 'ar', 'ru', 'uz']) {
      const cat = (await import(`./locales/${locale}/marketing.json`)).default as Json;
      const label = ((cat.command as Json).tabs as Json).failures as string;
      expect({ locale, label }).toEqual({ locale, label: expect.stringContaining('{{count}}') });
    }
  });
});

describe('marketing i18n — lead detail: the Satış tab', () => {
  // A whole TAB and its empty/error copy. Same trap as the timeline panel:
  // `fallbackLng: 'en'` means a locale that simply lacks these keys neither
  // throws nor shows a raw key — a ru/ar/uz operator is quietly served English,
  // and nothing at runtime notices (missingKeyHandler is DEV-only).
  //
  // The error strings are in the same set on purpose. `leadDetail.*.failed` is
  // the sentence that distinguishes "could not load" from "nothing here"; if it
  // silently degrades to English while the empty state is translated, the two
  // states stop reading as different states in that locale.
  //
  // Konuşmalar used to be pinned here beside it. That tab is gone — Hareketler
  // and Konuşmalar merged into Akış — and its keys went with the component, so
  // what stood here is now covered by the Akış block below.
  it('every offered locale defines the sales keys, not just tr', async () => {
    const want = flat((tr as Json).leadDetail as Json)
      .filter((k) => /^(sales\.|tabs\.sales$)/.test(k))
      .map((k) => `leadDetail.${k}`);
    expect(want).toEqual(
      expect.arrayContaining([
        'leadDetail.tabs.sales',
        'leadDetail.sales.failed',
        'leadDetail.sales.empty.title',
      ]),
    );
    for (const locale of ['en', 'tr', 'ar', 'ru', 'uz']) {
      const cat = (await import(`./locales/${locale}/marketing.json`)).default as Json;
      const have = new Set(flat(cat));
      expect({ locale, missing: want.filter((k) => !have.has(k)) }).toEqual({ locale, missing: [] });
    }
  });

  // The Satış tab's rows deep-link into the board with `?deal=`, and a deal
  // that cannot be opened has to say so out loud rather than dropping the user
  // on a pipeline. That toast is the only thing distinguishing a dead link from
  // a working one, so it may not silently degrade to English.
  it('every offered locale can say a deal could not be opened', async () => {
    for (const locale of ['en', 'tr', 'ar', 'ru', 'uz']) {
      const cat = (await import(`./locales/${locale}/marketing.json`)).default as Json;
      const have = new Set(flat(cat));
      expect({ locale, has: have.has('opportunities.dealNotFound') }).toEqual({ locale, has: true });
    }
  });
});

describe('marketing i18n — lead detail: the Akış stream', () => {
  // The whole merged stream: its tab name, its three source signals, its
  // per-message failure line and its empty state. Same trap as everywhere else
  // in this file — `fallbackLng: 'en'` means a locale that simply lacks these
  // neither throws nor shows a raw key, so a ru/ar/uz operator is quietly
  // served another language and nothing at runtime notices.
  it('every offered locale defines the stream namespace, not just tr', async () => {
    const want = flat((tr as Json).leadDetail as Json)
      .filter((k) => /^(stream\.|tabs\.stream$)/.test(k))
      .map((k) => `leadDetail.${k}`);
    expect(want).toEqual(
      expect.arrayContaining([
        'leadDetail.tabs.stream',
        'leadDetail.stream.failed',
        'leadDetail.stream.unread',
        'leadDetail.stream.truncated',
        'leadDetail.stream.gated',
        'leadDetail.stream.messageFailed',
        'leadDetail.stream.empty.title',
      ]),
    );
    for (const locale of ['en', 'tr', 'ar', 'ru', 'uz']) {
      const cat = (await import(`./locales/${locale}/marketing.json`)).default as Json;
      const have = new Set(flat(cat));
      expect({ locale, missing: want.filter((k) => !have.has(k)) }).toEqual({ locale, missing: [] });
    }
  });

  // The three signals mean three different things — could not READ it / read
  // it, there was MORE / your PLAN does not include it — and LeadStream.tsx is
  // held to keeping them apart. But that component test runs against the inline
  // Turkish defaults, so it can only police one language. A translator who
  // renders `gated` with the same words as `unread` re-collapses the
  // distinction in a locale no other test looks at, and sends a billing
  // question to support.
  it('never says a gated source failed, in any locale', async () => {
    for (const locale of ['en', 'tr', 'ar', 'ru', 'uz']) {
      const cat = (await import(`./locales/${locale}/marketing.json`)).default as Json;
      const s = (cat.leadDetail as Json).stream as Record<string, string>;
      expect({ locale, collides: s.gated === s.unread }).toEqual({ locale, collides: false });
      expect({ locale, collides: s.gated === s.truncated }).toEqual({ locale, collides: false });
    }
  });
});

describe('marketing i18n — lead header: Ara + Mesaj', () => {
  // The lead header's two new actions and the whole start-conversation dialog.
  // `fallbackLng: 'en'` means a locale that simply lacks these neither throws
  // nor shows a raw key — a ru/ar/uz operator is quietly served English, and
  // nothing at runtime notices (missingKeyHandler is DEV-only).
  //
  // The refusal strings are in the set deliberately. `startConversation.failed`
  // and `.noChannels` are what a rep sees when the message did NOT go out; if
  // they degrade to English while the dialog around them is translated, "sent"
  // and "not sent" stop reading as different outcomes in that locale — the
  // exact confusion this repo has already paid for once.
  it('every offered locale defines the message action + start-conversation keys', async () => {
    const want = flat((tr as Json).leadDetail as Json)
      .filter((k) => /^(startConversation\.|actions\.message$)/.test(k))
      .map((k) => `leadDetail.${k}`);
    expect(want).toEqual(
      expect.arrayContaining([
        'leadDetail.actions.message',
        'leadDetail.startConversation.title',
        'leadDetail.startConversation.send',
        'leadDetail.startConversation.failed',
        'leadDetail.startConversation.noChannels',
      ]),
    );
    for (const locale of ['en', 'tr', 'ar', 'ru', 'uz']) {
      const cat = (await import(`./locales/${locale}/marketing.json`)).default as Json;
      const have = new Set(flat(cat));
      expect({ locale, missing: want.filter((k) => !have.has(k)) }).toEqual({ locale, missing: [] });
    }
  });
});
describe('marketing i18n — the click-to-dial affordance', () => {
  // ClickToDialButton is the ONE dial affordance in the product — the calls
  // page header and, since spec §3, every lead header. It shipped with its
  // labels as hardcoded English literals ('Call', 'Starting…', 'Log call
  // outcome', 'Save outcome', 'Enter a phone number') on a page where every
  // other string is translated. `fallbackLng: 'en'` means the same trap as the
  // timeline panel, except here it was not even a fallback: a Turkish rep saw
  // an English button no matter what the catalogue said.
  it('every offered locale defines the dial keys, not just tr', async () => {
    const want = flat(((tr as Json).calls as Json).dial as Json).map((k) => `calls.dial.${k}`);
    expect(want).toEqual(
      expect.arrayContaining([
        'calls.dial.call',
        'calls.dial.starting',
        'calls.dial.enterPhone',
        'calls.dial.logTitle',
        'calls.dial.save',
      ]),
    );
    for (const locale of ['en', 'tr', 'ar', 'ru', 'uz']) {
      const cat = (await import(`./locales/${locale}/marketing.json`)).default as Json;
      const have = new Set(flat(cat));
      expect({ locale, missing: want.filter((k) => !have.has(k)) }).toEqual({ locale, missing: [] });
    }
  });

  // The spec names the action "Ara", and that word is the whole button.
  it('calls the primary action Ara in Turkish', () => {
    expect(((tr as Json).calls as Json).dial as Json).toMatchObject({ call: 'Ara' });
  });

  // The number being rung is the only thing that tells a rep the modal in front
  // of them belongs to the call they just placed. A translator dropping
  // {{phone}} costs nothing at runtime and leaves the dialog naming no one.
  it('keeps the {{phone}} placeholder in every dialing label', async () => {
    for (const locale of ['en', 'tr', 'ar', 'ru', 'uz']) {
      const cat = (await import(`./locales/${locale}/marketing.json`)).default as Json;
      const label = ((cat.calls as Json).dial as Json).dialing as string;
      expect({ locale, label }).toEqual({ locale, label: expect.stringContaining('{{phone}}') });
    }
  });
});

describe('marketing i18n — the person surface and its work queue', () => {
  // The whole of the person-primary surface: its title, its three columns and
  // the chips that are how anyone reaches the leads nobody has answered. The
  // two tab names that used to be anchored here are deliberately gone with the
  // tabs — there is one list now, and one object in it.
  //
  // Same trap as everywhere else in this file: `fallbackLng: 'en'` means a
  // locale that simply lacks them neither throws nor shows a raw key — a
  // ru/ar/uz operator is quietly served another language, and nothing at
  // runtime notices (missingKeyHandler is DEV-only).
  it('every offered locale names all three columns and all three work-queue chips', async () => {
    const want = [
      ...flat((tr as Json).surface as Json).map((k) => `surface.${k}`),
      ...flat(((tr as Json).leads as Json).queue as Json).map((k) => `leads.queue.${k}`),
    ];
    expect(want).toEqual(
      expect.arrayContaining([
        'surface.title',
        // the list column, the stream column, the record card
        'surface.people.search',
        'surface.pane.reply',
        'surface.card.open',
        'leads.queue.waiting',
        'leads.queue.unassigned',
        'leads.queue.all',
      ]),
    );
    // The tabs are gone; a stale key left behind is a string nobody renders
    // and a translator still pays for.
    expect(want).not.toContain('surface.tab.conversations');
    for (const locale of ['en', 'tr', 'ar', 'ru', 'uz']) {
      const cat = (await import(`./locales/${locale}/marketing.json`)).default as Json;
      const have = new Set(flat(cat));
      expect({ locale, missing: want.filter((k) => !have.has(k)) }).toEqual({ locale, missing: [] });
    }
  });

  // "Bekleyen" is the one chip whose meaning is not self-evident — it is not a
  // lead status but "the customer wrote last and nobody replied". The hint is
  // the only place that says so, and a count that cannot be fetched has to
  // read as unknown rather than as zero, which is what countFailed is for.
  it('every offered locale can explain Bekleyen and admit a missing count', async () => {
    for (const locale of ['en', 'tr', 'ar', 'ru', 'uz']) {
      const cat = (await import(`./locales/${locale}/marketing.json`)).default as Json;
      const have = new Set(flat(cat));
      expect({
        locale,
        missing: ['leads.queue.waitingHint', 'leads.queue.countFailed'].filter((k) => !have.has(k)),
      }).toEqual({ locale, missing: [] });
    }
  });

  it('uses the spec’s own words in Turkish', () => {
    // The spec's own word for the object on this surface. Not "leads" and not
    // "conversations" — those were the two lists, and the correction was that
    // there is only ever one, of people.
    expect((tr as Json).surface).toMatchObject({ title: 'Kişiler' });
    expect(((tr as Json).leads as Json).queue).toMatchObject({
      waiting: 'Bekleyen',
      unassigned: 'Atanmamış',
      all: 'Hepsi',
    });
  });
});

describe('marketing i18n — the board as a view of people', () => {
  // The pipeline's leftmost column is the 361 people nobody is selling to, and
  // the words that make it readable: what the column IS, what a card with no
  // person on it says, and — the load-bearing pair — how it admits a failure
  // versus how it admits an empty column.
  //
  // Same trap as everywhere else in this file: `fallbackLng: 'en'` means a
  // locale that simply LACKS these neither throws nor shows a raw key, so a
  // ru/ar/uz operator is quietly served another language and nothing at runtime
  // notices (missingKeyHandler is DEV-only). The `opportunities` namespace is
  // barely translated outside en/tr, which is exactly why the new keys need
  // pinning rather than assuming.
  const WANT = [
    'opportunities.notInPipeline.title',
    'opportunities.notInPipeline.failed',
    'opportunities.notInPipeline.empty',
    'opportunities.notInPipeline.more',
    'opportunities.card.nobody',
    'opportunities.card.unnamed',
    'opportunities.terminalDropRefused',
    'opportunities.dealForPersonFailed',
  ];

  it('every offered locale can name the column, its cards and its refusals', async () => {
    for (const locale of ['en', 'tr', 'ar', 'ru', 'uz']) {
      const cat = (await import(`./locales/${locale}/marketing.json`)).default as Json;
      const have = new Set(flat(cat));
      expect({ locale, missing: WANT.filter((k) => !have.has(k)) }).toEqual({
        locale,
        missing: [],
      });
    }
  });

  // The repo's central rule, at the string level. "We could not read who is
  // outside the pipeline" and "nobody is outside the pipeline" are opposite
  // facts; a translator who renders them with the same sentence re-collapses
  // the distinction in a locale no component test looks at — and this column
  // exists precisely to stop a failed read from reading as a zero.
  it('never says a column that failed is a column that is empty, in any locale', async () => {
    for (const locale of ['en', 'tr', 'ar', 'ru', 'uz']) {
      const cat = (await import(`./locales/${locale}/marketing.json`)).default as Json;
      const c = (cat.opportunities as Json).notInPipeline as Record<string, string>;
      expect({ locale, collides: c.failed === c.empty }).toEqual({ locale, collides: false });
    }
  });

  it('uses the spec’s own words in Turkish', () => {
    expect(((tr as Json).opportunities as Json).notInPipeline).toMatchObject({
      title: 'Hatta değil',
    });
  });
});
