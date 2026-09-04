# Jeeta — Pazarlama Dokümanları

Satış/pazarlama ekibi için iki doküman:

| Dosya | İçerik |
|---|---|
| `Jeeta-Pazarlama-Satis-Kilavuzu.pdf` | Satış playbook'u: değer önerileri, hedef kitleler, planlar/fiyatlar, rakip konumlama, itiraz karşılama, satış konuşmaları. |
| `Jeeta-Nasil-Calisir-Egitim-Kilavuzu.pdf` | Ürün eğitim kılavuzu: mimari, lead yolculuğu, modül modül anlatım, AI, kurulum, roller, demo akışı. |

`.html` dosyaları düzenlenebilir kaynaklardır. İçeriği değiştirip PDF'i yeniden üretmek için (frontend/node_modules'daki playwright-core kullanılır):

```bash
cd frontend
node ../docs/marketing/html2pdf.mjs \
  ../docs/marketing/Jeeta-Pazarlama-Satis-Kilavuzu.html \
  ../docs/marketing/Jeeta-Pazarlama-Satis-Kilavuzu.pdf
```

**Kaynaklar:** Fiyatlar `backend/prisma/seed-packages.ts` (resmi paket seed'i); özellik envanteri koddan çıkarılmıştır. Güncel/kampanya fiyatı için jeetagrowth.com esas alınmalıdır.
