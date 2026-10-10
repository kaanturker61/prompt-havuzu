# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Genel bakış

Prompt havuzu: promptları `.md` dosyaları olarak tutan, yerel web arayüzü (arama, düzenleme, git geçmişi, içe aktarma) sunan ve istenen promptları Claude Code marketplace/plugin yapısına yayınlayan bir araç. Proje dili Türkçedir (arayüz, hata mesajları, frontmatter anahtarları); commit mesajlarını İngilizce, diğer yeni metinleri Türkçe yaz.

## Komutlar

Bağımlılık, build, lint veya test yok. Yalnızca Node.js >= 18 ve git gerekir.

- Çalıştır: `node tools/ui/server.js --open` (ya da `start.bat` / `./start.sh`)
- Seçenekler: `--port 4317` (veya `PORT`; doluysa sonraki 10 porta bakar)
- Plugin doğrulama: `claude plugin validate <klasör>`

## Mimari

- `tools/ui/server.js`: tek dosyalık, bağımlılıksız HTTP sunucusu. Yalnızca 127.0.0.1'de dinler; Host kontrolü yapar, GET dışındaki `/api/*` isteklerinde `X-PP: 1` başlığı ve Origin eşleşmesi ister. Rotalar `route(method, path, fn)` ile dosya içinde kaydedilir. Statik olarak yalnızca `index.html` ve `fm.js` servis edilir (yeni bir public dosyası eklenirse `server.js` içindeki izin listesine de eklenmeli).
- `tools/ui/public/fm.js`: frontmatter ayrıştırıcı/yazıcı; hem Node (`require`) hem tarayıcıda (`window.FM`) çalışır, sunucu ve arayüz aynı kodu paylaşır. Bilinmeyen anahtarları ve biçimlendirmeyi olduğu gibi korur, yalnızca değişen anahtarın satırını yeniden yazar (git farkları küçük kalsın diye). Yeni standart alanlar `CANON` sırasına eklenir. `fold` (Türkçe karakter/büyük-küçük harf yok sayan arama) ve `slug` da burada.
- `tools/ui/public/index.html`: tüm arayüz (tek dosya, framework yok).
- Çalışma zamanı dosyaları: `pp.config.json` (marketplace ayarları, arayüz yazar), `.pp/trash/` (silinenler; kalıcı silme yok, git'e girmez).

## Dikkat edilecekler

- Dosya erişimi `safePath` üzerinden geçmeli (ROOT dışına ve `.git`'e çıkışı engeller). Yazmalar `atomicWrite` (tmp + rename), silmeler `toTrash` ile yapılır.
- `IGNORE` kümesi (`.git`, `node_modules`, `.pp`, `tools`) ağaç ve aramadan dışlanır; arama dizini `cache` içinde mtime/size ile tutulur.
- Dosya okuma `decode` ile UTF-8, UTF-16 ve windows-1254 (eski Türkçe ANSI) destekler; yeni okuma yolları doğrudan `toString('utf8')` yerine bunu kullanmalı.
- Git işlemleri `git()` yardımcısıyla `execFile` üzerinden çalışır (shell yok); commit hash'leri `HASH_RE` ile doğrulanır.
- `.gitattributes` `*.md` ve `*.json` için LF zorlar.
