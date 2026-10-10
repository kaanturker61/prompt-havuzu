'use strict';
/* Aşama 3 sunucu testleri: /api/history/* rotaları, X-PP-MP koruması, iki marketplace, etkin marketplace yokken.
 * server.js alt süreç olarak başlatılır; yalnızca geçici klasör ve PP_CONFIG kullanılır. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { GitService } = require('../lib/git-service');
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

const md = (durum, govde) => '---\nbaslik: Örnek\ndurum: ' + durum + '\n---\n' + govde;
const q = (o) => '?' + Object.entries(o).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');

test('sunucu: geçmiş rotaları, koruma, iki marketplace, etkin yokken 409', { skip: !gitAvailable && 'git yok' }, async () => {
  const tmp = tmpDir();
  const srv = await start(tmp);
  const g = new GitService({ env: gitEnv(tmp) });
  try {
    const lib = path.join(tmp, 'PromptLibrary');
    const A = path.join(lib, 'birinci'); const B = path.join(lib, 'ikinci');
    assert.equal((await srv.call('PUT', '/api/settings', { libraryRoot: lib, create: true })).status, 200);
    await srv.call('POST', '/api/marketplaces', { name: 'birinci' });
    await srv.call('POST', '/api/marketplaces', { name: 'ikinci' });
    const P = 'prompts/kod/a.md';

    const seed = async (mp, dir, ver, durum) => {
      assert.equal((await srv.call('POST', '/api/marketplaces/activate', { name: mp })).status, 200);
      fs.mkdirSync(path.join(dir, 'prompts', 'kod'), { recursive: true });
      fs.writeFileSync(path.join(dir, P), md('taslak', 'Kodu hızlıca incele.\n'));
      await g.commitPaths(dir, 'ilk', [P]);
      await g.createTag(dir, 'prompt/kod/a/v1.0.0', 'ilk ' + mp, await g.headCommit(dir));
      fs.writeFileSync(path.join(dir, P), md(durum, 'Kodu dikkatle incele.\n'));
      await g.commitPaths(dir, 'ikinci', [P]);
      await g.createTag(dir, 'prompt/kod/a/v' + ver, 'ikinci ' + mp, await g.headCommit(dir));
    };
    await seed('birinci', A, '1.1.0', 'kararlı');
    await seed('ikinci', B, '2.0.0', 'yayında');

    // ikinci etkin: yalnızca kendi tag'leri
    let r = await srv.call('GET', '/api/history/versions' + q({ path: P }));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.versions.map((v) => v.version), ['2.0.0', '1.0.0']);
    assert.equal(r.data.versions[0].subject, 'ikinci ikinci');
    assert.equal(r.data.ad, 'kod/a'); assert.equal(r.data.tracked, true);

    // koruma: yanlış başlık 409, doğru başlık 200
    r = await srv.call('GET', '/api/history/versions' + q({ path: P }), undefined, { headers: { 'X-PP-MP': 'birinci' } });
    assert.equal(r.status, 409); assert.equal(r.data.code, 'etkinDegil'); assert.equal(r.data.active, 'ikinci');
    r = await srv.call('GET', '/api/history/versions' + q({ path: P }), undefined, { headers: { 'X-PP-MP': 'ikinci' } });
    assert.equal(r.status, 200);

    // marketplace değişince sonuç değişir (önbellek karışmaz)
    await srv.call('POST', '/api/marketplaces/activate', { name: 'birinci' });
    r = await srv.call('GET', '/api/history/versions' + q({ path: P }));
    assert.deepEqual(r.data.versions.map((v) => v.version), ['1.1.0', '1.0.0']);
    assert.equal(r.data.versions[0].subject, 'ikinci birinci');

    // compare / show
    r = await srv.call('GET', '/api/history/compare' + q({ path: P, a: 'prompt/kod/a/v1.0.0', b: 'prompt/kod/a/v1.1.0' }));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.fields[0].key, 'durum');
    assert.equal(r.data.body.same, false);
    assert.equal(r.data.commits.length, 1);
    r = await srv.call('GET', '/api/history/compare' + q({ path: P, a: 'prompt/kod/a/v1.1.0', b: 'HEAD' }));
    assert.equal(r.status, 400); assert.equal(r.data.code, 'ayniSurum'); // v1.1.0 = HEAD
    r = await srv.call('GET', '/api/history/compare' + q({ path: P, a: 'prompt/kod/a/v1.0.0', b: 'HEAD' }));
    assert.equal(r.status, 200); assert.equal(r.data.b.ref, 'HEAD');
    r = await srv.call('GET', '/api/history/show' + q({ path: P, tag: 'prompt/kod/a/v1.0.0' }));
    assert.equal(r.status, 200); assert.match(r.data.raw, /hızlıca/);

    // hatalar
    const st = async (url) => (await srv.call('GET', url)).status;
    assert.equal(await st('/api/history/compare' + q({ path: P, a: 'HEAD~1', b: 'HEAD' })), 400);
    assert.equal(await st('/api/history/compare' + q({ path: P, a: '../x', b: 'HEAD' })), 400);
    assert.equal(await st('/api/history/show' + q({ path: P, tag: 'prompt/kod/a/v1.0.0;rm' })), 400);
    assert.equal(await st('/api/history/show' + q({ path: P, tag: 'prompt/kod/a/v9.9.9' })), 404);
    assert.equal(await st('/api/history/show' + q({ path: '../x.md', tag: 'prompt/kod/a/v1.0.0' })), 400);
    assert.equal(await st('/api/history/show' + q({ tag: 'prompt/kod/a/v1.0.0' })), 400);
    r = await srv.call('GET', '/api/history/compare' + q({ path: P, a: 'HEAD', b: 'HEAD' }));
    assert.equal(r.status, 400); assert.equal(r.data.code, 'ayniSurum');
    r = await srv.call('GET', '/api/history/show' + q({ path: P, tag: 'prompt/kod/a/v2.0.0' }));
    assert.equal(r.data.code, 'surumYok'); // 2.0.0 yalnızca ikinci marketplace'te

    // changes
    r = await srv.call('GET', '/api/history/changes?group=file');
    assert.equal(r.status, 200); assert.equal(r.data.mp, 'birinci'); assert.equal(r.data.group, 'file');
    assert.equal(r.data.files.find((f) => f.path === P).count, 2);
    assert.equal(r.data.files.find((f) => f.path === P).exists, true);
    r = await srv.call('GET', '/api/history/changes?group=version');
    assert.equal(r.status, 200); assert.equal(r.data.mp, 'birinci');
    assert.deepEqual(r.data.prompts.map((p) => [p.ad, p.path, p.versions.length]), [['kod/a', P, 2]]);
    assert.equal(await st('/api/history/changes?group=file&limit=0'), 400);
    assert.equal(await st('/api/history/changes?group=file&limit=3001'), 400);
    assert.equal(await st('/api/history/changes?group=file&limit=abc'), 400);
    assert.equal(await st('/api/history/changes?group=baska'), 400);
    assert.equal((await srv.call('GET', '/api/history/changes?group=file&limit=1')).data.commitCount, 1);

    // gerileme: /api/git/log biçimi
    r = await srv.call('GET', '/api/git/log' + q({ path: P }));
    assert.equal(r.status, 200); assert.ok(Array.isArray(r.data.commits)); assert.equal(r.data.commits[0].subject, 'ikinci');

    // etkin marketplace yokken: history 409 setupRequired, ağaç 200
    const cfg = JSON.parse(fs.readFileSync(srv.cfg, 'utf8'));
    fs.writeFileSync(srv.cfg, JSON.stringify({ ...cfg, activeMarketplace: '' }));
    await srv.call('GET', '/api/info'); // kurulum durumu yeniden değerlendirilir
    r = await srv.call('GET', '/api/history/versions' + q({ path: P }));
    assert.equal(r.status, 409); assert.equal(r.data.setupRequired, true);
    assert.equal((await srv.call('GET', '/api/history/changes?group=file')).status, 409);
    assert.equal((await srv.call('GET', '/api/tree')).status, 200);
  } finally { await srv.stop(); rmrf(tmp); }
});
