import type { ReactNode } from 'react';
import { AlertTriangle, Info, Lightbulb } from 'lucide-react';

/**
 * In-app help center (Nextra/help.hummytummy style) for the marketing platform.
 * Bilingual (TR/EN) connection + usage guides authored as JSX so they can use
 * the app's design tokens. The doc tree drives both the sidebar and the routes.
 */

export type Lang = 'tr' | 'en';
export interface Bi {
  tr: string;
  en: string;
}
export interface DocPage {
  slug: string;
  title: Bi;
  body: (L: Lang) => ReactNode;
}
export interface DocSection {
  id: string;
  title: Bi;
  pages: DocPage[];
}

// ─────────────────────────────────────────────── small doc-prose primitives

const t = (L: Lang, tr: string, en: string) => (L === 'tr' ? tr : en);

function H2({ children }: { children: ReactNode }) {
  return <h2 className="mt-8 mb-3 text-lg font-semibold text-foreground first:mt-0">{children}</h2>;
}
function P({ children }: { children: ReactNode }) {
  return <p className="my-3 text-sm leading-6 text-muted-foreground">{children}</p>;
}
function Steps({ children }: { children: ReactNode }) {
  return <ol className="my-3 ml-5 list-decimal space-y-2 text-sm leading-6 text-foreground">{children}</ol>;
}
function Ul({ children }: { children: ReactNode }) {
  return <ul className="my-3 ml-5 list-disc space-y-1.5 text-sm leading-6 text-foreground">{children}</ul>;
}
function B({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-foreground">{children}</strong>;
}
function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-surface-muted px-1.5 py-0.5 text-[0.8em] text-foreground">{children}</code>;
}
function Callout({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'tip'; children: ReactNode }) {
  const map = {
    info: { Icon: Info, cls: 'border-blue-500/30 bg-blue-500/5 text-foreground' },
    warn: { Icon: AlertTriangle, cls: 'border-amber-500/30 bg-amber-500/5 text-foreground' },
    tip: { Icon: Lightbulb, cls: 'border-green-500/30 bg-green-500/5 text-foreground' },
  }[tone];
  const Icon = map.Icon;
  return (
    <div className={`my-4 flex gap-2.5 rounded-lg border p-3 text-sm leading-6 ${map.cls}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────── content tree

export const HELP_SECTIONS: DocSection[] = [
  {
    id: 'start',
    title: { tr: 'Başlarken', en: 'Getting Started' },
    pages: [
      {
        slug: 'overview',
        title: { tr: 'Genel Bakış', en: 'Overview' },
        body: (L) => (
          <>
            <P>
              {t(
                L,
                'Bu platform; sosyal medya, WhatsApp, reklam ve telefon kanallarını tek panelde toplayan bir pazarlama & CRM çözümüdür. Bu rehber, hesaplarınızı nasıl bağlayacağınızı adım adım anlatır.',
                'This platform is a marketing & CRM solution that unifies social media, WhatsApp, ads and telephony in one panel. This guide walks you through connecting each account step by step.',
              )}
            </P>
            <H2>{t(L, 'Neleri bağlayabilirsiniz?', 'What can you connect?')}</H2>
            <Ul>
              <li>{t(L, 'Telefon — NetGSM Netsantral ile tarayıcıdan arama (webphone) ve tıkla-ara', 'Telephony — browser calling (webphone) & click-to-dial via NetGSM Netsantral')}</li>
              <li>{t(L, 'Facebook & Instagram — gönderi paylaşımı ve DM', 'Facebook & Instagram — publishing & DMs')}</li>
              <li>{t(L, 'WhatsApp — mesajlaşma', 'WhatsApp — messaging')}</li>
              <li>{t(L, 'Meta Reklamları — raporlama, kampanya yönetimi ve otomatik ölçekleme', 'Meta Ads — reporting, campaign management & auto-scaling')}</li>
              <li>{t(L, 'SMS — NetGSM ile toplu/birebir SMS', 'SMS — bulk & 1:1 SMS via NetGSM')}</li>
            </Ul>
            <H2>{t(L, 'Ayarlar nerede?', 'Where are the settings?')}</H2>
            <P>
              {t(
                L,
                'Bağlantıların çoğu sol menüdeki ilgili sayfadan yapılır: sosyal hesaplar için ',
                'Most connections are made from the relevant page in the left menu: ',
              )}
              <Code>Pazarlama → Sosyal Medya</Code>
              {t(L, ', telefon için ', ' for social accounts, ')}
              <Code>Ayarlar → Telefon (Netsantral)</Code>
              {t(L, ', reklam için ', ' for telephony, ')}
              <Code>Raporlama → Reklamlar</Code>
              {t(L, ', mesaj kanalları için ', ' for ads, and ')}
              <Code>Mesajlar → Kanallar</Code>
              {t(L, '.', ' for messaging channels.')}
            </P>
          </>
        ),
      },
    ],
  },
  {
    id: 'connect',
    title: { tr: 'Bağlantılar', en: 'Connections' },
    pages: [
      {
        slug: 'telephony',
        title: { tr: 'Telefon (NetGSM)', en: 'Telephony (NetGSM)' },
        body: (L) => (
          <>
            <P>
              {t(
                L,
                'Telefon entegrasyonu, temsilcilerin tarayıcıdan (webphone) arama yapmasını ve lead kartından tek tıkla aramayı sağlar. NetGSM Netsantral (bulut santral) hesabı gerekir.',
                'The telephony integration lets reps call from the browser (webphone) and click-to-dial from a lead card. It requires a NetGSM Netsantral (cloud PBX) account.',
              )}
            </P>

            <H2>{t(L, '1) NetGSM bilgilerini toplayın', '1) Gather your NetGSM details')}</H2>
            <P>{t(L, 'NetGSM panelinden (Netsantral → Santral Bilgileri):', 'From the NetGSM panel (Netsantral → Santral Bilgileri):')}</P>
            <Ul>
              <li><B>{t(L, 'Abone no & şifre', 'Account no & password')}</B> {t(L, '(API/santral erişimi için)', '(for API/PBX access)')}</li>
              <li><B>{t(L, 'Domain / Sunucu', 'Domain / Server')}</B>: <Code>sip5.netsantral.com</Code></li>
              <li><B>WSS</B>: <Code>wss://sip5.netsantral.com:8089/ws</Code></li>
              <li><B>{t(L, 'Santral (trunk) no', 'Santral (trunk) no')}</B> {t(L, '(0850 hattınız)', '(your 0850 line)')}</li>
              <li><B>{t(L, 'Dahili', 'Extension')}</B>: {t(L, 'her temsilci için bir dahili oluşturun (ör. ', 'create an extension per rep (e.g. ')}<Code>101</Code>{t(L, ') ve SIP şifresini not edin', ') and note its SIP password')}</li>
            </Ul>
            <Callout tone="warn">
              {t(
                L,
                'NetGSM\'de SIP kullanıcı adı tam biçimdedir: dahili-santral (ör. ',
                'On NetGSM the SIP username is the full form: extension-santral (e.g. ',
              )}
              <Code>101-8508407303</Code>
              {t(
                L,
                '). Panele sadece dahiliyi (101) ve SIP şifresini girmeniz yeterli; sistem tam adı kendisi oluşturur.',
                '). You only enter the extension (101) and SIP password in the panel; the system builds the full username automatically.',
              )}
            </Callout>

            <H2>{t(L, '2) Çalışma alanı ayarlarını girin', '2) Configure the workspace')}</H2>
            <P><Code>{t(L, 'Ayarlar → Telefon (Netsantral)', 'Settings → Phone (Netsantral)')}</Code></P>
            <Steps>
              <li>{t(L, 'Netsantral abone no + şifre, WSS adresi, SIP domain ve trunk (0850) numarasını girin ve kaydedin.', 'Enter the Netsantral account no + password, the WSS URL, the SIP domain and the trunk (0850) number, then save.')}</li>
              <li>{t(L, 'Her temsilciye dahili + SIP şifresi atayın. İsteğe bağlı: temsilcinin cep numarası (bridge modu için).', 'Assign each rep an extension + SIP password. Optional: the rep\'s mobile number (for bridge mode).')}</li>
            </Steps>

            <H2>{t(L, '3) İki arama modu', '3) Two calling modes')}</H2>
            <Ul>
              <li><B>{t(L, 'Webphone (tarayıcı)', 'Webphone (browser)')}</B>: {t(L, 'temsilci dahiliye sahipse ve cep numarası yoksa kullanılır. Tarayıcıda konuşulur; mikrofon izni gerekir.', 'used when the rep has an extension and no mobile set. You talk in the browser; needs mic permission.')}</li>
              <li><B>Bridge</B>: {t(L, 'temsilcinin cep numarası tanımlıysa kullanılır. NetGSM önce temsilcinin cebini çaldırır, açınca müşteriye bağlar. Webphone/kayıt gerekmez.', 'used when the rep has a mobile set. NetGSM rings the rep\'s mobile first, then bridges the customer. No webphone/registration needed.')}</li>
            </Ul>

            <H2>{t(L, '4) Webphone\'u kullanma', '4) Using the webphone')}</H2>
            <Steps>
              <li>{t(L, 'Panele giriş yapın. Sağ altta küçük bir telefon göstergesi belirir; birkaç saniyede ', 'Sign in to the panel. A small phone pill appears bottom-right; within a few seconds it shows ')}<B>{t(L, '"Telefon hazır"', '"Phone ready"')}</B>{t(L, ' yazar (dahili kayıt oldu).', ' (the extension registered).')}</li>
              <li>{t(L, 'İlk aramada tarayıcı mikrofon izni ister — ', 'On the first call the browser asks for microphone permission — ')}<B>{t(L, 'İzin Ver', 'Allow')}</B>{t(L, '. Aksi halde ses gitmez.', '. Otherwise outbound audio won\'t work.')}</li>
              <li>{t(L, 'Bir lead kartında "Ara" deyin; gösterge "Görüşmede"ye geçer ve görüşürsünüz. "Kapat" ile bitirin.', 'Click "Call" on a lead; the pill turns to "In call" and you talk. End with "Hang up".')}</li>
            </Steps>
            <Callout tone="tip">
              {t(
                L,
                'Webphone\'un çağrı alabilmesi için panelin açık olması yeterlidir — her sayfada arka planda kayıtlı kalır. Sekme kapanınca kayıt düşer.',
                'The panel just needs to be open for the webphone to receive calls — it stays registered in the background on every page. Closing the tab drops the registration.',
              )}
            </Callout>

            <H2>{t(L, 'Sorun giderme', 'Troubleshooting')}</H2>
            <Ul>
              <li><B>{t(L, 'Hiç çalmıyor', 'Doesn\'t ring at all')}</B>: {t(L, 'sağ altta "Telefon hazır" yazdığından emin olun. "bağlanamadı" ise dahili/SIP şifresi ve WSS adresini kontrol edin. Bridge modunda temsilcinin cep numarası girili olmalı.', 'make sure the pill says "Phone ready". If it says "couldn\'t connect", check the extension/SIP password and WSS URL. In bridge mode the rep\'s mobile must be set.')}</li>
              <li><B>{t(L, 'Çalıyor ama ses yok', 'Rings but no audio')}</B>: {t(L, 'mikrofon iznini verdiğinizden emin olun. Bazı kurumsal ağlarda (simetrik NAT) ses için TURN sunucusu gerekebilir — yöneticinizle iletişime geçin.', 'make sure you granted microphone permission. On some corporate networks (symmetric NAT) audio may need a TURN server — contact your administrator.')}</li>
              <li><B>{t(L, 'Çağrı durumu otomatik dolmuyor', 'Call result not auto-filled')}</B>: {t(L, 'çağrı sonucu (cevaplandı/cevapsız) NetGSM Çağrı Detay (CDR) entegrasyonu aktifse otomatik dolar; değilse temsilci elle seçer.', 'the call result (answered/no-answer) auto-fills when the NetGSM Call Detail (CDR) integration is active; otherwise the rep selects it manually.')}</li>
            </Ul>
          </>
        ),
      },
      {
        slug: 'facebook-instagram',
        title: { tr: 'Facebook & Instagram', en: 'Facebook & Instagram' },
        body: (L) => (
          <>
            <P>
              {t(
                L,
                'Facebook sayfanızı ve Instagram işletme hesabınızı tek tıkla bağlayıp gönderi paylaşabilir ve DM\'leri panelden yönetebilirsiniz.',
                'Connect your Facebook Page and Instagram Business account in one click to publish posts and manage DMs from the panel.',
              )}
            </P>
            <H2>{t(L, 'Bağlama', 'Connecting')}</H2>
            <Steps>
              <li><Code>{t(L, 'Pazarlama → Sosyal Medya → Hesaplar', 'Marketing → Social → Accounts')}</Code></li>
              <li>{t(L, '"Connect Facebook" (veya Instagram) butonuna basın.', 'Click "Connect Facebook" (or Instagram).')}</li>
              <li>{t(L, 'Açılan Facebook penceresinde giriş yapıp izinleri onaylayın, bağlamak istediğiniz Sayfa/Instagram hesabını seçin.', 'In the Facebook popup, sign in, approve the permissions, and pick the Page/Instagram account to connect.')}</li>
              <li>{t(L, 'Hesap "Bağlı" olarak listelenir; artık gönderi paylaşımı ve DM kullanılabilir.', 'The account shows as "Connected"; publishing and DMs are now available.')}</li>
            </Steps>
            <Callout tone="info">
              {t(
                L,
                'Instagram\'ı bağlamak için bir Instagram İşletme/Profesyonel hesabı ve onun bir Facebook Sayfasına bağlı olması gerekir.',
                'To connect Instagram you need an Instagram Business/Professional account linked to a Facebook Page.',
              )}
            </Callout>
            <Callout tone="warn">
              {t(
                L,
                'Yeni bir SaaS müşterisi olarak tek yapmanız gereken "Connect Facebook" akışıdır — Meta uygulama kurulumu, webhook vb. platform tarafında bir kez yapılır, sizin tekrar yapmanıza gerek yoktur.',
                'As a new SaaS customer all you do is the "Connect Facebook" flow — the Meta app setup, webhooks, etc. are done once on the platform side; you don\'t repeat them.',
              )}
            </Callout>
          </>
        ),
      },
      {
        slug: 'whatsapp',
        title: { tr: 'WhatsApp', en: 'WhatsApp' },
        body: (L) => (
          <>
            <P>
              {t(
                L,
                'WhatsApp numaranızı tek tıkla bağlayıp gelen/giden mesajları Gelen Kutusu\'ndan yönetebilirsiniz.',
                'Connect your WhatsApp number in one click and manage inbound/outbound messages from the Inbox.',
              )}
            </P>
            <H2>{t(L, 'Bağlama', 'Connecting')}</H2>
            <Steps>
              <li><Code>{t(L, 'Mesajlar → Kanallar', 'Conversations → Channels')}</Code></li>
              <li>{t(L, '"Connect WhatsApp" butonuna basın (Meta\'nın gömülü kayıt akışı açılır).', 'Click "Connect WhatsApp" (Meta\'s embedded signup opens).')}</li>
              <li>{t(L, 'İşletme hesabınızı ve WhatsApp numaranızı seçin/oluşturun, doğrulamayı tamamlayın.', 'Pick/create your business account and WhatsApp number, then complete verification.')}</li>
              <li>{t(L, 'Akış bitince WhatsApp kanalı otomatik oluşturulur; mesajlaşma hazırdır.', 'When done, the WhatsApp channel is created automatically; messaging is ready.')}</li>
            </Steps>
            <Callout tone="info">
              {t(
                L,
                'Numaranızın başka bir WhatsApp Business uygulamasında aktif olmaması gerekir.',
                'Your number must not be active in another WhatsApp Business app.',
              )}
            </Callout>
          </>
        ),
      },
      {
        slug: 'ads',
        title: { tr: 'Meta Reklamları', en: 'Meta Ads' },
        body: (L) => (
          <>
            <P>
              {t(
                L,
                'Meta reklam hesabınızı bağlayıp harcama/dönüşüm raporlarını görebilir, kampanyaları yönetebilir ve otomatik ölçekleme kuralları kurabilirsiniz.',
                'Connect your Meta ad account to see spend/conversion reports, manage campaigns, and set up automated scaling rules.',
              )}
            </P>
            <H2>{t(L, 'Bağlama', 'Connecting')}</H2>
            <Steps>
              <li><Code>{t(L, 'Raporlama → Reklamlar', 'Reporting → Ads')}</Code></li>
              <li>{t(L, 'Reklam hesabını bağlayın (Facebook bağlantısı sırasında reklam hesabı da seçilebilir).', 'Connect the ad account (the ad account can also be picked during the Facebook connect).')}</li>
              <li>{t(L, '"Report" sekmesinde harcama/tıklama/lead; "Manage" sekmesinde kampanya yönetimi görünür.', 'The "Report" tab shows spend/clicks/leads; the "Manage" tab shows campaign management.')}</li>
            </Steps>
            <H2>{t(L, 'Otomatik ölçekleme kuralları', 'Automated scaling rules')}</H2>
            <P>
              {t(
                L,
                'Manage sekmesinden "KOŞUL → AKSİYON" kuralları kurabilirsiniz: ör. "CPL > 50₺ ise kampanyayı duraklat" veya "ROAS 3 günde > 2 ise bütçeyi %20 artır". Saatlik çalışır ve her işlemi loglar.',
                'In the Manage tab you can set "WHEN → THEN" rules: e.g. "if CPL > 50 pause the campaign" or "if ROAS > 2 over 3 days raise budget by 20%". It runs hourly and logs every action.',
              )}
            </P>
            <Callout tone="warn">
              {t(
                L,
                'Bütçe aksiyonları kampanya-bazlı bütçe (CBO) kullanan kampanyalarda çalışır.',
                'Budget actions work on campaigns using campaign-level budget (CBO).',
              )}
            </Callout>
          </>
        ),
      },
      {
        slug: 'sms',
        title: { tr: 'SMS (NetGSM)', en: 'SMS (NetGSM)' },
        body: (L) => (
          <>
            <P>
              {t(
                L,
                'NetGSM ile birebir ve toplu SMS gönderebilirsiniz. Onaylı bir gönderici adı (başlık) gerekir.',
                'Send 1:1 and bulk SMS via NetGSM. An approved sender name (header) is required.',
              )}
            </P>
            <H2>{t(L, 'Bağlama', 'Connecting')}</H2>
            <Steps>
              <li><Code>{t(L, 'Mesajlar → Kanallar → SMS ekle', 'Conversations → Channels → Add SMS')}</Code></li>
              <li>{t(L, 'NetGSM API kullanıcı kodu (usercode) ve API şifresini, onaylı gönderici adınızı (msgheader) girin.', 'Enter your NetGSM API usercode and API password, plus your approved sender name (msgheader).')}</li>
              <li>{t(L, 'Kaydedin; teslim raporları otomatik takip edilir.', 'Save; delivery reports are tracked automatically.')}</li>
            </Steps>
            <Callout tone="info">
              {t(
                L,
                'API şifresi, panel giriş şifrenizden farklı olabilir (API alt kullanıcısı). NetGSM panelinden "API İşlemleri" altından yönetilir.',
                'The API password can differ from your panel login password (an API sub-user). Manage it under "API İşlemleri" in the NetGSM panel.',
              )}
            </Callout>
          </>
        ),
      },
    ],
  },
  {
    id: 'usage',
    title: { tr: 'Kullanım', en: 'Usage' },
    pages: [
      {
        slug: 'social-posting',
        title: { tr: 'Sosyal Gönderi (Reels/Story)', en: 'Social Posting (Reels/Story)' },
        body: (L) => (
          <>
            <P>
              {t(
                L,
                'Tek bir gönderiyi birden çok hesaba aynı anda paylaşabilir; her hesap için format seçebilirsiniz.',
                'Publish one post to multiple accounts at once; pick a format per account.',
              )}
            </P>
            <H2>{t(L, 'Gönderi oluşturma', 'Creating a post')}</H2>
            <Steps>
              <li><Code>{t(L, 'Pazarlama → Sosyal Medya → Yeni gönderi', 'Marketing → Social → New post')}</Code></li>
              <li>{t(L, 'İçeriği yazın; medyayı yükleyin (veya herkese açık bir URL yapıştırın).', 'Write the content; upload media (or paste a public URL).')}</li>
              <li>{t(L, 'Paylaşılacak hesapları seçin; her Facebook/Instagram hesabı için format seçin: ', 'Pick the target accounts; choose a format for each Facebook/Instagram account: ')}<B>Feed / Reel / Story</B>.</li>
              <li>{t(L, 'Hemen paylaşın veya ileri bir tarihe planlayın.', 'Publish now or schedule for later.')}</li>
            </Steps>
            <Callout tone="info">
              {t(
                L,
                'Reels ve Story için video gerekir (Story görsel de kabul eder). Instagram için en az bir medya zorunludur.',
                'Reels and Stories need a video (Stories also accept an image). Instagram requires at least one media item.',
              )}
            </Callout>
          </>
        ),
      },
    ],
  },
];

// Flat lookup helpers used by the page + router.
export const ALL_PAGES = HELP_SECTIONS.flatMap((s) => s.pages);
export const FIRST_SLUG = ALL_PAGES[0]?.slug ?? 'overview';
export function findPage(slug?: string): DocPage | undefined {
  return ALL_PAGES.find((p) => p.slug === slug);
}
