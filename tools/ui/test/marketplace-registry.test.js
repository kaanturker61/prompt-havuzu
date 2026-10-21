'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { GitService } = require('../lib/git-service');
const { MarketplaceRegistry } = require('../lib/marketplace-registry');
const { gitAvailable, tmpDir, rmrf, gitEnv } = require('./helpers');

test('discover: items / ignored / valid / reason', { skip: !gitAvailable && 'git yok' }, async () => {
  const d = tmpDir();
  try {
    const git = new GitService({ env: gitEnv(d) });
    const lib = path.join(d, 'lib'); fs.mkdirSync(lib);
    const tool = path.join(lib, 'arac'); fs.mkdirSync(tool);
    const reg = new MarketplaceRegistry({ git, toolRoot: tool });
    const a = path.join(lib, 'a'); fs.mkdirSync(a); await git.init(a);
    fs.mkdirSync(path.join(a, '.claude-plugin')); fs.writeFileSync(path.join(a, '.claude-plugin', 'marketplace.json'), '{}');
    fs.mkdirSync(path.join(lib, 'b'));
    fs.mkdirSync(path.join(lib, '.gizli')); await git.init(path.join(lib, '.gizli'));
    const c = path.join(lib, 'c'); fs.mkdirSync(c); fs.writeFileSync(path.join(c, '.git'), 'bozuk icerik');
    fs.writeFileSync(path.join(lib, 'dosya.txt'), 'x');

    const r = await reg.discover(lib, 'a');
    assert.deepEqual(r.items.map((i) => i.name), ['a', 'c']);
    const ia = r.items[0]; const ic = r.items[1];
    assert.equal(ia.valid, true); assert.equal(ia.reason, null); assert.equal(ia.active, true);
    assert.equal(ia.hasManifest, true); assert.equal('hasPpConfig' in ia, false);
    assert.equal(ic.valid, false); assert.ok(ic.reason); assert.equal(ic.active, false);
    assert.deepEqual(r.ignored.map((i) => [i.name, i.reason]), [['arac', 'Araç reposu'], ['b', 'Git deposu değil']]);
    assert.equal(await reg.hasAnyGitChild(lib), true);
  } finally { rmrf(d); }
});

test('discover: reasonCode (aracReposu, gitDegil, gitOkunamadi); geçerli klasörde null, reason metinleri aynı', { skip: !gitAvailable && 'git yok' }, async () => {
  const d = tmpDir();
  try {
    const git = new GitService({ env: gitEnv(d) });
    const lib = path.join(d, 'lib'); fs.mkdirSync(lib);
    const tool = path.join(lib, 'arac'); fs.mkdirSync(tool);
    const reg = new MarketplaceRegistry({ git, toolRoot: tool });
    const a = path.join(lib, 'a'); fs.mkdirSync(a); await git.init(a);
    fs.mkdirSync(path.join(lib, 'b'));
    const c = path.join(lib, 'c'); fs.mkdirSync(c); fs.writeFileSync(path.join(c, '.git'), 'bozuk icerik');

    const r = await reg.discover(lib, 'a');
    assert.deepEqual(r.items.map((i) => [i.name, i.valid, i.reasonCode]), [['a', true, null], ['c', false, 'gitOkunamadi']]);
    assert.match(r.items[1].reason, /^Git deposu okunamadı/);
    assert.deepEqual(r.ignored.map((i) => [i.name, i.reason, i.reasonCode]), [
      ['arac', 'Araç reposu', 'aracReposu'], ['b', 'Git deposu değil', 'gitDegil']
    ]);
  } finally { rmrf(d); }
});

test('discover: git kökü bu klasör değilse kokDepoDegil, okunamıyorsa gitOkunamadi (git saplaması)', async () => {
  const d = tmpDir();
  try {
    const lib = path.join(d, 'lib'); fs.mkdirSync(lib);
    for (const n of ['ust', 'yok', 'iyi']) fs.mkdirSync(path.join(lib, n, '.git'), { recursive: true });
    const answers = {
      ust: { path: lib, error: null },
      yok: { path: null, error: 'fatal: ilk satir\nikinci satir' },
      iyi: { path: path.join(lib, 'iyi'), error: null }
    };
    const git = { toplevelInfo: async (dir) => answers[path.basename(dir)] };
    const reg = new MarketplaceRegistry({ git, toolRoot: path.join(d, 'baska') });
    const r = await reg.discover(lib, '');
    const by = Object.fromEntries(r.items.map((i) => [i.name, i]));
    assert.equal(by.ust.reasonCode, 'kokDepoDegil'); assert.equal(by.ust.reason, 'Git deposu kökü bu klasör değil');
    assert.equal(by.yok.reasonCode, 'gitOkunamadi'); assert.equal(by.yok.reason, 'Git deposu okunamadı: fatal: ilk satir');
    assert.equal(by.iyi.reasonCode, null); assert.equal(by.iyi.reason, null); assert.equal(by.iyi.valid, true);
    assert.deepEqual(r.ignored, []);
  } finally { rmrf(d); }
});

test('hasAnyGitChild: araç reposu sayılmaz',{ skip: !gitAvailable && 'git yok' }, async () => {
  const d = tmpDir();
  try {
    const git = new GitService({ env: gitEnv(d) });
    const tool = path.join(d, 'arac'); fs.mkdirSync(tool); await git.init(tool);
    const reg = new MarketplaceRegistry({ git, toolRoot: tool });
    assert.equal(await reg.hasAnyGitChild(d), false);
  } finally { rmrf(d); }
});

test('folderOf: yol enjeksiyonu reddedilir', async () => {
  const d = tmpDir();
  try {
    fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true });
    fs.mkdirSync(path.join(d, '.gizli'));
    fs.writeFileSync(path.join(d, 'dosya'), '');
    const reg = new MarketplaceRegistry({ git: {}, toolRoot: path.join(d, 'x') });
    assert.equal(await reg.folderOf(d, 'a'), path.join(d, 'a'));
    for (const bad of ['..', 'a/b', 'a\\b', '.gizli', '', 'yok', 'dosya', 'C:', null, undefined, 5]) {
      assert.equal(await reg.folderOf(d, bad), null, String(bad));
    }
  } finally { rmrf(d); }
});
