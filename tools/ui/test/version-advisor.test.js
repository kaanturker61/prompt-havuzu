'use strict';
/* VersionAdvisor: taban seçimi, seviye hesabı, prompt tag durumu. Gerçek geçici repo. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { gitAvailable, tmpDir, rmrf, gitEnv, sh } = require('./helpers');
const { seed, write, cmd, commitAll, buildStack } = require('./stack');
const { UndoStack } = require('../lib/undo');

const real = { skip: !gitAvailable && 'git yok' };

async function analyze(s, name = 'ornek') {
  const cfg = await s.config.load();
  const built = await s.catalog.build(cfg);
  return s.advisor.analyze(s.mk, built.packages.get(name), cfg);
}

test('taban yok: ilk sürüm 1.0.0', real, async () => {
  const tmp = tmpDir();
  try {
    const s = buildStack(seed(tmp), tmp);
    const a = await analyze(s);
    assert.equal(a.base.kind, null); assert.equal(a.version, '1.0.0'); assert.equal(a.level, null);
    assert.deepEqual(a.reasons, ['İlk yayın']);
    assert.equal(a.prompts.length, 2); assert.ok(a.prompts.every((p) => p.change === 'yeni'));
  } finally { rmrf(tmp); }
});

test('eski yayın (plugin.json 1.0.1, etiket yok): tagOnly; sonra etiket yayını', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    const s = buildStack(mk, tmp);
    // eski yöntemle üretilmiş çıktı + sürümlü plugin.json commit'lenir
    const cfg = await s.config.load();
    const built = await s.catalog.build(cfg);
    const undo = new UndoStack();
    await s.exporter.apply(s.exporter.plan('ornek', built.packages.get('ornek').prompts, built.scanned), undo);
    await s.manifests.writePluginJson('ornek', cfg, { version: '1.0.1' }, undo);
    undo.clear();
    commitAll(mk, tmp);
    const a = await analyze(s);
    assert.equal(a.base.kind, 'head'); assert.equal(a.base.headVersion, '1.0.1');
    assert.equal(a.tagOnly, true); assert.equal(a.version, '1.0.1'); assert.equal(a.noChange, false);
    assert.equal(s.advisor.validateChoice(a, '1.0.1'), null, 'tagOnly: eşitlik kabul');
    const r = await s.publisher.publish(mk, { name: 'ornek' });
    assert.equal(r.version, '1.0.1'); assert.equal(r.tag, 'paket/ornek/v1.0.1');
    const a2 = await analyze(s);
    assert.equal(a2.base.kind, 'tag'); assert.equal(a2.noChange, true); assert.equal(a2.level, null);
    assert.equal(s.advisor.validateChoice(a2, '1.0.2').code, 'degisiklikYok');
  } finally { rmrf(tmp); }
});

test('seviyeler: yeni prompt küçük, versiyon artışı büyük, komut adı değişimi büyük', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    write(mk, 'prompts/ornek/a.md', cmd('A', 'komut_adi: aa\nversiyon: 1.0.0\n'));
    commitAll(mk, tmp);
    const s = buildStack(mk, tmp);
    await s.publisher.publish(mk, { name: 'ornek' });

    write(mk, 'prompts/ornek/c.md', cmd('C'));
    commitAll(mk, tmp);
    let a = await analyze(s);
    assert.equal(a.level, 'kucuk'); assert.equal(a.version, '1.1.0'); assert.equal(a.base.version, '1.0.0');
    assert.equal(a.prompts.find((p) => p.ad === 'c').change, 'yeni');
    assert.equal(a.prompts.find((p) => p.ad === 'aa').change, 'ayni');
    assert.equal(s.advisor.validateChoice(a, '1.0.0').code, 'surumGeride');
    assert.equal(s.advisor.validateChoice(a, '1.0').code, 'surumGecersiz');
    await s.publisher.publish(mk, { name: 'ornek' });

    // versiyon 1.0.0 -> 2.0.0 ve gövde değişti
    write(mk, 'prompts/ornek/a.md', '---\nbaslik: A\ntur: komut\nkomut_adi: aa\nversiyon: 2.0.0\n---\nyeni gövde\n');
    commitAll(mk, tmp);
    a = await analyze(s);
    const pa = a.prompts.find((p) => p.ad === 'aa');
    assert.equal(pa.change, 'degisti'); assert.equal(pa.oldVersiyon, '1.0.0'); assert.equal(pa.level, 'buyuk');
    assert.equal(a.level, 'buyuk'); assert.equal(a.version, '2.0.0');
    await s.publisher.publish(mk, { name: 'ornek' });

    // komut adı değişti: eski hedef kaldırılır (büyük)
    write(mk, 'prompts/ornek/b.md', cmd('B', 'komut_adi: yenib\n'));
    commitAll(mk, tmp);
    a = await analyze(s);
    assert.deepEqual(a.removed.map((r) => r.target), ['plugins/ornek/commands/bb.md']);
    assert.equal(a.prompts.find((p) => p.ad === 'yenib').change, 'yeni');
    assert.equal(a.level, 'buyuk'); assert.equal(a.version, '3.0.0');
  } finally { rmrf(tmp); }
});

test('aynı versiyon + farklı içerik: yama ve surumArtirilmamis; etiketler değişince değişiklik yok; açıklama yama', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    const s = buildStack(mk, tmp);
    await s.publisher.publish(mk, { name: 'ornek' });
    write(mk, 'prompts/ornek/a.md', cmd('A', 'komut_adi: aa\netiketler: [x, y]\n'));
    commitAll(mk, tmp);
    let a = await analyze(s);
    assert.equal(a.noChange, true, 'yalnızca etiketler değişti');
    write(mk, 'prompts/ornek/a.md', '---\nbaslik: A\ntur: komut\nkomut_adi: aa\n---\nDEGISTI\n');
    commitAll(mk, tmp);
    a = await analyze(s);
    const pa = a.prompts.find((p) => p.ad === 'aa');
    assert.equal(pa.level, 'yama');
    assert.ok(pa.issues.some((i) => i.code === 'surumArtirilmamis' && /Yama sayılacak/.test(i.msg)));
    assert.equal(a.version, '1.0.1');
    await s.publisher.publish(mk, { name: 'ornek' });
    // yalnızca açıklama
    write(mk, 'prompts/ornek/.claude-plugin/plugin.json', JSON.stringify({ description: 'Yeni açıklama' }, null, 2) + '\n');
    commitAll(mk, tmp);
    a = await analyze(s);
    assert.equal(a.descChanged, true); assert.equal(a.level, 'yama'); assert.equal(a.version, '1.0.2');
    // açıklama değişikliği yayında plugin.json'a yansır
    await s.publisher.publish(mk, { name: 'ornek' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(mk, 'plugins/ornek/.claude-plugin/plugin.json'), 'utf8')).description, 'Yeni açıklama');
  } finally { rmrf(tmp); }
});

test('HEAD\'den ulaşılamayan daha yüksek tag tabanı etkilemez', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    const s = buildStack(mk, tmp);
    await s.publisher.publish(mk, { name: 'ornek' });
    const orphan = sh(mk, ['commit-tree', 'HEAD^{tree}', '-m', 'baska dal'], gitEnv(tmp)).trim();
    sh(mk, ['tag', 'paket/ornek/v9.0.0', orphan], gitEnv(tmp));
    const a = await analyze(s);
    assert.equal(a.base.kind, 'tag'); assert.equal(a.base.version, '1.0.0'); assert.equal(a.base.tag, 'paket/ornek/v1.0.0');
    assert.equal(a.base.tags[0].version, '9.0.0', 'tags listesi hepsini içerir (lastTag için)');
  } finally { rmrf(tmp); }
});

test('prompt tag durumu: VersionService.bump ile etiketli tagged:true, eksik false, versiyonsuz null', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    const s = buildStack(mk, tmp);
    const abs = path.join(mk, 'prompts', 'ornek', 'a.md');
    await s.versions.bump(mk, 'prompts', { rel: 'prompts/ornek/a.md', abs, level: 'yama', note: 'ilk' });
    write(mk, 'prompts/ornek/b.md', cmd('B', 'komut_adi: bb\nversiyon: 1.0.0\n'));
    commitAll(mk, tmp);
    const a = await analyze(s);
    assert.equal(a.prompts.find((p) => p.ad === 'aa').tagged, true);
    assert.equal(a.prompts.find((p) => p.ad === 'bb').tagged, false);
    write(mk, 'prompts/ornek/c.md', cmd('C'));
    commitAll(mk, tmp);
    assert.equal((await analyze(s)).prompts.find((p) => p.ad === 'c').tagged, null);
    // içerik değişip versiyon aynıysa (surumGuncelDegil) tagged false
    write(mk, 'prompts/ornek/a.md', fs.readFileSync(abs, 'utf8') + '\nek satır\n');
    commitAll(mk, tmp);
    assert.equal((await analyze(s)).prompts.find((p) => p.ad === 'aa').tagged, false);
  } finally { rmrf(tmp); }
});

test('sürüm bileşeni üst sınırdayken öneri üretilmez: version boş, reasons notu (B-13)', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    const s = buildStack(mk, tmp);
    await s.publisher.publish(mk, { name: 'ornek', version: '1.1.999999999' });
    write(mk, 'prompts/ornek/a.md', '---\nbaslik: A\ntur: komut\nkomut_adi: aa\n---\nDEGISTI\n');
    commitAll(mk, tmp);
    const a = await analyze(s);
    assert.equal(a.level, 'yama');
    assert.ok(!a.version, 'öneri yok: ' + a.version);
    assert.ok(a.reasons.some((r) => /üst sınıra ulaştı/.test(r)), JSON.stringify(a.reasons));
    assert.ok(!JSON.stringify(a).includes('e+'), 'bilimsel gösterim hiçbir yerde yok');
    // yayın sürümü boş bırakılırsa geçersiz sürüm olarak reddedilir (null etiket üretilmez)
    await assert.rejects(s.publisher.publish(mk, { name: 'ornek' }), (e) => e.status === 400 && e.data.code === 'surumGecersiz');
    assert.equal(sh(mk, ['tag', '-l', 'paket/ornek/*'], gitEnv(tmp)).trim(), 'paket/ornek/v1.1.999999999');
  } finally { rmrf(tmp); }
});
