'use strict';
/* Sınır testleri (docs/plans/08): raporun B-01 ... B-12 tekrar üretim adımları, HTTP üzerinden.
 * server.js alt süreç olarak geçici klasör + PP_CONFIG ile çalışır; bağlantı testleri yalnızca geçici klasörde kurulur. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { gitAvailable, tmpDir, rmrf } = require('./helpers');
const { startServer, setupMarketplace } = require('./server-helper');
const { makeLink, removeLink } = require('./links');

const real = { skip: !gitAvailable && 'git yok' };
const issueCodes = (r) => r.data.setup.issues.map((i) => i.code);
const put = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const ppFile = (mk) => path.join(mk, 'pp.config.json');

// Sunucu + marketplace kurar, fn'e verir, sonunda kapatır ve temizler.
async function withServer(fn, opts) {
  const tmp = tmpDir();
  const srv = await startServer(tmp, { identity: !(opts && opts.identity === false) });
  const links = [];
  const ctx = { tmp, srv, links, call: srv.call };
  try {
    Object.assign(ctx, await setupMarketplace(srv, tmp, opts));
    await fn(ctx);
  } finally {
    links.forEach(removeLink);
    await srv.stop();
    rmrf(tmp);
  }
}

test('B-01: bozuk/null/[] pp.config.json okumada uyarı, yazan rotalarda 409; dosya bayt bayt aynı', real, async () => {
  await withServer(async ({ call, mk, tmp }) => {
    const good = JSON.stringify({ libraryDir: 'prompts', marketplace: { name: 'mk', owner: 'ben', plugin: 'mk', description: 'ÖZEL AÇIKLAMA', version: '2.5.0' }, packages: { eski: { description: 'ESKİ PAKET' } }, export: { durumlar: ['kararlı', ''], haricKlasorler: ['gelen-kutusu', 'ozel-haric'] } }, null, 2) + '\n';
    for (const bad of [good.replace(/\n$/, '') + ', "elle_eklenen": }', 'garip{', 'null', '[]', '"x"', '5']) {
      fs.writeFileSync(ppFile(mk), bad);
      put(path.join(mk, 'plugins', 'x', 'commands', 'a.md'), 'x'); // unpublish için var olan dosya
      const before = fs.readFileSync(ppFile(mk));
      const names = fs.readdirSync(mk).sort();

      // okuma: 200 + uyarı, ok kalır
      let r = await call('GET', '/api/info');
      assert.equal(r.status, 200, bad);
      assert.ok(issueCodes(r).includes('ppConfigBozuk'), bad);
      assert.equal(r.data.setup.ok, true);
      assert.equal(r.data.config.libraryDir, 'library');
      for (const u of ['/api/tree', '/api/facets', '/api/search?q=x', '/api/settings', '/api/marketplaces']) assert.equal((await call('GET', u)).status, 200, u + ' ' + bad);
      r = await call('GET', '/api/tree');
      assert.ok(r.data.marketplaces[0].count === 0);
      r = await call('GET', '/api/marketplace/status');
      assert.equal(r.status, 200);
      assert.ok(r.data.configIssues.some((i) => i.code === 'ppConfigBozuk'), 'configIssues');
      assert.equal(fs.existsSync(path.join(mk, 'library')), false, 'library/ açılmadı');

      // yazma/üretim: 409 ppConfigBozuk
      const writes = [
        ['POST', '/api/package', { name: 'yeni-plugin', description: 'yeni' }],
        ['PUT', '/api/package', { name: 'eski', description: 'x' }],
        ['POST', '/api/package/rename', { from: 'eski', to: 'yeni' }],
        ['POST', '/api/marketplace/init', {}],
        ['POST', '/api/marketplace/update', {}],
        ['POST', '/api/package/publish', { name: 'eski' }],
        ['POST', '/api/import/run', { dir: tmp, files: [path.join(tmp, 'a.txt')] }],
        ['POST', '/api/version/bump', { path: 'prompts/a.md', level: 'yama', note: 'x' }],
        ['POST', '/api/marketplace/publish', { all: true }],
        ['POST', '/api/marketplace/unpublish', { target: 'plugins/x/commands/a.md' }]
      ];
      for (const [m, u, b] of writes) {
        r = await call(m, u, b);
        assert.equal(r.status, 409, `${m} ${u} ${bad}: ${r.text}`);
        assert.equal(r.data.code, 'ppConfigBozuk', `${u}: ${r.text}`);
        assert.match(r.data.error, /^pp\.config\.json okunamadı .*düzelt/, u);
      }
      assert.deepEqual(fs.readFileSync(ppFile(mk)), before, 'pp.config.json bayt bayt aynı');
      assert.equal(fs.existsSync(path.join(mk, 'prompts', 'yeni-plugin')), false);
      assert.ok(fs.existsSync(path.join(mk, 'plugins', 'x', 'commands', 'a.md')), 'unpublish hiçbir şeyi çöpe taşımadı');
      assert.deepEqual(fs.readdirSync(mk).sort(), names, 'kökte yeni dosya/klasör yok (.bak, library/ ...)');
      assert.ok(!fs.readdirSync(mk).some((n) => /\.bak/.test(n)));
      fs.rmSync(path.join(mk, 'plugins'), { recursive: true, force: true });
    }

    // uygulamanın içinden düzeltme: PUT /api/file ile pp.config.json
    fs.writeFileSync(ppFile(mk), 'garip{');
    let r = await call('GET', '/api/file?path=pp.config.json');
    assert.equal(r.status, 200); assert.equal(r.data.raw, 'garip{');
    r = await call('PUT', '/api/file', { path: 'pp.config.json', raw: good });
    assert.equal(r.status, 200);
    r = await call('GET', '/api/info');
    assert.ok(!issueCodes(r).includes('ppConfigBozuk'), 'uyarı kalktı');
    r = await call('POST', '/api/package', { name: 'yeni-plugin', description: 'yeni' });
    assert.equal(r.status, 200, r.text);
    const cfg = JSON.parse(fs.readFileSync(ppFile(mk), 'utf8'));
    assert.equal(cfg.marketplace.version, '2.5.0'); assert.equal(cfg.packages.eski.description, 'ESKİ PAKET');
    assert.equal(cfg.packages['yeni-plugin'].description, 'yeni');
    assert.ok(fs.existsSync(path.join(mk, 'prompts', 'yeni-plugin')));
  });
});

test('B-01: tipi yanlış export alanı yalnızca uyarıdır (info/status 200, yazan rotalar engellenmez)', real, async () => {
  await withServer(async ({ call, mk }) => {
    // "durumlar" dizi yerine metin: etkin ayar varsayılana ('kararlı' + boş durum) döner, ama kullanıcı uyarılır
    fs.writeFileSync(ppFile(mk), '{"export":{"durumlar":"kararlı"}}');
    let r = await call('GET', '/api/info');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.setup.ok, true);
    const i = r.data.setup.issues.filter((x) => x.code === 'exportAlanGecersiz');
    assert.equal(i.length, 1, JSON.stringify(r.data.setup.issues));
    assert.equal(i[0].level, 'warn');
    assert.match(i[0].message, /^pp\.config\.json içindeki "export\.durumlar" dizi olmalı \(şu an: metin\)/);
    assert.ok(!issueCodes(r).includes('ppConfigBozuk'), 'dosya bozuk sayılmaz');
    assert.deepEqual(r.data.config.export, { durumlar: ['kararlı', ''], haricKlasorler: ['gelen-kutusu'] });
    for (const u of ['/api/tree', '/api/facets', '/api/search?q=x']) assert.equal((await call('GET', u)).status, 200, u);
    r = await call('GET', '/api/marketplace/status');
    assert.equal(r.status, 200, r.text);
    assert.ok(r.data.configIssues.some((x) => x.code === 'exportAlanGecersiz'), 'configIssues');
    assert.deepEqual(r.data.export.durumlar, ['kararlı', '']);

    // yazan rotalar ENGELLENMEZ (409 yok); yalnızca ppConfigBozuk/libraryDirGecersiz engeller
    r = await call('POST', '/api/package', { name: 'yeni-plugin', description: 'yeni' });
    assert.equal(r.status, 200, r.text);
    assert.ok(fs.existsSync(path.join(mk, 'library', 'yeni-plugin')), 'varsayılan libraryDir (library) kullanıldı');
    assert.equal(JSON.parse(fs.readFileSync(ppFile(mk), 'utf8')).packages['yeni-plugin'].description, 'yeni');
    r = await call('POST', '/api/package', { name: 'ikinci' });
    assert.equal(r.status, 200, r.text);
    r = await call('POST', '/api/marketplace/update', {});
    // (bu rota başka nedenle 409 verebilir, örn. ilk commit yok; önemli olan ayar nedeniyle engellenmemesi)
    assert.ok(!['ppConfigBozuk', 'libraryDirGecersiz', 'exportAlanGecersiz'].includes(r.data && r.data.code), r.text);

    // nesne olmayan export da aynı: uyarı var, engel yok
    for (const ex of ['kararlı', 5, null, ['kararlı']]) {
      fs.writeFileSync(ppFile(mk), JSON.stringify({ libraryDir: 'prompts', export: ex }));
      r = await call('GET', '/api/info');
      assert.equal(r.status, 200, JSON.stringify(ex));
      assert.deepEqual(issueCodes(r), ['exportAlanGecersiz'], JSON.stringify(ex));
      assert.deepEqual(r.data.config.export.durumlar, ['kararlı', '']);
      r = await call('POST', '/api/package', { name: 'p-' + (typeof ex) + (Array.isArray(ex) ? '-dizi' : ''), description: 'x' });
      assert.equal(r.status, 200, `${JSON.stringify(ex)}: ${r.text}`);
    }

    // düzeltilince uyarı kalkar
    fs.writeFileSync(ppFile(mk), JSON.stringify({ libraryDir: 'prompts', export: { durumlar: ['kararlı'], haricKlasorler: ['gelen-kutusu'] } }));
    r = await call('GET', '/api/info');
    assert.deepEqual(issueCodes(r), []);
    assert.deepEqual(r.data.config.export.durumlar, ['kararlı']);
  });
});

test('B-01: pp.config.json BOM ile başlıyorsa okunur, yazma çalışır', real, async () => {
  await withServer(async ({ call, mk }) => {
    fs.writeFileSync(ppFile(mk), '\uFEFF' + JSON.stringify({ libraryDir: 'prompts', marketplace: { name: 'mk', version: '3.1.0' } }));
    let r = await call('GET', '/api/info');
    assert.ok(!issueCodes(r).includes('ppConfigBozuk'));
    assert.equal(r.data.config.marketplace.version, '3.1.0');
    r = await call('POST', '/api/package', { name: 'p1', description: 'a' });
    assert.equal(r.status, 200, r.text);
  });
});

test('B-02: libraryDir doğrulanır: kök dışı, mutlak, boş -> uyarı + library; diske dokunulmaz', real, async () => {
  await withServer(async ({ call, mk, tmp }) => {
    const outside = path.join(tmp, 'disari');
    put(path.join(outside, 'gizli.md'), '---\nbaslik: Gizli\n---\nDISARI-GIZLI');
    const before = fs.readdirSync(tmp).sort();
    for (const v of ['../../yeni_dis', '../../disari', 'C:\\Windows', '/etc', '', '.git']) {
      fs.writeFileSync(ppFile(mk), JSON.stringify({ libraryDir: v, marketplace: { name: 'mk' } }));
      let r = await call('GET', '/api/tree');
      assert.equal(r.status, 200, JSON.stringify(v) + r.text);
      assert.ok(!JSON.stringify(r.data).includes('gizli.md'), 'kök dışı dosya ağaçta yok');
      r = await call('GET', '/api/info');
      assert.equal(r.status, 200);
      assert.ok(issueCodes(r).includes('libraryDirGecersiz'), JSON.stringify(v));
      assert.equal(r.data.config.libraryDir, 'library');
      r = await call('GET', '/api/search?q=DISARI-GIZLI');
      assert.equal(r.status, 200); assert.deepEqual(r.data.results, []);
      assert.equal((await call('GET', '/api/facets')).status, 200);
      assert.deepEqual(fs.readdirSync(tmp).sort(), before, 'kök dışında hiçbir klasör oluşmadı');
      assert.equal(fs.existsSync(path.join(mk, 'library')), false);
      // yazan rota 409 libraryDirGecersiz
      r = await call('POST', '/api/package', { name: 'x', description: 'y' });
      assert.equal(r.status, 409, r.text); assert.equal(r.data.code, 'libraryDirGecersiz');
    }
    assert.equal(fs.readFileSync(path.join(outside, 'gizli.md'), 'utf8').includes('DISARI-GIZLI'), true);

    // normalize edilen geçerli biçimler sorunsuz çalışır
    for (const v of ['./prompts', 'prompts/', 'prompts', '.\\prompts\\']) {
      fs.writeFileSync(ppFile(mk), JSON.stringify({ libraryDir: v, marketplace: { name: 'mk' } }));
      put(path.join(mk, 'prompts', 'p', 'a.md'), '---\nbaslik: Normal\n---\nNORMAL-ICERIK');
      let r = await call('GET', '/api/info');
      assert.ok(!issueCodes(r).includes('libraryDirGecersiz'), v);
      assert.equal(r.data.config.libraryDir, 'prompts');
      r = await call('GET', '/api/search?q=NORMAL-ICERIK');
      assert.equal(r.data.results.length, 1, v);
    }
    // anahtar yoksa library ve uyarı yok
    fs.writeFileSync(ppFile(mk), JSON.stringify({ marketplace: { name: 'mk' } }));
    const r = await call('GET', '/api/info');
    assert.ok(!issueCodes(r).includes('libraryDirGecersiz')); assert.equal(r.data.config.libraryDir, 'library');
  });
});

test('B-02: prompts kök dışına junction ise geçersiz sayılır', real, async (t) => {
  await withServer(async ({ call, mk, tmp, links }) => {
    const outside = path.join(tmp, 'dis-lib');
    put(path.join(outside, 'x', 'gizli.md'), 'DISARI-GIZLI');
    fs.rmSync(path.join(mk, 'prompts'), { recursive: true, force: true });
    if (!makeLink(outside, path.join(mk, 'prompts'))) return t.skip('bağlantı kurulamadı (EPERM)');
    links.push(path.join(mk, 'prompts'));
    let r = await call('GET', '/api/info');
    assert.ok(issueCodes(r).includes('libraryDirGecersiz'));
    assert.equal(r.data.config.libraryDir, 'library');
    r = await call('GET', '/api/search?q=DISARI-GIZLI');
    assert.deepEqual(r.data.results, []);
    r = await call('GET', '/api/tree');
    assert.equal(r.status, 200);
    assert.equal(fs.existsSync(path.join(mk, 'library')), false);
  });
});

test('B-03: kök dışı junction üzerinden GET/PUT/POST/DELETE/rename hepsi 400; dış dosya değişmez', real, async (t) => {
  await withServer(async ({ call, mk, tmp, links }) => {
    const outside = path.join(tmp, 'dis');
    put(path.join(outside, 'gizli.md'), 'DIS-ICERIK');
    put(path.join(mk, 'prompts', 'p', 'a.md'), '---\nbaslik: A\n---\ngovde ICERIK-A');
    const link = path.join(mk, 'prompts', 'kisayol');
    if (!makeLink(outside, link)) return t.skip('bağlantı kurulamadı (EPERM)');
    links.push(link);
    const reqs = [
      ['GET', '/api/file?path=prompts/kisayol/gizli.md'],
      ['PUT', '/api/file', { path: 'prompts/kisayol/gizli.md', raw: 'DEGISTI' }],
      ['POST', '/api/file', { path: 'prompts/kisayol/yeni-dis.md', raw: 'x' }],
      ['POST', '/api/file', { path: 'prompts/kisayol/alt/derin.md', raw: 'x' }],
      ['DELETE', '/api/file?path=prompts/kisayol/gizli.md'],
      ['DELETE', '/api/file?path=prompts/kisayol'],
      ['POST', '/api/mkdir', { path: 'prompts/kisayol/yeni-klasor' }],
      ['POST', '/api/rename', { from: 'prompts/kisayol/gizli.md', to: 'prompts/p/c.md' }],
      ['POST', '/api/rename', { from: 'prompts/p/a.md', to: 'prompts/kisayol/tasindi.md' }],
      ['GET', '/api/git/log?path=prompts/kisayol/gizli.md'],
      ['GET', '/api/history/versions?path=prompts/kisayol/gizli.md']
    ];
    for (const [m, u, b] of reqs) {
      const r = await call(m, u, b);
      assert.equal(r.status, 400, `${m} ${u}: ${r.text}`);
      assert.match(r.data.error, /^Geçersiz yol/);
      assert.ok(!r.text.includes(tmp), 'yanıtta mutlak yol yok');
    }
    assert.equal(fs.readFileSync(path.join(outside, 'gizli.md'), 'utf8'), 'DIS-ICERIK', 'dış dosya değişmedi');
    assert.deepEqual(fs.readdirSync(outside), ['gizli.md'], 'dışarıda dosya/klasör oluşmadı');
    assert.ok(fs.existsSync(path.join(mk, 'prompts', 'p', 'a.md')), 'kaynak taşınmadı');

    // ağaçta ve aramada bağlantı görünmez
    let r = await call('GET', '/api/tree');
    assert.ok(!JSON.stringify(r.data).includes('kisayol'), 'ağaçta bağlantı yok');
    assert.ok(!JSON.stringify(r.data).includes('gizli.md'));
    r = await call('GET', '/api/search?q=DIS-ICERIK');
    assert.deepEqual(r.data.results, []);
    assert.equal((await call('GET', '/api/search?q=ICERIK-A')).data.results.length, 1);
  });
});

test('B-03: kök içine işaret eden bağlantı 200; kırık bağlantı 400', real, async (t) => {
  await withServer(async ({ call, mk, tmp, links }) => {
    put(path.join(mk, 'prompts', 'p', 'a.md'), 'ICERIK-A');
    const inner = path.join(mk, 'prompts', 'ic');
    if (!makeLink(path.join(mk, 'prompts', 'p'), inner)) return t.skip('bağlantı kurulamadı (EPERM)');
    links.push(inner);
    let r = await call('GET', '/api/file?path=prompts/ic/a.md');
    assert.equal(r.status, 200); assert.equal(r.data.raw, 'ICERIK-A');
    r = await call('PUT', '/api/file', { path: 'prompts/ic/a.md', raw: 'YENI' });
    assert.equal(r.status, 200);
    assert.equal(fs.readFileSync(path.join(mk, 'prompts', 'p', 'a.md'), 'utf8'), 'YENI');
    // kırık bağlantı
    const gone = path.join(tmp, 'gidecek'); fs.mkdirSync(gone);
    const broken = path.join(mk, 'prompts', 'kirik');
    assert.ok(makeLink(gone, broken)); links.push(broken);
    fs.rmdirSync(gone);
    r = await call('POST', '/api/file', { path: 'prompts/kirik/yeni.md', raw: 'x' });
    assert.equal(r.status, 400, r.text);
    assert.equal(fs.existsSync(gone), false, 'bağlantı hedefi oluşturulmadı');
  });
});

test('B-04: .git varyantları GET/PUT/POST/DELETE 403; depo yerinde kalır', real, async () => {
  await withServer(async ({ call, mk }) => {
    for (const p of ['.git/config', '.GIT/config', '.Git/HEAD', '.git.', '.git /x', 'a/.GIT/x', '.GIT']) {
      const enc = encodeURIComponent(p);
      for (const [m, u, b] of [['GET', '/api/file?path=' + enc], ['PUT', '/api/file', { path: p, raw: 'x' }], ['POST', '/api/file', { path: p + '/yazildi.md', raw: 'x' }],
        ['DELETE', '/api/file?path=' + enc], ['POST', '/api/mkdir', { path: p + '/k' }], ['POST', '/api/rename', { from: p, to: 'baska' }]]) {
        const r = await call(m, u, b);
        assert.equal(r.status, 403, `${m} ${p}: ${r.text}`);
        assert.equal(r.data.error, '.git klasörüne erişim yok');
      }
    }
    assert.ok(fs.existsSync(path.join(mk, '.git', 'HEAD')), 'depo yerinde');
    assert.equal(fs.existsSync(path.join(mk, '.git', 'yazildi.md')), false);
    assert.equal(fs.existsSync(path.join(mk, '.pp')), false, 'çöp kutusu oluşmadı');
    assert.equal((await call('GET', '/api/git/status')).status, 200, 'depo bozulmadı');
  });
});

test('B-05: yapı dosyaları silinemez/taşınamaz (403 korunanYol); içerikleri silinebilir', real, async () => {
  await withServer(async ({ call, mk }) => {
    put(path.join(mk, 'plugins', 'mk', 'commands', 'a.md'), 'x');
    put(path.join(mk, '.pp', 'ozel.txt'), 'x');
    put(path.join(mk, 'prompts', 'x', 'a.md'), 'x');
    for (const p of ['prompts', 'Prompts', 'PROMPTS', 'pp.config.json', 'PP.CONFIG.JSON', 'plugins', '.claude-plugin', '.gitignore', '.gitattributes', '.pp', '.pp/ozel.txt']) {
      const r = await call('DELETE', '/api/file?path=' + encodeURIComponent(p));
      assert.equal(r.status, 403, `${p}: ${r.text}`);
      assert.equal(r.data.code, 'korunanYol');
      assert.equal(r.data.error, 'Bu yol marketplace yapısının parçası; silinemez veya taşınamaz');
    }
    for (const p of ['prompts', 'pp.config.json', 'plugins', '.claude-plugin']) assert.ok(fs.existsSync(path.join(mk, p)), p + ' yerinde');
    assert.ok(fs.existsSync(path.join(mk, '.pp', 'ozel.txt')));
    assert.equal(fs.existsSync(path.join(mk, '.pp', 'trash')), false, 'çöp kutusuna bir şey taşınmadı');
    let r = await call('POST', '/api/rename', { from: 'prompts', to: 'x' });
    assert.equal(r.status, 403); assert.equal(r.data.code, 'korunanYol');
    r = await call('POST', '/api/rename', { from: 'pp.config.json', to: 'baska.json' });
    assert.equal(r.status, 403);
    assert.ok(fs.existsSync(path.join(mk, 'prompts')) && !fs.existsSync(path.join(mk, 'x')));
    // içerikleri silinebilir
    r = await call('DELETE', '/api/file?path=prompts/x/a.md');
    assert.equal(r.status, 200, r.text);
    r = await call('DELETE', '/api/file?path=plugins/mk/commands/a.md');
    assert.equal(r.status, 200, r.text);
    r = await call('DELETE', '/api/file?path=plugins/mk');
    assert.equal(r.status, 200, r.text);
    // iç içe libraryDir: üst klasör de korunur
    fs.writeFileSync(ppFile(mk), JSON.stringify({ libraryDir: 'a/b', marketplace: { name: 'mk' } }));
    put(path.join(mk, 'a', 'b', 'p.md'), 'x');
    for (const p of ['a', 'a/b']) assert.equal((await call('DELETE', '/api/file?path=' + encodeURIComponent(p))).status, 403, p);
    assert.equal((await call('DELETE', '/api/file?path=a/b/p.md')).status, 200);
  });
});

test('B-11: null/[]/"str"/5 gövde 8 rotada 400 Türkçe ileti; günlükte TypeError yok', real, async () => {
  await withServer(async ({ call, srv }) => {
    const routes = [['PUT', '/api/file'], ['POST', '/api/file'], ['POST', '/api/rename'], ['POST', '/api/package'], ['POST', '/api/git/commit'],
      ['POST', '/api/version/bump'], ['POST', '/api/marketplaces'], ['PUT', '/api/settings']];
    for (const [m, u] of routes) {
      for (const raw of ['null', '[]', '"str"', '5', 'true', '[1,2]']) {
        const r = await call(m, u, undefined, { raw });
        assert.equal(r.status, 400, `${m} ${u} ${raw}: ${r.text}`);
        assert.equal(r.data.error, 'İstek gövdesi bir JSON nesnesi olmalı');
      }
      const bad = await call(m, u, undefined, { raw: '{bozuk' });
      assert.equal(bad.status, 400); assert.equal(bad.data.error, 'Geçersiz JSON');
    }
    // boş gövde hâlâ {} sayılır (ilgili rota kendi doğrulamasını yapar, 500 değil)
    const empty = await call('POST', '/api/file', undefined);
    assert.equal(empty.status, 400); assert.equal(empty.data.error, 'Yol gerekli');
    assert.ok(!/TypeError/.test(srv.logs().err), 'günlükte TypeError yok: ' + srv.logs().err);
  });
});

test('B-12: uzun dosya adı: 190 karakter tamam, 250 karakter 400 (yolsuz); var olan 230 baytlık dosya PUT ile kaydedilir', real, async () => {
  await withServer(async ({ call, mk, tmp }) => {
    const ok = 'c'.repeat(187) + '.md'; // 190 karakter
    let r = await call('POST', '/api/file', { path: 'prompts/p/' + ok, raw: 'uzun' });
    assert.equal(r.status, 200, r.text);
    assert.equal(fs.readFileSync(path.join(mk, 'prompts', 'p', ok), 'utf8'), 'uzun');
    r = await call('POST', '/api/file', { path: 'prompts/p/' + 'c'.repeat(247) + '.md', raw: 'x' });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.data.error, 'Ad en çok 200 bayt olabilir');
    assert.ok(!r.text.includes(tmp) && !r.text.includes('ENOENT'), 'yanıtta yol yok');
    r = await call('POST', '/api/file', { path: 'prompts/p/' + 'ş'.repeat(101) + '.md', raw: 'x' });
    assert.equal(r.status, 400, 'bayt sayılır');
    r = await call('POST', '/api/file', { path: 'prompts/' + 'k'.repeat(250) + '/a.md', raw: 'x' });
    assert.equal(r.status, 400, 'uzun klasör adı da');
    r = await call('POST', '/api/file', { path: 'prompts/p/' + ok, raw: 'x', unique: true });
    assert.equal(r.status, 200, 'unique sonrası da sınırın içinde');
    // var olan uzun adlı dosya okunur ve kaydedilir (sınır yalnızca yeni adlar için)
    const long = 'u'.repeat(227) + '.md';
    put(path.join(mk, 'prompts', 'p', long), 'eski');
    r = await call('GET', '/api/file?path=' + encodeURIComponent('prompts/p/' + long));
    assert.equal(r.status, 200); assert.equal(r.data.raw, 'eski');
    r = await call('PUT', '/api/file', { path: 'prompts/p/' + long, raw: 'yeni' });
    assert.equal(r.status, 200, r.text);
    assert.equal(fs.readFileSync(path.join(mk, 'prompts', 'p', long), 'utf8'), 'yeni');
    assert.ok(!fs.readdirSync(path.join(mk, 'prompts', 'p')).some((n) => n.endsWith('.pp-tmp')), 'geçici dosya kalmadı');
  });
});

test('B-12: yazma hatasında geçici dosya silinir ve ham fs hatası yolsuz, Türkçe iletiye çevrilir (E8)', real, async () => {
  await withServer(async ({ call, mk, tmp, srv }) => {
    fs.mkdirSync(path.join(mk, 'prompts', 'dizin.md')); // dosya yerine klasör: rename başarısız olur
    const r = await call('PUT', '/api/file', { path: 'prompts/dizin.md', raw: 'x' });
    assert.equal(r.status, 500, r.text);
    assert.match(r.data.error, /^[^:]+ \(E[A-Z]+\)$/, r.text);
    assert.ok(!r.text.includes(tmp) && !r.text.includes('rename') && !r.text.includes(mk), 'yolsuz: ' + r.text);
    assert.ok(!fs.readdirSync(path.join(mk, 'prompts')).some((n) => n.endsWith('.pp-tmp')), 'geçici dosya silindi');
    assert.match(srv.logs().err, /E[A-Z]+/, 'tam hata günlüğe yazıldı');
  });
});

test('B-06 (dosya adı): aygıt adları ve yasak adlar 400; içe aktarmada atlanır', real, async () => {
  await withServer(async ({ call, mk, tmp }) => {
    for (const p of ['prompts/p/CON.md', 'prompts/p/nul.md', 'prompts/p/Com1.md', 'prompts/p/lpt9.md', 'prompts/AUX/a.md', 'prompts/p/x.', 'prompts/p/a?b.md', 'prompts/p/a<b.md']) {
      const r = await call('POST', '/api/file', { path: p, raw: 'x' });
      assert.equal(r.status, 400, `${p}: ${r.text}`);
    }
    assert.match((await call('POST', '/api/file', { path: 'prompts/p/CON.md', raw: 'x' })).data.error, /Windows aygıt adı/);
    assert.equal(fs.existsSync(path.join(mk, 'prompts', 'p', 'CON.md')), false);
    assert.equal(fs.existsSync(path.join(mk, 'prompts', 'AUX')), false);
    // normal ad
    assert.equal((await call('POST', '/api/file', { path: 'prompts/p/normal.md', raw: 'x' })).status, 200);
    // rename hedefi
    let r = await call('POST', '/api/rename', { from: 'prompts/p/normal.md', to: 'prompts/p/CON.md' });
    assert.equal(r.status, 400, r.text);
    assert.ok(fs.existsSync(path.join(mk, 'prompts', 'p', 'normal.md')));
    r = await call('POST', '/api/rename', { from: 'prompts/p/normal.md', to: 'prompts/p/yeni-ad.md' });
    assert.equal(r.status, 200, r.text);
    // mkdir
    r = await call('POST', '/api/mkdir', { path: 'prompts/NUL' });
    assert.equal(r.status, 400);
    assert.equal(fs.existsSync(path.join(mk, 'prompts', 'NUL')), false);
    // içe aktarma: aygıt adlı dosya atlanır
    const src = path.join(tmp, 'ice'); fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'con.txt'), 'icerik bir');
    fs.writeFileSync(path.join(src, 'normal.txt'), 'icerik iki');
    r = await call('POST', '/api/import/run', { dir: src, files: [path.join(src, 'con.txt'), path.join(src, 'normal.txt')] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.created.length, 1); assert.match(r.data.created[0].to, /normal\.md$/);
    assert.equal(r.data.skipped.length, 1); assert.match(r.data.skipped[0].reason, /Windows aygıt adı/);
  });
});

test('B-03 (transfer): hedef plugin kök dışına bağlıysa 400; hedef ayarı bozuksa 409; normal taşıma çalışır', real, async (t) => {
  await withServer(async ({ call, mk, lib, tmp, links }) => {
    let r = await call('POST', '/api/marketplaces', { name: 'hedef', activate: false });
    assert.equal(r.status, 200, r.text);
    const hedef = path.join(lib, 'hedef');
    fs.mkdirSync(path.join(hedef, 'prompts', 'plug'), { recursive: true });
    put(path.join(mk, 'prompts', 'p', 'a.md'), '---\nbaslik: A\n---\ngovde');
    put(path.join(mk, 'prompts', 'p', 'b.md'), '---\nbaslik: B\n---\ngovde');
    // 1) normal
    r = await call('POST', '/api/prompts/transfer', { path: 'prompts/p/a.md', toMp: 'hedef', toPlugin: 'plug' });
    assert.equal(r.status, 200, r.text);
    assert.ok(fs.existsSync(path.join(hedef, 'prompts', 'plug', 'a.md')));
    // 2) hedef ayarı bozuk
    fs.writeFileSync(ppFile(hedef), 'garip{');
    r = await call('POST', '/api/prompts/transfer', { path: 'prompts/p/b.md', toMp: 'hedef', toPlugin: 'plug' });
    assert.equal(r.status, 409, r.text); assert.equal(r.data.code, 'ppConfigBozuk');
    assert.ok(fs.existsSync(path.join(mk, 'prompts', 'p', 'b.md')), 'kaynak yerinde');
    assert.equal(fs.readFileSync(ppFile(hedef), 'utf8'), 'garip{');
    fs.writeFileSync(ppFile(hedef), JSON.stringify({ libraryDir: 'prompts', marketplace: { name: 'hedef' } }));
    // 3) hedef plugin klasörü kök dışına junction
    const outside = path.join(tmp, 'dis-hedef'); fs.mkdirSync(outside);
    const link = path.join(hedef, 'prompts', 'dis');
    if (!makeLink(outside, link)) return t.skip('bağlantı kurulamadı (EPERM)');
    links.push(link);
    r = await call('POST', '/api/prompts/transfer', { path: 'prompts/p/b.md', toMp: 'hedef', toPlugin: 'dis' });
    assert.equal(r.status, 400, r.text);
    assert.deepEqual(fs.readdirSync(outside), [], 'dışarıya yazılmadı');
    assert.ok(fs.existsSync(path.join(mk, 'prompts', 'p', 'b.md')), 'kaynak yerinde');
  });
});

test('B-03 (yayın): plugins/ ve .claude-plugin/ kök dışına bağlıysa yayın ve init 400, dışarıya yazılmaz', real, async (t) => {
  await withServer(async ({ call, mk, tmp, links }) => {
    const outside = path.join(tmp, 'dis-plugins'); fs.mkdirSync(outside);
    const outside2 = path.join(tmp, 'dis-claude'); fs.mkdirSync(outside2);
    put(path.join(mk, 'prompts', 'ornek', 'a.md'), '---\nbaslik: A\ntur: komut\nkomut_adi: a\n---\ngovde');
    const link = path.join(mk, 'plugins');
    if (!makeLink(outside, link)) return t.skip('bağlantı kurulamadı (EPERM)');
    links.push(link);
    let r = await call('POST', '/api/package/publish', { name: 'ornek' });
    assert.equal(r.status, 400, r.text); assert.match(r.data.error, /^Geçersiz yol/);
    r = await call('POST', '/api/marketplace/update', {});
    assert.equal(r.status, 400, r.text);
    r = await call('POST', '/api/marketplace/publish', { all: true });
    assert.equal(r.status, 400, r.text);
    assert.deepEqual(fs.readdirSync(outside), [], 'plugins bağlantısı üzerinden yazılmadı');
    removeLink(link);
    // .claude-plugin
    fs.rmSync(path.join(mk, '.claude-plugin'), { recursive: true, force: true });
    const link2 = path.join(mk, '.claude-plugin');
    assert.ok(makeLink(outside2, link2)); links.push(link2);
    r = await call('POST', '/api/marketplace/init', {});
    assert.equal(r.status, 400, r.text);
    assert.deepEqual(fs.readdirSync(outside2), [], '.claude-plugin bağlantısı üzerinden yazılmadı');
  }, { commit: true });
});

test('E1: GET /api/tree bozuk ayarda marketplace içinde library/ açmaz; sağlam ayarda libraryDir açılır', real, async () => {
  await withServer(async ({ call, mk }) => {
    fs.rmSync(path.join(mk, 'prompts'), { recursive: true, force: true });
    fs.writeFileSync(ppFile(mk), JSON.stringify({ libraryDir: 'icerik/promptlar', marketplace: { name: 'mk' } }));
    assert.equal((await call('GET', '/api/tree')).status, 200);
    assert.ok(fs.existsSync(path.join(mk, 'icerik', 'promptlar')), 'geçerli libraryDir açıldı');
    fs.writeFileSync(ppFile(mk), '[]');
    assert.equal((await call('GET', '/api/tree')).status, 200);
    assert.equal(fs.existsSync(path.join(mk, 'library')), false);
  });
});

test('B-06: marketplace/plugin adı olarak aygıt adları ve sondaki nokta 400, ham git hatası yok, diskte klasör yok', real, async () => {
  await withServer(async ({ call, lib }) => {
    const before = fs.readdirSync(lib).sort();
    for (const name of ['CON', 'nul', 'aux', 'com1', 'lpt1', 'prn', 'ok.', 'x.']) {
      const r = await call('POST', '/api/marketplaces', { name });
      assert.equal(r.status, 400, `${name}: ${r.text}`);
      assert.ok(!/fatal|error:/i.test(r.data.error), r.data.error);
      assert.match(r.data.error, /Windows aygıt adı|nokta ile bitemez/);
    }
    assert.deepEqual(fs.readdirSync(lib).sort(), before, 'diskte klasör yok');
    assert.equal((await call('POST', '/api/marketplaces/clone', { url: 'o/con' })).status, 400);
    for (const name of ['CON', 'nul', 'Com1']) {
      const r = await call('POST', '/api/package', { name, description: 'x' });
      assert.equal(r.status, 400, `${name}: ${r.text}`);
      assert.match(r.data.error, /Windows aygıt adı/);
    }
  });
});

test('B-06: komut_adi CON olan prompt: paket sayfasında aygitAdi (error); yayın 400 dogrulama, ağaç temiz, etiket yok', real, async () => {
  const { sh } = require('./helpers');
  await withServer(async ({ call, mk, tmp, srv }) => {
    const { gitEnv } = require('./helpers');
    put(path.join(mk, 'prompts', 'norm', 'konsol.md'), '---\nbaslik: Konsol\ntur: komut\nkomut_adi: CON\n---\ngovde');
    put(path.join(mk, 'prompts', 'norm', 'iyi.md'), '---\nbaslik: Iyi\ntur: komut\nkomut_adi: iyi\n---\ngovde');
    const env = gitEnv(tmp);
    sh(mk, ['add', '-A'], env); sh(mk, ['commit', '-q', '-m', 'icerik'], env);
    let r = await call('GET', '/api/package?name=norm');
    assert.equal(r.status, 200, r.text);
    assert.ok(r.data.issues.some((i) => i.code === 'aygitAdi' && i.level === 'error'), JSON.stringify(r.data.issues));
    assert.equal(r.data.blocking, 1);
    r = await call('GET', '/api/file?path=prompts/norm/konsol.md');
    assert.equal(r.data.publishCheck.code, 'aygitAdi'); assert.equal(r.data.publishCheck.level, 'error');
    const head = sh(mk, ['rev-parse', 'HEAD'], env).trim();
    r = await call('POST', '/api/package/publish', { name: 'norm' });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.data.code, 'dogrulama');
    assert.ok(r.data.issues.some((i) => i.code === 'aygitAdi'));
    assert.equal(sh(mk, ['status', '--porcelain'], env).trim(), '', 'ağaç temiz');
    assert.equal(sh(mk, ['rev-parse', 'HEAD'], env).trim(), head);
    assert.equal(sh(mk, ['tag', '-l'], env).trim(), '', 'etiket yok');
    assert.equal(fs.existsSync(path.join(mk, 'plugins', 'norm')), false);
    assert.ok(!/at |Error/.test(srv.logs().err), 'günlükte yığın izi yok: ' + srv.logs().err);
  });
});

test('B-13: sürüm +1 çok büyük bileşenlerde 400, dosya/etiket/commit değişmez; 1e+21 yazılmaz', real, async () => {
  const { sh, gitEnv } = require('./helpers');
  await withServer(async ({ call, mk, tmp }) => {
    const env = gitEnv(tmp);
    const file = path.join(mk, 'prompts', 'p.md');
    for (const [v, level, re] of [['9007199254740993.0.0', 'yama', /yorumlanamadı/], ['1000000000000000000000.0.0', 'yama', /yorumlanamadı/], ['1e+21.0.0', 'yama', /yorumlanamadı/],
      ['99999999999.1.1', 'buyuk', /yorumlanamadı/], ['999999999.0.0', 'buyuk', /üst sınıra ulaştı/]]) {
      fs.writeFileSync(file, '---\nbaslik: P\nversiyon: ' + v + '\n---\ngovde\n');
      sh(mk, ['add', '-A'], env); sh(mk, ['commit', '-q', '-m', 'x ' + v], env);
      const head = sh(mk, ['rev-parse', 'HEAD'], env).trim(); const bytes = fs.readFileSync(file);
      const r = await call('POST', '/api/version/bump', { path: 'prompts/p.md', level, note: 'not' });
      assert.equal(r.status, 400, `${v}: ${r.text}`);
      assert.match(r.data.error, re, v);
      assert.equal(r.data.field, 'versiyon');
      assert.deepEqual(fs.readFileSync(file), bytes, 'dosya değişmedi');
      assert.equal(sh(mk, ['rev-parse', 'HEAD'], env).trim(), head, 'commit değişmedi');
      assert.equal(sh(mk, ['tag', '-l'], env).trim(), '', 'etiket yok');
    }
    assert.ok(!/e\+21/.test(fs.readFileSync(file, 'utf8').replace('1e+21.0.0', '')));
  });
});

test('B-18: uzak depo adresi 2048 karakterden uzunsa 400 urlGecersiz (remotes ve clone); 500 ve ENAMETOOLONG yok', real, async () => {
  await withServer(async ({ call, srv }) => {
    for (const n of [3025, 100025]) {
      const url = 'https://github.com/o/' + 'x'.repeat(n);
      for (const [m, u, b] of [['POST', '/api/git/remotes', { name: 'origin', url }], ['PUT', '/api/git/remotes', { name: 'origin', url }],
        ['POST', '/api/marketplaces/clone', { url }]]) {
        const r = await call(m, u, b);
        assert.equal(r.status, 400, `${m} ${u} ${n}: ${r.text.slice(0, 200)}`);
        assert.equal(r.data.code, 'urlGecersiz');
        assert.equal(r.data.error, 'URL en çok 2048 karakter olabilir');
      }
    }
    const r = await call('GET', '/api/git/remotes');
    assert.equal(r.status, 200); assert.deepEqual(r.data.remotes || [], [], 'uzak depo kaydedilmedi');
    assert.ok(!/ENAMETOOLONG/.test(srv.logs().err), 'günlükte spawn hatası yok');
  });
});

/* ===== İkinci bölüm (adım 8): B-19 BOM, B-16 git hata eşleme, B-15 ayrık HEAD, B-20 arama sınırı ===== */

