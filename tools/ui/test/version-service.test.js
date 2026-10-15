'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const FM = require('../public/fm.js');
const { GitService, GitError } = require('../lib/git-service');
const { VersionService, VersionError } = require('../lib/version-service');
const { gitAvailable, tmpDir, rmrf, gitEnv } = require('./helpers');

const real = { skip: !gitAvailable && 'git yok' };
const LIB = 'prompts';

function decode(buf) { return buf.toString('utf8'); }

function fsFiles() {
  return {
    read: (a) => fsp.readFile(a),
    write: async (a, d) => { const tmp = a + '.tmp'; await fsp.writeFile(tmp, d, 'utf8'); await fsp.rename(tmp, a); },
    stat: (a) => fsp.stat(a),
    utimes: (a, x, y) => fsp.utimes(a, x, y)
  };
}

function walk(root, rel, out) {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel + '/' + e.name;
    if (e.isDirectory()) walk(root, r, out);
    else if (/\.md$/.test(e.name)) {
      const raw = fs.readFileSync(path.join(root, r), 'utf8');
      const p = FM.parse(raw);
      out.push({ path: r, meta: FM.meta(p), fmBroken: false });
    }
  }
  return out;
}

// opts.commit false ise ilk commit yoktur. opts.identity false ise kimlik tanımsızdır.
async function setup(opts = {}) {
  const d = tmpDir();
  const g = new GitService({ env: gitEnv(d, { identity: opts.identity !== false }) });
  const root = path.join(d, 'mp'); fs.mkdirSync(path.join(root, LIB, 'ornek'), { recursive: true });
  await g.init(root);
  const a = path.join(root, LIB, 'ornek', 'a.md');
  fs.writeFileSync(a, opts.aRaw || '---\nbaslik: A\n---\n\ngovde bir\n');
  if (opts.commit !== false) {
    const gi = new GitService({ env: gitEnv(d) });
    await gi.commitPaths(root, 'ilk', [LIB + '/ornek/a.md']);
  }
  const mk = (git) => new VersionService({ git, files: fsFiles(), decode, listPrompts: async (r) => walk(r, LIB, []) });
  return { d, g, root, a, rel: LIB + '/ornek/a.md', mk, svc: mk(g) };
}

const snap = async (s) => ({
  bytes: fs.readFileSync(s.a), mtime: Math.round(fs.statSync(s.a).mtimeMs),
  head: await s.g.headCommit(s.root), tags: (await s.g.listTags(s.root, 'prompt/')).map((t) => t.name),
  status: (await s.g.status(s.root)).files.map((f) => f.x + f.y + f.path)
});

test('bump: ilk sürüm 1.0.0, ikinci kucuk 1.1.0; commit yalnızca prompt dosyası', real, async () => {
  const s = await setup();
  try {
    fs.writeFileSync(path.join(s.root, 'baska.txt'), 'x');
    await s.g.run(s.root, ['add', 'baska.txt']);
    const r1 = await s.svc.bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'yama', note: '# Başlık\n- ilk' });
    assert.equal(r1.version, '1.0.0'); assert.equal(r1.tag, 'prompt/ornek/a/v1.0.0');
    assert.match(fs.readFileSync(s.a, 'utf8'), /^versiyon: 1\.0\.0$/m);
    const tags = await s.g.listTags(s.root, 'prompt/');
    assert.equal(tags[0].commit, r1.commit);
    const msg = await s.g.run(s.root, ['cat-file', '-p', tags[0].name]);
    assert.match(msg, /# Başlık\n- ilk/);
    const show = await s.g.showCommit(s.root, r1.commit, { stat: true });
    assert.match(show, /^ornek\/a v1\.0\.0/);
    assert.match(show, /a\.md/); assert.doesNotMatch(show, /baska\.txt/);
    assert.equal((await s.g.status(s.root)).files.find((f) => f.path === 'baska.txt').x, 'A'); // başka staged korunur
    const r2 = await s.svc.bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'kucuk', note: 'ikinci' });
    assert.equal(r2.version, '1.1.0');
    assert.equal(r2.raw, fs.readFileSync(s.a, 'utf8'));
  } finally { rmrf(s.d); }
});

test('bump: ilk commit yokken de çalışır', real, async () => {
  const s = await setup({ commit: false });
  try {
    const r = await s.svc.bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'buyuk', note: 'n' });
    assert.equal(r.version, '1.0.0');
    assert.equal(await s.g.headCommit(s.root), r.commit);
  } finally { rmrf(s.d); }
});

