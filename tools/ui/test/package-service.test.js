'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const FM = require('../public/fm.js');
const Rules = require('../public/rules.js');
const ppConfig = require('../lib/pp-config');
const { PackageService, PackageError } = require('../lib/package-service');
const { tmpDir, rmrf } = require('./helpers');

const atomicWrite = async (abs, data) => { const t = abs + '.tmp'; await fsp.writeFile(t, data, 'utf8'); await fsp.rename(t, abs); };

function build(over = {}) {
  const d = tmpDir();
  const cfgFile = path.join(d, 'pp.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ libraryDir: 'prompts', marketplace: { name: 'm', plugin: 'm' }, packages: { eski: { description: 'Eski aciklama' } } }, null, 2) + '\n');
  fs.mkdirSync(path.join(d, 'prompts', 'eski'), { recursive: true });
  fs.writeFileSync(path.join(d, 'prompts', 'eski', 'a.md'), 'a');
  const svc = new PackageService({
    fsp, atomicWrite, loadConfigAt: ppConfig.loadConfigAt, saveConfigAt: ppConfig.saveConfigAt, Rules, FM, ...over
  });
  return { d, svc, cfgFile };
}
const rejectsWith = (p, status, msg) => assert.rejects(p, (e) => { assert.ok(e instanceof PackageError); assert.equal(e.status, status); if (msg) assert.match(e.message, msg); return true; });

test('create: klasör, .gitkeep ve açıklama yazılır', async () => {
  const { d, svc, cfgFile } = build();
  try {
    const r = await svc.create(d, 'prompts', { name: 'Kod İnceleme', description: ' Kodu inceler ' });
    assert.deepEqual(r, { name: 'kod-inceleme', slug: 'kod-inceleme', path: 'prompts/kod-inceleme' });
    assert.ok(fs.existsSync(path.join(d, 'prompts', 'kod-inceleme', '.gitkeep')));
    assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).packages['kod-inceleme'].description, 'Kodu inceler');
    // açıklamasız: config dokunulmaz
    const before = fs.readFileSync(cfgFile);
    await svc.create(d, 'prompts', { name: 'bos' });
    assert.deepEqual(fs.readFileSync(cfgFile), before);
  } finally { rmrf(d); }
});

test('create: var olan ad 409 (diske dokunmaz), ayrılmış ad 400, boş ad 400', async () => {
  const { d, svc, cfgFile } = build();
  try {
    const before = fs.readFileSync(cfgFile);
    await rejectsWith(svc.create(d, 'prompts', { name: 'Eski', description: 'x' }), 409, /^Bu adda bir plugin zaten var: eski$/);
    fs.writeFileSync(path.join(d, 'prompts', 'dosya'), 'x');
    await rejectsWith(svc.create(d, 'prompts', { name: 'dosya' }), 409);
    await rejectsWith(svc.create(d, 'prompts', { name: 'claude-x' }), 400, /Anthropic/);
    await rejectsWith(svc.create(d, 'prompts', { name: 'gelen-kutusu' }), 400, /içe aktarma/);
    await rejectsWith(svc.create(d, 'prompts', { name: 'tools' }), 400, /sistemde ayrılmış/);
    await rejectsWith(svc.create(d, 'prompts', { name: '!!!' }), 400, /^Plugin adı gerekli$/);
    assert.deepEqual(fs.readFileSync(cfgFile), before);
    assert.deepEqual(fs.readdirSync(path.join(d, 'prompts')).sort(), ['dosya', 'eski']);
  } finally { rmrf(d); }
});

test('create: saveConfigAt hatasında klasör silinir, pp.config.json bayt bayt aynı kalır', async () => {
  const { d, svc, cfgFile } = build({
    saveConfigAt: async (dir, c, aw) => { await aw(path.join(dir, 'pp.config.json'), '{kismen'); throw new Error('disk dolu'); }
  });
  try {
    const before = fs.readFileSync(cfgFile);
    await rejectsWith(svc.create(d, 'prompts', { name: 'yeni', description: 'a' }), 500, /^Plugin oluşturulamadı: disk dolu\. Yapılan değişiklikler geri alındı\.$/);
    assert.equal(fs.existsSync(path.join(d, 'prompts', 'yeni')), false);
    assert.deepEqual(fs.readFileSync(cfgFile), before);
  } finally { rmrf(d); }
});

