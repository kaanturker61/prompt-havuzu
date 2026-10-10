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
    assert.equal(ia.hasManifest, true); assert.equal(ia.hasPpConfig, false);
    assert.equal(ic.valid, false); assert.ok(ic.reason); assert.equal(ic.active, false);
    assert.deepEqual(r.ignored.map((i) => [i.name, i.reason]), [['arac', 'Araç reposu'], ['b', 'Git deposu değil']]);
    assert.equal(await reg.hasAnyGitChild(lib), true);
  } finally { rmrf(d); }
});

test('hasAnyGitChild: araç reposu sayılmaz', { skip: !gitAvailable && 'git yok' }, async () => {
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
