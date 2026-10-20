'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const FM = require('../public/fm.js');
const Rules = require('../public/rules.js');
const { MarketplaceSettings, SettingsError } = require('../lib/marketplace-settings');
const { PackageService, PackageError } = require('../lib/package-service');
const { tmpDir, rmrf } = require('./helpers');
const { makeLink, removeLink } = require('./links');

const atomicWrite = async (abs, data) => { const t = abs + '.tmp'; await fsp.writeFile(t, data, 'utf8'); await fsp.rename(t, abs); };

/** Summary: Kaynak plugin.json dosyasının mutlak yolu. */
const pluginFile = (d, folder) => path.join(d, 'prompts', folder, '.claude-plugin', 'plugin.json');

/** Summary: Kaynak plugin.json içeriği (nesne). */
const readPlugin = (d, folder) => JSON.parse(fs.readFileSync(pluginFile(d, folder), 'utf8'));

/** Summary: Açıklama yazarken yarım bir dosya bırakıp hata veren ayar saplaması; geri kalan her şey gerçek ayar sınıfıdır. */
const failingSettings = (settings) => ({
  loadStrict: (...args) => settings.loadStrict(...args),
  setPluginDescription: async (dir, lib, folder) => {
    const file = settings.pluginFile(dir, lib, folder);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await atomicWrite(file, '{kismen');
    throw new Error('yazılamadı');
  }
});

