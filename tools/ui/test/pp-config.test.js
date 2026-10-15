'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ppConfig = require('../lib/pp-config');
const { tmpDir, rmrf } = require('./helpers');
const { makeLink, removeLink } = require('./links');

const { inspectConfigAt, loadConfigAt, saveConfigAt, assertHealthy, PpConfigError, configFileAt } = ppConfig;

function mk(content) {
  const d = tmpDir();
  if (content !== undefined) fs.writeFileSync(configFileAt(d), content);
  return d;
}
const codes = (r) => r.issues.map((i) => i.code);
const noWrite = async () => { throw new Error('yazılmamalıydı'); };

test('inspectConfigAt: yok/bozuk/null/dizi/metin/sayı durumları', async () => {
  const d = mk();
  try {
    let r = await inspectConfigAt(d);
    assert.equal(r.state, 'yok'); assert.deepEqual(r.issues, []);
    assert.equal(r.cfg.libraryDir, 'library');
    r = await inspectConfigAt(null);
    assert.equal(r.state, 'yok'); assert.deepEqual(r.issues, []);

    for (const bad of ['garip{', 'null', '[]', '"x"', '5', 'true', '']) {
      fs.writeFileSync(configFileAt(d), bad);
      r = await inspectConfigAt(d);
      assert.equal(r.state, 'bozuk', JSON.stringify(bad));
      assert.deepEqual(codes(r), ['ppConfigBozuk'], JSON.stringify(bad));
      assert.equal(r.issues[0].level, 'warn');
      assert.match(r.issues[0].message, /^pp\.config\.json okunamadı \(/);
      assert.match(r.issues[0].message, /düzelt/);
      assert.ok(!r.issues[0].message.includes(d), 'ileti mutlak yol içermemeli');
      // kullanılabilir varsayılanlar
      assert.equal(r.cfg.libraryDir, 'library');
      assert.equal(r.cfg.marketplace.version, '1.0.0');
      assert.deepEqual(r.cfg.packages, {});
      assert.deepEqual(await loadConfigAt(d), r.cfg, 'loadConfigAt = inspectConfigAt().cfg');
    }
    assert.match((await inspectConfigAt(d)).issues[0].message, /JSON biçimi geçersiz|okunamadı/);
    fs.writeFileSync(configFileAt(d), 'null');
    assert.match((await inspectConfigAt(d)).issues[0].message, /kök bir nesne değil, null/);
    fs.writeFileSync(configFileAt(d), '[]');
    assert.match((await inspectConfigAt(d)).issues[0].message, /kök bir nesne değil, dizi/);
    fs.writeFileSync(configFileAt(d), '5');
    assert.match((await inspectConfigAt(d)).issues[0].message, /kök bir nesne değil, sayı/);
  } finally { rmrf(d); }
});

test('inspectConfigAt: pp.config.json bir klasörse (okunamayan) bozuk sayılır', async () => {
  const d = tmpDir();
  try {
    fs.mkdirSync(configFileAt(d));
    const r = await inspectConfigAt(d);
    assert.equal(r.state, 'bozuk');
    assert.deepEqual(codes(r), ['ppConfigBozuk']);
    assert.ok(!r.issues[0].message.includes(d));
  } finally { rmrf(d); }
});

test("BOM'lu geçerli dosya okunur", async () => {
  const d = mk('\uFEFF' + JSON.stringify({ libraryDir: 'prompts', marketplace: { name: 'm', version: '2.5.0' }, packages: { a: { description: 'x' } } }));
  try {
    const r = await inspectConfigAt(d);
    assert.equal(r.state, 'ok'); assert.deepEqual(r.issues, []);
    assert.equal(r.cfg.libraryDir, 'prompts');
    assert.equal(r.cfg.marketplace.version, '2.5.0');
    assert.equal(r.cfg.packages.a.description, 'x');
  } finally { rmrf(d); }
});

test('saveConfigAt bozuk dosyaya yazmaz, bayt aynı kalır; .bak üretilmez', async () => {
  for (const bad of ['garip{', 'null', '[]', '"x"', '5']) {
    const d = mk(bad);
    try {
      const before = fs.readFileSync(configFileAt(d));
      await assert.rejects(saveConfigAt(d, { libraryDir: 'prompts' }, noWrite), (e) => {
        assert.ok(e instanceof PpConfigError);
        assert.equal(e.name, 'PpConfigError'); assert.equal(e.status, 409); assert.deepEqual(e.data, { code: 'ppConfigBozuk' });
        assert.match(e.message, /^pp\.config\.json okunamadı/);
        return true;
      }, bad);
      assert.deepEqual(fs.readFileSync(configFileAt(d)), before);
      assert.deepEqual(fs.readdirSync(d), ['pp.config.json'], '.bak ya da başka dosya yok');
    } finally { rmrf(d); }
  }
});

test('saveConfigAt libraryDir geçersizken yazmaz (libraryDirGecersiz)', async () => {
  const d = mk(JSON.stringify({ libraryDir: '../disari', marketplace: { name: 'm' } }));
  try {
    const before = fs.readFileSync(configFileAt(d));
    await assert.rejects(saveConfigAt(d, { libraryDir: 'library' }, noWrite), (e) => e instanceof PpConfigError && e.data.code === 'libraryDirGecersiz' && e.status === 409);
    assert.deepEqual(fs.readFileSync(configFileAt(d)), before);
    await assert.rejects(assertHealthy(d), (e) => e.data.code === 'libraryDirGecersiz');
  } finally { rmrf(d); }
});

test('saveConfigAt sağlam dosyada ve dosya yokken yazar', async () => {
  const d = mk(JSON.stringify({ libraryDir: 'prompts', marketplace: { name: 'm' } }));
  const d2 = mk();
  try {
    const writes = [];
    const aw = async (abs, data) => { writes.push([abs, data]); fs.writeFileSync(abs, data); };
    const cfg = await loadConfigAt(d);
    cfg.packages.yeni = { description: 'a' };
    await saveConfigAt(d, cfg, aw);
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(configFileAt(d), 'utf8')).packages.yeni.description, 'a');
    assert.equal(JSON.parse(fs.readFileSync(configFileAt(d), 'utf8')).libraryDir, 'prompts');
    // dosya yokken oluşturabilir
    await saveConfigAt(d2, { libraryDir: 'prompts' }, aw);
    assert.equal(writes.length, 2);
    assert.ok(fs.existsSync(configFileAt(d2)));
    assert.equal((await assertHealthy(d)).state, 'ok');
  } finally { rmrf(d); rmrf(d2); }
});

