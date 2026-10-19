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

15. İçe aktarılan dosyaya dil ne olursa olsun frontmatter yazılmaz
Adımlar:
1. İçinde metin olan `idea.txt` dosyasını İngilizce arayüzle içe aktar.
2. Oluşan prompt'un ham metnine ve ağaçtaki adına bak.
3. Aynısını Türkçe arayüzde `ilk.txt` ile yap.
Beklenen: İki dosyada da frontmatter yoktur (`baslik`, `durum`, `olusturma` yazılmaz). Ağaçta ve aramada dosya adı (`idea`, `ilk`) görünür.

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

19. Yeni marketplace pp.config.json oluşturmaz
Adımlar:
1. Ağaçtaki "+ Marketplace" ile "deneme-10" adında boş bir marketplace oluştur.
2. Dosya gezgininde marketplace klasörünü aç; Git panelini aç.
Beklenen: Klasörde `pp.config.json` ve `library/` yok; `.claude-plugin/marketplace.json`, `prompts/.gitkeep`, `README.md`, `.gitignore`, `.gitattributes` var. Uyarı bandında `pp.config.json` ile ilgili uyarı yok.

20. Paket yayını pp.config.json yazmaz
Adımlar:
1. "deneme-10"da "ornek" plugin'ini oluştur, içine `tur: komut` olan bir prompt ekle.
2. Tüm değişiklikleri commit et.
3. Paket sayfasında "Yayınla".
4. `git log -1 --stat` çıktısına bak.
Beklenen: Commit yalnızca `plugins/ornek/...` ve `.claude-plugin/marketplace.json` içerir. `pp.config.json` oluşmaz. `marketplace.json` içinde katalog sürümü `1.0.1` olur. `paket/ornek/v1.0.0` tag'i atılır.

21. Katalog sürümü marketplace.json'dan okunur ve oraya yazılır
Adımlar:
1. Marketplace panelini aç.
2. "Katalog sürümü" alanını `2.0.0` yap ve "Marketplace dosyalarını yaz".
3. `marketplace.json` dosyasını aç; paneli kapatıp yeniden aç.
Beklenen: `marketplace.json` `version` (ya da varsa `metadata.version`) `2.0.0` olur. `pp.config.json` oluşmaz. Panel `2.0.0` gösterir.

22. Marketplace ayarlar formu sadeleşir
Adımlar:
1. Marketplace panelini aç.
2. Ad, sahip ve açıklamayı değiştirip "Marketplace dosyalarını yaz".
Beklenen: Formda yalnızca ad, sahip, katalog sürümü ve açıklama var; "Klasörsüz promptlar için paket" ve "Dışa aktarılacak durumlar" yok. `marketplace.json` `name`, `owner.name` ve `description` güncellenir. Kurulum komutundaki `@<ad>` yeni addır.

23. Plugin açıklaması kaynak klasörde tutulur
Adımlar:
1. "+ Plugin" ile "kod-inceleme" plugin'ini "Kod inceleme komutları" açıklamasıyla oluştur.
2. Ağaçta plugin'in üzerine gel; paket sayfasını aç.
3. Açıklamayı paket sayfasından değiştir.
Beklenen: `prompts/kod-inceleme/.claude-plugin/plugin.json` oluşur ve yalnızca `description` içerir. Ağaçta `.claude-plugin` klasörü görünmez. İpucunda ve paket sayfasında açıklama görünür; değişiklik aynı dosyaya yazılır. `pp.config.json` oluşmaz.

24. Plugin açıklaması yayına yansır
Adımlar:
1. 23. senaryodaki plugin'e `tur: komut` olan bir prompt ekle ve commit et.
2. "Yayınla".
3. Açıklamayı değiştirip commit et, paket sayfasına bak.
Beklenen: `plugins/kod-inceleme/.claude-plugin/plugin.json` `description` değeri kaynak açıklamayla aynıdır. 3. adımdan sonra paket sayfası yama artışı ve "açıklama değişti" nedenini gösterir.

25. Açıklamasız plugin ek dosya yazmaz
Adımlar:
1. Açıklama vermeden "+ Plugin" ile "bos-aciklama" oluştur.
Beklenen: `prompts/bos-aciklama/` altında yalnızca `.gitkeep` vardır; `.claude-plugin` oluşmaz.

