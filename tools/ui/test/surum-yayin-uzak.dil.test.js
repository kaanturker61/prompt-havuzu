'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const I18n = require('../public/i18n.js');
const FM = require('../public/fm.js');
const Rules = require('../public/rules.js');
const TR = require('../public/lang/tr.js');
const EN = require('../public/lang/en.js');
const { GitService, GitError } = require('../lib/git-service');
const { VersionError } = require('../lib/version-service');
const { PromptHistory, HistoryError } = require('../lib/prompt-history');
const { PublishError } = require('../lib/publisher');
const { RemoteError } = require('../lib/remote-sync');
const { StateStore } = require('../lib/state-store');
const { describeNetError } = require('../lib/net-errors');
const { gitAvailable, tmpDir, rmrf, gitEnv, sh, makeRepo, makeBare } = require('./helpers');
const { seed, write, cmd, commitAll, buildStack, snapshot } = require('./stack');
const { MarketplaceFactory } = require('../lib/marketplace-factory');
const templates = require('../lib/templates');
const { tagNote } = require('../lib/commit-text');

const LIB = path.join(__dirname, '..', 'lib');
const SOURCES = ['version-service.js', 'prompt-history.js', 'publisher.js', 'remote-sync.js', 'state-store.js'];
const NAMESPACES = ['ver.err.', 'hist.err.', 'pub.', 'remote.'];
const DIACRITIC_RE = /[çğıöşüÇĞİÖŞÜ]/;
const PLACEHOLDER_RE = /\{([A-Za-z_]\w*)\}/g;
const LIBDIR = 'prompts';
const REL = 'prompts/ornek/a.md';
const real = { skip: !gitAvailable && 'git yok' };
const EXPECTED_KEYS = [
  'ver.err.level', 'ver.err.noteEmpty', 'ver.err.notPrompt', 'ver.err.fileNotFound', 'ver.err.diskChanged', 'ver.err.fmBroken',
  'ver.err.adCakisiyor', 'ver.err.versiyonYorumlanamadi', 'ver.err.surumSinir', 'ver.err.tagVar', 'ver.err.surumGeride',
  'ver.err.rollbackFailed', 'ver.err.needIdentity', 'ver.err.failedGit', 'ver.err.failed', 'ver.err.hashUnreadable',
  'ver.err.hashUnreadableNoUndo',
  'hist.err.commitYok', 'hist.err.surumAdiGecersiz', 'hist.err.surumYok', 'hist.err.surumBaskaDosyanin', 'hist.err.dosyaYok',
  'hist.err.ayniSurum',
  'pub.err.publishRollbackFailed', 'pub.err.updateRollbackFailed', 'pub.err.publishFailedGit', 'pub.err.updateFailedGit',
  'pub.err.publishFailed', 'pub.err.updateFailed', 'pub.err.needIdentity', 'pub.err.commitYok', 'pub.err.paketYok',
  'pub.err.kirli', 'pub.err.dogrulama', 'pub.err.bosPaket', 'pub.err.tagVar', 'pub.err.katalogSurumYorumlanamadi',
  'pub.err.katalogSurumKucuk', 'pub.err.hashUnreadable', 'pub.err.hashUnreadableNoUndo', 'pub.updated', 'pub.noChange',
  'remote.err.remoteYok', 'remote.err.bulunamadi', 'remote.err.adVar', 'remote.err.dalYokPush', 'remote.err.dalYok',
  'remote.err.kirli', 'remote.err.commitYok', 'remote.err.uzakDalYok', 'remote.err.ayristi', 'remote.err.guncel',
  'remote.err.rollbackFailed', 'remote.err.failed'
].sort();
/** Summary: Bilinçli olarak çevrilmeyen Türkçe dize değişmezleri (Aşama 6 sonrası kalmadı). */
const ALLOWED_TURKISH_LITERALS = [];
/** Summary: Eski sürümlerin diske yazdığı, error metni içeren başarısız lastCheck kaydı. */
const OLD_FAILED_CHECK = {
  at: '2026-01-01T10:00:00.000Z', ok: false, code: 'ag', error: 'Eski diskten gelen Türkçe ileti', behind: 0, newTags: [], newCommits: []
};

/** Summary: Çağrıyı İngilizce dil bağlamında çalıştırır. */
const inEn = (fn) => I18n.run('en', fn);

/** Summary: Çağrıyı Türkçe dil bağlamında çalıştırır. */
const inTr = (fn) => I18n.run('tr', fn);

/** Summary: Dil kodu -> bağlam çalıştırıcı. */
const LANGS = { tr: inTr, en: inEn };

/** Summary: Söz reddini hata olarak döner (çözülürse test başarısız olur). */
async function rejected(promise) {
  try { await promise; } catch (e) { return e; }
  return assert.fail('söz reddedilmedi');
}

/** Summary: Bu aşamanın ad uzaylarındaki sözlük anahtarları, sıralı. */
function stageKeys(dictionary) {
  return Object.keys(dictionary).filter((key) => NAMESPACES.some((ns) => key.startsWith(ns))).sort();
}

/** Summary: Şablondaki yer tutucu adları, tekil ve sıralı. */
function placeholders(text) {
  return [...new Set([...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]))].sort();
}

/** Summary: Sözlük değerini kategori -> metin haritasına çevirir (düz metin için tek 'text' girdisi). */
function variants(value) {
  return typeof value === 'string' ? { text: value } : value;
}

/** Summary: Kaynaktaki dize değişmezlerini yorumları ve düzenli ifade değişmezlerini atlayarak çıkarır. */
function stringLiterals(src) {
  const found = [];
  const beforeRegex = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', 'return']);
  let i = 0;
  let prev = '';
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') { const end = src.indexOf('\n', i); i = end < 0 ? src.length : end; continue; }
    if (c === '/' && next === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      found.push(src.slice(i + 1, j));
      i = j + 1;
      prev = 'x';
      continue;
    }
    if (c === '/' && beforeRegex.has(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && (inClass || src[j] !== '/')) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j++;
      }
      i = j + 1;
      while (/[a-z]/.test(src[i] || '')) i++;
      prev = 'x';
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (/[\w$]/.test(src[j] || '')) j++;
      prev = src.slice(i, j) === 'return' ? 'return' : 'x';
      i = j;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return found;
}

/** Summary: Commit hook reddini taklit eden ham git hatası. */
function hookError(root) {
  return new GitError('HOOK-RED', { stderr: 'HOOK-RED: yasak sözcük\n' + root + '/plugins\n', exitCode: 1, args: ['-C', root, 'commit', '-m', 'x'] });
}

/** Summary: Seed'li marketplace + yığın; prompts/ornek/a.md üzerinde sürüm işlemleri için. */
function versionStack(tmp, name, opts) {
  const mk = seed(tmp, name);
  const s = buildStack(mk, tmp, opts);
  return { mk, s, abs: path.join(mk, 'prompts', 'ornek', 'a.md') };
}

/** Summary: Sürüm +1 çağrısı (varsayılan yama, not n). */
function bump(v, extra) {
  return v.s.versions.bump(v.mk, LIBDIR, { rel: REL, abs: v.abs, level: 'yama', note: 'n', ...extra });
}

/** Summary: Verilen sürümle frontmatter'lı ham prompt metni. */
const rawWith = (version) => '---\nbaslik: A\nversiyon: ' + version + '\n---\n\ngovde\n';

/** Summary: Hata verisinden dile bağlı sorun metinlerini (issues[].msg) çıkarır; kalan alanlar dilden bağımsız karşılaştırılır. */
function languageFree(data) {
  if (!data || !Array.isArray(data.issues)) return data;
  return { ...data, issues: data.issues.map(({ msg, ...rest }) => rest) };
}

/** Summary: Aynı hatayı iki dilde alır; ileti dile göre, status, code ve data (sorun metinleri hariç) aynı. */
async function assertBothLanguages(label, make, check) {
  const seen = {};
  for (const [lang, run] of Object.entries(LANGS)) {
    const e = await run(() => rejected(make()));
    seen[lang] = e;
    check(e, lang);
  }
  assert.equal(seen.tr.status, seen.en.status, label + ' status');
  assert.deepEqual(languageFree(seen.tr.data), languageFree(seen.en.data), label + ' data');
  assert.notEqual(seen.tr.message, seen.en.message, label + ' iletiler farklı dilde');
}

