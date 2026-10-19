'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Rules = require('../public/rules.js');

test('normTur: eşanlamlılar ve geçersiz değerler', () => {
  for (const [v, e] of [['komut', 'komut'], ['Command', 'komut'], ['slash', 'komut'], ['ajan', 'ajan'], ['Agent', 'ajan'],
    ['subagent', 'ajan'], ['skill', 'skill'], ['beceri', 'skill'], ['komutt', ''], ['', ''], [undefined, ''], [['komut', 'ajan'], '']]) {
    assert.equal(Rules.normTur(v), e, String(v));
  }
});

test('checkVersion: geçerli ve geçersiz', () => {
  assert.equal(Rules.checkVersion('1.0.0'), null);
  assert.equal(Rules.checkVersion('10.2.33'), null);
  assert.equal(Rules.checkVersion(''), 'Sürüm boş olamaz (örnek: 1.0.0)');
  assert.equal(Rules.checkVersion(' '), 'Sürüm boş olamaz (örnek: 1.0.0)');
  for (const v of ['1.0', '01.0.0', '1.0.0-beta', 'v1.0.0']) {
    assert.equal(Rules.checkVersion(v), `Sürüm X.Y.Z biçiminde olmalı (örnek: 1.0.0): "${v}"`, v);
  }
});

test('normalizeVersion', () => {
  assert.equal(Rules.normalizeVersion(''), '1.0.0');
  assert.equal(Rules.normalizeVersion(undefined), '1.0.0');
  assert.equal(Rules.normalizeVersion(' 2.0.1 '), '2.0.1');
  assert.equal(Rules.normalizeVersion('1.0'), '1.0');
});

test('isFmBroken: BOM ve CRLF', () => {
  assert.equal(Rules.isFmBroken('---\nbaslik: A\n', false), true);
  assert.equal(Rules.isFmBroken('﻿---\r\nbaslik: A\r\n', false), true);
  assert.equal(Rules.isFmBroken('---\nbaslik: A\n---\n', true), false);
  assert.equal(Rules.isFmBroken('merhaba\n', false), false);
  assert.equal(Rules.isFmBroken('', false), false);
});

test('publishCheck: tablo', () => {
  const t = [
    [{ meta: {}, hasFm: false }, 'yayinDisi'],
    [{ meta: { komut_adi: 'x' }, hasFm: true }, 'turYok'],
    [{ meta: { tur: 'komutt' } }, 'turGecersiz'],
    [{ meta: { tur: ['komut', 'ajan'] } }, 'turGecersiz'],
    [{ fmBroken: true }, 'onYuzKapanmamis'],
    [{ meta: { tur: 'Command' } }, null],
    [{ meta: { tur: 'komutt' }, fmBroken: true }, 'onYuzKapanmamis']
  ];
  for (const [inp, code] of t) {
    const r = Rules.publishCheck(inp);
    assert.equal(r ? r.code : null, code, JSON.stringify(inp));
  }
  const r = Rules.publishCheck({ meta: { komut_adi: 'x' }, hasFm: true });
  assert.deepEqual(r.fields, ['komut_adi']);
  assert.equal(r.level, 'warn');
  assert.equal(r.reason, 'Yayın alanları dolu (komut_adi) ama "tur" yok. Bu prompt yayınlanmayacak.');
  assert.equal(Rules.publishCheck({ meta: {} }).level, 'info');
});

test('coerceVersion: K3 tablosu', () => {
  const eq = (v, e) => assert.deepEqual(Rules.coerceVersion(v), e, String(v));
  eq(undefined, { version: '', legacy: false });
  eq('', { version: '', legacy: false });
  eq('1.0.2', { version: '1.0.2', legacy: false });
  eq('1', { version: '1.0.0', legacy: true });
  eq('1.2', { version: '1.2.0', legacy: true });
  eq('v1.0.2', { version: '1.0.2', legacy: true });
  eq('01.2', { version: '1.2.0', legacy: true });
  eq('1.0.0-beta', null);
  eq('taslak', null);
  eq([1, 2], null);
});

