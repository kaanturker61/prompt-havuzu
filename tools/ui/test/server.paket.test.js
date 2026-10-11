'use strict';
/* Aşama 4 sunucu testleri: paket rotaları, yayın, uzak depo, klonlama, X-PP-MP kapsamı.
 * server.js alt süreç olarak başlatılır; yalnızca geçici klasör, PP_CONFIG ve yerel bare repo kullanılır (ağ yok). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { gitAvailable, tmpDir, rmrf, gitEnv, sh, makeBare, makeRepo } = require('./helpers');

const SERVER = path.join(__dirname, '..', 'server.js');
const real = { skip: !gitAvailable && 'git yok' };

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

const cmd = (baslik, extra = '') => `---\nbaslik: ${baslik}\ntur: komut\n${extra}---\n${baslik} gövde\n`;

// Kütüphane + 'mk' marketplace'i, ornek paketi (a, b) ve ilk commit.
async function setupMk(srv, tmp, names = ['mk']) {
  const lib = path.join(tmp, 'lib');
  assert.equal((await srv.call('PUT', '/api/settings', { libraryRoot: lib, create: true })).status, 200);
  for (const n of names) assert.equal((await srv.call('POST', '/api/marketplaces', { name: n })).status, 200);
  await srv.call('POST', '/api/marketplaces/activate', { name: names[0] });
  const mk = path.join(lib, names[0]);
  let r = await srv.call('POST', '/api/package', { name: 'ornek', description: 'Örnek paket' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await srv.call('POST', '/api/file', { path: 'prompts/ornek/a.md', raw: cmd('A', 'komut_adi: aa\n') });
  await srv.call('POST', '/api/file', { path: 'prompts/ornek/b.md', raw: cmd('B', 'komut_adi: bb\n') });
  r = await srv.call('GET', '/api/git/status');
  r = await srv.call('POST', '/api/git/commit', { message: 'ilk', paths: r.data.files.map((f) => f.path) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return mk;
}

test('sunucu: paket listesi, sayfa, yayın, push, marketplace güncelle ve durum süzgeci', real, async () => {
  const tmp = tmpDir();
  const srv = await start(tmp);
  try {
    const mk = await setupMk(srv, tmp);
    const env = gitEnv(tmp);
    await srv.call('POST', '/api/file', { path: 'prompts/ornek/taslak.md', raw: cmd('Taslak', 'durum: taslak\nkomut_adi: tt\n') });
    await srv.call('POST', '/api/file', { path: 'prompts/ornek/bos.md', raw: cmd('Boş durum', 'komut_adi: bd\n') });
    sh(mk, ['add', '-A'], env); sh(mk, ['commit', '-q', '-m', 'ekler'], env);

    let r = await srv.call('GET', '/api/packages');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.export, { durumlar: ['kararlı', ''], haricKlasorler: ['gelen-kutusu'] });
    const p = r.data.packages[0];
    assert.equal(p.name, 'ornek'); assert.equal(p.description, 'Örnek paket'); assert.equal(p.exportedCount, 3);
    assert.equal(p.excludedCount, 1); assert.equal(p.version, null); assert.equal(p.lastTag, null);
    assert.equal(p.proposal.version, '1.0.0'); assert.equal(p.listed, false); assert.equal(p.pendingPush, false);

    r = await srv.call('GET', '/api/package?name=ornek');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.prompts.map((x) => x.ad).sort(), ['aa', 'bb', 'bd']);
    assert.equal(r.data.excluded[0].code, 'durumHaric'); assert.equal(r.data.excluded[0].source, 'prompts/ornek/taslak.md');
    assert.deepEqual(r.data.dirty, []); assert.deepEqual(r.data.marketplaceVersion, { current: '1.0.0', proposal: '1.0.1' });
    assert.equal(r.data.remote, null);
    assert.equal((await srv.call('GET', '/api/package?name=yok')).data.error, 'Paket bulunamadı: yok');
    assert.equal((await srv.call('GET', '/api/package?name=yok')).status, 404);

    // uzak depo ekle (bare), doğrulamalar
    const bare = makeBare(tmp);
    assert.equal((await srv.call('POST', '/api/git/remotes', { name: 'Origin', url: bare })).status, 400);
    r = await srv.call('POST', '/api/git/remotes', { name: 'origin', url: 'ext::sh -c x' });
    assert.equal(r.status, 400); assert.match(r.data.error, /güvenlik/);
    assert.equal((await srv.call('POST', '/api/git/remotes', { name: 'origin', url: 'https://u:p@h/r' })).status, 400);
    assert.equal((await srv.call('POST', '/api/git/push', {})).data.code, 'remoteYok');
    r = await srv.call('POST', '/api/git/remotes', { name: 'origin', url: bare });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await srv.call('POST', '/api/git/remotes', { name: 'origin', url: bare })).status, 409);
    assert.equal((await srv.call('PUT', '/api/git/remotes', { name: 'yok', url: bare })).status, 404);

    // yayın + push
    r = await srv.call('POST', '/api/package/publish', { name: 'ornek', push: true });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.version, '1.0.0'); assert.equal(r.data.tag, 'paket/ornek/v1.0.0'); assert.equal(r.data.marketplaceVersion, '1.0.1');
    assert.deepEqual(r.data.push, { ok: true });
    assert.match(sh(bare, ['tag', '-l'], env), /paket\/ornek\/v1\.0\.0/);
    const pj = JSON.parse(fs.readFileSync(path.join(mk, 'plugins/ornek/.claude-plugin/plugin.json'), 'utf8'));
    assert.equal(pj.version, '1.0.0');
    r = await srv.call('GET', '/api/packages');
    assert.equal(r.data.packages[0].version, '1.0.0'); assert.equal(r.data.packages[0].lastTag.name, 'paket/ornek/v1.0.0');
    assert.equal(r.data.packages[0].listed, true); assert.equal(r.data.packages[0].proposal.noChange, true);
    assert.equal((await srv.call('POST', '/api/package/publish', { name: 'ornek' })).data.degisiklikYok, undefined);
    r = await srv.call('POST', '/api/package/publish', { name: 'ornek' });
    assert.equal(r.status, 409); assert.equal(r.data.code, 'degisiklikYok');

    // durum süzgeci: taslak çıktıda yok, boş durum var
    assert.equal(fs.existsSync(path.join(mk, 'plugins/ornek/commands/tt.md')), false);
    assert.equal(fs.existsSync(path.join(mk, 'plugins/ornek/commands/bd.md')), true);

    // marketplace güncelle: değişiklik yok -> commit null; katalog sürümü değişmez
    r = await srv.call('POST', '/api/marketplace/update', {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.commit, 'ilk güncelleme plugins/README.md ekler');
    r = await srv.call('POST', '/api/marketplace/update', {});
    assert.equal(r.data.commit, null); assert.equal(r.data.message, 'Değişiklik yok');
    // taslak yayına girsin: durum değişince güncelle commit atar, tag atmaz
    await srv.call('PUT', '/api/file', { path: 'prompts/ornek/taslak.md', raw: cmd('Taslak', 'durum: kararlı\nkomut_adi: tt\n') });
    sh(mk, ['add', '-A'], env); sh(mk, ['commit', '-q', '-m', 'taslak kararlı'], env);
    r = await srv.call('POST', '/api/marketplace/update', {});
    assert.ok(r.data.commit); assert.deepEqual(r.data.written, ['plugins/ornek/commands/tt.md']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(mk, 'pp.config.json'), 'utf8')).marketplace.version, '1.0.1');
    assert.equal(sh(mk, ['tag', '-l', 'paket/*'], env).trim().split('\n').length, 1);

    // marketplace durumu: update komutu yok, uzak depo yerel yol
    r = await srv.call('GET', '/api/marketplace/status');
    assert.equal(r.data.commands.update, undefined);
    assert.equal(r.data.commands.add, 'claude plugin marketplace add ' + (/\s/.test(bare) ? '"' + bare + '"' : bare));
    assert.deepEqual(r.data.listed, ['ornek']);
    assert.equal(r.data.commands.install[0].cmd, 'claude plugin install ornek@mk');
    // GitLab remote: yalnızca tam URL (push yapılmaz)
    await srv.call('PUT', '/api/git/remotes', { name: 'origin', url: 'https://gitlab.com/grup/proje' });
    r = await srv.call('GET', '/api/marketplace/status');
    assert.equal(r.data.commands.add, 'claude plugin marketplace add https://gitlab.com/grup/proje.git');
    assert.deepEqual(r.data.commands.alternatives, []);
    await srv.call('PUT', '/api/git/remotes', { name: 'origin', url: 'https://github.com/o/r' });
    r = await srv.call('GET', '/api/marketplace/status');
    assert.equal(r.data.commands.add, 'claude plugin marketplace add o/r');
    assert.deepEqual(r.data.commands.alternatives, ['claude plugin marketplace add https://github.com/o/r.git']);
    r = await srv.call('GET', '/api/git/remotes');
    assert.equal(r.data.remotes[0].provider, 'github'); assert.equal(r.data.remotes[0].addCommand, 'o/r');
  } finally { await srv.stop(); rmrf(tmp); }
});

test('sunucu: X-PP-MP kapsamı ve iki marketplace\'te yayın yalnızca etkin depoya yazar', real, async () => {
  const tmp = tmpDir();
  const srv = await start(tmp);
  try {
    const mk = await setupMk(srv, tmp, ['mk', 'diger']);
    const other = path.join(tmp, 'lib', 'diger');
    const env = gitEnv(tmp);
    const bad = { headers: { 'X-PP-MP': 'diger' } };
    const headBefore = sh(mk, ['rev-parse', 'HEAD'], env).trim();
    for (const [m, u, b] of [['GET', '/api/packages'], ['GET', '/api/package?name=ornek'], ['POST', '/api/package/publish', { name: 'ornek' }],
      ['POST', '/api/git/push', {}], ['POST', '/api/git/fetch', {}], ['POST', '/api/git/pull', {}], ['GET', '/api/git/remotes'],
      ['POST', '/api/marketplace/update', {}]]) {
      const r = await srv.call(m, u, b, bad);
      assert.equal(r.status, 409, m + ' ' + u); assert.equal(r.data.code, 'etkinDegil', u); assert.equal(r.data.active, 'mk');
    }
    assert.equal(sh(mk, ['rev-parse', 'HEAD'], env).trim(), headBefore);
    assert.equal(sh(mk, ['tag', '-l'], env).trim(), '');
    assert.equal(fs.existsSync(path.join(mk, 'plugins')), false);
    // doğru başlıkla yayın yalnızca etkin depoya yazar
    const ok = { headers: { 'X-PP-MP': 'mk' } };
    let r = await srv.call('POST', '/api/package/publish', { name: 'ornek' }, ok);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.match(sh(mk, ['tag', '-l'], env), /paket\/ornek\/v1\.0\.0/);
    assert.equal(sh(other, ['tag', '-l'], env).trim(), '');
    assert.equal(fs.existsSync(path.join(other, 'plugins')), false);
    // klonlama ve pp-config etkin marketplace'ten bağımsız (yanlış başlık engellemez)
    r = await srv.call('POST', '/api/marketplaces/pp-config', { name: 'diger' }, bad);
    assert.equal(r.status, 409, 'diger zaten pp.config.json içeriyor');
  } finally { await srv.stop(); rmrf(tmp); }
});

test('sunucu: klonlama, pp-config oluşturma, taşıma engeli', real, async () => {
  const tmp = tmpDir();
  const srv = await start(tmp);
  try {
    const mk = await setupMk(srv, tmp);
    const env = gitEnv(tmp);
    // ayarsız bir kaynak depo (pp.config.json yok)
    const src = makeRepo(tmp, 'ayarsiz');
    fs.mkdirSync(path.join(src, '.claude-plugin'));
    fs.writeFileSync(path.join(src, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'uzak-mp', description: 'Uzak açıklama', owner: { name: 'Sahip' }, plugins: [] }));
    sh(src, ['add', '-A'], env); sh(src, ['commit', '-q', '-m', 'i'], env);
    const bare = makeBare(tmp, 'ayarsiz.git');
    sh(src, ['remote', 'add', 'origin', bare], env); sh(src, ['push', '-q', 'origin', 'main'], env);

    let r = await srv.call('POST', '/api/marketplaces/clone', { url: 'ext::sh -c x' });
    assert.equal(r.status, 400); assert.equal(r.data.code, 'urlGecersiz');
    r = await srv.call('POST', '/api/marketplaces/clone', { url: bare, name: 'claude-plugins-official' });
    assert.equal(r.status, 400); assert.equal(r.data.code, 'adGecersiz');
    r = await srv.call('POST', '/api/marketplaces/clone', { url: path.join(tmp, 'yok.git'), name: 'yoktur' });
    assert.equal(r.status, 502); assert.match(r.data.error, /^Depo klonlanamadı: /);
    assert.equal(fs.existsSync(path.join(tmp, 'lib', 'yoktur')), false);
    r = await srv.call('POST', '/api/marketplaces/clone', { url: bare, name: 'mk' });
    assert.equal(r.status, 409); assert.equal(r.data.code, 'klasorVar');

    // etkinleştirmeden (activate:false) ve X-PP-MP başlığı olmadan çalışır
    r = await srv.call('POST', '/api/marketplaces/clone', { url: bare, name: 'uzak', activate: false });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.warnings.map((w) => w.code), ['ppConfigYok']);
    assert.equal(r.data.marketplace.name, 'uzak'); assert.equal(r.data.marketplace.hasPpConfig, false);
    assert.equal((await srv.call('GET', '/api/info')).data.activeMarketplace, 'mk');

    // taşıma hedefinde pp.config.json yok
    fs.mkdirSync(path.join(tmp, 'lib', 'uzak', 'library', 'p'), { recursive: true });
    r = await srv.call('POST', '/api/prompts/transfer', { path: 'prompts/ornek/a.md', toMp: 'uzak', toPlugin: 'p' });
    assert.equal(r.status, 400); assert.equal(r.data.code, 'hedefPpConfigYok');
    assert.ok(fs.existsSync(path.join(mk, 'prompts/ornek/a.md')), 'kaynak yerinde');

    // pp-config oluştur
    r = await srv.call('POST', '/api/marketplaces/pp-config', { name: 'uzak' }, { headers: { 'X-PP-MP': 'baska' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const pc = JSON.parse(fs.readFileSync(path.join(tmp, 'lib', 'uzak', 'pp.config.json'), 'utf8'));
    assert.equal(pc.libraryDir, 'prompts'); assert.equal(pc.marketplace.name, 'uzak-mp'); assert.equal(pc.marketplace.owner, 'Sahip');
    assert.equal(pc.marketplace.description, 'Uzak açıklama');
    assert.equal(sh(path.join(tmp, 'lib', 'uzak'), ['log', '--oneline'], env).trim().split('\n').length, 1, 'commit atılmadı');
    assert.equal((await srv.call('POST', '/api/marketplaces/pp-config', { name: 'uzak' })).status, 409);
    assert.equal((await srv.call('POST', '/api/marketplaces/pp-config', { name: 'yok' })).status, 404);

    // etkinleştirerek klonla
    r = await srv.call('POST', '/api/marketplaces/clone', { url: bare, name: 'uzak2' });
    assert.equal(r.status, 200);
    assert.equal((await srv.call('GET', '/api/info')).data.activeMarketplace, 'uzak2');
    assert.ok(r.data.setup.issues.some((i) => i.code === 'ppConfigYok'));
    assert.equal(r.data.setup.ok, true);
  } finally { await srv.stop(); rmrf(tmp); }
});

test('sunucu: fetch, pull, ileri sarma ve ayarlar (remoteCheck)', real, async () => {
  const tmp = tmpDir();
  const srv = await start(tmp);
  try {
    const mk = await setupMk(srv, tmp);
    const env = gitEnv(tmp);
    const bare = makeBare(tmp);
    await srv.call('POST', '/api/git/remotes', { name: 'origin', url: bare });
    let r = await srv.call('POST', '/api/git/push', {});
    assert.equal(r.status, 200); assert.equal(r.data.ok, true);
    // B kopyası uzakta yeni commit + paket etiketi oluşturur
    sh(tmp, ['clone', '-q', bare, 'b'], env);
    const b = path.join(tmp, 'b');
    fs.writeFileSync(path.join(b, 'prompts', 'ornek', 'c.md'), cmd('C'));
    sh(b, ['add', '-A'], env); sh(b, ['commit', '-q', '-m', 'uzak değişiklik'], env);
    sh(b, ['tag', '-a', 'paket/ornek/v1.2.0', '-m', 'x'], env);
    sh(b, ['push', '-q', 'origin', 'main', '--tags'], env);

    r = await srv.call('POST', '/api/git/fetch', {});
    assert.equal(r.status, 200); assert.equal(r.data.ok, true); assert.equal(r.data.behind, 1);
    assert.deepEqual(r.data.newTags, ['paket/ornek/v1.2.0']); assert.equal(r.data.newCommits[0].subject, 'uzak değişiklik');
    r = await srv.call('GET', '/api/git/remotes');
    assert.equal(r.data.behind, 1); assert.equal(r.data.lastCheck.behind, 1);
    // arka plan: saatlik sınır içinde önbellekten
    r = await srv.call('POST', '/api/git/fetch', { background: true });
    assert.equal(r.data.cached, true);
    // kirli ağaçta güncelleme 409
    fs.appendFileSync(path.join(mk, 'prompts/ornek/a.md'), 'kirli\n');
    r = await srv.call('POST', '/api/git/pull', {});
    assert.equal(r.status, 409); assert.equal(r.data.code, 'kirliCalismaAgaci');
    sh(mk, ['checkout', '--', 'prompts/ornek/a.md'], env);
    r = await srv.call('POST', '/api/git/pull', {});
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.deepEqual(r.data.adoptedTags, ['paket/ornek/v1.2.0']);
    assert.ok(fs.existsSync(path.join(mk, 'prompts/ornek/c.md')));
    assert.equal((await srv.call('POST', '/api/git/pull', {})).data.code, 'guncel');
    assert.match(sh(mk, ['tag', '-l'], env), /paket\/ornek\/v1\.2\.0/);
    // yeni paket yayını artık v1.2.0 tabanından hesaplanır
    r = await srv.call('GET', '/api/package?name=ornek');
    assert.equal(r.data.lastTag.version, '1.2.0');

    // ayarlar: remoteCheck
    r = await srv.call('GET', '/api/settings');
    assert.equal(r.data.remoteCheck, 'acilista');
    r = await srv.call('PUT', '/api/settings', { remoteCheck: 'elle' });
    assert.equal(r.status, 200); assert.equal(r.data.remoteCheck, 'elle');
    assert.equal((await srv.call('PUT', '/api/settings', { remoteCheck: 'saatlik' })).status, 400);
    assert.equal((await srv.call('PUT', '/api/settings', { remoteCheck: 'saatlik' })).data.error, 'Geçersiz değer');
    assert.equal((await srv.call('PUT', '/api/settings', { libraryRoot: '' })).status, 400);
    r = await srv.call('GET', '/api/settings');
    assert.equal(r.data.remoteCheck, 'elle'); assert.equal(r.data.activeMarketplace, 'mk');
    r = await srv.call('POST', '/api/git/fetch', { background: true });
    assert.equal(r.data.skipped !== undefined || r.data.cached === true, true);
    // libraryRoot ile birlikte gelirse remoteCheck korunur
    r = await srv.call('PUT', '/api/settings', { libraryRoot: path.join(tmp, 'lib') });
    assert.equal(r.data.remoteCheck, 'elle');
  } finally { await srv.stop(); rmrf(tmp); }
});

test('sunucu: paket alanı klasörle uyuşmazsa yayın engellenir; /api/file publishCheck; init export ayarı', real, async () => {
  const tmp = tmpDir();
  const srv = await start(tmp);
  try {
    const mk = await setupMk(srv, tmp);
    const env = gitEnv(tmp);
    await srv.call('POST', '/api/file', { path: 'prompts/ornek/x.md', raw: cmd('X', 'paket: baska\nkomut_adi: xx\n') });
    sh(mk, ['add', '-A'], env); sh(mk, ['commit', '-q', '-m', 'x'], env);
    let r = await srv.call('GET', '/api/file?path=prompts/ornek/x.md');
    assert.equal(r.data.publishCheck.code, 'paketUyusmuyor'); assert.equal(r.data.publishCheck.level, 'warn');
    assert.equal(r.data.publish.paket, 'ornek'); assert.equal(r.data.publish.paketKaynagi, 'klasor');
    r = await srv.call('GET', '/api/marketplace/status');
    assert.ok(r.data.skipped.some((s) => s.code === 'paketUyusmuyor' && s.source === 'prompts/ornek/x.md'));
    r = await srv.call('POST', '/api/package/publish', { name: 'ornek' });
    assert.equal(r.status, 400); assert.equal(r.data.code, 'dogrulama'); assert.equal(r.data.issues[0].code, 'paketUyusmuyor');
    assert.equal(sh(mk, ['tag', '-l'], env).trim(), '');
    r = await srv.call('GET', '/api/facets');
    assert.equal(r.data.yayinUyari, 1);
    // durum süzgeci ayarı
    r = await srv.call('POST', '/api/marketplace/init', { config: { export: { durumlar: [] } } });
    assert.equal(r.status, 400); assert.equal(r.data.error, 'En az bir durum seçilmeli');
    r = await srv.call('POST', '/api/marketplace/init', { config: { export: { durumlar: ['kararlı'] } } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(mk, 'pp.config.json'), 'utf8')).export.durumlar, ['kararlı']);
    assert.equal(fs.existsSync(path.join(mk, 'plugins')), false, 'init plugin.json yazmaz');
    assert.equal((await srv.call('POST', '/api/marketplace/init', { config: { name: 'claude-plugins-official' } })).status, 400);
    r = await srv.call('GET', '/api/package?name=ornek');
    assert.equal(r.data.prompts.length, 0, 'boş durumlu promptlar artık dışarıda');
  } finally { await srv.stop(); rmrf(tmp); }
});