/** Summary: A (seed edilmiş, push edilmiş) ve B (bare'den klon) çalışma kopyaları. */
async function twoCopies(tmp, { gitA } = {}) {
  const a = seed(tmp, 'a');
  const sa = buildStack(a, tmp, { git: gitA });
  const bare = makeBare(tmp);
  await sa.git.addRemote(a, 'origin', bare);
  assert.deepEqual(await sa.remoteSync.push(a, {}), { ok: true });
  sh(tmp, ['clone', '-q', bare, 'b'], gitEnv(tmp));
  const b = path.join(tmp, 'b');
  const sb = buildStack(b, tmp);
  return { a, b, sa, sb, bare };
}

/** Summary: pp-state.json yolu. */
const stateFile = (dir) => path.join(dir, '.git', 'pp-state.json');

/** Summary: pp-state.json içeriğini ham metin olarak okur. */
const readStateText = (dir) => fs.readFileSync(stateFile(dir), 'utf8');

test('VersionService: ön kontrol iletileri tr Türkçe, en İngilizce; status, code, field ve data dilden bağımsız', real, async () => {
  const tmp = tmpDir();
  try {
    const v = versionStack(tmp, 'mk');
    await bump(v, { level: 'kucuk' });
    await bump(v, { level: 'kucuk' });
    const cases = [
      { name: 'level', extra: { level: 'x' }, status: 400, data: { field: 'level' },
        tr: 'Geçersiz seviye. Büyük, küçük veya yama seç.', en: 'Invalid level. Choose major, minor, or patch.' },
      { name: 'note', extra: { note: '  ' }, status: 400, data: { field: 'note' },
        tr: 'Sürüm notu boş olamaz', en: 'The version note cannot be empty' },
      { name: 'notPrompt', extra: { rel: 'pp.config.json' }, status: 400, data: undefined,
        tr: 'Sürüm yalnızca prompt dosyaları için oluşturulur', en: 'A version can only be created for prompt files' },
      { name: 'fileNotFound', extra: { abs: path.join(v.mk, 'yok.md') }, status: 404, data: undefined,
        tr: 'Dosya bulunamadı. Silinmiş veya taşınmış olabilir', en: 'File not found. It may have been deleted or moved' },
      { name: 'diskChanged', extra: { baseMtime: 12345 }, status: 409, data: { conflict: true },
        tr: 'Dosya sen açtıktan sonra diskte değişti', en: 'The file changed on disk after you opened it' },
      { name: 'fmBroken', extra: { raw: '---\nbaslik: x\n\ngovde\n' }, status: 400, data: { code: 'onYuzKapanmamis' },
        tr: 'Frontmatter kapanmamış (ikinci "---" satırı yok). versiyon alanı yazılamıyor.',
        en: 'Frontmatter is not closed (the second "---" line is missing). The versiyon field cannot be written.' },
      { name: 'versiyon', extra: { raw: rawWith('abc') }, status: 400, data: { field: 'versiyon' },
        tr: 'versiyon alanı yorumlanamadı: "abc". X.Y.Z biçiminde düzelt (örnek: 1.0.0).',
        en: 'The versiyon field could not be interpreted: "abc". Fix it to use the X.Y.Z format (example: 1.0.0).' },
      { name: 'surumSinir', extra: { raw: rawWith('999999999.0.0'), level: 'buyuk' }, status: 400, data: { field: 'versiyon' },
        tr: 'Sürüm üst sınıra ulaştı (bileşen en çok 999999999 olabilir). versiyon alanını düzelt.',
        en: 'The version reached the upper limit (a component can be at most 999999999). Fix the versiyon field.' },
      { name: 'surumGeride', extra: { raw: rawWith('1.0.0') }, status: 409, data: { code: 'surumGeride' },
        tr: 'Yeni sürüm (1.0.1) son sürümden (1.1.0) büyük olmalı. versiyon alanını düzelt.',
        en: 'The new version (1.0.1) must be greater than the last version (1.1.0). Fix the versiyon field.' }
    ];
    for (const c of cases) {
      await assertBothLanguages(c.name, () => bump(v, c.extra), (e, lang) => {
        assert.ok(e instanceof VersionError, c.name);
        assert.equal(e.message, c[lang], c.name + ' ' + lang);
        assert.equal(e.status, c.status, c.name);
        const data = e.data && { ...e.data };
        if (data) delete data.mtime;
        assert.deepEqual(data, c.data, c.name);
      });
    }
    await v.s.git.run(v.mk, ['tag', 'prompt/ornek/a/v1.0.1', 'HEAD']);
    await assertBothLanguages('tagVar', () => bump(v, { raw: rawWith('1.0.0') }), (e, lang) => {
      assert.deepEqual(e.data, { code: 'tagVar', tag: 'prompt/ornek/a/v1.0.1' });
      assert.equal(e.status, 409);
      assert.equal(e.message, {
        tr: "Bu sürümün tag'i zaten var: prompt/ornek/a/v1.0.1. versiyon alanını kontrol et.",
        en: 'A tag for this version already exists: prompt/ornek/a/v1.0.1. Check the versiyon field.'
      }[lang]);
    });
    fs.writeFileSync(path.join(v.mk, 'prompts', 'ornek', 'a_.md'), cmd('A2'));
    await assertBothLanguages('adCakisiyor', () => bump(v), (e, lang) => {
      assert.deepEqual(e.data, { code: 'adCakisiyor', other: 'prompts/ornek/a_.md' });
      assert.equal(e.status, 409);
      assert.equal(e.message, {
        tr: 'Bu prompt ile prompts/ornek/a_.md aynı sürüm adını (prompt/ornek/a) üretiyor. Birinin dosya adını değiştir.',
        en: 'This prompt and prompts/ornek/a_.md produce the same version name (prompt/ornek/a). Rename one of the files.'
      }[lang]);
    });
    assert.deepEqual(I18n.missing.filter((entry) => entry.includes(':ver.err.')), []);
  } finally { rmrf(tmp); }
});

test('VersionService: hata özetleri (hook reddi, genel hata, kimlik, geri alma başarısız) iki dilde; gitCode ve gitDetail aynı', real, async () => {
  const tmp = tmpDir();
  try {
    const failing = (over) => (tag) => {
      const base = new GitService({ env: gitEnv(tmp) });
      const proxy = Object.create(base);
      Object.assign(proxy, over(base));
      return versionStack(tmp, 'mk-' + tag, { git: proxy });
    };
    const scenarios = [
      { name: 'failedGit', make: failing(() => ({ commitPaths: async () => { throw hookError('/x'); } })),
        tr: "Sürüm oluşturulamadı: Git commit'i reddetti. Bir commit hook'u ya da git ayarı engelliyor olabilir. Yapılan değişiklikler geri alındı.",
        en: 'Could not create the version: Git rejected the commit. A commit hook or a git setting may be blocking it. The changes were rolled back.',
        check: (e) => { assert.equal(e.status, 500); assert.equal(e.data.gitCode, 'commitReddedildi'); assert.match(e.data.gitDetail, /^HOOK-RED: yasak sözcük/); } },
      { name: 'failed', make: failing(() => ({ createTag: async () => { throw new Error('tag patladi'); } })),
        tr: 'Sürüm oluşturulamadı: tag patladi. Yapılan değişiklikler geri alındı.',
        en: 'Could not create the version: tag patladi. The changes were rolled back.',
        check: (e) => { assert.equal(e.status, 500); assert.equal(e.data, undefined); } },
      { name: 'rollbackFailed',
        make: failing(() => ({ createTag: async () => { throw new Error('tag patladi'); }, undoCommit: async () => { throw new Error('undo patladi'); } })),
        tr: 'Sürüm oluşturulamadı ve geri alma tamamlanamadı: undo patladi. Git panelinden durumu kontrol et.',
        en: 'Could not create the version and the rollback could not be completed: undo patladi. Check the status in the Git panel.',
        check: (e) => { assert.equal(e.status, 500); assert.equal(e.data.rollbackFailed, true); } },
      { name: 'hashUnreadable',
        make: failing((base) => {
          let n = 0;
          return { headCommit: async function (dir) { if (++n === 2) throw new Error('head okunamadi'); return GitService.prototype.headCommit.call(base, dir); } };
        }),
        tr: 'Sürüm oluşturulamadı ve geri alma tamamlanamadı: commit oluştu ama hash okunamadı, commit geri alınamadı. Git panelinden durumu kontrol et.',
        en: 'Could not create the version and the rollback could not be completed: the commit was created but its hash could not be read, so the commit could not be undone. Check the status in the Git panel.',
        check: (e) => { assert.equal(e.data.rollbackFailed, true); } }
    ];
    for (const sc of scenarios) {
      for (const [lang, run] of Object.entries(LANGS)) {
        const v = sc.make(sc.name + '-' + lang);
        const e = await run(() => rejected(bump(v)));
        assert.ok(e instanceof VersionError, sc.name);
        assert.equal(e.message, sc[lang], sc.name + ' ' + lang);
        sc.check(e);
      }
    }
    for (const [lang, run] of Object.entries(LANGS)) {
      const mk = seed(tmp, 'kimlik-' + lang);
      const noId = new GitService({ env: gitEnv(tmp, { identity: false }) });
      const s = buildStack(mk, tmp, { git: noId });
      const e = await run(() => rejected(s.versions.bump(mk, LIBDIR, { rel: REL, abs: path.join(mk, REL), level: 'yama', note: 'n' })));
      assert.equal(e.status, 400);
      assert.equal(e.data.needIdentity, true);
      assert.equal(e.message, {
        tr: 'Git, commit yazarını bilmiyor. Ad ve e-posta gir. Sürüm oluşturulmadı, değişiklikler geri alındı.',
        en: 'Git does not know the commit author. Enter a name and email. The version was not created and the changes were rolled back.'
      }[lang]);
    }
    assert.deepEqual(I18n.missing.filter((entry) => entry.includes(':ver.err.')), []);
  } finally { rmrf(tmp); }
});

