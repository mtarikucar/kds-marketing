/**
 * Unified NetGSM error vocabulary. One place for user-facing (Turkish)
 * messages across the send/report/balance/santral/İYS surfaces so every
 * settings card and toast explains a bare provider code the same way.
 * Legacy send codes are documented in netgsm-send.util.ts (English,
 * operator-facing); these are the tenant-facing Turkish equivalents.
 */
const MESSAGES: Record<string, string> = {
  '20': 'Mesaj reddedildi: metin boş, çok uzun veya desteklenmeyen karakter içeriyor (kod 20).',
  '30': 'NetGSM kimlik doğrulaması başarısız: API kullanıcı adı/şifresini, API erişiminin açık olduğunu ve sunucu IP adresinin izin listesinde olduğunu kontrol edin (kod 30).',
  '40': 'Gönderici başlık (msgheader) hesapta tanımlı veya İYS onaylı değil (kod 40).',
  '50': 'İYS: alıcının ticari ileti izni yok veya ret kaydı var (kod 50).',
  '51': 'İYS: gönderici marka/başlık İYS\'de ticari ileti için kayıtlı değil (kod 51).',
  '60': 'NetGSM hesabında bu işlem için yetki veya tanımlı paket yok (kod 60).',
  '70': 'NetGSM\'e eksik veya hatalı parametre gönderildi (kod 70).',
  '80': 'NetGSM hız limiti aşıldı — kısa bir bekleme sonrası yeniden deneyin (kod 80).',
  '85': 'Aynı alıcıya aynı içerik çok kısa aralıkla gönderildi (mükerrer limit, kod 85).',
  '100': 'NetGSM sistem hatası — daha sonra yeniden deneyin (kod 100).',
};

export function netgsmErrorMessage(code: string): string {
  return MESSAGES[code] ?? `NetGSM işlemi reddetti (kod ${code}).`;
}

export class NetgsmError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? netgsmErrorMessage(code));
    this.name = 'NetgsmError';
  }
}
