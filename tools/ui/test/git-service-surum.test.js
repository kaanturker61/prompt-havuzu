'use strict';
/* GitService: Aşama 2 eklemeleri (tag, geri alma, hash). Gerçek geçici repo ile. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { GitService, GitError } = require('../lib/git-service');
const Rules = require('../public/rules.js');
const { gitAvailable, tmpDir, rmrf, gitEnv } = require('./helpers');

const real = { skip: !gitAvailable && 'git yok' };

async function newRepo(d, opts) {
  const g = new GitService({ env: gitEnv(d, opts) });
  const repo = path.join(d, 'repo'); fs.mkdirSync(repo);
  await g.init(repo);
  return { g, repo };
}

test('headCommit, createTag, listTags, deleteTag', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo } = await newRepo(d);
    assert.equal(await g.headCommit(repo), null);
    fs.writeFileSync(path.join(repo, 'a.md'), 'bir\n');
    await g.commitPaths(repo, 'ilk', ['a.md']);
    const head = await g.headCommit(repo);
    assert.match(head, /^[0-9a-f]{40}$/);
    // doğrulandı: --cleanup=whitespace '#' ile başlayan satırları korur
    await g.createTag(repo, 'prompt/ornek/a/v1.0.0', '# Başlık\n\n- madde', head);
    await g.createTag(repo, 'paket/x/v1.0.0', 'p', head);
    const tags = await g.listTags(repo, 'prompt/');
    assert.equal(tags.length, 1); // "paket/" ad alanı gelmez
    assert.equal(tags[0].name, 'prompt/ornek/a/v1.0.0');
    assert.equal(tags[0].commit, head);
    assert.notEqual(tags[0].object, head); // annotated tag nesnesi
    assert.match(tags[0].date, /^\d{4}-\d\d-\d\dT/);
    const cat = await g.run(repo, ['cat-file', '-p', tags[0].name]);
    assert.match(cat, /^# Başlık$/m);
    assert.equal((await g.listTags(repo, 'prompt/ornek/')).length, 1);
    await g.deleteTag(repo, 'prompt/ornek/a/v1.0.0');
    assert.deepEqual(await g.listTags(repo, 'prompt/'), []);
    // hafif (lightweight) tag: commit = object
    await g.run(repo, ['tag', 'prompt/ornek/b/v1.0.0', head]);
    const lw = await g.listTags(repo, 'prompt/');
    assert.equal(lw[0].commit, head); assert.equal(lw[0].object, head);
  } finally { rmrf(d); }
});

test('undoCommit: sonraki commit, ilk commit, CAS', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo } = await newRepo(d);
    fs.writeFileSync(path.join(repo, 'a.md'), 'bir\n');
    await g.commitPaths(repo, 'ilk', ['a.md']);
    const c1 = await g.headCommit(repo);
    fs.writeFileSync(path.join(repo, 'a.md'), 'iki\n');
    await g.commitPaths(repo, 'ikinci', ['a.md']);
    const c2 = await g.headCommit(repo);
    // CAS: yanlış commit verilince hata, HEAD değişmez
    await assert.rejects(g.undoCommit(repo, { commit: c1, parent: c1 }), GitError);
    assert.equal(await g.headCommit(repo), c2);
    await g.undoCommit(repo, { commit: c2, parent: c1 });
    assert.equal(await g.headCommit(repo), c1);
    // ilk commit: dal yeniden doğmamış olur
    await g.undoCommit(repo, { commit: c1 });
    assert.equal(await g.hasCommits(repo), false);
    assert.equal(await g.headCommit(repo), null);
  } finally { rmrf(d); }
});

test('undoCommit: ayrık HEAD üzerinde de çalışır (doğrulandı)', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo } = await newRepo(d);
    fs.writeFileSync(path.join(repo, 'a.md'), 'bir\n');
    await g.commitPaths(repo, 'ilk', ['a.md']);
    const c1 = await g.headCommit(repo);
    await g.run(repo, ['checkout', '-q', '--detach']);
    fs.writeFileSync(path.join(repo, 'a.md'), 'iki\n');
    await g.commitPaths(repo, 'ikinci', ['a.md']);
    const c2 = await g.headCommit(repo);
    await g.undoCommit(repo, { commit: c2, parent: c1 });
    assert.equal(await g.headCommit(repo), c1);
  } finally { rmrf(d); }
});

test('unstage: doğmamış ve normal dalda; başka staged dosya korunur', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo } = await newRepo(d);
    fs.writeFileSync(path.join(repo, 'a.md'), 'a\n');
    fs.writeFileSync(path.join(repo, 'b.md'), 'b\n');
    await g.run(repo, ['add', '--', 'a.md', 'b.md']);
    await g.unstage(repo, ['a.md']); // doğmamış dalda rm --cached
    let st = await g.status(repo);
    assert.deepEqual(st.files.map((f) => [f.path, f.x]).sort(), [['a.md', '?'], ['b.md', 'A']]);
    await g.commitPaths(repo, 'ilk', ['a.md']);
    fs.writeFileSync(path.join(repo, 'a.md'), 'a2\n');
    await g.run(repo, ['add', '--', 'a.md']);
    await g.unstage(repo, ['a.md']); // normal dalda reset
    st = await g.status(repo);
    assert.deepEqual(st.files.map((f) => [f.path, f.x, f.y]).sort(), [['a.md', ' ', 'M'], ['b.md', 'A', ' ']]);
  } finally { rmrf(d); }
});

test('hashFiles ve blobAt: CRLF + .gitattributes eol=lf ile eşit', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo } = await newRepo(d);
    fs.writeFileSync(path.join(repo, '.gitattributes'), '*.md text eol=lf\n');
    fs.writeFileSync(path.join(repo, 'a.md'), 'satir1\r\nsatir2\r\n');
    await g.commitPaths(repo, 'ilk', ['.gitattributes', 'a.md']);
    const head = await g.headCommit(repo);
    const blob = await g.blobAt(repo, head, 'a.md');
    assert.match(blob, /^[0-9a-f]{40}$/);
    assert.deepEqual(await g.hashFiles(repo, ['a.md']), [blob]);
    assert.equal(await g.blobAt(repo, head, 'yok.md'), null);
    assert.deepEqual(await g.hashFiles(repo, []), []);
    fs.writeFileSync(path.join(repo, 'a.md'), 'degisti\n');
    assert.notEqual((await g.hashFiles(repo, ['a.md']))[0], blob);
  } finally { rmrf(d); }
});

test('log range: yalnızca aralıktaki commitler', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo } = await newRepo(d);
    let mid;
    for (const t of ['bir', 'iki', 'uc']) {
      fs.writeFileSync(path.join(repo, 'a.md'), t + '\n');
      await g.commitPaths(repo, t, ['a.md']);
      if (t === 'iki') mid = await g.headCommit(repo);
    }
    const l = await g.log(repo, { path: 'a.md', limit: 20, range: mid + '..HEAD' });
    assert.deepEqual(l.map((c) => c.subject), ['uc']);
    await assert.rejects(g.log(repo, { range: '-x..HEAD' }), /Geçersiz commit/);
  } finally { rmrf(d); }
});

test('_checkRef: tehlikeli adlar reddedilir, runner çağrılmaz', async () => {
  const calls = [];
  const g = new GitService({ runner: (bin, args, opts, cb) => { calls.push(args); cb(null, '', ''); } });
  const dir = path.resolve('x');
  const h = 'a'.repeat(40);
  await assert.rejects(g.deleteTag(dir, '-x'), /Geçersiz tag adı/);
  await assert.rejects(g.deleteTag(dir, 'a..b'), /Geçersiz tag adı/);
  await assert.rejects(g.createTag(dir, '-f', 'm', h), /Geçersiz tag adı/);
  await assert.rejects(g.createTag(dir, 'prompt/a/v1.0.0', 'm', '-x'), /Geçersiz commit/);
  await assert.rejects(g.listTags(dir, '--sort'), /Geçersiz tag adı/);
  await assert.rejects(g.undoCommit(dir, { commit: 'zz' }), /Geçersiz commit/);
  assert.equal(calls.length, 0);
});

test('tag adı: Rules.promptTag çıktıları check-ref-format geçer', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo } = await newRepo(d);
    for (const rel of ['prompts/Örnek Klasör/Merhaba Dünya.md', 'prompts/a.b/..x/c.lock.md', 'prompts/ğ ı/ş.md', 'prompts/v1.0.0/x.md']) {
      const ad = Rules.promptTagAd(rel, 'prompts');
      await g.run(repo, ['check-ref-format', 'refs/tags/' + Rules.promptTag(ad, '1.0.0')]);
    }
  } finally { rmrf(d); }
});