test('bump: raw ile kaydedilmemiş içerik commit edilir', real, async () => {
  const s = await setup();
  try {
    const raw = '---\nbaslik: A\n---\n\nEDITOR GOVDESI\n';
    const r = await s.svc.bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'yama', note: 'n', raw });
    assert.match(fs.readFileSync(s.a, 'utf8'), /EDITOR GOVDESI/);
    assert.match(await s.g.showFile(s.root, r.commit, s.rel), /EDITOR GOVDESI/);
  } finally { rmrf(s.d); }
});

test('bump: ön kontroller yan etkisizdir', real, async () => {
  const s = await setup();
  try {
    await s.svc.bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'kucuk', note: 'n' }); // 1.0.0
    await s.svc.bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'kucuk', note: 'n' }); // 1.1.0
    const cases = [];
    const body = () => fs.readFileSync(s.a, 'utf8');
    const attempt = async (name, fn, check) => {
      const before = await snap(s);
      await assert.rejects(fn(), (e) => { assert.ok(e instanceof VersionError, name); check(e); return true; }, name);
      const after = await snap(s);
      assert.deepEqual(after.bytes, before.bytes, name); assert.equal(after.mtime, before.mtime, name);
      assert.equal(after.head, before.head, name); assert.deepEqual(after.tags, before.tags, name);
      assert.deepEqual(after.status, before.status, name);
      cases.push(name);
    };
    const call = (extra) => () => s.svc.bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'yama', note: 'n', ...extra });
    // surumGeride: elle 1.0.0 yazılırsa yama = 1.0.1 < 1.1.0
    fs.writeFileSync(s.a, body().replace(/versiyon: .*/, 'versiyon: 1.0.0'));
    await attempt('surumGeride', call(), (e) => { assert.equal(e.status, 409); assert.equal(e.data.code, 'surumGeride'); });
    // tagVar: 1.0.0 elle, seviye 1.0.1 zaten tag olarak varsa
    await s.g.run(s.root, ['tag', 'prompt/ornek/a/v1.0.1', 'HEAD']);
    await attempt('tagVar', call(), (e) => { assert.equal(e.status, 409); assert.equal(e.data.code, 'tagVar'); });
    await s.g.deleteTag(s.root, 'prompt/ornek/a/v1.0.1');
    fs.writeFileSync(s.a, body().replace(/versiyon: .*/, 'versiyon: abc'));
    await attempt('versiyon', call(), (e) => { assert.equal(e.status, 400); assert.equal(e.data.field, 'versiyon'); });
    await attempt('note', call({ note: '  ' }), (e) => { assert.equal(e.data.field, 'note'); });
    await attempt('level', call({ level: 'x' }), (e) => { assert.equal(e.data.field, 'level'); });
    await attempt('kapanmamis', call({ raw: '---\nbaslik: x\n\ngovde\n' }), (e) => { assert.equal(e.data.code, 'onYuzKapanmamis'); });
    await attempt('conflict', call({ baseMtime: 12345 }), (e) => { assert.equal(e.status, 409); assert.equal(e.data.conflict, true); });
    await attempt('prompt degil', () => s.svc.bump(s.root, LIB, { rel: 'pp.config.json', abs: s.a, level: 'yama', note: 'n' }), (e) => { assert.equal(e.status, 400); });
    // adCakisiyor
    fs.writeFileSync(s.a, body().replace(/versiyon: .*/, 'versiyon: 1.1.0'));
    fs.writeFileSync(path.join(s.root, LIB, 'ornek', 'a_.md'), 'x');
    await attempt('adCakisiyor', call(), (e) => { assert.equal(e.status, 409); assert.equal(e.data.code, 'adCakisiyor'); });
    assert.equal(cases.length, 9);
  } finally { rmrf(s.d); }
});

test('bump: hata enjeksiyonu a) dosya yazılamaz', real, async () => {
  const s = await setup();
  try {
    const before = await snap(s);
    const svc = new VersionService({ git: s.g, files: { ...fsFiles(), write: async () => { throw new Error('disk dolu'); } }, decode, listPrompts: async (r) => walk(r, LIB, []) });
    await assert.rejects(svc.bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'yama', note: 'n' }), (e) => { assert.equal(e.status, 500); assert.match(e.message, /disk dolu/); return true; });
    assert.deepEqual(await snap(s), before);
  } finally { rmrf(s.d); }
});

