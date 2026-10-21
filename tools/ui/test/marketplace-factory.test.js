'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { GitService } = require('../lib/git-service');
const { MarketplaceFactory } = require('../lib/marketplace-factory');
const templates = require('../lib/templates');
const { gitAvailable, tmpDir, rmrf, gitEnv } = require('./helpers');

const real = { skip: !gitAvailable && 'git yok' };

function setup(d) {
  const git = new GitService({ env: gitEnv(d) });
  return { git, factory: new MarketplaceFactory({ git, templates }) };
}

test('create: dosya içerikleri ve repo kökü', real, async () => {
  const d = tmpDir();
  try {
    const { git, factory } = setup(d);
    const lib = path.join(d, 'lib'); fs.mkdirSync(lib);
    const r = await factory.create(lib, { name: 'Örnek Promptlar', description: 'Açıklama', owner: 'Demo' });
    assert.equal(r.name, 'ornek-promptlar');
    const dir = r.dir;
    assert.equal(await git.isRepoRoot(dir), true);
    assert.equal(fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim(), 'ref: refs/heads/main');
    const mk = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.deepEqual(mk, { name: 'ornek-promptlar', description: 'Açıklama', owner: { name: 'Demo' }, plugins: [] });
    assert.equal(fs.existsSync(path.join(dir, 'pp.config.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'library')), false);
    assert.ok(fs.existsSync(path.join(dir, 'prompts', '.gitkeep')));
    assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^desktop\.ini$/m);
    assert.match(fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8'), /\*\.md text eol=lf/);
    assert.ok(fs.existsSync(path.join(dir, 'README.md')));
    assert.equal(await git.hasCommits(dir), false, 'commit atılmaz');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.pp-tmp')), []);
  } finally { rmrf(d); }
});

test('create: ad doğrulama ve var olan klasör', real, async () => {
  const d = tmpDir();
  try {
    const { factory } = setup(d);
    fs.mkdirSync(path.join(d, 'var')); fs.writeFileSync(path.join(d, 'var', 'dokunma.txt'), 'x');
    await assert.rejects(factory.create(d, { name: '!!!' }), (e) => e.status === 400 && e.message === 'Geçersiz marketplace adı');
    await assert.rejects(factory.create(d, { name: 'claude-plugins-official' }), (e) => e.status === 400 && /ayrılmış/.test(e.message));
    await assert.rejects(factory.create(d, { name: 'var' }), (e) => e.status === 409 && e.message === 'Bu adda bir klasör zaten var: var');
    assert.deepEqual(fs.readdirSync(path.join(d, 'var')), ['dokunma.txt']);
  } finally { rmrf(d); }
});

test('CON/nul/aux/com1/lpt1/prn/ok. 400, diskte klasör yok, ham git hatası yok', real, async () => {
  const d = tmpDir();
  try {
    const { factory } = setup(d);
    for (const name of ['CON', 'nul', 'aux', 'com1', 'LPT1', 'prn', 'Con', 'ok.', 'x.', ' ok. ']) {
      await assert.rejects(factory.create(d, { name }), (e) => {
        assert.equal(e.status, 400, name);
        assert.ok(!/fatal|error:|git/i.test(e.message), 'ham git hatası yok: ' + e.message);
        assert.match(e.message, name.trim().endsWith('.') ? /nokta ile bitemez/ : /Windows aygıt adı/, name);
        return true;
      });
    }
    assert.deepEqual(fs.readdirSync(d).filter((n) => n !== 'gitconfig'), [], 'diskte klasör oluşmadı');
    // ham giriş geçerli, slug aygıt adı olmayan adlar çalışır
    await factory.create(d, { name: 'Konsol Promptları' });
    assert.ok(fs.existsSync(path.join(d, 'konsol-promptlari')));
  } finally { rmrf(d); }
});

test('create geri alma: init sonrası hata klasörü tamamen siler', real, async () => {
  const d = tmpDir();
  try {
    const git = { async init(dir) { fs.mkdirSync(path.join(dir, '.git')); throw new Error('init patladı'); } };
    const factory = new MarketplaceFactory({ git, templates });
    await assert.rejects(factory.create(d, { name: 'yeni' }), (e) => {
      assert.equal(e.status, 500);
      assert.equal(e.message, 'Marketplace oluşturulamadı: init patladı. Yapılan değişiklikler geri alındı.');
      return true;
    });
    assert.equal(fs.existsSync(path.join(d, 'yeni')), false);
  } finally { rmrf(d); }
});

test('create geri alma: dosya yazarken hata', real, async () => {
  const d = tmpDir();
  try {
    const { git } = setup(d);
    let n = 0;
    const factory = new MarketplaceFactory({ git, templates, atomicWrite: async (abs, data) => {
      if (++n === 3) throw new Error('disk dolu');
      fs.writeFileSync(abs, data);
    } });
    await assert.rejects(factory.create(d, { name: 'yeni' }), /disk dolu/);
    assert.equal(fs.existsSync(path.join(d, 'yeni')), false);
  } finally { rmrf(d); }
});

test('initExisting: var olan dosya korunur, yalnızca eksikler yazılır', real, async () => {
  const d = tmpDir();
  try {
    const { git, factory } = setup(d);
    const dir = path.join(d, 'notlar'); fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitignore'), 'benim\n');
    fs.writeFileSync(path.join(dir, 'prompts', 'a.md'), 'icerik');
    const created = await factory.initExisting(dir);
    assert.ok(created.includes('.git') && created.includes('.claude-plugin/marketplace.json') && created.includes('prompts/.gitkeep'));
    assert.ok(!created.includes('pp.config.json'));
    assert.ok(!created.includes('.gitignore'));
    assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'benim\n');
    assert.equal(fs.readFileSync(path.join(dir, 'prompts', 'a.md'), 'utf8'), 'icerik');
    assert.equal(await git.isRepoRoot(dir), true);
  } finally { rmrf(d); }
});

test('initExisting: yok -> 404, zaten repo -> 409', real, async () => {
  const d = tmpDir();
  try {
    const { git, factory } = setup(d);
    await assert.rejects(factory.initExisting(path.join(d, 'yok')), (e) => e.status === 404 && e.message === 'Klasör bulunamadı: yok');
    const dir = path.join(d, 'r'); fs.mkdirSync(dir); await git.init(dir);
    await assert.rejects(factory.initExisting(dir), (e) => e.status === 409 && e.message === 'Bu klasör zaten bir git deposu: r');
  } finally { rmrf(d); }
});

test('initExisting geri alma: yalnızca oluşturulanlar silinir', real, async () => {
  const d = tmpDir();
  try {
    const { git } = setup(d);
    const dir = path.join(d, 'notlar'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'benim.md'), 'x');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'benim\n');
    let n = 0;
    const factory = new MarketplaceFactory({ git, templates, atomicWrite: async (abs, data) => {
      if (++n === 3) throw new Error('yazılamadı');
      fs.writeFileSync(abs, data);
    } });
    await assert.rejects(factory.initExisting(dir), (e) => e.status === 500 && /Git başlatılamadı: yazılamadı\. Yapılan değişiklikler geri alındı\./.test(e.message));
    assert.deepEqual(fs.readdirSync(dir).sort(), ['.gitignore', 'benim.md']);
    assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'benim\n');
  } finally { rmrf(d); }
});
