import {
  conceptContractViolations,
  BODY_SIMILARITY_CEILING,
  HOOK_SIMILARITY_CEILING,
  MIN_SHOTS_PER_CONCEPT,
  normalizeForCompare,
  tokenOverlap,
} from './concept-distinctness';

/** The owner's own reference batch: five angles on one Strandbeest idea. */
const strandbeest = [
  {
    angle: 'curiosity',
    hook: 'Bunun motoru yok.',
    shots: [
      { onScreenText: 'Bunun motoru yok.', voiceover: '', description: 'Strandbeest yürüyor, geniş plan' },
      { onScreenText: 'Pili de yok.', voiceover: '', description: 'rüzgar pervanesi dönüyor' },
      { onScreenText: 'Sadece geometri.', voiceover: 'Theo Jansen bunu 1990ta tasarladi', description: 'bacak baglantilarina makro' },
    ],
  },
  {
    angle: 'engineering',
    hook: 'Bir tekerlegi bacaga donusturebilir misin?',
    shots: [
      { onScreenText: '', voiceover: 'Once bir krank, sonra bir baglanti kolu', description: 'elle cevrilen tek bacak, yakin plan' },
      { onScreenText: 'On bir cubuk.', voiceover: 'On bir cubuk ve tek bir donme merkezi', description: 'krankin bacagi ittigi an' },
    ],
  },
  {
    angle: 'concept',
    hook: 'Bir robot islemci olmadan yuruyebilir mi?',
    shots: [
      { onScreenText: 'Islemci yok.', voiceover: 'Hesaplama bazen mekanik olur', description: 'devre karti ile bacak yan yana' },
      { onScreenText: '', voiceover: 'Karar veren sey bir kod degil, bir oran', description: 'oranlarin semasi ekranda' },
    ],
  },
  {
    angle: 'story',
    hook: 'Bu tasarimin bacak oranlarini bilgisayar secti.',
    shots: [
      { onScreenText: '', voiceover: 'Jansen bir genetik algoritma yazdi', description: 'eski calisma masasi, eskizler' },
      { onScreenText: 'On bir sayi.', voiceover: 'Kazanan on bir sayi bugun hala kullaniliyor', description: 'sayilar tek tek beliriyor' },
    ],
  },
  {
    angle: 'sensory',
    hook: 'Dislinin disine, sonra yurumeye.',
    shots: [
      { onScreenText: '', voiceover: '', description: 'makro: disli disleri kaviyor' },
      { onScreenText: '', voiceover: '', description: 'makro: krank tam tur atiyor' },
      { onScreenText: '', voiceover: '', description: 'alti bacak ayni anda yere basiyor' },
    ],
  },
];

describe('normalizeForCompare / tokenOverlap', () => {
  it('ignores case and punctuation so a re-punctuated copy is still a copy', () => {
    expect(normalizeForCompare('Bunun motoru YOK!!!')).toBe(normalizeForCompare('bunun, motoru yok'));
  });

  it('scores overlap as Jaccard over word tokens', () => {
    expect(tokenOverlap('a b c', 'a b c')).toBe(1);
    expect(tokenOverlap('a b c', 'd e f')).toBe(0);
    // {a,b,c} vs {a,b,d}: 2 shared of 4 distinct.
    expect(tokenOverlap('a b c', 'a b d')).toBeCloseTo(0.5, 5);
  });

  it('treats two empty strings as fully overlapping, not silently distinct', () => {
    // Two concepts with no hook at all are not five different angles. If this
    // returned 0 the emptiest possible batch would be the most "distinct" one.
    expect(tokenOverlap('', '')).toBe(1);
  });
});

describe('conceptContractViolations — the five-angles contract', () => {
  it('passes the reference batch', () => {
    expect(conceptContractViolations(strandbeest)).toEqual([]);
  });

  it('catches five paraphrases of one script', () => {
    // THE failure this exists for: same idea, same beats, reworded. A test that
    // only counted five results would call this a success.
    const paraphrases = [1, 2, 3, 4, 5].map((n) => ({
      angle: `angle ${n}`,
      hook: `Bu Strandbeest'in motoru yok ${n}`,
      shots: [
        { onScreenText: `Motoru yok ${n}`, voiceover: '', description: 'Strandbeest yuruyor geniş plan' },
        { onScreenText: `Pili yok ${n}`, voiceover: '', description: 'pervane donuyor yakin plan' },
      ],
    }));
    const violations = conceptContractViolations(paraphrases);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join(' ')).toMatch(/hook/i);
  });

  it('catches a repeated angle label even when the words differ', () => {
    const dupAngle = [strandbeest[0], { ...strandbeest[1], angle: 'Curiosity ' }];
    expect(conceptContractViolations(dupAngle).join(' ')).toMatch(/angle/i);
  });

  it('catches an identical hook', () => {
    const dupHook = [strandbeest[0], { ...strandbeest[1], hook: strandbeest[0].hook }];
    expect(conceptContractViolations(dupHook).join(' ')).toMatch(/hook/i);
  });

  it('catches two concepts whose SHOTS are the same body reworded', () => {
    // Distinct hooks + distinct angles, identical content underneath — the
    // shape a hook-only check would wave through.
    const sameBody = [
      { ...strandbeest[0], angle: 'a1', hook: 'Tamamen farkli bir kanca cumlesi' },
      { ...strandbeest[0], angle: 'a2', hook: 'Bambaska bir acilis ifadesi burada' },
    ];
    expect(conceptContractViolations(sameBody).join(' ')).toMatch(/shot|body|content/i);
  });

  it('rejects a concept that is not actually planned shot by shot', () => {
    const thin = [strandbeest[0], { ...strandbeest[1], shots: [strandbeest[1].shots[0]] }];
    expect(conceptContractViolations(thin).join(' ')).toMatch(
      new RegExp(`${MIN_SHOTS_PER_CONCEPT}`),
    );
  });

  it('rejects a shot that carries neither words to read nor words to hear', () => {
    // A silent shot is legitimate (the sensory concept above is entirely
    // silent) — a shot with no visual description is not: nothing tells the
    // generator what is in frame.
    const mute = [
      strandbeest[0],
      { ...strandbeest[1], shots: [{ onScreenText: '', voiceover: '', description: '' }, strandbeest[1].shots[1]] },
    ];
    expect(conceptContractViolations(mute).join(' ')).toMatch(/description/i);
  });

  it('rejects an empty hook or angle rather than counting it as different', () => {
    expect(conceptContractViolations([{ ...strandbeest[0], hook: '   ' }]).join(' ')).toMatch(/hook/i);
    expect(conceptContractViolations([{ ...strandbeest[0], angle: '' }]).join(' ')).toMatch(/angle/i);
  });

  it('names WHICH pair collided, not just that something did', () => {
    const dup = [strandbeest[0], strandbeest[1], { ...strandbeest[2], hook: strandbeest[0].hook }];
    const violations = conceptContractViolations(dup);
    // Concepts are reported by their 1-based position so a human reading the
    // error knows which two to look at.
    expect(violations.join(' ')).toMatch(/#1.*#3|#3.*#1/);
  });

  it('exposes its thresholds as constants rather than burying them', () => {
    expect(HOOK_SIMILARITY_CEILING).toBeGreaterThan(0);
    expect(HOOK_SIMILARITY_CEILING).toBeLessThan(1);
    expect(BODY_SIMILARITY_CEILING).toBeGreaterThan(HOOK_SIMILARITY_CEILING);
    expect(BODY_SIMILARITY_CEILING).toBeLessThan(1);
  });
});
