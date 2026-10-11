'use strict';
/* MarketplaceFactory.cloneRemote: yerel bare repodan klonlama, hata yolları ve temizlik. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { GitService } = require('../lib/git-service');
const { MarketplaceFactory } = require('../lib/marketplace-factory');
const { MarketplaceRegistry } = require('../lib/marketplace-registry');
const templates = require('../lib/templates');
const { gitAvailable, tmpDir, rmrf, gitEnv, sh, makeRepo, makeBare } = require('./helpers');
const { seed } = require('./stack');

const real = { skip: !gitAvailable && 'git yok' };

function setup(tmp, git) {
  const g = git || new GitService({ env: gitEnv(tmp) });
  const lib = path.join(tmp, 'lib'); fs.mkdirSync(lib, { recursive: true });
  return { g, lib, factory: new MarketplaceFactory({ git: g, templates }), registry: new MarketplaceRegistry({ git: g, toolRoot: path.join(tmp, 'arac') }) };
}

async function bareWith(tmp, g, name = 'kaynak', seedIt = true) {
  const src = seedIt ? seed(tmp, name) : makeRepo(tmp, name);
  const bare = makeBare(tmp, name + '.git');
  await g.addRemote(src, 'origin', bare);
  if (seedIt) await g.push(src, { remote: 'origin', branch: 'main' });
  return bare;
}

test('klonlama: bare repodan klonlar, registry geçerli listeler, uyarı yok', real, async () => {
  const tmp = tmpDir();
  try {
    const { g, lib, factory, registry } = setup(tmp);
    const bare = await bareWith(tmp, g);
    const r = await factory.cloneRemote(lib, bare, {});
    assert.equal(r.name, 'kaynak'); assert.deepEqual(r.warnings, []);
    assert.ok(fs.existsSync(path.join(lib, 'kaynak', 'prompts', 'ornek', 'a.md')));
    const found = (await registry.discover(lib, 'kaynak')).items.find((i) => i.name === 'kaynak');
    assert.equal(found.valid, true); assert.equal(found.hasPpConfig, true);
    // ad verilebilir
    const r2 = await factory.cloneRemote(lib, bare, { name: 'Başka Ad' });
    assert.equal(r2.name, 'baska-ad');
  } finally { rmrf(tmp); }
});

test('klonlama: pp.config.json ve manifest yoksa uyarı; boş depo uyarısı', real, async () => {
  const tmp = tmpDir();
  try {
    const { g, lib, factory } = setup(tmp);
    const src = makeRepo(tmp, 'ayarsiz');
    fs.writeFileSync(path.join(src, 'x.md'), 'x\n');
    sh(src, ['add', '.'], gitEnv(tmp)); sh(src, ['commit', '-q', '-m', 'i'], gitEnv(tmp));
    const bare = makeBare(tmp, 'ayarsiz.git');
    await g.addRemote(src, 'origin', bare); await g.push(src, { remote: 'origin', branch: 'main' });
    const r = await factory.cloneRemote(lib, bare, {});
    assert.deepEqual(r.warnings.map((w) => w.code), ['ppConfigYok', 'manifestYok']);
    assert.equal(r.warnings[0].message, 'Bu depoda pp.config.json yok. Prompt Havuzu ayarlarını oluştur.');
    assert.equal(fs.existsSync(path.join(lib, 'ayarsiz', 'pp.config.json')), false, 'otomatik dosya yazılmaz');
    const empty = makeBare(tmp, 'bos.git');
    const r2 = await factory.cloneRemote(lib, empty, {});
    assert.ok(r2.warnings.some((w) => w.code === 'bosDepo'));
  } finally { rmrf(tmp); }
});

test('klonlama hataları: klasör var 409 (dokunulmaz), geçersiz URL/ad 400, olmayan depo 502 ve yarım klasör yok', real, async () => {
  const tmp = tmpDir();
  try {
    const { g, lib, factory } = setup(tmp);
    const bare = await bareWith(tmp, g);
    fs.mkdirSync(path.join(lib, 'kaynak')); fs.writeFileSync(path.join(lib, 'kaynak', 'benim.txt'), 'x');
    await assert.rejects(factory.cloneRemote(lib, bare, {}), (e) => e.status === 409 && e.code === 'klasorVar' && e.message === 'Bu adda bir klasör zaten var: kaynak');
    assert.equal(fs.readFileSync(path.join(lib, 'kaynak', 'benim.txt'), 'utf8'), 'x');
    await assert.rejects(factory.cloneRemote(lib, 'ext::sh -c x', {}), (e) => e.status === 400 && e.code === 'urlGecersiz');
    await assert.rejects(factory.cloneRemote(lib, bare, { name: 'claude-plugins-official' }), (e) => e.status === 400 && e.code === 'adGecersiz' && /ayrılmış/.test(e.message));
    await assert.rejects(factory.cloneRemote(lib, path.join(tmp, 'yok.git'), {}), (e) => e.status === 502 && /^Depo klonlanamadı: /.test(e.message) && !!e.code);
    assert.equal(fs.existsSync(path.join(lib, 'yok')), false);
    assert.deepEqual(fs.readdirSync(lib).sort(), ['kaynak']);
  } finally { rmrf(tmp); }
});

test('klonlama zaman aşımı: yarım klasör silinir', async () => {
  const tmp = tmpDir();
  try {
    const lib = path.join(tmp, 'lib'); fs.mkdirSync(lib);
    const runner = (bin, args, opts, cb) => {
      if (args.includes('clone')) {
        fs.mkdirSync(path.join(lib, 'zaman'), { recursive: true }); fs.writeFileSync(path.join(lib, 'zaman', 'yarim'), 'x');
        return cb(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), '', '');
      }
      cb(null, '', '');
    };
    const g = new GitService({ runner });
    const factory = new MarketplaceFactory({ git: g, templates });
    await assert.rejects(factory.cloneRemote(lib, 'https://example.com/o/zaman.git', {}), (e) => e.status === 502 && e.code === 'zamanAsimi' && /zamanında tamamlanmadı/.test(e.message));
    assert.equal(fs.existsSync(path.join(lib, 'zaman')), false);
    assert.ok(true);
  } finally { rmrf(tmp); }
});