test('hoşgörülü alanlar (version "", "1.0", durumlar metin) bozuk sayılmaz; tipi yanlış export yalnızca uyarıdır', async () => {
  const d = tmpDir();
  try {
    const put = (o) => fs.writeFileSync(configFileAt(d), JSON.stringify(o));
    put({ libraryDir: 'prompts', marketplace: { version: '' } });
    let r = await inspectConfigAt(d);
    assert.equal(r.state, 'ok'); assert.deepEqual(r.issues, []); assert.equal(r.cfg.marketplace.version, '1.0.0');
    put({ marketplace: { version: '1.0' } });
    r = await inspectConfigAt(d);
    assert.deepEqual(r.issues, []); assert.equal(r.cfg.marketplace.version, '1.0');
    // tipi yanlış export alanı bozuk sayılmaz (state 'ok', varsayılana düşer); yalnızca exportAlanGecersiz uyarısı eklenir
    put({ export: { durumlar: 'metin', haricKlasorler: 5 } });
    r = await inspectConfigAt(d);
    assert.equal(r.state, 'ok');
    assert.deepEqual(codes(r), ['exportAlanGecersiz', 'exportAlanGecersiz']);
    assert.deepEqual(r.cfg.export, { durumlar: ['kararlı', ''], haricKlasorler: ['gelen-kutusu'] });
    // nesne olmayan marketplace/packages yok sayılır (dizi yayılımı ya da metin indeksleri yok)
    put({ marketplace: 'x', packages: ['a', 'b'], export: [1] });
    r = await inspectConfigAt(d);
    assert.equal(r.state, 'ok');
    assert.deepEqual(codes(r), ['exportAlanGecersiz']);
    assert.equal(r.cfg.marketplace.name, 'prompt-havuzu');
    assert.deepEqual(r.cfg.packages, {});
    // libraryDir anahtarı yoksa library ve uyarı yok; bilinmeyen anahtarlar korunur
    put({ ozel: { a: 1 } });
    r = await inspectConfigAt(d);
    assert.deepEqual(r.issues, []); assert.equal(r.cfg.libraryDir, 'library'); assert.deepEqual(r.cfg.ozel, { a: 1 });
  } finally { rmrf(d); }
});

