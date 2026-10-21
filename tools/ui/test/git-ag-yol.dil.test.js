'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const I18n = require('../public/i18n.js');
const TR = require('../public/lang/tr.js');
const EN = require('../public/lang/en.js');
const { describeGitError, explainGitError, sanitizeDetail } = require('../lib/git-errors');
const { describeNetError } = require('../lib/net-errors');
const { GitService, GitError, GitNotFoundError } = require('../lib/git-service');
const { resolveSafe, checkNewPath } = require('../lib/safe-path');
const { OpLock, BusyError } = require('../lib/op-lock');
const { UndoStack } = require('../lib/undo');
const { gitAvailable, tmpDir, rmrf, gitEnv, makeRepo } = require('./helpers');
const { makeLink, removeLink } = require('./links');

const LIB = path.join(__dirname, '..', 'lib');
const SOURCES = ['git-errors.js', 'net-errors.js', 'git-service.js', 'safe-path.js', 'op-lock.js', 'undo.js'];
const NAMESPACES = ['git.', 'net.', 'err.path.', 'err.lock.', 'err.undo.'];
const DIACRITIC_RE = /[çğıöşüÇĞİÖŞÜ]/;
const PLACEHOLDER_RE = /\{([A-Za-z_]\w*)\}/g;
const EXPECTED_KEYS = [
  'git.error.kilit', 'git.error.commitReddedildi', 'git.error.eklenemedi', 'git.error.bilinmiyor',
  'git.notFound', 'git.timeout', 'git.toolRepo', 'git.emptyResponse', 'git.invalidCommit', 'git.invalidTagName', 'git.invalidLimit',
  'git.invalidPath', 'git.headDetachedUndo', 'git.invalidRefName', 'git.invalidRemoteName', 'git.invalidUrl', 'git.headMismatch',
  'git.invalidDirName',
  'net.kimlikSsh', 'net.kimlik', 'net.ag', 'net.bulunamadi', 'net.reddedildi', 'net.zamanAsimi', 'net.mesgul', 'net.atomikYok',
  'net.bilinmiyor', 'net.dirPlaceholder',
  'err.path.required', 'err.path.invalid', 'err.path.dotGit', 'err.path.linkOutside', 'err.path.linkBroken',
  'err.lock.busy',
  'err.undo.stepNotFunction', 'err.undo.rollbackFailed'
].sort();
/** Summary: Bilinçli olarak çevrilmeyen Türkçe dize değişmezleri (git reflog verisi; Aşama 6'da ele alınır). */
const ALLOWED_TURKISH_LITERALS = ['prompt-havuzu: sürüm geri alındı'];
const HASH = 'a'.repeat(40);
const OTHER_HASH = 'b'.repeat(40);

/** Summary: Çağrıyı İngilizce dil bağlamında çalıştırır. */
const inEn = (fn) => I18n.run('en', fn);

/** Summary: Çağrıyı Türkçe dil bağlamında çalıştırır. */
const inTr = (fn) => I18n.run('tr', fn);

/** Summary: Verilen süre sonra çözülen söz. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Summary: Eşzamanlı çağrının fırlattığı hatayı döner (fırlatmazsa test başarısız olur). */
function thrown(fn) {
  try { fn(); } catch (e) { return e; }
  return assert.fail('hata fırlatılmadı');
}

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

/** Summary: Sahte runner: her çağrıyı kaydeder, sonucu result(cb, args) belirler. */
function fakeRunner(result) {
  const calls = [];
  const runner = (bin, args, opts, cb) => { calls.push({ bin, args, opts }); result(cb, args); };
  return { runner, calls };
}

/** Summary: Her komutu başarıyla (boş çıktı) tamamlayan sahte runner. */
const okRunner = () => fakeRunner((cb) => cb(null, '', ''));

/** Summary: Git sürecinin gerçek başarısızlığını taklit eden GitError. */
function rawGitError(stderr, sub) {
  return new GitError(stderr, { stderr, exitCode: 128, args: ['-C', 'x', '-c', 'core.quotepath=false', sub] });
}

const DIR = path.resolve('r');