const { sh, gitEnv } = require('./helpers');

const BOM = [0xEF, 0xBB, 0xBF];
const startsWithBom = (f) => BOM.every((b, i) => fs.readFileSync(f)[i] === b);
const commitAllIn = (mk, tmp, msg = 'x') => { const env = gitEnv(tmp); sh(mk, ['add', '-A'], env); sh(mk, ['commit', '-q', '-m', msg], env); };
const norm = (x) => String(x).replace(/\\/g, '/').toLowerCase();

test('B-19: BOM\'lu dosya GET ile \\uFEFF başlar; PUT sonrası ilk 3 bayt EF BB BF kalır, fark yalnızca değişen satır; +1 sonrası da BOM durur', real, async () => {
  await withServer(async ({ call, mk, tmp }) => {
    const env = gitEnv(tmp);
    const rel = 'prompts/p/bom.md';
    const f = path.join(mk, ...rel.split('/'));
    const src = '---\nbaslik: Bom\netiketler: [a, b]\n---\nGövde ÇĞİ\nikinci satır\n';
    put(f, Buffer.concat([Buffer.from(BOM), Buffer.from(src, 'utf8')]));
    commitAllIn(mk, tmp, 'bom');

    let r = await call('GET', '/api/file?path=' + rel);
    assert.equal(r.status, 200);
    assert.equal(r.data.raw.charCodeAt(0), 0xFEFF, 'GET raw \\uFEFF ile başlar');
    assert.equal(r.data.raw, '﻿' + src);
    // BOM başlık/etiket ayrıştırmasını bozmaz (arama dizini)
    r = await call('GET', '/api/search?q=Bom');
    assert.equal(r.data.results.length, 1); assert.equal(r.data.results[0].baslik, 'Bom'); assert.deepEqual(r.data.results[0].etiketler, ['a', 'b']);

    // etiket ekle ve kaydet (arayüzün yaptığı gibi BOM'lu raw gönderir)
    const edited = '﻿' + src.replace('[a, b]', '[a, b, c]');
    r = await call('PUT', '/api/file', { path: rel, raw: edited });
    assert.equal(r.status, 200, r.text);
    assert.ok(startsWithBom(f), 'PUT sonrası ilk 3 bayt EF BB BF');
    assert.deepEqual(fs.readFileSync(f), Buffer.from(edited, 'utf8'), 'bayt bayt beklenen içerik');
    assert.equal(sh(mk, ['diff', '--numstat'], env).trim(), '1\t1\t' + rel, 'fark yalnızca değişen satır');
    commitAllIn(mk, tmp, 'etiket');

    // +1 sonrası BOM durur, yalnızca versiyon satırı eklenir
    r = await call('POST', '/api/version/bump', { path: rel, level: 'yama', note: 'BOM testi' });
    assert.equal(r.status, 200, r.text);
    assert.ok(startsWithBom(f), '+1 sonrası ilk 3 bayt EF BB BF');
    assert.equal(r.data.raw.charCodeAt(0), 0xFEFF);
    assert.equal(fs.readFileSync(f, 'utf8'), edited.replace('etiketler: [a, b, c]\n', 'etiketler: [a, b, c]\nversiyon: 1.0.0\n'));
    assert.equal(sh(mk, ['diff', '--numstat', 'HEAD~1', 'HEAD'], env).trim(), '1\t0\t' + rel, 'sürüm commit\'inde yalnızca versiyon satırı eklendi');
    assert.match(sh(mk, ['tag', '-l'], env), /prompt\/p\/bom\/v1\.0\.0/);

    // BOM'lu .json teknik dosyası da korunur
    put(path.join(mk, 'notlar.json'), Buffer.concat([Buffer.from(BOM), Buffer.from('{"a": 1}\n')]));
    r = await call('GET', '/api/file?path=notlar.json');
    assert.equal(r.data.raw, '﻿{"a": 1}\n');
    r = await call('PUT', '/api/file', { path: 'notlar.json', raw: r.data.raw.replace('1', '2') });
    assert.equal(r.status, 200);
    assert.ok(startsWithBom(path.join(mk, 'notlar.json')));
  }, { commit: true });
});

