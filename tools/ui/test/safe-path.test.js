'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { resolveSafe, checkNewPath } = require('../lib/safe-path');
const { tmpDir, rmrf } = require('./helpers');
const { makeLink, removeLink } = require('./links');

const throwsWith = (fn, status, msg) => assert.throws(fn, (e) => {
  assert.equal(e.status, status, e.message);
  if (msg) assert.match(e.message, msg);
  return true;
});

function fixture() {
  const t = tmpDir();
  const root = path.join(t, 'kok'); const out = path.join(t, 'dis');
  fs.mkdirSync(path.join(root, 'prompts', 'p'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'config'), 'git');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'gizli.md'), 'DIS');
  fs.writeFileSync(path.join(root, 'prompts', 'p', 'a.md'), 'A');
  return { t, root, out };
}

test('kök dışı ve geçersiz yollar 400', () => {
  const { t, root } = fixture();
  try {
    throwsWith(() => resolveSafe(root, ''), 400, /^Yol gerekli$/);
    throwsWith(() => resolveSafe(root, undefined), 400, /^Yol gerekli$/);
    throwsWith(() => resolveSafe(root, 5), 400, /^Yol gerekli$/);
    throwsWith(() => resolveSafe(root, null), 400);
    for (const bad of ['..', '../x', 'prompts/../../x', '..\\x', 'a/../..', '/', '//', '.', 'prompts/..', 'a\u0000b.md', 'a\nb.md', 'a\u001fb']) {
      throwsWith(() => resolveSafe(root, bad), 400, /^Geçersiz yol/);
    }
    if (process.platform === 'win32') {
      for (const bad of ['C:\\Windows\\win.ini', 'C:/Windows', 'C:foo.md', 'prompts/a.md:akis', 'prompts/a:b.md']) {
        throwsWith(() => resolveSafe(root, bad), 400, /^Geçersiz yol/);
      }
    }
  } finally { rmrf(t); }
});

test('geçerli yollar: ayraç normalize, ..foo.md geçerli, var olmayan yol geçerli', () => {
  const { t, root } = fixture();
  try {
    assert.deepEqual(resolveSafe(root, 'prompts/p/a.md'), { abs: path.join(root, 'prompts', 'p', 'a.md'), rel: 'prompts/p/a.md' });
    assert.equal(resolveSafe(root, 'prompts\\p\\a.md').rel, 'prompts/p/a.md');
    assert.equal(resolveSafe(root, '/prompts//p/./a.md').rel, 'prompts/p/a.md');
    assert.equal(resolveSafe(root, 'prompts/x/../p/a.md').rel, 'prompts/p/a.md');
    assert.equal(resolveSafe(root, '..foo.md').rel, '..foo.md');
    assert.equal(resolveSafe(root, 'prompts/..a.md').rel, 'prompts/..a.md');
    assert.equal(resolveSafe(root, 'yok/yeni/dosya.md').rel, 'yok/yeni/dosya.md');
    assert.equal(resolveSafe(root, 'prompts/.gitkeep').rel, 'prompts/.gitkeep', '.gitkeep .git değildir');
    assert.equal(resolveSafe(root, '.gitignore').rel, '.gitignore');
    assert.equal(resolveSafe(root, 'a/.github/x.md').rel, 'a/.github/x.md');
    assert.equal(resolveSafe(root, 'prompts/git/x.md').rel, 'prompts/git/x.md');
  } finally { rmrf(t); }
});

test('.git varyantları 403 (büyük-küçük harf, sondaki nokta/boşluk, iç içe)', () => {
  const { t, root } = fixture();
  try {
    for (const bad of ['.git', '.git/config', '.GIT/config', '.Git/HEAD', '.gIT', '.git.', '.git /x', '.git ', 'a/.GIT/x', 'prompts/.git', 'prompts/.Git/x.md', '.git\\config', '/.GIT', '.git...']) {
      throwsWith(() => resolveSafe(root, bad), 403, /^\.git klasörüne erişim yok$/);
    }
    if (process.platform === 'win32') {
      throwsWith(() => resolveSafe(root, '.git::$INDEX_ALLOCATION'), 403);
      throwsWith(() => resolveSafe(root, '.git:x'), 403);
    }
  } finally { rmrf(t); }
});

test('8.3 kısa ad ile .git erişimi engellenir (en iyi çaba)', (tt) => {
  if (process.platform !== 'win32') return tt.skip('yalnızca Windows');
  const { t, root } = fixture();
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('cmd', ['/c', 'dir', '/x', '/a:h', root], { encoding: 'utf8' });
    const m = /(\S+~\d)\s+\.git\b/i.exec(r.stdout || '');
    if (!m) return tt.skip('8.3 kısa ad üretilmemiş (birim kapalı)');
    throwsWith(() => resolveSafe(root, m[1] + '/config'), 403);
  } finally { rmrf(t); }
});

test('kök dışı junction: mevcut dosya, yok hedef, üst bileşen 400', (tt) => {
  const { t, root, out } = fixture();
  const link = path.join(root, 'prompts', 'kisayol');
  try {
    if (!makeLink(out, link)) return tt.skip('bağlantı kurulamadı (EPERM)');
    throwsWith(() => resolveSafe(root, 'prompts/kisayol/gizli.md'), 400, /^Geçersiz yol: kök dışına çıkan bağlantı$/);
    throwsWith(() => resolveSafe(root, 'prompts/kisayol/yeni-dis.md'), 400, /kök dışına çıkan bağlantı/);
    throwsWith(() => resolveSafe(root, 'prompts/kisayol'), 400, /kök dışına çıkan bağlantı/);
    throwsWith(() => resolveSafe(root, 'prompts/kisayol/alt/derin/x.md'), 400, /kök dışına çıkan bağlantı/);
    throwsWith(() => resolveSafe(root, 'prompts\\kisayol\\gizli.md'), 400);
    assert.equal(fs.readFileSync(path.join(out, 'gizli.md'), 'utf8'), 'DIS', 'dış dosya değişmedi');
    assert.deepEqual(fs.readdirSync(out), ['gizli.md']);
  } finally { removeLink(link); rmrf(t); }
});