test('describeGitError: her kod için varsayılan ve tr Türkçe, en İngilizce; bilinmeyen kod bilinmiyor iletisi', () => {
  const table = {
    kilit: [
      'Git şu an başka bir işlemle meşgul ya da yarım kalmış bir kilit dosyası (.git/index.lock) var. Çalışan bir git işlemi yoksa dosyayı silip tekrar dene.',
      'Git is busy with another operation, or an unfinished lock file (.git/index.lock) exists. If no git operation is running, delete the file and try again.'
    ],
    commitReddedildi: [
      "Git commit'i reddetti. Bir commit hook'u ya da git ayarı engelliyor olabilir.",
      'Git rejected the commit. A commit hook or a git setting may be blocking it.'
    ],
    eklenemedi: [
      'Git dosyaları ekleyemedi. Dosya adı ya da yolu bu sistemde kullanılamıyor olabilir (örneğin Windows aygıt adı).',
      'Git could not add the files. The file name or path may not be usable on this system (for example, a Windows device name).'
    ],
    bilinmiyor: ['Git işlemi başarısız oldu.', 'The git operation failed.']
  };
  for (const [code, [wantTr, wantEn]] of Object.entries(table)) {
    assert.equal(describeGitError(code), wantTr, 'varsayılan ' + code);
    assert.equal(inTr(() => describeGitError(code)), wantTr, 'tr ' + code);
    assert.equal(inEn(() => describeGitError(code)), wantEn, 'en ' + code);
    assert.match(wantEn, /\.$/, 'en ileti noktayla biter ' + code);
  }
  assert.equal(inEn(() => describeGitError('olmayan')), 'The git operation failed.');
  assert.equal(inEn(() => describeGitError(undefined)), 'The git operation failed.');
});

test('explainGitError: en bağlamında error İngilizce özet, code ve gitDetail dilden bağımsız', () => {
  const root = 'C:\\Users\\Demo User\\Temp\\pp-test\\PromptLibrary\\mk';
  const lock = "fatal: Unable to create 'C:/Users/Demo User/Temp/pp-test/PromptLibrary/mk/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository.";
  const run = () => explainGitError(rawGitError(lock, 'add'), [root]);
  const tr = inTr(run);
  const en = inEn(run);
  assert.equal(tr.code, 'kilit');
  assert.equal(en.code, 'kilit');
  assert.equal(tr.error, describeGitError('kilit'));
  assert.equal(en.error, inEn(() => describeGitError('kilit')));
  assert.match(en.error, /^Git is busy with another operation/);
  assert.equal(en.gitDetail, tr.gitDetail, 'gitDetail çevrilmez');
  assert.match(en.gitDetail, /^fatal: Unable to create '<yol>\/\.git\/index\.lock': File exists\./);
  assert.doesNotMatch(en.gitDetail, /Demo|Temp|C:/);

  const hook = inEn(() => explainGitError(rawGitError('HOOK-RED: yasak\n', 'commit'), [root]));
  assert.deepEqual({ code: hook.code, gitDetail: hook.gitDetail }, { code: 'commitReddedildi', gitDetail: 'HOOK-RED: yasak' });
  assert.match(hook.error, /^Git rejected the commit/);
  assert.equal(inEn(() => explainGitError(null).error), 'The git operation failed.');
  assert.equal(explainGitError(null).error, 'Git işlemi başarısız oldu.');
  assert.equal(inEn(() => sanitizeDetail("fatal: cannot open 'D:/baska yer/dosya.txt': hata", [])), "fatal: cannot open '<yol>': hata");
});

test('explainGitError: servisin kendi hatası oluşturulduğu andaki dil iletisiyle geçer, git dışı hata aynen', async () => {
  const own = await inEn(() => rejected(new GitService({ runner: okRunner().runner }).showFile(DIR, 'zzz', 'a.md')));
  const x = inTr(() => explainGitError(own, []));
  assert.deepEqual(x, { code: null, error: 'Invalid commit', gitDetail: '' }, 'ileti oluşurken sabitlenir, sonradan değişmez');
  const plain = inEn(() => explainGitError(new Error('disk dolu'), []));
  assert.deepEqual(plain, { code: null, error: 'disk dolu', gitDetail: '' });
  const notFound = inEn(() => explainGitError(new GitNotFoundError([]), []));
  assert.equal(notFound.error, 'git was not found. Git must be installed and available in PATH.');
});