test('inspectConfigAt: tipi yanlış export alanı exportAlanGecersiz uyarısı verir; state ok, etkin ayar varsayılan', async () => {
  const d = tmpDir();
  try {
    const put = (o) => fs.writeFileSync(configFileAt(d), JSON.stringify(o));
    const DEF = { durumlar: ['kararlı', ''], haricKlasorler: ['gelen-kutusu'] };

    // export nesne değil: metin, sayı, null, dizi, mantıksal değer
    const tip = [['kararlı', 'metin'], [5, 'sayı'], [null, 'null'], [['kararlı'], 'dizi'], [true, 'mantıksal değer']];
    for (const [v, ad] of tip) {
      put({ marketplace: { name: 'm', version: '3.0.0' }, export: v });
      const r = await inspectConfigAt(d);
      assert.deepEqual(codes(r), ['exportAlanGecersiz'], JSON.stringify(v));
      assert.equal(r.issues[0].level, 'warn');
      assert.equal(r.state, 'ok', "yalnızca uyarı: state 'bozuk' olmaz");
      assert.ok(r.issues[0].message.startsWith('pp.config.json içindeki "export" nesne olmalı (şu an: ' + ad + ')'), r.issues[0].message);
      assert.ok(r.issues[0].message.includes('["kararlı",""]') && r.issues[0].message.includes('varsayılan'), 'varsayılan ileti içinde');
      assert.ok(!r.issues[0].message.includes(d), 'ileti mutlak yol içermemeli');
      assert.deepEqual(r.cfg.export, DEF, JSON.stringify(v));
      assert.equal(r.cfg.marketplace.version, '3.0.0', 'diğer alanlar korunur');
    }

    // durumlar dizi değil (asıl senaryo: "kararlı" metni); haricKlasorler geçerli kalır
    for (const [v, ad] of [['kararlı', 'metin'], [5, 'sayı'], [null, 'null'], [{}, 'nesne'], [true, 'mantıksal değer']]) {
      put({ export: { durumlar: v, haricKlasorler: ['ozel'] } });
      const r = await inspectConfigAt(d);
      assert.deepEqual(codes(r), ['exportAlanGecersiz'], JSON.stringify(v));
      assert.equal(r.issues[0].level, 'warn'); assert.equal(r.state, 'ok');
      assert.ok(r.issues[0].message.startsWith('pp.config.json içindeki "export.durumlar" dizi olmalı (şu an: ' + ad + ')'), r.issues[0].message);
      assert.ok(r.issues[0].message.includes('["kararlı",""]'));
      assert.deepEqual(r.cfg.export, { durumlar: ['kararlı', ''], haricKlasorler: ['ozel'] }, 'yalnızca bozuk alan varsayılana düşer');
    }
    // senaryodaki içerik, aynen
    fs.writeFileSync(configFileAt(d), '{"export":{"durumlar":"kararlı"}}');
    let r = await inspectConfigAt(d);
    assert.deepEqual(codes(r), ['exportAlanGecersiz']); assert.equal(r.state, 'ok');
    assert.deepEqual(r.cfg.export, DEF);

    // haricKlasorler dizi değil; durumlar geçerli kalır
    for (const v of ['gelen-kutusu', 7, null]) {
      put({ export: { durumlar: ['taslak'], haricKlasorler: v } });
      r = await inspectConfigAt(d);
      assert.deepEqual(codes(r), ['exportAlanGecersiz'], JSON.stringify(v));
      assert.ok(r.issues[0].message.startsWith('pp.config.json içindeki "export.haricKlasorler" dizi olmalı (şu an: '), r.issues[0].message);
      assert.ok(r.issues[0].message.includes('["gelen-kutusu"]'));
      assert.deepEqual(r.cfg.export, { durumlar: ['taslak'], haricKlasorler: ['gelen-kutusu'] });
    }
    // iki alan birden: alan başına bir uyarı
    put({ export: { durumlar: 'a', haricKlasorler: 'b' } });
    r = await inspectConfigAt(d);
    assert.deepEqual(codes(r), ['exportAlanGecersiz', 'exportAlanGecersiz']);
    assert.notEqual(r.issues[0].message, r.issues[1].message);

    // başka sorunlarla birlikte: ppConfigBozuk/libraryDirGecersiz önce gelir
    put({ libraryDir: '../disari', export: { durumlar: 'a' } });
    r = await inspectConfigAt(d);
    assert.deepEqual(codes(r), ['libraryDirGecersiz', 'exportAlanGecersiz']);
    assert.equal(r.cfg.libraryDir, 'library');
    // bozuk dosyada export zaten okunmaz: yalnızca ppConfigBozuk
    fs.writeFileSync(configFileAt(d), '{"export":{"durumlar":"kararlı"}');
    r = await inspectConfigAt(d);
    assert.deepEqual(codes(r), ['ppConfigBozuk']); assert.equal(r.state, 'bozuk');
  } finally { rmrf(d); }
});