test('bumpVersion ve compareVersions', () => {
  assert.equal(Rules.bumpVersion('', 'buyuk'), '1.0.0');
  assert.equal(Rules.bumpVersion('1', 'yama'), '1.0.1');
  assert.equal(Rules.bumpVersion('1.2', 'kucuk'), '1.3.0');
  assert.equal(Rules.bumpVersion('1.9.9', 'buyuk'), '2.0.0');
  assert.equal(Rules.bumpVersion('1.0.0-beta', 'yama'), null);
  assert.equal(Rules.bumpVersion('1.0.0', 'x'), null);
  assert.equal(Rules.compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(Rules.compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(Rules.compareVersions('0.9.0', '1.0.0'), -1);
});

test('promptTagAd, promptTag, parsePromptTag', () => {
  assert.equal(Rules.promptTagAd('prompts/Örnek Klasör/Merhaba Dünya.md', 'prompts'), 'ornek-klasor/merhaba-dunya');
  assert.equal(Rules.promptTagAd('prompts/ornek/a.md', 'prompts'), 'ornek/a');
  assert.equal(Rules.promptTagAd('plugins/x.md', 'prompts'), null);
  const t = Rules.promptTag('ornek/a', '1.0.3');
  assert.equal(t, 'prompt/ornek/a/v1.0.3');
  assert.deepEqual(Rules.parsePromptTag(t), { ad: 'ornek/a', version: '1.0.3' });
  assert.equal(Rules.parsePromptTag('prompt/a/v1.0'), null);
  assert.equal(Rules.parsePromptTag('paket/a/v1.0.0'), null);
  assert.match(Rules.MSG.surumGuncelDegil('1.0.2'), /v1\.0\.2/);
});

test('checkPluginName: tablo', () => {
  for (const ad of ['claude-x', 'anthropic', 'anthropics-a', 'cc-plugin-a', 'claude', 'claude-code', 'claude-mods', 'official-claude', 'anthropic-official', 'gelen-kutusu', 'tools', 'node_modules', '', 'x-claude-official']) {
    assert.equal(typeof Rules.checkPluginName(ad), 'string', ad);
  }
  for (const ad of ['kod', 'mcp-for-claude', 'claudex', 'official', 'kod-inceleme']) assert.equal(Rules.checkPluginName(ad), null, ad);
  assert.equal(Rules.checkPluginName('gelen-kutusu'), '"gelen-kutusu" içe aktarma klasörüne ayrılmış. Başka bir ad seç.');
  assert.equal(Rules.checkPluginName('tools'), '"tools" adı sistemde ayrılmış. Başka bir ad seç.');
  assert.match(Rules.checkPluginName('claude-x'), /^"claude-x" adı Anthropic'e ayrılmış \(/);
});

test('pluginNameWarn', () => {
  assert.equal(Rules.pluginNameWarn('mcp-for-claude'), '"mcp-for-claude" içinde "claude" kelimesi geçiyor; Claude Code bunu uyarıyla kabul eder.');
  assert.equal(Rules.pluginNameWarn('my-anthropic-tools'), '"my-anthropic-tools" içinde "anthropic" kelimesi geçiyor; Claude Code bunu uyarıyla kabul eder.');
  assert.equal(Rules.pluginNameWarn('claudex'), null);
  assert.equal(Rules.pluginNameWarn('a'.repeat(129)), 'Plugin adı 128 karakterden uzun; Claude Desktop kabul etmeyebilir.');
  assert.equal(Rules.pluginNameWarn('kod'), null);
});

test('classifyPromptPath: dört tür ve kenar durumlar', () => {
  const c = (p, l = 'prompts') => Rules.classifyPromptPath(p, l);
  assert.deepEqual(c('prompts/ornek/a.md'), { kind: 'paket', klasor: 'ornek', paket: 'ornek' });
  assert.deepEqual(c('prompts/Kod İnceleme/alt/a.md'), { kind: 'paket', klasor: 'Kod İnceleme', paket: 'kod-inceleme' });
  assert.deepEqual(c('prompts/x.md'), { kind: 'klasorsuz', klasor: null, paket: null });
  assert.equal(c('prompts/gelen-kutusu/x.md').kind, 'gelenKutusu');
  assert.equal(c('prompts/gelen-kutusu/alt/x.md').kind, 'gelenKutusu');
  assert.equal(c('prompts/.gizli/x.md').kind, 'disarida');
  assert.equal(c('plugins/a/commands/x.md').kind, 'disarida');
  assert.equal(c('prompts2/a/x.md').kind, 'disarida');
  assert.equal(c('prompts/a/x.md', 'prompts/').kind, 'paket', 'libraryDir sonundaki /');
  assert.equal(c('prompts\\a\\x.md').kind, 'paket', 'ters eğik çizgi');
  assert.equal(c('prompts/a/x.md', '').kind, 'disarida');
});

test('RESERVED_DIRS server.js IGNORE ile aynı kaynaktan gelir', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /const IGNORE = new Set\(Rules\.RESERVED_DIRS\);/);
  assert.deepEqual(Rules.RESERVED_DIRS.slice().sort(), ['.git', '.pp', 'node_modules', 'tools']);
  assert.equal(Rules.INBOX_DIR, 'gelen-kutusu');
});

test('MSG.paketUyusmuyor', () => {
  assert.equal(Rules.MSG.paketUyusmuyor('kod', 'x'), 'Dosya "kod" paketinin klasöründe ama "paket" alanı "x". Paket klasörden alınır; alanı düzelt ya da dosyayı taşı.');
  assert.equal(Rules.MSG.paketUyusmuyorBilgi, undefined);
});

test('parseLibraryDir tablosu', () => {
  const ok = (v, want) => assert.deepEqual(Rules.parseLibraryDir(v), { value: want, error: null }, JSON.stringify(v));
  ok('prompts', 'prompts'); ok('library', 'library'); ok('a/b', 'a/b'); ok('./prompts', 'prompts'); ok('prompts/', 'prompts');
  ok('prompts\\sub', 'prompts/sub'); ok('  prompts  ', 'prompts'); ok('.\\prompts\\', 'prompts'); ok('..foo', '..foo'); ok('Prompts', 'Prompts');
  ok('a/b/', 'a/b');
  const bad = (v) => { const r = Rules.parseLibraryDir(v); assert.equal(r.value, null, JSON.stringify(v)); assert.equal(typeof r.error, 'string', JSON.stringify(v)); assert.ok(r.error.length > 0); };
  for (const v of ['', '   ', '.', './', '..', '../x', 'a/../b', 'a/..', '../../disari', '/etc', '\\x', 'C:', 'C:\\Windows', 'C:/x', '\\\\srv\\share', '//srv/share',
    'a//b', 'a/./b', '.git', '.GIT', 'a/.Git', '.pp', '.claude-plugin', 'plugins', 'Plugins', 'a/plugins/b', 'prompts.', 'a./b', 'a /b',
    'a:b', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b', 'a\u0000b', 'a\nb', undefined, null, 5, true, ['a'], {}]) bad(v);
  assert.match(Rules.parseLibraryDir('..').error, /"\.\."/);
  assert.match(Rules.parseLibraryDir('plugins').error, /ayrılmış/);
  assert.match(Rules.parseLibraryDir('/etc').error, /mutlak/);
});

test('isProtectedPath tablosu (iç içe libraryDir dahil)', () => {
  const p = (rel, lib = 'prompts') => Rules.isProtectedPath(rel, lib);
  for (const rel of ['prompts', 'Prompts', 'PROMPTS', 'prompts/', '/prompts', 'prompts.', 'prompts ', 'plugins', 'Plugins',
    '.claude-plugin', '.CLAUDE-PLUGIN', '.gitignore', '.gitattributes', '.pp', '.pp/trash', '.pp/trash/2026/x.md', '.PP/x', '.pp.', 'prompts\\']) {
    assert.equal(p(rel), true, rel);
  }
  for (const rel of ['prompts/x', 'prompts/x/a.md', 'prompts/gelen-kutusu', 'plugins/mk', 'plugins/mk/commands/a.md', '.claude-plugin/marketplace.json',
    'README.md', 'pp.config.json', 'PP.Config.JSON', 'x/pp.config.json', 'x/plugins', 'x/.pp', 'prompts2', 'tools', '', '.ppx', '.gitignore/x']) {
    assert.equal(p(rel), false, rel);
  }
  // iç içe libraryDir: üst klasörler de korunur
  assert.equal(p('a', 'a/b'), true); assert.equal(p('a/b', 'a/b'), true); assert.equal(p('A/B', 'a/b'), true);
  assert.equal(p('a/b/c', 'a/b'), false); assert.equal(p('a/x', 'a/b'), false); assert.equal(p('b', 'a/b'), false);
  // libraryDir biçimleri normalize edilir; geçersiz/yoksa yalnızca sabit yollar korunur
  assert.equal(p('prompts', './prompts/'), true);
  assert.equal(Rules.isProtectedPath('prompts', undefined), false);
  assert.equal(p('prompts', '../x'), false);
  assert.equal(Rules.isProtectedPath('pp.config.json', undefined), false);
  assert.equal(Rules.isProtectedPath('plugins', undefined), true);
  assert.equal(p('library', 'library'), true);
});

test('isDeviceName ve checkEntryName', () => {
  for (const ad of ['CON', 'con', 'Con', 'PRN', 'aux', 'NUL', 'nul.txt', 'NUL.md', 'COM1', 'com9', 'Com1.md', 'LPT1', 'lpt9', 'CONIN$', 'conout$', 'con.tar.gz', 'con .txt']) {
    assert.equal(Rules.isDeviceName(ad), true, ad);
  }
  for (const ad of ['', 'cons', 'concat', 'com0', 'com10', 'lpt0', 'xcon', 'con-1', 'a.con', '.con', 'nulo', 'prompt', 'comm1', undefined, null]) {
    assert.equal(Rules.isDeviceName(ad), false, String(ad));
  }
  assert.equal(Rules.checkEntryName('normal.md'), null);
  assert.equal(Rules.checkEntryName('Türkçe İsim ğüşiöç.md'), null);
  assert.equal(Rules.checkEntryName('.gitkeep'), null);
  assert.equal(Rules.checkEntryName('a'.repeat(197) + '.md'), null);
  assert.equal(Rules.MAX_NAME_BYTES, 200);
  assert.equal(Rules.checkEntryName('a'.repeat(250) + '.md'), 'Ad en çok 200 bayt olabilir');
  assert.equal(Rules.checkEntryName('ş'.repeat(101)), 'Ad en çok 200 bayt olabilir', 'bayt sayılır, karakter değil');
  assert.equal(Rules.checkEntryName('ş'.repeat(100)), null);
  assert.equal(Rules.checkEntryName('CON.md'), Rules.MSG.aygitAdi('CON.md'));
  assert.match(Rules.checkEntryName('nul'), /Windows aygıt adı/);
  for (const bad of ['', '.', '..', 'a?b', 'a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a*b', 'a\u0000b', 'a\tb', 'x.', 'x ', 'x...']) {
    assert.equal(typeof Rules.checkEntryName(bad), 'string', JSON.stringify(bad));
  }
  assert.equal(Rules.checkEntryName('a/b'), null, 'ayraç bu kuralın konusu değil (yol bileşeni verilir)');
});

test('RESERVED_DIRS değişmedi, LIBRARY_DIR_RESERVED ayrı sabit', () => {
  assert.deepEqual(Rules.RESERVED_DIRS.slice().sort(), ['.git', '.pp', 'node_modules', 'tools']);
  assert.deepEqual(Rules.LIBRARY_DIR_RESERVED.slice().sort(), ['.claude-plugin', '.git', '.pp', 'plugins']);
  assert.notEqual(Rules.LIBRARY_DIR_RESERVED, Rules.RESERVED_DIRS);
});

test('checkVersion/coerceVersion 9 basamak sınırı (B-13)', () => {
  assert.equal(Rules.checkVersion('999999999.999999999.999999999'), null);
  assert.equal(Rules.checkVersion('0.0.0'), null);
  for (const v of ['9007199254740993.0.0', '1000000000.0.0', '1.1000000000.0', '1.0.1000000000', '1000000000000000000000.0.0']) {
    assert.equal(Rules.checkVersion(v), 'Sürüm bileşenleri en çok 9 basamak olabilir: "' + v + '"', v);
  }
  assert.match(Rules.checkVersion('1e+21.0.0'), /X\.Y\.Z biçiminde/);
  assert.match(Rules.checkVersion('01.0.0'), /X\.Y\.Z biçiminde/);
  assert.equal(Rules.SEMVER_RE.test('1000000000.0.0'), false);
  assert.equal(Rules.VERSION_PART_MAX, 999999999);
  const c = (v) => Rules.coerceVersion(v);
  assert.equal(c('99999999999.1.1'), null);
  assert.equal(c('9007199254740993.0.0'), null);
  assert.equal(c('1.2.99999999999'), null);
  assert.equal(c('1000000000'), null);
  assert.equal(c('v1000000000.1'), null);
  assert.equal(c('1e+21.0.0'), null);
  assert.deepEqual(c('999999999.1.1'), { version: '999999999.1.1', legacy: false });
  assert.deepEqual(c('999999999'), { version: '999999999.0.0', legacy: true });
  assert.deepEqual(c('0000000001.2'), { version: '1.2.0', legacy: true }, 'baştaki sıfırlar sayılmaz');
  assert.deepEqual(c('00'), { version: '0.0.0', legacy: true });
});

test('bumpVersion taşmada null döner; 1e+21 üretilmez (B-13)', () => {
  assert.equal(Rules.bumpVersion('999999999.0.0', 'buyuk'), null);
  assert.equal(Rules.bumpVersion('1.999999999.0', 'kucuk'), null);
  assert.equal(Rules.bumpVersion('1.1.999999999', 'yama'), null);
  assert.equal(Rules.bumpVersion('999999999', 'buyuk'), null);
  assert.equal(Rules.bumpVersion('99999999999.1.1', 'yama'), null);
  assert.equal(Rules.bumpVersion('1000000000000000000000.0.0', 'yama'), null);
  assert.equal(Rules.bumpVersion('999999998.0.0', 'buyuk'), '999999999.0.0');
  assert.equal(Rules.bumpVersion('999999999.0.0', 'kucuk'), '999999999.1.0');
  assert.equal(Rules.bumpVersion('1.1.999999998', 'yama'), '1.1.999999999');
  assert.equal(Rules.bumpVersion('', 'buyuk'), '1.0.0');
  assert.equal(Rules.levelBetween('1000000000.0.0', '1.0.0'), null);
});

test('MSG.anahtarTekrar', () => {
  assert.equal(Rules.MSG.anahtarTekrar([{ key: 'baslik', count: 2 }]), 'baslik 2 kez yazılmış; sonuncusu geçerli.');
  assert.equal(Rules.MSG.anahtarTekrar(['baslik']), 'baslik 2 kez yazılmış; sonuncusu geçerli.');
  assert.equal(Rules.MSG.anahtarTekrar([{ key: 'baslik', count: 2 }, { key: 'durum', count: 3 }]),
    'baslik (2 kez), durum (3 kez) birden fazla kez yazılmış; hepsinde sonuncusu geçerli.');
});
