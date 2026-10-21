'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const FM = require('../public/fm.js');
const Rules = require('../public/rules.js');
const I18n = require('../public/i18n.js');
const { PromptIndex } = require('../lib/prompt-index');
const { tmpDir, rmrf } = require('./helpers');

const decode = (b) => b.toString('utf8');
const mkIndex = () => new PromptIndex({ decode, FM, Rules, ignore: new Set(Rules.RESERVED_DIRS) });
const put = (dir, rel, raw) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, raw); return f; };

/** Summary: Dosya yolu -> [içerik, beklenen kod, beklenen seviye, beklenen Türkçe başlangıç, beklenen İngilizce başlangıç]. */
const FILES = {
  'prompts/p/buyuk.md': ['x'.repeat(2000001), 'dosyaBuyuk', 'warn', "Dosya 2 MB'tan büyük", 'The file is larger than 2 MB'],
  'prompts/p/eksik.md': ['---\nbaslik: A\naciklama: b\n---\nx', 'turYok', 'warn', 'Yayın alanları dolu (aciklama)', 'Publish fields are filled in (aciklama)'],
  'prompts/p/gecersiz.md': ['---\nbaslik: A\ntur: zzz\n---\nx', 'turGecersiz', 'warn', '"tur" değeri tanınmadı: "zzz"', 'The "tur" value was not recognized: "zzz"'],
  'prompts/p/kapanmamis.md': ['---\nbaslik: A\naciklama: b\n', 'onYuzKapanmamis', 'warn', 'Frontmatter kapanmamış', 'The frontmatter is not closed'],
  'prompts/p/bos.md': ['---\nbaslik: A\n---\nx', 'yayinDisi', 'info', 'Tür seçilmemiş', 'No type selected']
};

/** Summary: Dizin kökü, dosyaları yazılmış geçici klasörle birlikte fn'e verir ve temizler. */
async function withFiles(fn) {
  const dir = tmpDir();
  try {
    for (const [rel, [raw]] of Object.entries(FILES)) put(dir, rel, raw);
    await fn(dir);
  } finally { rmrf(dir); }
}

/** Summary: Liste öğelerini yola göre eşler. */
const byPath = (list) => Object.fromEntries(list.map((item) => [item.path, item]));

test('PromptIndex: check önbelleği dil sızdırmaz; aynı örnek önce tr sonra en bağlamında okunur', async () => {
  await withFiles(async (dir) => {
    const ix = mkIndex();
    const trList = byPath(await I18n.run('tr', () => ix.listMd(dir, 'prompts', { includeBig: true })));
    assert.deepEqual(Object.keys(trList).sort(), Object.keys(FILES).sort());
    for (const [rel, [, code, level, trStart]] of Object.entries(FILES)) {
      const check = I18n.run('tr', () => ({ code: trList[rel].check.code, level: trList[rel].check.level, reason: trList[rel].check.reason }));
      assert.deepEqual([check.code, check.level], [code, level], rel);
      assert.ok(check.reason.startsWith(trStart), `tr ${rel}: ${check.reason}`);
    }

    const enList = byPath(await I18n.run('en', () => ix.listMd(dir, 'prompts', { includeBig: true })));
    for (const [rel, [, code, , trStart, enStart]] of Object.entries(FILES)) {
      assert.equal(enList[rel], trList[rel], 'önbellekten aynı öğe: ' + rel);
      const reason = I18n.run('en', () => enList[rel].check.reason);
      assert.equal(enList[rel].check.code, code);
      assert.ok(reason.startsWith(enStart), `en ${rel}: ${reason}`);
      assert.ok(!reason.startsWith(trStart), 'tr metin sızmadı: ' + rel);
      const back = I18n.run('tr', () => trList[rel].check.reason);
      assert.ok(back.startsWith(trStart), `tr'ye dönünce ${rel}: ${back}`);
    }
  });
});

test('PromptIndex: check.reason tembel alıcıdır (düz metin önbellekte tutulmaz); kod, seviye ve fields korunur', async () => {
  await withFiles(async (dir) => {
    const ix = mkIndex();
    const list = byPath(await ix.listMd(dir, 'prompts', { includeBig: true }));
    for (const [rel, [, code, level]] of Object.entries(FILES)) {
      const descriptor = Object.getOwnPropertyDescriptor(list[rel].check, 'reason');
      assert.equal(typeof descriptor.get, 'function', 'tembel alıcı: ' + rel);
      assert.equal(descriptor.value, undefined, 'önbellekte metin yok: ' + rel);
      assert.equal(list[rel].check.code, code);
      assert.equal(list[rel].check.level, level);
    }
    assert.deepEqual(list['prompts/p/eksik.md'].check.fields, ['aciklama']);
    assert.equal(list['prompts/p/buyuk.md'].tooBig, true);

    const enJson = JSON.parse(I18n.run('en', () => JSON.stringify(list['prompts/p/buyuk.md'].check)));
    const trJson = JSON.parse(I18n.run('tr', () => JSON.stringify(list['prompts/p/buyuk.md'].check)));
    assert.deepEqual(enJson, { code: 'dosyaBuyuk', level: 'warn', reason: 'The file is larger than 2 MB. It is not indexed or published.' });
    assert.deepEqual(trJson, { code: 'dosyaBuyuk', level: 'warn', reason: "Dosya 2 MB'tan büyük. Dizinlenmiyor ve yayınlanmıyor." });
    const spread = I18n.run('en', () => ({ ...list['prompts/p/eksik.md'].check }));
    assert.match(spread.reason, /^Publish fields are filled in/);
  });
});

test('PromptIndex: dosya değişince yeniden indekslenir, tüketici okuması yeni bağlamın dilinde', async () => {
  await withFiles(async (dir) => {
    const ix = mkIndex();
    await I18n.run('tr', () => ix.listMd(dir, 'prompts', { includeBig: true }));
    put(dir, 'prompts/p/eksik.md', '---\nbaslik: A\naciklama: bir iki üç\nmodel: x\n---\nyeni içerik');
    const list = byPath(await I18n.run('en', () => ix.listMd(dir, 'prompts', { includeBig: true })));
    const check = list['prompts/p/eksik.md'].check;
    assert.deepEqual(check.fields, ['aciklama', 'model']);
    assert.equal(I18n.run('en', () => check.reason), 'Publish fields are filled in (aciklama, model) but "tur" is missing. This prompt will not be published.');
    assert.equal(I18n.run('tr', () => check.reason), 'Yayın alanları dolu (aciklama, model) ama "tur" yok. Bu prompt yayınlanmayacak.');
  });
});
