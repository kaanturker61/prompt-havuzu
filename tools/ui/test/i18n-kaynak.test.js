'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const I18n = require('../public/i18n.js');
const TR = require('../public/lang/tr.js');
const EN = require('../public/lang/en.js');

/** Summary: tools/ui klasörü. */
const UI_DIR = path.join(__dirname, '..');
/** Summary: Araç reposu kökü. */
const REPO_DIR = path.join(UI_DIR, '..', '..');
/** Summary: Dil kodu -> sözlük nesnesi. */
const DICTIONARIES = { tr: TR, en: EN };
/** Summary: Dil kodu -> sözlük dosyası. */
const DICTIONARY_FILES = { tr: path.join(UI_DIR, 'public', 'lang', 'tr.js'), en: path.join(UI_DIR, 'public', 'lang', 'en.js') };
/** Summary: Anahtar adı biçimi: ad uzayı + noktalı anlamsal ad. */
const KEY_NAME_RE = /^[a-z]+(?:\.[A-Za-z0-9]+)+$/;
/** Summary: Dosyada tek tırnaklı, dört boşluk girintili üst düzey sözlük anahtarı. */
const DECLARED_KEY_RE = /^ {4}'([^']+)':/gm;
/** Summary: Çeviri çağrısı başlangıcı: tx( th( I18n.tx( I18n.th( (nesne özelliği ve ad parçası değil). */
const CALL_RE = /(?<![\w$.])(?:I18n\.)?(?:tx|th)\(/g;
/** Summary: Sabit (tek ya da çift tırnaklı) anahtar bağımsız değişkeni. */
const LITERAL_ARG_RE = /^\s*(['"])([^'"\n]+)\1\s*[,)]/;
/** Summary: Kapsam dışı sayılan değişkenli anahtar: tx(key ...) ya da tablo erişimi tx(TABLO[kod] ...). */
const INDIRECT_ARG_RE = /^\s*[A-Za-z_$][\w$]*(?:\[[^\]\n]+\])?\s*[,)]/;
/** Summary: Kaynakta tırnak içinde yazılmış anahtar biçimli dize. */
const KEY_LITERAL_RE = /(['"`])([a-z]+(?:\.[A-Za-z0-9]+)+)\1/g;
/** Summary: Türkçe diyakritikli harfler. */
const DIACRITIC_RE = /[çğıöşüÇĞİÖŞÜ]/;
/** Summary: en-US dışı yazımlar. */
const BRITISH_RE = /initialis|cancell|colour|behaviour|catalogue|organis/i;
/** Summary: Bilinçli iki dilli dil seçici etiketleri (arayuz-anahtar.test.js BILINGUAL_KEYS ile aynı girdiler). */
const BILINGUAL_KEYS = ['ui.settings.language', 'ui.settings.languageAuto', 'ui.settings.languageTr'];
/** Summary: LF zorunlu tutulan i18n dosyaları (tools/ui göreli). */
const LF_FILES = ['public/i18n.js', 'public/lang/tr.js', 'public/lang/en.js', 'lib/commit-text.js'];

/** Summary: Yorum satırlarını atarak kaynak metni döner. */
function withoutCommentLines(src) {
  return src.split('\n').filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line)).join('\n');
}

/** Summary: Yer tutucu adlarını sıralı ve tekil döner. */
function placeholders(text) {
  return [...new Set([...text.matchAll(/\{([A-Za-z_]\w*)\}/g)].map((m) => m[1]))].sort();
}

/** Summary: Sözlük değerinin kategori adı -> metin biçimi (düz metin 'text' kategorisi olur). */
function variants(value) {
  return typeof value === 'string' ? { text: value } : value;
}

/** Summary: Dilin Intl.PluralRules kategorileri, sıralı. */
function pluralCategories(lang) {
  return new Intl.PluralRules(I18n.LOCALE[lang]).resolvedOptions().pluralCategories.slice().sort();
}

/** Summary: Sözlük dosyasında üst düzey yazılmış anahtarlar (yinelenenler dahil). */
function declaredKeys(lang) {
  return [...fs.readFileSync(DICTIONARY_FILES[lang], 'utf8').matchAll(DECLARED_KEY_RE)].map((m) => m[1]);
}

/** Summary: Sunucu tarafı kaynak dosyaları: server.js, lib klasöründeki tüm .js dosyaları ve public/rules.js. */
function serverSources() {
  const libDir = path.join(UI_DIR, 'lib');
  const libs = fs.readdirSync(libDir).filter((name) => name.endsWith('.js')).sort().map((name) => path.join(libDir, name));
  return [path.join(UI_DIR, 'server.js'), ...libs, path.join(UI_DIR, 'public', 'rules.js')];
}

test('sözlükler: tüm ad uzaylarında tr ve en anahtar, yer tutucu, çoğul kümeleri eşit; değer boş değil; en değerinde Türkçe diyakritik yok', () => {
  const trKeys = Object.keys(TR).sort();
  assert.ok(trKeys.length > 900, 'sözlük okunuyor: ' + trKeys.length);
  assert.deepEqual(Object.keys(EN).sort(), trKeys);
  for (const lang of Object.keys(DICTIONARIES)) {
    const declared = declaredKeys(lang);
    assert.deepEqual(declared.filter((key, index) => declared.indexOf(key) !== index), [], lang + ': yinelenen anahtar (sonraki ilkini sessizce ezer)');
    assert.equal(declared.length, Object.keys(DICTIONARIES[lang]).length, lang + ': dosyadaki anahtar satırları = nesne anahtarları');
  }
  const required = { tr: ['other'], en: pluralCategories('en') };
  for (const key of trKeys) {
    assert.match(key, KEY_NAME_RE, 'anahtar biçimi');
    assert.equal(typeof TR[key], typeof EN[key], 'aynı biçim (düz metin ya da çoğul) ' + key);
    const all = [];
    for (const lang of Object.keys(DICTIONARIES)) {
      const value = DICTIONARIES[lang][key];
      if (typeof value === 'object') {
        const categories = Object.keys(value).sort();
        assert.deepEqual(categories, required[lang], lang + ' çoğul kategorileri ' + key);
        assert.ok(categories.every((category) => pluralCategories(lang).includes(category)), lang + ' geçersiz çoğul kategorisi ' + key);
      }
      all.push(...Object.values(variants(value)));
    }
    assert.ok(all.every((text) => typeof text === 'string' && text.trim().length > 0), 'boş değer yok ' + key);
    const expected = placeholders(all[0]);
    for (const text of all) assert.deepEqual(placeholders(text), expected, 'yer tutucu kümesi ' + key + ': ' + text);
    if (typeof TR[key] === 'object') assert.ok(expected.includes('count'), 'çoğul anahtar count ister ' + key);
    if (BILINGUAL_KEYS.includes(key)) continue;
    for (const text of Object.values(variants(EN[key]))) {
      assert.ok(!DIACRITIC_RE.test(text), 'en değerinde Türkçe diyakritik ' + key + ': ' + text);
      assert.doesNotMatch(text, BRITISH_RE, key);
    }
  }
});

test('kaynak taraması: server.js, lib ve rules.js içindeki sabit tx/th anahtarları tr ve en sözlüğünde var; değişkenli anahtarlar kapsam dışı', () => {
  const files = serverSources();
  assert.ok(files.length > 20, 'kaynak dosyaları bulunuyor: ' + files.length);
  const used = new Set();
  const unsupported = [];
  const literals = new Set();
  let calls = 0;
  for (const file of files) {
    const src = withoutCommentLines(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(KEY_LITERAL_RE)) literals.add(m[2]);
    for (const m of src.matchAll(CALL_RE)) {
      calls++;
      const rest = src.slice(m.index + m[0].length, m.index + m[0].length + 120);
      const literal = LITERAL_ARG_RE.exec(rest);
      if (literal) used.add(literal[2]);
      else if (!INDIRECT_ARG_RE.test(rest)) unsupported.push(path.basename(file) + ': ' + src.slice(m.index, m.index + 60).split('\n')[0]);
    }
  }
  assert.ok(calls > 250 && used.size > 200, 'tarama gerçekten çağrı buluyor: ' + calls + ' / ' + used.size);
  assert.deepEqual(unsupported, [], 'birleştirilmiş ya da şablon anahtarlı çağrı yok; tx(key) ve tx(TABLO[kod]) biçimli değişkenli anahtarlar bu testte yok sayılır');
  for (const key of used) {
    assert.ok(Object.prototype.hasOwnProperty.call(TR, key), 'tr sözlüğünde yok: ' + key);
    assert.ok(Object.prototype.hasOwnProperty.call(EN, key), 'en sözlüğünde yok: ' + key);
  }
  const html = withoutCommentLines(fs.readFileSync(path.join(UI_DIR, 'public', 'index.html'), 'utf8'));
  for (const m of html.matchAll(KEY_LITERAL_RE)) literals.add(m[2]);
  const orphans = Object.keys(TR).filter((key) => !key.startsWith('ui.') && !literals.has(key));
  assert.deepEqual(orphans, [], 'kaynakta (sunucu tarafı ya da index.html) hiç geçmeyen ui.* dışı sözlük anahtarı');
});

test('.gitattributes *.js ve *.html için LF zorlar; i18n dosyalarında ve bu testte CR yok', () => {
  const rules = fs.readFileSync(path.join(REPO_DIR, '.gitattributes'), 'utf8').split(/\r?\n/).map((line) => line.trim());
  assert.ok(rules.includes('*.js text eol=lf'), '*.js text eol=lf');
  assert.ok(rules.includes('*.html text eol=lf'), '*.html text eol=lf');
  for (const file of LF_FILES) {
    assert.ok(!fs.readFileSync(path.join(UI_DIR, file), 'utf8').includes('\r'), file + ': LF');
  }
  assert.ok(!fs.readFileSync(__filename, 'utf8').includes('\r'));
});
