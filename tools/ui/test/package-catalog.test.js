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

test('scanPluginFiles: sembolik bağlantı dosya ve klasörleri bileşen sayılmaz', real, async (t) => {
  const { makeLink, removeLink } = require('./links');
  const tmp = tmpDir();
  const out = path.join(tmp, 'dis'); fs.mkdirSync(path.join(out, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(out, 'gizli.md'), 'DIS'); fs.writeFileSync(path.join(out, 'agents', 'a.md'), 'DIS');
  fs.mkdirSync(path.join(out, 'skill-x')); fs.writeFileSync(path.join(out, 'skill-x', 'SKILL.md'), 'DIS');
  const links = [];
  try {
    const mk = seed(tmp);
    write(mk, 'plugins/ornek/commands/gercek.md', 'g');
    write(mk, 'plugins/ornek/skills/ok/SKILL.md', 's');
    fs.mkdirSync(path.join(mk, 'plugins', 'ornek', 'skills'), { recursive: true });
    const fileLink = path.join(mk, 'plugins', 'ornek', 'commands', 'bag.md');
    const agentsLink = path.join(mk, 'plugins', 'ornek', 'agents');
    const skillLink = path.join(mk, 'plugins', 'ornek', 'skills', 'bag');
    const pkgLink = path.join(mk, 'plugins', 'bagpkg');
    if (!makeLink(path.join(out, 'agents'), agentsLink)) return t.skip('bağlantı kurulamadı (EPERM)');
    links.push(agentsLink);
    makeLink(path.join(out, 'gizli.md'), fileLink, 'file'); links.push(fileLink);
    makeLink(path.join(out, 'skill-x'), skillLink); links.push(skillLink);
    makeLink(out, pkgLink); links.push(pkgLink);
    const s = buildStack(mk, tmp);
    const scanned = await s.exporter.scanPluginFiles();
    assert.deepEqual(scanned.map((x) => x.target).sort(), ['plugins/ornek/commands/gercek.md', 'plugins/ornek/skills/ok/SKILL.md']);
    // yayın dışı çıktılar: bağlantılar orphan ya da kaldırma listesine girmez
    const built = await s.catalog.build(await s.config.load());
    assert.ok(!built.orphans.some((o) => /bag|agents|gizli/.test(o.target)), JSON.stringify(built.orphans));
  } finally { links.forEach(removeLink); rmrf(tmp); }
});

const GOLD_SOURCES = {
  komut: '---\nbaslik: Kod Gözden Geçir\ntur: komut\naciklama: Kodu gözden geçir\narguman_ipucu: "[x]"\nizinli_araclar: [Bash(git diff:*), Read]\nmodel: sonnet\n---\nGövde komut\n',
  ajan: '---\nbaslik: Ajan Örnek\ntur: ajan\nizinli_araclar: Read, Grep\n---\nGövde ajan\n',
  skill: '---\nbaslik: Beceri\ntur: skill\nkomut_adi: "Kod İnceleme"\naciklama: "Kod: gözden geçir"\narguman_ipucu: [dosya]\nizinli_araclar: [Read, Grep]\nmodel: opus\n---\nGövde skill\n'
};
const GOLD_OUTPUT = {
  'plugins/ornek/commands/gk.md': '---\ndescription: Kodu gözden geçir\nargument-hint: "[x]"\nallowed-tools: Bash(git diff:*), Read\nmodel: sonnet\n---\nGövde komut\n',
  'plugins/ornek/agents/gj.md': '---\nname: gj\ndescription: Ajan Örnek\ntools: Read, Grep\n---\nGövde ajan\n',
  'plugins/ornek/skills/kod-inceleme/SKILL.md': '---\nname: kod-inceleme\ndescription: "Kod: gözden geçir"\nargument-hint: dosya\nallowed-tools: Read, Grep\nmodel: opus\n---\nGövde skill\n'
};

test('altın çıktı: eski Türkçe alanlı komut, ajan ve skill çıktısı bayt bayt kilitli', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    write(mk, 'prompts/ornek/gk.md', GOLD_SOURCES.komut);
    write(mk, 'prompts/ornek/gj.md', GOLD_SOURCES.ajan);
    write(mk, 'prompts/ornek/gs.md', GOLD_SOURCES.skill);
    const s = buildStack(mk, tmp);
    const built = await s.catalog.build(await s.config.load());
    for (const src of ['gk', 'gj', 'gs']) {
      const p = built.bySource.get(`prompts/ornek/${src}.md`);
      assert.equal(p.expected, GOLD_OUTPUT[p.target], p.target);
    }
  } finally { rmrf(tmp); }
});