test('describeNetError: her kod için tr Türkçe, en İngilizce; dir parametresi aynen görünür', () => {
  const dir = 'C:\\Library\\$&{ad} mk';
  const cases = [
    [['kimlik', { url: 'https://github.com/o/r.git', dir }],
      'Uzak depo kimlik doğrulaması başarısız. Bu araç parola soramaz. Kimlik bilgini bir kez kaydet: GitHub için "gh auth login" + "gh auth setup-git", GitLab için Git Credential Manager ile terminalde bir kez "git -C ' + dir + ' fetch" çalıştırıp giriş yap.',
      'Authentication with the remote failed. This tool cannot ask for a password. Save your credentials once: for GitHub run "gh auth login" + "gh auth setup-git"; for GitLab use Git Credential Manager and run "git -C ' + dir + ' fetch" once in a terminal to sign in.'],
    [['kimlik', { url: 'git@github.com:o/r.git', dir }],
      "SSH anahtarı kullanılamadı: anahtar ssh-agent'a yüklü olmalı, parola sormamalı ve sunucu known_hosts içinde olmalı.",
      'The SSH key could not be used: the key must be loaded in ssh-agent, must not ask for a passphrase, and the server must be in known_hosts.'],
    [['ag'], "Uzak depoya ulaşılamadı. Ağ bağlantısını ve URL'yi kontrol et.", 'Could not reach the remote. Check your network connection and the URL.'],
    [['bulunamadi'], 'Depo bulunamadı ya da erişim iznin yok.', 'Repository not found, or you do not have access.'],
    [['reddedildi', { dir }],
      'Uzak depoda yerelde olmayan commit\'ler var. Önce "Kontrol et", sonra "Güncelle" (yalnızca ileri sarma) ya da terminalde "git -C ' + dir + ' pull --rebase".',
      'The remote has commits that are not in your local copy. First press "Check", then "Update" (fast-forward only), or run "git -C ' + dir + ' pull --rebase" in a terminal.'],
    [['zamanAsimi'], 'İşlem zamanında tamamlanmadı. Bir kimlik bilgisi penceresi açık kalmış olabilir.', 'The operation did not finish in time. A credentials window may have been left open.'],
    [['mesgul'], 'Başka bir git işlemi sürüyor, bitmesini bekle.', 'Another git operation is in progress, wait for it to finish.'],
    [['atomikYok'], 'Uzak sunucu atomik push desteklemiyor.', 'The remote server does not support atomic push.'],
    [['bilinmiyor'], 'Uzak depo işlemi başarısız oldu.', 'The remote operation failed.'],
    [['olmayan'], 'Uzak depo işlemi başarısız oldu.', 'The remote operation failed.']
  ];
  for (const [args, wantTr, wantEn] of cases) {
    assert.equal(describeNetError(...args), wantTr, 'varsayılan ' + args[0]);
    assert.equal(inTr(() => describeNetError(...args)), wantTr, 'tr ' + args[0]);
    assert.equal(inEn(() => describeNetError(...args)), wantEn, 'en ' + args[0]);
  }
});

test('describeNetError: dir verilmezse yer tutucu dilin klasör ibaresidir', () => {
  assert.match(describeNetError('kimlik'), /"git -C <klasör> fetch"/);
  assert.match(inTr(() => describeNetError('reddedildi')), /"git -C <klasör> pull --rebase"/);
  assert.match(inEn(() => describeNetError('kimlik')), /"git -C <folder> fetch"/);
  assert.match(inEn(() => describeNetError('reddedildi', {})), /"git -C <folder> pull --rebase"/);
  assert.match(inEn(() => describeNetError('reddedildi', { dir: '' })), /<folder>/);
});