test('inspectConfigAt: geçerli export ayarında (dizi, boş dizi, anahtar yok, boş nesne) uyarı çıkmaz', async () => {
  const d = tmpDir();
  try {
    const put = (o) => fs.writeFileSync(configFileAt(d), JSON.stringify(o));
    for (const ex of [undefined, {}, { durumlar: ['kararlı', ''] }, { durumlar: [] }, { haricKlasorler: [] }, { durumlar: ['kararlı'], haricKlasorler: ['gelen-kutusu', 'arsiv'] }]) {
      put(ex === undefined ? { libraryDir: 'prompts' } : { libraryDir: 'prompts', export: ex });
      const r = await inspectConfigAt(d);
      assert.deepEqual(r.issues, [], JSON.stringify(ex));
      assert.equal(r.state, 'ok');
    }
    // dosya yokken de uyarı yok
    fs.rmSync(configFileAt(d));
    assert.deepEqual((await inspectConfigAt(d)).issues, []);
  } finally { rmrf(d); }
});

test('exportAlanGecersiz yazmayı engellemez: assertHealthy geçer, saveConfigAt yazar', async () => {
  const d = mk(JSON.stringify({ libraryDir: 'prompts', export: { durumlar: 'kararlı' } }));
  try {
    const h = await assertHealthy(d);
    assert.equal(h.state, 'ok');
    assert.deepEqual(h.issues.map((i) => i.code), ['exportAlanGecersiz']);
    const writes = [];
    const aw = async (abs, data) => { writes.push(abs); fs.writeFileSync(abs, data); };
    const cfg = await loadConfigAt(d);
    cfg.packages.yeni = { description: 'a' };
    await saveConfigAt(d, cfg, aw);
    assert.equal(writes.length, 1, 'yazma engellenmedi');
    assert.equal(JSON.parse(fs.readFileSync(configFileAt(d), 'utf8')).packages.yeni.description, 'a');
  } finally { rmrf(d); }
});

