'use strict';
/* GitService: Aşama 3 geçmiş sekmesi okuma metotları (listTags genişlemesi, changeLog, wordDiff). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { GitService, parseTagRefs, parseChangeLog, parseWordDiff } = require('../lib/git-service');
const { gitAvailable, tmpDir, rmrf, gitEnv } = require('./helpers');

const real = { skip: !gitAvailable && 'git yok' };

async function newRepo(d) {
  const g = new GitService({ env: gitEnv(d) });
  const repo = path.join(d, 'repo'); fs.mkdirSync(repo);
  await g.init(repo);
  return { g, repo };
}

test('parseTagRefs: annotated, lightweight, çok satırlı not, boş çıktı', () => {
  const F = '\x1f'; const R = '\x1e';
  const out = 'prompt/a/v1.0.0' + F + 'o1' + F + 'c1' + F + '2026-01-01T10:00:00+03:00' + F + 'tag' + F + 'Demo' + F + 'Başlık' + F + 'satır 1\nsatır 2\n' + R + '\n' +
    'prompt/b/v1.0.0' + F + 'c2' + F + F + '2026-01-02T10:00:00+03:00' + F + 'commit' + F + F + 'commit konusu' + F + F + R + '\n';
  const t = parseTagRefs(out);
  assert.equal(t.length, 2);
  assert.deepEqual(t[0], { name: 'prompt/a/v1.0.0', object: 'o1', commit: 'c1', date: '2026-01-01T10:00:00+03:00', annotated: true, tagger: 'Demo', subject: 'Başlık', body: 'satır 1\nsatır 2' });
  assert.equal(t[1].annotated, false); assert.equal(t[1].commit, 'c2'); assert.equal(t[1].subject, ''); assert.equal(t[1].tagger, '');
  assert.deepEqual(parseTagRefs(''), []);
  assert.equal(parseTagRefs(out.replace(/\n/g, '\r\n'))[0].body, 'satır 1\nsatır 2');
});

test('parseChangeLog: A/M/D/R, çok dosya, tırnaklı yol atlanır, boş çıktı', () => {
  const F = '\x1f'; const R = '\x1e';
  const out = R + 'h1' + F + 's1' + F + 'Demo' + F + '2026-01-01T00:00:00+00:00' + F + 'konu' + '\n\nR100\tprompts/a.md\tprompts/kod/b.md\nM\tx.md\n' +
    R + 'h2' + F + 's2' + F + 'K' + F + '2026-01-02T00:00:00+00:00' + F + 'ikinci' + '\n\nA\ty.md\nD\tz.md\nM\t"t\\tab.md"\n';
  const c = parseChangeLog(out);
  assert.equal(c.length, 2);
  assert.deepEqual(c[0].files, [{ status: 'R', path: 'prompts/kod/b.md', oldPath: 'prompts/a.md' }, { status: 'M', path: 'x.md' }]);
  assert.deepEqual(c[1].files, [{ status: 'A', path: 'y.md' }, { status: 'D', path: 'z.md' }]);
  assert.equal(c[1].subject, 'ikinci');
  assert.deepEqual(parseChangeLog(''), []);
});

test('parseWordDiff: başlık atlama, iki hunk, ~, CR ve No newline', () => {
  const out = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n Kodu \n-hızlıca\n+dikkatle\n  incele.\r\n~\n \n~\n\\ No newline at end of file\n@@ -9 +9,3 @@\n+yeni\n~\n';
  const { hunks } = parseWordDiff(out);
  assert.equal(hunks.length, 2);
  assert.deepEqual([hunks[0].oldStart, hunks[0].oldLines, hunks[0].newStart, hunks[0].newLines], [1, 2, 1, 2]);
  assert.deepEqual(hunks[0].lines[0], [{ t: '=', s: 'Kodu ' }, { t: '-', s: 'hızlıca' }, { t: '+', s: 'dikkatle' }, { t: '=', s: ' incele.' }]);
  assert.deepEqual(hunks[0].lines[1], [{ t: '=', s: '' }]);
  assert.deepEqual([hunks[1].oldStart, hunks[1].oldLines, hunks[1].newLines], [9, 1, 3]);
  assert.deepEqual(hunks[1].lines, [[{ t: '+', s: 'yeni' }]]);
  assert.deepEqual(parseWordDiff('').hunks, []);
});

test('changeLog ve wordDiff: sahte runner argümanları ve reddedilen girdiler', async () => {
  const calls = [];
  const g = new GitService({ runner: (bin, args, opts, cb) => { calls.push(args); cb(null, '', ''); } });
  const dir = path.resolve('x'); const h = 'a'.repeat(40);
  await g.changeLog(dir, { path: 'p.md', follow: true, limit: 5, from: h, to: h });
  const a = calls[0];
  for (const x of ['--follow', '-M', '--name-status', h + '..' + h]) assert.ok(a.includes(x), x);
  assert.deepEqual(a.slice(-2), ['--', 'p.md']);
  await g.wordDiff(dir, { hash: h, path: 'a.md' }, { hash: h, path: 'b.md' });
  assert.ok(calls[1].includes('--word-diff=porcelain') && calls[1].includes(h + ':a.md'));
  const n = calls.length;
  await assert.rejects(g.changeLog(dir, { from: 'HEAD~1', to: h }), /Geçersiz commit/);
  await assert.rejects(g.changeLog(dir, { limit: 0 }), /Geçersiz limit/);
  await assert.rejects(g.wordDiff(dir, { hash: '-x', path: 'a' }, { hash: h, path: 'b' }), /Geçersiz commit/);
  await assert.rejects(g.wordDiff(dir, { hash: h, path: '-a' }, { hash: h, path: 'b' }), /Geçersiz yol/);
  assert.equal(calls.length, n);
});

test('listTags: yeni alanlar, %1e ayırıcı, çok satırlı not (doğrulandı)', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo } = await newRepo(d);
    fs.writeFileSync(path.join(repo, 'a.md'), 'bir\n');
    await g.commitPaths(repo, 'ilk', ['a.md']);
    const head = await g.headCommit(repo);
    await g.createTag(repo, 'prompt/a/v1.0.0', 'Konu satırı\n\nAyrıntı 1\nAyrıntı 2', head);
    await g.createTag(repo, 'prompt/b/v1.0.0', 'ikinci', head);
    await g.run(repo, ['tag', 'prompt/c/v1.0.0', head]);
    const tags = await g.listTags(repo, 'prompt/');
    assert.equal(tags.length, 3);
    const a = tags.find((t) => t.name === 'prompt/a/v1.0.0');
    assert.equal(a.annotated, true); assert.equal(a.tagger, 'Test');
    assert.equal(a.subject, 'Konu satırı'); assert.equal(a.body, 'Ayrıntı 1\nAyrıntı 2');
    assert.equal(a.commit, head);
    const c = tags.find((t) => t.name === 'prompt/c/v1.0.0');
    assert.equal(c.annotated, false); assert.equal(c.tagger, ''); assert.equal(c.body, '');
    assert.equal(tags.find((t) => t.name === 'prompt/b/v1.0.0').subject, 'ikinci');
  } finally { rmrf(d); }
});

test('changeLog rename; log --follow eski yol; follow+range; wordDiff blob-blob (doğrulandı)', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo } = await newRepo(d);
    const lines = (n) => Array.from({ length: 12 }, (_, i) => 'satir ' + i + (i === 5 ? ' ' + n : '')).join('\n') + '\n';
    fs.writeFileSync(path.join(repo, 'a.md'), lines('bir'));
    await g.commitPaths(repo, 'ilk', ['a.md']);
    const c1 = await g.headCommit(repo);
    fs.writeFileSync(path.join(repo, 'a.md'), lines('iki'));
    await g.commitPaths(repo, 'degisiklik', ['a.md']);
    const c2 = await g.headCommit(repo);
    fs.mkdirSync(path.join(repo, 'kod'));
    await g.run(repo, ['mv', 'a.md', 'kod/b.md']);
    await g.run(repo, ['commit', '-q', '-m', 'tasi']);
    fs.writeFileSync(path.join(repo, 'kod', 'b.md'), lines('uc'));
    await g.commitPaths(repo, 'son', ['kod/b.md']);
    const c4 = await g.headCommit(repo);

    const cl = await g.changeLog(repo, { limit: 10 });
    const mv = cl.find((c) => c.subject === 'tasi');
    assert.deepEqual(mv.files, [{ status: 'R', path: 'kod/b.md', oldPath: 'a.md' }]);

    const lg = await g.log(repo, { path: 'kod/b.md', follow: true, limit: 20 });
    assert.deepEqual(lg.map((c) => [c.subject, c.path]), [['son', 'kod/b.md'], ['tasi', 'kod/b.md'], ['degisiklik', 'a.md'], ['ilk', 'a.md']]);

    const rg = await g.log(repo, { path: 'kod/b.md', follow: true, limit: 20, range: c1 + '..' + c4 });
    assert.deepEqual(rg.map((c) => c.subject), ['son', 'tasi', 'degisiklik']);

    const wd = await g.wordDiff(repo, { hash: c1, path: 'a.md' }, { hash: c4, path: 'kod/b.md' });
    const { hunks } = parseWordDiff(wd);
    assert.equal(hunks.length, 1);
    const toks = hunks[0].lines.flat();
    assert.ok(toks.some((t) => t.t === '-' && t.s === 'bir'));
    assert.ok(toks.some((t) => t.t === '+' && t.s === 'uc'));
    assert.equal((await g.changeLog(repo, { from: c1, to: c2 })).length, 1);
  } finally { rmrf(d); }
});

test('changeLog: commit yokken boş dizi', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo } = await newRepo(d);
    assert.deepEqual(await g.changeLog(repo, {}), []);
  } finally { rmrf(d); }
});