test('PromptHistory: HistoryError iletileri tr Türkçe, en İngilizce; status ve code aynı; önbellek metin tutmaz', real, async () => {
  const tmp = tmpDir();
  try {
    const v = versionStack(tmp, 'mk');
    await v.s.versions.bump(v.mk, LIBDIR, { rel: REL, abs: v.abs, level: 'yama', note: 'a' });
    const bAbs = path.join(v.mk, 'prompts', 'ornek', 'b.md');
    await v.s.versions.bump(v.mk, LIBDIR, { rel: 'prompts/ornek/b.md', abs: bAbs, level: 'yama', note: 'b' });
    const h = new PromptHistory({ git: v.s.git, FM, Rules });
    const opts = { libraryDir: LIBDIR };
    const empty = makeRepo(tmp, 'bos');
    const cases = [
      { code: 'surumAdiGecersiz', status: 400, make: () => h.show(v.mk, REL, 'HEAD~1', opts),
        tr: 'Geçersiz sürüm adı: "HEAD~1"', en: 'Invalid version name: "HEAD~1"' },
      { code: 'surumAdiGecersiz', status: 400, make: () => h.compare(v.mk, REL, '', 'HEAD', opts),
        tr: 'Geçersiz sürüm adı: ""', en: 'Invalid version name: ""' },
      { code: 'surumYok', status: 404, make: () => h.show(v.mk, REL, 'prompt/ornek/a/v9.9.9', opts),
        tr: 'Sürüm bulunamadı: prompt/ornek/a/v9.9.9', en: 'Version not found: prompt/ornek/a/v9.9.9' },
      { code: 'surumBaskaDosyanin', status: 400, make: () => h.show(v.mk, REL, 'prompt/ornek/b/v1.0.0', opts),
        tr: 'Bu sürüm bu dosyaya ait değil: prompt/ornek/b/v1.0.0', en: 'This version does not belong to this file: prompt/ornek/b/v1.0.0' },
      { code: 'ayniSurum', status: 400, make: () => h.compare(v.mk, REL, 'prompt/ornek/a/v1.0.0', 'prompt/ornek/a/v1.0.0', opts),
        tr: 'Aynı sürüm iki kez seçildi', en: 'The same version was selected twice' },
      { code: 'dosyaYok', status: 404, make: () => h.show(v.mk, 'prompts/silinmis.md', 'HEAD', opts),
        tr: 'Bu sürümde dosya yok', en: 'The file does not exist in this version' },
      { code: 'commitYok', status: 404, make: () => h.resolveRef(empty, REL, 'HEAD', opts),
        tr: 'Henüz commit yok', en: 'There are no commits yet' }
    ];
    for (const c of cases) {
      for (const run of [inTr, inEn, inTr, inEn]) {
        const lang = run === inTr ? 'tr' : 'en';
        const e = await run(() => rejected(c.make()));
        assert.ok(e instanceof HistoryError, c.code);
        assert.equal(e.code, c.code);
        assert.equal(e.status, c.status);
        assert.equal(e.message, c[lang], c.code + ' ' + lang);
      }
    }
    assert.deepEqual(I18n.missing.filter((entry) => entry.includes(':hist.err.')), []);
  } finally { rmrf(tmp); }
});

test('PackagePublisher: ön kontrol ve doğrulama iletileri tr Türkçe, en İngilizce; code ve data dilden bağımsız', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp, 'mk');
    write(mk, 'prompts/bos/x.md', '---\nbaslik: X\n---\ngovde\n');
    commitAll(mk, tmp);
    const s = buildStack(mk, tmp);
    const empty = makeRepo(tmp, 'bos-depo');
    const se = buildStack(empty, tmp);
    const publish = (extra) => s.publisher.publish(mk, { name: 'ornek', ...extra });
    const cases = [
      { name: 'paketYok', make: () => publish({ name: 'yok' }), status: 404, data: undefined,
        tr: 'Paket bulunamadı: yok', en: 'Package not found: yok' },
      { name: 'bosPaket', make: () => publish({ name: 'bos' }), status: 409, data: { code: 'bosPaket' },
        tr: 'Pakette yayınlanacak prompt yok', en: 'There are no prompts to publish in the package' },
      { name: 'commitYok', make: () => se.publisher.publish(empty, { name: 'ornek' }), status: 409, data: { code: 'commitYok' },
        tr: "Henüz hiç commit yok. Önce Git panelinden ilk commit'i at.",
        en: 'There are no commits yet. First make the initial commit from the Git panel.' },
      { name: 'commitYokGuncelle', make: () => se.publisher.updateAll(empty), status: 409, data: { code: 'commitYok' },
        tr: "Henüz hiç commit yok. Önce Git panelinden ilk commit'i at.",
        en: 'There are no commits yet. First make the initial commit from the Git panel.' },
      { name: 'katalogSurumKucuk', make: () => publish({ marketplaceVersion: '0.9.0' }), status: 400, data: { code: 'katalogSurumGecersiz' },
        tr: 'Katalog sürümü mevcut sürümden (1.0.0) küçük olamaz',
        en: 'The catalog version cannot be lower than the current version (1.0.0)' }
    ];
    for (const c of cases) {
      await assertBothLanguages(c.name, c.make, (e, lang) => {
        assert.ok(e instanceof PublishError, c.name);
        assert.equal(e.message, c[lang], c.name + ' ' + lang);
        assert.equal(e.status, c.status, c.name);
        assert.deepEqual(e.data, c.data, c.name);
      });
    }

    write(mk, 'prompts/ornek/x.md', cmd('X', 'paket: baska\n'));
    commitAll(mk, tmp);
    await assertBothLanguages('dogrulama1', () => publish(), (e, lang) => {
      assert.equal(e.data.code, 'dogrulama');
      assert.equal(e.data.issues.length, 1);
      assert.equal(e.message, { tr: 'Paket doğrulanamadı: 1 sorun var', en: 'The package could not be validated: 1 issue' }[lang]);
    });
    write(mk, 'prompts/ornek/y.md', cmd('Y', 'paket: baska\n'));
    commitAll(mk, tmp);
    await assertBothLanguages('dogrulama2', () => publish(), (e, lang) => {
      assert.equal(e.data.issues.length, 2);
      assert.equal(e.message, { tr: 'Paket doğrulanamadı: 2 sorun var', en: 'The package could not be validated: 2 issues' }[lang]);
    });
    fs.rmSync(path.join(mk, 'prompts', 'ornek', 'x.md'));
    fs.rmSync(path.join(mk, 'prompts', 'ornek', 'y.md'));
    commitAll(mk, tmp);

    write(mk, 'prompts/ornek/c1.md', cmd('C1'));
    await assertBothLanguages('kirli', () => publish(), (e, lang) => {
      assert.deepEqual(e.data, { code: 'kirliCalismaAgaci', files: ['prompts/ornek/c1.md'] });
      assert.equal(e.message, {
        tr: 'Önce bu dosyaları kaydet (commit): prompts/ornek/c1.md',
        en: 'First save (commit) these files: prompts/ornek/c1.md'
      }[lang]);
    });
    for (let i = 2; i <= 7; i++) write(mk, `prompts/ornek/c${i}.md`, cmd('C' + i));
    await assertBothLanguages('kirliCok', () => publish(), (e, lang) => {
      assert.equal(e.data.files.length, 7);
      const list = e.data.files.slice(0, 5).join(', ') + ' …';
      assert.equal(e.message, { tr: 'Önce bu dosyaları kaydet (commit): ' + list, en: 'First save (commit) these files: ' + list }[lang]);
    });
    await assertBothLanguages('kirliGuncelle', () => s.publisher.updateAll(mk), (e, lang) => {
      assert.equal(e.data.code, 'kirliCalismaAgaci');
      assert.ok(e.message.startsWith({ tr: 'Önce bu dosyaları kaydet (commit): ', en: 'First save (commit) these files: ' }[lang]));
      assert.ok(e.message.endsWith(' …'));
    });
    commitAll(mk, tmp);

    await publish();
    write(mk, 'prompts/ornek/c8.md', cmd('C8'));
    commitAll(mk, tmp);
    const orphan = sh(mk, ['commit-tree', 'HEAD^{tree}', '-m', 'yetim'], gitEnv(tmp)).trim();
    sh(mk, ['tag', 'paket/ornek/v1.1.0', orphan], gitEnv(tmp));
    await assertBothLanguages('tagVar', () => publish({ version: '1.1.0' }), (e, lang) => {
      assert.deepEqual(e.data, { code: 'tagVar', tag: 'paket/ornek/v1.1.0' });
      assert.equal(e.status, 409);
      assert.equal(e.message, {
        tr: 'Bu sürümün etiketi zaten var: paket/ornek/v1.1.0',
        en: 'A tag for this version already exists: paket/ornek/v1.1.0'
      }[lang]);
    });
    assert.deepEqual(I18n.missing.filter((entry) => entry.includes(':pub.')), []);
  } finally { rmrf(tmp); }
});

