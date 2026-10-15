'use strict';
/* lib/git-errors.js: Türkçe git hata iletileri, ayrıntı arındırma (B-16). Saf fonksiyonlar; git çalıştırılmaz. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { describeGitError, sanitizeDetail, explainGitError, isRawGitFailure, MAX_DETAIL } = require('../lib/git-errors');
const { GitError, GitNotFoundError } = require('../lib/git-service');

const WIN_ROOT = 'C:\\Users\\Demo User\\AppData\\Local\\Temp\\pp-test-1\\PromptLibrary\\mk';
const CMD = (sub) => ['-C', WIN_ROOT, '-c', 'core.quotepath=false', sub, '-m', 'mesaj'];
const raw = (stderr, sub, exitCode = 128) => new GitError(stderr, { stderr, exitCode, args: CMD(sub) });

test('describeGitError: her kod Türkçe, noktayla biter; ham git başlığı yok', () => {
  for (const code of ['kilit', 'commitReddedildi', 'eklenemedi', 'bilinmiyor']) {
    const m = describeGitError(code);
    assert.ok(m.length > 15, code);
    assert.match(m, /\.$/, code);
    assert.doesNotMatch(m, /fatal:|error:/i, code);
  }
  assert.match(describeGitError('kilit'), /index\.lock/);
  assert.match(describeGitError('kilit'), /silip tekrar dene/);
  assert.match(describeGitError('commitReddedildi'), /hook/);
  assert.match(describeGitError('eklenemedi'), /aygıt adı/);
  assert.equal(describeGitError('olmayan'), describeGitError('bilinmiyor'));
  assert.equal(describeGitError(undefined), describeGitError('bilinmiyor'));
});

test('sanitizeDetail: marketplace kökü iki ayraç ve büyük-küçük harf farkıyla <yol> olur, altındaki göreli kısım kalır', () => {
  const forward = "fatal: Unable to create 'C:/Users/Demo User/AppData/Local/Temp/pp-test-1/PromptLibrary/mk/.git/index.lock': File exists.";
  assert.equal(sanitizeDetail(forward, [WIN_ROOT]), "fatal: Unable to create '<yol>/.git/index.lock': File exists.");
  const back = 'error: C:\\Users\\Demo User\\AppData\\Local\\Temp\\pp-test-1\\PromptLibrary\\mk\\prompts\\a.md bozuk';
  assert.equal(sanitizeDetail(back, [WIN_ROOT]), 'error: <yol>\\prompts\\a.md bozuk');
  const lower = "fatal: cannot open 'c:/users/demo user/appdata/local/temp/PP-TEST-1/promptlibrary/MK/x'";
  assert.equal(sanitizeDetail(lower, [WIN_ROOT]), "fatal: cannot open '<yol>/x'");
  // POSIX kökü
  assert.equal(sanitizeDetail("fatal: Unable to create '/home/k/lib/mk/.git/index.lock': File exists.", ['/home/k/lib/mk']),
    "fatal: Unable to create '<yol>/.git/index.lock': File exists.");
  // sondaki ayraçlı kök
  assert.equal(sanitizeDetail('at C:/a/b/mk/x', ['C:\\a\\b\\mk\\']), 'at <yol>/x');
});

test('sanitizeDetail: kök adının öneki başka klasörü yarım değiştirmez; yol parçası içindeki eşleşme atlanır', () => {
  assert.equal(sanitizeDetail('see C:/a/mk2/f', ['C:\\a\\mk']), 'see <yol>', 'mk2 kök sayılmaz; genel yol kuralı tamamını arındırır');
  assert.equal(sanitizeDetail("fatal: '/var/home/k/mk/f' var", ['/home/k/mk']), "fatal: '<yol>' var", 'başka bir yolun ortasında kök eşleşmesi olmaz');
});

test('sanitizeDetail: diğer mutlak yollar <yol> olur (sürücü, UNC, POSIX, tırnaklı ve boşluklu)', () => {
  assert.equal(sanitizeDetail("fatal: cannot open 'D:/baska yer/dosya.txt': hata", []), "fatal: cannot open '<yol>': hata");
  assert.equal(sanitizeDetail('hata C:\\Windows\\System32\\x.dll bulunamadı', []), 'hata <yol> bulunamadı');
  assert.equal(sanitizeDetail('hata \\\\sunucu\\paylasim\\x.md bulunamadı', []), 'hata <yol> bulunamadı');
  assert.equal(sanitizeDetail('bin /usr/bin/git yok', []), 'bin <yol> yok');
  assert.equal(sanitizeDetail('--git-dir=/srv/x/.git hatalı', []), '--git-dir=<yol> hatalı');
  assert.equal(sanitizeDetail('"/home/biri/dosya adı.md" yok', []), '"<yol>" yok');
  assert.equal(sanitizeDetail("fatal: '\\\\sunucu\\pay lasim\\x'", []), "fatal: '<yol>'");
  assert.doesNotMatch(sanitizeDetail('C:/a/b, D:\\c\\d ve /e/f', []), /[A-Z]:|\/e\/f/);
});

test('sanitizeDetail: göreli yollar, ref adları ve URL\'ler korunur; hook çıktısına dokunulmaz', () => {
  const keep = [
    "error: open(\"plugins/norm/commands/con.md\"): No such file or directory",
    'refs/heads/main -> origin/main',
    '+refs/tags/paket/*:refs/pp/uzak/origin/paket/*',
    'https://github.com/o/r.git erişilemedi',
    'oran 1/2 ve a / b ve (ve/veya)',
    'HOOK-RED: yasak sözcük "TODO" bulundu\nikinci satır: Türkçe karakterler şğüöçı'
  ];
  for (const k of keep) assert.equal(sanitizeDetail(k, [WIN_ROOT]), k);
});

test('sanitizeDetail: 600 karakterle sınırlanır; kısa metin, tam 600 ve boş girdi bozulmaz', () => {
  assert.equal(MAX_DETAIL, 600);
  const long = sanitizeDetail('x'.repeat(2000), []);
  assert.equal(long.length, 600); assert.ok(long.endsWith('…'));
  assert.equal(sanitizeDetail('y'.repeat(600), []), 'y'.repeat(600));
  assert.equal(sanitizeDetail('kısa', []), 'kısa');
  assert.equal(sanitizeDetail('', []), ''); assert.equal(sanitizeDetail(null), ''); assert.equal(sanitizeDetail(undefined, undefined), '');
  assert.equal(sanitizeDetail(12345), '12345');
  // yol arındırıldıktan sonra sınır uygulanır (uzun yol kısalmış halde sayılır)
  assert.equal(sanitizeDetail('C:/' + 'a/'.repeat(1000) + ' son', []), '<yol> son');
  // vekil çift ikiye bölünmez
  const emoji = sanitizeDetail('😀'.repeat(400), []);
  assert.ok(emoji.length <= 600); assert.doesNotMatch(emoji, /[\uD800-\uDBFF]…$/);
});

test('sanitizeDetail: CRLF normalize edilir, baştaki/sondaki boşluk atılır; çok kısa kökler yok sayılır', () => {
  assert.equal(sanitizeDetail('  a\r\nb\r\n\r\n', []), 'a\nb');
  assert.equal(sanitizeDetail('a / b', ['/']), 'a / b');
  assert.equal(sanitizeDetail('x C: y', ['C:']), 'x C: y');
  assert.equal(sanitizeDetail('x y', ['', null, undefined]), 'x y');
});

test('sanitizeDetail: çok büyük çıktı hızlı işlenir ve 600 karaktere iner; baştaki yol yine arındırılır', () => {
  const t0 = Date.now();
  const out = sanitizeDetail("fatal: '" + WIN_ROOT + "\\.git\\index.lock': File exists\n" + 'y'.repeat(5e6), [WIN_ROOT]);
  assert.ok(Date.now() - t0 < 2000, 'dev girdi yavaş işlenmedi');
  assert.equal(out.length, 600);
  assert.ok(out.startsWith("fatal: '<yol>\\.git\\index.lock': File exists\n"), out.slice(0, 80));
  assert.ok(!out.includes('Users'));
});

test('isRawGitFailure: yalnızca git sürecinin gerçek başarısızlığı', () => {
  assert.equal(isRawGitFailure(raw('fatal: x', 'commit')), true);
  assert.equal(isRawGitFailure(new GitError('boş stderr', { exitCode: 1 })), true, 'çıkış kodu var');
  assert.equal(isRawGitFailure(new GitError('Geçersiz commit')), false, 'servisin kendi Türkçe hatası');
  assert.equal(isRawGitFailure(new GitNotFoundError([])), false);
  assert.equal(isRawGitFailure(new Error('disk dolu')), false);
  assert.equal(isRawGitFailure(null), false);
});

test('explainGitError: kilit, hook, eklenemedi; error Türkçe özet, gitDetail arındırılmış git stderr\'i', () => {
  const lock = "fatal: Unable to create 'C:/Users/Demo User/AppData/Local/Temp/pp-test-1/PromptLibrary/mk/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository.";
  let x = explainGitError(raw(lock, 'add'), [WIN_ROOT]);
  assert.equal(x.code, 'kilit');
  assert.equal(x.error, describeGitError('kilit'));
  assert.doesNotMatch(x.error, /fatal|C:|Users/);
  assert.match(x.gitDetail, /^fatal: Unable to create '<yol>\/\.git\/index\.lock': File exists\./);
  assert.doesNotMatch(x.gitDetail, /Demo|AppData|C:/);

  x = explainGitError(raw('HOOK-RED: yasak\n', 'commit', 1), [WIN_ROOT]);
  assert.equal(x.code, 'commitReddedildi'); assert.equal(x.gitDetail, 'HOOK-RED: yasak');
  assert.equal(x.error, describeGitError('commitReddedildi'));

  x = explainGitError(raw('error: open("plugins/n/commands/con.md"): No such file or directory\nfatal: adding files failed', 'add'), [WIN_ROOT]);
  assert.equal(x.code, 'eklenemedi'); assert.match(x.gitDetail, /adding files failed/);

  x = explainGitError(new GitError('', { stderr: '', exitCode: 1, args: CMD('commit') }), [WIN_ROOT]);
  assert.equal(x.code, 'commitReddedildi'); assert.equal(x.gitDetail, '', 'stderr boşsa ayrıntı yok');

  x = explainGitError(raw("fatal: pathspec 'x' did not match any files", 'add'), [WIN_ROOT]);
  assert.equal(x.code, 'bilinmiyor'); assert.equal(x.error, 'Git işlemi başarısız oldu.'); assert.match(x.gitDetail, /pathspec/);
});

test('explainGitError: git dışı ve servisin kendi hataları iletisiyle geçer (code null, gitDetail boş)', () => {
  for (const e of [new Error('disk dolu'), new GitError('Geçersiz commit'), new GitNotFoundError([]), new GitError('Araç reposunda git işlemi yapılamaz')]) {
    const x = explainGitError(e, [WIN_ROOT]);
    assert.equal(x.code, null); assert.equal(x.error, e.message); assert.equal(x.gitDetail, '');
  }
  assert.equal(explainGitError(null).error, 'Git işlemi başarısız oldu.');
  assert.equal(explainGitError(undefined, []).code, null);
});
