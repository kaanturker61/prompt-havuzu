# Test Senaryoları

1. Var olmayan library kökü "Oluştur" onayıyla oluşturulur ve kaydedilir
Adımlar:
1. `PP_CONFIG` ile geçici bir ayar dosyası göster (ayar dosyası yok) ve sunucuyu başlat: `$env:PP_CONFIG="$env:TEMP\pp-deneme.json"; node tools/ui/server.js --open`
2. Kurulum ekranında Ayarlar penceresini aç.
3. Library kökü olarak diskte olmayan bir yol yaz (örn. `C:\demo\olmayan\kok`).
4. Kaydet'e bas.
5. Çıkan onayda "Oluştur"u seç.
Beklenen: Klasör diskte oluşur, ayar kaydedilir ve kurulum ekranında "Library kökünde hiç marketplace yok" mesajıyla "Yeni marketplace…" düğmesi görünür. Onay sonrası ikinci istek (`create:true`) gönderilir.

2. Tarayıcı Türkçe iken ilk açılışta arayüz Türkçe açılır
Adımlar:
1. `PP_CONFIG` ile var olmayan bir ayar dosyası göster, sunucuyu başlat, tarayıcı dilini `tr-TR` yap.
2. Sayfayı aç (kurulum ekranı).
3. Sayfa kaynağında `<html lang>` değerine ve başlıklara bak.
Beklenen: Arayüz Türkçe, `<html lang="tr">`, kurulum iletileri Türkçe. Ayar dosyası bu adımda yazılmaz (`language` yok ya da `auto`).

3. Tarayıcı İngilizce iken ilk açılışta arayüz İngilizce açılır
Adımlar:
1. Yeni bir `PP_CONFIG` göster, tarayıcı dilini `en-US` yap.
2. Sayfayı aç.
3. Kurulum ekranındaki ileti, üst çubuk düğmeleri ve arama kutusu yer tutucusunu oku.
Beklenen: Tüm metinler İngilizce, `<html lang="en-US">`, kurulum iletisi İngilizce. Sunucu iletisi de İngilizce (istek `X-PP-Lang: en` taşır).

4. Ayarlar'dan dil değiştirilince sayfa yenilenir ve seçim kalıcı olur
Adımlar:
1. Türkçe arayüzde Ayarlar'ı aç, "Dil / Language" listesinden "English (US)" seç.
2. Sayfanın yenilendiğini ve bildirimin İngilizce çıktığını gözlemle.
3. Sunucuyu durdurup farklı bir portta (`--port 4400`) yeniden başlat, sayfayı aç.
4. `PP_CONFIG` dosyasında `language` değerine bak.
Beklenen: Yenilemeden sonra arayüz İngilizce, bildirim yeni dilde. Farklı portta da İngilizce açılır. `config.json` içinde `"language": "en"`.

5. Kaydedilmemiş değişiklik varken dil değişimi onay ister
Adımlar:
1. Bir prompt aç, gövdeye metin ekle (kaydetme).
2. Ayarlar'dan dili değiştir.
3. Çıkan onayda önce "Vazgeç"i, sonra tekrar deneyip "Kaydet ve devam et"i seç.
Beklenen: "Vazgeç"te dil ve sayfa değişmez, düzenleme korunur. "Kaydet ve devam et"te dosya kaydedilir, sayfa yeni dilde yenilenir. "Değişiklikleri at"ta değişiklik atılır, tarayıcı çıkış uyarısı çıkmaz.

6. Sunucu hata iletileri seçili dilde gelir
Adımlar:
1. Arayüz İngilizce iken yeni plugin adı olarak `claude-x` yaz ve oluştur.
2. Aynı plugin adını ikinci kez oluşturmayı dene.
3. Dili Türkçe'ye çevirip 1-2. adımları tekrarla.
Beklenen: İngilizce'de iletiler İngilizce, Türkçe'de bugünkü Türkçe iletiler. Alanın altındaki satır içi ileti ile toast aynı dilde.

7. Kural iletileri arayüzde canlı doğrulamada seçili dilde görünür
Adımlar:
1. İngilizce arayüzde "+ Marketplace" ile yeni marketplace penceresini aç.
2. Ad olarak `nul`, sonra `claude-code-plugins`, sonra boş yaz.
3. Dili Türkçe'ye çevirip tekrarla.
Beklenen: Her adımda ileti seçili dilde. İleti içindeki ad (`nul`) ve alan adları aynen görünür.

8. Veri sözleşmesi dilden etkilenmez
Adımlar:
1. Arayüz İngilizce iken yeni prompt oluştur (başlık "Test", şablon "Claude Code command").
2. Durum listesinden "Stable" seç, kaydet.
3. Dosyada frontmatter'ı aç.
4. Dili Türkçe'ye çevirip aynı dosyayı aç, Durum listesine bak.
Beklenen: Dosyada `baslik:`, `durum: kararlı`, `tur: komut`, `olusturma: YYYY-AA-GG` (ISO) ve diğer anahtarlar Türkçe kalır. Türkçe arayüzde Durum "Kararlı" görünür. Gövde şablonu İngilizce tohumlanır.

