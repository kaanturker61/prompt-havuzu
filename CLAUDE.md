# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Genel bakış

Prompt havuzu: promptları library kökündeki marketplace klasörlerinde `.md` dosyaları olarak tutan, yerel web arayüzü (arama, düzenleme, git geçmişi, içe aktarma) sunan ve istenen promptları Claude Code marketplace/plugin yapısına yayınlayan bir araç. Araç reposu yalnızca kodu içerir; promptlar araç reposunun dışında, kullanıcı ayarında seçilen library kökünün altındadır ve her marketplace klasörü ayrı bir git deposudur. Proje dili Türkçedir (arayüz, hata mesajları, frontmatter anahtarları); commit mesajlarını İngilizce, diğer yeni metinleri Türkçe yaz.

## Komutlar

Çalışma zamanı bağımlılığı ve build yok; lint yok. Yalnızca Node.js >= 18 ve git gerekir.

- Çalıştır: `node tools/ui/server.js --open` (ya da `start.bat` / `./start.sh`)
- Seçenekler: `--port 4317` (veya `PORT`; doluysa sonraki 10 porta bakar), `--open`. `--root` ve `PROMPT_ROOT` kaldırıldı; library kökü Ayarlar penceresinden seçilir.
- Test: `npm test --prefix tools/ui` (`node --test`, `node:test` + `node:assert/strict`, bağımlılık yok). Testler yalnızca geçici klasörlerde ve `PP_CONFIG` ile çalışır; gerçek ayar dosyasına, yerel kütüphane klasörüne veya araç reposunun git durumuna dokunmaz. Git testleri `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM` ile izole edilir.
- Plugin doğrulama: `claude plugin validate <marketplace klasörü>`

## Ayarlar ve kurulum durumu

- Kullanıcı ayar dosyası (`{ version, libraryRoot, activeMarketplace }`): Windows `%APPDATA%\prompt-havuzu\config.json`; macOS `~/Library/Application Support/prompt-havuzu/config.json` (`XDG_CONFIG_HOME` varsa o); Linux `$XDG_CONFIG_HOME` veya `~/.config` altında `prompt-havuzu/config.json`. `PP_CONFIG=<dosya>` hepsini geçersiz kılar (testler ve elle deneme için bunu kullan).
- Çalışma kökü `root()` = `<libraryRoot>/<activeMarketplace>`. `server.js` içinde sabit kök yok; her yer `root()` kullanır.
- Kurulum durumu `setup: { ok, libraryRoot, activeMarketplace, root, issues[] }` (`lib/setup-service.js`). `GET /api/info`, `/api/settings`, `/api/marketplaces` her çağrıda yeniden değerlendirir. `ok=false` iken kurulum gerektiren tüm rotalar (ağaç, arama, dosya, git, içe aktarma, marketplace yayını) `409 { setupRequired: true, setup }` döner; arayüz bunu `conflict` 409'undan ayırıp kurulum ekranına düşer. Her zaman açık rotalar: `/api/info`, `/api/settings`, `/api/marketplaces*`, statik dosyalar (`route(..., { open: true })`).
- Araç reposu hiçbir zaman kök veya marketplace olmaz: kök araç reposunun içindeyse kurulum hatası, `GitService` de araç reposunda komut çalıştırmayı reddeder.

## Mimari

- `tools/ui/server.js`: bağımlılıksız HTTP sunucusu (HTTP katmanı, rotalar, dosya/arama/yayın kodu). Yalnızca 127.0.0.1'de dinler; Host kontrolü yapar, GET dışındaki `/api/*` isteklerinde `X-PP: 1` başlığı ve Origin eşleşmesi ister. Rotalar `route(method, path, fn, opts)` ile dosya içinde kaydedilir. Statik olarak yalnızca `index.html`, `fm.js` ve `rules.js` servis edilir (yeni bir public dosyası eklenirse `server.js` içindeki izin listesine de eklenmeli; `lib/` sunucu tarafında kalır).
- `tools/ui/lib/`: sunucu tarafı modüller, bağımlılıklar constructor ile enjekte edilir.
  - `paths.js`: ayar dosyası yolu, `samePath`/`isInside` (Windows büyük-küçük harf, `realpath`), kök önerisi.
  - `undo.js`: `UndoStack` (adımlar ters sırada, hatalar `AggregateError`).
  - `config-store.js`: `ConfigStore` (atomik yazma, bozuk dosyada `.bak`).
  - `git-service.js`: `GitService`, `GitError`, `GitNotFoundError`. Sürüm/tag için: `headCommit`, `listTags`, `createTag`, `deleteTag`, `undoCommit` (`update-ref` CAS), `unstage`, `blobAt`, `hashFiles`; `log` için `range` seçeneği.
  - `version-service.js`: `VersionService` (`info`, `statusMap`, `bump`), `VersionError`. +1: dosyayı yaz, commit, annotated tag; her adımda `UndoStack` ile geri alma. Git komutu bilmez, yalnızca `GitService` metotlarını çağırır.
  - `marketplace-registry.js`, `marketplace-factory.js`, `templates.js`: marketplace keşfi, oluşturma (git init + iskelet, hata olursa geri alma), var olan klasörde git başlatma.
  - `setup-service.js`: `SetupService`, kurulum durumunu değerlendirir; kök değişince arama önbelleği temizlenir.