test('PackagePublisher: katalog sürümü yorumlanamıyorsa ileti iki dilde', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp, 'mk');
    const cfgFile = path.join(mk, 'pp.config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    cfg.marketplace.version = 'abc';
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
    commitAll(mk, tmp);
    const s = buildStack(mk, tmp);
    await assertBothLanguages('katalogSurumYorumlanamadi', () => s.publisher.publish(mk, { name: 'ornek' }), (e, lang) => {
      assert.deepEqual(e.data, { code: 'katalogSurumGecersiz' });
      assert.equal(e.message, {
        tr: 'Katalog sürümü yorumlanamadı: "abc". Marketplace panelinden düzelt.',
        en: 'The catalog version could not be interpreted: "abc". Fix it in the Marketplace panel.'
      }[lang]);
    });
  } finally { rmrf(tmp); }
});

test('PackagePublisher: yayın ve güncelleme hata özetleri (genel hata, hook reddi, kimlik, geri alma başarısız) iki dilde', real, async () => {
  const tmp = tmpDir();
  try {
    const stackWith = (tag, over, identity) => {
      const base = new GitService({ env: gitEnv(tmp) });
      const proxy = Object.create(base);
      Object.assign(proxy, over(base));
      const mk = seed(tmp, 'mk-' + tag);
      const git = identity === false ? new GitService({ env: gitEnv(tmp, { identity: false }) }) : proxy;
      return { mk, s: buildStack(mk, tmp, { git }) };
    };
    const hook = () => ({ commitPaths: async () => { throw hookError('/x'); } });
    const scenarios = [
      { name: 'publishFailed', over: () => ({ createTag: async () => { throw new Error('tag yazilamadi'); } }),
        run: ({ mk, s }) => s.publisher.publish(mk, { name: 'ornek' }),
        tr: 'Yayın başarısız: tag yazilamadi. Yapılan değişiklikler geri alındı.',
        en: 'Publish failed: tag yazilamadi. The changes were rolled back.',
        check: (e) => { assert.equal(e.status, 500); assert.deepEqual(e.data, { code: 'geriAlindi' }); } },
      { name: 'publishFailedGit', over: hook,
        run: ({ mk, s }) => s.publisher.publish(mk, { name: 'ornek' }),
        tr: "Yayın başarısız: Git commit'i reddetti. Bir commit hook'u ya da git ayarı engelliyor olabilir. Yapılan değişiklikler geri alındı.",
        en: 'Publish failed: Git rejected the commit. A commit hook or a git setting may be blocking it. The changes were rolled back.',
        check: (e) => { assert.equal(e.data.code, 'geriAlindi'); assert.equal(e.data.gitCode, 'commitReddedildi'); assert.match(e.data.gitDetail, /^HOOK-RED/); } },
      { name: 'updateFailedGit', over: hook,
        run: ({ mk, s }) => s.publisher.updateAll(mk),
        tr: "Güncelleme başarısız: Git commit'i reddetti. Bir commit hook'u ya da git ayarı engelliyor olabilir. Yapılan değişiklikler geri alındı.",
        en: 'Update failed: Git rejected the commit. A commit hook or a git setting may be blocking it. The changes were rolled back.',
        check: (e) => { assert.equal(e.data.gitCode, 'commitReddedildi'); } },
      { name: 'updateFailed', over: () => ({ commitPaths: async () => { throw new Error('commit yazilamadi'); } }),
        run: ({ mk, s }) => s.publisher.updateAll(mk),
        tr: 'Güncelleme başarısız: commit yazilamadi. Yapılan değişiklikler geri alındı.',
        en: 'Update failed: commit yazilamadi. The changes were rolled back.',
        check: (e) => { assert.deepEqual(e.data, { code: 'geriAlindi' }); } },
      { name: 'publishRollbackFailed',
        over: () => ({ createTag: async () => { throw new Error('tag yazilamadi'); }, undoCommit: async () => { throw new Error('undo patladi'); } }),
        run: ({ mk, s }) => s.publisher.publish(mk, { name: 'ornek' }),
        tr: 'Yayın başarısız ve geri alma tamamlanamadı: undo patladi. Git panelinden durumu kontrol et.',
        en: 'Publish failed and the rollback could not be completed: undo patladi. Check the status in the Git panel.',
        check: (e) => { assert.equal(e.data.code, 'rollbackFailed'); assert.equal(e.data.rollbackFailed, true); } },
      { name: 'updateRollbackFailed',
        over: () => ({ commitPaths: async () => { throw new Error('commit yazilamadi'); }, unstage: async () => { throw new Error('unstage patladi'); } }),
        run: ({ mk, s }) => s.publisher.updateAll(mk),
        tr: 'Güncelleme başarısız ve geri alma tamamlanamadı: unstage patladi. Git panelinden durumu kontrol et.',
        en: 'Update failed and the rollback could not be completed: unstage patladi. Check the status in the Git panel.',
        check: (e) => { assert.equal(e.data.rollbackFailed, true); } },
      { name: 'publishHashUnreadable',
        over: (base) => {
          let committed = false;
          return {
            commitPaths: async (...a) => { const r = await GitService.prototype.commitPaths.apply(base, a); committed = true; return r; },
            headCommit: async (dir) => (committed ? null : GitService.prototype.headCommit.call(base, dir))
          };
        },
        run: ({ mk, s }) => s.publisher.publish(mk, { name: 'ornek' }),
        tr: 'Yayın başarısız ve geri alma tamamlanamadı: commit oluştu ama hash okunamadı, commit geri alınamadı. Git panelinden durumu kontrol et.',
        en: 'Publish failed and the rollback could not be completed: the commit was created but its hash could not be read, so the commit could not be undone. Check the status in the Git panel.',
        check: (e) => { assert.equal(e.data.rollbackFailed, true); } },
      { name: 'updateHashUnreadable',
        over: (base) => {
          let committed = false;
          return {
            commitPaths: async (...a) => { const r = await GitService.prototype.commitPaths.apply(base, a); committed = true; return r; },
            headCommit: async (dir) => (committed ? null : GitService.prototype.headCommit.call(base, dir))
          };
        },
        run: ({ mk, s }) => s.publisher.updateAll(mk),
        tr: 'Güncelleme başarısız ve geri alma tamamlanamadı: commit oluştu ama hash okunamadı, commit geri alınamadı. Git panelinden durumu kontrol et.',
        en: 'Update failed and the rollback could not be completed: the commit was created but its hash could not be read, so the commit could not be undone. Check the status in the Git panel.',
        check: (e) => { assert.equal(e.data.rollbackFailed, true); } }
    ];
    for (const sc of scenarios) {
      for (const [lang, run] of Object.entries(LANGS)) {
        const ctx = stackWith(sc.name + '-' + lang, sc.over);
        if (sc.name.startsWith('update')) { write(ctx.mk, 'prompts/ornek/c.md', cmd('C', 'komut_adi: cc\n')); commitAll(ctx.mk, tmp); }
        const e = await run(() => rejected(sc.run(ctx)));
        assert.ok(e instanceof PublishError, sc.name);
        assert.equal(e.message, sc[lang], sc.name + ' ' + lang);
        sc.check(e);
      }
    }
    for (const [lang, run] of Object.entries(LANGS)) {
      const ctx = stackWith('kimlik-' + lang, () => ({}), false);
      const e = await run(() => rejected(ctx.s.publisher.publish(ctx.mk, { name: 'ornek' })));
      assert.equal(e.status, 400);
      assert.equal(e.data.needIdentity, true);
      assert.equal(e.message, {
        tr: 'Git, commit yazarını bilmiyor. Ad ve e-posta gir. Değişiklikler geri alındı.',
        en: 'Git does not know the commit author. Enter a name and email. The changes were rolled back.'
      }[lang]);
    }
    assert.deepEqual(I18n.missing.filter((entry) => entry.includes(':pub.')), []);
  } finally { rmrf(tmp); }
});

