# Sürüm notları

Her yayın sürümü bir artırır ve buraya yazılır. Oyunun ana menüsünün sağ alt köşesinde çalışan
sürüm görünür.

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
