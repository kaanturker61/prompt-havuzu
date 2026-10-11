'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ConfigStore } = require('../lib/config-store');
const { GitService } = require('../lib/git-service');
const { MarketplaceRegistry } = require('../lib/marketplace-registry');
const { SetupService } = require('../lib/setup-service');
const { gitAvailable, tmpDir, rmrf, gitEnv } = require('./helpers');

async function build(d, { cfg, rawCfg, gitBin } = {}) {
  const tool = path.join(d, 'arac'); fs.mkdirSync(tool, { recursive: true });
  const file = path.join(d, 'cfg', 'config.json');
  const store = new ConfigStore({ file });
  if (rawCfg !== undefined) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rawCfg); }
  else if (cfg) await store.save(cfg);
  const git = new GitService({ bin: gitBin || 'git', env: gitEnv(d), forbiddenRoots: [tool] });
  const registry = new MarketplaceRegistry({ git, toolRoot: tool });
  return { svc: new SetupService({ configStore: store, registry, git, toolRoot: tool }), tool, git, store };
}
const codes = (st) => st.issues.map((i) => i.code);
const real = { skip: !gitAvailable && 'git yok' };

test('kokAyarlanmadi: durur', real, async () => {
  const d = tmpDir();
  try {
    const { svc } = await build(d);
    const st = await svc.evaluate();
    assert.equal(st.ok, false); assert.equal(st.root, null);
    assert.deepEqual(codes(st), ['kokAyarlanmadi']);
    assert.equal(st.issues[0].action, 'ayarlar');
    assert.equal(st.issues[0].message, "Library kökü ayarlanmadı. Ayarlar'dan bir klasör seç.");
  } finally { rmrf(d); }
});

test('ayarDosyasiBozuk uyarı olarak eklenir, durdurmaz', real, async () => {
  const d = tmpDir();
  try {
    const { svc } = await build(d, { rawCfg: '{bozuk' });
    const st = await svc.evaluate();
    assert.deepEqual(codes(st), ['ayarDosyasiBozuk', 'kokAyarlanmadi']);
    assert.equal(st.issues[0].level, 'warn');
  } finally { rmrf(d); }
});

test('kokYok', real, async () => {
  const d = tmpDir();
  try {
    const { svc } = await build(d, { cfg: { libraryRoot: path.join(d, 'yok') } });
    const st = await svc.evaluate();
    assert.deepEqual(codes(st), ['kokYok']);
    assert.match(st.issues[0].message, /^Library kökü diskte bulunamadı: /);
  } finally { rmrf(d); }
});

test('kokAracReposunda: araç reposunun kendisi ve içi', real, async () => {
  const d = tmpDir();
  try {
    const { svc, tool, store } = await build(d, { cfg: { libraryRoot: '.' } });
    await store.save({ libraryRoot: tool });
    assert.deepEqual(codes(await svc.evaluate()), ['kokAracReposunda']);
    fs.mkdirSync(path.join(tool, 'x'));
    await store.save({ libraryRoot: path.join(tool, 'x') });
    assert.deepEqual(codes(await svc.evaluate()), ['kokAracReposunda']);
  } finally { rmrf(d); }
});

test('gitBulunamadi: durur', async () => {
  const d = tmpDir();
  try {
    const lib = path.join(d, 'lib'); fs.mkdirSync(lib);
    const { svc } = await build(d, { cfg: { libraryRoot: lib }, gitBin: path.join(d, 'yok-git-binary') });
    const st = await svc.evaluate();
    assert.deepEqual(codes(st), ['gitBulunamadi']);
    assert.equal(st.issues[0].action, null);
  } finally { rmrf(d); }
});