test('GitService doğrulama iletileri: tr Türkçe, en İngilizce, komut çalışmaz, dil ileti oluşurken belirlenir', async () => {
  const table = [
    [(g) => g.showFile(DIR, 'zzz', 'a.md'), 'Geçersiz commit', 'Invalid commit'],
    [(g) => g.deleteTag(DIR, '-x'), 'Geçersiz tag adı', 'Invalid tag name'],
    [(g) => g.listTags(DIR, '--sort'), 'Geçersiz tag adı', 'Invalid tag name'],
    [(g) => g.changeLog(DIR, { limit: 0 }), 'Geçersiz limit', 'Invalid limit'],
    [(g) => g.logRange(DIR, 'a', 'b', 0), 'Geçersiz limit', 'Invalid limit'],
    [(g) => g.wordDiff(DIR, { hash: HASH, path: '-a' }, { hash: HASH, path: 'b' }), 'Geçersiz yol', 'Invalid path'],
    [(g) => g.lsTree(DIR, HASH, '-x'), 'Geçersiz yol', 'Invalid path'],
    [(g) => g.isClean(DIR, ['-x']), 'Geçersiz yol', 'Invalid path'],
    [(g) => g.aheadBehind(DIR, 'a..b'), 'Geçersiz ref adı', 'Invalid ref name'],
    [(g) => g.refExists(DIR, 'x.lock'), 'Geçersiz ref adı', 'Invalid ref name'],
    [(g) => g.addRemote(DIR, 'Origin', 'https://h/r'), 'Geçersiz uzak depo adı', 'Invalid remote name'],
    [(g) => g.addRemote(DIR, 'origin', '-oProxy=x'), 'Geçersiz URL', 'Invalid URL'],
    [(g) => g.clone(DIR, '-x', 'dir'), 'Geçersiz URL', 'Invalid URL'],
    [(g) => g.clone(DIR, 'https://h/r.git', '../dir'), 'Geçersiz klasör adı', 'Invalid folder name']
  ];
  for (const [call, wantTr, wantEn] of table) {
    const { runner, calls } = okRunner();
    const g = new GitService({ runner });
    const label = wantEn;
    const byDefault = await rejected(call(g));
    const tr = await inTr(() => rejected(call(g)));
    const en = await inEn(() => rejected(call(g)));
    assert.ok(byDefault instanceof GitError && tr instanceof GitError && en instanceof GitError, label);
    assert.equal(byDefault.message, wantTr, 'varsayılan ' + label);
    assert.equal(tr.message, wantTr, 'tr ' + label);
    assert.equal(en.message, wantEn, 'en ' + label);
    assert.equal(en.code, null, 'doğrulama hatasında kod yok ' + label);
    assert.equal(calls.length, 0, 'komut çalışmadı ' + label);
  }
});

test('GitService: git bulunamadı, boş yanıt, HEAD iletileri en bağlamında İngilizce; kodlar ve alanlar aynı', async () => {
  const enoent = fakeRunner((cb) => cb(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }), '', ''));
  const missing = await inEn(() => rejected(new GitService({ runner: enoent.runner }).run(DIR, ['status'])));
  assert.ok(missing instanceof GitNotFoundError && missing instanceof GitError);
  assert.equal(missing.message, 'git was not found. Git must be installed and available in PATH.');
  assert.equal(missing.args.at(-1), 'status');
  const missingTr = await inTr(() => rejected(new GitService({ runner: enoent.runner }).run(DIR, ['status'])));
  assert.equal(missingTr.message, 'git bulunamadı. Git kurulu ve PATH içinde olmalı.');

  const empty = new GitService({ runner: fakeRunner((cb) => cb(null, '\n', '')).runner });
  assert.deepEqual(await inEn(() => empty.toplevelInfo(DIR)), { path: null, error: 'Empty response' });
  assert.deepEqual(await inTr(() => empty.toplevelInfo(DIR)), { path: null, error: 'Boş yanıt' });

  const noRef = new GitService({ runner: fakeRunner((cb) => cb(null, '\n', '')).runner });
  const detached = await inEn(() => rejected(noRef.undoCommit(DIR, { commit: HASH })));
  assert.equal(detached.message, 'HEAD is not attached to a branch, so the first commit could not be undone');
  const detachedTr = await inTr(() => rejected(noRef.undoCommit(DIR, { commit: HASH })));
  assert.equal(detachedTr.message, 'HEAD bir dala bağlı değil, ilk commit geri alınamadı');

  const moved = new GitService({ runner: fakeRunner((cb) => cb(null, OTHER_HASH + '\n', '')).runner });
  const mismatch = await inEn(() => rejected(moved.resetKeep(DIR, { expect: HASH, to: HASH })));
  assert.equal(mismatch.message, 'HEAD is not the expected commit, so the undo was not performed');
  const mismatchTr = await inTr(() => rejected(moved.resetKeep(DIR, { expect: HASH, to: HASH })));
  assert.equal(mismatchTr.message, 'HEAD beklenen commit değil, geri alma yapılmadı');
});

