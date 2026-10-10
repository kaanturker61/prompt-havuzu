# Prompt havuzu

Promptlarını tek yerde topla, ara, düzenle, git ile geçmişini tut ve istersen Claude Code marketplace'i olarak projelerine dağıt.

## Başlatma

Gereken: Node.js 18 veya üstü, git (geçmiş için). Başka kurulum yok.

1. Windows: `start.bat` dosyasına çift tıkla
2. macOS/Linux: `./start.sh`
3. Elle: `node tools/ui/server.js --open` (port 4317, doluysa sonraki boş port)

Arayüz yalnızca bu bilgisayardan erişilebilir (127.0.0.1). Durdurmak için terminalde Ctrl+C.

## İlk kullanım

1. **İçe aktar**: eski `.txt` klasörünün yolunu gir, dosyaları seç. Taslak olarak `library/gelen-kutusu` altına yazılır, orijinallere dokunulmaz.
2. Promptları klasörlere taşı (sağ tık veya `⋯` menüsü), etiketle.
3. **Git** > "Git deposunu başlat", sonra değişiklikleri commit et. Her promptun **Geçmiş** sekmesinde farkları görür, eski sürümü editöre alabilirsin.
4. **Marketplace**: promptu açıp "Claude Code yayın ayarları" bölümünden türünü seç, sonra panelden yayınla.

## Klasör yapısı

1. `library/`: tek kaynak. Her prompt bir `.md` dosyası.
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

1. Bir kez: `claude plugin marketplace add <havuz klasörü>`
2. Her projede: `claude plugin install <paket>@<marketplace>`
3. Havuzu değiştirince: panelden yayınla, projelerde `claude plugin marketplace update <marketplace>`
4. Doğrulamak için: `claude plugin validate <havuz klasörü>`

Komut söz dizimi Claude Code sürümüne göre değişebilir. Şüphede `claude plugin --help` çalıştır.

## Kısayollar

1. Ctrl+S: kaydet
2. Ctrl+K: aramaya git
3. Esc: pencereyi kapat

## Lisans

MIT. Ayrıntı için `LICENSE` dosyasına bak.
