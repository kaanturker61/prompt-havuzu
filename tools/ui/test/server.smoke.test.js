'use strict';
/* server.js alt süreç olarak başlatılır; yalnızca geçici klasör ve PP_CONFIG kullanılır. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { gitAvailable, tmpDir, rmrf, gitEnv } = require('./helpers');

const SERVER = path.join(__dirname, '..', 'server.js');
const PUBLIC = path.join(__dirname, '..', 'public');

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
    child.stdout.on('data', (b) => { out += b; const m = /çalışıyor: http:\/\/localhost:(\d+)/.exec(out); if (m) { clearTimeout(t); resolve(); } });
    child.once('exit', (c) => { clearTimeout(t); reject(new Error('Sunucu kapandı (' + c + '): ' + out)); });
  });
  const base = 'http://127.0.0.1:' + port;
  async function call(method, url, body, { headers = {} } = {}) {
    const h = { ...headers };
    if (method !== 'GET' && !('X-PP' in h) && h['X-PP'] !== null) h['X-PP'] = '1';
    if (h['X-PP'] === undefined) delete h['X-PP'];
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: r.status, data };
  }
  return { child, cfg, base, call, stop: () => new Promise((res) => { child.once('exit', res); child.kill(); setTimeout(res, 3000); }) };
}

test('sunucu: kurulum akışı uçtan uca', { skip: !gitAvailable && 'git yok' }, async () => {
  const tmp = tmpDir();
  const srv = await start(tmp);
  try {
    const lib = path.join(tmp, 'PromptLibrary');

    // kurulum yok
    let r = await srv.call('GET', '/api/info');
    assert.equal(r.status, 200);
    assert.equal(r.data.setup.issues[0].code, 'kokAyarlanmadi');
    assert.equal(r.data.root, null); assert.equal(r.data.isRepo, false);
    assert.equal(r.data.configPath, srv.cfg);
    assert.equal(r.data.config.libraryDir, 'library');

    r = await srv.call('GET', '/api/tree');
    assert.equal(r.status, 409); assert.equal(r.data.setupRequired, true);
    assert.equal(r.data.error, "Kurulum tamamlanmadı: Library kökü ayarlanmadı. Ayarlar'dan bir klasör seç.");
    assert.equal((await srv.call('GET', '/api/git/status')).status, 409);
    assert.equal((await srv.call('POST', '/api/git/init', {})).status, 404, 'kaldırılan rota');

    // X-PP olmadan reddedilir
    r = await srv.call('PUT', '/api/settings', { libraryRoot: lib }, { headers: { 'X-PP': null } });
    assert.equal(r.status, 403);

    // ayar hataları
    assert.equal((await srv.call('PUT', '/api/settings', { libraryRoot: '' })).status, 400);
    r = await srv.call('PUT', '/api/settings', { libraryRoot: 'goreli/yol' });
    assert.equal(r.data.error, 'Mutlak bir klasör yolu gir');
    r = await srv.call('PUT', '/api/settings', { libraryRoot: path.join(__dirname, 'x') });
    assert.equal(r.status, 400); assert.equal(r.data.code, 'kokAracReposunda');
    r = await srv.call('PUT', '/api/settings', { libraryRoot: lib });
    assert.equal(r.status, 404); assert.equal(r.data.notFound, true);
    fs.writeFileSync(path.join(tmp, 'dosya'), '');
    r = await srv.call('PUT', '/api/settings', { libraryRoot: path.join(tmp, 'dosya') });
    assert.match(r.data.error, /^Bu yol bir klasör değil: /);
    assert.equal(fs.existsSync(lib), false, 'create olmadan klasör oluşmamalı');

    // ayar -> klasör oluşturulur
    r = await srv.call('PUT', '/api/settings', { libraryRoot: lib, create: true });
    assert.equal(r.status, 200);
    assert.equal(r.data.libraryRoot, lib);
    assert.equal(r.data.setup.issues[0].code, 'marketplaceYok');
    assert.equal(r.data.toolRoot, path.resolve(__dirname, '..', '..', '..'));

    // marketplace oluştur
    r = await srv.call('POST', '/api/marketplaces', { name: 'claude-plugins-official' });
    assert.equal(r.status, 400);
    r = await srv.call('POST', '/api/marketplaces', { name: 'Örnek Promptlar', description: 'Deneme', owner: 'Ben' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.ok, true); assert.equal(r.data.marketplace.name, 'ornek-promptlar');
    assert.equal(r.data.marketplace.valid, true); assert.equal(r.data.marketplace.active, true);
    assert.equal(r.data.setup.ok, true);
    assert.equal((await srv.call('POST', '/api/marketplaces', { name: 'ornek-promptlar' })).status, 409);

    r = await srv.call('GET', '/api/tree');
    assert.equal(r.status, 200); assert.equal(r.data.libraryDir, 'prompts');
    r = await srv.call('GET', '/api/git/status');
    assert.equal(r.data.isRepo, true); assert.equal(r.data.branch, 'main'); assert.equal(r.data.hasCommits, false);
    assert.ok(r.data.files.some((f) => f.path === 'pp.config.json'));

    // dosya + git commit akışı
    r = await srv.call('POST', '/api/file', { path: 'prompts/a.md', raw: '---\nbaslik: A\n---\nmerhaba\n' });
    assert.equal(r.status, 200);
    r = await srv.call('POST', '/api/git/commit', { message: 'ilk', paths: ['prompts/a.md'] });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.match(r.data.commit, /^[0-9a-f]+$/);
    r = await srv.call('GET', '/api/git/log?path=prompts/a.md');
    assert.equal(r.data.commits.length, 1);
    r = await srv.call('GET', '/api/git/show?hash=' + r.data.commits[0].hash + '&path=prompts/a.md');
    assert.match(r.data.raw, /merhaba/);
    assert.equal((await srv.call('GET', '/api/git/show?hash=' + 'a'.repeat(40) + '&path=prompts/a.md')).data.error, 'Bu sürümde dosya yok');
    r = await srv.call('GET', '/api/search?q=merhaba');
    assert.equal(r.data.results.length, 1);
    r = await srv.call('POST', '/api/git/commit', { message: 'x', paths: [] });
    assert.equal(r.data.error, 'Commit için en az bir dosya seç');

    // ikinci marketplace + geçiş + arama önbelleği temizliği
    r = await srv.call('POST', '/api/marketplaces', { name: 'ikinci' });
    assert.equal(r.status, 200);
    r = await srv.call('GET', '/api/search?q=merhaba');
    assert.equal(r.data.results.length, 1, "okuma tüm marketplace'leri kapsar: ikinci etkinken de bulunur");
    assert.equal(r.data.results[0].mp, 'ornek-promptlar');
    r = await srv.call('POST', '/api/marketplaces/activate', { name: 'ornek-promptlar' });
    assert.equal(r.data.setup.ok, true);
    assert.equal((await srv.call('GET', '/api/search?q=merhaba')).data.results.length, 1);
    assert.equal((await srv.call('POST', '/api/marketplaces/activate', { name: 'yok' })).status, 404);

    // git deposu olmayan klasör
    fs.mkdirSync(path.join(lib, 'notlar'));
    r = await srv.call('GET', '/api/marketplaces');
    assert.deepEqual(r.data.ignored.map((i) => i.name), ['notlar']);
    assert.deepEqual(r.data.items.map((i) => i.name), ['ikinci', 'ornek-promptlar']);
    r = await srv.call('POST', '/api/marketplaces/activate', { name: 'notlar' });
    assert.equal(r.data.setup.issues[0].code, 'marketplaceGitYok');
    r = await srv.call('GET', '/api/tree');
    assert.equal(r.status, 200, 'ağaç etkin marketplace gerektirmez');
    assert.ok(r.data.ignored.some((i) => i.name === 'notlar'));
    assert.equal((await srv.call('GET', '/api/file?path=prompts/x.md')).status, 409);
    r = await srv.call('POST', '/api/marketplaces/git-init', { name: 'notlar' });
    assert.equal(r.status, 200); assert.ok(r.data.created.includes('.git'));
    assert.equal(r.data.setup.ok, true);
    assert.equal((await srv.call('POST', '/api/marketplaces/git-init', { name: 'notlar' })).status, 409);
    assert.equal((await srv.call('POST', '/api/marketplaces/git-init', { name: '..' })).status, 404);

    // çalışırken silme
    rmrf(path.join(lib, 'notlar', '.git'));
    r = await srv.call('GET', '/api/file?path=prompts/x.md');
    assert.equal(r.status, 409); assert.equal(r.data.setupRequired, true);
    assert.equal(r.data.setup.issues[0].code, 'marketplaceGitYok');

    // kayıt dosyası gerçekten geçici yerde
    assert.ok(fs.existsSync(srv.cfg));
    assert.equal(JSON.parse(fs.readFileSync(srv.cfg, 'utf8')).libraryRoot, lib);
  } finally {
    await srv.stop();
    rmrf(tmp);
  }
});

test('sunucu: tek geçerli marketplace kök kaydında otomatik seçilir', { skip: !gitAvailable && 'git yok' }, async () => {
  const tmp = tmpDir();
  const srv = await start(tmp);
  try {
    const lib = path.join(tmp, 'lib'); fs.mkdirSync(lib);
    await srv.call('PUT', '/api/settings', { libraryRoot: lib });
    await srv.call('POST', '/api/marketplaces', { name: 'tek', activate: false });
    let r = await srv.call('GET', '/api/settings');
    assert.equal(r.data.activeMarketplace, '');
    assert.equal(r.data.setup.issues[0].code, 'marketplaceSecilmedi');
    r = await srv.call('PUT', '/api/settings', { libraryRoot: lib });
    assert.equal(r.data.activeMarketplace, 'tek'); assert.equal(r.data.setup.ok, true);
  } finally {
    await srv.stop();
    rmrf(tmp);
  }
});

// Ağaç yanıtında (marketplaces[]) bir marketplace altındaki dosya/klasör düğümünü yoluna göre bulur.
function findNode(marketplaces, mp, p) {
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.path === p) return n;
      const x = walk(n.children); if (x) return x;
    }
    return null;
  };
  const m = marketplaces.find((x) => x.name === mp);
  if (!m) return null;
  const groups = [m.plugins, m.loose, m.inbox ? [m.inbox] : [], m.teknik];
  for (const g of groups) { const x = walk(g); if (x) return x; }
  return null;
}

async function setupMk(srv, tmp) {
  const lib = path.join(tmp, 'lib'); fs.mkdirSync(lib);
  await srv.call('PUT', '/api/settings', { libraryRoot: lib });
  const r = await srv.call('POST', '/api/marketplaces', { name: 'mk' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return path.join(lib, 'mk');
}

test('sunucu: sürüm kuralları (D1)', { skip: !gitAvailable && 'git yok' }, async () => {
  const tmp = tmpDir();
  const srv = await start(tmp);
  try {
    const mk = await setupMk(srv, tmp);
    const ppFile = path.join(mk, 'pp.config.json');
    const writeCfg = (v) => {
      const c = JSON.parse(fs.readFileSync(ppFile, 'utf8')); c.marketplace.version = v;
      fs.writeFileSync(ppFile, JSON.stringify(c, null, 2) + '\n');
    };

    // a) boş sürüm okunurken 1.0.0, diske yazılmaz
    writeCfg('');
    let r = await srv.call('GET', '/api/marketplace/status');
    assert.equal(r.data.config.version, '1.0.0');
    assert.deepEqual(r.data.configIssues, []);
    assert.equal(JSON.parse(fs.readFileSync(ppFile, 'utf8')).marketplace.version, '');
    assert.equal((await srv.call('GET', '/api/info')).data.config.marketplace.version, '1.0.0');

    // b) init doğrulaması
    r = await srv.call('POST', '/api/marketplace/init', { config: { version: '' } });
    assert.equal(r.status, 400); assert.equal(r.data.field, 'version'); assert.equal(r.data.error, 'Sürüm boş olamaz (örnek: 1.0.0)');
    r = await srv.call('POST', '/api/marketplace/init', { config: { version: '1.0' } });
    assert.equal(r.status, 400); assert.equal(r.data.error, 'Sürüm X.Y.Z biçiminde olmalı (örnek: 1.0.0): "1.0"');
    assert.equal(JSON.parse(fs.readFileSync(ppFile, 'utf8')).marketplace.version, '', 'hata durumunda yazılmamalı');
    r = await srv.call('POST', '/api/marketplace/init', { config: { version: '1.2.3' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(JSON.parse(fs.readFileSync(ppFile, 'utf8')).marketplace.version, '1.2.3');

    // c) eski yayın rotası plugin.json'a sürüm yazmaz (sürüm paket yayınıyla gelir: server.paket.test.js)
    await srv.call('POST', '/api/file', { path: 'prompts/k.md', raw: '---\ntur: komut\n---\ngovde\n' });
    r = await srv.call('POST', '/api/marketplace/publish', { all: true });
    assert.equal(r.data.done.length, 1);
    const pj = JSON.parse(fs.readFileSync(path.join(mk, 'plugins', 'mk', '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(pj.version, undefined);
    assert.equal(JSON.parse(fs.readFileSync(path.join(mk, '.claude-plugin', 'marketplace.json'), 'utf8')).version, '1.2.3', 'katalog sürümü marketplace.json içinde');

    // d) biçimi bozuk eski değer reddedilmez, uyarı verir
    writeCfg('1.0');
    r = await srv.call('GET', '/api/marketplace/status');
    assert.equal(r.data.config.version, '1.0');
    assert.equal(r.data.configIssues[0].code, 'surumGecersiz');
    assert.equal(r.data.configIssues[0].level, 'warn');
  } finally {
    await srv.stop();
    rmrf(tmp);
  }
});

test('sunucu: yayına girmeyen promptlar nedeniyle raporlanır (D2)', { skip: !gitAvailable && 'git yok' }, async () => {
  const tmp = tmpDir();
  const srv = await start(tmp);
  try {
    const mk = await setupMk(srv, tmp);
    const A = 'prompts/a.md'; const B = 'prompts/b.md'; const C = 'prompts/c.md'; const D = 'prompts/d.md'; const E = 'prompts/e.md';
    const put = (p, raw) => srv.call('POST', '/api/file', { path: p, raw });
    await put(A, '---\nbaslik: A\ntur: komut\nkomut_adi: aa\n---\ngovde\n');
    await put(B, '---\nbaslik: B\nkomut_adi: bb\n---\ngovde\n');
    await put(C, '---\nbaslik: C\ntur: komutt\n---\ngovde\n');
    await put(D, '---\nbaslik: D\ntur: komut\ngovde\n');
    await put(E, '---\nbaslik: E\n---\ngovde\n');

    let r = await srv.call('GET', '/api/marketplace/status');
    assert.deepEqual(r.data.skipped.map((x) => x.code).sort(), ['onYuzKapanmamis', 'turGecersiz', 'turYok']);
    assert.equal(r.data.unpublishedCount, 1);
    assert.deepEqual(r.data.skipped.find((x) => x.code === 'turYok').fields, ['komut_adi']);
    assert.equal(r.data.items.length, 1);
    assert.ok(r.data.items[0].issues.every((i) => i.code));

    // tek prompt yayınlama: yanıltıcı "zaten güncel" yerine skipped
    r = await srv.call('POST', '/api/marketplace/publish', { paths: [B] });
    assert.deepEqual(r.data.done, []); assert.equal(r.data.skipped[0].code, 'turYok');
    r = await srv.call('POST', '/api/marketplace/publish', { paths: ['prompts/yok.md'] });
    assert.equal(r.data.skipped[0].code, 'kaynakYok');
    r = await srv.call('POST', '/api/marketplace/publish', { paths: [E] });
    assert.equal(r.data.skipped[0].code, 'yayinDisi');

    // /api/file, /api/tree, /api/facets
    r = await srv.call('GET', '/api/file?path=' + B);
    assert.equal(r.data.publishCheck.code, 'turYok');
    r = await srv.call('GET', '/api/file?path=' + A);
    assert.equal(r.data.publishCheck, null);
    r = await srv.call('GET', '/api/file?path=' + E);
    assert.equal(r.data.publishCheck.code, 'yayinDisi');
    r = await srv.call('GET', '/api/file?path=pp.config.json');
    assert.equal(r.data.publishCheck, null);
    r = await srv.call('GET', '/api/tree');
    assert.equal(findNode(r.data.marketplaces, 'mk', B).meta.uyari, 'turYok');
    assert.equal(findNode(r.data.marketplaces, 'mk', A).meta.uyari, '');
    assert.equal(findNode(r.data.marketplaces, 'mk', E).meta.uyari, '');
    r = await srv.call('GET', '/api/facets');
    assert.equal(r.data.yayinUyari, 3);

    // orphan eşleştirme: yayınlanmış A'dan tur silinir
    r = await srv.call('POST', '/api/marketplace/publish', { paths: [A] });
    assert.equal(r.data.done.length, 1);
    r = await srv.call('PUT', '/api/file', { path: A, raw: '---\nbaslik: A\nkomut_adi: aa\n---\ngovde\n' });
    assert.equal(r.status, 200);
    r = await srv.call('GET', '/api/marketplace/status');
    assert.equal(r.data.orphans.length, 1);
    assert.equal(r.data.orphans[0].likelySource.source, A);
    assert.equal(r.data.orphans[0].likelySource.code, 'turYok');

    // yalnızca simgelerden oluşan ad ve boş içerik
    await put('prompts/f.md', '---\ntur: komut\nkomut_adi: "!!!"\naciklama: x\n---\n\n');
    r = await srv.call('GET', '/api/marketplace/status');
    const f = r.data.items.find((i) => i.source === 'prompts/f.md');
    assert.deepEqual(f.issues.map((i) => i.code).sort(), ['adUretilemedi', 'icerikBos']);
    r = await srv.call('POST', '/api/marketplace/publish', { paths: ['prompts/f.md'] });
    assert.equal(r.data.failed[0].code, 'icerikBos');
    r = await srv.call('GET', '/api/file?path=prompts/f.md');
    assert.equal(r.data.publishCheck.code, 'icerikBos'); assert.equal(r.data.publishCheck.level, 'error');

    // 2 MB üstü dosya
    fs.writeFileSync(path.join(mk, 'prompts', 'buyuk.md'), 'x'.repeat(2000001));
    r = await srv.call('GET', '/api/marketplace/status');
    assert.ok(r.data.skipped.some((x) => x.code === 'dosyaBuyuk' && x.source === 'prompts/buyuk.md'));
    r = await srv.call('POST', '/api/marketplace/publish', { all: true });
    assert.ok(r.data.skipped.some((x) => x.code === 'dosyaBuyuk'));
    r = await srv.call('GET', '/api/search?q=x');
    assert.ok(!r.data.results.some((x) => x.path === 'prompts/buyuk.md'));
  } finally {
    await srv.stop();
    rmrf(tmp);
  }
});

test('sunucu: kaydet-commit ve sürüm (Aşama 2)', { skip: !gitAvailable && 'git yok' }, async () => {
  const tmp = tmpDir();
  const srv = await start(tmp);
  try {
    const lib = path.join(tmp, 'PromptLibrary');
    let r = await srv.call('PUT', '/api/settings', { libraryRoot: lib, create: true });
    assert.equal(r.status, 200);
    r = await srv.call('POST', '/api/marketplaces', { name: 'mp' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const P = 'prompts/ornek/a.md';
    const mpDir = path.join(lib, 'mp');
    const RAW = '---\nbaslik: A\n---\n\nbir\n';
    r = await srv.call('POST', '/api/file', { path: P, raw: RAW });
    assert.equal(r.status, 200);
    let mtime = r.data.mtime;

    // Kaydet + commit
    r = await srv.call('PUT', '/api/file', { path: P, raw: RAW, commitMessage: 'ilk' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.match(r.data.commit, /^[0-9a-f]{7,}$/);
    r = await srv.call('GET', '/api/git/log?path=' + encodeURIComponent(P));
    assert.equal(r.data.commits.length, 1);
    r = await srv.call('PUT', '/api/file', { path: P, raw: RAW, commitMessage: 'tekrar' });
    assert.equal(r.data.commitSkipped, 'degisiklikYok'); assert.equal(r.data.commit, null);
    r = await srv.call('PUT', '/api/file', { path: P, raw: RAW });
    assert.equal('commit' in r.data, false);
    mtime = r.data.mtime;

    // Sürüm
    r = await srv.call('GET', '/api/version?path=' + encodeURIComponent(P));
    assert.equal(r.status, 200);
    assert.equal(r.data.ilkSurum, true); assert.equal(r.data.oneriler.yama, '1.0.0');
    r = await srv.call('POST', '/api/version/bump', { path: P, level: 'yama', note: 'İlk sürüm', baseMtime: mtime });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.version, '1.0.0'); assert.equal(r.data.tag, 'prompt/ornek/a/v1.0.0');
    assert.match(fs.readFileSync(path.join(mpDir, P), 'utf8'), /^versiyon: 1\.0\.0$/m);

    // tutarlılık uyarısı
    r = await srv.call('GET', '/api/file?path=' + encodeURIComponent(P));
    const changed = r.data.raw + 'yeni satir\n';
    r = await srv.call('PUT', '/api/file', { path: P, raw: changed });
    r = await srv.call('GET', '/api/tree');
    assert.equal(findNode(r.data.marketplaces, 'mp', P).meta.surum, 'surumGuncelDegil');
    r = await srv.call('GET', '/api/version?path=' + encodeURIComponent(P));
    assert.equal(r.data.uyari.code, 'surumGuncelDegil');
    r = await srv.call('POST', '/api/version/bump', { path: P, level: 'kucuk', note: 'ikinci' });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.version, '1.1.0');
    r = await srv.call('GET', '/api/tree');
    assert.equal(findNode(r.data.marketplaces, 'mp', P).meta.surum, '');

    // hatalar
    const cur = fs.readFileSync(path.join(mpDir, P), 'utf8');
    fs.writeFileSync(path.join(mpDir, P), cur.replace('versiyon: 1.1.0', 'versiyon: 1.0.0'));
    r = await srv.call('POST', '/api/version/bump', { path: P, level: 'yama', note: 'n' });
    assert.equal(r.status, 409); assert.equal(r.data.code, 'surumGeride');
    fs.writeFileSync(path.join(mpDir, P), cur.replace('versiyon: 1.1.0', 'versiyon: abc'));
    r = await srv.call('POST', '/api/version/bump', { path: P, level: 'yama', note: 'n' });
    assert.equal(r.status, 400); assert.equal(r.data.field, 'versiyon');
    r = await srv.call('POST', '/api/version/bump', { path: P, level: 'yama', note: '' });
    assert.equal(r.status, 400); assert.equal(r.data.field, 'note');
    r = await srv.call('POST', '/api/version/bump', { path: 'pp.config.json', level: 'yama', note: 'n' });
    assert.equal(r.status, 400);
    r = await srv.call('GET', '/api/version?path=pp.config.json');
    assert.equal(r.status, 400);
    r = await srv.call('POST', '/api/version/bump', { path: P, level: 'yama', note: 'n', baseMtime: 12345 });
    assert.equal(r.status, 409); assert.equal(r.data.conflict, true);
  } finally { await srv.stop(); rmrf(tmp); }
});

/** Summary: Yolu istemci tarafında normalleştirmeden (../ korunur) ham GET gönderir. */
function rawGet(base, rawPath, headers = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: rawPath, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('sunucu: i18n çekirdeği ve sözlükler servis edilir, izin listesi dışındaki yollar 404', async () => {
  const tmp = tmpDir();
  const srv = await start(tmp);
  try {
    for (const file of ['i18n.js', 'lang/tr.js', 'lang/en.js', 'fm.js', 'rules.js']) {
      const r = await rawGet(srv.base, '/' + file);
      assert.equal(r.status, 200, file);
      assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8', file);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.text, fs.readFileSync(path.join(PUBLIC, file), 'utf8'), file);
    }

    const index = await rawGet(srv.base, '/');
    assert.equal(index.status, 200);
    assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
    const srcs = [...index.text.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.deepEqual(srcs, ['/lang/tr.js', '/lang/en.js', '/i18n.js', '/fm.js', '/rules.js']);
    for (const src of srcs) assert.equal((await rawGet(srv.base, src)).status, 200, src);
    // index.html'deki her @font-face dosyası izin listesinde ve woff2 olarak servis edilir.
    const fonts = [...index.text.matchAll(/url\("(\/fonts\/[^"]+)"\)/g)].map((m) => m[1]);
    assert.ok(fonts.length > 0, 'yerel yazı tipleri');
    for (const f of new Set(fonts)) {
      const r = await rawGet(srv.base, f);
      assert.equal(r.status, 200, f);
      assert.equal(r.headers['content-type'], 'font/woff2', f);
    }
    assert.equal((await rawGet(srv.base, '/fonts/OFL.txt')).status, 404, 'lisans dosyası servis edilmez');

    const denied = [
      '/lib/git-service.js', '/lib/', '/lang', '/lang/', '/lang/de.js', '/lang/tr.js.map', '/lang/tr.js/', '/lang//tr.js',
      '/lang/../lib/git-service.js', '/lang/../../server.js', '/../server.js', '/../../package.json',
      '/lang/%2e%2e/lib/git-service.js', '/%2e%2e/server.js', '/lang/..%2flib%2fgit-service.js', '/lang%2ftr.js',
      '/server.js', '/package.json', '/test/i18n.test.js', '/I18n.js', '/Lang/tr.js', '/LANG/TR.JS', '/lang/tr.JS'
    ];
    for (const p of denied) {
      const r = await rawGet(srv.base, p);
      assert.equal(r.status, 404, p);
      assert.equal(r.text, 'Bulunamadı', p);
    }
    assert.equal((await rawGet(srv.base, '/lib/git-service.js', { 'X-PP-Lang': 'en' })).text, 'Not found', 'statik 404 iletisi istek dilinde');
  } finally {
    await srv.stop();
    rmrf(tmp);
  }
});

test('sunucu: X-PP-Lang ile API 404 iletisi dile göre; başlıksız ve geçersiz değer Türkçe', async () => {
  const tmp = tmpDir();
  const srv = await start(tmp);
  try {
    const get = (lang) => srv.call('GET', '/api/yok-boyle-bir-yol', undefined, { headers: lang === undefined ? {} : { 'X-PP-Lang': lang } });

    let r = await get('en');
    assert.equal(r.status, 404);
    assert.deepEqual(r.data, { error: 'Not found' });
    for (const lang of [undefined, 'tr', 'fr', '', 'en-US', 'en, tr', 'null']) {
      r = await get(lang);
      assert.equal(r.status, 404, String(lang));
      assert.deepEqual(r.data, { error: 'Bulunamadı' }, 'dil=' + JSON.stringify(lang));
    }

    for (const method of ['POST', 'PUT', 'DELETE']) {
      r = await srv.call(method, '/api/yok-boyle-bir-yol', method === 'DELETE' ? undefined : {}, { headers: { 'X-PP-Lang': 'en' } });
      assert.equal(r.status, 404, method);
      assert.deepEqual(r.data, { error: 'Not found' }, method);
    }

    r = await srv.call('PUT', '/api/settings', {}, { headers: { 'X-PP': '0', 'X-PP-Lang': 'en' } });
    assert.equal(r.status, 403);
    assert.deepEqual(r.data, { error: 'Missing request header' }, 'başlık hatası istek dilinde');

    const results = await Promise.all(Array.from({ length: 24 }, (_, n) => get(n % 2 ? 'en' : 'tr')));
    results.forEach((x, n) => assert.equal(x.data.error, n % 2 ? 'Not found' : 'Bulunamadı', 'istek ' + n));
  } finally {
    await srv.stop();
    rmrf(tmp);
  }
});