test('PackagePublisher.updateAll: yanıt iletisi ve commit konusu işlem anındaki dilde (Marketplace güncellendi / Değişiklik yok)', real, async () => {
  const tmp = tmpDir();
  try {
    const expected = {
      tr: { updated: 'Marketplace güncellendi', none: 'Değişiklik yok', subject: 'Marketplace güncellendi' },
      en: { updated: 'Marketplace updated', none: 'No changes', subject: 'Marketplace updated' }
    };
    for (const [lang, run] of Object.entries(LANGS)) {
      const mk = seed(tmp, 'mk-' + lang);
      const s = buildStack(mk, tmp);
      const first = await run(() => s.publisher.updateAll(mk));
      assert.ok(first.commit, lang);
      assert.equal(first.message, expected[lang].updated);
      assert.equal(sh(mk, ['log', '-1', '--format=%s'], gitEnv(tmp)).trim(), expected[lang].subject, 'commit konusu işlem anındaki dilde ' + lang);
      const second = await run(() => s.publisher.updateAll(mk));
      assert.equal(second.commit, null);
      assert.equal(second.message, expected[lang].none);
    }
  } finally { rmrf(tmp); }
});

/** Summary: HEAD commit konusu. */
const subjectOf = (mk, tmp) => sh(mk, ['log', '-1', '--format=%s'], gitEnv(tmp)).trim();

/** Summary: Annotated tag notunun satırları (sondaki boş satırlar atılır). */
const tagLines = (mk, tmp, tag) => sh(mk, ['for-each-ref', '--format=%(contents)', 'refs/tags/' + tag], gitEnv(tmp)).replace(/\n+$/, '').split('\n');

/** Summary: Ajan ve skill promptları ekleyip commit'ler; üç türün de (komut, ajan, skill) çıktıya girmesi için. */
function addAgentAndSkill(mk, tmp) {
  write(mk, 'prompts/ornek/ag.md', '---\nbaslik: Ag\ntur: ajan\naciklama: Ajan aciklamasi\nizinli_araclar: Read, Grep\nmodel: sonnet\n---\nAjan govde\n');
  write(mk, 'prompts/ornek/sk.md', '---\nbaslik: Sk\ntur: skill\naciklama: Skill aciklamasi\n---\nSkill govde\n');
  commitAll(mk, tmp);
}

test('PackagePublisher.publish: commit konusu ve tag notu işlem anındaki dilde; tag adı ve sürüm dilden bağımsız', real, async () => {
  const tmp = tmpDir();
  try {
    const expected = {
      tr: {
        first: 'ornek: 1.0.0 sürümü yayınlandı',
        firstLines: ['+ plugins/ornek/commands/aa.md (yeni)', '+ plugins/ornek/commands/bb.md (yeni)'],
        second: 'ornek: 2.0.0 sürümü yayınlandı',
        secondLines: ['+ plugins/ornek/commands/cc.md (yeni)', '~ plugins/ornek/commands/aa.md (değişti)', '- plugins/ornek/commands/bb.md (kaldırıldı)'],
        none: 'ornek 1.0.0\n\nDeğişiklik yok, mevcut çıktı etiketlendi.'
      },
      en: {
        first: 'ornek: version 1.0.0 published',
        firstLines: ['+ plugins/ornek/commands/aa.md (new)', '+ plugins/ornek/commands/bb.md (new)'],
        second: 'ornek: version 2.0.0 published',
        secondLines: ['+ plugins/ornek/commands/cc.md (new)', '~ plugins/ornek/commands/aa.md (changed)', '- plugins/ornek/commands/bb.md (removed)'],
        none: 'ornek 1.0.0\n\nNo changes, the existing output was tagged.'
      }
    };
    const tags = {};
    for (const [lang, run] of Object.entries(LANGS)) {
      const mk = seed(tmp, 'mk-' + lang);
      const s = buildStack(mk, tmp);
      const first = await run(() => s.publisher.publish(mk, { name: 'ornek' }));
      assert.equal(subjectOf(mk, tmp), expected[lang].first, lang);
      const firstNote = tagLines(mk, tmp, first.tag);
      assert.deepEqual(firstNote.slice(0, 2), ['ornek 1.0.0', ''], lang);
      assert.deepEqual(firstNote.slice(2).sort(), expected[lang].firstLines.slice().sort(), lang);

      write(mk, 'prompts/ornek/a.md', cmd('A', 'komut_adi: aa\n') + 'ek satir\n');
      fs.rmSync(path.join(mk, 'prompts', 'ornek', 'b.md'));
      write(mk, 'prompts/ornek/c.md', cmd('C', 'komut_adi: cc\n'));
      commitAll(mk, tmp);
      const second = await run(() => s.publisher.publish(mk, { name: 'ornek', version: '2.0.0' }));
      assert.equal(subjectOf(mk, tmp), expected[lang].second, lang);
      const secondNote = tagLines(mk, tmp, second.tag);
      assert.deepEqual(secondNote.slice(0, 2), ['ornek 2.0.0', ''], lang);
      assert.deepEqual(secondNote.slice(2).sort(), expected[lang].secondLines.slice().sort(), lang);
      tags[lang] = [first.tag, second.tag, first.version, second.version];
      assert.equal(run(() => tagNote('ornek', '1.0.0', [], [])), expected[lang].none, lang);
    }
    assert.deepEqual(tags.tr, ['paket/ornek/v1.0.0', 'paket/ornek/v2.0.0', '1.0.0', '2.0.0']);
    assert.deepEqual(tags.en, tags.tr);
    assert.deepEqual(I18n.missing.filter((entry) => entry.includes(':gitmsg.')), []);
  } finally { rmrf(tmp); }
});

test('PackagePublisher.publish: plugins/ ve .claude-plugin/ çıktısı (komut, ajan, skill, plugin.json, marketplace.json) tr ve en için bayt bayt aynı', real, async () => {
  const dirs = { tr: tmpDir(), en: tmpDir() };
  try {
    const outputs = {};
    const subjects = {};
    for (const [lang, run] of Object.entries(LANGS)) {
      const mk = seed(dirs[lang], 'mk');
      addAgentAndSkill(mk, dirs[lang]);
      const s = buildStack(mk, dirs[lang]);
      await run(() => s.publisher.publish(mk, { name: 'ornek' }));
      subjects[lang] = subjectOf(mk, dirs[lang]);
      outputs[lang] = Object.fromEntries(Object.entries(snapshot(mk)).filter(([rel]) => rel.startsWith('plugins/') || rel.startsWith('.claude-plugin/')));
    }
    const files = Object.keys(outputs.tr).filter((rel) => !rel.endsWith('/')).sort();
    assert.deepEqual(files, [
      '.claude-plugin/marketplace.json', 'plugins/ornek/.claude-plugin/plugin.json', 'plugins/ornek/agents/ag.md',
      'plugins/ornek/commands/aa.md', 'plugins/ornek/commands/bb.md', 'plugins/ornek/skills/sk/SKILL.md'
    ]);
    assert.deepEqual(outputs.en, outputs.tr);
    assert.notEqual(subjects.tr, subjects.en);
  } finally { for (const dir of Object.values(dirs)) rmrf(dir); }
});

