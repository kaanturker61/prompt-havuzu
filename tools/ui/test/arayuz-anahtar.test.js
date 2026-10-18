'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const TR = require('../public/lang/tr.js');
const EN = require('../public/lang/en.js');

const CALL_RE = /(?<![\w$.])(?:I18n\.)?(?:tx|th)\(/g;
const LITERAL_ARG_RE = /^\s*(['"])([^'"\n]+)\1\s*[,)]/;
const IDENTIFIER_ARG_RE = /^\s*[A-Za-z_$][\w$]*\s*[,)]/;
const KEY_LITERAL_RE = /(['"`])(ui\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+)\1/g;
const STATIC_ATTRIBUTE_RE = /\sdata-i18n(?:-[a-z-]+)?="([^"]+)"/g;
const BARE_TEMPLATE_CALL_RE = /\$\{\s*(?:I18n\.)?tx\(/;
const DIACRITIC_RE = /[çğıöşüÇĞİÖŞÜ]/;
const BILINGUAL_KEYS = ['ui.settings.language', 'ui.settings.languageAuto', 'ui.settings.languageTr'];

/** Summary: Yorum satırlarını atarak kaynak metni döner. */
function sourceWithoutCommentLines() {
  return html.split('\n').filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line)).join('\n');
}

/** Summary: Çeviri çağrılarını (tx/th/I18n.tx/I18n.th) ve ilk bağımsız değişkenlerini listeler. */
function translationCalls(src) {
  return [...src.matchAll(CALL_RE)].map((m) => {
    const rest = src.slice(m.index + m[0].length, m.index + m[0].length + 120);
    const literal = LITERAL_ARG_RE.exec(rest);
    return { text: src.slice(m.index, m.index + m[0].length + 40).split('\n')[0], literal: literal ? literal[2] : null, identifier: IDENTIFIER_ARG_RE.test(rest) };
  });
}

/** Summary: Kaynakta kullanılan tüm sabit anahtarlar: çağrı argümanları, ui.* sabitleri (tablolar dahil) ve data-i18n* öznitelikleri. */
function usedKeys() {
  const src = sourceWithoutCommentLines();
  const keys = new Set();
  for (const call of translationCalls(src)) if (call.literal) keys.add(call.literal);
  for (const m of src.matchAll(KEY_LITERAL_RE)) keys.add(m[2]);
  for (const m of src.matchAll(STATIC_ATTRIBUTE_RE)) keys.add(m[1]);
  return [...keys].sort();
}

/** Summary: Metindeki {yer tutucu} adlarını sıralı ve tekil döner. */
function placeholders(text) {
  return [...new Set([...text.matchAll(/\{([A-Za-z_]\w*)\}/g)].map((m) => m[1]))].sort();
}

/** Summary: Sözlük değerinin kategori adı -> metin biçimi (düz metin 'text' kategorisi olur). */
function variants(value) {
  return typeof value === 'string' ? { text: value } : value;
}

/** Summary: Sözlüğün ui.* anahtarlarını sıralı döner. */
function uiKeys(dictionary) {
  return Object.keys(dictionary).filter((key) => key.startsWith('ui.')).sort();
}

test('index.html: tx/th ile kullanılan her sabit anahtar hem tr hem en sözlüğünde bulunur', () => {
  const keys = usedKeys();
  assert.ok(keys.length >= 120, 'tarama gerçekten anahtar buluyor: ' + keys.length);
  for (const key of keys) {
    assert.ok(Object.prototype.hasOwnProperty.call(TR, key), 'tr sözlüğünde yok: ' + key);
    assert.ok(Object.prototype.hasOwnProperty.call(EN, key), 'en sözlüğünde yok: ' + key);
  }
});

test('index.html: sözlükteki her ui.* anahtarı kaynakta kullanılıyor (yetim anahtar yok)', () => {
  const used = new Set(usedKeys());
  assert.deepEqual(uiKeys(TR).filter((key) => !used.has(key)), []);
});

test('index.html: çeviri çağrısı anahtarı sabit ya da tablo değişkeni; birleştirilmiş ya da hesaplanmış anahtar yok', () => {
  const src = sourceWithoutCommentLines();
  const calls = translationCalls(src);
  assert.ok(calls.length > 100, 'çağrılar bulunuyor: ' + calls.length);
  const unsupported = calls.filter((call) => !call.literal && !call.identifier).map((call) => call.text);
  assert.deepEqual(unsupported, []);
  const dynamic = calls.filter((call) => !call.literal).map((call) => call.text);
  assert.ok(dynamic.every((text) => /^(?:I18n\.)?(?:tx|th)\(k\b/.test(text)), 'değişkenli çağrılar: ' + dynamic.join(' | '));
  assert.doesNotMatch(src, /(?<![\w$.])(?:I18n\.)?(?:tx|th)\(\s*['"][^'"\n]*['"]\s*\+/);
  assert.doesNotMatch(src, /(?<![\w$.])(?:I18n\.)?(?:tx|th)\(\s*`/);
});

test('index.html: HTML şablonlarında çıplak ${tx(...)} yok (esc(tx()) ya da th() kullanılır)', () => {
  assert.doesNotMatch(sourceWithoutCommentLines(), BARE_TEMPLATE_CALL_RE);
});

test('sözlük: tr ve en ui.* anahtar kümesi, yer tutucular ve çoğul kategorileri eşit; değerler boş değil', () => {
  assert.deepEqual(uiKeys(EN), uiKeys(TR));
  for (const key of uiKeys(TR)) {
    const trValue = TR[key];
    const enValue = EN[key];
    assert.equal(typeof trValue, typeof enValue, 'aynı biçim (düz metin ya da çoğul) ' + key);
    const trVariants = variants(trValue);
    const enVariants = variants(enValue);
    const all = [...Object.values(trVariants), ...Object.values(enVariants)];
    assert.ok(all.every((text) => typeof text === 'string' && text.trim().length > 0), 'boş değer yok ' + key);
    const expected = placeholders(all[0]);
    for (const text of all) assert.deepEqual(placeholders(text), expected, 'yer tutucu kümesi ' + key + ': ' + text);
    if (typeof trValue === 'object') {
      assert.ok(expected.includes('count'), 'çoğul anahtar count ister ' + key);
      assert.deepEqual(Object.keys(trVariants), ['other'], 'tr yalnızca other ' + key);
      assert.deepEqual(Object.keys(enVariants).sort(), ['one', 'other'], 'en one + other ' + key);
    }
  }
});

test('sözlük: en ui.* değerlerinde Türkçe diyakritik ve en-GB yazım yok (iki dilli seçici etiketleri hariç)', () => {
  for (const key of uiKeys(EN)) {
    if (BILINGUAL_KEYS.includes(key)) continue;
    for (const text of Object.values(variants(EN[key]))) {
      assert.ok(!DIACRITIC_RE.test(text), key + ': ' + text);
      assert.doesNotMatch(text, /initialis|cancell|colour|behaviour|catalogue|organis/i, key);
    }
  }
});

test('index.html ve bu test dosyasında CR yok (LF)', () => {
  assert.ok(!html.includes('\r'));
  assert.ok(!fs.readFileSync(__filename, 'utf8').includes('\r'));
});
