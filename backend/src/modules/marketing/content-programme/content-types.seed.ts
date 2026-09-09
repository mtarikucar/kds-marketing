/**
 * The ten formats a programme starts with (design K1).
 *
 * They live in code rather than in a migration on purpose: a programme copies
 * them into its workspace on creation (`ContentTypesService.ensureDefaults`),
 * and from then on the OWNER'S rows are the truth — renamed, restructured,
 * retired — while a workspace that never opened a programme carries nothing.
 * Changing an entry here therefore affects only workspaces created afterwards;
 * that is the intended "seed, not schema" behaviour.
 *
 * Each `structure` is the beat template the planner follows. Durations sum to
 * `defaultDurationSec` so a beat's "0-3s" window can be derived from its
 * predecessors, and the total stays inside the short-form sweet spot (12–20 s)
 * where every supported network delivers the whole clip.
 */
export interface ContentTypeBeat {
  role: string;
  durationSec: number;
  guidance: string;
}

export interface DefaultContentType {
  key: string;
  name: string;
  description: string;
  structure: ContentTypeBeat[];
  defaultDurationSec: number;
  networks: string[];
  minShare: number;
  maxShare: number;
  ordinal: number;
}

const SHORT_FORM = ['INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'FACEBOOK'];

export const DEFAULT_CONTENT_TYPES: readonly DefaultContentType[] = [
  {
    key: 'hook-story',
    name: 'Kanca + hikâye',
    description: 'İlk saniyede merak uyandıran bir kanca, ardından tek bir kişinin küçük hikâyesi ve ürünün çözdüğü an.',
    structure: [
      { role: 'hook', durationSec: 3, guidance: 'Tek cümlelik merak kancası; yüz ve göz teması, metin üstte.' },
      { role: 'story', durationSec: 7, guidance: 'Sorunun yaşandığı anı göster; kişi, mekân, gerginlik.' },
      { role: 'turn', durationSec: 3, guidance: 'Ürün/çözüm devreye girer; rahatlama.' },
      { role: 'cta', durationSec: 2, guidance: 'Tek, net çağrı; marka logosu.' },
    ],
    defaultDurationSec: 15,
    networks: SHORT_FORM,
    minShare: 0.05,
    maxShare: 0.4,
    ordinal: 0,
  },
  {
    key: 'how-to',
    name: 'Nasıl yapılır',
    description: 'Üç adımda bir sonuca ulaştıran, kaydedilmek için tasarlanmış kısa rehber.',
    structure: [
      { role: 'hook', durationSec: 3, guidance: 'Sonucu önce göster: "Bunu 3 adımda yap".' },
      { role: 'step-1', durationSec: 4, guidance: 'İlk adım; ekranda numara ve kısa metin.' },
      { role: 'step-2', durationSec: 4, guidance: 'İkinci adım; eller/ürün yakın plan.' },
      { role: 'step-3', durationSec: 4, guidance: 'Son adım ve bitmiş sonuç; "kaydet" çağrısı.' },
    ],
    defaultDurationSec: 15,
    networks: SHORT_FORM,
    minShare: 0.05,
    maxShare: 0.4,
    ordinal: 1,
  },
  {
    key: 'before-after',
    name: 'Öncesi / sonrası',
    description: 'Aynı kadraj, iki durum: ürün öncesi ve sonrası arasındaki fark tek bakışta okunur.',
    structure: [
      { role: 'before', durationSec: 4, guidance: 'Öncesi: sorunlu durum, soğuk ışık, sabit kadraj.' },
      { role: 'transition', durationSec: 2, guidance: 'Hızlı geçiş (el hareketi, kesme, wipe).' },
      { role: 'after', durationSec: 6, guidance: 'Sonrası: aynı kadraj, sıcak ışık, sonucu göster.' },
    ],
    defaultDurationSec: 12,
    networks: SHORT_FORM,
    minShare: 0.05,
    maxShare: 0.4,
    ordinal: 2,
  },
  {
    key: 'pov-ugc',
    name: 'POV / UGC',
    description: 'Elde telefon, birinci şahıs; bir müşterinin kendi çektiği izlenimi veren samimi klip.',
    structure: [
      { role: 'hook', durationSec: 3, guidance: 'POV metni: "POV: ... ile ilk günün"; el kamerası.' },
      { role: 'experience', durationSec: 9, guidance: 'Ürünü günlük hayatta kullanırken; doğal ses, doğal ışık.' },
      { role: 'reaction', durationSec: 3, guidance: 'Samimi tepki; kamera yüzünde biter.' },
    ],
    defaultDurationSec: 15,
    networks: SHORT_FORM,
    minShare: 0.05,
    maxShare: 0.4,
    ordinal: 3,
  },
  {
    key: 'product-demo',
    name: 'Ürün demosu',
    description: 'Ürünün tek bir özelliğini yakın planda, açıklamasız ve net gösteren demo.',
    structure: [
      { role: 'hook', durationSec: 3, guidance: 'Özelliği bir soruyla aç: "Bunu yapabildiğini biliyor muydun?"' },
      { role: 'demo', durationSec: 10, guidance: 'Ürün elde, özellik çalışırken; makro çekim, temiz arka plan.' },
      { role: 'cta', durationSec: 2, guidance: 'Ürün adı ve nereden alınacağı.' },
    ],
    defaultDurationSec: 15,
    networks: SHORT_FORM,
    minShare: 0.05,
    maxShare: 0.4,
    ordinal: 4,
  },
  {
    key: 'myth-bust',
    name: 'Mit çürütme',
    description: 'Sektördeki yaygın bir yanlış inanç önce söylenir, sonra kanıtla çürütülür.',
    structure: [
      { role: 'myth', durationSec: 4, guidance: 'Miti büyük harflerle ekrana yaz; "yanlış" damgası.' },
      { role: 'evidence', durationSec: 8, guidance: 'Gerçeği göster: karşılaştırma, veri veya canlı deneme.' },
      { role: 'verdict', durationSec: 3, guidance: 'Tek cümlelik doğru bilgi; "paylaş" çağrısı.' },
    ],
    defaultDurationSec: 15,
    networks: SHORT_FORM,
    minShare: 0.05,
    maxShare: 0.4,
    ordinal: 5,
  },
  {
    key: 'listicle',
    name: 'Liste',
    description: '"3 şey" formatı: hızlı kesmelerle sıralanan, her biri tek kadraj alan maddeler.',
    structure: [
      { role: 'hook', durationSec: 3, guidance: '"... için 3 şey"; sayı ekranda büyük.' },
      { role: 'item-1', durationSec: 4, guidance: '1. madde; ekranda numara, tek kadraj.' },
      { role: 'item-2', durationSec: 4, guidance: '2. madde; tempo aynı.' },
      { role: 'item-3', durationSec: 4, guidance: '3. madde en güçlüsü; "kaydet" çağrısıyla bitir.' },
    ],
    defaultDurationSec: 15,
    networks: SHORT_FORM,
    minShare: 0.05,
    maxShare: 0.4,
    ordinal: 6,
  },
  {
    key: 'behind-the-scenes',
    name: 'Kamera arkası',
    description: 'Ürünün nasıl yapıldığı, ekibin günü ya da hazırlık anları; cilasız ve güven veren.',
    structure: [
      { role: 'hook', durationSec: 3, guidance: '"Böyle yapılıyor" ya da "bugün atölyede"; el kamerası.' },
      { role: 'process', durationSec: 10, guidance: 'Süreçten 3-4 kısa an; gerçek sesler, insanlar.' },
      { role: 'result', durationSec: 3, guidance: 'Bitmiş ürün ve ekipten bir gülümseme.' },
    ],
    defaultDurationSec: 16,
    networks: SHORT_FORM,
    minShare: 0.05,
    maxShare: 0.4,
    ordinal: 7,
  },
  {
    key: 'testimonial',
    name: 'Müşteri sesi',
    description: 'Gerçek bir müşterinin kendi sözleriyle deneyimi; yorum ekran görüntüsü ya da kısa röportaj.',
    structure: [
      { role: 'hook', durationSec: 3, guidance: 'Yorumdan en güçlü cümle ekranda; müşteri adı/şehri.' },
      { role: 'testimony', durationSec: 10, guidance: 'Müşteri anlatır ya da yorum okunur; ürün görünür.' },
      { role: 'proof', durationSec: 3, guidance: 'Sonuç/puan; markaya güven veren kapanış.' },
    ],
    defaultDurationSec: 16,
    networks: [...SHORT_FORM, 'LINKEDIN'],
    minShare: 0.05,
    maxShare: 0.4,
    ordinal: 8,
  },
  {
    key: 'trend-remix',
    name: 'Trend remix',
    description: 'Güncel bir trendi (ses, format, konu) markanın diline çevirir; ömrü kısa, erişimi yüksek.',
    structure: [
      { role: 'trend-hook', durationSec: 3, guidance: 'Trendin tanınan açılışını birebir kullan; kitle hemen tanısın.' },
      { role: 'remix', durationSec: 8, guidance: 'Trendi ürün/markaya bağla; format korunur, içerik bizim.' },
      { role: 'tag', durationSec: 3, guidance: 'Marka damgası ve trend etiketi.' },
    ],
    defaultDurationSec: 14,
    networks: SHORT_FORM,
    minShare: 0.05,
    maxShare: 0.25, // a trend has a short shelf life; never let it crowd the calendar
    ordinal: 9,
  },
];
