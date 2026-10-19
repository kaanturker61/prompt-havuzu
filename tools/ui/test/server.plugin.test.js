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