26. Plugin yeniden adlandırılınca açıklama korunur
Adımlar:
1. "kod-inceleme" plugin'ini "inceleme" olarak yeniden adlandır.
Beklenen: Açıklama ağaçta ve paket sayfasında korunur. `prompts/inceleme/.claude-plugin/plugin.json` yeni klasördedir.

27. Eski pp.config.json uyarısı ve çöpe taşıma
Adımlar:
1. `pp.config.json` dosyası olan bir marketplace'i etkinleştir.
2. Uyarı bandındaki "Sil (çöp kutusuna taşı)" düğmesine bas ve onayla.
3. Git panelinden yalnızca silinen `pp.config.json`'u seçip commit et.
Beklenen: Uyarı, dosyanın artık kullanılmadığını ve ayarların nereden okunduğunu anlatır. Dosya `.pp/trash` altına taşınır, uyarı bandı kalkar. Commit yalnızca silmeyi içerir.

28. Eski pp.config.json değerleri yok sayılır
Adımlar:
1. Bir marketplace'in `pp.config.json` dosyasına elle `libraryDir: "library"`, `export.durumlar: ["taslak"]`, `marketplace.version: "9.9.9"` yaz.
2. Sayfayı yenile; ağaca, durumu "taslak" olan bir komut promptunun yayın notuna ve Marketplace paneline bak.
Beklenen: Ağaç `prompts/` içeriğini gösterir, `library/` oluşmaz. Taslak prompt "yalnızca kararlı ve (boş) durumlar dışa aktarılır" bilgisini gösterir. Katalog sürümü `marketplace.json` değerini gösterir (`9.9.9` değil). Eski dosya uyarısı görünür.

29. pp.config.json teknik dosya olarak silinebilir
Adımlar:
1. Teknik dosyalar altında `pp.config.json`'a sağ tıkla.
Beklenen: Menüde "Yeniden adlandır" ve "Sil (çöp kutusuna taşı)" görünür. `plugins/`, `.claude-plugin/`, `.gitignore` için bu menü öğeleri hâlâ gizlidir.

30. Klonlanan depo ayar dosyası istemez
Adımlar:
1. `pp.config.json` içermeyen bir marketplace deposunu "Uzak depodan klonla" ile ekle ve etkinleştir.
2. Klon sonucu penceresine ve dosya gezginine bak; `git status` çalıştır.
Beklenen: "Ayar dosyası oluştur" düğmesi ve ayar dosyası uyarısı yok. `pp.config.json` ve `library/` oluşmaz; `git status` temiz kalır. Marketplace adı `marketplace.json`'daki addır (klasör adı farklı olsa bile).

31. Ayar dosyası olmayan marketplace'e taşıma
Adımlar:
1. 30. senaryodaki klonda `prompts/p` klasörünü oluştur.
2. Etkin marketplace'ten bir promptu "Taşı" ile bu hedefin `p` plugin'ine taşı.
Beklenen: Taşıma başarılı olur, ayar dosyası hatası çıkmaz. Hedefte commit atılmaz, kaynakta dosya `.pp/trash`'e gider.

32. Bozuk marketplace.json yazmayı engeller
Adımlar:
1. Etkin marketplace'in `.claude-plugin/marketplace.json` içeriğini `garip{` yap.
2. Sayfayı yenile; Marketplace panelini aç; "Yayınla", "Marketplace'i güncelle" ve "Marketplace dosyalarını yaz" dene.
3. Yeni bir plugin oluştur.
4. Dosyayı Teknik dosyalardan düzelt.
Beklenen: Uyarı bandında ve panelde "marketplace.json okunamadı" uyarısı çıkar. Üç yazma işlemi 409 ile reddedilir, dosya bayt bayt aynı kalır. Plugin oluşturma çalışır. Düzeltince uyarı kalkar.

33. Dışarıyı gösteren prompts bağlantısı
Adımlar:
1. (Windows) Etkin marketplace'te `prompts/` klasörünü kaldırıp marketplace dışındaki bir klasöre junction olarak yeniden oluştur (`mklink /J`).
2. Sayfayı yenile; ara; plugin oluşturmayı dene.
Beklenen: `libraryDirGecersiz` uyarısı çıkar. Dış klasördeki dosyalar ağaçta ve aramada görünmez. Plugin oluşturma 409 ile reddedilir; dış klasöre hiçbir şey yazılmaz.

