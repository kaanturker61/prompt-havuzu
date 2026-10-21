'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ConfigStore, DEFAULTS, LANGUAGES } = require('../lib/config-store');
const { tmpDir, rmrf } = require('./helpers');

test('dosya yoksa varsayılanlar gelir', async () => {
  const d = tmpDir();
  try {
    const { config, warning } = await new ConfigStore({ file: path.join(d, 'c.json') }).load();
    assert.deepEqual(config, { version: 1, libraryRoot: '', activeMarketplace: '', remoteCheck: 'acilista', language: 'auto' });
    assert.equal(warning, null);
  } finally { rmrf(d); }
});

test('save/load gidiş-dönüşü ve dizin otomatik oluşur', async () => {
  const d = tmpDir();
  try {
    const f = path.join(d, 'ic', 'ice', 'c.json');
    const s = new ConfigStore({ file: f });
    await s.save({ libraryRoot: 'D:/X', activeMarketplace: 'm' });
    assert.deepEqual((await s.load()).config, { version: 1, libraryRoot: 'D:/X', activeMarketplace: 'm', remoteCheck: 'acilista', language: 'auto' });
    assert.equal(fs.readdirSync(path.dirname(f)).length, 1, 'tmp dosyası kalmamalı');
  } finally { rmrf(d); }
});

test('bozuk JSON: varsayılanlar + warning, dosya ezilmez; save öncesi .bak alınır', async () => {
  const d = tmpDir();
  try {
    const f = path.join(d, 'c.json');
    fs.writeFileSync(f, '{bozuk');
    const s = new ConfigStore({ file: f });
    const r = await s.load();
    assert.equal(r.config.libraryRoot, '');
    assert.ok(r.warning && r.warning.file === f);
    assert.equal(fs.readFileSync(f, 'utf8'), '{bozuk');
    await s.save({ libraryRoot: 'Y' });
    assert.equal(fs.readFileSync(f + '.bak', 'utf8'), '{bozuk');
    assert.equal((await s.load()).config.libraryRoot, 'Y');
  } finally { rmrf(d); }
});

test('nesne olmayan JSON bozuk sayılır', async () => {
  const d = tmpDir();
  try {
    const f = path.join(d, 'c.json'); fs.writeFileSync(f, '[1]');
    assert.ok((await new ConfigStore({ file: f }).load()).warning);
  } finally { rmrf(d); }
});

test('defaultFile: PP_CONFIG kullanılır', () => {
  const f = path.resolve('x', 'cfg.json');
  assert.equal(ConfigStore.defaultFile({ PP_CONFIG: f }), f);
});

test('remoteCheck: varsayılan acilista, geçersiz değer normalize edilir, bilinmeyen anahtarlar atılır', async () => {
  const d = tmpDir();
  try {
    const s = new ConfigStore({ file: path.join(d, 'c.json') });
    await s.save({ libraryRoot: 'X', remoteCheck: 'elle', baskaAnahtar: 1 });
    let c = (await s.load()).config;
    assert.equal(c.remoteCheck, 'elle'); assert.equal('baskaAnahtar' in c, false);
    await s.save({ libraryRoot: 'X', remoteCheck: 'saatlik' });
    assert.equal((await s.load()).config.remoteCheck, 'acilista');
    fs.writeFileSync(path.join(d, 'c.json'), JSON.stringify({ libraryRoot: 'Y' }));
    assert.equal((await s.load()).config.remoteCheck, 'acilista');
  } finally { rmrf(d); }
});

test('language: LANGUAGES ve varsayılan auto; tr/en korunur, geçersiz ya da yok değer auto olur', async () => {
  assert.deepEqual([...LANGUAGES], ['auto', 'tr', 'en']);
  assert.equal(DEFAULTS.language, 'auto');
  const d = tmpDir();
  try {
    const f = path.join(d, 'c.json');
    const s = new ConfigStore({ file: f });
    for (const lang of ['tr', 'en', 'auto']) {
      await s.save({ libraryRoot: 'X', language: lang });
      assert.equal((await s.load()).config.language, lang);
      assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).language, lang, 'dosyaya yazılır');
    }
    for (const bad of ['de', 'TR', 'En', '', null, undefined, 5, ['tr'], {}]) {
      await s.save({ libraryRoot: 'X', language: bad });
      assert.equal((await s.load()).config.language, 'auto', 'save: ' + JSON.stringify(bad));
      fs.writeFileSync(f, JSON.stringify({ libraryRoot: 'X', language: bad }));
      assert.equal((await s.load()).config.language, 'auto', 'load: ' + JSON.stringify(bad));
    }
  } finally { rmrf(d); }
});

test('language: eski ayar dosyası (language yok) sorunsuz okunur, diğer alanlar korunur, uyarı yok', async () => {
  const d = tmpDir();
  try {
    const f = path.join(d, 'c.json');
    fs.writeFileSync(f, JSON.stringify({ version: 1, libraryRoot: 'D:/Lib', activeMarketplace: 'mk', remoteCheck: 'elle' }));
    const s = new ConfigStore({ file: f });
    const { config, warning } = await s.load();
    assert.equal(warning, null);
    assert.deepEqual(config, { version: 1, libraryRoot: 'D:/Lib', activeMarketplace: 'mk', remoteCheck: 'elle', language: 'auto' });
    await s.save({ ...config, language: 'en' });
    assert.deepEqual((await s.load()).config, { version: 1, libraryRoot: 'D:/Lib', activeMarketplace: 'mk', remoteCheck: 'elle', language: 'en' });
    await s.save({ libraryRoot: 'D:/Baska' });
    assert.equal((await s.load()).config.language, 'auto', 'save yalnızca verilen alanları yazar, dil açıkça verilmezse auto');
    fs.writeFileSync(f, JSON.stringify({ libraryRoot: 'Y', language: 'tr', baskaAnahtar: 1 }));
    const c = (await s.load()).config;
    assert.equal(c.language, 'tr');
    assert.equal('baskaAnahtar' in c, false, 'bilinmeyen anahtarlar yine atılır');
  } finally { rmrf(d); }
});
