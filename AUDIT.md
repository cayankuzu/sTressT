# sTressT — Denetim Raporu (AAA ana metin, Aşama 1–2)

Tarih: 2026-10-01 · Kapsam: tüm proje, 40 eşya tanımı, 7 alet, tüm ekranlar ve ana sistemler.
Yöntem: kod incelemesi ve **gerçek oyun üzerinde otomatik testler**. `src/dev/qa.ts` test aracı
oyunu gerçek savuruşlar, gerçek tutma/fırlatma ve gerçek fizikle sürer; sonuçlar yalnızca koddan
çıkarılmadı. Araç yalnızca geliştirme sürümünde çalışır, oyuna paketlenmez.

## 1. Kapsam kararı (demo sınırı)

Kullanıcı kararı: "demo oyunu, demoyu aşan işlere girme." Buna göre:

| Ana metindeki istek | Karar | Gerekçe |
| --- | --- | --- |
| Mevcut sistemlerin kalitesi, hatasızlık, aşırı QA, test otomasyonu | **Kapsamda** | Demonun özü |
| Eğilme (crouch), ters Y ekseni | **Kapsamda** | Küçük, standart FPS beklentisi |
| Zemine göre adım sesi, oda yankısı | **Kapsamda** | Küçük, indirme gerektirmez |
| Demo sonu ekranı (başı-sonu olan demo) | **Kapsamda** | Küçük, demo hissi için şart |
| NPC'ler, algı, bölgesel vuruş, ragdoll | Kapsam dışı | Demonun 2–3 katı iş; tam sürüm (Godot) |
| Çok odalı bina, final sahnesi | Kapsam dışı | Demo yapısını değiştirir |
| Riglenmiş birinci şahıs eller | Kapsam dışı | Yeni varlık hattı gerektirir |
| Açılır/kırılır kapı ve pencere | Kapsam dışı | Mevcut tasarımda yok |
| Mobil/dokunmatik | Kapsam dışı | Kullanıcı kuralı: yalnızca klavye + fare |
| Altyazı | Uygulanamaz | Oyunda diyalog yok |

## 2. Envanter