34. Ayar uyarıları iki dilde
Adımlar:
1. 27, 32 ve 33. senaryolardaki uyarıları TR/EN kısayoluyla iki dilde görüntüle.
Beklenen: `ppConfigEski`, `manifestBozuk`, `libraryDirGecersiz` ve `pluginJsonBozuk` iletileri iki dilde tam cümledir. Düğme etiketi "Sil (çöp kutusuna taşı)" / "Delete (move to trash)". İngilizce metinde Türkçe harf yoktur.

35. Mevcut marketplace'lerin geçişi
Adımlar:
1. `pp.config.json`'u olan mevcut marketplace'leri sırayla etkinleştir; ağaç, arama ve paket sayfalarını kontrol et.
2. `pp.config.json`'daki katalog sürümü `marketplace.json`'dakinden farklı olan marketplace'te Marketplace panelinden doğru sürümü yazıp "Marketplace dosyalarını yaz"; değişikliği commit et.
3. Her marketplace'te `pp.config.json`'u uyarı düğmesiyle çöpe taşı ve (izleniyorsa) commit et.
Beklenen: Promptlar, plugin'ler ve yayın durumları değişmeden görünür. Yayınlanmış plugin'lerin açıklaması paket sayfasında görünür. 3. adımdan sonra hiçbir marketplace'te uyarı kalmaz.

36. Prompt türü seçilince yayın alanları gizlenir ve tur: prompt yazılır
Adımlar:
1. `tur: komut` olan, `description` ve `model` alanları dolu bir prompt aç.
2. "Claude Code yayın ayarları" bölmesinde Tür listesinden "Prompt (yayınlanmaz)" seç.
3. Kaydet, Ham metin sekmesine geç.
Beklenen: Alan listesi kaybolur, rozet "Yayın dışı" olur, uyarı çıkmaz, onay penceresi açılmaz. Dosyada `tur: prompt` yazar; `description` ve `model` satırları yerinde kalır. Paket sayfasında prompt "hariç" listesinde "Prompt türü: Claude Code'a yayınlanmaz." gerekçesiyle görünür.

37. Türü boş eski dosya örtük Prompt olarak görünür ve dosya değişmez
Adımlar:
1. Frontmatter'ında `tur` olmayan, yayın alanı da olmayan bir prompt aç.
2. Tür listesine bak, listeyi aç; hiçbir şeyi değiştirmeden başka dosyaya geç.
Beklenen: Seçicide "Prompt (tür yazılmamış)" görünür, açılan listede yalnızca Prompt / Komut / Ajan / Skill vardır. Dosya kirli sayılmaz, diskte değişiklik olmaz. Ağaçta tür rozeti ve "!" yoktur.

38. Türü boş ama yayın alanı dolu dosyada uyarı Prompt seçilince kalkar
Adımlar:
1. Ham metinde `tur` satırını silip `aciklama: x` bırak, kaydet.
2. Düzenle sekmesinde uyarı bandını oku, ağaçtaki "!" rozetine bak.
3. Tür listesinden "Prompt (yayınlanmaz)" seç ve kaydet.
Beklenen: 2. adımda `turYok` uyarısı (alan adıyla) ve "!" görünür, paket sayfasında paket engellidir. 3. adımdan sonra uyarı, rozet ve engel kalkar; dosyada `tur: prompt` yazar.

39. Komut türünde değer girilince satır İngilizce anahtarla eklenir, boşaltılınca silinir
Adımlar:
1. Yeni boş bir prompt oluştur, Tür olarak "Komut (slash command)" seç.
2. `argument-hint` alanına `[konu]` yaz; "Diğer Claude Code alanları"nı açıp `effort` için `high` seç.
3. Ham metne bak; sonra `argument-hint` alanını boşalt, `effort`'u "(boş: varsayılan)" yap ve tekrar Ham metne bak.
Beklenen: Etiketler `argument-hint`, `effort` gibi gerçek anahtar adlarıdır ve altlarında açıklama vardır. İlk bakışta `argument-hint: "[konu]"` ve `effort: high` satırları vardır; boşaltınca ikisi de silinir, boş satır kalmaz.