test('B-19: BOM\'suz dosyaya BOM eklenmez; UTF-16 ve windows-1254 dosyalar okunur, UTF-8 (BOM\'suz) kaydedilir', real, async () => {
  await withServer(async ({ call, mk }) => {
    // BOM'suz UTF-8
    const duz = 'prompts/p/duz.md'; const fd = path.join(mk, ...duz.split('/'));
    put(fd, '---\nbaslik: Düz\n---\ngovde\n');
    let r = await call('GET', '/api/file?path=' + duz);
    assert.notEqual(r.data.raw.charCodeAt(0), 0xFEFF); assert.equal(r.data.raw, '---\nbaslik: Düz\n---\ngovde\n');
    r = await call('PUT', '/api/file', { path: duz, raw: r.data.raw.replace('govde', 'yeni govde') });
    assert.equal(r.status, 200);
    assert.deepEqual(fs.readFileSync(fd), Buffer.from('---\nbaslik: Düz\n---\nyeni govde\n', 'utf8'));
    assert.ok(!startsWithBom(fd), 'BOM eklenmedi');
    // yeni dosya
    r = await call('POST', '/api/file', { path: 'prompts/p/yeni.md', raw: '---\nbaslik: Y\n---\nx\n' });
    assert.equal(r.status, 200); assert.ok(!startsWithBom(path.join(mk, 'prompts', 'p', 'yeni.md')));

    // UTF-16LE (BOM'lu): BOM atılır, metin okunur; kaydedilince BOM'suz UTF-8
    const u16 = 'prompts/p/u16.md'; const f16 = path.join(mk, ...u16.split('/'));
    put(f16, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('---\nbaslik: Yaz\n---\nçğışÖÜ\n', 'utf16le')]));
    r = await call('GET', '/api/file?path=' + u16);
    assert.equal(r.status, 200); assert.equal(r.data.raw, '---\nbaslik: Yaz\n---\nçğışÖÜ\n');
    r = await call('PUT', '/api/file', { path: u16, raw: r.data.raw });
    assert.equal(r.status, 200);
    assert.deepEqual(fs.readFileSync(f16), Buffer.from('---\nbaslik: Yaz\n---\nçğışÖÜ\n', 'utf8'));
    // UTF-16BE (BOM'lu)
    const be = path.join(mk, 'prompts', 'p', 'u16be.md');
    const le = Buffer.from('---\nbaslik: BE\n---\nşğ\n', 'utf16le'); le.swap16();
    put(be, Buffer.concat([Buffer.from([0xFE, 0xFF]), le]));
    r = await call('GET', '/api/file?path=prompts/p/u16be.md');
    assert.equal(r.data.raw, '---\nbaslik: BE\n---\nşğ\n');

    // windows-1254 (geçersiz UTF-8): ş=FE ğ=F0 ı=FD
    const w = path.join(mk, 'prompts', 'p', 'ansi.md');
    put(w, Buffer.concat([Buffer.from('---\nbaslik: Eski\n---\n'), Buffer.from([0xFE, 0xF0, 0xFD, 0x0A])]));
    r = await call('GET', '/api/file?path=prompts/p/ansi.md');
    assert.equal(r.data.raw, '---\nbaslik: Eski\n---\nşğı\n');
    r = await call('PUT', '/api/file', { path: 'prompts/p/ansi.md', raw: r.data.raw });
    assert.equal(r.status, 200);
    assert.deepEqual(fs.readFileSync(w), Buffer.from('---\nbaslik: Eski\n---\nşğı\n', 'utf8'));
  });
});