| Kalem | Sayı |
| --- | --- |
| Kaynak dosyası (TypeScript) | 74 (12 800 satır) |
| 3D model | 60 (40'ı etkileşimli eşya) |
| Eşya tanımı | 40 (36 kırılabilir, 4 kırılmaz: varil, lastik, top, ördek) |
| Malzeme türü | 10 |
| Alet | 7 (yumruk, tava, sopa, çekiç, boru anahtarı, levye, balyoz) |
| Doku seti | 33 |
| Ses dosyası | 105 (21 grup × 5 varyasyon) + sentetik katmanlar |
| Ekran | Profil, ana menü, kayıtlar, yeni oyun, ayarlar, duraklat, 2 dükkân, depo, onaylar, yükleme, hata |
| Girdi eylemi | 28 (2'si kullanılmıyor: `snap`, `fine`) |
| Birim testi | 63 (7 dosya) + 4 performans ölçümü |

## 3. Eşya matrisi (her eşya tek tek)

Her eşya odanın ortasına tek başına konup sırayla test edildi. **Sütunlar:** boyut (m), duruş
(uyandırınca eğilme), düzenle/taşı/fırlat, ve yumruk / sopa / balyozla **kaç savuruşta
parçalandığı**, ardından kırılma anındaki **parça sayısı** (toplanacak büyük parça sayısı).

| Eşya | Boyut | Duruş | Düzenle · Taşı · Fırlat | Yumruk / Sopa / Balyoz | Parça (büyük) |
| --- | --- | --- | --- | --- | --- |
| Çay fincanı | 0.11×0.07×0.13 | ✓ | ✓ ✓ ✓ | 1 / 1 / 1 | 13 (0–1) |
| Fincan tabağı | 0.15×0.02×0.15 | ✓ | ✓ ✓ ✓ | 1 / 1 / 1 | 13 (0) |
| Yemek tabağı | 0.19×0.02×0.19 | ✓ | ✓ ✓ ✓ | 1 / 1 / 1 | 6–12 (1–2) |
| Çaydanlık | 0.16×0.16×0.27 | ✓ | ✓ ✓ ✓ | 2 / 1 / 1 | 10–13 (2) |
| Seramik vazo 1–4 | 0.11–0.22 × 0.31–0.41 | ✓ | ✓ ✓ ✓ | 2–3 / 1–2 / 1 | 4–16 (2–3) |
| Antika vazo | 0.25×0.44×0.26 | ✓ | ✓ ✓ ✓ | 4 / 2 / 1 | 11–13 (2) |
| Toprak saksı | 0.27×0.22×0.26 | ✓ | ✓ ✓ ✓ | 2 / 1 / 1 | 7–14 (2) |
| Seramik testi | 0.28×0.21×0.17 | ✓ | ✓ ✓ ✓ | 2 / 1 / 1 | 12–16 (2) |
| Şarap şişesi | 0.07×0.30×0.07 | ✓ | ✓ ✓ ✓ | 2 / 1 / 1 | 30–34 (2) |
| Şampanya şişesi | 0.08×0.32×0.08 | ✓ | ✓ ✓ ✓ | 2 / 1 / 1 | 29–30 (2) |
| Resim çerçevesi | 0.10×0.25×0.20 | ✓ | ✓ ✓ ✓ | 3 / 1 / 1 | 15–22 (2) |
| Ayna (yatık, B06) | 0.49×0.03×0.74 | ✓ | ✓ ✓ ✓ | yerde menzil sınırı / 1 / 1 | 37–41 (4–5) |
| Karton kutu | 0.39×0.34×0.52 | ✓ | ✓ ✓ ✓ | 2 / 1 / 1 | 5 (3) |
| Tüplü TV | 0.60×0.46×0.47 | ✓ | ✓ ✓ ✓ | 16 / 7 / 1 | 15–26 (3) |
| Küçük TV | 0.40×0.41×0.35 | ✓ | ✓ ✓ ✓ | 9 / 2 / 1 | 8–13 (2–3) |
| Dizüstü (B07) | 0.35×0.29×0.26 | ✓ | ✓ ✓ ✓ | 10 / 3 / 1 | 11–49 (2–4) |
| Teyp (B07) | 0.51×0.33×0.13 | ✓ | ✓ ✓ ✓ | 9 / 2 / 1 | 9–20 (3–4) |
| Mikrodalga (B07, B13) | 0.50×0.25×0.35 | ✓ | ✓ ✓ ✓ | 27 / 6 / 1 | 11–17 (3) |
| Çalar saat | 0.13×0.17×0.07 | ✓ | ✓ ✓ ✓ | 3 / 1 / 1 | 16–18 (2) |
| Masa lambası | 0.18×0.36×0.26 | ✓ | ✓ ✓ ✓ | 8 / 2 / 1 | 11–17 (2) |
| Ahşap sandalye | 0.43×0.96×0.54 | ✓ | ✓ ✓ ✓ | 11 / 2 / 1 | 12–26 (4–6) |
| Plastik sandalye | 0.64×0.88×0.63 | ✓ | ✓ ✓ ✓ | 6 / 2 / 1 | 5–7 (4) |
| Okul sandalyesi | 0.57×1.01×0.68 | ✓ | ✓ ✓ ✓ | 11 / 2 / 1 | 5–13 (4–6) |
| Tabure | 0.38×0.58×0.41 | ✓ | ✓ ✓ ✓ | 7 / 1 / 1 | 13–22 (3–6) |
| Sehpa | 0.55×0.55×0.45 | ✓ | ✓ ✓ ✓ | 10 / 2 / 2 | 15–26 (3–5) |
| Ahşap masa | 0.92×0.53×0.44 | ✓ | ✓ ✓ ✓ | 30 / 8 / 2 | 6–14 (4–5) |
| Komodin | 0.50×0.62×0.51 | ✓ | ✓ ✓ ✓ | 40 / 3 / 1 | 19–21 (5–7) |
| Ahşap dolap (32 kg) | 1.19×1.18×0.62 | ✓ | ✓ ✓ ✓ | 34 / 9 / 3 | 12–21 (5–8) |
| Ahşap sandık | 0.82×0.35×0.41 | ✓ | ✓ ✓ ✓ | 21 / 3 / 1 | 10–14 (4–5) |
| Islak zemin tabelası | 0.30×0.63×0.36 | ✓ | ✓ ✓ ✓ | 3 / 1 / 1 | 7 (3) |
| Bahçe cücesi | 0.26×0.60×0.21 | ✓ | ✓ ✓ ✓ | 4 / 3 / 1 | 9–16 (3–4) |
| Kedi heykeli | 0.15×0.28×0.25 | ✓ | ✓ ✓ ✓ | 27 / 2 / 1 | 5–9 (2) |
| Mermer büst | 0.27×0.51×0.30 | ✓ | ✓ ✓ ✓ | kırılmıyor* / 5 / 2 | 11–14 (3) |
| Varil, lastik, top, ördek | — | ✓ | ✓ ✓ ✓ | kırılmaz (tasarım) | — |

\* Mermerin yumrukla kırılmaması tasarım gereği: alet satın almayı teşvik eder.
Tüm eşyalarda: pivot (taban y=0, ortalı) doğru, duruşta eğiklik 0°, fırlatılan hiçbir şey odadan
çıkmadı, sayısal bozulma (NaN) yok. Fırlatma hızı: hafif eşyalar 15 m/s (sınır), ağırlar 2.7–5 m/s.

### Etkileşim matrisi (özet)

| Eşya grubu | Al/Taşı | Bırak | Fırlat | İt (yürüme/tekme) | Vur | Kır | Düzenle | Depola |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 36 kırılabilir eşya | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (sağlamsa) |
| 4 kırılmaz eşya | ✓ | ✓ | ✓ | ✓ | ✓ | Uygulanamaz | ✓ | ✓ |
| 12 kg üstü parçalar | Desteklenmiyor (tasarım: önce küçült) | — | — | ✓ | ✓ | ✓ | — | — |
| Kırma odası kapısı | Moda göre otomatik kilit | — | — | — | — | Kapsam dışı | — | — |
| Dükkân vitrinleri | — | — | — | — | Statik | Kapsam dışı | — | — |

## 4. Sistem testleri

| Alan | Test | Sonuç |
| --- | --- | --- |
| Hareket | Yürüme 3.4 m/s, koşu 5.15 m/s, zıplama 0.63 m, 4 m düşüşte iniş algılama | ✓ |
| Çarpışma | Odanın 4 köşesine koşup çıkma | ✓ takılma yok |
| Harita sınırı | 5 sınırdan zıplayarak kaçma, konteyner üstünden duvara atlama | ✓ kaçış yok |
| Girdi spam'i | E ×31, TAB ×25, sol tık ×40, duraklat/devam ×20 | ✓ kopya, kilit, artık menü yok |
| Kesilen eylemler | Tutarken duraklat, tutarken mod değiştir, savuruşta duraklat, yerleştirirken duraklat | ✓ |
| Kayıt | Fırlatıp hemen kaydet ve yükle | ✓ tutarlı |
| Menüler | 6 ekran, tüm geri yolları, "üzerine yaz" ve "sil" onayları | ✓ çıkmaz ekran yok |
| Ayarlar | FOV 100, hassasiyet 3, ana ses 0 → anında uygulanıyor | ✓ (kalite: bir sonraki açılış) |
| Performans | 20 eşya aynı anda balyozla: mantık+fizik ort. 3.3 ms, en kötü 6.9 ms | ✓ (bütçe 16.7 ms) |
| Performans | 272 parça sahnede: ort. 1.2 ms; çizim 60 FPS | ✓ |
| Bellek | 8 yeni oyun + toplu yıkım: geometri/doku/gövde sayısı sabit, JS belleği GC ile dönüyor | ✓ sızıntı yok |
| Konsol | Oyun içi hata ve uyarı | ✓ 0 |
| Kod temizliği | TODO, FIXME, HACK, console.log taraması | ✓ yok |

## 5. Hata kaydı

Öncelik: P0 oynanamaz · P1 çekirdek mekanik bozuk · P2 deneyimi ciddi bozuyor · P3 cila · P4 kozmetik.

### Bu aşamada bulunup düzeltilenler

| ID | Öncelik | Hata | Kök neden | Düzeltme | Regresyon testi |
| --- | --- | --- | --- | --- | --- |
| B01 | P3 | DÜZENLE'de eşya E ile alınınca seçim çerçevesi eski yerinde asılı kalıyordu (kullanıcı raporu) | Elde taşıma dalında çerçeve gizlenmiyordu | Taşırken çerçeve gizleniyor | Tarayıcıda: al → çerçeve yok |
| B02 | P3 | Devrik eşyada seçim çerçevesi modelden kopuktu | Çerçeve dünya eksenine göre ortalanıyordu | Modelin kendi sınır merkezi ve açısı kullanılıyor | Yatık vazoda çerçeve oturuyor |
| B03 | P2 | Kırık sandalyede sopa 40 vuruşta bitiremiyordu | Nişan çizgisi boşluktan geçip zemine çarpınca vuruş zemine gidiyordu | Işın zemine/duvara giderse, savuruş kalınlığındaki taramada değen kırılabilir eşyaya vuruluyor (alet ve tekme) | Sandalye sopayla 2–3 vuruş |
| B04 | **P1** | Dizüstü kırılırken `expected instance of RawShape` hatası: parçalar eksik, eşya "parçalanıyor" durumunda takılı, sahipsiz fizik gövdesi | 2–3 mm'lik ekran kırıklarında tüm noktalar tek düzlemde kalıyordu; Rapier gövdeyi ancak collider oluştururken hesaplayıp hata fırlatıyor, yedek hiç devreye girmiyordu | İnce parçalar gerçek kalınlığını koruyor; collider oluşturma hata verirse aynı ayarlarla ince kutuya düşülüyor (parça + eşya) | Dizüstü 6/6 hatasız, birim testi |
| B05 | P4 | Debug paneli çizim çağrısını 0 gösteriyordu | Sayaç her render geçişinde sıfırlanıyordu | Sayaç kare başında sıfırlanıyor, tüm geçişleri topluyor | Panel doğru değer |

### Aşama A — kapatılan hatalar

| ID | Öncelik | Hata | Kök neden | Düzeltme | Doğrulama |
| --- | --- | --- | --- | --- | --- |
| B06 | P2 | Ayna (3 cm panel) dik konunca devriliyordu | İnce bir duvar aynası kenarı üstünde duramaz | Tanıma "dinlenme pozu" eklendi: ayna şablonda yüzü yukarı, sırtüstü kurulur; tüm yerleştirme kodu değişmeden çalışır | Uyandırınca 0°, sopa/balyozla 37–41 cam parçası |
| B07 | P2 | Dizüstü ~1.85×, mikrodalga ~2×, teyp ~1.4× büyüktü | Kaynak modellerin ölçeği | Ölçek ve kütle gerçek değere çekildi (0.35 / 0.50 / 0.51 m) | Boyut tablosu |
| B08 | P3 | Tahta parçalar yığında yavaş kayıp uyumuyordu | (1) Hareketsiz duran oyuncu bile her adımda kinematik konumunu yeniden yazıyordu; Rapier buna dokunan her şeyi uyandırıyordu. (2) Yığında titreşen parçalar | Boştaki oyuncu yerinde sabitleniyor; uzun süre yavaş kalan parça sert sönümleniyor, Rapier kendisi uyutuyor | Dolap parçaları oyuncunun yanında 2–4 sn'de uyuyor |
| B09 | P3 | Son eşya kırılınca kaos 2.8 sn'de siliniyordu | Kısa bekleme ve solma | KIR modu 4 sn sürüyor, enkaz 2.5 sn'de soluyor | Tarayıcıda |
| B10 | P2 | Küçük parçalar zeminden düşebiliyor, hızlı parçalar duvardan geçebiliyordu | **5 cm'den küçük parçalara açılan CCD, ince kırıklarda Rapier'de tünellemeyi artırıyordu** (16 parçadan 2–4'ü düşüyordu; CCD'siz 0–1) | Parçalarda CCD kaldırıldı; duvarların ve tavanın arkasına 1 m görünmez blok; zeminin içine kaçan parça zeminin üstüne geri konur | 40 eşya × 3 alet: kaçan parça 0 |
| B11 | P3 | Grafik kalitesi bir sonraki açılışta uygulanıyordu | Kurulumda bir kez okunuyordu | Çözünürlük, gölge ve toz anında değişiyor (kenar yumuşatma açılışta) | Düşük: 0.75× / gölge 512; yüksek: gölge 2048 |
| B12 | P4 | Kullanılmayan girdi eylemleri | Eski özellik kalıntısı | `snap`, `fine` kaldırıldı | Lint/test |
| B13 | P3 | Mikrodalga 3–5 parçaya ayrılıyordu | Cam pencere çerçeveyle aynı geometri adasındaydı, metal parçanın içinde eriyordu | Cam üçgenler şablonda her zaman ayrı parça olur (mikrodalga, çerçeve camı, saat camı) | Mikrodalga 11–17 parça |
| B14 | P4 | Uyandırmada tek karelik ~2.5 mm düşüş | Uyutma toleransı 3 mm | 1.5 mm | Uyandırma hızı 0 m/s |
| B15 | **P1** | Oyuncu doğunca/yüklemede/ışınlanınca yerde "batık" başlayıp sürünüyor veya takılıyordu (yeni bulundu) | Işınlama kapsülü tam zemine, denetleyicinin 2 cm'lik güvenlik payının içine koyuyordu | Işınlama bu payın hemen üstüne yerleştiriyor | 10 noktada tam yürüme hızı, batma yok |
| B16 | P3 | Hareketsiz oyuncu yanındaki enkazı sonsuza kadar uyanık tutuyordu (yeni bulundu) | B08 (1) ile aynı | B08 ile aynı | Aynı |

Aşama içinde araç iki ara hatayı da teslimden önce yakaladı. Parçaları zorla uyutmak onları zemine
gömüyordu; yerine sönümleme kondu. Küçük adımları yok saymak da yürümeyi kilitliyordu; yerine
"gerçekten boşta" kuralı kondu.

### Bilinen, kabul edilen durumlar

- Yerde yatan aynaya ayakta yumruk menzili ancak yetiyor; eğilerek (C) rahatça vurulur.
- Mermer büst yumrukla kırılmaz (tasarım: alet satın almak).
- Şişe kırıklarının en küçükleri zemine 1 cm'ye kadar oturabiliyor; zaten birkaç saniyede silinen
  mikro parçalar.

## 6. Mevcut durum → hedef

| Alan | Mevcut | Hedef (demo) |
| --- | --- | --- |
| Hareket | Yürüme/koşu/zıplama/iniş iyi, eğilme yok | + eğilme (çarpıştırıcı, tavan kontrolü) |
| Kamera/ayarlar | FOV, hassasiyet, sallantı, sarsıntı | + ters Y, kalite canlı |
| Tutma/taşıma/fırlatma | Kütleye göre hız, ağır yük yavaşlatma, DÜZENLE'de nazik taşıma | Korunur |
| Yakın dövüş | 7 alet, enerji/açı/temas/malzeme hasarı, vuruş durması, savuruş yardımı (yeni) | Korunur, B03 ile güçlendi |
| Yıkım | Aşamalı (sağlam→hasarlı→kırık→parçalanmış), parça kopması, yontma, iz, yeniden kırılma | B06–B10, B13 |
| Fizik kararlılığı | Yerleştirme ve yığınlar sağlam, uyuma doğru | B08 |
| Ses | Malzemeye göre darbe, 5 varyasyon, ses bütçesi; adım sesi tek tip | + zemine göre adım, oda yankısı |
| Arayüz | Tam menü akışı, mod seçici, ipuçları | + demo sonu ekranı |
| Kalite güvencesi | 63 birim testi + `src/dev/qa.ts` test aracı | + tam oynanış senaryoları |

## 7. Uygulama planı ve durum

1. **Aşama A — açık hatalar:** B06–B16. **Tamamlandı.**
2. **Aşama B — oyuncu:** eğilme (C basılı: 1.1 m kapsül, göz 0.95 m, 1.8 m/s, alçak yerde
   kalkmaz/zıplamaz), ters Y ekseni ayarı, aynanın çerçevesi ahşap + camı ayrı. **Tamamlandı.**
3. **Aşama C — ses:** odada kauçuk zemin adımı (Kenney CC0 "carpet"), sokakta beton; sentetik oda
   yankısı (odada 0.31, sokakta 0.06 gönderme); eğilince adımlar sessiz ve kısa. **Tamamlandı.**
4. **Aşama D — demo çerçevesi:** son alet alınınca "Demo tamamlandı" ekranı (süre, parçalanan eşya,
   kazanılan kredi, çöpe atılan parça, en yüksek kombo, fırlatılan eşya), kayıt başına bir kez.
   **Tamamlandı.**
5. **Aşama E — aşırı QA 2. tur:** `qa.playthrough()` uçtan uca senaryo (bulunan eşya → yerleştir →
   kır → temizle → dükkân → tezgâh → teslimat → kır → temizle → kaydet/yükle) 3 kez geçti;
   40 eşya taraması, hareket ve girdi testleri geçti; production önizlemesi temiz. **Tamamlandı.**

## 8. Tamamlanma raporu

| Kalem | Sayı |
| --- | --- |
| Sistem | 23 (oyuncu, kamera, girdi, tutma, düzenleme, aletler, tekme, yıkım, parçalar, kırılma, ekonomi, oturum, kayıt, profiller, ayarlar, ses, parçacıklar, ışık, arayüz, dükkânlar, teslimat, temizlik, modlar) |
| Model | 60 (40 etkileşimli eşya) |
| Alet | 7 |
| NPC | 0 (kapsam dışı) |
| Mekân | Kırma odası + sokak (2 dükkân arayüzü) |
| Arayüz ekranı | 12 |
| Girdi eylemi | 27 |
| Otomatik test | 66 birim testi + test aracında ~420 kontrol (40 eşya × 9, hareket 6, girdi 9, oynanış 9 × 3) |
| Geçen | Tümü |
| Başarısız | 0 |
| Engellenen (elle yapılmalı) | Firefox ve Safari'de elle test; gerçek düşük donanımlı PC |
| Bu denetimde düzeltilen | 16 hata (B01–B16; 2'si P1) |
| Bilinen, kabul edilen | 3 (bölüm 5) |

P0: 0 · P1: 0 açık · P2: 0 açık.

## 9. Sürüm 0.1.1: kullanıcı raporları ve ikinci tarama

Bu bölümdeki sayılar, yukarıdaki tablolardan güncel olanlardır. Depo kaldırıldığı için ekran sayısı
11'e, girdi eylemi sayısı 26'ya indi.

| ID | Öncelik | Hata | Kök neden | Düzeltme | Doğrulama |
| --- | --- | --- | --- | --- | --- |
| B17 | **P1** | Yumruk dışındaki aletler elde hiç sallanmıyordu. Vuruş gerçekleşiyor ama alet dinlenme pozunda kalıyordu (kullanıcı raporu) | Yumrukların sağ/sol sırası (`leftTurn`) bütün aletlere uygulanıyordu. Sıra yalnız yumruklarda ilerlediği için diğer aletlerde hep "sol elin sırası"nda kalınıyor, sağ el dinlenme pozunu çiziyordu. Vuruş geri tepmesi de bu yüzden kapalıydı | Sıra yalnız yumruklarda uygulanıyor | `qa.feedbackAudit()`: 7 aletin hepsi savuruşta 0.22–0.37 m hareket edip dönüyor; yumruklar sağ/sol sırayla |
| B18 | P2 | Konteynere atılan parça para kazandırıyordu ama hiçbir geri bildirim yoktu (kullanıcı raporu) | `payout.cleanup` etiketi tanımlıydı ama hiçbir yere bağlanmamıştı | Konteynerin üstünde "+N CR · TEMİZLİK" balonu ve ödül sesi; birlikte düşen parçalar tek balonda toplanıyor | 15 parça → tek balonda +94 |
| B19 | P3 | Depo (DEL / I) anlaşılmıyordu. DEL yalnız DÜZENLE modunda, odada, elde eşya yokken ve hasarsız bir eşyaya bakarken çalışıyor, başka her durumda sessiz kalıyordu (kullanıcı raporu) | Fiziksel teslimata geçildikten sonra işlevsiz kalan eski envanter. Eşyayı korumak için sokağa taşımak zaten yetiyor | Kullanıcı kararıyla depo kaldırıldı. Eski kayıtlarda depoda duran eşyalar, kayıt yüklenince bir kez sokaktaki teslim alanına gelir | Birim testi; tarayıcıda depolu eski kayıt: kutu bir kez geldi, ikinci yüklemede tekrar gelmedi |
| B20 | P3 | Konteynere sağlam eşya atılınca hiçbir şey olmuyordu ve nedeni söylenmiyordu (yeni bulundu) | Konteyner yalnız parçaları kabul ediyor | "{eşya} sağlam: konteyner yalnızca kırık parçaları alır. Önce kır." notu. Eşyanın merkezi esas alınıyor, çünkü tabanı konteyner zemininin hemen altında kalabiliyor | `qa.feedbackAudit()` |
| B21 | P2 (test aracı) | Test aracı o an açık olan profilin 3. yuvasına yazıyordu; oyuncunun kaydının üzerine yazabilirdi (yeni bulundu) | Profil seçilmeden `newGame(2)` çağrılıyordu | Araç hep kendi "QA" profilinde oynuyor. Panelde fare yakalanıp bırakılınca oyun duraklarsa oynanış sonucu `INVALID` olarak işaretleniyor | Kod incelemesi; 5180'deki "as" profiline dokunulmadı |

Test turu: 66 birim testi; `feedbackAudit`, `inputAudit` ve `controllerAudit` geçti; `playthrough`
11 turun son 7'sinde art arda geçti. İlk 4 turun 2'si, bazı vuruşlar boşa gittiği için yarım kaldı;
bu sonra tekrarlanmadı. O sırada "panel duraklaması" diye tahmin edilmişti; gerçek neden 0.1.3'te
bulundu (bölüm 11): test aracı devrilen eşyalara sabit yükseklikten nişan alıyordu.

## 10. Sürüm 0.1.2: seviyeli ekonomi

Tasarım ve sayılar GAME_DESIGN.md'deki "Levels" ve "Economy rules" bölümlerinde; değişiklik listesi
CHANGELOG.md'de.

| Kontrol | Sonuç |
| --- | --- |
| Birim testleri | Geçti: seviye kuralları, mağaza kilidi, koleksiyon ve aşama ödülleri dahil |
| Ekonomi simülatörü | Balyoz: iyi oyuncu 20,2 dk, ortalama 28,5 dk, zayıf 36,2 dk. Koleksiyon: 26,1 / 35,0 / 42,8 dk. Kimse takılmıyor |
| Kilit (tarayıcı) | Yumruk 3. seviye sandalyeye hasar vermiyor (260/260), kilit satırı ve "Beyzbol Sopası gerekir" notu çıkıyor. 2. seviyedeyken tekme ve üstüne düşen kutu da işlemiyor; sopa alınınca tekme işliyor (260 → 187). Sopa sendeyken yumrukla vurunca "3 ile kuşan" uyarısı çıkıyor |
| Mağaza | Kilitli eşya satın alınamıyor (`tool_required`); gruplar, işaretler, kazanç ve kâr doğru gösteriliyor |
| Ödüller | HASAR +6, KIRILDI +15, PARÇALANDI +37, İLK KEZ! +29 (seramik vazo); aynı vuruştaki aşamalar tek balonda |
| Seviye atlama | Tava tezgâhtan alınınca "SEVİYE 2 AÇILDI · 6 yeni eşya"; hedef Beyzbol Sopası'na geçiyor |
| Test aracı | `feedbackAudit`, `inputAudit` ve `playthrough` geçti. Nesne taraması seviye başına örneklerde (vazo, saksı, tabure, cüce) geçti; nesne taraması artık her eşyayı yalnızca onu kırabilen aletlerle deniyor |

Açık kalan, P4 (0.1.3'te kapatıldı, bölüm 11): tabure sopayla yakından kırılınca küçük bir kırıntı 3 denemenin 2'sinde arka
duvardan dışarı kaçtı; bağımsız 6 denemede tekrarlanmadı. Kırıntı toplanmıyor, kayda yazılmıyor ve
kırma bitince siliniyor.

## 11. Sürüm 0.1.3: açık kalanlar kapatıldı

| ID | Öncelik | Hata | Kök neden | Düzeltme | Doğrulama |
| --- | --- | --- | --- | --- | --- |
| B22 | P4 | Tabure sopayla kırılınca küçük bir kırıntı bazen arka duvardan dışarı kaçıyordu; zemin kurtarması onu dışarıda sonsuza kadar "kurtarıyordu" | Kesin neden yeniden üretilemedi (16 bağımsız denemede tekrarlamadı) | Son güvenlik ağı (`confineToRoom`): kuzey cephesinin arkasında odadan başka ulaşılabilir yer yok. Orada bulunan kırıntı silinir, toplanacak parça odanın içine geri konur | Birim testi; tarayıcıda duvar arkasına konan parça odaya döndü (z -14,2 → -12,6), kırıntı silindi; oynanış ve test turları geçti |
| B23 | P3 (test aracı) | Oynanış testi aralıklı olarak (yaklaşık 4 turda 1) "sopa sandalyeyi 20 vuruşta kıramadı" ve "yumruk odayı bitiremedi" diyordu | Test aracı eşyanın tabanının sabit bir yükseklik üstüne nişan alıyordu; ilk darbede devrilip yere yatan sandalyenin üstünden vuruş zemine gidiyordu (19 vuruşun hepsi zeminde). Oyun hatası değil: oyuncu yatan eşyaya bakarak vurur | Oynanış testi de nesne taraması gibi eşyanın kalan en büyük parçasının merkezine nişan alıyor | Düzeltmeden sonra art arda 6/6 tur |

Süre sınırı yok (kullanıcı kararı): ekonomi testleri toplam süre sınırı yerine ritmi koruyor. İlk
yükseltme birkaç dakika içinde gelmeli, iki alet arasındaki en uzun bekleme iyi / ortalama / zayıf
oyuncu için 10 / 13 / 16 dakikayı geçmemeli ve 120 dakikalık simülasyonda herkes bütün aletleri ve
bütün koleksiyonu tamamlamalı.

Açık hata: yok. Elle yapılması gerekenler: Firefox ve Safari'de deneme, gerçek bir düşük donanımlı
PC'de deneme.
