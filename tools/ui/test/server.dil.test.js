'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const I18n = require('../public/i18n.js');
const DICT_TR = require('../public/lang/tr.js');
const DICT_EN = require('../public/lang/en.js');
const { gitAvailable, tmpDir, rmrf } = require('./helpers');
const { startServer, setupMarketplace } = require('./server-helper');

/** Summary: Sunucunun kullandığı ayar dosyasını (PP_CONFIG) ayrıştırır. */
const readCfg = (srv) => JSON.parse(fs.readFileSync(srv.cfg, 'utf8'));
const EN = { headers: { 'X-PP-Lang': 'en' } };

test('dil: varsayılan auto; GET info ve settings language döner; eski ayar dosyası (language yok) okunur ve okuma dosyayı değiştirmez', async () => {
  const tmp = tmpDir();
  const old = JSON.stringify({ version: 1, libraryRoot: '', activeMarketplace: '', remoteCheck: 'elle' });
  fs.mkdirSync(path.join(tmp, 'cfg'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'cfg', 'config.json'), old);
  const srv = await startServer(tmp);
  try {
    let r = await srv.call('GET', '/api/info');
    assert.equal(r.status, 200);
    assert.equal(r.data.language, 'auto');
    r = await srv.call('GET', '/api/settings');
    assert.equal(r.status, 200);
    assert.equal(r.data.language, 'auto');
    assert.equal(r.data.remoteCheck, 'elle', 'eski alanlar korunur');
    assert.equal(fs.readFileSync(srv.cfg, 'utf8'), old, 'okuma ayar dosyasını yeniden yazmaz');
  } finally { await srv.stop(); rmrf(tmp); }
});

test('dil: dosya hiç yokken de language auto döner', async () => {
  const tmp = tmpDir();
  const srv = await startServer(tmp);
  try {
    assert.equal((await srv.call('GET', '/api/info')).data.language, 'auto');
    assert.equal((await srv.call('GET', '/api/settings')).data.language, 'auto');
    assert.equal(fs.existsSync(srv.cfg), false);
  } finally { await srv.stop(); rmrf(tmp); }
});

test('dil: PUT yalnızca language ile, library kökü olmadan çalışır; config.json, info ve settings güncellenir', async () => {
  const tmp = tmpDir();
  const srv = await startServer(tmp);
  try {
    let r = await srv.call('PUT', '/api/settings', { language: 'en' });
    assert.equal(r.status, 200);
    assert.equal(r.data.language, 'en');
    assert.equal(r.data.libraryRoot, '');
    assert.deepEqual(readCfg(srv), { version: 1, libraryRoot: '', activeMarketplace: '', remoteCheck: 'acilista', language: 'en' });
    assert.equal((await srv.call('GET', '/api/info')).data.language, 'en');
    assert.equal((await srv.call('GET', '/api/settings')).data.language, 'en');

    for (const lang of ['tr', 'auto', 'en']) {
      r = await srv.call('PUT', '/api/settings', { language: lang });
      assert.equal(r.status, 200, lang);
      assert.equal(r.data.language, lang);
      assert.equal(readCfg(srv).language, lang);
      assert.equal((await srv.call('GET', '/api/info')).data.language, lang);
    }
  } finally { await srv.stop(); rmrf(tmp); }
});

test('dil: dil ayarı sunucu iletisinin dilini değiştirmez; yalnızca X-PP-Lang başlığı belirler', async () => {
  const tmp = tmpDir();
  const srv = await startServer(tmp);
  try {
    assert.equal((await srv.call('PUT', '/api/settings', { language: 'en' })).status, 200);
    let r = await srv.call('GET', '/api/yok-boyle-bir-yol');
    assert.equal(r.status, 404);
    assert.deepEqual(r.data, { error: 'Bulunamadı' });
    r = await srv.call('GET', '/api/yok-boyle-bir-yol', undefined, EN);
    assert.deepEqual(r.data, { error: 'Not found' });
    assert.equal((await srv.call('PUT', '/api/settings', { language: 'tr' })).status, 200);
    r = await srv.call('GET', '/api/yok-boyle-bir-yol', undefined, EN);
    assert.deepEqual(r.data, { error: 'Not found' });
  } finally { await srv.stop(); rmrf(tmp); }
});