test('B-19: içe aktarmada .txt BOM\'u önizlemeye ve oluşan prompta sızmaz', real, async () => {
  await withServer(async ({ call, mk, tmp }) => {
    const src = path.join(tmp, 'ice'); fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'bomlu.txt'), Buffer.concat([Buffer.from(BOM), Buffer.from('ilk satır\nikinci satır\n')]));
    let r = await call('POST', '/api/import/scan', { dir: src });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.files[0].preview, 'ilk satır');
    r = await call('POST', '/api/import/run', { dir: src, files: [path.join(src, 'bomlu.txt')] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.created.length, 1);
    const out = fs.readFileSync(path.join(mk, ...r.data.created[0].to.split('/')), 'utf8');
    assert.ok(!out.includes('﻿'), 'oluşan prompta BOM girmedi');
    assert.match(out, /\nilk satır\nikinci satır\n/);
  });
});

test('B-16: index.lock varken PUT /api/file + commitMessage ve POST /api/git/commit Türkçe özet verir; gitDetail var, mutlak yol yok', real, async () => {
  await withServer(async ({ call, mk, tmp }) => {
    const rel = 'prompts/p/a.md';
    const f = path.join(mk, ...rel.split('/'));
    put(f, '---\nbaslik: A\n---\nilk\n');
    commitAllIn(mk, tmp, 'ilk');
    const lock = path.join(mk, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    // ham git başlığı ve mutlak yol: yalnızca gitDetail git çıktısını taşır (yolları arındırılmış)
    const noPath = (s, what) => assert.ok(!norm(s).includes(norm(mk)) && !norm(s).includes(norm(tmp)), what + ': mutlak yol yok: ' + s);
    const noRaw = (s, what) => assert.ok(!/fatal:|error:|Unable to create/i.test(s), what + ': ham git başlığı yok: ' + s);

    let r = await call('PUT', '/api/file', { path: rel, raw: '---\nbaslik: A\n---\nKILITLI\n', commitMessage: 'kilit' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.commit, null);
    const ce = r.data.commitError;
    assert.match(ce.error, /^Git şu an başka bir işlemle meşgul ya da yarım kalmış bir kilit dosyası/);
    assert.equal(ce.gitCode, 'kilit');
    noRaw(ce.error, 'error'); noPath(ce.error, 'error');
    assert.match(ce.gitDetail, /Unable to create '<yol>\/\.git\/index\.lock': File exists/, 'gitDetail git çıktısını arındırılmış taşır');
    noPath(ce.gitDetail, 'gitDetail');
    assert.ok(ce.gitDetail.length <= 600);
    assert.equal(ce.needIdentity, undefined);
    assert.ok(fs.readFileSync(f, 'utf8').includes('KILITLI'), 'dosya yine de diske yazıldı');

    // Git paneli
    r = await call('POST', '/api/git/commit', { message: 'kilit', paths: [rel] });
    assert.equal(r.status, 400, r.text);
    assert.match(r.data.error, /^Git şu an başka bir işlemle meşgul/);
    assert.equal(r.data.gitCode, 'kilit'); assert.match(r.data.gitDetail, /index\.lock/);
    noRaw(r.data.error, 'error'); noPath(r.data.error, 'error'); noPath(r.data.gitDetail, 'gitDetail');

    // kilit kalkınca aynı işlemler çalışır
    fs.rmSync(lock);
    r = await call('PUT', '/api/file', { path: rel, raw: '---\nbaslik: A\n---\nKILITSIZ\n', commitMessage: 'kilitsiz' });
    assert.equal(r.status, 200, r.text); assert.equal(r.data.commitError, undefined); assert.match(r.data.commit, /^[0-9a-f]{7,}$/);
    assert.equal(sh(mk, ['status', '--porcelain'], gitEnv(tmp)).trim(), '');
  });
});

test('B-16: commit hook reddinde commitError Türkçe, gitDetail HOOK-RED içerir; hook kalkınca commit atılır', real, async (t) => {
  await withServer(async ({ call, mk, tmp }) => {
    const rel = 'prompts/p/a.md';
    put(path.join(mk, ...rel.split('/')), '---\nbaslik: A\n---\nilk\n');
    commitAllIn(mk, tmp, 'ilk');
    const hook = path.join(mk, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '#!/bin/sh\necho "HOOK-RED: yasak sözcük" >&2\nexit 1\n', { mode: 0o755 });
    let r = await call('PUT', '/api/file', { path: rel, raw: '---\nbaslik: A\n---\nhook\n', commitMessage: 'hook' });
    assert.equal(r.status, 200, r.text);
    if (!r.data.commitError) return t.skip('bu ortamda git hook çalıştırılmıyor');
    const ce = r.data.commitError;
    assert.match(ce.error, /^Git commit'i reddetti/);
    assert.equal(ce.gitCode, 'commitReddedildi');
    assert.match(ce.gitDetail, /HOOK-RED: yasak sözcük/, 'hook çıktısı kaybolmaz');
    assert.ok(!/fatal|error:/i.test(ce.error) && !norm(ce.error).includes(norm(mk)));
    assert.equal(r.data.commit, null);
    assert.equal(sh(mk, ['diff', '--cached', '--name-only'], gitEnv(tmp)).trim(), '', 'başarısız commit dosyayı staged bırakmadı');
    r = await call('POST', '/api/git/commit', { message: 'hook', paths: [rel] });
    assert.equal(r.status, 400); assert.equal(r.data.gitCode, 'commitReddedildi'); assert.match(r.data.gitDetail, /HOOK-RED/);
    fs.rmSync(hook);
    r = await call('POST', '/api/git/commit', { message: 'hook yok', paths: [rel] });
    assert.equal(r.status, 200, r.text); assert.match(r.data.commit, /^[0-9a-f]{7,}$/);
  });
});

test('B-16: kimlik yoksa needIdentity yolu aynen kalır (gitCode/gitDetail eklenmez)', real, async () => {
  await withServer(async ({ call, mk }) => {
    const rel = 'prompts/p/a.md';
    put(path.join(mk, ...rel.split('/')), '---\nbaslik: A\n---\nilk\n');
    let r = await call('PUT', '/api/file', { path: rel, raw: '---\nbaslik: A\n---\nikinci\n', commitMessage: 'kimliksiz' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.data.commitError, { error: 'Git, commit yazarını bilmiyor. Ad ve e-posta gir.', needIdentity: true });
    r = await call('POST', '/api/git/commit', { message: 'kimliksiz', paths: [rel] });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.data.error, 'Git, commit yazarını bilmiyor. Ad ve e-posta gir.'); assert.equal(r.data.needIdentity, true);
    assert.equal(r.data.gitCode, undefined); assert.equal(r.data.gitDetail, undefined);
    assert.equal(fs.readFileSync(path.join(mk, ...rel.split('/')), 'utf8'), '---\nbaslik: A\n---\nikinci\n', 'dosya yine de diske yazıldı');
  }, { identity: false });
});

test('B-15: ayrık HEAD\'de GET /api/git/status branch null, detached true, head kısa hash', real, async () => {
  await withServer(async ({ call, mk, tmp }) => {
    put(path.join(mk, 'prompts', 'a.md'), 'x');
    let r = await call('GET', '/api/git/status');
    assert.equal(r.data.branch, 'main'); assert.equal(r.data.detached, false); assert.equal(r.data.hasCommits, false, 'doğmamış dal: main');
    commitAllIn(mk, tmp, 'ilk');
    r = await call('GET', '/api/git/status');
    assert.equal(r.data.branch, 'main'); assert.equal(r.data.detached, false);
    const env = gitEnv(tmp);
    sh(mk, ['checkout', '-q', '--detach'], env);
    r = await call('GET', '/api/git/status');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.branch, null); assert.equal(r.data.detached, true);
    assert.equal(r.data.head, sh(mk, ['rev-parse', '--short', 'HEAD'], env).trim());
    assert.equal(r.data.hasCommits, true);
  });
});

test('B-20: GET /api/search 305 eşleşmede results 300, total 305, limit 300, truncated true; 300 ve altında false', real, async () => {
  await withServer(async ({ call, mk }) => {
    const body = (i) => `---\nbaslik: Not ${i}\netiketler: [${i % 2 ? 'tek' : 'cift'}]\n---\ngovde ortaksozcuk ${i}\n`;
    for (let i = 0; i < 305; i++) put(path.join(mk, 'prompts', 'p', `n${String(i).padStart(4, '0')}.md`), body(i));
    let r = await call('GET', '/api/search?q=ortaksozcuk');
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.equal(r.data.results.length, 300); assert.equal(r.data.total, 305); assert.equal(r.data.limit, 300); assert.equal(r.data.truncated, true);
    assert.ok(Array.isArray(r.data.results)); assert.equal(typeof r.data.results[0].path, 'string');
    // "Son değişenler" (boş sorgu) yolu: results dizisi aynı biçimde, sayım alanları eklenmiş
    r = await call('GET', '/api/search?q=');
    assert.equal(r.data.results.length, 300); assert.equal(r.data.total, 305); assert.equal(r.data.truncated, true);
    assert.ok(r.data.results.slice(0, 8).every((x) => x.mp && x.path && 'mtime' in x));
    // süzgeçle daralınca kesilme biter
    r = await call('GET', '/api/search?q=&tags=tek');
    assert.equal(r.data.total, 152); assert.equal(r.data.results.length, 152); assert.equal(r.data.truncated, false);
    // tam 300
    for (let i = 300; i < 305; i++) fs.rmSync(path.join(mk, 'prompts', 'p', `n${String(i).padStart(4, '0')}.md`));
    r = await call('GET', '/api/search?q=ortaksozcuk');
    assert.equal(r.data.results.length, 300); assert.equal(r.data.total, 300); assert.equal(r.data.truncated, false);
    // sonuç yok
    r = await call('GET', '/api/search?q=hicbirdeyok');
    assert.deepEqual(r.data, { results: [], total: 0, limit: 300, truncated: false });
  });
});