- `tools/ui/public/fm.js`: frontmatter ayrıştırıcı/yazıcı; hem Node (`require`) hem tarayıcıda (`window.FM`) çalışır, sunucu ve arayüz aynı kodu paylaşır. Bilinmeyen anahtarları ve biçimlendirmeyi olduğu gibi korur, yalnızca değişen anahtarın satırını yeniden yazar (git farkları küçük kalsın diye). Yeni standart alanlar `CANON` sırasına eklenir. `fold` (Türkçe karakter/büyük-küçük harf yok sayan arama) ve `slug` da burada.
- `tools/ui/public/rules.js`: paylaşılan kural modülü (`fm.js` ile aynı UMD kalıbı, Node'da `require`, tarayıcıda `window.Rules`; `fm.js`'e bağımlı). `normTur`, `publishCheck` (bir promptun neden yayına girmediği), `isFmBroken`, sürüm kuralları (`checkVersion`, `normalizeVersion`). Sunucu ve arayüz aynı kuralı kullanır; bu kuralları başka yerde yeniden yazma.
- `tools/ui/public/index.html`: tüm arayüz (tek dosya, framework yok). Kurulum ekranı, Ayarlar penceresi ve marketplace seçicisi burada; localStorage anahtarları `pp.<marketplace>.last|expanded` biçiminde marketplace'e göre ayrılır.
- Marketplace klasörü (`<libraryRoot>/<ad>`, ayrı git deposu): `prompts/` (tek doğruluk kaynağı, `pp.config.json` içindeki `libraryDir`), `pp.config.json`, `.claude-plugin/`, `plugins/`, `.pp/`. Her prompt bir `.md`; alanlar README'de listeli (`baslik`, `etiketler`, `durum`, `tur`, `paket`, `komut_adi`, `aciklama`, ...).
- `plugins/` ve `.claude-plugin/` (marketplace içinde): **üretilen** çıktı. `tur: komut|ajan|skill` olan promptlar `publishPlan` ile `plugins/<paket>/{commands,agents,skills}` altına dönüştürülür (`renderTarget`: Türkçe alan adları Claude Code frontmatter'ına çevrilir, örn. `izinli_araclar` -> `allowed-tools`/`tools`). Bunlar elle düzenlenmez, kaynak prompt düzenlenip arayüzden yayınlanır. Yayın sonrası `marketplaceSync` `plugin.json` ve `marketplace.json` dosyalarını yazar; harici (`./plugins/` dışı) marketplace girdilerini korur.
- Marketplace sürümü her zaman `X.Y.Z` biçimindedir (`Rules.SEMVER_RE`), boşsa `1.0.0` sayılır (okurken diske yazılmaz); `POST /api/marketplace/init` geçersiz sürümü 400 ile reddeder. Eski bozuk bir değer `configIssues` ile uyarı olarak gösterilir.
- Yayına girmeyen her prompt sessiz kalmaz: `publishPlan` bunları `skipped` içinde `code`/`reason` ile döndürür (`turYok`, `turGecersiz`, `onYuzKapanmamis`, `dosyaBuyuk`, bilinçli `yayinDisi`). Durum paneli, `/api/file` (`publishCheck`), ağaç (`meta.uyari`) ve `/api/facets` (`yayinUyari`) bunu kullanır.
- Çalışma zamanı dosyaları (marketplace içinde): `pp.config.json` (marketplace ayarları, arayüz yazar), `.pp/trash/` (silinenler; kalıcı silme yok, git'e girmez).

## Dikkat edilecekler

- Git işlemleri yalnızca `lib/git-service.js` içindeki `GitService` üzerinden, `git -C <dir> ...` biçiminde (`execFile`, shell yok) yapılır. `server.js` ve diğer kod git komutu bilmez; submodule yok. Commit hash'leri `HASH_RE` ile doğrulanır.
- Dosya erişimi `safePath` üzerinden geçmeli (etkin marketplace kökü dışına ve `.git`'e çıkışı engeller). Yazmalar `atomicWrite` (tmp + rename), silmeler `toTrash` ile yapılır.
- `IGNORE` kümesi (`.git`, `node_modules`, `.pp`, `tools`) ağaç ve aramadan dışlanır; arama dizini `cache` içinde mtime/size ile tutulur (kök değişince temizlenir).
- Dosya okuma `decode` ile UTF-8, UTF-16 ve windows-1254 (eski Türkçe ANSI) destekler; yeni okuma yolları doğrudan `toString('utf8')` yerine bunu kullanmalı.
- Yeni marketplace iskeleti `.gitattributes` ile `*.md` ve `*.json` için LF zorlar. Otomatik ilk commit yoktur. Commit iki yoldan atılır: Git paneli ya da Kaydet sırasında dolu commit mesajı (`PUT /api/file` + `commitMessage`, yalnızca o dosya commit edilir; mesaj boşsa yalnızca diske yazılır).
- Prompt sürümü: `versiyon` alanı `X.Y.Z` olmalı. `Rules.coerceVersion` eski biçimleri (`1`, `1.2`, `v1.0.2`) yorumlar, `Rules.bumpVersion(v, seviye)` (`buyuk|kucuk|yama`) artırır; alan boşsa ilk +1 `1.0.0` üretir. Yeni prompt ve içe aktarma `versiyon` yazmaz. +1 (`POST /api/version/bump`) dosyayı yazar, yalnızca o dosyayı commit eder ve `prompt/<ad>/vX.Y.Z` annotated tag'ini sürüm notuyla atar; `<ad>` = `Rules.promptTagAd` (libraryDir'e göre göreli yol, parça parça `FM.slug`). Son sürümden beri içerik değişip `versiyon` aynıysa `surumGuncelDegil` uyarısı verilir (`meta.surum`, `GET /api/version`). Push yok.