test('GitService: araç reposu hatası en bağlamında İngilizce ama code aracReposu; kod tabanlı akış dilden etkilenmez', async () => {
  const tool = tmpDir();
  try {
    const { runner, calls } = okRunner();
    const g = new GitService({ runner, forbiddenRoots: [tool] });
    const e = await inEn(() => rejected(g.run(path.join(tool, 'alt'), ['status'])));
    assert.equal(e.message, 'Git operations cannot be run in the tool repository');
    assert.equal(e.code, 'aracReposu');
    const eTr = await inTr(() => rejected(g.run(tool, ['status'])));
    assert.equal(eTr.message, 'Araç reposunda git işlemi yapılamaz');
    assert.equal(eTr.code, 'aracReposu');
    for (const call of [(s) => s.headCommit(tool), (s) => s.toplevelInfo(tool), (s) => s.currentBranch(tool), (s) => s.upstream(tool), (s) => s.refExists(tool, 'main')]) {
      const err = await inEn(() => rejected(call(g)));
      assert.equal(err.code, 'aracReposu', 'araç reposu hatası yutulmaz (en): ' + err.message);
    }
    const net = await inEn(() => rejected(g.fetch(tool, 'origin')));
    assert.equal(net.code, 'aracReposu');
    assert.equal(net.netCode, undefined, 'araç reposu hatası ağ hatası sayılmaz');
    assert.equal(calls.length, 0);
    const x = inEn(() => explainGitError(e, []));
    assert.deepEqual(x, { code: null, error: 'Git operations cannot be run in the tool repository', gitDetail: '' });
  } finally { rmrf(tool); }
});

test('GitService: zaman aşımı iletisi zamanlayıcı geri çağrısında da isteğin dilinde üretilir', async () => {
  const hang = () => {};
  const g = new GitService({ runner: hang });
  const keepAlive = setInterval(() => {}, 100);
  try {
    const [en, tr] = await Promise.all([
      inEn(() => rejected(g.run(DIR, ['fetch'], { timeout: 1 }))),
      inTr(() => rejected(g.run(DIR, ['fetch'], { timeout: 1 })))
    ]);
    assert.equal(en.message, 'The operation timed out');
    assert.equal(tr.message, 'İşlem zaman aşımına uğradı');
    assert.equal(en.timedOut, true);
    assert.equal(tr.timedOut, true);
    assert.equal(inEn(() => explainGitError(en, [])).error, 'The operation timed out');
  } finally { clearInterval(keepAlive); }
});

test('GitService: gerçek git hatası stderr Türkçeleşmez, özet dile göre; ALS execFile geri çağrısında korunur', { skip: !gitAvailable && 'git yok' }, async () => {
  const t = tmpDir();
  try {
    const repo = makeRepo(t);
    const g = new GitService({ env: gitEnv(t) });
    const failure = await inEn(() => rejected(g.run(repo, ['add', '--', 'yok-dosya'])));
    const en = inEn(() => explainGitError(failure, [repo]));
    const tr = inTr(() => explainGitError(failure, [repo]));
    assert.equal(en.code, 'bilinmiyor');
    assert.equal(en.error, 'The git operation failed.');
    assert.equal(tr.error, 'Git işlemi başarısız oldu.');
    assert.match(en.gitDetail, /pathspec 'yok-dosya' did not match any files/);
    assert.equal(en.gitDetail, tr.gitDetail);
    assert.equal(failure.message, failure.stderr.trim(), 'ham ileti git çıktısı, çevrilmez');

    fs.writeFileSync(path.join(repo, 'a.md'), 'A');
    fs.writeFileSync(path.join(repo, '.git', 'index.lock'), '');
    const locked = await inEn(() => rejected(g.run(repo, ['add', '--', 'a.md'])));
    const lockEn = inEn(() => explainGitError(locked, [repo]));
    assert.equal(lockEn.code, 'kilit');
    assert.match(lockEn.error, /^Git is busy with another operation/);
    assert.match(lockEn.gitDetail, /^fatal: Unable to create '<yol>\/\.git\/index\.lock': File exists\./);
    fs.rmSync(path.join(repo, '.git', 'index.lock'));

    const bad = await inEn(() => rejected(g.showFile(repo, 'zzz', 'a.md')));
    assert.equal(bad.message, 'Invalid commit');
    const after = await inEn(async () => { await g.run(repo, ['status']); return I18n.current(); });
    assert.equal(after, 'en', 'git çağrısına gidip dönen akışta dil korunur');
  } finally { rmrf(t); }
});

