'use strict';
/* PackagePublisher: yayın, katalog sürümü, geri alma, push başarısızlığı, kilitler. Gerçek git + yerel bare repo. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { GitService } = require('../lib/git-service');
const { gitAvailable, tmpDir, rmrf, gitEnv, sh, makeBare } = require('./helpers');
const { seed, write, cmd, commitAll, buildStack, snapshot } = require('./stack');

const real = { skip: !gitAvailable && 'git yok' };
const rd = (mk, rel) => fs.readFileSync(path.join(mk, ...rel.split('/')), 'utf8');
const readJson = (mk, rel) => JSON.parse(rd(mk, rel));

async function withBare(s, tmp) {
  const bare = makeBare(tmp);
  await s.git.addRemote(s.mk, 'origin', bare);
  return bare;
}

test('yayın: commit, annotated tag, manifestler, katalog sürümü ve push', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    const s = buildStack(mk, tmp);
    const bare = await withBare(s, tmp);
    const r = await s.publisher.publish(mk, { name: 'ornek', push: true });
    assert.equal(r.ok, true); assert.equal(r.version, '1.0.0'); assert.equal(r.tag, 'paket/ornek/v1.0.0');
    assert.equal(r.marketplaceVersion, '1.0.1', 'katalog sürümü varsayılan yama artışı');
    assert.deepEqual(r.written.sort(), ['plugins/ornek/commands/aa.md', 'plugins/ornek/commands/bb.md']);
    assert.deepEqual(r.push, { ok: true });
    assert.equal(sh(mk, ['cat-file', '-t', 'paket/ornek/v1.0.0'], gitEnv(tmp)).trim(), 'tag', 'annotated');
    assert.match(sh(mk, ['tag', '-l', '-n9', 'paket/ornek/v1.0.0'], gitEnv(tmp)), /ornek 1\.0\.0/);
    assert.equal(sh(mk, ['log', '-1', '--format=%s'], gitEnv(tmp)).trim(), 'ornek: 1.0.0 sürümü yayınlandı');
    assert.equal(sh(bare, ['rev-parse', 'refs/heads/main'], gitEnv(tmp)).trim(), r.commit);
    assert.match(sh(bare, ['tag', '-l'], gitEnv(tmp)), /paket\/ornek\/v1\.0\.0/);
    assert.equal(readJson(mk, 'plugins/ornek/.claude-plugin/plugin.json').version, '1.0.0');
    assert.equal(readJson(mk, 'plugins/ornek/.claude-plugin/plugin.json').description, 'Örnek paket');
    const mj = readJson(mk, '.claude-plugin/marketplace.json');
    assert.equal(mj.version, '1.0.1');
    assert.deepEqual(mj.plugins.map((p) => [p.name, p.source, p.version]), [['ornek', './plugins/ornek', undefined]]);
    assert.equal(readJson(mk, 'pp.config.json').marketplace.version, '1.0.1');
    assert.equal(sh(mk, ['status', '--porcelain'], gitEnv(tmp)).trim(), '', 'çalışma ağacı temiz');
    assert.deepEqual((await s.state.get(mk)).pendingTags, []);
    assert.ok(s.changed.length >= 1, 'önbellek temizliği tetiklendi');
    assert.equal(s.catalog.blocking((await s.catalog.build(await s.config.load())).packages.get('ornek')).length, 0);
  } finally { rmrf(tmp); }
});

test('katalog sürümü: verilen değer, küçük değer reddi, ardışık yayınlar ve updateAll', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    write(mk, 'prompts/diger/d.md', cmd('D'));
    commitAll(mk, tmp);
    const s = buildStack(mk, tmp);
    await assert.rejects(s.publisher.publish(mk, { name: 'ornek', marketplaceVersion: '0.9.0' }),
      (e) => e.status === 400 && e.data.code === 'katalogSurumGecersiz' && /mevcut sürümden \(1\.0\.0\) küçük olamaz/.test(e.message));
    await assert.rejects(s.publisher.publish(mk, { name: 'ornek', marketplaceVersion: '1.x' }), (e) => e.status === 400 && e.data.code === 'katalogSurumGecersiz');
    assert.equal(sh(mk, ['tag', '-l'], gitEnv(tmp)).trim(), '', 'hata yan etki bırakmadı');
    let r = await s.publisher.publish(mk, { name: 'ornek' });
    assert.equal(r.marketplaceVersion, '1.0.1');
    r = await s.publisher.publish(mk, { name: 'diger' });
    assert.equal(r.marketplaceVersion, '1.0.2', 'ikinci paket yayını bir kez daha artırır');
    assert.deepEqual(readJson(mk, '.claude-plugin/marketplace.json').plugins.map((p) => p.name), ['diger', 'ornek']);
    write(mk, 'prompts/ornek/c.md', cmd('C'));
    commitAll(mk, tmp);
    r = await s.publisher.publish(mk, { name: 'ornek', marketplaceVersion: '3.0.0' });
    assert.equal(r.marketplaceVersion, '3.0.0'); assert.equal(r.version, '1.1.0');
    // updateAll: katalog sürümü değişmez
    write(mk, 'prompts/ornek/d2.md', cmd('D2'));
    commitAll(mk, tmp);
    const u = await s.publisher.updateAll(mk);
    assert.ok(u.commit); assert.equal(u.written.length, 1);
    assert.equal(readJson(mk, 'pp.config.json').marketplace.version, '3.0.0');
    assert.equal(readJson(mk, '.claude-plugin/marketplace.json').version, '3.0.0');
    assert.equal(readJson(mk, 'plugins/ornek/.claude-plugin/plugin.json').version, '1.1.0', 'updateAll paket sürümünü artırmaz');
    assert.equal(sh(mk, ['tag', '-l', 'paket/*'], gitEnv(tmp)).trim().split('\n').length, 3, 'updateAll tag atmaz');
    // ikinci çalıştırma: değişiklik yok
    const u2 = await s.publisher.updateAll(mk);
    assert.equal(u2.commit, null); assert.equal(u2.message, 'Değişiklik yok'); assert.deepEqual(u2.written, []);
  } finally { rmrf(tmp); }
});

test('doğrulamalar: değişiklik yok, sürüm geride, tag var (yan etkisiz), kirli kaynak, boş paket, doğrulama', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    const s = buildStack(mk, tmp);
    await s.publisher.publish(mk, { name: 'ornek' });
    const head = sh(mk, ['rev-parse', 'HEAD'], gitEnv(tmp)).trim();
    await assert.rejects(s.publisher.publish(mk, { name: 'ornek' }), (e) => e.status === 409 && e.data.code === 'degisiklikYok');
    write(mk, 'prompts/ornek/c.md', cmd('C'));
    // kirli kaynak
    await assert.rejects(s.publisher.publish(mk, { name: 'ornek' }),
      (e) => e.status === 409 && e.data.code === 'kirliCalismaAgaci' && e.data.files.includes('prompts/ornek/c.md'));
    commitAll(mk, tmp);
    await assert.rejects(s.publisher.publish(mk, { name: 'ornek', version: '1.0.0' }), (e) => e.status === 400 && e.data.code === 'surumGeride');
    await assert.rejects(s.publisher.publish(mk, { name: 'ornek', version: 'x' }), (e) => e.status === 400 && e.data.code === 'surumGecersiz');
    // HEAD'den ulaşılamayan bir dalda aynı etiket: tagVar, yan etki yok
    const orphan = sh(mk, ['commit-tree', 'HEAD^{tree}', '-m', 'yetim'], gitEnv(tmp)).trim();
    sh(mk, ['tag', 'paket/ornek/v1.1.0', orphan], gitEnv(tmp));
    const before = snapshot(mk); const headNow = sh(mk, ['rev-parse', 'HEAD'], gitEnv(tmp)).trim();
    await assert.rejects(s.publisher.publish(mk, { name: 'ornek', version: '1.1.0' }), (e) => e.status === 409 && e.data.code === 'tagVar');
    assert.deepEqual(snapshot(mk), before); assert.equal(sh(mk, ['rev-parse', 'HEAD'], gitEnv(tmp)).trim(), headNow);
    assert.notEqual(head, headNow);
    // bilinmeyen paket, doğrulama hatası
    await assert.rejects(s.publisher.publish(mk, { name: 'yok' }), (e) => e.status === 404);
    write(mk, 'prompts/ornek/x.md', cmd('X', 'paket: baska\n'));
    commitAll(mk, tmp);
    await assert.rejects(s.publisher.publish(mk, { name: 'ornek', version: '1.2.0' }),
      (e) => e.status === 400 && e.data.code === 'dogrulama' && e.data.issues[0].code === 'paketUyusmuyor' && /1 sorun var/.test(e.message));
  } finally { rmrf(tmp); }
});

test('tag adımında hata: HEAD parent\'a döner, dosyalar eski halinde, başka staged dosya korunur', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    class Bozuk extends GitService { async createTag() { throw new Error('tag yazılamadı'); } }
    const s = buildStack(mk, tmp, { git: new Bozuk({ env: gitEnv(tmp) }) });
    write(mk, 'baska.txt', 'baska\n');
    sh(mk, ['add', 'baska.txt'], gitEnv(tmp));
    const parent = sh(mk, ['rev-parse', 'HEAD'], gitEnv(tmp)).trim();
    const before = snapshot(mk);
    await assert.rejects(s.publisher.publish(mk, { name: 'ornek' }),
      (e) => e.status === 500 && e.data.code === 'geriAlindi' && /Yayın başarısız: tag yazılamadı\. Yapılan değişiklikler geri alındı\./.test(e.message));
    assert.equal(sh(mk, ['rev-parse', 'HEAD'], gitEnv(tmp)).trim(), parent);
    assert.deepEqual(snapshot(mk), before);
    assert.equal(sh(mk, ['tag', '-l'], gitEnv(tmp)).trim(), '');
    assert.equal(sh(mk, ['diff', '--cached', '--name-only'], gitEnv(tmp)).trim(), 'baska.txt', 'önceden staged dosya staged kalır');
    assert.equal(fs.existsSync(path.join(mk, 'plugins')), false);
  } finally { rmrf(tmp); }
});

test('commit adımında kimlik hatası: needIdentity ve tam geri alma', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    const noId = new GitService({ env: gitEnv(tmp, { identity: false }) });
    const s = buildStack(mk, tmp, { git: noId });
    const before = snapshot(mk);
    await assert.rejects(s.publisher.publish(mk, { name: 'ornek' }), (e) => e.status === 400 && e.data.needIdentity === true);
    assert.deepEqual(snapshot(mk), before);
  } finally { rmrf(tmp); }
});

test('push başarısız: yerel yayın kalır, pendingTags dolar; remote düzelince push boşaltır', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    const s = buildStack(mk, tmp);
    await s.git.addRemote(mk, 'origin', path.join(tmp, 'yok.git'));
    const r = await s.publisher.publish(mk, { name: 'ornek', push: true });
    assert.equal(r.ok, true);
    assert.equal(r.push.ok, false); assert.ok(['bulunamadi', 'ag', 'bilinmiyor'].includes(r.push.code));
    assert.ok(r.push.error.length > 10);
    assert.deepEqual((await s.state.get(mk)).pendingTags, ['paket/ornek/v1.0.0']);
    assert.match(sh(mk, ['tag', '-l'], gitEnv(tmp)), /paket\/ornek\/v1\.0\.0/, 'yerel tag kaldı');
    const bare = makeBare(tmp);
    await s.git.setRemoteUrl(mk, 'origin', bare);
    const p = await s.remoteSync.push(mk, {});
    assert.deepEqual(p, { ok: true });
    assert.deepEqual((await s.state.get(mk)).pendingTags, []);
    assert.match(sh(bare, ['tag', '-l'], gitEnv(tmp)), /paket\/ornek\/v1\.0\.0/);
    assert.equal((await s.remoteSync.status(mk)).upstream, 'origin/main');
  } finally { rmrf(tmp); }
});

test('push istenip uzak depo yoksa: yayın tamam, push remoteYok', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    const s = buildStack(mk, tmp);
    const r = await s.publisher.publish(mk, { name: 'ornek', push: true });
    assert.equal(r.ok, true); assert.equal(r.push.ok, false); assert.equal(r.push.code, 'remoteYok');
  } finally { rmrf(tmp); }
});

test('OpLock: ag kilidi yayını bloklamaz; iki yaz işlemi çakışırsa ikincisi busy', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    const s = buildStack(mk, tmp);
    const r = await s.lock.run(mk, 'ag', () => s.publisher.publish(mk, { name: 'ornek' }));
    assert.equal(r.ok, true);
    write(mk, 'prompts/ornek/c.md', cmd('C'));
    commitAll(mk, tmp);
    const p1 = s.publisher.publish(mk, { name: 'ornek' });
    await assert.rejects(s.publisher.publish(mk, { name: 'ornek' }), (e) => e.status === 409 && e.data.busy === true);
    await assert.rejects(s.publisher.updateAll(mk), (e) => e.data && e.data.busy === true);
    assert.equal((await p1).version, '1.1.0');
    assert.equal(s.lock.isBusy(mk, 'yaz'), false);
  } finally { rmrf(tmp); }
});

test('commit yokken yayın 409 commitYok; paket sayfası verisi', real, async () => {
  const tmp = tmpDir();
  try {
    const { makeRepo } = require('./helpers');
    const mk = makeRepo(tmp, 'bos');
    write(mk, 'pp.config.json', JSON.stringify({ libraryDir: 'prompts', marketplace: { name: 'bos', owner: 'o', plugin: 'bos', description: 'd', version: '1.0.0' } }));
    write(mk, 'prompts/p/a.md', cmd('A'));
    const s = buildStack(mk, tmp);
    await assert.rejects(s.publisher.publish(mk, { name: 'p' }), (e) => e.status === 409 && e.data.code === 'commitYok');
    await assert.rejects(s.publisher.updateAll(mk), (e) => e.status === 409 && e.data.code === 'commitYok');
  } finally { rmrf(tmp); }
});