test('yeni marketplace iskeleti, varsayılan açıklama ve plugins/README.md oluşturma anındaki dilde; tr çıktısı eski metinle birebir', real, async () => {
  const tmp = tmpDir();
  try {
    const legacyReadme = (name) => `# ${name}\n\nBu klasör Prompt Havuzu ile yönetilen bir Claude Code marketplace deposudur.\n\n- Promptlar \`prompts/\` altında \`.md\` dosyaları olarak tutulur.\n- \`plugins/\` ve \`.claude-plugin/\` arayüzden yayınlanınca üretilir, elle düzenlenmez.\n- İlk commit'i Prompt Havuzu'nun Git panelinden atabilirsin.\n`;
    const legacyPluginsReadme = '# plugins\n\nBu klasördeki komut, ajan ve skill dosyaları `prompts/` içindeki promptlardan otomatik üretilir.\nDüzenlemeyi kaynakta yap, sonra arayüzden yayınla. Burada yapılan değişiklikler bir sonraki yayında ezilir.\n';
    const factory = new MarketplaceFactory({ git: new GitService({ env: gitEnv(tmp) }), templates });
    const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
    const made = {};
    for (const [lang, run] of Object.entries(LANGS)) {
      const created = await run(() => factory.create(tmp, { name: 'Deneme ' + lang }));
      const own = await run(() => factory.create(tmp, { name: 'Ozel ' + lang, description: 'Özel açıklama' }));
      const mk = seed(tmp, 'mk-' + lang);
      await run(() => buildStack(mk, tmp).publisher.updateAll(mk));
      made[lang] = {
        readme: read(created.dir, 'README.md'),
        description: JSON.parse(read(created.dir, 'pp.config.json')).marketplace.description,
        manifestDescription: JSON.parse(read(created.dir, '.claude-plugin/marketplace.json')).description,
        ownDescription: JSON.parse(read(own.dir, 'pp.config.json')).marketplace.description,
        pluginsReadme: read(mk, 'plugins/README.md')
      };
      assert.equal(created.name, 'deneme-' + lang);
    }
    assert.equal(made.tr.readme, legacyReadme('deneme-tr'));
    assert.equal(made.tr.pluginsReadme, legacyPluginsReadme);
    assert.deepEqual([made.tr.description, made.tr.manifestDescription, made.tr.ownDescription], ['Prompt havuzu: deneme-tr', 'Prompt havuzu: deneme-tr', 'Özel açıklama']);
    assert.ok(made.en.readme.startsWith('# deneme-en\n\nThis folder is a Claude Code marketplace repository managed with Prompt Havuzu.\n'), made.en.readme);
    assert.ok(made.en.readme.includes('- Prompts are kept as `.md` files under `prompts/`.\n'));
    assert.ok(!DIACRITIC_RE.test(made.en.readme));
    assert.ok(made.en.pluginsReadme.startsWith('# plugins\n\nThe command, agent, and skill files in this folder are generated automatically from the prompts in `prompts/`.\n'), made.en.pluginsReadme);
    assert.ok(!DIACRITIC_RE.test(made.en.pluginsReadme));
    assert.deepEqual([made.en.description, made.en.manifestDescription, made.en.ownDescription], ['Prompt library: deneme-en', 'Prompt library: deneme-en', 'Özel açıklama']);
    assert.deepEqual(I18n.missing.filter((entry) => entry.includes(':scaffold.')), []);
  } finally { rmrf(tmp); }
});

test('RemoteSync: ön kontrol ve ileri sarma iletileri tr Türkçe, en İngilizce; code, status ve data aynı', real, async () => {
  const tmp = tmpDir();
  try {
    const { a, b, sa, sb, bare } = await twoCopies(tmp);
    const x = makeRepo(tmp, 'x');
    const sx = buildStack(x, tmp);
    const r2 = makeBare(tmp, 'r2.git');
    const noBranch = seed(tmp, 'n');
    const sn = buildStack(noBranch, tmp);
    await sn.git.addRemote(noBranch, 'origin', r2);
    const unborn = makeRepo(tmp, 'unborn');
    const su = buildStack(unborn, tmp);
    await su.git.addRemote(unborn, 'origin', makeBare(tmp, 'r3.git'));
    const cases = [
      { name: 'commitYok', make: () => su.remoteSync.pull(unborn, {}), status: 409, data: { code: 'commitYok' },
        tr: 'Henüz commit yok, ileri sarma yapılamaz.', en: 'There are no commits yet, so a fast-forward is not possible.' },
      { name: 'remoteYok', make: () => sx.remoteSync.fetch(x, {}), status: 409, data: { code: 'remoteYok' },
        tr: 'Uzak depo tanımlı değil. Önce bir uzak depo ekle.', en: 'No remote is configured. Add a remote first.' },
      { name: 'remoteYokPush', make: () => sx.remoteSync.push(x, {}), status: 409, data: { code: 'remoteYok' },
        tr: 'Uzak depo tanımlı değil. Önce bir uzak depo ekle.', en: 'No remote is configured. Add a remote first.' },
      { name: 'bulunamadi', make: () => sa.remoteSync.fetch(a, { remote: 'yok' }), status: 404, data: undefined,
        tr: 'Uzak depo bulunamadı: yok', en: 'Remote not found: yok' },
      { name: 'bulunamadiDuzenle', make: () => sa.remoteSync.setRemote(a, 'yok', bare), status: 404, data: undefined,
        tr: 'Uzak depo bulunamadı: yok', en: 'Remote not found: yok' },
      { name: 'adVar', make: () => sa.remoteSync.addRemote(a, 'origin', bare), status: 409, data: undefined,
        tr: 'Bu adda bir uzak depo zaten var: origin', en: 'A remote with this name already exists: origin' },
      { name: 'uzakDalYok', make: () => sn.remoteSync.pull(noBranch, {}), status: 409, data: { code: 'uzakDalYok' },
        tr: 'Uzak depoda "main" dalı yok.', en: 'The remote has no "main" branch.' }
    ];
    for (const c of cases) {
      await assertBothLanguages(c.name, c.make, (e, lang) => {
        assert.ok(e instanceof RemoteError, c.name);
        assert.equal(e.message, c[lang], c.name + ' ' + lang);
        assert.equal(e.status, c.status, c.name);
        assert.deepEqual(e.data, c.data, c.name);
      });
    }

    sh(a, ['checkout', '--detach', '-q'], gitEnv(tmp));
    await assertBothLanguages('dalYokPush', () => sa.remoteSync.push(a, {}), (e, lang) => {
      assert.deepEqual(e.data, { code: 'dalYok' });
      assert.equal(e.message, { tr: 'HEAD bir dala bağlı değil, push yapılamaz.', en: 'HEAD is not attached to a branch, so push is not possible.' }[lang]);
    });
    await assertBothLanguages('dalYok', () => sa.remoteSync.pull(a, {}), (e, lang) => {
      assert.deepEqual(e.data, { code: 'dalYok' });
      assert.equal(e.message, { tr: 'HEAD bir dala bağlı değil.', en: 'HEAD is not attached to a branch.' }[lang]);
    });
    sh(a, ['checkout', 'main', '-q'], gitEnv(tmp));

    await sb.publisher.publish(b, { name: 'ornek', push: true });
    write(a, 'prompts/ornek/yerel.md', cmd('Yerel'));
    await assertBothLanguages('kirli', () => sa.remoteSync.pull(a, {}), (e, lang) => {
      assert.deepEqual(e.data, { code: 'kirliCalismaAgaci', files: ['prompts/ornek/yerel.md'] });
      assert.equal(e.message, {
        tr: 'Önce bu dosyaları kaydet (commit) ya da geri al: prompts/ornek/yerel.md',
        en: 'First save (commit) or revert these files: prompts/ornek/yerel.md'
      }[lang]);
    });
    for (let i = 1; i <= 6; i++) write(a, `prompts/ornek/z${i}.md`, cmd('Z' + i));
    await assertBothLanguages('kirliCok', () => sa.remoteSync.pull(a, {}), (e, lang) => {
      assert.equal(e.data.files.length, 7);
      const list = e.data.files.slice(0, 5).join(', ') + ' …';
      assert.equal(e.message, {
        tr: 'Önce bu dosyaları kaydet (commit) ya da geri al: ' + list,
        en: 'First save (commit) or revert these files: ' + list
      }[lang]);
    });

    commitAll(a, tmp);
    await assertBothLanguages('ayristi', () => sa.remoteSync.pull(a, {}), (e, lang) => {
      assert.deepEqual(e.data, { code: 'ayristi' });
      assert.equal(e.message, {
        tr: 'Yerelde push edilmemiş commit var ve uzak depo da ilerlemiş. Bu araç birleştirme yapmaz; terminalde: git -C ' + a + ' pull --rebase',
        en: 'There are local commits that have not been pushed and the remote has also moved ahead. This tool does not merge; in a terminal run: git -C ' + a + ' pull --rebase'
      }[lang]);
    });

    const cleanDir = path.join(tmp, 'temiz');
    fs.mkdirSync(cleanDir);
    const clean = await twoCopies(cleanDir);
    await clean.sb.publisher.publish(clean.b, { name: 'ornek', push: true });
    assert.equal((await clean.sa.remoteSync.pull(clean.a, {})).ok, true);
    await assertBothLanguages('guncel', () => clean.sa.remoteSync.pull(clean.a, {}), (e, lang) => {
      assert.deepEqual(e.data, { code: 'guncel' });
      assert.equal(e.message, { tr: 'Zaten güncel', en: 'Already up to date' }[lang]);
    });
    assert.deepEqual(I18n.missing.filter((entry) => entry.includes(':remote.')), []);
  } finally { rmrf(tmp); }
});

