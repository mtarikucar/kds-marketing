import { LEGAL, type LegalContent } from '../legalShared';

/**
 * Data deletion instructions — the public, linkable page every platform review
 * asks for.
 *
 * Meta accepts this URL as an alternative to the signed_request deletion
 * callback (both are implemented; this is the one a human can actually use),
 * and the TikTok, Pinterest and LinkedIn reviews each expect an equivalent.
 *
 * It is deliberately specific about what is DELETED versus what is legally
 * RETAINED. Turkish tax law mandates ~10-year retention of invoices, so a page
 * promising "everything is erased" would be a promise the product cannot keep —
 * and the erasure it describes (ComplianceService.fulfillErasure) really does
 * anonymise-in-place rather than hard-delete those rows.
 */
const dataDeletionContent: LegalContent = {
  tr: {
    title: 'Veri Silme Talebi',
    subtitle: `${LEGAL.brand} üzerinde tutulan kişisel verilerinizin silinmesini nasıl talep edeceğinizi açıklar.`,
    lastUpdatedLabel: 'Son güncelleme',
    effectiveDate: LEGAL.effectiveDateTr,
    tocLabel: 'İçindekiler',
    intro: [
      `Kişisel verilerinizin silinmesini talep etme hakkınız vardır (KVKK m.7 ve m.11; GDPR m.17). Bu sayfa, ${LEGAL.brand} üzerinde tutulan verileriniz için bu talebi nasıl ileteceğinizi, talebin nasıl işlendiğini ve hangi kayıtların yasal olarak saklanmak zorunda olduğunu açıklar.`,
      `Not: Platform'da iki farklı rolümüz vardır. Kendi hesap sahiplerimizin verileri bakımından veri sorumlusu, müşterilerimizin kendi son müşterilerine/lead'lerine ait verileri bakımından ise veri işleyen sıfatıyla hareket ederiz. Bir işletmenin sizinle ilgili tuttuğu veriler için talebinizi o işletmeye de iletebilirsiniz; bize ilettiğinizde talebi ilgili işletmeye yönlendirir ve gereğini yaparız.`,
    ],
    sections: [
      {
        id: 'how-to-request',
        heading: 'Talebi Nasıl İletirsiniz',
        body: [
          `En hızlı yol e-postadır. ${LEGAL.email} adresine "Veri Silme Talebi" konusuyla yazın ve sizi kayıtlarımızda bulmamızı sağlayacak bilgileri ekleyin: e-posta adresiniz, telefon numaranız veya bizimle hangi kanaldan (WhatsApp, Instagram, Messenger, web sohbeti) yazıştığınız.`,
          `Kimliğinizi doğrulayabilmek için ek bilgi isteyebiliriz. Bu, başkasının sizin adınıza verilerinizi sildirmesini önlemek içindir.`,
          `Talepleri mevzuatta öngörülen süre içinde (KVKK bakımından en geç 30 gün) sonuçlandırırız.`,
        ],
      },
      {
        id: 'in-app',
        heading: 'Hesap Sahibiyseniz',
        body: [
          `Platform'u kullanan bir işletmeyseniz, çalışma alanınızdaki bir kişiye ait silme talebini panelden başlatabilirsiniz: Ayarlar → Uyumluluk bölümünden ilgili kişi için silme talebi oluşturulur ve bir yönetici tarafından onaylanarak yürütülür. Her silme işlemi denetim kaydı bırakır.`,
        ],
      },
      {
        id: 'platform-requests',
        heading: 'Sosyal Medya Platformları Üzerinden Gelen Talepler',
        body: [
          `Facebook, Instagram veya bağlı diğer bir uygulama üzerinden uygulamamızın erişimini kaldırıp veri silme talebi oluşturduğunuzda, ilgili platform bize doğrudan imzalı bir silme talebi gönderir. Bu talebi imzasını doğruladıktan sonra işleriz ve size bir onay kodu döneriz.`,
          `Talebinizin durumunu bu onay koduyla şu adresten görebilirsiniz: ${'https://jeetagrowth.com/data-deletion-status'}?code=ONAY_KODU`,
          `Önemli bir sınır: bu platformlar bize uygulamaya özgü (app-scoped) bir kullanıcı kimliği gönderir; bu kimlik, sizinle mesajlaştığımız sayfaya özgü kimlikten (PSID) farklı bir numaralandırmadadır ve her zaman eşleşmez. Eşleşme bulunamadığında talebinizi "eşleşme bulunamadı" olarak kaydeder ve durum sayfasında bunu açıkça yazarız — bulamadığımız bir veri için "silindi" demeyiz. Böyle bir durumda yukarıdaki e-posta adresinden bize ulaşın; sizi kayıtlarımızda başka bir bilgiyle bulabiliriz.`,
        ],
      },
      {
        id: 'what-gets-deleted',
        heading: 'Neler Silinir',
        body: ['Talep onaylandığında aşağıdaki veriler kalıcı olarak silinir:'],
        items: [
          'Tüm yazışmalarınız ve mesaj içerikleriniz (WhatsApp, Instagram, Messenger, e-posta, SMS, web sohbeti).',
          'Kanal kimlikleriniz (telefon numarası, WhatsApp numarası, PSID/IGSID gibi platform kimlikleri).',
          'Çağrı kayıtları ve görüşme dökümleri.',
          'Etkinlik geçmişiniz, ilk temas/atıf kayıtları ve takip edilen bağlantı tıklamaları.',
          'Anket yanıtlarınız.',
          'Adınız, e-posta adresiniz, telefon numaranız, adresiniz ve notlar dâhil profil bilgileriniz anonimleştirilir; kayıt artık sizi tanımlamaz.',
          'Daha önce bir veri kopyası (erişim talebi) oluşturulmuşsa, o kopyanın içeriği de silinir.',
        ],
      },
      {
        id: 'what-is-kept',
        heading: 'Neler Saklanır ve Neden',
        body: [
          'Bazı kayıtları silemeyiz; bu bir tercih değil, yasal bir zorunluluktur. Vergi mevzuatı gereği fatura ve mali kayıtlar yaklaşık 10 yıl saklanır. Bu kayıtlar silinmez; ancak artık anonimleştirilmiş, sizi tanımlamayan bir kayda bağlanırlar.',
        ],
        items: [
          'Faturalar, teklifler ve ödeme/mutabakat kayıtları (yasal saklama süresi boyunca).',
          'Üyelik, kupon ve cüzdan hareketleri gibi mali sonuç doğuran kayıtlar.',
          'Silme talebinin kendisine ait denetim kaydı (talebin yerine getirildiğini kanıtlar; içinde kişisel veri barındırmaz).',
        ],
      },
      {
        id: 'contact',
        heading: 'İletişim',
        body: [
          `Bu sayfayla veya talebinizle ilgili her konuda ${LEGAL.email} adresinden bize ulaşabilirsiniz. Veri sorumlusu: ${LEGAL.entity}, ${LEGAL.address}, ${LEGAL.countryTr}.`,
          `Talebinizin sonucundan memnun kalmazsanız Kişisel Verileri Koruma Kurumu'na şikâyette bulunma hakkınız saklıdır.`,
        ],
      },
    ],
  },
  en: {
    title: 'Data Deletion Request',
    subtitle: `How to ask us to delete the personal data ${LEGAL.brand} holds about you.`,
    lastUpdatedLabel: 'Last updated',
    effectiveDate: LEGAL.effectiveDateEn,
    tocLabel: 'Contents',
    intro: [
      `You have the right to ask for your personal data to be deleted (KVKK Art. 7 and 11; GDPR Art. 17). This page explains how to make that request for data held on ${LEGAL.brand}, how the request is handled, and which records we are legally required to keep.`,
      `A note on our role: we act as a data controller for our own account holders' data, and as a data processor for data about our customers' end-customers/leads. If a business holds data about you on our Platform, you may address your request to that business as well; when you send it to us we route it to them and see it through.`,
    ],
    sections: [
      {
        id: 'how-to-request',
        heading: 'How to Make a Request',
        body: [
          `Email is the fastest route. Write to ${LEGAL.email} with the subject "Data Deletion Request" and include enough for us to find you in our records: your email address, your phone number, or which channel you messaged us on (WhatsApp, Instagram, Messenger, web chat).`,
          `We may ask for additional information to verify your identity. That step exists to stop someone else from having your data deleted in your name.`,
          `We resolve requests within the period prescribed by law (no later than 30 days under KVKK).`,
        ],
      },
      {
        id: 'in-app',
        heading: 'If You Are an Account Holder',
        body: [
          `If you are a business using the Platform, you can raise a deletion request for a person in your workspace from the panel: Settings → Compliance creates the request, and a manager approves and executes it. Every erasure leaves an audit record.`,
        ],
      },
      {
        id: 'platform-requests',
        heading: 'Requests That Come Through a Social Platform',
        body: [
          `When you remove our app's access on Facebook, Instagram or another connected platform and ask for your data to be deleted, that platform sends us a signed deletion request directly. We verify its signature, process it, and return a confirmation code.`,
          `You can check the state of that request with the code at: ${'https://jeetagrowth.com/data-deletion-status'}?code=YOUR_CODE`,
          `One important limit, stated plainly: these platforms send us an app-scoped user id, which is a different numbering from the page-scoped id (PSID) we hold for the conversation we had with you, and the two do not always match. When the id matches nothing we hold, we record the request as "no match found" and the status page says exactly that — we do not report a deletion of data we never found. If that happens, email us at the address above and we can usually find you by another detail.`,
        ],
      },
      {
        id: 'what-gets-deleted',
        heading: 'What Gets Deleted',
        body: ['Once a request is approved, the following is permanently deleted:'],
        items: [
          'All of your conversations and message content (WhatsApp, Instagram, Messenger, email, SMS, web chat).',
          'Your channel identities (phone number, WhatsApp number, platform ids such as PSID/IGSID).',
          'Call records and call transcripts.',
          'Your activity history, first-touch attribution records and tracked link clicks.',
          'Your survey responses.',
          'Your profile details — name, email, phone, address and notes — are anonymized, so the record no longer identifies you.',
          'If a data export (access request) was produced earlier, that copy is scrubbed too.',
        ],
      },
      {
        id: 'what-is-kept',
        heading: 'What Is Kept, and Why',
        body: [
          'Some records we cannot delete — that is a legal obligation, not a preference. Turkish tax law requires invoices and financial records to be retained for about ten years. Those rows are kept, but they come to reference an anonymized record that no longer identifies you.',
        ],
        items: [
          'Invoices, estimates and payment/settlement records (for the statutory retention period).',
          'Records with financial consequences such as memberships, coupon redemptions and wallet entries.',
          'The audit record of the deletion request itself (it proves the erasure ran, and holds no personal data).',
        ],
      },
      {
        id: 'contact',
        heading: 'Contact',
        body: [
          `For anything about this page or your request, write to ${LEGAL.email}. Data controller: ${LEGAL.entity}, ${LEGAL.address}, ${LEGAL.countryEn}.`,
          `If you are not satisfied with the outcome, you retain the right to complain to the Turkish Personal Data Protection Authority (KVKK) or your local supervisory authority.`,
        ],
      },
    ],
  },
};

export default dataDeletionContent;