test('libraryDir tablosu: kök dışı, mutlak, UNC, boş, ayrılmış ad -> library + uyarı', async () => {
  const d = tmpDir();
  try {
    const bad = ['../../yeni_dis', '../disari', '..', 'a/../../x', 'C:\\Windows', 'C:/Windows', '/etc', '\\\\sunucu\\paylasim\\x', '', '   ', '.', './', 'a//b', 'a/./b',
      '.git', '.GIT', '.pp', '.claude-plugin', 'Plugins', 'plugins', 'a/plugins', 'prompts.', 'a /b', 'a:b', 'a|b', 'a<b', 'a*b', 'a?b', 'a"b', 'a\u0001b', 5, null, ['prompts'], {}];
    for (const v of bad) {
      fs.writeFileSync(configFileAt(d), JSON.stringify({ libraryDir: v, marketplace: { name: 'm', version: '3.0.0' } }));
      const r = await inspectConfigAt(d);
      assert.deepEqual(codes(r), ['libraryDirGecersiz'], JSON.stringify(v));
      assert.equal(r.state, 'ok', JSON.stringify(v));
      assert.equal(r.cfg.libraryDir, 'library', JSON.stringify(v));
      assert.equal(r.cfg.marketplace.version, '3.0.0', 'diğer alanlar korunur');
      assert.match(r.issues[0].message, /^pp\.config\.json içindeki "libraryDir" geçersiz \(/);
      assert.ok(!r.issues[0].message.includes(d));
    }
    assert.deepEqual(fs.readdirSync(d), ['pp.config.json'], 'diske hiçbir şey oluşmadı');
    assert.equal(fs.existsSync(path.join(d, 'library')), false);
  } finally { rmrf(d); }
});

test('libraryDir normalize: ./prompts, prompts/, prompts\\x, a/b', async () => {
  const d = tmpDir();
  try {
    const cases = [['prompts', 'prompts'], ['library', 'library'], ['./prompts', 'prompts'], ['prompts/', 'prompts'], ['prompts//', 'prompts'],
      ['prompts\\sub', 'prompts/sub'], ['a/b', 'a/b'], ['.\\prompts\\', 'prompts'], [' prompts ', 'prompts'], ['./././x', 'x'], ['..foo', '..foo']];
    for (const [raw, want] of cases) {
      fs.writeFileSync(configFileAt(d), JSON.stringify({ libraryDir: raw }));
      const r = await inspectConfigAt(d);
      assert.deepEqual(r.issues, [], raw);
      assert.equal(r.cfg.libraryDir, want, raw);
    }
  } finally { rmrf(d); }
});

test('libraryDir: kök dışına işaret eden junction geçersiz, kök içine işaret eden geçerli', async (t) => {
  const d = tmpDir(); const out = tmpDir();
  const link = path.join(d, 'prompts');
  try {
    if (!makeLink(out, link)) return t.skip('bağlantı kurulamadı (EPERM)');
    fs.writeFileSync(configFileAt(d), JSON.stringify({ libraryDir: 'prompts' }));
    let r = await inspectConfigAt(d);
    assert.deepEqual(codes(r), ['libraryDirGecersiz']);
    assert.equal(r.cfg.libraryDir, 'library');
    assert.match(r.issues[0].message, /dışına çıkıyor/);
    removeLink(link);
    // kök içine işaret eden bağlantı geçerli
    fs.mkdirSync(path.join(d, 'gercek'));
    assert.ok(makeLink(path.join(d, 'gercek'), link));
    r = await inspectConfigAt(d);
    assert.deepEqual(r.issues, []);
    assert.equal(r.cfg.libraryDir, 'prompts');
    // marketplace kökünün kendisine işaret eden bağlantı da geçersiz (kök içinde değil, eşit)
    removeLink(link);
    assert.ok(makeLink(d, link));
    assert.deepEqual(codes(await inspectConfigAt(d)), ['libraryDirGecersiz']);
  } finally { removeLink(link); rmrf(d); rmrf(out); }
});

test('assertHealthy: sağlam ve yok durumlarında inspect sonucunu döndürür', async () => {
  const d = tmpDir();
  try {
    assert.equal((await assertHealthy(d)).state, 'yok');
    fs.writeFileSync(configFileAt(d), '{}');
    assert.equal((await assertHealthy(d)).state, 'ok');
    fs.writeFileSync(configFileAt(d), 'null');
    await assert.rejects(assertHealthy(d), (e) => e instanceof PpConfigError && e.data.code === 'ppConfigBozuk');
  } finally { rmrf(d); }
});
