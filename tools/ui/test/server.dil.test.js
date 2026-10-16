'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
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