test('bump: b) kimliksiz ortam needIdentity, her şey geri gelir', real, async () => {
  const s = await setup({ identity: false, commit: false });
  try {
    // ilk commit için kimlik gerekir; dosyayı elle izlenmeyen bırak
    const before = await snap(s);
    await assert.rejects(s.svc.bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'yama', note: 'n' }), (e) => {
      assert.equal(e.status, 400); assert.equal(e.data.needIdentity, true); return true;
    });
    assert.deepEqual(await snap(s), before);
  } finally { rmrf(s.d); }
});

test('bump: b2) kimliksiz ortam, mevcut commit varken', real, async () => {
  const s = await setup();
  try {
    const noId = new GitService({ env: gitEnv(s.d, { identity: false }) });
    const svc = s.mk(noId);
    const before = await snap(s);
    await assert.rejects(svc.bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'yama', note: 'n' }), (e) => { assert.equal(e.data.needIdentity, true); return true; });
    assert.deepEqual(await snap(s), before);
  } finally { rmrf(s.d); }
});

test('bump: c) createTag hatası; başka staged dosya korunur', real, async () => {
  const s = await setup();
  try {
    fs.writeFileSync(path.join(s.root, 'b.md'), 'b\n');
    await s.g.run(s.root, ['add', 'b.md']);
    const before = await snap(s);
    const proxy = Object.create(s.g); proxy.createTag = async () => { throw new Error('tag patladi'); };
    await assert.rejects(s.mk(proxy).bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'yama', note: 'n' }), /tag patladi/);
    assert.deepEqual(await snap(s), before);
    assert.ok(before.status.includes('A b.md'));
  } finally { rmrf(s.d); }
});

test('bump: d) ilk commit yokken createTag hatası; dosya yeniden izlenmeyen', real, async () => {
  const s = await setup({ commit: false });
  try {
    const before = await snap(s);
    const proxy = Object.create(s.g); proxy.createTag = async () => { throw new Error('tag patladi'); };
    await assert.rejects(s.mk(proxy).bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'yama', note: 'n' }), /tag patladi/);
    assert.equal(await s.g.hasCommits(s.root), false);
    assert.deepEqual(await snap(s), before);
    assert.ok((await snap(s)).status.some((x) => x.startsWith('??')));
  } finally { rmrf(s.d); }
});

test('bump: e) createTag ve undoCommit hatası rollbackFailed; dosya yine geri gelir', real, async () => {
  const s = await setup();
  try {
    const orig = fs.readFileSync(s.a);
    const proxy = Object.create(s.g);
    proxy.createTag = async () => { throw new Error('tag patladi'); };
    proxy.undoCommit = async () => { throw new Error('undo patladi'); };
    await assert.rejects(s.mk(proxy).bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'yama', note: 'n' }), (e) => {
      assert.equal(e.status, 500); assert.equal(e.data.rollbackFailed, true); assert.match(e.message, /undo patladi/); return true;
    });
    assert.deepEqual(fs.readFileSync(s.a), orig);
  } finally { rmrf(s.d); }
});

test('bump: f) commit sonrası headCommit hatası rollbackFailed olur', real, async () => {
  const s = await setup();
  try {
    let n = 0;
    const proxy = Object.create(s.g);
    proxy.headCommit = async function (dir) { if (++n === 2) throw new Error('head okunamadi'); return GitService.prototype.headCommit.call(s.g, dir); };
    await assert.rejects(s.mk(proxy).bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'yama', note: 'n' }), (e) => {
      assert.equal(e.data.rollbackFailed, true); assert.match(e.message, /geri alınamadı/); return true;
    });
  } finally { rmrf(s.d); }
});