test('kök içine bağlantı 200; .git e giden bağlantı 403', (tt) => {
  const { t, root } = fixture();
  const link = path.join(root, 'prompts', 'kisayol'); const gl = path.join(root, 'prompts', 'gitbag');
  try {
    if (!makeLink(path.join(root, 'prompts', 'p'), link)) return tt.skip('bağlantı kurulamadı (EPERM)');
    assert.equal(resolveSafe(root, 'prompts/kisayol/a.md').rel, 'prompts/kisayol/a.md');
    assert.equal(resolveSafe(root, 'prompts/kisayol/yeni.md').rel, 'prompts/kisayol/yeni.md');
    assert.ok(makeLink(path.join(root, '.git'), gl));
    throwsWith(() => resolveSafe(root, 'prompts/gitbag/config'), 403, /^\.git klasörüne erişim yok$/);
    throwsWith(() => resolveSafe(root, 'prompts/gitbag'), 403);
  } finally { removeLink(link); removeLink(gl); rmrf(t); }
});

test('dosya bağlantısı: kök dışına işaret edeni 400, içine edeni 200', (tt) => {
  const { t, root, out } = fixture();
  const fl = path.join(root, 'prompts', 'dis.md'); const fi = path.join(root, 'prompts', 'ic.md');
  try {
    if (!makeLink(path.join(out, 'gizli.md'), fl, 'file')) return tt.skip('dosya bağlantısı kurulamadı (EPERM)');
    throwsWith(() => resolveSafe(root, 'prompts/dis.md'), 400, /kök dışına çıkan bağlantı/);
    assert.ok(makeLink(path.join(root, 'prompts', 'p', 'a.md'), fi, 'file'));
    assert.equal(resolveSafe(root, 'prompts/ic.md').rel, 'prompts/ic.md');
  } finally { removeLink(fl); removeLink(fi); rmrf(t); }
});

test('kırık bağlantı 400 (hedef kök dışında olabilir)', (tt) => {
  const { t, root, out } = fixture();
  const link = path.join(root, 'prompts', 'kirik'); const gone = path.join(out, 'olmayan-klasor');
  try {
    // hedef önce var, bağlantı kurulur, sonra hedef silinir -> kırık bağlantı
    fs.mkdirSync(gone);
    if (!makeLink(gone, link)) return tt.skip('bağlantı kurulamadı (EPERM)');
    fs.rmdirSync(gone);
    throwsWith(() => resolveSafe(root, 'prompts/kirik/yeni.md'), 400);
    throwsWith(() => resolveSafe(root, 'prompts/kirik'), 400);
    assert.equal(fs.existsSync(gone), false, 'hedef oluşturulmadı');
  } finally { removeLink(link); rmrf(t); }
});

test('hata iletisinde mutlak yol yok', (tt) => {
  const { t, root, out } = fixture();
  const link = path.join(root, 'prompts', 'kisayol');
  try {
    const cases = [() => resolveSafe(root, '../x'), () => resolveSafe(root, '.GIT/config'), () => resolveSafe(root, '')];
    if (makeLink(out, link)) cases.push(() => resolveSafe(root, 'prompts/kisayol/gizli.md'));
    for (const fn of cases) {
      try { fn(); assert.fail('hata bekleniyordu'); } catch (e) {
        assert.ok(e.status);
        assert.ok(!e.message.includes(root) && !e.message.includes(t) && !e.message.includes(out), e.message);
      }
    }
  } finally { removeLink(link); rmrf(t); }
});

test('checkNewPath: yalnızca var olmayan bileşenlere yasak ad kuralı uygulanır', () => {
  const { t, root } = fixture();
  try {
    checkNewPath(root, 'prompts/p/a.md'); // var olan
    checkNewPath(root, 'prompts/p/yeni.md');
    checkNewPath(root, 'prompts/yeni-klasor/yeni.md');
    for (const bad of ['prompts/p/CON.md', 'prompts/p/nul', 'prompts/Com1.txt', 'prompts/lpt9.md', 'prompts/AUX/x.md', 'prompts/p/x.', 'prompts/p/x ', 'prompts/p/a?b.md', 'prompts/p/a<b.md', 'prompts/p/a|b.md']) {
      throwsWith(() => checkNewPath(root, bad), 400);
    }
    throwsWith(() => checkNewPath(root, 'prompts/p/CON.md'), 400, /Windows aygıt adı/);
    checkNewPath(root, 'prompts/p/' + 'a'.repeat(197) + '.md'); // 200 bayt
    throwsWith(() => checkNewPath(root, 'prompts/p/' + 'a'.repeat(198) + '.md'), 400, /^Ad en çok 200 bayt olabilir$/);
    throwsWith(() => checkNewPath(root, 'prompts/p/' + 'ş'.repeat(101)), 400, /^Ad en çok 200 bayt olabilir$/); // 202 bayt
    checkNewPath(root, 'prompts/p/' + 'ş'.repeat(100)); // 200 bayt
    // var olan uzun ad kontrol edilmez (PUT için); yeni uzun ad edilir
    const long = 'u'.repeat(230) + '.md';
    fs.writeFileSync(path.join(root, 'prompts', 'p', long), 'x');
    checkNewPath(root, 'prompts/p/' + long);
  } finally { rmrf(t); }
});
