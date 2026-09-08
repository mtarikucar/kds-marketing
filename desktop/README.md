# Jeeta Masaüstü

Bir telefonu çalışma alanınıza bağlayan köprü. Jeeta sunucuda çalışır, telefon
sizin masanızdadır; arada bu uygulama vardır.

## Neden bir köprü var

Sunucu telefona ulaşamaz ve hiçbir zaman ulaşamayacak — arada bir dizüstü, bir
kablo ve bir insan var. Bu yüzden hiçbir komut telefona *gönderilmez*: Jeeta
komutu kuyruğa yazar, bu uygulama onu **alır**, yapar ve sonucu geri yazar.

Bunun pratik sonucu: **kuyruğa yazılmış bir komut olmuş bir komut değildir.**
Dizüstü kapalı olabilir, kablo çıkmış olabilir, siz "hayır" demiş olabilirsiniz.

## Kurulum

1. Android telefonda **Geliştirici seçenekleri → USB hata ayıklama**'yı açın.
2. Bilgisayara **Android Platform Tools**'u kurun (`adb` PATH'te olmalı).
3. Telefonu USB ile bağlayın ve ekranda çıkan **"Bu bilgisayara izin ver"**
   uyarısını onaylayın. (Onaylamazsanız uygulama telefonu "yetkisiz" olarak
   gösterir — liste boş görünmez, ne yapmanız gerektiğini söyler.)
4. Jeeta'da **Ayarlar → API ve bağlayıcı**'dan bir API anahtarı üretin.
5. Uygulamaya anahtarı ve sunucu adresini girin, telefonu seçin.

## Güvenlik — niyet değil, yapı

- **Cihaz varsayılan olarak `MANUAL`.** Her komut için siz onaylarsınız. Bu bir
  ayar dosyasında değil, **sunucuda** tutulur: kuyruk, cihazın yapmayacağı bir
  şeyi vaat edemez.
- **Reddetmek bir hata değildir.** "Hayır" dediğinizde sonuç `REFUSED` olarak
  kaydedilir — döngüde bir insan olduğunu kanıtlayan tek sinyal, arıza gibi
  görünmez.
- **`SHELL` komutu yoktur ve bilerek yoktur.** Birinin kişisel telefonuna
  uzaktan kabuk erişimi, "şu linki aç"tan başka bir risk sınıfıdır.
- **Sadece `https` ve `tel` açılır.** `intent:` bir bileşeni ve parametrelerini
  adlandırabildiği için dışarıda bırakıldı.
- **API anahtarı iptal edilirse uygulama durur**, yeniden denemez.
- **Komutların ömrü vardır.** Bir hafta sonra takılan telefon, bir günlük
  dokunuşu peş peşe tekrar etmez: o komutların yazıldığı ekran çoktan yok.

## Geliştirme

```
npm install
npm run typecheck
npm test
```

`src/adb.ts` cihaz katmanı, `src/bridge.ts` döngü. Her `adb` çağrısı argümanları
**dizi** olarak geçer — asla kabuk dizesi olarak. Komutlar bir yabancının web
sitesinden gelen URL'ler ve bir LLM'in yazdığı metin taşır.
