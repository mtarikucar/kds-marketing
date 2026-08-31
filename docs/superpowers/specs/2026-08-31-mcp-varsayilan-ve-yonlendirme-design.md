# Claude bağlıysa varsayılan MCP, ve yeni kullanıcıyı oraya götürmek

Tarih: 2026-08-31
Durum: tasarım — sahip iki kararı doğrudan verdi (yedek, yönlendirme biçimi)

Öncesi: `2026-08-31-arastirmayi-mcp-ye-tasima-design.md` (v2.286.0) gece
kuyruğunu MCP'den boşaltılabilir yaptı. O sürümde mod elle çevriliyor.

## Sorun

v2.286.0 çalışıyor ama **kimse açmıyorsa hiçbir şey kurtarmıyor.** Sahibin
talimatı: Claude bağlıysa varsayılan MCP olsun, ve yeni kullanıcılar da aynı
kuruluma yönlendirilsin.

Buradaki tuzak, bu depoda tekrar eden hatanın en tehlikeli hâli:
**bağlantı, birinin kuyruğu boşaltacağının kanıtı değil.** Claude'u bir kez
bağlayıp zamanlanmış görevi hiç kurmayan bir kullanıcıda mod MCP'ye düşerse,
gece araştırması sessizce durur ve kimse fark etmez.

## Karar 1 · Mod "kim boşaltır" değil, "kime öncelik verilir" olur

Sahibin kararı: **platform yedeğe girsin.**

Bu, tasarımı sadeleştiriyor. Sert bir mod yerine:

| Mod | Davranış |
|---|---|
| `SERVER` | Platform hemen boşaltır (bugünkü) |
| `MCP` (elle ya da otomatik) | Sahibin Claude'una **öncelik**; iş `GRACE_HOURS` içinde kiralanmazsa platform devralır |

Böylece **"araştırma asla sessizce durmaz"** sistem çapında bir kural olur.
Tasarruf, hat çalıştığı her gece gerçekleşir; platform yalnızca hat
çalışmadığında öder.

### Otomatik varsayılan neye bakar

`ApiKey.lastUsedAt` — anahtarın **var olması** niyet, **kullanılıyor olması**
gerçek bir bağlantıdır. Son N gün içinde kullanılmış aktif bir MCP anahtarı
varsa mod etkin olarak `MCP` sayılır.

Bu hâlâ "birisi 3'te boşaltacak"ın kanıtı değil — kanıt yedek mekanizmasının
kendisidir. Kanıt gerekmiyor, çünkü yanlış tahminin bedeli artık yok.

### Yedek devreye girdiğinde susulmaz

Platform bir işi devraldığında bu **kaydedilir** ve panelde adıyla söylenir:

> Dün gece Claude'un işi almadı. Biz koşturduk (0,26 $).
> Zamanlanmış görevin çalışıyor mu?

Bu satır olmazsa yedek, maliyeti sessizce platformda tutan bir tuzağa dönüşür —
yani sorunu diğer yönden tekrarlar.

## Karar 2 · Yeni kullanıcıya hazır komut verilir

Kontrol listesi bugün üç adım (strateji, kanal, ekip). Dördüncü adım eklenir:
**"Claude'unu bağla"** —

1. MCP adresi + anahtar oluştur (kopyalanabilir)
2. **Kopyalanmaya hazır zamanlanmış görev komutu** — `claim_research_job` →
   brief'i uygula → `submit_research_candidates` → `complete_research_job`
3. Adım, **ilk başarılı kiralama görüldüğünde** tamamlanır

Üçüncü nokta önemli: adımın tamamlanma ölçütü "anahtar oluşturuldu" değil,
**hattın gerçekten çalıştığının kanıtı**. Kurulumun yarıda kalması burada
görünür olur.

## Yazma modu uyarısı

v2.286.0'da ölçüldü: `APPROVAL` modunda üç veri aracı gecikmiyor,
**kullanılamıyor** — onay yürütücüsü sonucu onaylayanın HTTP cevabına
döndürüyor, ajanın turuna değil. Yani `APPROVAL` + MCP hattı = Google Maps
sinyali olmadan araştırma.

Hem ayar kartı hem kontrol listesi adımı, workspace `APPROVAL`'daysa bunu
**söyler**. Otomatik varsayılan bu durumda da açılır (yedek koruyor), ama
kullanıcı neyle karşılaşacağını bilerek gider.

## Hata davranışı

- Yedek devreye girdiyse **adıyla** söylenir, maliyetiyle birlikte
- Kuyruk okunamıyorsa "0 iş" denmez, okunamadığı söylenir (v2.271.0 kuralı)
- Kontrol listesi adımı, kanıt yokken "tamam" göstermez

## Test

- **Birim:** `lastUsedAt` eşiğinin etkin modu belirlemesi; `GRACE_HOURS`
  dolmadan platformun işe dokunmaması; dolduğunda devralması ve bunu kaydetmesi
- **Gerçek-DB e2e:** süre dolduğunda platformun devralması; devralmanın
  kaydedilmesi; **kiracı izolasyonu** — her `workspaceId` yüklemi kendi
  iddiasını düşürmeli
- **Dürüstlük:** yedek devreye girdiğinde panel bunu gösterir; mutasyonla
  doğrulanır (satırı sil → test düşer)

## Kapsam dışı

- `mcpWriteMode`'un kendisi (sahibin kararı, bu spec değiştirmiyor)
- BYOK
- Araştırma dışındaki iş türleri