test('marketplaceYok / marketplaceSecilmedi / marketplaceBulunamadi', real, async () => {
  const d = tmpDir();
  try {
    const lib = path.join(d, 'lib'); fs.mkdirSync(lib);
    const { svc, store, git } = await build(d, { cfg: { libraryRoot: lib } });
    let st = await svc.evaluate();
    assert.deepEqual(codes(st), ['marketplaceYok']); assert.equal(st.issues[0].action, 'yeniMarketplace');
    const a = path.join(lib, 'a'); fs.mkdirSync(a); await git.init(a);
    st = await svc.evaluate();
    assert.deepEqual(codes(st), ['marketplaceSecilmedi']); assert.equal(st.issues[0].action, 'marketplaceSec');
    await store.save({ libraryRoot: lib, activeMarketplace: 'yok' });
    st = await svc.evaluate();
    assert.deepEqual(codes(st), ['marketplaceBulunamadi']);
    assert.equal(st.issues[0].message, 'Seçili marketplace bulunamadı: yok');
  } finally { rmrf(d); }
});

test('marketplaceGitYok: düz klasör ve bozuk .git', real, async () => {
  const d = tmpDir();
  try {
    const lib = path.join(d, 'lib'); fs.mkdirSync(path.join(lib, 'duz'), { recursive: true });
    const { svc, store } = await build(d, { cfg: { libraryRoot: lib, activeMarketplace: 'duz' } });
    let st = await svc.evaluate();
    assert.deepEqual(codes(st), ['marketplaceGitYok']);
    assert.equal(st.issues[0].message, "Seçili marketplace'te git başlatılmamış: duz");
    assert.equal(st.issues[0].action, 'gitBaslat');
    fs.mkdirSync(path.join(lib, 'bozuk')); fs.writeFileSync(path.join(lib, 'bozuk', '.git'), 'bozuk');
    await store.save({ libraryRoot: lib, activeMarketplace: 'bozuk' });
    st = await svc.evaluate();
    assert.deepEqual(codes(st), ['marketplaceGitYok']);
    assert.match(st.issues[0].message, /bozuk \(.+\)$/);
  } finally { rmrf(d); }
});

test('ok: root doğru; kök değişince onRootChange çağrılır', real, async () => {
  const d = tmpDir();
  try {
    const lib = path.join(d, 'lib'); fs.mkdirSync(lib);
    const { svc, store, git } = await build(d, { cfg: { libraryRoot: lib } });
    const a = path.join(lib, 'a'); fs.mkdirSync(a); await git.init(a); fs.writeFileSync(path.join(a, 'pp.config.json'), '{}');
    const b = path.join(lib, 'b'); fs.mkdirSync(b); await git.init(b); fs.writeFileSync(path.join(b, 'pp.config.json'), '{}');
    const seen = [];
    svc.onRootChange((now, prev) => seen.push([now, prev]));
    await store.save({ libraryRoot: lib, activeMarketplace: 'a' });
    let st = await svc.evaluate();
    assert.equal(st.ok, true); assert.deepEqual(st.issues, []);
    assert.equal(st.root.toLowerCase(), a.toLowerCase());
    assert.equal(seen.length, 1);
    await svc.evaluate();
    assert.equal(seen.length, 1, 'kök aynıysa çağrılmaz');
    await store.save({ libraryRoot: lib, activeMarketplace: 'b' });
    st = await svc.evaluate();
    assert.equal(seen.length, 2);
    assert.equal(svc.current, st);
  } finally { rmrf(d); }
});

