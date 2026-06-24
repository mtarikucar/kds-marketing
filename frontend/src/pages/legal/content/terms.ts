import { LEGAL, type LegalContent } from '../legalShared';

/**
 * Terms of Service for Jeeta. Substantive template content for a Turkish
 * marketing/CRM SaaS. The operator should have counsel review before relying on
 * it. Governing law: Türkiye; courts of {LEGAL.jurisdiction}.
 */
const termsContent: LegalContent = {
  tr: {
    title: 'Kullanım Şartları',
    subtitle: `${LEGAL.brand} hizmetlerini kullanımınıza ilişkin koşulları belirler.`,
    lastUpdatedLabel: 'Son güncelleme',
    effectiveDate: LEGAL.effectiveDateTr,
    tocLabel: 'İçindekiler',
    intro: [
      `Bu Kullanım Şartları ("Şartlar"), ${LEGAL.brand} ("biz", "Platform") tarafından sunulan pazarlama ve CRM hizmetlerinden ("Hizmet") yararlanmanızı düzenler.`,
      `Hizmeti kullanarak bu Şartları kabul etmiş sayılırsınız. Şartları kabul etmiyorsanız Hizmeti kullanmamalısınız.`,
    ],
    sections: [
      {
        id: 'kabul',
        heading: 'Şartların Kabulü',
        body: [
          'Hizmete kaydolarak veya Hizmeti kullanarak bu Şartları ve Gizlilik Politikamızı okuduğunuzu, anladığınızı ve bunlarla bağlı olmayı kabul ettiğinizi beyan edersiniz. Bir kuruluş adına hareket ediyorsanız, o kuruluşu bağlama yetkisine sahip olduğunuzu kabul edersiniz.',
        ],
      },
      {
        id: 'hesap',
        heading: 'Hesap ve Kayıt',
        body: [
          'Hizmeti kullanmak için doğru ve güncel bilgilerle bir çalışma alanı (hesap) oluşturmanız gerekir. Hesap kimlik bilgilerinizin gizliliğinden ve hesabınız altında gerçekleşen tüm faaliyetlerden siz sorumlusunuz. Yetkisiz bir kullanım fark ederseniz bizi derhal bilgilendirmelisiniz.',
        ],
      },
      {
        id: 'hizmet',
        heading: 'Hizmetin Kapsamı',
        body: [
          'Platform; CRM, omnichannel gelen kutusu, kampanya, otomasyon, funnel, sosyal medya planlama, ses/telefon, faturalandırma ve analitik gibi modülleri içeren bulut tabanlı bir pazarlama ve müşteri yönetimi çözümüdür. Hizmetin özelliklerini zaman zaman geliştirebilir, değiştirebilir veya kullanımdan kaldırabiliriz.',
        ],
      },
      {
        id: 'abonelik',
        heading: 'Abonelik, Ücretler ve Ödeme',
        items: [
          'Ücretli planlar, seçtiğiniz abonelik dönemine göre (aylık/yıllık) peşin olarak faturalandırılır.',
          'Ödemeler, anlaşmalı ödeme hizmeti sağlayıcımız üzerinden güvenli şekilde tahsil edilir.',
          'Aksi belirtilmedikçe abonelikler dönem sonunda otomatik olarak yenilenir; yenilemeyi hesap ayarlarınızdan kapatabilirsiniz.',
          'Yürürlükteki mevzuatın gerektirdiği haller saklı kalmak kaydıyla, ödenen ücretler iade edilmez.',
          'Ücretleri önceden bildirimde bulunarak değiştirebiliriz; değişiklikler bir sonraki yenileme döneminde geçerli olur.',
        ],
      },
      {
        id: 'kullanim',
        heading: 'Kabul Edilebilir Kullanım',
        body: ['Hizmeti kullanırken aşağıdakileri yapmamayı kabul edersiniz:'],
        items: [
          'Yürürlükteki mevzuata, üçüncü kişi haklarına veya bu Şartlara aykırı davranmak.',
          'İzinsiz (spam) ileti göndermek; ilgili kişilerin onayı olmadan ticari elektronik ileti yollamak.',
          'Kötü amaçlı yazılım yaymak, Hizmetin güvenliğini veya bütünlüğünü tehlikeye atmak.',
          'Hizmete yetkisiz erişim sağlamaya çalışmak veya başkalarının kullanımını engellemek.',
          'Hizmeti tersine mühendislik yapmak veya izinsiz olarak çoğaltmak.',
        ],
      },
      {
        id: 'musteri-verisi',
        heading: 'Müşteri Verileri ve Gizlilik',
        body: [
          'Platform’a yüklediğiniz veya Platform üzerinde işlediğiniz içerik ve verilere ("Müşteri Verileri") ilişkin tüm hak ve sorumluluklar size aittir. Bu veriler bakımından biz yalnızca veri işleyen olarak hareket ederiz ve verileri yalnızca Hizmeti sunmak amacıyla işleriz. Kişisel verilerin işlenmesine ilişkin ayrıntılar Gizlilik Politikamızda yer alır. Müşteri Verilerini işlemek için gerekli tüm izin ve hukuki dayanaklara sahip olmak sizin sorumluluğunuzdadır.',
        ],
      },
      {
        id: 'fikri-mulkiyet',
        heading: 'Fikri Mülkiyet',
        body: [
          'Platform’a, yazılımına, markalarına ve tüm içeriğine ilişkin fikri mülkiyet hakları bize veya lisans verenlerimize aittir. Size yalnızca Hizmeti bu Şartlara uygun olarak kullanmanız için sınırlı, münhasır olmayan ve devredilemez bir kullanım hakkı tanınır. Müşteri Verileriniz üzerindeki haklar sizde kalır.',
        ],
      },
      {
        id: 'ucuncu-taraf',
        heading: 'Üçüncü Taraf Entegrasyonları',
        body: [
          'Hizmet, WhatsApp, Meta (Facebook/Instagram), LinkedIn, TikTok, SMS/telefon ve ödeme sağlayıcıları gibi üçüncü taraf hizmetlerle entegrasyon sunabilir. Bu hizmetlerin kullanımı ilgili sağlayıcının kendi şart ve politikalarına tabidir; üçüncü taraf hizmetlerinin sürekliliğinden veya değişikliklerinden sorumlu değiliz.',
        ],
      },
      {
        id: 'kullanilabilirlik',
        heading: 'Hizmet Sürekliliği',
        body: [
          'Hizmeti makul ölçüde kesintisiz sunmaya çalışırız; ancak bakım, güncelleme, üçüncü taraf kaynaklı sorunlar veya mücbir sebepler nedeniyle geçici kesintiler yaşanabilir. Hizmet "olduğu gibi" sunulmakta olup kesintisiz veya hatasız olacağına dair bir garanti verilmemektedir.',
        ],
      },
      {
        id: 'sorumluluk',
        heading: 'Sorumluluğun Sınırlandırılması',
        body: [
          'Yürürlükteki mevzuatın izin verdiği azami ölçüde; dolaylı, arızi, özel veya netice kabilinden zararlardan (kâr kaybı, veri kaybı, iş kaybı dâhil) sorumlu değiliz. Her hâlükârda, doğrudan zararlara ilişkin toplam sorumluluğumuz, talebin doğduğu tarihten önceki on iki (12) ay içinde Hizmet için bize ödediğiniz tutarla sınırlıdır.',
        ],
      },
      {
        id: 'garanti-reddi',
        heading: 'Garanti Reddi',
        body: [
          'Hizmet, açık veya zımni hiçbir garanti verilmeksizin "mevcut hâliyle" ve "mevcut olduğu ölçüde" sunulur. Belirli bir amaca uygunluk, ticarete elverişlilik ve ihlal etmeme dâhil zımni garantileri, mevzuatın izin verdiği ölçüde reddederiz.',
        ],
      },
      {
        id: 'fesih',
        heading: 'Askıya Alma ve Fesih',
        body: [
          'Bu Şartları ihlal etmeniz hâlinde hesabınızı askıya alabilir veya feshedebiliriz. Aboneliğinizi dilediğiniz zaman iptal edebilirsiniz; iptal, mevcut faturalandırma döneminin sonunda geçerli olur. Fesih hâlinde, yasal yükümlülükler saklı kalmak kaydıyla, Müşteri Verilerinizi makul bir süre içinde dışa aktarma imkânı sunabilir ve ardından sileriz.',
        ],
      },
      {
        id: 'degisiklikler',
        heading: 'Şartlardaki Değişiklikler',
        body: [
          'Bu Şartları zaman zaman güncelleyebiliriz. Önemli değişiklikleri Platform üzerinden veya e-posta ile bildiririz. Değişikliklerin yürürlüğe girmesinden sonra Hizmeti kullanmaya devam etmeniz güncel Şartları kabul ettiğiniz anlamına gelir.',
        ],
      },
      {
        id: 'hukuk',
        heading: 'Uygulanacak Hukuk ve Yetki',
        body: [
          `Bu Şartlar Türkiye Cumhuriyeti hukukuna tabidir. Bu Şartlardan doğan uyuşmazlıklarda ${LEGAL.jurisdiction} Mahkemeleri ve İcra Daireleri yetkilidir. Tüketici sıfatını haiz kullanıcıların ilgili tüketici mevzuatından doğan hakları saklıdır.`,
        ],
      },
      {
        id: 'iletisim',
        heading: 'İletişim',
        body: [`Bu Şartlara ilişkin sorularınız için ${LEGAL.email} adresine yazabilirsiniz.`],
      },
    ],
  },
  en: {
    title: 'Terms of Service',
    subtitle: `The terms that govern your use of ${LEGAL.brand}'s services.`,
    lastUpdatedLabel: 'Last updated',
    effectiveDate: LEGAL.effectiveDateEn,
    tocLabel: 'Contents',
    intro: [
      `These Terms of Service ("Terms") govern your use of the marketing and CRM services ("Service") provided by ${LEGAL.brand} ("we", "the Platform").`,
      `By using the Service you agree to these Terms. If you do not accept them, you must not use the Service.`,
    ],
    sections: [
      {
        id: 'acceptance',
        heading: 'Acceptance of the Terms',
        body: [
          'By registering for or using the Service, you confirm that you have read, understood and agree to be bound by these Terms and our Privacy Policy. If you act on behalf of an organization, you confirm that you are authorized to bind that organization.',
        ],
      },
      {
        id: 'account',
        heading: 'Account and Registration',
        body: [
          'To use the Service you must create a workspace (account) with accurate and current information. You are responsible for keeping your credentials confidential and for all activity under your account. You must notify us promptly if you become aware of any unauthorized use.',
        ],
      },
      {
        id: 'service',
        heading: 'The Service',
        body: [
          'The Platform is a cloud-based marketing and customer management solution including modules such as CRM, omnichannel inbox, campaigns, automation, funnels, social media planning, voice/telephony, billing and analytics. We may improve, modify or discontinue features from time to time.',
        ],
      },
      {
        id: 'billing',
        heading: 'Subscription, Fees and Payment',
        items: [
          'Paid plans are billed in advance according to your chosen subscription period (monthly/annual).',
          'Payments are collected securely through our contracted payment service provider.',
          'Unless stated otherwise, subscriptions renew automatically at the end of each period; you can turn off renewal in your account settings.',
          'Except where required by applicable law, fees paid are non-refundable.',
          'We may change fees with prior notice; changes take effect at the next renewal period.',
        ],
      },
      {
        id: 'acceptable-use',
        heading: 'Acceptable Use',
        body: ['When using the Service, you agree not to:'],
        items: [
          'Violate applicable law, third-party rights or these Terms.',
          'Send unsolicited messages (spam) or commercial electronic messages without the recipients’ consent.',
          'Distribute malware or jeopardize the security or integrity of the Service.',
          'Attempt to gain unauthorized access to the Service or disrupt others’ use of it.',
          'Reverse engineer or reproduce the Service without authorization.',
        ],
      },
      {
        id: 'customer-data',
        heading: 'Customer Data and Privacy',
        body: [
          'You retain all rights to and responsibility for the content and data you upload to or process on the Platform ("Customer Data"). In respect of such data we act solely as a data processor and process it only to provide the Service. Details of personal data processing are set out in our Privacy Policy. You are responsible for having all consents and legal bases necessary to process Customer Data.',
        ],
      },
      {
        id: 'ip',
        heading: 'Intellectual Property',
        body: [
          'All intellectual property rights in the Platform, its software, trademarks and content belong to us or our licensors. You are granted only a limited, non-exclusive, non-transferable right to use the Service in accordance with these Terms. You retain rights to your Customer Data.',
        ],
      },
      {
        id: 'third-party',
        heading: 'Third-Party Integrations',
        body: [
          'The Service may offer integrations with third-party services such as WhatsApp, Meta (Facebook/Instagram), LinkedIn, TikTok, SMS/telephony and payment providers. Use of these services is subject to the respective provider’s own terms and policies; we are not responsible for the continuity or changes of third-party services.',
        ],
      },
      {
        id: 'availability',
        heading: 'Service Availability',
        body: [
          'We aim to provide the Service with reasonable continuity; however, temporary interruptions may occur due to maintenance, updates, third-party issues or force majeure. The Service is provided "as is" with no warranty that it will be uninterrupted or error-free.',
        ],
      },
      {
        id: 'liability',
        heading: 'Limitation of Liability',
        body: [
          'To the maximum extent permitted by applicable law, we are not liable for any indirect, incidental, special or consequential damages (including loss of profit, data or business). In any case, our total liability for direct damages is limited to the amount you paid us for the Service in the twelve (12) months preceding the event giving rise to the claim.',
        ],
      },
      {
        id: 'disclaimer',
        heading: 'Disclaimer of Warranties',
        body: [
          'The Service is provided "as is" and "as available" without warranties of any kind, whether express or implied. To the extent permitted by law, we disclaim implied warranties including fitness for a particular purpose, merchantability and non-infringement.',
        ],
      },
      {
        id: 'termination',
        heading: 'Suspension and Termination',
        body: [
          'We may suspend or terminate your account if you breach these Terms. You may cancel your subscription at any time; cancellation takes effect at the end of the current billing period. On termination, subject to legal obligations, we may offer you a reasonable period to export your Customer Data and then delete it.',
        ],
      },
      {
        id: 'changes',
        heading: 'Changes to the Terms',
        body: [
          'We may update these Terms from time to time. We will notify you of material changes via the Platform or by email. Continuing to use the Service after changes take effect means you accept the updated Terms.',
        ],
      },
      {
        id: 'law',
        heading: 'Governing Law and Jurisdiction',
        body: [
          `These Terms are governed by the laws of the Republic of Türkiye. The Courts and Enforcement Offices of ${LEGAL.jurisdiction} shall have jurisdiction over disputes arising from these Terms. Rights of users qualifying as consumers under applicable consumer legislation are reserved.`,
        ],
      },
      {
        id: 'contact',
        heading: 'Contact',
        body: [`For questions about these Terms, write to ${LEGAL.email}.`],
      },
    ],
  },
};

export default termsContent;
