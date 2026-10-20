'use strict';
/* Aşama 2.5 sunucu testleri: plugin rotaları, X-PP-MP koruması, etkin yokken ağaç, marketplace'ler arası taşıma.
 * server.js alt süreç olarak başlatılır; yalnızca geçici klasör ve PP_CONFIG kullanılır. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { gitAvailable, tmpDir, rmrf, gitEnv } = require('./helpers');

const SERVER = path.join(__dirname, '..', 'server.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function start(tmp) {
  const port = await freePort();
  const cfg = path.join(tmp, 'cfg', 'config.json');
  const child = spawn(process.execPath, [SERVER, '--port', String(port)], {
    env: { ...process.env, ...gitEnv(tmp), PP_CONFIG: cfg }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let out = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Sunucu zamanında başlamadı: ' + out)), 15000);
    child.stdout.on('data', (b) => { out += b; if (/çalışıyor: http:\/\/localhost:(\d+)/.test(out)) { clearTimeout(t); resolve(); } });
    child.once('exit', (c) => { clearTimeout(t); reject(new Error('Sunucu kapandı (' + c + '): ' + out)); });
  });
  const base = 'http://127.0.0.1:' + port;
  async function call(method, url, body, { headers = {} } = {}) {
    const h = { ...headers };
    if (method !== 'GET') h['X-PP'] = '1';
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: r.status, data };
  }
  return { cfg, call, stop: () => new Promise((res) => { child.once('exit', res); child.kill(); setTimeout(res, 3000); }) };
}

test('sunucu: plugin rotaları, X-PP-MP koruması, taşıma ve etkin marketplace yokken okuma', { skip: !gitAvailable && 'git yok' }, async () => {
  const tmp = tmpDir();
  const srv = await start(tmp);
  try {
    const lib = path.join(tmp, 'PromptLibrary');
    const OP = path.join(lib, 'ornek-promptlar');
    const IK = path.join(lib, 'ikinci');
    let r = await srv.call('PUT', '/api/settings', { libraryRoot: lib, create: true });
    assert.equal(r.status, 200);
    assert.equal(r.data.setup.rootOk, true);
    await srv.call('POST', '/api/marketplaces', { name: 'ornek-promptlar' });
    await srv.call('POST', '/api/marketplaces', { name: 'ikinci' });
    r = await srv.call('POST', '/api/marketplaces/activate', { name: 'ornek-promptlar' });
    assert.equal(r.status, 200);
    assert.equal(r.data.info.activeMarketplace, 'ornek-promptlar');
    assert.equal(r.data.info.setup.ok, true);

    // Yeni plugin
    r = await srv.call('POST', '/api/package', { name: 'Kod İnceleme', description: 'Kodu inceler' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.plugin, { name: 'kod-inceleme', slug: 'kod-inceleme', path: 'prompts/kod-inceleme' });
    assert.equal((await srv.call('POST', '/api/package', { name: 'kod inceleme' })).status, 409);
    assert.equal((await srv.call('POST', '/api/package', { name: 'claude-x' })).status, 400);
    assert.equal((await srv.call('POST', '/api/package', { name: '' })).data.error, 'Plugin adı gerekli');
    r = await srv.call('GET', '/api/tree');
    const pl = r.data.marketplaces.find((m) => m.name === 'ornek-promptlar').plugins.find((p) => p.name === 'kod-inceleme');
    assert.equal(pl.description, 'Kodu inceler');
    assert.ok(fs.existsSync(path.join(OP, 'prompts', 'kod-inceleme', '.gitkeep')));
    assert.equal(r.data.marketplaces.find((m) => m.name === 'ikinci').plugins.length, 0);

    // PUT ve rename
    assert.equal((await srv.call('PUT', '/api/package', { name: 'yok', description: 'x' })).status, 404);
    assert.equal((await srv.call('PUT', '/api/package', { name: 'kod-inceleme', description: '' })).status, 400);
    r = await srv.call('PUT', '/api/package', { name: 'kod-inceleme', description: 'Yeni' });
    assert.deepEqual(r.data, { ok: true });
    await srv.call('POST', '/api/file', { path: 'prompts/kod-inceleme/a.md', raw: '---\nbaslik: A\npaket: kod-inceleme\n---\ngovde\n' });
    r = await srv.call('POST', '/api/package/rename', { from: 'kod-inceleme', to: 'Kod' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.plugin.slug, 'kod'); assert.equal(r.data.moved, 1);
    assert.equal((await srv.call('POST', '/api/package/rename', { from: 'kod', to: 'kod' })).data.error, 'Yeni ad eskisiyle aynı');
    assert.equal((await srv.call('POST', '/api/package/rename', { from: 'yok', to: 'x' })).status, 404);

    // X-PP-MP koruması
    const P = 'prompts/kod/a.md';
    const orig = fs.readFileSync(path.join(OP, P), 'utf8');
    r = await srv.call('PUT', '/api/file', { path: P, raw: 'DEGISTI' }, { headers: { 'X-PP-MP': 'ikinci' } });
    assert.equal(r.status, 409); assert.equal(r.data.code, 'etkinDegil'); assert.equal(r.data.active, 'ornek-promptlar');
    assert.equal(r.data.error, 'Etkin marketplace değişti (şu an: ornek-promptlar). Ağaçtan yeniden seç.');
    assert.equal(fs.readFileSync(path.join(OP, P), 'utf8'), orig, 'dosya değişmemeli');
    r = await srv.call('PUT', '/api/file', { path: P, raw: orig.replace('paket: kod-inceleme', 'paket: kod') + 'x\n' }, { headers: { 'X-PP-MP': encodeURIComponent('ornek-promptlar') } });
    assert.equal(r.status, 200);

    // Marketplace'ler arası taşıma
    fs.mkdirSync(path.join(IK, 'prompts', 'yeni-yer'), { recursive: true });
    const T = (body, h) => srv.call('POST', '/api/prompts/transfer', body, h ? { headers: h } : undefined);
    assert.equal((await T({ path: P, toMp: 'ornek-promptlar', toPlugin: 'kod' })).status, 400);
    assert.equal((await T({ path: P, toMp: 'yok', toPlugin: 'kod' })).status, 404);
    assert.equal((await T({ path: P, toMp: 'ikinci', toPlugin: 'yokplugin' })).status, 404);
    assert.equal((await T({ path: P, toMp: 'ikinci', toPlugin: '../x' })).status, 400);
    assert.equal((await T({ path: 'README.md', toMp: 'ikinci', toPlugin: 'yeni-yer' })).status, 400);
    assert.equal((await T({ path: P, toMp: 'ikinci', toPlugin: 'yeni-yer' }, { 'X-PP-MP': 'baska' })).status, 409);
    assert.ok(fs.existsSync(path.join(OP, P)), 'koruma devredeyken kaynak yerinde');
    r = await T({ path: P, toMp: 'ikinci', toPlugin: 'yeni-yer' }, { 'X-PP-MP': 'ornek-promptlar' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.to, { mp: 'ikinci', path: 'prompts/yeni-yer/a.md' });
    const moved = fs.readFileSync(path.join(IK, 'prompts', 'yeni-yer', 'a.md'), 'utf8');
    assert.match(moved, /^paket: yeni-yer$/m, 'paket alanı yeni klasöre eşitlenir');
    assert.equal(fs.existsSync(path.join(OP, P)), false);
    assert.ok(fs.existsSync(path.join(OP, r.data.trash)));
    // çakışan ad benzersizleştirilir
    await srv.call('POST', '/api/file', { path: 'prompts/kod/a.md', raw: 'x' });
    r = await T({ path: 'prompts/kod/a.md', toMp: 'ikinci', toPlugin: 'yeni-yer' });
    assert.equal(r.data.to.path, 'prompts/yeni-yer/a-2.md');
    // git geçmişi dokunulmadı: commit atılmadı
    assert.equal((await srv.call('GET', '/api/git/status')).data.hasCommits, false);

    // Etkin marketplace yokken: ağaç/arama/facet 200, git ve yazma 409
    const cfg = JSON.parse(fs.readFileSync(srv.cfg, 'utf8'));
    fs.writeFileSync(srv.cfg, JSON.stringify({ ...cfg, activeMarketplace: '' }));
    r = await srv.call('GET', '/api/info');
    assert.equal(r.data.setup.issues[0].code, 'marketplaceSecilmedi'); assert.equal(r.data.setup.rootOk, true);
    r = await srv.call('GET', '/api/tree');
    assert.equal(r.status, 200); assert.equal(r.data.libraryDir, null); assert.equal(r.data.marketplaces.length, 2);
    assert.equal((await srv.call('GET', '/api/facets')).status, 200);
    assert.equal((await srv.call('GET', '/api/search?q=a')).status, 200);
    assert.equal((await srv.call('GET', '/api/git/status')).status, 409);
    assert.equal((await srv.call('POST', '/api/package', { name: 'x' })).status, 409);
  } finally { await srv.stop(); rmrf(tmp); }
});

test('sunucu: "tools" adlı klasör bugünkü IGNORE yüzünden görünmez; plugin olarak da reddedilir [doğrulandı]', { skip: !gitAvailable && 'git yok' }, async () => {
  const tmp = tmpDir();
  const srv = await start(tmp);
  try {
    const lib = path.join(tmp, 'lib');
    await srv.call('PUT', '/api/settings', { libraryRoot: lib, create: true });
    await srv.call('POST', '/api/marketplaces', { name: 'mp' });
    fs.mkdirSync(path.join(lib, 'mp', 'prompts', 'tools'), { recursive: true });
    fs.writeFileSync(path.join(lib, 'mp', 'prompts', 'tools', 'x.md'), '---\nbaslik: Gizli\n---\ngovde');
    let r = await srv.call('GET', '/api/tree');
    assert.deepEqual(r.data.marketplaces[0].plugins, [], 'tools klasörü ağaçta yok');
    assert.equal((await srv.call('GET', '/api/search?q=gizli')).data.results.length, 0);
    r = await srv.call('POST', '/api/package', { name: 'tools' });
    assert.equal(r.status, 400); assert.match(r.data.error, /sistemde ayrılmış/);
  } finally { await srv.stop(); rmrf(tmp); }
});

test('sunucu: /api/prompts/move ve /api/package/move; paket alanı kuralı, fromMp ve X-PP-MP koruması, çakışma, çöp hatasında tam geri alma', { skip: !gitAvailable && 'git yok' }, async () => {
  const tmp = tmpDir();
  const srv = await start(tmp);
  try {
    const lib = path.join(tmp, 'PromptLibrary');
    const AL = path.join(lib, 'alfa');
    const BE = path.join(lib, 'beta');
    await srv.call('PUT', '/api/settings', { libraryRoot: lib, create: true });
    await srv.call('POST', '/api/marketplaces', { name: 'alfa' });
    await srv.call('POST', '/api/marketplaces', { name: 'beta', activate: false });
    fs.mkdirSync(path.join(BE, 'prompts', 'notlar'), { recursive: true });
    assert.equal((await srv.call('POST', '/api/package', { name: 'kod', description: 'Kodu inceler' })).status, 200);
    assert.equal((await srv.call('POST', '/api/package', { name: 'yazi' })).status, 200);
    const put = async (p, raw) => assert.equal((await srv.call('POST', '/api/file', { path: p, raw })).status, 200);
    const read = (root, p) => fs.readFileSync(path.join(root, p), 'utf8');
    const PM = (body, headers) => srv.call('POST', '/api/prompts/move', body, headers ? { headers } : undefined);
    const GM = (body, headers) => srv.call('POST', '/api/package/move', body, headers ? { headers } : undefined);
    const body = (ad, extra = '') => `---\nbaslik: ${ad}\npaket: kod\n${extra}---\ngovde ${ad}\n`;

    await put('prompts/kod/a.md', body('A', 'etiketler: [x, y]\n'));
    const a = read(AL, 'prompts/kod/a.md');
    let r = await PM({ path: 'prompts/kod/a.md', fromMp: 'alfa', to: { mp: 'alfa', kind: 'paket', plugin: 'yazi' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.to, { mp: 'alfa', path: 'prompts/yazi/a.md', kind: 'paket', plugin: 'yazi' });
    assert.equal(r.data.same, true); assert.equal(r.data.trash, null); assert.equal(r.data.renamed, false);
    assert.deepEqual(r.data.paket, { action: 'set', value: 'yazi' });
    assert.equal(read(AL, 'prompts/yazi/a.md'), a.replace('paket: kod', 'paket: yazi'), 'yalnızca paket satırı değişti');
    assert.equal(fs.existsSync(path.join(AL, 'prompts/kod/a.md')), false);
    r = await PM({ path: 'prompts/yazi/a.md', to: { mp: 'alfa', kind: 'paket', plugin: 'yazi' } });
    assert.equal(r.status, 400); assert.equal(r.data.code, 'ayniKonum');
    const bomRaw = '﻿---\r\nbaslik: D\r\npaket: kod\r\n---\r\ngövde\r\n';
    await put('prompts/kod/d.md', bomRaw);
    r = await PM({ path: 'prompts/kod/d.md', to: { mp: 'alfa', kind: 'paket', plugin: 'yazi' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(fs.readFileSync(path.join(AL, 'prompts/yazi/d.md')), Buffer.from(bomRaw.replace('paket: kod', 'paket: yazi'), 'utf8'), 'BOM, CRLF ve gövde bayt aynı; yalnızca paket satırı değişti');
    r = await PM({ path: 'prompts/yazi/a.md', fromMp: 'beta', to: { mp: 'beta', kind: 'klasorsuz' } });
    assert.equal(r.status, 409); assert.equal(r.data.code, 'etkinDegil');
    r = await PM({ path: 'prompts/yazi/a.md', to: { mp: 'beta', kind: 'klasorsuz' } }, { 'X-PP-MP': 'beta' });
    assert.equal(r.status, 409);
    assert.ok(fs.existsSync(path.join(AL, 'prompts/yazi/a.md')), 'korumalar devredeyken kaynak yerinde');
    assert.equal((await PM({ path: 'prompts/yazi/a.md', to: { mp: 'beta', kind: 'olmayan' } })).data.code, 'hedefTuruGecersiz');
    assert.equal((await PM({ path: 'prompts/yazi/a.md', to: { mp: 'beta', kind: 'paket', plugin: 'gelen-kutusu' } })).status, 400);
    assert.equal((await PM({ path: 'prompts/yazi/a.md', to: { mp: 'beta', kind: 'paket', plugin: 'yok' } })).data.code, 'pluginYok');

    await put('prompts/kod/b.md', body('B'));
    const b = read(AL, 'prompts/kod/b.md');
    r = await PM({ path: 'prompts/kod/b.md', fromMp: 'alfa', to: { mp: 'beta', kind: 'klasorsuz' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.same, false); assert.deepEqual(r.data.paket, { action: 'remove', value: null });
    assert.equal(read(BE, 'prompts/b.md'), b.replace('paket: kod\n', ''), 'klasörsüze giderken eski klasör alanı kalkar');
    assert.ok(fs.existsSync(path.join(AL, r.data.trash)));

    await put('prompts/kod/c.md', body('C'));
    const c = read(AL, 'prompts/kod/c.md');
    r = await PM({ path: 'prompts/kod/c.md', to: { mp: 'beta', kind: 'gelenKutusu' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.to.path, 'prompts/gelen-kutusu/c.md'); assert.equal(r.data.paket.action, 'keep');
    assert.equal(read(BE, 'prompts/gelen-kutusu/c.md'), c, 'gelen kutusunda dosya bayt aynı');
    await put('prompts/kod/c.md', c);
    r = await PM({ path: 'prompts/kod/c.md', to: { mp: 'beta', kind: 'gelenKutusu', name: 'c.md' } });
    assert.equal(r.status, 409); assert.equal(r.data.code, 'hedefVar');
    r = await PM({ path: 'prompts/kod/c.md', to: { mp: 'beta', kind: 'gelenKutusu' } });
    assert.equal(r.data.to.path, 'prompts/gelen-kutusu/c-2.md'); assert.equal(r.data.renamed, true);

    r = await GM({ name: 'kod', fromMp: 'alfa', toMp: 'alfa' });
    assert.equal(r.status, 400);
    fs.mkdirSync(path.join(BE, 'prompts', 'yazi'));
    r = await GM({ name: 'yazi', toMp: 'beta' });
    assert.equal(r.status, 409); assert.equal(r.data.code, 'pluginVar');
    assert.equal((await GM({ name: 'yazi', toMp: 'beta' }, { 'X-PP-MP': 'beta' })).data.code, 'etkinDegil');
    assert.equal((await GM({ name: 'yazi', fromMp: 'beta', toMp: 'beta' })).data.code, 'etkinDegil');
    fs.rmdirSync(path.join(BE, 'prompts', 'yazi'));
    r = await GM({ name: 'kod', fromMp: 'alfa', toMp: 'beta' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.plugin, { name: 'kod', slug: 'kod', path: 'prompts/kod' });
    assert.deepEqual(r.data.to, { mp: 'beta', path: 'prompts/kod' });
    assert.equal(JSON.parse(read(BE, 'prompts/kod/.claude-plugin/plugin.json')).description, 'Kodu inceler');
    const tree = await srv.call('GET', '/api/tree');
    assert.equal(tree.data.marketplaces.find((m) => m.name === 'beta').plugins.find((p) => p.name === 'kod').description, 'Kodu inceler', 'açıklama klasörle birlikte taşındı');
    assert.equal(fs.existsSync(path.join(AL, 'prompts', 'kod')), false);
    assert.ok(fs.existsSync(path.join(AL, r.data.trash, '.gitkeep')));
    assert.equal((await srv.call('GET', '/api/git/status')).data.hasCommits, false, 'commit atılmadı');

    fs.rmSync(path.join(AL, '.pp', 'trash'), { recursive: true, force: true });
    fs.writeFileSync(path.join(AL, '.pp', 'trash'), 'dosya');
    r = await PM({ path: 'prompts/yazi/a.md', to: { mp: 'beta', kind: 'paket', plugin: 'notlar' } });
    assert.equal(r.status, 500); assert.equal(r.data.code, 'geriAlindi');
    assert.equal(fs.existsSync(path.join(BE, 'prompts/notlar/a.md')), false, 'hedef kopya geri alındı');
    r = await PM({ path: 'prompts/yazi/a.md', to: { mp: 'beta', kind: 'gelenKutusu', name: 'z.md' } });
    assert.equal(r.status, 500);
    assert.equal(fs.existsSync(path.join(BE, 'prompts/gelen-kutusu/z.md')), false);
    assert.ok(fs.existsSync(path.join(AL, 'prompts/yazi/a.md')), 'kaynak yerinde');
    r = await GM({ name: 'yazi', toMp: 'beta' });
    assert.equal(r.status, 500); assert.match(r.data.error, /^Plugin taşınamadı: /); assert.equal(r.data.code, 'geriAlindi');
    assert.equal(fs.existsSync(path.join(BE, 'prompts', 'yazi')), false);
    assert.ok(fs.existsSync(path.join(AL, 'prompts/yazi/a.md')));
  } finally { await srv.stop(); rmrf(tmp); }
});