function build({ wrap, ...over } = {}) {
  const d = tmpDir();
  const manifest = path.join(d, '.claude-plugin', 'marketplace.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ name: 'm', plugins: [] }, null, 2) + '\n');
  fs.mkdirSync(path.join(d, 'prompts', 'eski', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(d, 'prompts', 'eski', 'a.md'), 'a');
  fs.writeFileSync(pluginFile(d, 'eski'), JSON.stringify({ description: 'Eski aciklama', keywords: ['k'] }, null, 2) + '\n');
  const real = new MarketplaceSettings({ fsp, atomicWrite, Rules, FM });
  const svc = new PackageService({ fsp, atomicWrite, settings: wrap ? wrap(real) : real, Rules, FM, ...over });
  return { d, svc, manifest };
}
const rejectsWith = (p, status, msg) => assert.rejects(p, (e) => { assert.ok(e instanceof PackageError); assert.equal(e.status, status); if (msg) assert.match(e.message, msg); return true; });

test('create: klasör, .gitkeep ve açıklama kaynak plugin.json dosyasına yazılır; açıklamasız plugin dosya yazmaz', async () => {
  const { d, svc, manifest } = build();
  try {
    const before = fs.readFileSync(manifest);
    const r = await svc.create(d, 'prompts', { name: 'Kod İnceleme', description: ' Kodu inceler ' });
    assert.deepEqual(r, { name: 'kod-inceleme', slug: 'kod-inceleme', path: 'prompts/kod-inceleme' });
    assert.ok(fs.existsSync(path.join(d, 'prompts', 'kod-inceleme', '.gitkeep')));
    assert.deepEqual(readPlugin(d, 'kod-inceleme'), { description: 'Kodu inceler' });
    await svc.create(d, 'prompts', { name: 'bos' });
    assert.deepEqual(fs.readdirSync(path.join(d, 'prompts', 'bos')), ['.gitkeep']);
    assert.deepEqual(fs.readFileSync(manifest), before, 'marketplace.json dokunulmadı');
    assert.equal(fs.existsSync(path.join(d, 'pp.config.json')), false);
  } finally { rmrf(d); }
});

test('create: var olan ad 409 (diske dokunmaz), ayrılmış ad 400, boş ad 400', async () => {
  const { d, svc } = build();
  try {
    const before = fs.readFileSync(pluginFile(d, 'eski'));
    await rejectsWith(svc.create(d, 'prompts', { name: 'Eski', description: 'x' }), 409, /^Bu adda bir plugin zaten var: eski$/);
    fs.writeFileSync(path.join(d, 'prompts', 'dosya'), 'x');
    await rejectsWith(svc.create(d, 'prompts', { name: 'dosya' }), 409);
    await rejectsWith(svc.create(d, 'prompts', { name: 'claude-x' }), 400, /Anthropic/);
    await rejectsWith(svc.create(d, 'prompts', { name: 'gelen-kutusu' }), 400, /içe aktarma/);
    await rejectsWith(svc.create(d, 'prompts', { name: 'tools' }), 400, /sistemde ayrılmış/);
    await rejectsWith(svc.create(d, 'prompts', { name: '!!!' }), 400, /^Plugin adı gerekli$/);
    assert.deepEqual(fs.readFileSync(pluginFile(d, 'eski')), before);
    assert.deepEqual(fs.readdirSync(path.join(d, 'prompts')).sort(), ['dosya', 'eski']);
  } finally { rmrf(d); }
});

test('create: açıklama yazılamazsa klasör (yarım plugin.json dahil) silinir', async () => {
  const { d, svc, manifest } = build({ wrap: failingSettings });
  try {
    const before = fs.readFileSync(manifest);
    await rejectsWith(svc.create(d, 'prompts', { name: 'yeni', description: 'a' }), 500, /^Plugin oluşturulamadı: yazılamadı\. Yapılan değişiklikler geri alındı\.$/);
    assert.equal(fs.existsSync(path.join(d, 'prompts', 'yeni')), false);
    assert.deepEqual(fs.readFileSync(manifest), before);
  } finally { rmrf(d); }
});

test('rename: açıklama klasörle birlikte taşınır, dosyalar yeni klasörde', async () => {
  const { d, svc } = build();
  try {
    const r = await svc.rename(d, 'prompts', { from: 'eski', to: 'Yeni Ad' });
    assert.deepEqual(r, { name: 'yeni-ad', slug: 'yeni-ad', path: 'prompts/yeni-ad', moved: 1 });
    assert.ok(fs.existsSync(path.join(d, 'prompts', 'yeni-ad', 'a.md')));
    assert.equal(fs.existsSync(path.join(d, 'prompts', 'eski')), false);
    assert.deepEqual(readPlugin(d, 'yeni-ad'), { description: 'Eski aciklama', keywords: ['k'] });
    assert.equal(fs.existsSync(path.join(d, 'pp.config.json')), false);
  } finally { rmrf(d); }
});

test('rename: hata durumları', async () => {
  const { d, svc } = build();
  try {
    fs.mkdirSync(path.join(d, 'prompts', 'baska'));
    await rejectsWith(svc.rename(d, 'prompts', { from: 'yok', to: 'x' }), 404, /^Plugin bulunamadı: yok$/);
    await rejectsWith(svc.rename(d, 'prompts', { from: '../x', to: 'x' }), 404);
    await rejectsWith(svc.rename(d, 'prompts', { from: 'eski', to: 'Eski' }), 400, /^Yeni ad eskisiyle aynı$/);
    await rejectsWith(svc.rename(d, 'prompts', { from: 'eski', to: 'baska' }), 409, /^Bu adda bir plugin zaten var: baska$/);
    await rejectsWith(svc.rename(d, 'prompts', { from: 'eski', to: 'claude-x' }), 400);
  } finally { rmrf(d); }
});

test('hata iletisi işleme göre: create "oluşturulamadı", rename "yeniden adlandırılamadı"', async () => {
  const a = build({ wrap: failingSettings });
  try {
    await rejectsWith(a.svc.create(a.d, 'prompts', { name: 'yeni', description: 'a' }), 500, /^Plugin oluşturulamadı: yazılamadı\. Yapılan değişiklikler geri alındı\.$/);
  } finally { rmrf(a.d); }
  const failRename = { ...fsp, rename: async () => { throw new Error('yazılamadı'); } };
  const b = build({ fsp: failRename });
  try {
    await assert.rejects(b.svc.rename(b.d, 'prompts', { from: 'eski', to: 'yeni' }), (e) => {
      assert.ok(e instanceof PackageError);
      assert.equal(e.status, 500);
      assert.equal(e.message, 'Plugin yeniden adlandırılamadı: yazılamadı. Yapılan değişiklikler geri alındı.');
      assert.equal(e.data, undefined);
      return true;
    });
    assert.ok(fs.existsSync(path.join(b.d, 'prompts', 'eski', 'a.md')), 'klasör yerinde');
  } finally { rmrf(b.d); }
});

test('create: geri alma da başarısız olursa ileti işlem adı taşımaz, rollbackFailed verisi korunur', async () => {
  const flaky = { ...fsp, rm: async () => { throw new Error('geri alinamadi'); } };
  const { d, svc } = build({ fsp: flaky, wrap: failingSettings });
  try {
    await assert.rejects(svc.create(d, 'prompts', { name: 'yeni', description: 'a' }), (e) => {
      assert.ok(e instanceof PackageError);
      assert.equal(e.status, 500);
      assert.equal(e.message, 'Plugin işlemi başarısız ve geri alma tamamlanamadı: geri alinamadi. Klasörü elle kontrol et.');
      assert.deepEqual(e.data, { rollbackFailed: true });
      return true;
    });
  } finally { rmrf(d); }
});

test('rename: yalnızca büyük/küçük harf farkı (Windows dahil) [doğrulandı]',async () => {
  const { d, svc } = build();
  try {
    fs.mkdirSync(path.join(d, 'prompts', 'Kod'));
    fs.writeFileSync(path.join(d, 'prompts', 'Kod', 'k.md'), 'k');
    const r = await svc.rename(d, 'prompts', { from: 'Kod', to: 'kod' });
    assert.equal(r.slug, 'kod'); assert.equal(r.moved, 1);
    assert.ok(fs.readdirSync(path.join(d, 'prompts')).includes('kod'), 'diskteki ad gerçekten küçük harfli: ' + fs.readdirSync(path.join(d, 'prompts')));
    assert.ok(!fs.readdirSync(path.join(d, 'prompts')).includes('Kod'));
    assert.ok(fs.existsSync(path.join(d, 'prompts', 'kod', 'k.md')));
    assert.ok(!fs.readdirSync(path.join(d, 'prompts')).some((n) => n.startsWith('.pp-rename')));
  } finally { rmrf(d); }
});

test('bozuk dosyalar: marketplace.json plugin işlemlerini engellemez; bozuk plugin.json açıklama yazmayı 409 pluginJsonBozuk ile reddeder, bayt aynı', async () => {
  const conflict = (p, code) => assert.rejects(p, (e) => {
    assert.ok(e instanceof SettingsError, 'SettingsError bekleniyordu: ' + e.name + ' ' + e.message);
    assert.equal(e.status, 409); assert.equal(e.data.code, code);
    return true;
  });
  {
    const { d, svc, manifest } = build();
    try {
      fs.writeFileSync(manifest, 'garip{');
      await svc.create(d, 'prompts', { name: 'yeni', description: 'a' });
      assert.deepEqual(readPlugin(d, 'yeni'), { description: 'a' });
      await svc.rename(d, 'prompts', { from: 'yeni', to: 'yeni2' });
      assert.deepEqual(await svc.setDescription(d, 'prompts', { name: 'yeni2', description: 'b' }), { ok: true });
      assert.equal(fs.readFileSync(manifest, 'utf8'), 'garip{', 'marketplace.json bayt aynı');
    } finally { rmrf(d); }
  }
  for (const bad of ['garip{', 'null', '[]', '"x"', '5']) {
    const { d, svc } = build();
    try {
      fs.writeFileSync(pluginFile(d, 'eski'), bad);
      await conflict(svc.setDescription(d, 'prompts', { name: 'eski', description: 'x' }), 'pluginJsonBozuk');
      assert.equal(fs.readFileSync(pluginFile(d, 'eski'), 'utf8'), bad);
      assert.deepEqual(fs.readdirSync(path.join(d, 'prompts')), ['eski']);
    } finally { rmrf(d); }
  }
});

test('prompts/ marketplace dışına bağlıysa create/rename/setDescription 409 libraryDirGecersiz; dışarıya yazılmaz', async (t) => {
  const { d, svc } = build();
  const out = tmpDir();
  const link = path.join(d, 'prompts');
  try {
    fs.rmSync(link, { recursive: true, force: true });
    if (!makeLink(out, link)) return t.skip('bağlantı kurulamadı (EPERM)');
    const conflict = (p) => assert.rejects(p, (e) => { assert.ok(e instanceof SettingsError); assert.equal(e.status, 409); assert.equal(e.data.code, 'libraryDirGecersiz'); return true; });
    await conflict(svc.create(d, 'prompts', { name: 'yeni', description: 'a' }));
    await conflict(svc.rename(d, 'prompts', { from: 'eski', to: 'yeni' }));
    await conflict(svc.setDescription(d, 'prompts', { name: 'eski', description: 'x' }));
    assert.deepEqual(fs.readdirSync(out), [], 'bağlantının hedefine hiçbir şey yazılmadı');
  } finally { removeLink(link); rmrf(d); rmrf(out); }
});

test('setDescription: plugin yoksa 404, boşsa 400, başarıda plugin.json yazılır ve diğer anahtarlar korunur', async () => {
  const { d, svc } = build();
  try {
    await rejectsWith(svc.setDescription(d, 'prompts', { name: 'yok', description: 'x' }), 404, /^Plugin bulunamadı: yok$/);
    await rejectsWith(svc.setDescription(d, 'prompts', { name: 'eski', description: '  ' }), 400, /^Paket açıklaması boş olamaz$/);
    assert.deepEqual(await svc.setDescription(d, 'prompts', { name: 'eski', description: 'Yeni' }), { ok: true });
    assert.deepEqual(readPlugin(d, 'eski'), { description: 'Yeni', keywords: ['k'] });
  } finally { rmrf(d); }
});

/** Summary: Kaynak marketplace'in .pp/trash klasörüne taşıyan çöp saplaması (sunucudaki toTrash ile aynı biçim). */
const trashInto = (dir) => async (rel, abs) => {
  const dest = path.join(dir, '.pp', 'trash', 'ts', rel);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rename(abs, dest);
  return path.relative(dir, dest).split(path.sep).join('/');
};

/** Summary: Kaynak (eski plugin'li) ve boş hedef marketplace kurar; taşıma bağımlılıkları enjekte edilir. */
function buildMove(over = {}) {
  const holder = {};
  const src = build({ toTrash: (rel, abs) => trashInto(holder.d)(rel, abs), isInside: require('../lib/paths').isInside, checkNewPath: require('../lib/safe-path').checkNewPath, ...over });
  holder.d = src.d;
  const dst = tmpDir();
  fs.mkdirSync(path.join(dst, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(src.d, 'prompts', 'eski', '.gitkeep'), '');
  fs.mkdirSync(path.join(src.d, 'prompts', 'eski', 'alt'));
  fs.writeFileSync(path.join(src.d, 'prompts', 'eski', 'alt', 'b.md'), '---\nbaslik: B\n---\nİçerik\r\n');
  return { ...src, dst, move: () => src.svc.move({ src: { dir: src.d, libraryDir: 'prompts', name: 'eski' }, dst: { dir: dst, libraryDir: 'prompts' } }) };
}

test('move: dosyalar, .gitkeep ve klasördeki plugin.json (açıklama) bayt aynı hedefe kopyalanır, kaynak çöpe gider', async () => {
  const { d, dst, move } = buildMove();
  try {
    const before = fs.readFileSync(pluginFile(d, 'eski'));
    const r = await move();
    assert.deepEqual({ ...r, trash: undefined }, { name: 'eski', slug: 'eski', path: 'prompts/eski', moved: 2, trash: undefined });
    assert.deepEqual(fs.readFileSync(pluginFile(dst, 'eski')), before, 'açıklama klasörle birlikte taşındı');
    assert.deepEqual(fs.readFileSync(path.join(dst, 'prompts', 'eski', 'alt', 'b.md')), Buffer.from('---\nbaslik: B\n---\nİçerik\r\n'));
    assert.equal(fs.readFileSync(path.join(dst, 'prompts', 'eski', 'a.md'), 'utf8'), 'a');
    assert.ok(fs.existsSync(path.join(dst, 'prompts', 'eski', '.gitkeep')));
    assert.equal(fs.existsSync(path.join(d, 'prompts', 'eski')), false);
    assert.ok(fs.existsSync(path.join(d, r.trash, '.claude-plugin', 'plugin.json')), 'kaynak yedeği .pp/trash altında');
    assert.equal(fs.existsSync(path.join(d, 'pp.config.json')) || fs.existsSync(path.join(dst, 'pp.config.json')), false);
  } finally { rmrf(d); }
});

test('move: hedefte aynı slug 409 pluginVar, plugin içinde bağlantı ya da .git 400 baglantiVar, dışarı çıkan hedef 400; iki taraf diskte değişmez', async (t) => {
  const { d, dst, move } = buildMove();
  const out = tmpDir();
  try {
    const snapshot = () => JSON.stringify([fs.readdirSync(path.join(d, 'prompts', 'eski')).sort(), fs.existsSync(path.join(dst, 'prompts'))]);
    const before = snapshot();
    fs.mkdirSync(path.join(dst, 'prompts', 'ESKI'), { recursive: true });
    await assert.rejects(move(), (e) => { assert.ok(e instanceof PackageError); assert.equal(e.status, 409); assert.equal(e.data.code, 'pluginVar'); return true; });
    assert.deepEqual(fs.readdirSync(path.join(dst, 'prompts')), ['ESKI']);
    fs.rmdirSync(path.join(dst, 'prompts', 'ESKI'));
    fs.mkdirSync(path.join(d, 'prompts', 'eski', '.git'));
    await assert.rejects(move(), (e) => { assert.equal(e.status, 400); assert.equal(e.data.code, 'baglantiVar'); assert.match(e.message, /\.git$/); return true; });
    fs.rmdirSync(path.join(d, 'prompts', 'eski', '.git'));
    const link = path.join(d, 'prompts', 'eski', 'alt', 'dis');
    if (makeLink(out, link)) {
      await assert.rejects(move(), (e) => { assert.equal(e.status, 400); assert.equal(e.data.code, 'baglantiVar'); return true; });
      removeLink(link);
    } else t.diagnostic('bağlantı kurulamadı (EPERM): baglantiVar bağlantı kolu atlandı');
    fs.rmSync(path.join(dst, 'prompts'), { recursive: true, force: true });
    assert.equal(snapshot(), before);
    const hostile = path.join(dst, 'prompts');
    if (makeLink(out, hostile)) {
      await assert.rejects(move(), (e) => { assert.ok(e.status === 400 || e.status === 409); return true; });
      assert.deepEqual(fs.readdirSync(out), [], 'bağlantının hedefine hiçbir şey yazılmadı');
      removeLink(hostile);
    }
  } finally { rmrf(d); rmrf(dst); rmrf(out); }
});

test('move: çöpe taşıma hata verirse hedef kopya (ve oluşan prompts/) silinir, kaynak ve plugin.json bayt aynı kalır', async () => {
  const failTrash = { toTrash: async () => { throw new Error('çöp yazılamadı'); } };
  const { d, dst, move } = buildMove(failTrash);
  try {
    const before = fs.readFileSync(pluginFile(d, 'eski'));
    await assert.rejects(move(), (e) => {
      assert.ok(e instanceof PackageError);
      assert.equal(e.status, 500);
      assert.equal(e.message, 'Plugin taşınamadı: çöp yazılamadı. Yapılan değişiklikler geri alındı.');
      return true;
    });
    assert.equal(fs.existsSync(path.join(dst, 'prompts')), false, 'hedefte hiçbir şey kalmadı');
    assert.deepEqual(fs.readFileSync(pluginFile(d, 'eski')), before);
    assert.ok(fs.existsSync(path.join(d, 'prompts', 'eski', 'alt', 'b.md')), 'kaynak yerinde');
  } finally { rmrf(d); rmrf(dst); }
});