test('statusMap ve info: tutarlılık uyarısı, CRLF, önbellek, not önerisi', real, async () => {
  const s = await setup();
  try {
    await s.g.run(s.root, ['config', 'core.autocrlf', 'false']);
    fs.writeFileSync(path.join(s.root, '.gitattributes'), '*.md text eol=lf\n');
    let n = 0;
    const proxy = Object.create(s.g);
    proxy.hashFiles = function (...a) { n++; return GitService.prototype.hashFiles.apply(s.g, a); };
    const svc = s.mk(proxy);
    assert.equal((await svc.info(s.root, LIB, s.rel, s.a)).ilkSurum, true);
    assert.equal((await svc.info(s.root, LIB, s.rel, s.a)).oneriler.yama, '1.0.0');
    await svc.bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'yama', note: 'n' });
    assert.equal((await svc.statusMap(s.root, LIB)).size, 0);
    n = 0;
    assert.equal((await svc.statusMap(s.root, LIB)).size, 0);
    assert.equal(n, 0, 'ikinci çağrıda hashFiles çağrılmaz');

    const body = fs.readFileSync(s.a, 'utf8');
    // aynı içerik CRLF ile yeniden yazıldı: işaret yok
    fs.writeFileSync(s.a, body.replace(/\n/g, '\r\n'));
    assert.equal((await svc.statusMap(s.root, LIB)).size, 0);
    // gövde değişti: işaret var
    fs.writeFileSync(s.a, body + 'yeni satir\n');
    const m = await svc.statusMap(s.root, LIB);
    assert.equal(m.get(s.rel), 'surumGuncelDegil');
    const inf = await svc.info(s.root, LIB, s.rel, s.a);
    assert.equal(inf.uyari.code, 'surumGuncelDegil'); assert.equal(inf.degisti, true);
    assert.equal(inf.sonSurum.version, '1.0.0');
    assert.deepEqual(inf.oneriler, { buyuk: '2.0.0', kucuk: '1.1.0', yama: '1.0.1' });
    // versiyon elle 1.0.1: işaret yok
    fs.writeFileSync(s.a, (body + 'yeni satir\n').replace('versiyon: 1.0.0', 'versiyon: 1.0.1'));
    assert.equal((await svc.statusMap(s.root, LIB)).size, 0);
    assert.equal((await svc.info(s.root, LIB, s.rel, s.a)).uyari, null);
    // not önerisi: yalnızca tag sonrası commitler (sürüm commit'i hariç)
    fs.writeFileSync(s.a, body + 'yeni satir\n');
    await s.g.commitPaths(s.root, 'govde guncellendi', [s.rel]);
    assert.equal((await svc.info(s.root, LIB, s.rel, s.a)).notOnerisi, '- govde guncellendi');
  } finally { rmrf(s.d); }
});

test('info: eski biçim ve yorumlanamayan sürüm', real, async () => {
  const s = await setup({ aRaw: '---\nversiyon: 1\n---\n\nx\n' });
  try {
    let i = await s.svc.info(s.root, LIB, s.rel, s.a);
    assert.equal(i.eskiBicim, true); assert.equal(i.versiyon, '1.0.0'); assert.equal(i.oneriler.yama, '1.0.1'); assert.equal(i.ilkSurum, false);
    fs.writeFileSync(s.a, '---\nversiyon: 1.0.0-beta\n---\n\nx\n');
    i = await s.svc.info(s.root, LIB, s.rel, s.a);
    assert.equal(i.versiyonGecerli, false); assert.equal(i.oneriler, null);
  } finally { rmrf(s.d); }
});

test('statusMap: aynı rel iki depoda karışmaz (önbellek anahtarı kökü içerir)', real, async () => {
  const s1 = await setup();
  const s2 = await setup();
  try {
    // s1'de sürüm basılıp dosya değiştirilir; s2'de aynı rel için hiç tag yok.
    const svc = s1.mk(s1.g);
    await svc.bump(s1.root, LIB, { rel: s1.rel, abs: s1.a, level: 'yama', note: 'n' });
    fs.appendFileSync(s1.a, 'degisti\n');
    // aynı servis örneği ikinci depoyu da sorgular (ortak önbellek)
    const m1 = await svc.statusMap(s1.root, LIB);
    const m2 = await svc.statusMap(s2.root, LIB);
    assert.equal(m1.get(s1.rel), 'surumGuncelDegil');
    assert.equal(m2.has(s2.rel), false);
    // s2'ye aynı yolda, aynı sürümle tag basılınca s1 sonucu s2'ye sızmamalı
    await svc.bump(s2.root, LIB, { rel: s2.rel, abs: s2.a, level: 'yama', note: 'n' });
    assert.equal((await svc.statusMap(s2.root, LIB)).has(s2.rel), false, 's2 değişmedi');
    assert.equal((await svc.statusMap(s1.root, LIB)).get(s1.rel), 'surumGuncelDegil');
  } finally { rmrf(s1.d); rmrf(s2.d); }
});

