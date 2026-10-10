# Test Senaryoları

1. Var olmayan library kökü "Oluştur" onayıyla oluşturulur ve kaydedilir
Adımlar:
1. `PP_CONFIG` ile geçici bir ayar dosyası göster (ayar dosyası yok) ve sunucuyu başlat: `$env:PP_CONFIG="$env:TEMP\pp-deneme.json"; node tools/ui/server.js --open`
2. Kurulum ekranında Ayarlar penceresini aç.
3. Library kökü olarak diskte olmayan bir yol yaz (örn. `C:\demo\olmayan\kok`).
4. Kaydet'e bas.
5. Çıkan onayda "Oluştur"u seç.
Beklenen: Klasör diskte oluşur, ayar kaydedilir ve kurulum ekranında "Library kökünde hiç marketplace yok" mesajıyla "Yeni marketplace…" düğmesi görünür. Onay sonrası ikinci istek (`create:true`) gönderilir.