test('uyarılar: kokAracReposunuIceriyor ve kokBaskaDepoda; ok kalır', real, async () => {
  const d = tmpDir();
  try {
    // kök, araç reposunu içerir: araç reposu d/lib/arac olsun
    const lib = path.join(d, 'lib'); fs.mkdirSync(lib);
    const { svc, git, store } = await build(d, { cfg: { libraryRoot: lib } });
    const outer = path.join(d, 'dis'); fs.mkdirSync(path.join(outer, 'lib2', 'm'), { recursive: true });
    await git.init(outer); await git.init(path.join(outer, 'lib2', 'm'));
    await store.save({ libraryRoot: path.join(outer, 'lib2'), activeMarketplace: 'm' });
    let st = await svc.evaluate();
    assert.equal(st.ok, true);
    assert.deepEqual(codes(st), ['kokBaskaDepoda', 'ppConfigYok']);
    assert.equal(st.issues[0].level, 'warn');
    const pc = st.issues.find((i) => i.code === 'ppConfigYok');
    assert.equal(pc.level, 'warn'); assert.equal(pc.action, 'ppConfigOlustur');
    assert.equal(st.rootOk, true, 'ppConfigYok uyarıdır, rootOk değişmez');
    fs.writeFileSync(path.join(outer, 'lib2', 'm', 'pp.config.json'), '{}');
    assert.deepEqual(codes(await svc.evaluate()), ['kokBaskaDepoda']);
    await store.save({ libraryRoot: d, activeMarketplace: 'dis' });
    st = await svc.evaluate();
    assert.ok(codes(st).includes('kokAracReposunuIceriyor'));
  } finally { rmrf(d); }
});

test('refreshIfStale: .git dışarıdan silinince yeniden değerlendirir', real, async () => {
  const d = tmpDir();
  try {
    const lib = path.join(d, 'lib'); fs.mkdirSync(lib);
    const { svc, git } = await build(d, { cfg: { libraryRoot: lib, activeMarketplace: 'a' } });
    const a = path.join(lib, 'a'); fs.mkdirSync(a); await git.init(a);
    assert.equal((await svc.evaluate()).ok, true);
    rmrf(path.join(a, '.git'));
    const st = await svc.refreshIfStale();
    assert.equal(st.ok, false);
    assert.deepEqual(codes(st), ['marketplaceGitYok']);
  } finally { rmrf(d); }
});

test('rootOk: marketplaceSecilmedi iken true, kokYok iken false', real, async () => {
  const d = tmpDir();
  try {
    const lib = path.join(d, 'lib'); fs.mkdirSync(lib);
    const { svc, store, git } = await build(d, { cfg: { libraryRoot: lib } });
    const a = path.join(lib, 'a'); fs.mkdirSync(a); await git.init(a);
    let st = await svc.evaluate();
    assert.deepEqual(codes(st), ['marketplaceSecilmedi']);
    assert.equal(st.ok, false); assert.equal(st.rootOk, true);
    await store.save({ libraryRoot: lib, activeMarketplace: 'a' });
    st = await svc.evaluate();
    assert.equal(st.ok, true); assert.equal(st.rootOk, true);
    await store.save({ libraryRoot: path.join(d, 'yok') });
    st = await svc.evaluate();
    assert.deepEqual(codes(st), ['kokYok']); assert.equal(st.rootOk, false);
  } finally { rmrf(d); }
});

test('onLibraryChange yalnızca libraryRoot değişince çağrılır', real, async () => {
  const d = tmpDir();
  try {
    const lib = path.join(d, 'lib'); fs.mkdirSync(lib);
    const lib2 = path.join(d, 'lib2'); fs.mkdirSync(lib2);
    const { svc, store, git } = await build(d, { cfg: { libraryRoot: lib } });
    for (const n of ['a', 'b']) { fs.mkdirSync(path.join(lib, n)); await git.init(path.join(lib, n)); }
    const seen = [];
    svc.onLibraryChange((now, prev) => seen.push([now, prev]));
    await store.save({ libraryRoot: lib, activeMarketplace: 'a' });
    await svc.evaluate();
    assert.equal(seen.length, 1);
    await store.save({ libraryRoot: lib, activeMarketplace: 'b' });
    await svc.evaluate();
    assert.equal(seen.length, 1, 'yalnızca etkin marketplace değişti');
    await store.save({ libraryRoot: lib2, activeMarketplace: '' });
    await svc.evaluate();
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1], [lib2, lib]);
  } finally { rmrf(d); }
});