test('İngilizce anahtarlar aynı çıktıyı üretir; yeni alanlar türe göre sırayla, doğru biçimde yazılır', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    write(mk, 'prompts/ornek/gk.md', '---\nbaslik: Kod Gözden Geçir\ntur: komut\ndescription: Kodu gözden geçir\nargument-hint: "[x]"\nallowed-tools: [Bash(git diff:*), Read]\nmodel: sonnet\n---\nGövde komut\n');
    write(mk, 'prompts/ornek/gj.md', '---\nbaslik: Ajan Örnek\ntur: ajan\ntools: Read, Grep\n---\nGövde ajan\n');
    write(mk, 'prompts/ornek/gs.md', '---\nbaslik: Beceri\ntur: skill\nname: "Kod İnceleme"\ndescription: "Kod: gözden geçir"\nargument-hint: [dosya]\nallowed-tools: [Read, Grep]\nmodel: opus\n---\nGövde skill\n');
    write(mk, 'prompts/ornek/ns.md', '---\nbaslik: Yeni Beceri\ntur: skill\ndescription: Yeni\nmetadata:\n  eski: 1\nwhen_to_use: Bir şey olunca\ndisable-model-invocation: true\nuser-invocable: no\neffort: low\npaths: ["src/**/*.{ts,tsx}", "lib/**"]\narguments: dosya hedef\nhooks:\n  PreToolUse:\n    - matcher: Bash\n\n      hooks:\n        - type: command\nmetadata:\n  author: ben\n---\nGövde\n');
    write(mk, 'prompts/ornek/na.md', '---\nbaslik: Yeni Ajan\ntur: ajan\ndescription: Ajan açıklaması\ntools: Read, Grep\nmaxTurns: 5\nskills: a, b\nmemory: project\nbackground: TRUE\npermissionMode: plan\nhooks:\n  Stop:\n    - hooks: []\nallowed-tools: Bash\nexperimental:\n  cacheTtl: 1h\n---\nGövde\n');
    write(mk, 'prompts/ornek/nk.md', '---\nbaslik: Komut\ntur: komut\nname: ozel-ad\ndescription: K\npaths: [x]\narguments: [a, b]\nwhen_to_use: Ne zaman\nhooks:\nmetadata:\n  a: 1\nexperimental: x\n---\nGövde\n');
    const s = buildStack(mk, tmp);
    const built = await s.catalog.build(await s.config.load());
    for (const src of ['gk', 'gj', 'gs']) {
      const p = built.bySource.get(`prompts/ornek/${src}.md`);
      assert.equal(p.expected, GOLD_OUTPUT[p.target], p.target);
    }
    assert.equal(built.bySource.get('prompts/ornek/ns.md').expected,
      '---\nname: ns\ndescription: Yeni\nwhen_to_use: Bir şey olunca\narguments: dosya hedef\ndisable-model-invocation: true\nuser-invocable: false\neffort: low\n'
      + 'paths: ["src/**/*.{ts,tsx}", lib/**]\nhooks:\n  PreToolUse:\n    - matcher: Bash\n\n      hooks:\n        - type: command\nmetadata:\n  author: ben\n---\nGövde\n');
    assert.equal(built.bySource.get('prompts/ornek/na.md').expected,
      '---\nname: na\ndescription: Ajan açıklaması\ntools: Read, Grep\nmaxTurns: 5\nskills: [a, b]\nmemory: project\nbackground: true\nexperimental:\n  cacheTtl: 1h\n---\nGövde\n');
    const nk = built.bySource.get('prompts/ornek/nk.md');
    assert.equal(nk.target, 'plugins/ornek/commands/ozel-ad.md');
    assert.equal(nk.expected, '---\ndescription: K\nwhen_to_use: Ne zaman\narguments: [a, b]\nmetadata:\n  a: 1\n---\nGövde\n');
    assert.equal(s.catalog.blocking(built.packages.get('ornek')).length, 0);
  } finally { rmrf(tmp); }
});

test('komut_adi CON -> aygitAdi (error), paket engellenir; diğer paketler etkilenmez', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    write(mk, 'prompts/ornek/konsol.md', cmd('Con', 'komut_adi: CON\n'));
    write(mk, 'prompts/ornek/bos.md', cmd('N', 'komut_adi: nul\n'));
    write(mk, 'prompts/temiz/t.md', cmd('T', 'komut_adi: tt\n'));
    const s = buildStack(mk, tmp);
    const built = await s.catalog.build(await s.config.load());
    const ornek = built.packages.get('ornek');
    const block = s.catalog.blocking(ornek);
    assert.deepEqual(block.map((b) => [b.code, b.source]).sort(), [['aygitAdi', 'prompts/ornek/bos.md'], ['aygitAdi', 'prompts/ornek/konsol.md']]);
    assert.equal(block[0].level, 'error');
    assert.match(block[0].msg, /Windows aygıt adı/);
    const row = ornek.prompts.find((p) => p.source === 'prompts/ornek/konsol.md');
    const iss = row.issues.find((i) => i.code === 'aygitAdi');
    assert.equal(iss.level, 'error'); assert.equal(iss.msg, '"con" bir Windows aygıt adı; dosya, klasör veya plugin adı olarak kullanılamaz. Başka bir ad seç.');
    assert.equal(s.catalog.blocking(built.packages.get('temiz')).length, 0);
    const b2 = await s.catalog.build(await s.config.load());
    // bilinçli tasarım: BLOCKING_SKIP ve publishPlan biçimi değişmedi
    assert.ok(Array.isArray(b2.plans) && Array.isArray(b2.skipped) && Array.isArray(b2.orphans) && b2.packages instanceof Map);
  } finally { rmrf(tmp); }
});