40. Tür değişince alan kümesi değişir ve kullanılmayan alanlar notu çıkar
Adımlar:
1. Komut türündeki bir prompta `allowed-tools` ve `disable-model-invocation` değeri gir.
2. Türü "Skill" yap, sonra "Ajan (subagent)" yap.
Beklenen: Skill'de `paths` alanı da görünür, komutta görünmez. Ajanda `tools`, `maxTurns`, `memory`, `color` gibi alanlar görünür; `allowed-tools` ve `disable-model-invocation` "Dosyada olup bu türde yayına girmeyen alanlar" notunda listelenir. Ajan için `permissionMode`, `mcpServers`, `hooks` ve `initialPrompt` yok sayılır notu görünür. Odak tür listesinde kalır.

41. Boolean, liste ve sayı alanları doğru YAML biçiminde yazılır
Adımlar:
1. Skill türünde `user-invocable` için `false` seç, `paths` alanına iki satır yaz: `src/**/*.{ts,tsx}` ve `lib/**`.
2. Türü Ajan yapıp `maxTurns` için `12` yaz, `skills` alanına iki satırda `a` ve `b` yaz.
3. Ham metne bak.
Beklenen: `user-invocable: false` (tırnaksız), `paths: ["src/**/*.{ts,tsx}", lib/**]`, `maxTurns: 12`, `skills: [a, b]`. Virgül içeren glob tek öğe kalır.

42. Eski Türkçe anahtarlar kaydedilirken biçim korunarak İngilizceye taşınır
Adımlar:
1. Diskte `aciklama: "Kod: inceleme"   # not`, `arguman_ipucu: [dosya]` ve `izinli_araclar: Read` satırları olan bir komut promptu hazırla (CRLF satır sonlu).
2. Düzenle sekmesinde `description` alanında eski değerin göründüğünü kontrol et; yalnızca etiket ekleyip kaydet.
3. `git diff` ile değişikliğe bak.
Beklenen: Alanlar eski değerleri gösterir. Farkta yalnızca anahtar adları değişir (`description`, `argument-hint`, `allowed-tools`); değer, tırnak, yorum ve CRLF korunur; satır sırası değişmez. Etiket satırı eklenir.

43. Yalnızca eski alanlı paketin çıktısı değişmez ve sürüm artışı önerilmez
Adımlar:
1. Güncellemeden önce yayınlanmış, yalnızca eski Türkçe alanlı promptları olan bir paket seç.
2. Güncellenmiş araçla paket sayfasını aç; ardından "Marketplace'i güncelle"yi çalıştır.
3. `git status` ve `git diff plugins/` çıktısına bak.
Beklenen: Paket sayfası "değişiklik yok" der, sürüm önerisi yoktur. `plugins/` altında hiçbir bileşen dosyası değişmez. Aynı paketteki bir prompt 42. senaryodaki gibi taşınıp commit'lense de sonuç aynıdır.

44. Yeni Claude Code alanları çıktıya girer ve plugin doğrulamasından geçer
Adımlar:
1. Bir skill promptuna `when_to_use`, `disable-model-invocation: true` ve `effort: low` gir, commit'le.
2. Paketi yayınla; `plugins/<paket>/skills/<ad>/SKILL.md` dosyasını aç.
3. `claude plugin validate <marketplace klasörü>` çalıştır.
Beklenen: `SKILL.md`'de `name`, `description`, varsa `argument-hint`/`allowed-tools`/`model`, ardından `when_to_use`, `disable-model-invocation: true`, `effort: low` sırası vardır; aracın `tur`, `paket`, `baslik`, `durum`, `versiyon`, `etiketler` alanları yoktur. Doğrulama hatasız geçer.

45. Ham metinde yazılan hooks skill çıktısına aynen girer, ajanda girmez
Adımlar:
1. Bir skill promptuna Ham metin sekmesinden girintili bir `hooks` bloğu ekle, kaydet, yayınla.
2. Aynı bloğu ve `permissionMode: plan` satırını bir ajan promptuna ekle, yayınla.
Beklenen: Skill çıktısında `hooks` bloğu girintisiyle aynen bulunur. Ajan çıktısında `hooks` ve `permissionMode` yoktur; editörde ikisi "yayına girmeyen alanlar" notunda listelenir.