test('RemoteSync.pull: tag benimsemede hata ve geri alma başarısızlığı iletileri iki dilde', real, async () => {
  const tmp = tmpDir();
  try {
    const scenarios = [
      { name: 'failed', over: { createTagAt: async () => { throw new Error('tag yazilamadi'); } },
        tr: 'Güncelleme başarısız: tag yazilamadi. Yapılan değişiklikler geri alındı.',
        en: 'Update failed: tag yazilamadi. The changes were rolled back.',
        check: (e) => { assert.deepEqual(e.data, { code: 'geriAlindi' }); } },
      { name: 'rollbackFailed',
        over: { createTagAt: async () => { throw new Error('tag yazilamadi'); }, resetKeep: async () => { throw new Error('reset patladi'); } },
        tr: 'Güncelleme başarısız ve geri alma tamamlanamadı: reset patladi. Git panelinden durumu kontrol et.',
        en: 'Update failed and the rollback could not be completed: reset patladi. Check the status in the Git panel.',
        check: (e) => { assert.deepEqual(e.data, { code: 'rollbackFailed', rollbackFailed: true }); } }
    ];
    for (const sc of scenarios) {
      for (const [lang, run] of Object.entries(LANGS)) {
        const dir = path.join(tmp, sc.name + '-' + lang);
        fs.mkdirSync(dir);
        class Broken extends GitService {}
        Object.assign(Broken.prototype, sc.over);
        const { a, b, sa, sb } = await twoCopies(dir, { gitA: new Broken({ env: gitEnv(dir) }) });
        await sb.publisher.publish(b, { name: 'ornek', push: true });
        const e = await run(() => rejected(sa.remoteSync.pull(a, {})));
        assert.ok(e instanceof RemoteError, sc.name);
        assert.equal(e.status, 500);
        assert.equal(e.message, sc[lang], sc.name + ' ' + lang);
        sc.check(e);
      }
    }
  } finally { rmrf(tmp); }
});

test('lastCheck: diske error metni yazılmaz (yalnız code), status ve fetch dönüşünde error okuma anındaki dilde üretilir', real, async () => {
  const tmp = tmpDir();
  try {
    const { a, sa } = await twoCopies(tmp);
    const badUrl = path.join(tmp, 'yok.git');
    await sa.git.setRemoteUrl(a, 'origin', badUrl);
    const results = {};
    for (const [lang, run] of Object.entries(LANGS)) {
      results[lang] = await run(() => sa.remoteSync.fetch(a, { remote: 'origin', background: false }));
      assert.equal(results[lang].ok, false);
      assert.ok(results[lang].code);
      assert.equal(results[lang].error, run(() => describeNetError(results[lang].code, { url: badUrl, dir: a })));
    }
    assert.notEqual(results.tr.error, results.en.error);
    assert.equal(results.tr.code, results.en.code);
    const code = results.tr.code;

    const disk = JSON.parse(readStateText(a));
    assert.deepEqual(Object.keys(disk.lastCheck).sort(), ['at', 'behind', 'code', 'newCommits', 'newTags', 'ok']);
    assert.equal(disk.lastCheck.code, code);
    assert.equal(disk.lastCheck.ok, false);
    assert.equal(Object.prototype.hasOwnProperty.call(disk.lastCheck, 'error'), false);
    const text = readStateText(a);
    for (const dictionary of [TR, EN]) {
      for (const key of Object.keys(dictionary).filter((k) => k.startsWith('net.') && !k.includes('Placeholder'))) {
        const value = dictionary[key];
        const fixed = value.split(/\{[a-z]+\}/i).filter((part) => part.length > 8);
        for (const part of fixed) assert.ok(!text.includes(part), 'diskte ileti parçası yok: ' + key);
      }
    }

    const trStatus = await inTr(() => sa.remoteSync.status(a));
    const enStatus = await inEn(() => sa.remoteSync.status(a));
    const trAgain = await inTr(() => sa.remoteSync.status(a));
    assert.equal(trStatus.lastCheck.error, results.tr.error);
    assert.equal(enStatus.lastCheck.error, results.en.error);
    assert.equal(trAgain.lastCheck.error, results.tr.error);
    assert.deepEqual(Object.keys(trStatus.lastCheck).sort(), ['at', 'behind', 'code', 'error', 'newCommits', 'newTags', 'ok']);
    assert.equal(trStatus.lastCheck.ok, false);
    assert.equal(trStatus.lastCheck.code, code);
    assert.deepEqual(Object.keys(JSON.parse(readStateText(a)).lastCheck).sort(), ['at', 'behind', 'code', 'newCommits', 'newTags', 'ok'], 'status diske yazmaz');
  } finally { rmrf(tmp); }
});

test('lastCheck: başarılı kontrol ve pull diske error yazmaz; status error: null döner', real, async () => {
  const tmp = tmpDir();
  try {
    const { a, b, sa, sb } = await twoCopies(tmp);
    const f = await sa.remoteSync.fetch(a, {});
    assert.equal(f.ok, true);
    let disk = JSON.parse(readStateText(a));
    assert.equal(disk.lastCheck.ok, true);
    assert.equal(Object.prototype.hasOwnProperty.call(disk.lastCheck, 'error'), false);
    const st = await inEn(() => sa.remoteSync.status(a));
    assert.equal(st.lastCheck.error, null);
    assert.equal(st.lastCheck.ok, true);

    await sb.publisher.publish(b, { name: 'ornek', push: true });
    await sa.remoteSync.pull(a, {});
    disk = JSON.parse(readStateText(a));
    assert.equal(disk.lastCheck.ok, true);
    assert.equal(Object.prototype.hasOwnProperty.call(disk.lastCheck, 'error'), false);
    assert.equal((await inTr(() => sa.remoteSync.status(a))).lastCheck.error, null);
  } finally { rmrf(tmp); }
});

test('lastCheck: eski biçimli dosya (error metinli) okunur; error okuma anındaki dilde koddan üretilir, eski metin sızmaz', real, async () => {
  const tmp = tmpDir();
  try {
    const { a, sa } = await twoCopies(tmp);
    fs.writeFileSync(stateFile(a), JSON.stringify({ pendingTags: ['paket/ornek/v1.0.0'], lastCheck: OLD_FAILED_CHECK }, null, 2) + '\n');
    const trLast = (await inTr(() => sa.remoteSync.status(a))).lastCheck;
    const enLast = (await inEn(() => sa.remoteSync.status(a))).lastCheck;
    assert.equal(trLast.error, TR['net.ag']);
    assert.equal(enLast.error, EN['net.ag']);
    for (const last of [trLast, enLast]) {
      assert.equal(last.ok, false);
      assert.equal(last.code, 'ag');
      assert.equal(last.at, OLD_FAILED_CHECK.at);
      assert.ok(!JSON.stringify(last).includes('Eski diskten'));
    }
    assert.deepEqual((await sa.remoteSync.status(a)).pendingTags, ['paket/ornek/v1.0.0']);
    const raw = await sa.state.get(a);
    assert.equal(Object.prototype.hasOwnProperty.call(raw.lastCheck, 'error'), false);
    assert.deepEqual(raw.pendingTags, ['paket/ornek/v1.0.0']);

    const elle = await inEn(() => sa.remoteSync.fetch(a, { background: true, setting: 'elle' }));
    assert.equal(elle.skipped, 'elle');
    assert.equal(elle.cached, true);
    assert.equal(elle.ok, false);
    assert.equal(elle.error, EN['net.ag']);

    fs.writeFileSync(stateFile(a), JSON.stringify({ pendingTags: [], lastCheck: { at: new Date().toISOString(), ok: true, behind: 2, ahead: 0, newTags: ['t'], newCommits: [], error: null } }));
    const cached = await inEn(() => sa.remoteSync.fetch(a, { background: true, setting: 'acilista' }));
    assert.equal(cached.cached, true);
    assert.equal(cached.ok, true);
    assert.equal(cached.error, null);
    assert.equal(cached.behind, 2);

    fs.writeFileSync(stateFile(a), JSON.stringify({ lastCheck: { at: '2026-01-01T00:00:00.000Z', ok: false, error: 'Kodsuz eski ileti' } }));
    assert.equal((await inEn(() => sa.remoteSync.status(a))).lastCheck.error, EN['net.bilinmiyor']);
    assert.equal((await inTr(() => sa.remoteSync.status(a))).lastCheck.error, TR['net.bilinmiyor']);

    for (const bad of ['"metin"', '[1,2]', '7', 'null']) {
      fs.writeFileSync(stateFile(a), '{"lastCheck":' + bad + ',"pendingTags":"x"}');
      const st = await inEn(() => sa.remoteSync.status(a));
      assert.equal(st.lastCheck, null, bad);
      assert.deepEqual(st.pendingTags, [], bad);
    }
    fs.writeFileSync(stateFile(a), '{bozuk');
    assert.equal((await sa.remoteSync.status(a)).lastCheck, null);
  } finally { rmrf(tmp); }
});