9. Paket yayını iki dilde aynı çıktıyı üretir
Adımlar:
1. Aynı içerikli iki kopya marketplace hazırla; kaynak promptları commit'le.
2. Birini Türkçe, diğerini İngilizce arayüzle paket sayfasından Yayınla (`1.0.0`).
3. `plugins/`, `.claude-plugin/` dosyalarını ve `git tag -l -n9`, `git log -1 --format=%s` çıktısını karşılaştır.
Beklenen: `plugins/**` dosyaları, `plugin.json`, `marketplace.json` ve tag adı (`paket/<ad>/v1.0.0`) iki durumda bayt bayt aynı. Yalnızca commit konusu ve tag notu açıklama cümleleri arayüz dilinde.

10. Prompt +1 sürümü dilden bağımsız tag ve commit konusu üretir
Adımlar:
1. İngilizce arayüzde bir prompt'ta +1 -> Patch, not yaz, oluştur.
2. Türkçe arayüzde başka bir prompt'ta aynısını yap.
3. `git log --format=%s`, `git tag -l "prompt/*"` çıktılarına bak.
Beklenen: Konu `ad v1.0.0`, tag `prompt/<ad>/v1.0.0`; iki dilde aynı biçim. Sürüm penceresi seviye etiketleri seçili dilde (Patch / Yama).

11. Tarih ve saat seçili dilin biçiminde gösterilir
Adımlar:
1. Geçmiş sekmesinde ve Git panelinde bir commit listesini aç.
2. Aynı kaydın tarihini Türkçe ve İngilizce arayüzde karşılaştır.
3. Uzak depo kontrolü sonrası "Son kontrol" saatine bak.
Beklenen: Türkçe `tr-TR` (örn. 15 Eki 2026 15:45), İngilizce `en-US` (örn. Oct 15, 2026, 3:45 PM). Yeni prompt'un `olusturma` alanı dilden bağımsız ISO tarih.

12. Çoğul biçimler
Adımlar:
1. İngilizce arayüzde tek commit'li ve çok commit'li bir dosyanın Git panelindeki sayacına bak.
2. Tek ve çok sonuçlu bir arama yap.
3. Tek ve çok yayınlanmayan prompt için ağaçtaki uyarı ipucuna bak.
Beklenen: "1 commit" / "2 commits", "1 prompt will not be published" / "2 prompts will not be published". Türkçede sayıdan sonra çoğul eki yok ("2 commit").

13. Çoklu sekmede her sekme kendi dilinde hata alır
Adımlar:
1. Aynı adreste iki sekme aç (ikisi de Türkçe).
2. Sekme A'da dili İngilizce yap (sekme A yenilenir). Sekme B'yi yenileme.
3. Sekme B'de aynı adda plugin oluşturmayı dene.
Beklenen: Sekme B hâlâ Türkçe ve hata iletisi Türkçe (istek `X-PP-Lang: tr`). Sekme A'daki aynı işlem İngilizce ileti verir. Sekme B yenilenince İngilizce olur.

14. Kurulum iletileri ve önbellek dil değişiminde bayatlamaz
Adımlar:
1. Kurulum ekranında (library kökü ayarsız) Türkçe iletiyi oku.
2. Dili İngilizce yap (sayfa yenilenir).
3. Library kökü olarak araç reposunun içinde bir klasör yaz ve kaydetmeyi dene.
4. Uzak depo olmayan bir marketplace'te "Kontrol et" ile hata üret, dili değiştir, uygulamayı yeniden başlat.
Beklenen: Kurulum iletileri yeni dilde (önbellekten Türkçe gelmez). `.git/pp-state.json` içinde `lastCheck` için `error` metni yok, ileti açılışta seçili dilde üretilir.

15. İngilizce arayüzde içe aktarılan başlıklar doğru büyük harfle başlar
Adımlar:
1. İçinde metin olan `idea.txt` dosyasını İngilizce arayüzle içe aktar.
2. Oluşan prompt'un `baslik` alanına bak.
3. Aynısını Türkçe arayüzde `ilk.txt` ile yap.
Beklenen: İngilizce: `baslik: Idea`. Türkçe: `baslik: İlk`.

16. Arama ve sıralama dilden bağımsız
Adımlar:
1. `Işık`, `ışık`, `Isik` başlıklı üç prompt oluştur.
2. İngilizce ve Türkçe arayüzde `isik` ve `IŞIK` ara.
3. Plugin ve marketplace listesinin sırasına bak, dili değiştir.
Beklenen: Arama sonuçları iki dilde aynı. Ağaç sırası dil değişince değişmez.

17. Erişilebilirlik ve yerleşim
Adımlar:
1. Arayüz İngilizce iken Ayarlar, Marketplace paneli, paket sayfası ve Git panelini aç; pencereyi dar (<=700 px) yap.
2. Geliştirici araçlarında `aria-label`, `title`, `placeholder` değerlerine ve `<html lang>`'a bak.
3. Koyu ve açık temada tekrarla.
Beklenen: Düğme ve etiket metinleri taşmaz / kesilmez. Erişilebilirlik öznitelikleri İngilizce, `lang="en-US"`. Türkçeye dönünce `lang="tr"`.

18. Eksik çeviri anahtarı Türkçe yedeğe düşer (otomatik test)
Adımlar:
1. `npm test --prefix tools/ui` içindeki `i18n.test.js` çalıştırılır (motor testi `en` sözlüğünde olmayan bir anahtarı sorar).
Beklenen: İleti Türkçe sözlükten döner, o da yoksa anahtar metni; kilitleme testi gerçek sözlüklerde eksik anahtar bulmaz.