test('dil: geçersiz değer 400 { field: language }, ileti X-PP-Lang diline göre, ayar dosyası değişmez', async () => {
  const tmp = tmpDir();
  const srv = await startServer(tmp);
  try {
    assert.equal((await srv.call('PUT', '/api/settings', { language: 'en' })).status, 200);
    const before = fs.readFileSync(srv.cfg, 'utf8');
    for (const bad of ['de', 'EN', 'Tr', ' tr', 'auto ', '', null, 5, true, ['tr'], { tr: 1 }]) {
      let r = await srv.call('PUT', '/api/settings', { language: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.data.field, 'language', JSON.stringify(bad));
      assert.equal(r.data.error, 'Geçersiz değer', JSON.stringify(bad));
      r = await srv.call('PUT', '/api/settings', { language: bad }, EN);
      assert.equal(r.status, 400);
      assert.deepEqual(r.data, { error: 'Invalid value', field: 'language' });
    }
    assert.equal(fs.readFileSync(srv.cfg, 'utf8'), before);
    assert.equal((await srv.call('GET', '/api/settings')).data.language, 'en');
  } finally { await srv.stop(); rmrf(tmp); }
});

test('dil: remoteCheck ile birlikte tercih alanları birlikte kaydedilir; geçersiz biri hiçbirini yazdırmaz; remoteCheck hatası eskisi gibi', async () => {
  const tmp = tmpDir();
  const srv = await startServer(tmp);
  try {
    let r = await srv.call('PUT', '/api/settings', { remoteCheck: 'elle', language: 'tr' });
    assert.equal(r.status, 200);
    assert.equal(r.data.remoteCheck, 'elle'); assert.equal(r.data.language, 'tr');
    assert.deepEqual(readCfg(srv), { version: 1, libraryRoot: '', activeMarketplace: '', remoteCheck: 'elle', language: 'tr' });

    r = await srv.call('PUT', '/api/settings', { remoteCheck: 'saatlik', language: 'en' });
    assert.equal(r.status, 400); assert.equal(r.data.field, 'remoteCheck'); assert.equal(r.data.error, 'Geçersiz değer');
    r = await srv.call('PUT', '/api/settings', { remoteCheck: 'acilista', language: 'de' });
    assert.equal(r.status, 400); assert.equal(r.data.field, 'language');
    assert.deepEqual(readCfg(srv), { version: 1, libraryRoot: '', activeMarketplace: '', remoteCheck: 'elle', language: 'tr' });

    r = await srv.call('PUT', '/api/settings', { remoteCheck: 'acilista' });
    assert.equal(r.status, 200);
    assert.equal(r.data.language, 'tr', 'remoteCheck tek başına dili korur');
    assert.equal(readCfg(srv).language, 'tr');
  } finally { await srv.stop(); rmrf(tmp); }
});

test('dil: libraryRoot ile birlikte kaydedilir; geçersiz dil kökü de kaydetmez; yalnızca libraryRoot dili korur', async () => {
  const tmp = tmpDir();
  const srv = await startServer(tmp);
  try {
    const lib = path.join(tmp, 'PromptLibrary');
    let r = await srv.call('PUT', '/api/settings', { libraryRoot: lib, create: true, language: 'de' });
    assert.equal(r.status, 400); assert.equal(r.data.field, 'language');
    assert.equal(fs.existsSync(lib), false, 'doğrulama başarısızsa klasör de oluşturulmaz');
    assert.equal(fs.existsSync(srv.cfg), false, 'ayar dosyası yazılmaz');

    r = await srv.call('PUT', '/api/settings', { libraryRoot: lib, create: true, language: 'en' });
    assert.equal(r.status, 200);
    assert.equal(r.data.language, 'en');
    assert.equal(r.data.libraryRoot, lib);
    const cfg = readCfg(srv);
    assert.equal(cfg.libraryRoot, lib); assert.equal(cfg.language, 'en'); assert.equal(cfg.remoteCheck, 'acilista');
    assert.equal(fs.statSync(lib).isDirectory(), true);

    const lib2 = path.join(tmp, 'Baska');
    r = await srv.call('PUT', '/api/settings', { libraryRoot: lib2, create: true });
    assert.equal(r.status, 200);
    assert.equal(r.data.language, 'en', 'dil verilmeyen kök kaydı dili korur');
    assert.equal(readCfg(srv).language, 'en');
    assert.equal(readCfg(srv).libraryRoot, lib2);

    r = await srv.call('PUT', '/api/settings', { libraryRoot: lib, language: 'auto', remoteCheck: 'elle' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.data.language, r.data.remoteCheck, r.data.libraryRoot], ['auto', 'elle', lib]);
  } finally { await srv.stop(); rmrf(tmp); }
});

test('dil: yalnızca dil kaydı library kökünü ve etkin marketplace\'i değiştirmez; X-PP başlığı yine gerekir', { skip: !gitAvailable && 'git yok' }, async () => {
  const tmp = tmpDir();
  const srv = await startServer(tmp);
  try {
    const { lib, name } = await setupMarketplace(srv, tmp);
    const before = readCfg(srv);
    assert.equal(before.activeMarketplace, name);
    let r = await srv.call('PUT', '/api/settings', { language: 'en' });
    assert.equal(r.status, 200);
    assert.equal(r.data.libraryRoot, lib);
    assert.equal(r.data.activeMarketplace, name);
    assert.equal(r.data.setup.ok, true);
    assert.deepEqual(readCfg(srv), { ...before, language: 'en' });
    r = await srv.call('GET', '/api/info');
    assert.equal(r.data.language, 'en');
    assert.equal(r.data.activeMarketplace, name);

    r = await srv.call('PUT', '/api/settings', { language: 'tr' }, { headers: { 'X-PP': null } });
    assert.equal(r.status, 403);
    assert.equal(readCfg(srv).language, 'en');
  } finally { await srv.stop(); rmrf(tmp); }
});

/** Summary: Git gerektiren testleri git yoksa atlar. */
const real = { skip: !gitAvailable && 'git yok' };
/** Summary: Açık Türkçe ve geçersiz dil başlıkları (ikisi de Türkçe sonuç verir). */
const TR_HDR = { headers: { 'X-PP-Lang': 'tr' } };
const BAD_HDR = { headers: { 'X-PP-Lang': 'fr' } };
/** Summary: Bu aşamada server.js'in sahip olduğu sözlük ad uzayları. */
const SERVER_PREFIXES = [
  'err.api.', 'err.http.', 'err.static.', 'err.fs.', 'err.setup.', 'err.settings.', 'err.marketplace.', 'err.import.', 'err.file.', 'err.dir.',
  'err.rename.', 'err.package.', 'err.transfer.', 'err.git.', 'err.history.', 'err.version.', 'err.unpublish.', 'srv.'
];
const DIACRITIC_RE = /[çğıöşüÇĞİÖŞÜ]/;
const PLACEHOLDER_RE = /\{([A-Za-z_]\w*)\}/g;

/** Summary: Sunucu ve marketplace kurar, fn'e verir, sonunda kapatıp temizler. */
async function withMarketplace(fn) {
  const tmp = tmpDir();
  const srv = await startServer(tmp);
  try {
    const mp = await setupMarketplace(srv, tmp);
    await fn({ tmp, srv, call: srv.call, ...mp });
  } finally { await srv.stop(); rmrf(tmp); }
}

/** Summary: Başlıksız, tr ve geçersiz dil başlığıyla Türkçe; en ile İngilizce ileti ve aynı durum kodunu doğrular. */
async function expectBothLanguages(call, method, url, body, want) {
  const check = (r, text, label) => {
    assert.equal(r.status, want.status, `${label} ${method} ${url}: ${r.text}`);
    assert.equal(r.data.error, text, `${label} ${method} ${url}`);
    for (const [key, value] of Object.entries(want.extra || {})) assert.deepEqual(r.data[key], value, `${label} ${key}`);
  };
  for (const [label, headers] of [['başlıksız', undefined], ['tr', TR_HDR], ['fr', BAD_HDR]]) check(await call(method, url, body, headers), want.tr, label);
  const en = await call(method, url, body, EN);
  check(en, want.en, 'en');
  return en;
}

/** Summary: Host ve Origin gibi başlıkları serbestçe ayarlayan ham HTTP isteği. */
function rawRequest(srv, { method = 'GET', url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const target = new URL(srv.base);
    const req = http.request({ host: target.hostname, port: target.port, method, path: url, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let data; try { data = JSON.parse(text); } catch (e) { data = text; }
        resolve({ status: res.statusCode, data, text });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Summary: Yorum satırlarını ve blok yorumlarını ayıklar. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\s\/\/ .*$/, '')).join('\n');
}

/** Summary: Şablondaki yer tutucu adları, tekil ve sıralı. */
const placeholders = (text) => [...new Set([...String(text).matchAll(PLACEHOLDER_RE)].map((m) => m[1]))].sort();

test('dil/sunucu: 400 geçersiz yol ve 404 dosya yok; başlıksız, tr ve geçersiz değer Türkçe, en İngilizce', real, async () => {
  await withMarketplace(async ({ call }) => {
    await expectBothLanguages(call, 'GET', '/api/file?path=..%2Fdisari.md', undefined, { status: 400, tr: 'Geçersiz yol', en: 'Invalid path' });
    await expectBothLanguages(call, 'GET', '/api/file?path=', undefined, { status: 400, tr: 'Yol gerekli', en: 'Path is required' });
    await expectBothLanguages(call, 'GET', '/api/file?path=prompts%2Fyok.md', undefined, { status: 404, tr: 'Dosya bulunamadı', en: 'File not found' });
    await expectBothLanguages(call, 'GET', '/api/version?path=prompts%2Fyok.md', undefined, { status: 404, tr: 'Dosya bulunamadı', en: 'File not found' });
    await expectBothLanguages(call, 'PUT', '/api/file', { path: 'prompts/yok.md', raw: 'x' }, {
      status: 404, tr: 'Dosya bulunamadı. Silinmiş veya taşınmış olabilir', en: 'File not found. It may have been deleted or moved'
    });
    await expectBothLanguages(call, 'PUT', '/api/file', { path: 'prompts/a.md' }, { status: 400, tr: 'İçerik gerekli', en: 'Content is required' });
    await expectBothLanguages(call, 'POST', '/api/rename', { from: 'prompts/yok.md', to: 'prompts/baska.md' }, {
      status: 404, tr: 'Kaynak bulunamadı', en: 'Source not found'
    });
  });
});

test('dil/sunucu: 409 etkinDegil (X-PP-MP uyuşmazlığı) iletisi X-PP-Lang diline göre; code ve active değişmez', real, async () => {
  await withMarketplace(async ({ call, name }) => {
    const headers = (lang) => ({ headers: { 'X-PP-Lang': lang, 'X-PP-MP': encodeURIComponent('baska') } });
    const want = {
      tr: `Etkin marketplace değişti (şu an: ${name}). Ağaçtan yeniden seç.`,
      en: `The active marketplace changed (now: ${name}). Select it again in the tree.`
    };
    for (const lang of ['tr', 'en']) {
      const r = await call('GET', '/api/file?path=prompts%2Fyok.md', undefined, headers(lang));
      assert.equal(r.status, 409, r.text);
      assert.deepEqual(r.data, { error: want[lang], code: 'etkinDegil', active: name });
    }
    const r = await call('GET', '/api/file?path=prompts%2Fyok.md', undefined, { headers: { 'X-PP-MP': encodeURIComponent('baska') } });
    assert.equal(r.data.error, want.tr, 'başlıksız istek Türkçe');
  });
});

test('dil/sunucu: 403 korunan yol iletisi dile göre; code korunanYol, dosya yerinde kalır', real, async () => {
  await withMarketplace(async ({ call, mk }) => {
    const want = {
      status: 403, extra: { code: 'korunanYol' },
      tr: 'Bu yol marketplace yapısının parçası; silinemez veya taşınamaz',
      en: 'This path is part of the marketplace structure and cannot be deleted or moved'
    };
    await expectBothLanguages(call, 'DELETE', '/api/file?path=.gitignore', undefined, want);
    await expectBothLanguages(call, 'POST', '/api/rename', { from: '.gitignore', to: 'baska.txt' }, want);
    assert.ok(fs.existsSync(path.join(mk, '.gitignore')));
  });
});

test('dil/sunucu: ham fs hatası kodu parametre olur ve ileti dile göre (EEXIST); yanıtta yol yok', real, async () => {
  await withMarketplace(async ({ call, mk, tmp }) => {
    fs.mkdirSync(path.join(mk, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(mk, 'prompts', 'a.md'), 'x');
    fs.writeFileSync(path.join(mk, 'prompts', 'x.md'), 'x');
    const jobs = [
      ['POST', '/api/file', { path: 'prompts/a.md/b.md', raw: 'x' }],
      ['POST', '/api/rename', { from: 'prompts/x.md', to: 'prompts/a.md/z.md' }]
    ];
    for (const [method, url, body] of jobs) {
      const tr = await call(method, url, body);
      assert.equal(tr.status, 500, tr.text);
      const code = /\((E[A-Z]+)\)$/.exec(tr.data.error);
      assert.ok(code, 'tr ileti kodla biter: ' + tr.data.error);
      assert.ok(DIACRITIC_RE.test(tr.data.error), 'Türkçe: ' + tr.data.error);
      const en = await call(method, url, body, EN);
      assert.equal(en.status, 500);
      assert.ok(en.data.error.endsWith(` (${code[1]})`), 'ham kod parametre olarak korunur: ' + en.data.error);
      assert.ok(!DIACRITIC_RE.test(en.data.error), 'İngilizce: ' + en.data.error);
      assert.notEqual(en.data.error, tr.data.error);
      assert.ok(!en.text.includes(tmp) && !tr.text.includes(tmp), 'yanıtta yol yok');
    }
    const en = await call('POST', '/api/file', { path: 'prompts/a.md/b.md', raw: 'x' }, EN);
    assert.equal(en.data.error, 'The file or folder already exists (EEXIST)');
    assert.equal((await call('POST', '/api/file', { path: 'prompts/a.md/b.md', raw: 'x' }, TR_HDR)).data.error, 'Dosya ya da klasör zaten var (EEXIST)');
  });
});

test('dil/sunucu: ham fs hata kodları (ENOENT dahil) ve içe aktarma aygıt adı iki dilde parametreli', () => {
  const codes = {
    ENAMETOOLONG: 'nameTooLong', ENOENT: 'notFound', EACCES: 'accessDenied', EPERM: 'permissionDenied', EBUSY: 'busy', ENOSPC: 'noSpace',
    EEXIST: 'exists', ENOTDIR: 'notDirectory', EISDIR: 'isDirectory', ENOTEMPTY: 'notEmpty', EROFS: 'readOnly', EMFILE: 'tooManyOpen'
  };
  for (const [code, name] of Object.entries(codes)) {
    const tr = I18n.tx('err.fs.' + name, { code }, { lang: 'tr' });
    const en = I18n.tx('err.fs.' + name, { code }, { lang: 'en' });
    assert.ok(tr.endsWith(` (${code})`), tr);
    assert.ok(en.endsWith(` (${code})`), en);
    assert.ok(!en.includes('{'), en);
  }
  assert.equal(I18n.tx('err.fs.notFound', { code: 'ENOENT' }, { lang: 'tr' }), 'Dosya ya da klasör bulunamadı (ENOENT)');
  assert.equal(I18n.tx('err.fs.notFound', { code: 'ENOENT' }, { lang: 'en' }), 'File or folder not found (ENOENT)');
  assert.equal(I18n.tx('err.fs.spawnFailed', { code: 'ENOENT' }, { lang: 'tr' }), 'Komut çalıştırılamadı (ENOENT)');
  assert.equal(I18n.tx('err.fs.spawnFailed', { code: 'ENOENT' }, { lang: 'en' }), 'The command could not be run (ENOENT)');
  assert.equal(I18n.tx('err.fs.generic', { code: 'EXYZ' }, { lang: 'tr' }), 'Dosya sistemi hatası (EXYZ)');
  assert.equal(I18n.tx('err.fs.generic', { code: 'EXYZ' }, { lang: 'en' }), 'File system error (EXYZ)');
  assert.equal(I18n.tx('srv.import.deviceName', { name: 'con' }, { lang: 'tr' }), 'Windows aygıt adı: con');
  assert.equal(I18n.tx('srv.import.deviceName', { name: 'con' }, { lang: 'en' }), 'Windows device name: con');
  assert.deepEqual(I18n.missing.filter((entry) => entry.includes(':err.fs.') || entry.includes(':srv.')), []);
});

test('dil/sunucu: setupRequired 409 iletisi ve setup.issues[].message istek diline göre; önbellek dil sızdırmaz', async () => {
  const tmp = tmpDir();
  const srv = await startServer(tmp);
  try {
    const want = {
      tr: { reason: "Library kökü ayarlanmadı. Ayarlar'dan bir klasör seç.", error: "Kurulum tamamlanmadı: Library kökü ayarlanmadı. Ayarlar'dan bir klasör seç." },
      en: { reason: 'Library root is not set. Choose a folder in Settings.', error: 'Setup is not complete: Library root is not set. Choose a folder in Settings.' }
    };
    for (const lang of ['tr', 'en', 'tr', 'en']) {
      const r = await srv.call('GET', '/api/file?path=a.md', undefined, { headers: { 'X-PP-Lang': lang } });
      assert.equal(r.status, 409, r.text);
      assert.equal(r.data.setupRequired, true);
      assert.equal(r.data.error, want[lang].error, lang);
      assert.equal(r.data.setup.ok, false);
      assert.equal(r.data.setup.issues[0].code, 'kokAyarlanmadi');
      assert.equal(r.data.setup.issues[0].message, want[lang].reason, lang);
    }
    const plain = await srv.call('GET', '/api/file?path=a.md');
    assert.equal(plain.data.error, want.tr.error);
    const info = await srv.call('GET', '/api/info', undefined, EN);
    assert.equal(info.data.setup.issues[0].message, want.en.reason);
  } finally { await srv.stop(); rmrf(tmp); }
});

test('dil/sunucu: ayar rotası hataları dile göre; yollar parametre olarak korunur ve ayar dosyası yazılmaz', async () => {
  const tmp = tmpDir();
  const srv = await startServer(tmp);
  try {
    const missing = path.join(tmp, 'yok-klasor');
    const file = path.join(tmp, 'dosya.txt');
    fs.writeFileSync(file, 'x');
    const put = (body) => ['PUT', '/api/settings', body];
    await expectBothLanguages(srv.call, ...put({ libraryRoot: 'goreli/yol' }), { status: 400, tr: 'Mutlak bir klasör yolu gir', en: 'Enter an absolute folder path' });
    await expectBothLanguages(srv.call, ...put({ libraryRoot: '   ' }), { status: 400, tr: 'Library kökü gerekli', en: 'Library root is required' });
    await expectBothLanguages(srv.call, ...put({ libraryRoot: missing }), {
      status: 404, tr: `Klasör bulunamadı: ${missing}`, en: `Folder not found: ${missing}`, extra: { notFound: true }
    });
    await expectBothLanguages(srv.call, ...put({ libraryRoot: file }), {
      status: 400, tr: `Bu yol bir klasör değil: ${file}`, en: `This path is not a folder: ${file}`
    });
    await expectBothLanguages(srv.call, ...put({ remoteCheck: 'saatlik' }), {
      status: 400, tr: 'Geçersiz değer', en: 'Invalid value', extra: { field: 'remoteCheck' }
    });
    assert.equal(fs.existsSync(srv.cfg), false, 'hatalı istekler ayar dosyası yazmaz');
  } finally { await srv.stop(); rmrf(tmp); }
});

test('dil/sunucu: bağlam öncesi yanıtlar (host, başlık, origin, JSON gövde, 405, statik 404) dile göre', async () => {
  const tmp = tmpDir();
  const srv = await startServer(tmp);
  try {
    const cases = [
      { method: 'GET', url: '/api/info', headers: { Host: 'evil.example' }, status: 403, tr: 'Geçersiz host', en: 'Invalid host' },
      { method: 'PUT', url: '/api/settings', headers: {}, body: '{}', status: 403, tr: 'Eksik istek başlığı', en: 'Missing request header' },
      { method: 'PUT', url: '/api/settings', headers: { 'X-PP': '1', Origin: 'http://evil.example' }, body: '{}', status: 403, tr: 'Geçersiz kaynak', en: 'Invalid origin' },
      { method: 'PUT', url: '/api/settings', headers: { 'X-PP': '1' }, body: '{bozuk', status: 400, tr: 'Geçersiz JSON', en: 'Invalid JSON' },
      { method: 'PUT', url: '/api/settings', headers: { 'X-PP': '1' }, body: '[1]', status: 400, tr: 'İstek gövdesi bir JSON nesnesi olmalı', en: 'The request body must be a JSON object' },
      { method: 'GET', url: '/api/yok', headers: {}, status: 404, tr: 'Bulunamadı', en: 'Not found' },
      { method: 'POST', url: '/index.html', headers: {}, status: 405, tr: 'Method not allowed', en: 'Method not allowed' },
      { method: 'GET', url: '/gizli.txt', headers: {}, status: 404, tr: 'Bulunamadı', en: 'Not found' },
      { method: 'GET', url: '/lang/fr.js', headers: {}, status: 404, tr: 'Bulunamadı', en: 'Not found' }
    ];
    for (const c of cases) {
      for (const [lang, expected] of [[undefined, c.tr], ['tr', c.tr], ['fr', c.tr], ['en', c.en]]) {
        const headers = { ...c.headers, ...(lang ? { 'X-PP-Lang': lang } : {}) };
        const r = await rawRequest(srv, { method: c.method, url: c.url, headers, body: c.body });
        assert.equal(r.status, c.status, `${c.method} ${c.url} ${lang}: ${r.text}`);
        assert.equal(typeof r.data === 'string' ? r.data : r.data.error, expected, `${c.method} ${c.url} ${lang}`);
      }
    }
  } finally { await srv.stop(); rmrf(tmp); }
});

test('dil/sunucu: git\'e gidip dönen rotalarda ileti İngilizce bağlamda kalır (execFile geri çağrısından sonra)', real, async () => {
  await withMarketplace(async ({ call }) => {
    const show = '/api/git/show?hash=' + '0'.repeat(40) + '&path=README.md';
    await expectBothLanguages(call, 'GET', show, undefined, { status: 404, tr: 'Bu sürümde dosya yok', en: 'The file does not exist in this version' });
    await expectBothLanguages(call, 'POST', '/api/package/publish', { name: 'x' }, {
      status: 409, extra: { code: 'commitYok' },
      tr: "Henüz hiç commit yok. Önce Git panelinden ilk commit'i at.", en: 'There are no commits yet. First make the initial commit from the Git panel.'
    });
    const en = await expectBothLanguages(call, 'POST', '/api/git/commit', { message: 'm', paths: ['prompts/yok.md'] }, {
      status: 400, extra: { gitCode: 'bilinmiyor' }, tr: 'Git işlemi başarısız oldu.', en: 'The git operation failed.'
    });
    assert.equal(typeof en.data.gitDetail, 'string', 'git ayrıntısı olduğu gibi (çevrilmeden) taşınır');
    await expectBothLanguages(call, 'GET', '/api/git/show?hash=zz&path=README.md', undefined, { status: 400, tr: 'Geçersiz commit', en: 'Invalid commit' });
    await expectBothLanguages(call, 'GET', '/api/history/changes?limit=0', undefined, { status: 400, tr: 'Geçersiz limit', en: 'Invalid limit' });
    await expectBothLanguages(call, 'GET', '/api/history/changes?group=x', undefined, { status: 400, tr: 'Geçersiz gruplama', en: 'Invalid grouping' });
  });
});

test('dil/sunucu: eşzamanlı en ve tr istekleri birbirinin dilini ezmez (git ve dosya sistemi dönüşleri karışık)', real, async () => {
  await withMarketplace(async ({ call }) => {
    const show = '/api/git/show?hash=' + '0'.repeat(40) + '&path=README.md';
    const kinds = [
      { req: ['GET', show], en: 'The file does not exist in this version', tr: 'Bu sürümde dosya yok' },
      { req: ['GET', '/api/file?path=prompts%2Fyok.md'], en: 'File not found', tr: 'Dosya bulunamadı' },
      { req: ['GET', '/api/git/show?hash=zz&path=a'], en: 'Invalid commit', tr: 'Geçersiz commit' }
    ];
    const jobs = [];
    for (let i = 0; i < 24; i++) {
      const lang = i % 2 ? 'tr' : 'en';
      const kind = kinds[i % kinds.length];
      jobs.push(call(kind.req[0], kind.req[1], undefined, { headers: { 'X-PP-Lang': lang } }).then((r) => ({ lang, kind, r })));
    }
    const publishEn = 'There are no commits yet. First make the initial commit from the Git panel.';
    jobs.push(call('POST', '/api/package/publish', { name: 'x' }, EN).then((r) => ({ lang: 'en', kind: { en: publishEn }, r })));
    for (const { lang, kind, r } of await Promise.all(jobs)) assert.equal(r.data.error, kind[lang], lang + ' ' + JSON.stringify(r.data));
  });
});

test('dil/sunucu: içe aktarma frontmatter yazmaz (istek dilinden bağımsız); "---" ile başlayan metin korunur; atlanan dosya nedenleri dile göre', real, async () => {
  await withMarketplace(async ({ call, mk, tmp }) => {
    const dir = path.join(tmp, 'metinler');
    fs.mkdirSync(dir, { recursive: true });
    const write = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
    const files = [write('idea.txt', 'fikir'), write('ilk.txt', 'bir'), write('cizgi.txt', '---\nçizgi\n')];
    const written = (target, name) => fs.readFileSync(path.join(mk, target, name), 'utf8');

    let r;
    for (const [target, headers] of [['prompts/en', EN], ['prompts/tr', TR_HDR], ['prompts/baslik-yok', undefined], ['prompts/fr', BAD_HDR]]) {
      r = await call('POST', '/api/import/run', { dir, files, target }, headers);
      assert.equal(r.status, 200, r.text);
      assert.equal(written(target, 'idea.md'), 'fikir\n', target);
      assert.equal(written(target, 'ilk.md'), 'bir\n', target);
      assert.equal(written(target, 'cizgi.md'), '\n---\nçizgi\n', target);
    }

    const other = path.join(tmp, 'baska.txt');
    fs.writeFileSync(other, 'x');
    const odd = [write('not.md', 'x'), write('bos.txt', '   \n'), path.join(dir, 'yok.txt'), other];
    const reasons = (res) => res.data.skipped.map((s) => s.reason);
    r = await call('POST', '/api/import/run', { dir, files: odd, target: 'prompts/en2' }, EN);
    assert.deepEqual(reasons(r), ['Not a .txt file', 'Empty file', 'Could not be read', 'Outside the selected folder']);
    r = await call('POST', '/api/import/run', { dir, files: odd, target: 'prompts/tr2' });
    assert.deepEqual(reasons(r), ['.txt değil', 'Boş dosya', 'Okunamadı', 'Seçilen klasörün dışında']);

    await expectBothLanguages(call, 'POST', '/api/import/run', { dir, files: [] }, { status: 400, tr: 'Dosya seçilmedi', en: 'No files selected' });
    await expectBothLanguages(call, 'POST', '/api/import/scan', { dir: '' }, { status: 400, tr: 'Klasör yolu gerekli', en: 'Folder path is required' });
    const scan = await call('POST', '/api/import/scan', { dir: path.join(tmp, 'olmayan') }, EN);
    assert.equal(scan.status, 400);
    assert.ok(scan.data.error.startsWith('Could not read the folder: '), scan.data.error);
    assert.ok((await call('POST', '/api/import/scan', { dir: path.join(tmp, 'olmayan') })).data.error.startsWith('Klasör okunamadı: '));
  });
});

test('dil/sunucu: marketplace durumu notu ve sabitleme ipucu dile göre; marketplace ve git doğrulama hataları dile göre', real, async () => {
  await withMarketplace(async ({ call }) => {
    let en = await call('GET', '/api/marketplace/status', undefined, EN);
    assert.equal(en.data.commands.addNote, 'Local path: plugins are installed in place and versions are not tracked');
    let tr = await call('GET', '/api/marketplace/status');
    assert.equal(tr.data.commands.addNote, "Yerel yol: plugin'ler yerinde yüklenir, sürüm takibi yapılmaz");
    assert.equal((await call('POST', '/api/git/remotes', { name: 'origin', url: 'https://github.com/u/r' })).status, 200);
    en = await call('GET', '/api/marketplace/status', undefined, EN);
    tr = await call('GET', '/api/marketplace/status');
    assert.equal(en.data.commands.addNote, null);
    assert.equal(en.data.commands.pinHint, 'u/r#<branch-or-tag>');
    assert.equal(tr.data.commands.pinHint, 'u/r#<dal-veya-etiket>');
    assert.equal(en.data.commands.add, tr.data.commands.add, 'komutlar dilden bağımsız');

    await expectBothLanguages(call, 'POST', '/api/marketplaces/activate', { name: 'yok' }, { status: 404, tr: 'Marketplace bulunamadı: yok', en: 'Marketplace not found: yok' });
    await expectBothLanguages(call, 'POST', '/api/marketplaces/git-init', { name: 'yok' }, { status: 404, tr: 'Klasör bulunamadı: yok', en: 'Folder not found: yok' });
    await expectBothLanguages(call, 'POST', '/api/prompts/transfer', { path: 'prompts/a.txt' }, {
      status: 400, tr: 'Yalnızca prompt dosyaları taşınabilir', en: 'Only prompt files can be moved'
    });
    await expectBothLanguages(call, 'POST', '/api/git/commit', { message: '', paths: [] }, { status: 400, tr: 'Commit mesajı gerekli', en: 'Commit message is required' });
    await expectBothLanguages(call, 'POST', '/api/git/identity', { name: '' }, { status: 400, tr: 'Ad ve e-posta gerekli', en: 'Name and email are required' });
  });
});

test('dil/sunucu: yayın denetimi önbelleği dil sızdırmaz; publishCheck.reason her okumada isteğin dilinde (aynı mtime/size)', real, async () => {
  await withMarketplace(async ({ call, mk }) => {
    const put = (rel, text) => { const f = path.join(mk, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
    put('prompts/p/eksik.md', '---\nbaslik: A\naciklama: b\n---\ngovde\n');
    put('prompts/p/buyuk.md', '---\nbaslik: B\n---\n' + 'x'.repeat(2100000));
    const want = {
      eksik: {
        tr: 'Yayın alanları dolu (aciklama) ama "tur" yok. Bu prompt yayınlanmayacak.',
        en: 'Publish fields are filled in (aciklama) but "tur" is missing. This prompt will not be published.'
      },
      buyuk: { tr: "Dosya 2 MB'tan büyük. Dizinlenmiyor ve yayınlanmıyor.", en: 'The file is larger than 2 MB. It is not indexed or published.' }
    };
    for (const lang of ['tr', 'en', 'en', 'tr', 'en']) {
      for (const [name, rel] of [['eksik', 'prompts/p/eksik.md'], ['buyuk', 'prompts/p/buyuk.md']]) {
        const r = await call('GET', '/api/file?path=' + encodeURIComponent(rel), undefined, { headers: { 'X-PP-Lang': lang } });
        assert.equal(r.status, 200, r.text);
        assert.equal(r.data.publishCheck.reason, want[name][lang], `${name} ${lang}`);
        assert.equal(r.data.publishCheck.level, 'warn');
        assert.equal(r.data.publishCheck.code, name === 'eksik' ? 'turYok' : 'dosyaBuyuk');
      }
    }
  });
});

test('dil/sunucu: server.js ad uzayı anahtarları tr ve en için eşit, yer tutucuları aynı, boş değil, en değerlerinde Türkçe harf yok', () => {
  const owned = (dictionary) => Object.keys(dictionary).filter((key) => SERVER_PREFIXES.some((prefix) => key.startsWith(prefix))).sort();
  const keys = owned(DICT_TR);
  assert.deepEqual(owned(DICT_EN), keys);
  assert.ok(keys.length >= 85, 'beklenen anahtar sayısı: ' + keys.length);
  for (const key of keys) {
    assert.equal(typeof DICT_TR[key], 'string', 'tr düz metin ' + key);
    assert.equal(typeof DICT_EN[key], 'string', 'en düz metin ' + key);
    assert.ok(DICT_TR[key].length > 0 && DICT_EN[key].length > 0, 'boş değil ' + key);
    assert.deepEqual(placeholders(DICT_EN[key]), placeholders(DICT_TR[key]), 'yer tutucular ' + key);
    assert.ok(!DIACRITIC_RE.test(DICT_EN[key]), 'en değerinde Türkçe harf yok ' + key + ': ' + DICT_EN[key]);
  }
});

test('dil/sunucu: server.js kaynağı: kullanılan her anahtar iki sözlükte var, ölü anahtar yok, çevrilmemiş Türkçe ileti yok (konsol çıktısı hariç)', () => {
  const code = stripComments(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'));
  const used = new Set([...code.matchAll(/['"]((?:err|srv|git|mp)\.[A-Za-z]+(?:\.[A-Za-z]+)*)['"]/g)].map((m) => m[1]));
  assert.ok(used.size >= 88, 'kullanılan anahtar sayısı: ' + used.size);
  for (const key of used) {
    assert.ok(key in DICT_TR, 'tr sözlükte var: ' + key);
    assert.ok(key in DICT_EN, 'en sözlükte var: ' + key);
  }
  const owned = Object.keys(DICT_TR).filter((key) => SERVER_PREFIXES.some((prefix) => key.startsWith(prefix)));
  for (const key of owned) assert.ok(used.has(key), 'server.js kullanıyor (ölü anahtar yok): ' + key);

  const leftovers = code.split('\n').filter((line) => DIACRITIC_RE.test(line) && !/console\.(log|error|warn)\(/.test(line));
  assert.deepEqual(leftovers, [], 'çevrilmemiş Türkçe dize');
  assert.doesNotMatch(code, /PROTECTED_MSG/, 'modül düzeyi ileti sabiti kalmadı');
});
