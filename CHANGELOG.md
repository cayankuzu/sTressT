# Sürüm notları

Her yayın sürümü bir artırır ve buraya yazılır. Oyunun ana menüsünün sağ alt köşesinde çalışan
sürüm görünür.

## 0.1.2 (2026-10-01)

### Yeni: seviyeli ekonomi

- **7 seviye.** Her alet bir seviyedir (1 Yumruklar … 7 Balyoz) ve her eşyanın bir seviyesi var.
  Bir alet kendi seviyesindeki ve altındaki her şeyi kırar; **Balyoz her şeyi kırar.** Seviyesi
  yetmeyen vuruş hiç hasar vermez: eşya itilir, iz kalmaz, kısa bir "tok" sesi ve kıvılcım çıkar,
  hangi aletin gerektiği yazar. O alet sende varsa hangi tuşla kuşanacağın söylenir. Tekme, fırlatma
  ve zincirleme çarpışmalar da yalnızca en güçlü aletinin kırabildiği eşyalara işler.
- **Seviyeye göre fiyat ve kâr.** Eşyalar seviye bantlarında fiyatlandı (20 CR'lik fincandan
  1.200 CR'lik mermer büste). Her seviyede kâr oranı artıyor: 1. seviye fiyatın 1,05 katını,
  7. seviye 1,30 katını öder. Bir sonraki aleti almak her zaman kazandırır.
- **Yeni alet fiyatları:** Tava 140, Beyzbol Sopası 300, Çekiç 700, Boru Anahtarı 1.200, Levye 2.000,
  Balyoz 3.000 CR. Ekonomi simülatörüne göre balyoz iyi bir oyuncuda 20., ortalama bir oyuncuda
  28. dakikada geliyor.
- **Mağaza yalnızca kırabildiğini satar.** Eşya Mağazası stoğu seviye gruplarında gösteriyor.
  Kilitli seviyeler listede görünüyor ama gereken alet alınana kadar satın alınamıyor (tezgâhta
  bekleyen alet de sayılır). Her eşyanın kartında seviyesi, gereken alet, kazancı ve kârı yazıyor.
  Alet kartında da açtığı seviye ve o seviyenin eşyaları listeleniyor.
- **Her aşama para kazandırır.** İlk gerçek hasar değerin %10'unu (HASAR), kırılma %25'ini
  (KIRILDI), parçalanma kalanını (PARÇALANDI) öder. Tek vuruşta birden fazla aşama geçilirse tek
  balonda toplanır. Temizlik, kombo, tek vuruş, zincir ve oda boşaltma primleri aynen devam ediyor.
- **Koleksiyon.** 36 tür eşyanın her birini ilk kez kırınca değerinin %50'si kadar "İLK KEZ!"
  bonusu, hepsini kırınca 2.500 CR koleksiyon ödülü. Mağazada ✓ (koleksiyonda) ve ★ (yeni tür)
  işaretleri var.
- **Hedef göstergesi.** Para göstergesinin altında hep bir hedef duruyor. Önce bir sonraki alet:
  ne kadar biriktiğin, hangi seviyeyi ve kaç eşyayı açacağı; alınabilir olunca yeşile döner.
  Bütün aletler alınınca hedef koleksiyon olur. Koleksiyon sayacı da hep görünür.
- **Seviye açıldı.** Yeni seviye açan bir aleti tezgâhtan alınca "SEVİYE N AÇILDI · X yeni eşya"
  duyurusu çıkıyor.
- Kırma oturumu yalnızca gücünün yettiği eşyaları sayıyor: kilitli eşyalar varken de oda
  "boşalabiliyor". Odada kilitli eşya varsa kırma başlarken kaç tane olduğu ve hangi aletin
  gerektiği söyleniyor. Sağlık çubuğunda eşyanın seviyesi ve gerekiyorsa kilit satırı görünüyor.
- Başlangıç odasında 2, sokakta 5 eşya yumruğun gücünü aşıyor: ilk hedefler en baştan görünüyor.

### Eklendi

- Ana menüde, profil ekranında, yükleme ekranında ve demo sonu ekranında "© 2026 MeMoDe · Tüm
  hakları saklıdır" ve "Powered by MeMoDe · sürüm" yazıları. README'ye telif bölümü eklendi.

### Bilinen

- Tabure sopayla yakından kırılınca küçük bir kırıntı bazen arka duvardan dışarı kaçıyor. Kırıntı
  toplanmıyor, kayda yazılmıyor ve kırma bitince diğerleriyle birlikte siliniyor.

## 0.1.1 (2026-10-01)

### Düzeltildi

- **Aletler artık elde gerçekten sallanıyor.** Sopa, tava, çekiç, anahtar, levye ve balyoz vurunca
  hasar veriyordu ama görünen alet yerinden kıpırdamıyordu. Şimdi her alet geri çekilir, hedefe iner
  ve vuruşta geri teper. Yumruklar eskisi gibi sağ ve sol elle sırayla atılır.
- **Temizlikte kazanılan para görünüyor.** Konteynere atılan her parçanın parası, konteynerin
  üstünde "+N CR · TEMİZLİK" olarak çıkıyor ve ödül sesi çalıyor. Aynı anda düşen parçalar tek
  balonda toplanıyor.
- **Konteynere sağlam eşya atınca neden bir şey olmadığı söyleniyor.** Konteyner yalnızca kırık
  parçaları alır; sağlam bir eşya atınca "önce kır" notu çıkıyor.

### Kaldırıldı

- **Depo (DEL ve I tuşları).** Kafa karıştırıyordu ve aynı işi görmenin daha basit bir yolu var:
  kırılmasını istemediğin eşyayı E ile alıp sokağa taşıman yeterli. Eski bir kayıtta depoda eşya
  varsa, kayıt yüklenince bu eşyalar bir kez sokaktaki teslim alanına (eşya mağazasının önü) gelir,
  hiçbiri kaybolmaz.

### Eklendi

- Ana menüde sürüm numarası.
- Geliştirici test aracına `qa.feedbackAudit()`: bütün aletlerin elde sallandığını, tekmede botun
  göründüğünü ve konteynerin hem parçaya hem sağlam eşyaya doğru tepki verdiğini kontrol eder.
  Test aracı artık hep kendi "QA" profilinde çalışır, oyuncunun kayıtlarına dokunmaz.

## 0.1.0 (2026-10-01)

İlk yayın: birinci şahıs, fizik tabanlı öfke odası demosu.

- Kırma odası ve sokak; DÜZENLE, KIR ve TEMİZLE modları.
- 40 etkileşimli eşya ve 7 alet; eşyalar vurulduğu yerden parçalanır, büyük parçalar yeniden kırılır.
- Kalıcı dünya: kırılan her şey temizlenene kadar odada kalır. Profil başına 3 kayıt yuvası.
- Ekonomi: kırarak ve temizleyerek kazan, dükkânlardan alet ve eşya al. Siparişler fiziksel olarak
  teslim edilir.
- Eğilme, ters Y ekseni, zemine göre değişen adım sesleri, oda yankısı, demo sonu ekranı.