test('lastCheck: kimlik hatası iletisi okuma anındaki remote URL ve klasörüyle üretilir (SSH ve HTTPS ayrımı)', real, async () => {
  const tmp = tmpDir();
  try {
    const { a, sa } = await twoCopies(tmp);
    const record = { at: '2026-01-01T00:00:00.000Z', ok: false, code: 'kimlik', behind: 0, newTags: [], newCommits: [] };
    await sa.state.setLastCheck(a, record);
    await sa.git.setRemoteUrl(a, 'origin', 'git@github.com:u/r.git');
    assert.equal((await inEn(() => sa.remoteSync.status(a))).lastCheck.error, EN['net.kimlikSsh']);
    assert.equal((await inTr(() => sa.remoteSync.status(a))).lastCheck.error, TR['net.kimlikSsh']);
    await sa.git.setRemoteUrl(a, 'origin', 'https://github.com/u/r.git');
    const en = (await inEn(() => sa.remoteSync.status(a))).lastCheck.error;
    assert.equal(en, EN['net.kimlik'].replace('{dir}', a));
    assert.equal((await inTr(() => sa.remoteSync.status(a))).lastCheck.error, TR['net.kimlik'].replace('{dir}', a));
  } finally { rmrf(tmp); }
});

test('StateStore: setLastCheck error alanını atar, get eski error alanını yok sayar, yeniden yazım eski metni diskten siler', async () => {
  const tmp = tmpDir();
  try {
    const dir = path.join(tmp, 'depo');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const store = new StateStore();
    await store.setLastCheck(dir, { at: 'x', ok: false, code: 'ag', error: 'Bu metin diske yazılmamalı', behind: 0, newTags: [], newCommits: [] });
    assert.ok(!readStateText(dir).includes('Bu metin'));
    assert.deepEqual((await store.get(dir)).lastCheck, { at: 'x', ok: false, code: 'ag', behind: 0, newTags: [], newCommits: [] });
    await store.setLastCheck(dir, null);
    assert.equal((await store.get(dir)).lastCheck, null);

    fs.writeFileSync(stateFile(dir), JSON.stringify({ pendingTags: ['paket/a/v1.0.0'], lastCheck: OLD_FAILED_CHECK }));
    assert.equal((await store.get(dir)).lastCheck.code, 'ag');
    assert.equal(Object.prototype.hasOwnProperty.call((await store.get(dir)).lastCheck, 'error'), false);
    assert.ok(readStateText(dir).includes('Eski diskten'), 'okuma dosyayı değiştirmez');
    await store.addPending(dir, 'paket/b/v1.0.0');
    assert.ok(!readStateText(dir).includes('Eski diskten'), 'yeniden yazım eski metni siler');
    assert.deepEqual((await store.get(dir)).pendingTags, ['paket/a/v1.0.0', 'paket/b/v1.0.0']);
    assert.equal((await store.get(dir)).lastCheck.code, 'ag');
  } finally { rmrf(tmp); }
});

test('RemoteSync: durum önbelleği dil taşımaz (aynı örnek art arda tr, en, tr)', real, async () => {
  const tmp = tmpDir();
  try {
    const { a, sa } = await twoCopies(tmp);
    await sa.state.setLastCheck(a, { at: '2026-01-01T00:00:00.000Z', ok: false, code: 'zamanAsimi', behind: 0, newTags: [], newCommits: [] });
    const sequence = [];
    for (const run of [inTr, inEn, inTr, inEn]) sequence.push((await run(() => sa.remoteSync.status(a))).lastCheck.error);
    assert.deepEqual(sequence, [TR['net.zamanAsimi'], EN['net.zamanAsimi'], TR['net.zamanAsimi'], EN['net.zamanAsimi']]);
    const parallel = await Promise.all([inEn(() => sa.remoteSync.status(a)), inTr(() => sa.remoteSync.status(a))]);
    assert.deepEqual(parallel.map((st) => st.lastCheck.error), [EN['net.zamanAsimi'], TR['net.zamanAsimi']]);
  } finally { rmrf(tmp); }
});

test('sözlük: ver.err.*, hist.err.*, pub.*, remote.* anahtar kümesi, yer tutucular ve çoğul kategorileri tr ve en için eşit', () => {
  const keys = stageKeys(TR);
  assert.deepEqual(stageKeys(EN), keys);
  assert.equal(EXPECTED_KEYS.length, 54);
  assert.deepEqual(keys, EXPECTED_KEYS);
  for (const ns of NAMESPACES) assert.ok(keys.some((key) => key.startsWith(ns)), ns);
  for (const key of keys) {
    const trValue = TR[key];
    const enValue = EN[key];
    assert.equal(typeof trValue, typeof enValue, 'aynı biçim ' + key);
    const trVariants = variants(trValue);
    const enVariants = variants(enValue);
    const all = [...Object.values(trVariants), ...Object.values(enVariants)];
    assert.ok(all.every((text) => typeof text === 'string' && text.trim().length > 0), 'boş değer yok ' + key);
    const expected = placeholders(all[0]);
    for (const text of all) assert.deepEqual(placeholders(text), expected, 'yer tutucu kümesi ' + key + ': ' + text);
    if (typeof trValue === 'object') {
      assert.ok(expected.includes('count'), 'çoğul anahtar count ister ' + key);
      assert.deepEqual(Object.keys(trVariants), ['other'], 'tr yalnızca other ' + key);
      assert.deepEqual(Object.keys(enVariants).sort(), ['one', 'other'], 'en one + other ' + key);
    }
  }
  assert.deepEqual(keys.filter((key) => typeof TR[key] === 'object'), ['pub.err.dogrulama']);
  assert.deepEqual(placeholders(TR['ver.err.tagVar']), ['field', 'tag']);
  assert.deepEqual(placeholders(TR['remote.err.ayristi']), ['dir']);
});

test('en değerlerinde Türkçe diyakritik ve en-GB yazım yok; ver.adv.* anahtarlarına dokunulmadı', () => {
  for (const key of stageKeys(EN)) {
    for (const text of Object.values(variants(EN[key]))) {
      assert.ok(!DIACRITIC_RE.test(text), key + ': ' + text);
      assert.doesNotMatch(text, /initialis|cancell|colour|behaviour|catalogue|organis/i, key);
    }
  }
  assert.equal(Object.keys(TR).filter((key) => key.startsWith('ver.adv.')).length, 11);
  assert.equal(Object.keys(EN).filter((key) => key.startsWith('ver.adv.')).length, 11);
});

test('kaynak taraması: tx anahtarları sözlükte, her çağrı sabit anahtarlı; Türkçe diyakritikli dize yalnızca Aşama 6 metinleri', () => {
  const used = new Set();
  const remaining = [];
  for (const file of SOURCES) {
    const src = fs.readFileSync(path.join(LIB, file), 'utf8');
    const calls = (src.match(/\btx\(/g) || []).length;
    const constant = (src.match(/\btx\('[^']+'/g) || []).length;
    assert.equal(constant, calls, file + ': her tx çağrısı sabit anahtarla');
    for (const m of src.matchAll(/\btx\('([^']+)'/g)) used.add(m[1]);
    const literals = stringLiterals(src);
    assert.ok(literals.length > 0 || file === 'state-store.js', file + ': tarayıcı dizeleri buluyor');
    for (const text of literals) if (DIACRITIC_RE.test(text) && !ALLOWED_TURKISH_LITERALS.includes(text)) remaining.push(file + ': ' + text);
    assert.ok(!src.includes('\r'), file + ': LF');
  }
  assert.deepEqual(remaining, [], 'çevrilmemiş Türkçe dize');
  for (const key of used) {
    assert.ok(Object.prototype.hasOwnProperty.call(TR, key), 'tr: ' + key);
    assert.ok(Object.prototype.hasOwnProperty.call(EN, key), 'en: ' + key);
  }
  assert.deepEqual([...used].sort(), EXPECTED_KEYS, 'kaynakta kullanılan anahtarlar = bu aşamanın anahtarları');
  assert.deepEqual(stringLiterals("a = /[\"']/; b = 'x/y'; // 'z'\nc = \"ş\"; d = x / 2; e = `t`"), ['x/y', 'ş', 't']);
});