test('bump taşması 400 ve dosya/etiket/commit aynı; 9 basamak üstü sürüm yorumlanamaz (B-13)', real, async () => {
  const s = await setup();
  try {
    const body = () => fs.readFileSync(s.a, 'utf8');
    const attempt = async (versiyon, level, check) => {
      fs.writeFileSync(s.a, '---\nbaslik: A\nversiyon: ' + versiyon + '\n---\n\ngovde bir\n');
      const before = await snap(s);
      await assert.rejects(s.svc.bump(s.root, LIB, { rel: s.rel, abs: s.a, level, note: 'n' }), (e) => {
        assert.ok(e instanceof VersionError, versiyon); assert.equal(e.status, 400, versiyon); assert.equal(e.data.field, 'versiyon', versiyon);
        check(e); return true;
      }, versiyon);
      const after = await snap(s);
      assert.deepEqual(after.bytes, before.bytes, versiyon); assert.equal(after.mtime, before.mtime, versiyon);
      assert.equal(after.head, before.head, versiyon); assert.deepEqual(after.tags, before.tags, versiyon);
      assert.deepEqual(after.status, before.status, versiyon);
    };
    for (const v of ['9007199254740993.0.0', '99999999999.1.1', '1000000000.0.0', '1000000000000000000000.0.0', '1e+21.0.0', '1.2.99999999999']) {
      await attempt(v, 'yama', (e) => assert.match(e.message, /yorumlanamadı/));
    }
    await attempt('999999999.0.0', 'buyuk', (e) => assert.match(e.message, /üst sınıra ulaştı/));
    await attempt('1.999999999.0', 'kucuk', (e) => assert.match(e.message, /üst sınıra ulaştı/));
    await attempt('1.1.999999999', 'yama', (e) => assert.match(e.message, /üst sınıra ulaştı/));
    assert.ok(!/e\+21/.test(body()), '1e+21 hiçbir yere yazılmadı');
    // sınırın altındaki en büyük sürüm hâlâ artırılır
    fs.writeFileSync(s.a, '---\nbaslik: A\nversiyon: 999999998.0.0\n---\n\ngovde bir\n');
    const r = await s.svc.bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'buyuk', note: 'n' });
    assert.equal(r.version, '999999999.0.0');
  } finally { rmrf(s.d); }
});

/* ---------- B-16: ham git hataları Türkçe özet + gitDetail ---------- */

const rawHookError = (root, rel) => new GitError('HOOK-RED: yasak sözcük\n' + root + '/' + rel, {
  stderr: 'HOOK-RED: yasak sözcük\n' + root + '/' + rel + '\n', exitCode: 1, args: ['-C', root, '-c', 'core.quotepath=false', 'commit', '-m', 'x', '--', rel]
});

test('bump: commit hook reddi Türkçe özet + gitCode + arındırılmış gitDetail; her şey geri gelir (B-16)', real, async () => {
  const s = await setup();
  try {
    const before = await snap(s);
    const proxy = Object.create(s.g);
    proxy.commitPaths = async () => { throw rawHookError(s.root, s.rel); };
    await assert.rejects(s.mk(proxy).bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'yama', note: 'n' }), (e) => {
      assert.ok(e instanceof VersionError); assert.equal(e.status, 500);
      assert.equal(e.message, 'Sürüm oluşturulamadı: Git commit\'i reddetti. Bir commit hook\'u ya da git ayarı engelliyor olabilir. Yapılan değişiklikler geri alındı.');
      assert.equal(e.data.gitCode, 'commitReddedildi');
      assert.match(e.data.gitDetail, /^HOOK-RED: yasak sözcük\n<yol>\/prompts\/ornek\/a\.md$/, 'hook çıktısı korunur, kök arındırılır');
      assert.ok(!e.message.includes(s.root) && !e.data.gitDetail.includes(s.root));
      return true;
    });
    assert.deepEqual(await snap(s), before);
  } finally { rmrf(s.d); }
});

test('bump: kimlik hatası needIdentity yolunda kalır, gitDetail eklenmez (B-16)', real, async () => {
  const s = await setup({ identity: false, commit: false });
  try {
    await assert.rejects(s.svc.bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'yama', note: 'n' }), (e) => {
      assert.equal(e.data.needIdentity, true); assert.equal(e.data.gitDetail, undefined); assert.equal(e.data.gitCode, undefined); return true;
    });
  } finally { rmrf(s.d); }
});