46. Yeni prompt baslik, durum ve olusturma yazmaz
Adımlar:
1. "+ Prompt" ile "Kod İnceleme" adıyla, etiketsiz ve "Boş" şablonla prompt oluştur.
2. Aynısını "Claude Code komutu" şablonu ve "a, b" etiketleriyle tekrarla.
3. İki dosyanın Ham metnine bak.
Beklenen: Diyalogda "Dosya: kod-inceleme.md" önizlemesi görünür. İlk dosyada frontmatter yoktur. İkincide yalnızca `etiketler: [a, b]`, `tur: komut` ve `argument-hint: "[argüman]"` vardır; `baslik`, `durum` ve `olusturma` yoktur.

47. İçe aktarma frontmatter yazmaz, "---" ile başlayan metin bozulmaz
Adımlar:
1. Bir klasöre `fikir.txt` (düz metin) ve ilk satırı `---` olan `cizgi.txt` koy.
2. "İçe aktar" ile ikisini bir plugin'e aktar, oluşan dosyaları aç.
Beklenen: `fikir.md` yalnızca metni içerir (baştaki boş satır yok). `cizgi.md` boş satırla başlar, editörde "frontmatter kapanmamış" uyarısı çıkmaz, metnin tamamı gövdede görünür.

48. Başlıksız prompt her yerde dosya adıyla görünür
Adımlar:
1. 46. senaryodaki başlıksız prompta ağaçta, aramada ("kod") ve ön sayfadaki "Son değişenler"de bak.
2. Editörde başlık kutusuna "Kod İnceleme" yaz, kaydet; sonra kutuyu boşaltıp kaydet.
Beklenen: Ağaç, arama ve son değişenler `kod-inceleme` gösterir (ağaçta `.md` uzantısı yoktur). Başlık yazılınca her yerde başlık görünür; boşaltılınca `baslik` satırı silinir ve dosya adı geri gelir.

49. Ön sayfa ve tür filtresi Prompt'u gösterir
Adımlar:
1. Ön sayfadaki tür karosuna bak.
2. Sol filtreden tür olarak "Prompt" seç.
Beklenen: Karoda Komut, Ajan, Skill ve Prompt sayıları vardır. Filtre türü boş, `tur: prompt` ya da tanınmayan türdeki promptları listeler; durum karosunda yeni promptlar "Durumu boş" altında sayılır.

50. Geçmiş sekmesinde Claude Code anahtarları gerçek adıyla görünür
Adımlar:
1. 42. senaryodaki promptta, taşımadan önceki ve sonraki iki sürümü (+1 ile) oluştur.
2. Geçmiş sekmesinde iki sürümü karşılaştır.
Beklenen: Alan tablosunda `aciklama` ve `description` satırları kod biçiminde (çevrilmeden) görünür; Başlık, Etiketler gibi araç alanları çevrilmiş etiketle görünür.

51. İngilizce arayüzde etiketler aynı, ipuçları İngilizce
Adımlar:
1. Üst çubuktan EN seç.
2. Bir ajan promptunun yayın ayarlarını ve "More Claude Code fields" bölmesini aç.
3. Prompt seç ve kaydet.
Beklenen: Alan etiketleri yine `description`, `maxTurns` gibi gerçek adlardır; ipuçları ve notlar İngilizcedir. Seçici "Prompt (not published)" gösterir, dosyaya yine `tur: prompt` yazılır.

52. Klavye ve ekran okuyucu ile alan kullanımı
Adımlar:
1. Yalnızca klavyeyle tür listesine gel, Skill seç; Tab ile alanlarda ilerle.
2. "Diğer Claude Code alanları" özetini Enter ile aç.
3. Ekran okuyucuyla bir alana odaklan.
Beklenen: Her alan etiketiyle, ardından ipucu metniyle (`aria-describedby`) okunur. Özet klavyeyle açılır. Tür değişince odak listede kalır. Hiçbir metin büyük harfe çevrilmez; Tür satırı ile alanların etiket ve girdi sütunları hizalıdır.

53. Prompt seçimi yayındaki çıktıyı kaldırır
Adımlar:
1. Yayında olan bir komut promptunu "Prompt (yayınlanmaz)" yap, kaydet, commit'le.
2. Paket sayfasını aç.
Beklenen: Çıktı dosyası "kaldırılacak" olarak görünür ve büyük sürüm önerilir.
