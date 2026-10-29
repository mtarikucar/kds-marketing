"""Texts and the sentences they are cut into, one table for both cutters: the worker cuts a text
with `jeeta_voice_bridge::text::sentences` (rust/bridge/voice/src/text.rs) and sends each sentence
as a request of its own, and `split_sentences` here must cut a text where the worker does, so that
neither splits what the other keeps whole. The worker's test (rust/bridge/voice/tests/text.rs)
reads this file too: one JSON array per line, [text, [sentence, ...]], single spaces only (this
side joins pieces with one space) and no sentence past the worker's 220-character comma cut, which
this side does not make. Plan B4 review I5."""
import json

CASES = [json.loads(line) for line in """
["Merhaba, ben Acme'nin dijital asistanıyım. Görüşmemiz yazıya dökülmektedir. Ada Hanım ile mi görüşüyorum?", ["Merhaba, ben Acme'nin dijital asistanıyım.", "Görüşmemiz yazıya dökülmektedir.", "Ada Hanım ile mi görüşüyorum?"]]
["Tutar 1.250 TL. Saat 14.30'da Dr. Ahmet bekliyor! Size uygun mu acaba?", ["Tutar 1.250 TL.", "Saat 14.30'da Dr. Ahmet bekliyor!", "Size uygun mu acaba?"]]
["Randevunuz 14:00'e.", ["Randevunuz 14:00'e."]]
["Faiz oranı yüzde 3,5 oldu. Prof.Dr. Ahmet bugün burada.", ["Faiz oranı yüzde 3,5 oldu.", "Prof.Dr. Ahmet bugün burada."]]
["Ofisimiz 3. katta bulunuyor.", ["Ofisimiz 3. katta bulunuyor."]]
["1. seçenek iyi.", ["1. seçenek iyi."]]
["Bizim ofisimiz 3. katta ve bahçeye bakıyor.", ["Bizim ofisimiz 3. katta ve bahçeye bakıyor."]]
["Bu da 2. seçenek olarak kalsın.", ["Bu da 2. seçenek olarak kalsın."]]
["Kapı numarası 12. Ondan sonra sağa dönün.", ["Kapı numarası 12.", "Ondan sonra sağa dönün."]]
["Evet. Tamam. Yarın görüşürüz.", ["Evet. Tamam. Yarın görüşürüz."]]
["Yarın sizi arayacağız. Tamam mı?", ["Yarın sizi arayacağız. Tamam mı?"]]
["Peki.", ["Peki."]]
["Bunu gerçekten bilmiyor muydunuz?! Şaşırdım doğrusu bunu.", ["Bunu gerçekten bilmiyor muydunuz?!", "Şaşırdım doğrusu bunu."]]
["Bir düşüneyim bakalım… Evet, uygun görünüyor.", ["Bir düşüneyim bakalım…", "Evet, uygun görünüyor."]]
["Kutuyu rafa sok. Sonra kapıyı kapatın lütfen.", ["Kutuyu rafa sok. Sonra kapıyı kapatın lütfen."]]
["harika! yarın sizi arayacağız.", ["harika! yarın sizi arayacağız."]]
["bir iki üç dört! beş altı yedi sekiz.", ["bir iki üç dört!", "beş altı yedi sekiz."]]
["fiyat bin iki yüz doksan dokuz lira. kampanya üç kasıma kadar sürüyor... ne dersiniz?", ["fiyat bin iki yüz doksan dokuz lira.", "kampanya üç kasıma kadar sürüyor... ne dersiniz?"]]
["dükkanımız çarşı st. yanında, sizi bekliyoruz.", ["dükkanımız çarşı st. yanında, sizi bekliyoruz."]]
""".strip().splitlines()]
