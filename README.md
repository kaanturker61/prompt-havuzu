# Prompt havuzu

Promptlarını tek yerde topla, ara, düzenle, git ile geçmişini tut ve istersen Claude Code marketplace'i olarak projelerine dağıt.

## Başlatma

Gereken: Node.js 18 veya üstü, git (geçmiş için). Başka kurulum yok.

1. Windows: `start.bat` dosyasına çift tıkla
2. macOS/Linux: `./start.sh`
3. Elle: `node tools/ui/server.js --open` (port 4317, doluysa sonraki boş port)

Arayüz yalnızca bu bilgisayardan erişilebilir (127.0.0.1). Durdurmak için terminalde Ctrl+C.

## İlk kullanım

Promptlar araç klasörünün dışında, bir **library kökünde** tutulur. Kökün altındaki her klasör ayrı bir marketplace, yani ayrı bir git deposudur.

1. İlk açılışta "Kuruluma devam et" ekranı çıkar. **Ayarlar**'ı aç, library kökünü seç. Windows'ta `D:\` sürücüsü varsa orada bir library klasörü önerilir. Klasör yoksa oluşturulmasını onaylarsın. Araç klasörünün içi seçilemez.
2. Ayarlar'dan **Yeni marketplace** oluştur (örn. `ornek-promptlar`). Git deposu (dal `main`) ve iskelet dosyaları hazırlanır, otomatik commit atılmaz. Git deposu olmayan mevcut bir klasörü de seçip "Git'i başlat" diyebilirsin.
3. Üst çubuktaki seçiciden etkin marketplace'i değiştirirsin. Git paneli her zaman etkin marketplace'in deposuna çalışır.
4. **İçe aktar**: eski `.txt` klasörünün yolunu gir, dosyaları seç. Taslak olarak `prompts/gelen-kutusu` altına yazılır, orijinallere dokunulmaz.
5. Promptları klasörlere taşı (sağ tık veya `⋯` menüsü), etiketle.
6. **Git** panelinden değişiklikleri commit et. Her promptun **Geçmiş** sekmesinde farkları görür, eski sürümü editöre alabilirsin.
7. **Marketplace**: promptu açıp "Claude Code yayın ayarları" bölümünden türünü seç, sonra panelden yayınla.

Kullanıcı ayarları (library kökü, etkin marketplace) şu dosyada tutulur; yolu Ayarlar penceresinde de görünür:

1. Windows: `%APPDATA%\prompt-havuzu\config.json`
2. macOS: `~/Library/Application Support/prompt-havuzu/config.json` (`XDG_CONFIG_HOME` varsa `$XDG_CONFIG_HOME/prompt-havuzu/config.json`)
3. Linux: `$XDG_CONFIG_HOME/prompt-havuzu/config.json`, yoksa `~/.config/prompt-havuzu/config.json`
4. `PP_CONFIG=<dosya>` ortam değişkeni bunların hepsini geçersiz kılar.

## Klasör yapısı

Library kökü altında, her marketplace klasöründe (ayrı git deposu):

1. `prompts/`: tek kaynak. Her prompt bir `.md` dosyası.
2. `plugins/` ve `.claude-plugin/`: yayınlayınca otomatik üretilir. Elle düzenleme, kaynakta düzenle.
3. `.pp/trash/`: silinenler buraya taşınır (git'e girmez).
4. `pp.config.json`: marketplace ayarları (arayüz yazar).

## Prompt dosyası alanları

Hepsi isteğe bağlı. Tanımadığımız alanlara dokunulmaz.

1. `baslik`, `etiketler`, `projeler`, `durum` (taslak, kararlı, arşiv), `versiyon`, `olusturma`
2. `tur`: `komut`, `ajan` veya `skill` yazarsan yayınlanabilir olur
3. `paket`: hangi pluginin içine gireceği. Projelere sadece ihtiyacın olan paketi kurmak için kullan
4. `komut_adi`, `aciklama`, `arguman_ipucu`, `izinli_araclar`, `model`: Claude Code dosyasına dönüştürülür

Metin içinde `{{degisken}}` yazarsan **Kopyala** düğmesi değerleri sorar ve doldurup panoya koyar.

## Projelerde kullanım

Marketplace panelinde komutlar hazır gelir. Özeti:

1. Bir kez: `claude plugin marketplace add <marketplace klasörü>`
2. Her projede: `claude plugin install <paket>@<marketplace>`
3. Promptları değiştirince: panelden yayınla, projelerde `claude plugin marketplace update <marketplace>`
4. Doğrulamak için: `claude plugin validate <marketplace klasörü>`

Komut söz dizimi Claude Code sürümüne göre değişebilir. Şüphede `claude plugin --help` çalıştır.

## Kısayollar

1. Ctrl+S: kaydet
2. Ctrl+K: aramaya git
3. Esc: pencereyi kapat

## Lisans

MIT. Ayrıntı için `LICENSE` dosyasına bak.