test('safe-path: tr ve en iletileri, durum kodları aynı; ileti yol içermez', () => {
  const t = tmpDir();
  const root = path.join(t, 'kok');
  fs.mkdirSync(path.join(root, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  try {
    const table = [
      [() => resolveSafe(root, ''), 400, 'Yol gerekli', 'Path is required'],
      [() => resolveSafe(root, undefined), 400, 'Yol gerekli', 'Path is required'],
      [() => resolveSafe(root, 'a\u0000b.md'), 400, 'Geçersiz yol', 'Invalid path'],
      [() => resolveSafe(root, '../dis.md'), 400, 'Geçersiz yol', 'Invalid path'],
      [() => resolveSafe(root, 'prompts/..'), 400, 'Geçersiz yol', 'Invalid path'],
      [() => resolveSafe(root, '.git/config'), 403, '.git klasörüne erişim yok', 'Access to the .git folder is not allowed'],
      [() => resolveSafe(root, 'prompts/.GIT/x'), 403, '.git klasörüne erişim yok', 'Access to the .git folder is not allowed']
    ];
    for (const [call, status, wantTr, wantEn] of table) {
      for (const [label, wrap, want] of [['varsayılan', (fn) => fn(), wantTr], ['tr', inTr, wantTr], ['en', inEn, wantEn]]) {
        const e = thrown(() => wrap(call));
        assert.equal(e.status, status, label + ' ' + wantEn);
        assert.equal(e.message, want, label + ' ' + wantEn);
        assert.ok(!e.message.includes(root), 'ileti yol içermez');
      }
    }
    assert.equal(inEn(() => resolveSafe(root, 'prompts/a.md')).rel, 'prompts/a.md', 'başarılı çözümleme dilden bağımsız');
    const device = thrown(() => inEn(() => checkNewPath(root, 'prompts/CON')));
    assert.equal(device.status, 400);
    assert.match(device.message, /^"CON" is a Windows device name/);
  } finally { rmrf(t); }
});

test('safe-path: bağlantı iletileri (kök dışı, kırık, .git) en bağlamında İngilizce', (tt) => {
  const t = tmpDir();
  const root = path.join(t, 'kok');
  const out = path.join(t, 'dis');
  fs.mkdirSync(path.join(root, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'gizli.md'), 'DIS');
  const outLink = path.join(root, 'prompts', 'kisayol');
  const gitLink = path.join(root, 'prompts', 'gitbag');
  const brokenLink = path.join(root, 'prompts', 'kirik');
  const gone = path.join(out, 'olmayan');
  try {
    if (!makeLink(out, outLink)) return tt.skip('bağlantı kurulamadı (EPERM)');
    let e = thrown(() => inEn(() => resolveSafe(root, 'prompts/kisayol/gizli.md')));
    assert.deepEqual([e.status, e.message], [400, 'Invalid path: link that points outside the root']);
    e = thrown(() => inTr(() => resolveSafe(root, 'prompts/kisayol/gizli.md')));
    assert.deepEqual([e.status, e.message], [400, 'Geçersiz yol: kök dışına çıkan bağlantı']);

    assert.ok(makeLink(path.join(root, '.git'), gitLink));
    e = thrown(() => inEn(() => resolveSafe(root, 'prompts/gitbag/config')));
    assert.deepEqual([e.status, e.message], [403, 'Access to the .git folder is not allowed']);

    fs.mkdirSync(gone);
    if (!makeLink(gone, brokenLink)) return tt.skip('bağlantı kurulamadı (EPERM)');
    fs.rmdirSync(gone);
    e = thrown(() => inEn(() => resolveSafe(root, 'prompts/kirik/yeni.md')));
    assert.deepEqual([e.status, e.message], [400, 'Invalid path: broken link']);
    e = thrown(() => inTr(() => resolveSafe(root, 'prompts/kirik/yeni.md')));
    assert.deepEqual([e.status, e.message], [400, 'Geçersiz yol: kırık bağlantı']);
  } finally { removeLink(outLink); removeLink(gitLink); removeLink(brokenLink); rmrf(t); }
});

test('OpLock: BusyError iletisi dile göre, status ve data aynı', async () => {
  const lock = new OpLock();
  const hold = lock.run('d', 'yaz', () => sleep(40));
  const en = await inEn(() => rejected(lock.run('d', 'yaz', async () => 1)));
  const tr = await inTr(() => rejected(lock.run('d', 'yaz', async () => 1)));
  const byDefault = await rejected(lock.run('d', 'yaz', async () => 1));
  await hold;
  for (const e of [en, tr, byDefault]) {
    assert.ok(e instanceof BusyError && e instanceof Error);
    assert.equal(e.name, 'BusyError');
    assert.equal(e.status, 409);
    assert.deepEqual(e.data, { busy: true });
  }
  assert.equal(en.message, 'Another git operation is in progress, wait for it to finish');
  assert.equal(tr.message, 'Başka bir git işlemi sürüyor, bitmesini bekle');
  assert.equal(byDefault.message, tr.message);
  assert.equal(lock.isBusy('d', 'yaz'), false);
  assert.equal(await lock.run('d', 'yaz', async () => 'tamam'), 'tamam');
});

test('UndoStack: fonksiyon olmayan adım ve rollback hatası iletileri dile göre; çoğul en one/other', async () => {
  const u = new UndoStack();
  assert.equal(thrown(() => u.push(1)).message, 'Geri alma adımı bir fonksiyon olmalı');
  assert.equal(inTr(() => thrown(() => u.push('x'))).message, 'Geri alma adımı bir fonksiyon olmalı');
  const typeErr = inEn(() => thrown(() => u.push(null)));
  assert.ok(typeErr instanceof TypeError);
  assert.equal(typeErr.message, 'The undo step must be a function');
  assert.equal(u.size, 0);

  const failing = (count) => {
    const stack = new UndoStack();
    for (let i = 0; i < count; i++) stack.push(async () => { await sleep(1); throw new Error('adım ' + i); });
    return stack.rollback();
  };
  for (const [count, wantTr, wantEn] of [
    [1, 'Geri alma sırasında 1 adım başarısız oldu', '1 step failed during rollback'],
    [2, 'Geri alma sırasında 2 adım başarısız oldu', '2 steps failed during rollback'],
    [5, 'Geri alma sırasında 5 adım başarısız oldu', '5 steps failed during rollback']
  ]) {
    const tr = await inTr(() => rejected(failing(count)));
    const en = await inEn(() => rejected(failing(count)));
    assert.ok(tr instanceof AggregateError && en instanceof AggregateError);
    assert.equal(tr.message, wantTr);
    assert.equal(en.message, wantEn);
    assert.deepEqual(en.errors.map((x) => x.message), tr.errors.map((x) => x.message), 'iç hatalar dilden bağımsız');
    assert.equal(en.errors.length, count);
  }
  const ok = new UndoStack();
  ok.push(() => {});
  await inEn(() => ok.rollback());
  assert.equal(ok.size, 0);
});

test('bayatlama yok: aynı modül örnekleri art arda en, tr, en; await sonrası ve eşzamanlı bağlamlar karışmaz', async () => {
  const g = new GitService({ runner: okRunner().runner });
  const snapshot = async () => {
    await sleep(2);
    const e = await rejected(g.showFile(DIR, 'zzz', 'a.md'));
    const lock = new OpLock();
    const hold = lock.run('d', 'ag', () => sleep(5));
    const busy = await rejected(lock.run('d', 'ag', async () => 1));
    await hold;
    return [describeGitError('kilit').slice(0, 20), describeNetError('ag'), e.message, busy.message, thrown(() => resolveSafe(DIR, '')).message];
  };
  const wantEn = ['Git is busy with ano', 'Could not reach the remote. Check your network connection and the URL.', 'Invalid commit', 'Another git operation is in progress, wait for it to finish', 'Path is required'];
  const wantTr = ['Git şu an başka bir ', "Uzak depoya ulaşılamadı. Ağ bağlantısını ve URL'yi kontrol et.", 'Geçersiz commit', 'Başka bir git işlemi sürüyor, bitmesini bekle', 'Yol gerekli'];
  assert.deepEqual(await inEn(snapshot), wantEn);
  assert.deepEqual(await inTr(snapshot), wantTr);
  assert.deepEqual(await inEn(snapshot), wantEn);
  assert.deepEqual(await snapshot(), wantTr);
  const [a, b, c, d] = await Promise.all([inEn(snapshot), inTr(snapshot), inEn(snapshot), inTr(snapshot)]);
  assert.deepEqual([a, b, c, d], [wantEn, wantTr, wantEn, wantTr]);
  assert.deepEqual(I18n.missing.filter((entry) => NAMESPACES.some((ns) => entry.includes(':' + ns))), [], 'eksik anahtar yok');
});

test('sözlük: git.*, net.*, err.path.*, err.lock.*, err.undo.* anahtar kümesi, yer tutucular ve çoğul kategorileri tr ve en için eşit', () => {
  const keys = stageKeys(TR);
  assert.deepEqual(stageKeys(EN), keys);
  assert.equal(EXPECTED_KEYS.length, 36);
  for (const key of EXPECTED_KEYS) assert.ok(keys.includes(key), 'tr ve en sözlükte var: ' + key);
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
  assert.deepEqual(placeholders(TR['net.kimlik']), ['dir']);
  assert.deepEqual(placeholders(TR['net.reddedildi']), ['dir']);
});

test('en değerlerinde Türkçe diyakritik ve en-GB yazım yok; klasör yer tutucusu her dilde kendi dilinde', () => {
  for (const key of stageKeys(EN)) {
    for (const text of Object.values(variants(EN[key]))) {
      assert.ok(!DIACRITIC_RE.test(text), key + ': ' + text);
      assert.doesNotMatch(text, /initialis|cancell|colour|behaviour|catalogue|organis/i, key);
    }
  }
  assert.equal(EN['net.dirPlaceholder'], '<folder>');
  assert.equal(TR['net.dirPlaceholder'], '<klasör>');
});

test('kaynak taraması: tx anahtarları sözlükte, her çağrı sabit anahtarlı; Türkçe diyakritikli dize değişmezi kalmadı', () => {
  const used = new Set();
  for (const file of SOURCES) {
    const src = fs.readFileSync(path.join(LIB, file), 'utf8');
    const calls = (src.match(/\btx\(/g) || []).length;
    const constant = (src.match(/\btx\('[^']+'/g) || []).length;
    assert.equal(constant, calls, file + ': her tx çağrısı sabit anahtarla');
    for (const m of src.matchAll(/\btx\('([^']+)'/g)) used.add(m[1]);
    const literals = stringLiterals(src);
    assert.ok(literals.length > 3, file + ': tarayıcı dizeleri buluyor');
    if (file === 'git-service.js') assert.ok(literals.includes('rev-parse') && literals.includes('core.quotepath=false'), 'git-service dizeleri bulundu');
    assert.deepEqual(literals.filter((text) => DIACRITIC_RE.test(text) && !ALLOWED_TURKISH_LITERALS.includes(text)), [], file + ': çevrilmemiş Türkçe dize');
    assert.ok(!src.includes('\r'), file + ': LF');
  }
  assert.ok(used.size > 0);
  for (const key of used) {
    assert.ok(Object.prototype.hasOwnProperty.call(TR, key), 'tr: ' + key);
    assert.ok(Object.prototype.hasOwnProperty.call(EN, key), 'en: ' + key);
  }
  assert.deepEqual([...used].sort(), EXPECTED_KEYS, 'kaynakta kullanılan anahtarlar = bu aşamanın anahtarları');
  assert.deepEqual(stringLiterals("a = /[\"']/; b = 'x/y'; // 'z'\nc = \"ş\"; d = x / 2; e = `t`"), ['x/y', 'ş', 't']);
});