test('bump: gerçek .git/index.lock; geri alma da kilitlenirse rollbackFailed iletisi Türkçe, gitDetail arındırılmış (B-16)', real, async () => {
  const s = await setup();
  try {
    const orig = fs.readFileSync(s.a);
    const lock = path.join(s.root, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    await assert.rejects(s.svc.bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'yama', note: 'n' }), (e) => {
      assert.equal(e.status, 500); assert.equal(e.data.rollbackFailed, true);
      assert.match(e.message, /^Sürüm oluşturulamadı ve geri alma tamamlanamadı: Git şu an başka bir işlemle meşgul/);
      assert.doesNotMatch(e.message, /fatal|Unable to create/);
      assert.ok(!e.message.includes(s.root), 'iletide mutlak yol yok');
      assert.match(e.data.gitDetail, /index\.lock/); assert.ok(!e.data.gitDetail.includes(s.root));
      assert.ok(e.data.gitDetail.length <= 600);
      return true;
    });
    assert.deepEqual(fs.readFileSync(s.a), orig, 'dosya yine geri geldi');
    fs.rmSync(lock);
    assert.equal((await s.g.status(s.root)).files.length, 0, 'kilit kalkınca çalışma ağacı temiz');
    const r = await s.svc.bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'yama', note: 'n' });
    assert.equal(r.version, '1.0.0');
  } finally { rmrf(s.d); }
});

/* ---------- B-19: BOM korunur ---------- */

test('bump: UTF-8 BOM\'lu dosyada BOM durur, yalnızca versiyon satırı eklenir; BOM\'suz dosyaya BOM eklenmez (B-19)', real, async () => {
  const s = await setup({ aRaw: '﻿---\nbaslik: A\netiketler: [x, y]\n---\n\ngovde bir\n' });
  try {
    const head3 = () => Array.from(fs.readFileSync(s.a).subarray(0, 3));
    assert.deepEqual(head3(), [0xEF, 0xBB, 0xBF]);
    const r1 = await s.svc.bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'yama', note: 'n' });
    assert.deepEqual(head3(), [0xEF, 0xBB, 0xBF], 'ilk +1 sonrası');
    assert.equal(r1.raw.charCodeAt(0), 0xFEFF);
    assert.equal(fs.readFileSync(s.a, 'utf8'), '﻿---\nbaslik: A\netiketler: [x, y]\nversiyon: 1.0.0\n---\n\ngovde bir\n');
    // git'e giden içerik de BOM'lu (HEAD'deki blob ile çalışma dosyası aynı)
    assert.equal((await s.g.showFile(s.root, r1.commit, s.rel)).charCodeAt(0), 0xFEFF);
    // arayüzden gelen raw (BOM'lu) ile ikinci artış
    const raw = r1.raw.replace('govde bir', 'govde iki');
    await s.svc.bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'kucuk', note: 'n', raw });
    assert.deepEqual(head3(), [0xEF, 0xBB, 0xBF], 'raw ile +1 sonrası');
    assert.match(fs.readFileSync(s.a, 'utf8'), /versiyon: 1\.1\.0\n/);
  } finally { rmrf(s.d); }
  const t = await setup();
  try {
    await t.svc.bump(t.root, LIB, { rel: t.rel, abs: t.a, level: 'yama', note: 'n' });
    assert.notDeepEqual(Array.from(fs.readFileSync(t.a).subarray(0, 3)), [0xEF, 0xBB, 0xBF], 'BOM\'suz dosyaya BOM eklenmez');
    assert.equal(fs.readFileSync(t.a, 'utf8').charCodeAt(0), '-'.charCodeAt(0));
  } finally { rmrf(t.d); }
});

test('bump: CRLF + BOM birlikte korunur (B-19)', real, async () => {
  const s = await setup({ aRaw: '﻿---\r\nbaslik: A\r\n---\r\n\r\ngovde bir\r\n' });
  try {
    await s.svc.bump(s.root, LIB, { rel: s.rel, abs: s.a, level: 'yama', note: 'n' });
    assert.equal(fs.readFileSync(s.a, 'utf8'), '﻿---\r\nbaslik: A\r\nversiyon: 1.0.0\r\n---\r\n\r\ngovde bir\r\n');
  } finally { rmrf(s.d); }
});
