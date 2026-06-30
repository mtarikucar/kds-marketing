import { LEGAL, type LegalContent } from '../legalShared';

/**
 * Privacy Policy / KVKK aydınlatma metni for Jeeta. Substantive template content
 * tailored to a Turkish marketing/CRM SaaS (KVKK + GDPR aware). The operator
 * should have counsel review before relying on it for compliance.
 */
const privacyContent: LegalContent = {
  tr: {
    title: 'Gizlilik Politikası',
    subtitle: `${LEGAL.brand} olarak kişisel verilerinizi nasıl işlediğimizi ve KVKK kapsamındaki haklarınızı açıklar.`,
    lastUpdatedLabel: 'Son güncelleme',
    effectiveDate: LEGAL.effectiveDateTr,
    tocLabel: 'İçindekiler',
    intro: [
      `Bu Gizlilik Politikası, ${LEGAL.brand} ("biz", "Platform") tarafından sunulan pazarlama ve müşteri ilişkileri yönetimi (CRM) hizmetlerini kullanırken kişisel verilerinizin nasıl toplandığını, işlendiğini, saklandığını ve korunduğunu açıklamaktadır.`,
      `Verileriniz 6698 sayılı Kişisel Verilerin Korunması Kanunu (KVKK) ve uygulanabilir olduğu ölçüde Avrupa Birliği Genel Veri Koruma Tüzüğü (GDPR) çerçevesinde işlenir.`,
    ],
    sections: [
      {
        id: 'veri-sorumlusu',
        heading: 'Veri Sorumlusu',
        body: [
          `KVKK kapsamında veri sorumlusu ${LEGAL.entity}'dır. Bu politika veya kişisel verilerinize ilişkin her türlü talebiniz için ${LEGAL.email} adresinden bize ulaşabilirsiniz.`,
          `Adres: ${LEGAL.city}, ${LEGAL.countryTr}.`,
        ],
      },
      {
        id: 'rollerimiz',
        heading: 'İki Yönlü Rolümüz: Veri Sorumlusu ve Veri İşleyen',
        body: [
          `Hesap sahiplerinin (müşterilerimizin) ve onların çalışanlarının kişisel verileri bakımından veri sorumlusu sıfatıyla hareket ederiz.`,
          `Müşterilerimizin Platform'a yüklediği veya Platform üzerinde topladığı kendi son müşterilerine/lead'lerine ait veriler bakımından ise yalnızca veri işleyen sıfatıyla, ilgili müşterinin talimatları doğrultusunda hareket ederiz. Bu verilerin işlenme amaç ve vasıtalarını ilgili müşteri belirler.`,
        ],
      },
      {
        id: 'islenen-veriler',
        heading: 'İşlediğimiz Kişisel Veriler',
        body: ['Hizmetlerimizi sunmak için aşağıdaki veri kategorilerini işleyebiliriz:'],
        items: [
          'Kimlik ve iletişim verileri: ad, soyad, e-posta, telefon numarası, çalışma alanı/şirket bilgisi.',
          'Hesap ve kimlik doğrulama verileri: şifre (özet/hash olarak), oturum bilgileri, iki adımlı doğrulama (2FA) verileri.',
          'Kullanım ve işlem verileri: oturum açma kayıtları, IP adresi, cihaz/tarayıcı bilgisi, Platform içi etkinlikler.',
          'Ödeme verileri: fatura bilgileri ve ödeme sağlayıcımız aracılığıyla işlenen işlem kayıtları (kart bilgileri tarafımızca saklanmaz).',
          'İletişim/kanal verileri: bağladığınız kanallar (WhatsApp, e-posta, sosyal medya) üzerinden ilettiğiniz mesaj ve içerikler.',
          'Çerez ve benzeri teknolojilerle toplanan veriler.',
        ],
      },
      {
        id: 'amaclar',
        heading: 'Kişisel Verilerin İşlenme Amaçları',
        items: [
          'Hizmetin sunulması, hesabınızın oluşturulması ve yönetilmesi.',
          'Abonelik, faturalandırma ve ödeme süreçlerinin yürütülmesi.',
          'Güvenliğin sağlanması, dolandırıcılığın ve kötüye kullanımın önlenmesi.',
          'Destek taleplerinin karşılanması ve sizinle iletişim kurulması.',
          'Hizmetin iyileştirilmesi, analiz ve performans ölçümü.',
          'Hukuki yükümlülüklerin yerine getirilmesi.',
        ],
      },
      {
        id: 'hukuki-sebep',
        heading: 'İşlemenin Hukuki Sebepleri',
        body: [
          'Kişisel verileriniz; bir sözleşmenin kurulması veya ifası için gerekli olması (KVKK m.5/2-c), hukuki yükümlülüğümüzün yerine getirilmesi (m.5/2-ç), meşru menfaatlerimiz (m.5/2-f) ve gerektiğinde açık rızanız (m.5/1) hukuki sebeplerine dayanılarak işlenir. GDPR kapsamında işlemeler Madde 6 uyarınca sözleşme, hukuki yükümlülük, meşru menfaat veya rıza temelinde gerçekleştirilir.',
        ],
      },
      {
        id: 'aktarim',
        heading: 'Kişisel Verilerin Aktarılması',
        body: [
          'Kişisel verileriniz; hizmetin sunulması amacıyla sınırlı olarak, gerekli teknik ve idari tedbirler alınarak aşağıdaki taraflarla paylaşılabilir:',
        ],
        items: [
          'Barındırma (hosting) ve altyapı hizmet sağlayıcıları.',
          'Ödeme hizmeti sağlayıcıları (örn. ödeme kuruluşları).',
          'Mesajlaşma ve iletişim sağlayıcıları (örn. SMS/telefon ve sosyal medya platformları).',
          'Yetkili kamu kurum ve kuruluşları ile yargı mercileri (hukuki yükümlülük halinde).',
        ],
      },
      {
        id: 'yurtdisi',
        heading: 'Yurt Dışına Aktarım',
        body: [
          'Bazı hizmet sağlayıcılarımızın sunucuları yurt dışında bulunabilir. Bu durumda aktarım, KVKK m.9 kapsamındaki şartlara (yeterli korumanın bulunması veya gerekli taahhütlerin alınması) ve gerektiğinde açık rızanıza uygun olarak gerçekleştirilir.',
        ],
      },
      {
        id: 'saklama',
        heading: 'Saklama Süreleri',
        body: [
          'Kişisel verilerinizi, işleme amacının gerektirdiği süre boyunca ve ilgili mevzuatta öngörülen yasal saklama süreleri kadar muhafaza ederiz. Süre sonunda verileriniz silinir, yok edilir veya anonim hale getirilir. Hesabınızı kapattığınızda, yasal yükümlülükler saklı kalmak kaydıyla verileriniz makul bir süre içinde silinir.',
        ],
      },
      {
        id: 'cerezler',
        heading: 'Çerezler',
        body: [
          'Platform, oturumunuzu sürdürmek, tercihlerinizi hatırlamak ve kullanımı analiz etmek için zorunlu ve isteğe bağlı çerezler kullanır. Tarayıcı ayarlarınızdan çerezleri yönetebilir veya engelleyebilirsiniz; ancak zorunlu çerezlerin devre dışı bırakılması bazı işlevleri etkileyebilir.',
        ],
      },
      {
        id: 'haklariniz',
        heading: 'KVKK Kapsamındaki Haklarınız',
        body: ['KVKK m.11 uyarınca aşağıdaki haklara sahipsiniz:'],
        items: [
          'Kişisel verinizin işlenip işlenmediğini öğrenme ve buna ilişkin bilgi talep etme.',
          'İşlenme amacını ve amacına uygun kullanılıp kullanılmadığını öğrenme.',
          'Verilerin aktarıldığı üçüncü kişileri bilme.',
          'Eksik veya yanlış işlenmişse düzeltilmesini, şartlar oluştuğunda silinmesini/yok edilmesini isteme.',
          'İşlemenin münhasıran otomatik sistemlerle analizi sonucu aleyhinize bir sonuç çıkmasına itiraz etme.',
          'Kanuna aykırı işleme nedeniyle zarara uğramanız halinde zararın giderilmesini talep etme.',
        ],
      },
      {
        id: 'guvenlik',
        heading: 'Veri Güvenliği',
        body: [
          'Kişisel verilerinizi korumak için aktarımda ve saklamada şifreleme, rol bazlı erişim kontrolü, iki adımlı doğrulama (2FA), çalışma alanı izolasyonu ve düzenli güvenlik gözden geçirmeleri dâhil olmak üzere makul teknik ve idari tedbirleri uygularız.',
        ],
      },
      {
        id: 'degisiklikler',
        heading: 'Politikadaki Değişiklikler',
        body: [
          'Bu Gizlilik Politikasını zaman zaman güncelleyebiliriz. Önemli değişikliklerde sizi Platform üzerinden veya e-posta ile bilgilendiririz. Güncel sürüm her zaman bu sayfada yayınlanır.',
        ],
      },
      {
        id: 'iletisim',
        heading: 'İletişim',
        body: [
          `Sorularınız ve KVKK kapsamındaki başvurularınız için ${LEGAL.email} adresine yazabilirsiniz. Başvurularınız mevzuatta öngörülen sürede sonuçlandırılır.`,
        ],
      },
    ],
  },
  en: {
    title: 'Privacy Policy',
    subtitle: `How ${LEGAL.brand} collects, uses and protects your personal data, and your rights under KVKK and GDPR.`,
    lastUpdatedLabel: 'Last updated',
    effectiveDate: LEGAL.effectiveDateEn,
    tocLabel: 'Contents',
    intro: [
      `This Privacy Policy explains how ${LEGAL.brand} ("we", "the Platform") collects, processes, stores and protects your personal data when you use our marketing and customer relationship management (CRM) services.`,
      `Your data is processed in accordance with the Turkish Personal Data Protection Law No. 6698 (KVKK) and, where applicable, the EU General Data Protection Regulation (GDPR).`,
    ],
    sections: [
      {
        id: 'controller',
        heading: 'Data Controller',
        body: [
          `The data controller under KVKK is ${LEGAL.entity}. For any request regarding this policy or your personal data, contact us at ${LEGAL.email}.`,
          `Address: ${LEGAL.city}, ${LEGAL.countryEn}.`,
        ],
      },
      {
        id: 'our-roles',
        heading: 'Our Dual Role: Controller and Processor',
        body: [
          `We act as a data controller in respect of the personal data of account holders (our customers) and their staff.`,
          `In respect of data about our customers' own end-customers/leads that they upload to or collect on the Platform, we act solely as a data processor, on the instructions of the relevant customer, who determines the purposes and means of that processing.`,
        ],
      },
      {
        id: 'data-we-process',
        heading: 'Personal Data We Process',
        body: ['To provide our services, we may process the following categories of data:'],
        items: [
          'Identity and contact data: name, surname, email, phone number, workspace/company details.',
          'Account and authentication data: password (stored as a hash), session information, two-factor authentication (2FA) data.',
          'Usage and transaction data: login records, IP address, device/browser information, in-Platform activity.',
          'Payment data: billing details and transaction records processed via our payment provider (card details are not stored by us).',
          'Communication/channel data: messages and content you send through connected channels (WhatsApp, email, social media).',
          'Data collected via cookies and similar technologies.',
        ],
      },
      {
        id: 'purposes',
        heading: 'Purposes of Processing',
        items: [
          'Providing the service and creating and managing your account.',
          'Operating subscription, billing and payment processes.',
          'Ensuring security and preventing fraud and abuse.',
          'Handling support requests and communicating with you.',
          'Improving the service, analytics and performance measurement.',
          'Complying with legal obligations.',
        ],
      },
      {
        id: 'legal-basis',
        heading: 'Legal Bases for Processing',
        body: [
          'Your personal data is processed on the legal bases of necessity for the conclusion or performance of a contract, compliance with a legal obligation, our legitimate interests, and where required your explicit consent (KVKK Art. 5). Under GDPR, processing is carried out pursuant to Article 6 on the basis of contract, legal obligation, legitimate interest or consent.',
        ],
      },
      {
        id: 'sharing',
        heading: 'Sharing of Personal Data',
        body: ['Your data may be shared, limited to providing the service and with appropriate safeguards, with:'],
        items: [
          'Hosting and infrastructure service providers.',
          'Payment service providers (e.g. payment institutions).',
          'Messaging and communication providers (e.g. SMS/telephony and social media platforms).',
          'Competent public authorities and judicial bodies (where legally required).',
        ],
      },
      {
        id: 'international',
        heading: 'International Transfers',
        body: [
          "Some of our service providers' servers may be located abroad. In such cases, transfers are carried out in line with the conditions under KVKK Art. 9 (adequate protection or required undertakings) and, where necessary, your explicit consent.",
        ],
      },
      {
        id: 'retention',
        heading: 'Retention Periods',
        body: [
          'We retain your personal data for as long as the purpose of processing requires and for the legal retention periods set out in applicable legislation. At the end of these periods, your data is deleted, destroyed or anonymized. When you close your account, your data is deleted within a reasonable period, subject to legal obligations.',
        ],
      },
      {
        id: 'cookies',
        heading: 'Cookies',
        body: [
          'The Platform uses strictly necessary and optional cookies to keep you signed in, remember your preferences and analyze usage. You can manage or block cookies via your browser settings; disabling strictly necessary cookies may affect some functionality.',
        ],
      },
      {
        id: 'your-rights',
        heading: 'Your Rights',
        body: ['Under KVKK Art. 11 (and equivalent GDPR rights) you have the right to:'],
        items: [
          'Learn whether your personal data is processed and request information about it.',
          'Learn the purpose of processing and whether data is used accordingly.',
          'Know the third parties to whom data is transferred.',
          'Request correction of incomplete/incorrect data and, where conditions are met, its deletion/destruction.',
          'Object to a result against you arising solely from automated analysis.',
          'Request compensation for damages arising from unlawful processing.',
        ],
      },
      {
        id: 'security',
        heading: 'Data Security',
        body: [
          'We apply reasonable technical and organizational measures to protect your data, including encryption in transit and at rest, role-based access control, two-factor authentication (2FA), workspace isolation and regular security reviews.',
        ],
      },
      {
        id: 'changes',
        heading: 'Changes to This Policy',
        body: [
          'We may update this Privacy Policy from time to time. For material changes we will notify you via the Platform or by email. The current version is always published on this page.',
        ],
      },
      {
        id: 'contact',
        heading: 'Contact',
        body: [
          `For questions and KVKK/GDPR requests, write to ${LEGAL.email}. We respond to requests within the period prescribed by law.`,
        ],
      },
    ],
  },
};

export default privacyContent;
