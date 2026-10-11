'use strict';
/* PackageCatalog ve PackageExporter: durum filtresi, paket çözümleme, orphan temizliği, geri alma. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { gitAvailable, tmpDir, rmrf } = require('./helpers');
const { seed, write, cmd, buildStack, snapshot } = require('./stack');
const { UndoStack } = require('../lib/undo');

const real = { skip: !gitAvailable && 'git yok' };

test('durum filtresi: kararlı ve boş dışa aktarılır, taslak durumHaric olur', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    write(mk, 'prompts/ornek/c.md', cmd('C', 'durum: taslak\n'));
    write(mk, 'prompts/ornek/d.md', cmd('D', 'durum: kararli\n'));
    write(mk, 'prompts/ornek/e.md', cmd('E', 'durum: Kararlı\n'));
    const s = buildStack(mk, tmp);
    const cfg = await s.config.load();
    const built = await s.catalog.build(cfg);
    const pkg = built.packages.get('ornek');
    assert.deepEqual(pkg.prompts.map((p) => p.ad).sort(), ['aa', 'bb', 'd', 'e']);
    const ex = pkg.excluded.find((x) => x.source === 'prompts/ornek/c.md');
    assert.equal(ex.code, 'durumHaric'); assert.equal(ex.level, 'info');
    assert.match(ex.reason, /^Durumu "taslak"\. Yalnızca şu durumlar dışa aktarılır: kararlı, \(boş\)\.$/);
    assert.equal(s.catalog.blocking(pkg).length, 0);
    // yalnızca "kararlı" seçilirse boş durum da dışarıda kalır
    cfg.export.durumlar = ['kararlı'];
    const b2 = await s.catalog.build(cfg);
    assert.deepEqual(b2.packages.get('ornek').prompts.map((p) => p.ad).sort(), ['d', 'e']);
  } finally { rmrf(tmp); }
});

test('paket klasörden gelir: uyuşmazlık paketi engeller, gelen kutusu ve klasörsüz', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    write(mk, 'prompts/ornek/x.md', cmd('X', 'paket: baska\n'));
    write(mk, 'prompts/gelen-kutusu/g.md', cmd('G'));
    write(mk, 'prompts/kok.md', cmd('Kok'));
    write(mk, 'prompts/kok2.md', cmd('Kok2', 'paket: ozel\n'));
    const s = buildStack(mk, tmp);
    const built = await s.catalog.build(await s.config.load());
    const ornek = built.packages.get('ornek');
    assert.equal(ornek.prompts.find((p) => p.source === 'prompts/ornek/x.md').paket, 'ornek', 'paket klasörden');
    const block = s.catalog.blocking(ornek);
    assert.equal(block.length, 1); assert.equal(block[0].code, 'paketUyusmuyor');
    assert.equal(built.packages.has('baska'), false);
    assert.equal(built.bySkipped.get('prompts/gelen-kutusu/g.md').code, 'paketDisiKlasor');
    assert.equal(built.bySource.get('prompts/kok.md').paket, 'mk', 'klasörsüz: varsayılan paket');
    assert.equal(built.bySource.get('prompts/kok.md').paketKaynagi, 'varsayilan');
    assert.equal(built.bySource.get('prompts/kok2.md').paket, 'ozel');
    assert.equal(built.bySource.get('prompts/kok2.md').paketKaynagi, 'alan');
  } finally { rmrf(tmp); }
});

test('uyarı seviyeli promptlar (turYok) paketi engeller; yayinDisi engellemez', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    write(mk, 'prompts/ornek/t.md', '---\nbaslik: T\nkomut_adi: tt\n---\ngovde\n');
    write(mk, 'prompts/ornek/n.md', '---\nbaslik: N\n---\ngovde\n');
    const s = buildStack(mk, tmp);
    const pkg = (await s.catalog.build(await s.config.load())).packages.get('ornek');
    assert.deepEqual(s.catalog.blocking(pkg).map((i) => i.code), ['turYok']);
    assert.ok(pkg.excluded.some((x) => x.code === 'yayinDisi'));
  } finally { rmrf(tmp); }
});

test('orphan çıktılar ve kaynaksız paket klasörü: plan kaldırır, apply çöpe taşır', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    write(mk, 'plugins/eski/commands/x.md', 'eski\n');
    write(mk, 'plugins/eski/.claude-plugin/plugin.json', '{"name":"eski"}\n');
    write(mk, 'plugins/ornek/commands/yetim.md', 'yetim\n');
    const s = buildStack(mk, tmp);
    const built = await s.catalog.build(await s.config.load());
    assert.deepEqual(built.orphans.map((o) => o.target).sort(), ['plugins/eski/commands/x.md', 'plugins/ornek/commands/yetim.md']);
    assert.deepEqual(await s.catalog.packageNames(built), ['eski', 'ornek']);

    const p1 = s.exporter.plan('ornek', built.packages.get('ornek').prompts, built.scanned);
    assert.deepEqual(p1.write.map((w) => w.target).sort(), ['plugins/ornek/commands/aa.md', 'plugins/ornek/commands/bb.md']);
    assert.deepEqual(p1.remove, ['plugins/ornek/commands/yetim.md']);
    assert.equal(p1.removeDir, false);
    const p2 = s.exporter.plan('eski', [], built.scanned);
    assert.equal(p2.removeDir, true);

    const undo = new UndoStack();
    const r = await s.exporter.apply(p2, undo);
    assert.deepEqual(r.removed, ['plugins/eski']);
    assert.equal(fs.existsSync(path.join(mk, 'plugins', 'eski')), false);
    assert.ok(fs.readdirSync(path.join(mk, '.pp', 'trash')).length === 1, 'çöpe taşındı');
    await undo.rollback();
    assert.equal(fs.readFileSync(path.join(mk, 'plugins', 'eski', 'commands', 'x.md'), 'utf8'), 'eski\n');
  } finally { rmrf(tmp); }
});

test('apply + rollback: dosyalar bayt bayt aynı', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    write(mk, 'plugins/ornek/commands/aa.md', 'ESKI ICERIK\r\n');
    write(mk, 'plugins/ornek/commands/yetim.md', 'yetim\n');
    write(mk, 'plugins/ornek/skills/ys/SKILL.md', 'skill\n');
    const s = buildStack(mk, tmp);
    const before = snapshot(mk);
    const built = await s.catalog.build(await s.config.load());
    const plan = s.exporter.plan('ornek', built.packages.get('ornek').prompts, built.scanned);
    const undo = new UndoStack();
    const r = await s.exporter.apply(plan, undo);
    assert.deepEqual(r.written.sort(), ['plugins/ornek/commands/aa.md', 'plugins/ornek/commands/bb.md']);
    assert.deepEqual(r.removed.sort(), ['plugins/ornek/commands/yetim.md', 'plugins/ornek/skills/ys/SKILL.md']);
    assert.match(fs.readFileSync(path.join(mk, 'plugins/ornek/commands/aa.md'), 'utf8'), /^---\ndescription: /);
    await undo.rollback();
    assert.deepEqual(snapshot(mk), before);
    // yeniden üretim: ikinci kez hiçbir şey yazılmaz
    const u2 = new UndoStack();
    await s.exporter.apply(plan, u2);
    const b2 = await s.catalog.build(await s.config.load());
    const p2 = s.exporter.plan('ornek', b2.packages.get('ornek').prompts, b2.scanned);
    assert.equal(p2.write.length, 0); assert.equal(p2.remove.length, 0);
  } finally { rmrf(tmp); }
});

test('ManifestWriter: yalnızca sürümü olan paketler listelenir, harici girdiler korunur, entry.version silinir', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    write(mk, '.claude-plugin/marketplace.json', JSON.stringify({
      name: 'mk', owner: { name: 'x' }, metadata: { version: '1.0.0' },
      plugins: [{ name: 'ornek', source: './plugins/ornek', version: '9.9.9' }, { name: 'dis', source: { source: 'github', repo: 'a/b' } }]
    }));
    const s = buildStack(mk, tmp);
    const cfg = await s.config.load();
    const undo = new UndoStack();
    await s.manifests.writePluginJson('ornek', cfg, { version: '1.2.0' }, undo);
    await s.manifests.writePluginJson('yayinlanmamis', cfg, { version: null }, undo);
    const names = await s.manifests.writeMarketplace(cfg, { version: '1.0.7' }, undo);
    assert.deepEqual(names, ['ornek']);
    const mj = JSON.parse(fs.readFileSync(path.join(mk, '.claude-plugin/marketplace.json'), 'utf8'));
    assert.equal(mj.metadata.version, '1.0.7', 'metadata.version varsa orası');
    assert.equal(mj.version, undefined);
    assert.deepEqual(mj.plugins.map((p) => p.name), ['ornek', 'dis']);
    assert.equal(mj.plugins[0].version, undefined);
    assert.equal(mj.plugins[0].description, 'Örnek paket');
    const pj = JSON.parse(fs.readFileSync(path.join(mk, 'plugins/ornek/.claude-plugin/plugin.json'), 'utf8'));
    assert.equal(pj.version, '1.2.0'); assert.equal(pj.description, 'Örnek paket');
    assert.equal(JSON.parse(fs.readFileSync(path.join(mk, 'plugins/yayinlanmamis/.claude-plugin/plugin.json'), 'utf8')).version, undefined);
    await undo.rollback();
    assert.equal(fs.existsSync(path.join(mk, 'plugins')), false, 'oluşturulan klasörler geri alındı');
  } finally { rmrf(tmp); }
});