test('rename: açıklama taşınır, dosyalar yeni klasörde', async () => {
  const { d, svc, cfgFile } = build();
  try {
    const r = await svc.rename(d, 'prompts', { from: 'eski', to: 'Yeni Ad' });
    assert.deepEqual(r, { name: 'yeni-ad', slug: 'yeni-ad', path: 'prompts/yeni-ad', moved: 1 });
    assert.ok(fs.existsSync(path.join(d, 'prompts', 'yeni-ad', 'a.md')));
    assert.equal(fs.existsSync(path.join(d, 'prompts', 'eski')), false);
    const pk = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).packages;
    assert.equal(pk['yeni-ad'].description, 'Eski aciklama');
    assert.equal(pk.eski, undefined);
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

test('rename: saveConfigAt hatasında eski hal geri gelir', async () => {
  const { d, svc, cfgFile } = build({
    saveConfigAt: async (dir, c, aw) => { await aw(path.join(dir, 'pp.config.json'), '{kismen'); throw new Error('yazılamadı'); }
  });
  try {
    const before = fs.readFileSync(cfgFile);
    await rejectsWith(svc.rename(d, 'prompts', { from: 'eski', to: 'yeni' }), 500, /geri alındı/);
    assert.ok(fs.existsSync(path.join(d, 'prompts', 'eski', 'a.md')));
    assert.equal(fs.existsSync(path.join(d, 'prompts', 'yeni')), false);
    assert.deepEqual(fs.readFileSync(cfgFile), before);
  } finally { rmrf(d); }
});

test('rename: yalnızca büyük/küçük harf farkı (Windows dahil) [doğrulandı]', async () => {
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

test('bozuk pp.config.json: create/rename/setDescription 409, klasör kalmaz, dosya aynı (gerçek pp-config)', async () => {
  const { PpConfigError } = ppConfig;
  const conflict = (p, code) => assert.rejects(p, (e) => {
    assert.ok(e instanceof PpConfigError, 'PpConfigError bekleniyordu: ' + e.name + ' ' + e.message);
    assert.equal(e.status, 409); assert.equal(e.data.code, code);
    return true;
  });
  // 1) servis ön koşulu bağlıyken (sunucudaki bağlantı)
  for (const bad of ['garip{', 'null', '[]', '"x"', '5']) {
    const { d, svc, cfgFile } = build({ assertHealthy: ppConfig.assertHealthy });
    try {
      fs.writeFileSync(cfgFile, bad);
      await conflict(svc.create(d, 'prompts', { name: 'yeni', description: 'a' }), 'ppConfigBozuk');
      await conflict(svc.create(d, 'prompts', { name: 'yeni' }), 'ppConfigBozuk');
      await conflict(svc.rename(d, 'prompts', { from: 'eski', to: 'yeni' }), 'ppConfigBozuk');
      await conflict(svc.setDescription(d, 'prompts', { name: 'eski', description: 'x' }), 'ppConfigBozuk');
      assert.equal(fs.readFileSync(cfgFile, 'utf8'), bad);
      assert.deepEqual(fs.readdirSync(path.join(d, 'prompts')), ['eski']);
      assert.ok(fs.existsSync(path.join(d, 'prompts', 'eski', 'a.md')));
    } finally { rmrf(d); }
  }
  // 2) ön koşul olmasa da gerçek saveConfigAt yazmayı reddeder; klasör geri alınır, 500'e çevrilmez
  {
    const { d, svc, cfgFile } = build();
    try {
      fs.writeFileSync(cfgFile, 'garip{');
      await conflict(svc.create(d, 'prompts', { name: 'yeni', description: 'a' }), 'ppConfigBozuk');
      assert.equal(fs.existsSync(path.join(d, 'prompts', 'yeni')), false, 'klasör geri alındı');
      await conflict(svc.setDescription(d, 'prompts', { name: 'eski', description: 'x' }), 'ppConfigBozuk');
      assert.equal(fs.readFileSync(cfgFile, 'utf8'), 'garip{');
      assert.deepEqual(fs.readdirSync(d).sort(), ['pp.config.json', 'prompts']);
    } finally { rmrf(d); }
  }
  // 3) geçersiz libraryDir
  {
    const { d, svc, cfgFile } = build({ assertHealthy: ppConfig.assertHealthy });
    try {
      fs.writeFileSync(cfgFile, JSON.stringify({ libraryDir: '../../x' }));
      const before = fs.readFileSync(cfgFile);
      await conflict(svc.create(d, 'prompts', { name: 'yeni', description: 'a' }), 'libraryDirGecersiz');
      assert.deepEqual(fs.readFileSync(cfgFile), before);
      assert.equal(fs.existsSync(path.join(d, 'prompts', 'yeni')), false);
    } finally { rmrf(d); }
  }
});

test('setDescription: plugin yoksa 404, boşsa 400, başarıda yazılır', async () => {
  const { d, svc, cfgFile } = build();
  try {
    await rejectsWith(svc.setDescription(d, 'prompts', { name: 'yok', description: 'x' }), 404, /^Plugin bulunamadı: yok$/);
    await rejectsWith(svc.setDescription(d, 'prompts', { name: 'eski', description: '  ' }), 400, /^Paket açıklaması boş olamaz$/);
    assert.deepEqual(await svc.setDescription(d, 'prompts', { name: 'eski', description: 'Yeni' }), { ok: true });
    assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).packages.eski.description, 'Yeni');
  } finally { rmrf(d); }
});
