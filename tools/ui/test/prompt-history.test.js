'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const FM = require('../public/fm.js');
const Rules = require('../public/rules.js');
const { GitService } = require('../lib/git-service');
const { PromptHistory, HistoryError, diffMeta, groupChangesByFile, mapTagsToFile, filterBodyHunks, fmEndLine } = require('../lib/prompt-history');
const { gitAvailable, tmpDir, rmrf, gitEnv } = require('./helpers');

const real = { skip: !gitAvailable && 'git yok' };

/* ---- saf fonksiyonlar ---- */

test('diffMeta: skaler, liste, sıra, eklendi/kaldirildi, CANON sırası, "a, b" eşdeğerliği', () => {
  const a = { durum: 'taslak', etiketler: ['kod', 'git'], projeler: ['a', 'b'], zeta: 'z', eski: 'x', ayni: '1', bos: '' };
  const b = { durum: 'kararlı', etiketler: ['kod', 'inceleme'], projeler: ['b', 'a'], model: 'sonnet', ayni: '1', alfa: 'q', bos: [] };
  const f = diffMeta(a, b, FM.CANON);
  assert.deepEqual(f.map((x) => x.key), ['etiketler', 'projeler', 'durum', 'model', 'alfa', 'eski', 'zeta'].sort((x, y) => {
    const ix = FM.CANON.indexOf(x); const iy = FM.CANON.indexOf(y);
    if (ix >= 0 && iy >= 0) return ix - iy; if (ix >= 0) return -1; if (iy >= 0) return 1; return x.localeCompare(y, 'tr');
  }));
  const by = Object.fromEntries(f.map((x) => [x.key, x]));
  assert.deepEqual([by.durum.kind, by.durum.from, by.durum.to, by.durum.list], ['degisti', 'taslak', 'kararlı', false]);
  assert.deepEqual([by.etiketler.kind, by.etiketler.added, by.etiketler.removed], ['degisti', ['inceleme'], ['git']]);
  assert.equal(by.projeler.kind, 'sira'); assert.deepEqual(by.projeler.added, []);
  assert.deepEqual([by.model.kind, by.model.from, by.model.to], ['eklendi', null, 'sonnet']);
  assert.deepEqual([by.eski.kind, by.eski.to], ['kaldirildi', null]);
  assert.equal(by.ayni, undefined); assert.equal(by.bos, undefined);
  // "a, b" ile [a, b] eşdeğer; büyük/küçük ve Türkçe harf yok sayılır
  assert.deepEqual(diffMeta({ etiketler: 'a, b' }, { etiketler: ['a', 'b'] }, FM.CANON), []);
  assert.deepEqual(diffMeta({ etiketler: ['Işık'] }, { etiketler: ['ışık'] }, FM.CANON), []);
  assert.equal(diffMeta({ etiketler: 'a' }, { etiketler: ['a', 'b'] }, FM.CANON)[0].added[0], 'b');
});

test('groupChangesByFile: a->b->c zinciri tek grupta toplanır', () => {
  const c = (hash, date, files) => ({ hash, short: hash, author: 'K', date, subject: hash, files });
  const commits = [
    c('h4', '2026-04', [{ status: 'M', path: 'c.md' }]),
    c('h3', '2026-03', [{ status: 'R', path: 'c.md', oldPath: 'b.md' }]),
    c('h2', '2026-02', [{ status: 'R', path: 'b.md', oldPath: 'a.md' }, { status: 'A', path: 'x.md' }]),
    c('h1', '2026-01', [{ status: 'M', path: 'a.md' }])
  ];
  const g = groupChangesByFile(commits);
  assert.deepEqual(g.map((x) => x.path), ['c.md', 'x.md']);
  assert.deepEqual(g[0].oldPaths, ['b.md', 'a.md']);
  assert.equal(g[0].count, 4); assert.equal(g[0].status, 'M'); assert.equal(g[0].last.hash, 'h4');
  assert.deepEqual(g[0].commits.map((x) => x.path), ['c.md', 'c.md', 'b.md', 'a.md']);
});

test('filterBodyHunks: yalnızca frontmatter hunk çıkar, gövdeye değen kalır', () => {
  const t = (x, s) => ({ t: x, s });
  const fmHunk = { oldStart: 2, oldLines: 3, newStart: 2, newLines: 3, lines: [[t('=', 'a: 1')], [t('-', 'durum: taslak'), t('+', 'durum: x')], [t('=', 'b: 2')]] };
  const fmWithBodyCtx = { oldStart: 3, oldLines: 4, newStart: 3, newLines: 4, lines: [[t('-', 'durum: taslak')], [t('=', '---')], [t('=', '')], [t('=', 'Gövde')]] };
  const bodyHunk = { oldStart: 6, oldLines: 2, newStart: 6, newLines: 2, lines: [[t('=', 'x ')], [t('-', 'a'), t('+', 'b')]] };
  const mixed = { oldStart: 3, oldLines: 3, newStart: 3, newLines: 3, lines: [[t('=', 'z: 1')], [t('=', '---')], [t('-', 'eski'), t('+', 'yeni')]] };
  const r = filterBodyHunks([fmHunk, fmWithBodyCtx, bodyHunk, mixed], 4, 4);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], bodyHunk);
  // karışık hunk frontmatter satırlarından arındırılır; başlangıç ve uzunluk yeniden hesaplanır
  assert.deepEqual(r[1], { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, lines: [[t('-', 'eski'), t('+', 'yeni')]] });
  assert.deepEqual(filterBodyHunks([], 0, 0), []);
  // frontmatter yoksa (fmEnd=0) hiçbir hunk atılmaz
  assert.equal(filterBodyHunks([fmHunk], 0, 0).length, 1);
});

test('fmEndLine: kapanış satırı, BOM, CRLF, frontmatter yok', () => {
  const raw = '---\nbaslik: x\n---\ngövde\n';
  assert.equal(fmEndLine(FM.parse(raw), raw), 3);
  const crlf = '﻿---\r\na: 1\r\n---\r\nx';
  assert.equal(fmEndLine(FM.parse(crlf), crlf), 3);
  assert.equal(fmEndLine(FM.parse('düz'), 'düz'), 0);
});

test('mapTagsToFile: commit üyeliği öncelikli, yoksa ad eşleşmesi', () => {
  const tags = [{ name: 't1', ad: 'a', commit: 'c1' }, { name: 't2', ad: 'kod/b', commit: 'c9' }, { name: 't3', ad: 'x', commit: 'c1' }];
  const r = mapTagsToFile(tags, new Map([['c1', 'prompts/a.md']]), new Map([['a', 'prompts/a.md'], ['kod/b', 'prompts/kod/b.md']]));
  assert.deepEqual(r.map((x) => [x.name, x.pathAtTag, x.inHistory]), [['t1', 'prompts/a.md', true], ['t2', 'prompts/kod/b.md', false]]);
});

/* ---- gerçek repo ---- */

const mdOf = (durum, etiketler, govde) => '---\nbaslik: Örnek\nversiyon: 1.0.0\ndurum: ' + durum + '\netiketler: [' + etiketler + ']\n---\n' + govde;
const LINES = (w) => 'Birinci satır\nİkinci satır\nKodu ' + w + ' incele.\nSon satır\n';

async function setup(d, name = 'repo') {
  const g = new GitService({ env: gitEnv(d) });
  const repo = path.join(d, name); fs.mkdirSync(repo);
  await g.init(repo);
  return { g, repo };
}
const put = (repo, rel, txt) => { const f = path.join(repo, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); };

async function scenario(d) {
  const { g, repo } = await setup(d);
  const tag = async (name, msg) => g.createTag(repo, name, msg, await g.headCommit(repo));
  put(repo, 'prompts/a.md', mdOf('taslak', 'x', LINES('hızlıca')));
  await g.commitPaths(repo, 'ilk', ['prompts/a.md']);
  await tag('prompt/a/v1.0.0', 'ilk sürüm');
  put(repo, 'prompts/a.md', mdOf('kararlı', 'x, y', LINES('hızlıca').replace('Son satır', 'Son satır!')));
  await g.commitPaths(repo, 'güncelle', ['prompts/a.md']);
  await tag('prompt/a/v1.1.0', 'ikinci\n\nayrıntı');
  fs.mkdirSync(path.join(repo, 'prompts/kod'));
  await g.run(repo, ['mv', 'prompts/a.md', 'prompts/kod/b.md']);
  await g.run(repo, ['commit', '-q', '-m', 'taşı']);
  put(repo, 'prompts/kod/b.md', mdOf('kararlı', 'x, y', LINES('dikkatle').replace('Son satır', 'Son satır!')));
  await g.commitPaths(repo, 'değiştir', ['prompts/kod/b.md']);
  await tag('prompt/kod/b/v1.2.0', 'üçüncü');
  put(repo, 'prompts/c.md', mdOf('taslak', 'z', 'c\n'));
  await g.commitPaths(repo, 'c', ['prompts/c.md']);
  await tag('prompt/c/v1.0.0', 'c sürümü');
  await g.run(repo, ['tag', 'prompt/a/v2.0', await g.headCommit(repo)]); // geçersiz biçim
  return { g, repo };
}

const LIB = { libraryDir: 'prompts' };

test('timeline: yeniden adlandırma sonrası eski sürümler bağlanır, notlar, ignoredTags', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo } = await scenario(d);
    const h = new PromptHistory({ git: g, FM, Rules });
    const t = await h.timeline(repo, 'prompts/kod/b.md', LIB);
    assert.equal(t.tracked, true); assert.equal(t.ad, 'kod/b');
    assert.deepEqual(t.versions.map((v) => v.version), ['1.2.0', '1.1.0', '1.0.0']);
    assert.deepEqual(t.versions.map((v) => v.pathAtTag), ['prompts/kod/b.md', 'prompts/a.md', 'prompts/a.md']);
    assert.deepEqual(t.versions.map((v) => v.renamed), [false, true, true]);
    assert.ok(t.versions.every((v) => v.inHistory && v.annotated));
    assert.equal(t.versions[1].subject, 'ikinci'); assert.equal(t.versions[1].note, 'ikinci\n\nayrıntı');
    assert.equal(t.versions[1].tagger, 'Test');
    assert.equal(t.ignoredTags, 1); // prompt/a/v2.0: ad kümesindeki "a" adına uyar
    assert.deepEqual(t.paths.map((p) => [p.path, p.until === null]), [['prompts/a.md', false], ['prompts/kod/b.md', true]]);
    assert.equal(t.head.hash, await g.headCommit(repo));
    // ad kümesine uyan geçersiz biçimli tag sayılır
    assert.equal((await h.timeline(repo, 'prompts/a.md', LIB)).ignoredTags, 1);
    // başka dosya ve kitaplık dışı
    assert.deepEqual((await h.timeline(repo, 'prompts/c.md', LIB)).versions.map((v) => v.tag), ['prompt/c/v1.0.0']);
    const out = await h.timeline(repo, 'README.md', LIB);
    assert.equal(out.ad, null); assert.deepEqual(out.versions, []);
    const nope = await h.timeline(repo, 'prompts/yok.md', LIB);
    assert.equal(nope.tracked, false);
  } finally { rmrf(d); }
});

test('compare / show / resolveRef hataları', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo } = await scenario(d);
    const h = new PromptHistory({ git: g, FM, Rules });
    const rel = 'prompts/kod/b.md';
    const c = await h.compare(repo, rel, 'prompt/a/v1.0.0', 'prompt/kod/b/v1.2.0', LIB);
    const by = Object.fromEntries(c.fields.map((f) => [f.key, f]));
    assert.deepEqual([by.durum.from, by.durum.to], ['taslak', 'kararlı']);
    assert.deepEqual(by.etiketler.added, ['y']);
    assert.equal(c.renamed, true);
    assert.deepEqual([c.a.pathAtRef, c.b.pathAtRef], ['prompts/a.md', rel]);
    assert.equal(c.body.same, false);
    const toks = c.body.hunks.flatMap((x) => x.lines.flat());
    assert.ok(toks.some((x) => x.t === '-' && x.s === 'hızlıca') && toks.some((x) => x.t === '+' && x.s === 'dikkatle'));
    assert.ok(!toks.some((x) => /durum:|etiketler:/.test(x.s)), 'frontmatter gövde farkında görünmez');
    assert.deepEqual(c.commits.map((x) => x.subject), ['değiştir', 'taşı', 'güncelle']);
    assert.equal(c.commitsTruncated, false);
    assert.deepEqual(c.fmBroken, { a: false, b: false });

    // yalnızca frontmatter değişti: gövde farkı boş
    const only = await h.compare(repo, rel, 'prompt/a/v1.0.0', 'prompt/a/v1.1.0', LIB);
    assert.ok(only.fields.some((f) => f.key === 'durum'));
    assert.equal(only.body.same, false); // v1.1.0'da gövdeye "!" eklendi

    const head = await h.compare(repo, rel, 'prompt/kod/b/v1.2.0', 'HEAD', LIB);
    assert.equal(head.body.same, true); assert.deepEqual(head.fields, []);
    assert.equal(head.b.ref, 'HEAD'); assert.equal(head.b.version, null);

    const sh = await h.show(repo, rel, 'prompt/a/v1.0.0', LIB);
    assert.equal(sh.pathAtTag, 'prompts/a.md');
    assert.match(sh.raw, /durum: taslak/); assert.match(sh.raw, /hızlıca/);

    const code = async (p) => p.then(() => null, (e) => (e instanceof HistoryError ? [e.status, e.code] : e));
    assert.deepEqual(await code(h.show(repo, rel, 'prompt/c/v1.0.0', LIB)), [400, 'surumBaskaDosyanin']);
    assert.deepEqual(await code(h.show(repo, rel, 'prompt/a/v9.9.9', LIB)), [404, 'surumYok']);
    assert.deepEqual(await code(h.show(repo, rel, 'prompt/a/v1.0', LIB)), [400, 'surumAdiGecersiz']);
    assert.deepEqual(await code(h.show(repo, rel, 'HEAD~1', LIB)), [400, 'surumAdiGecersiz']);
    assert.deepEqual(await code(h.show(repo, rel, 'prompt/a/v1.0.0;rm', LIB)), [400, 'surumAdiGecersiz']);
    assert.deepEqual(await code(h.show(repo, rel, 'prompt/' + 'a'.repeat(300) + '/v1.0.0', LIB)), [400, 'surumAdiGecersiz']);
    assert.deepEqual(await code(h.compare(repo, rel, 'prompt/a/v1.0.0', 'prompt/a/v1.0.0', LIB)), [400, 'ayniSurum']);
    assert.deepEqual(await code(h.compare(repo, rel, '', 'HEAD', LIB)), [400, 'surumAdiGecersiz']);
    // HEAD'de dosya yok
    assert.deepEqual(await code(h.show(repo, 'prompts/silinmis.md', 'HEAD', LIB)), [404, 'dosyaYok']);
  } finally { rmrf(d); }
});

test('commit yokken HEAD: commitYok', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo } = await setup(d);
    const h = new PromptHistory({ git: g, FM, Rules });
    await assert.rejects(h.resolveRef(repo, 'prompts/a.md', 'HEAD', LIB), (e) => e.code === 'commitYok' && e.status === 404);
    assert.equal((await h.timeline(repo, 'prompts/a.md', LIB)).tracked, false);
  } finally { rmrf(d); }
});

test('önbellek: ikinci timeline log çalıştırmaz, yeni tag/commit sonrası çalıştırır', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo } = await scenario(d);
    let logs = 0;
    const orig = g.log.bind(g);
    g.log = (...a) => { logs++; return orig(...a); };
    const h = new PromptHistory({ git: g, FM, Rules });
    await h.timeline(repo, 'prompts/kod/b.md', LIB);
    assert.equal(logs, 1);
    await h.timeline(repo, 'prompts/kod/b.md', LIB);
    assert.equal(logs, 1);
    await g.createTag(repo, 'prompt/kod/b/v1.3.0', 'yeni', await g.headCommit(repo));
    const t = await h.timeline(repo, 'prompts/kod/b.md', LIB);
    assert.equal(logs, 2); assert.equal(t.versions[0].version, '1.3.0');
    h.clear();
    await h.timeline(repo, 'prompts/kod/b.md', LIB);
    assert.equal(logs, 3);
  } finally { rmrf(d); }
});

test('marketplace ayrımı: aynı rel ve ad, farklı depolar karışmaz', real, async () => {
  const d = tmpDir();
  try {
    const A = await setup(d, 'mpA'); const B = await setup(d, 'mpB');
    for (const [x, ver] of [[A, '1.0.0'], [B, '2.0.0']]) {
      put(x.repo, 'prompts/p.md', mdOf('taslak', 'x', 'g\n'));
      await x.g.commitPaths(x.repo, 'ilk', ['prompts/p.md']);
      await x.g.createTag(x.repo, 'prompt/p/v' + ver, 'n', await x.g.headCommit(x.repo));
    }
    const h = new PromptHistory({ git: A.g, FM, Rules });
    const ta = await h.timeline(A.repo, 'prompts/p.md', LIB);
    const tb = await h.timeline(B.repo, 'prompts/p.md', LIB);
    assert.deepEqual(ta.versions.map((v) => v.version), ['1.0.0']);
    assert.deepEqual(tb.versions.map((v) => v.version), ['2.0.0']);
    assert.deepEqual((await h.timeline(A.repo, 'prompts/p.md', LIB)).versions.map((v) => v.version), ['1.0.0']);
  } finally { rmrf(d); }
});

test('changesByFile ve versionsByPrompt', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo } = await scenario(d);
    const h = new PromptHistory({ git: g, FM, Rules });
    const r = await h.changesByFile(repo, { limit: 300, exists: (p) => fs.existsSync(path.join(repo, p)) });
    assert.equal(r.hasMore, false);
    const b = r.files.find((f) => f.path === 'prompts/kod/b.md');
    assert.deepEqual(b.oldPaths, ['prompts/a.md']);
    assert.equal(b.exists, true); assert.equal(b.last.subject, 'değiştir');
    assert.equal(r.files[0].path, 'prompts/c.md'); // en son değişen önce
    const small = await h.changesByFile(repo, { limit: 2 });
    assert.equal(small.hasMore, true); assert.equal(small.commitCount, 2);

    const v = await h.versionsByPrompt(repo, { libraryDir: 'prompts', currentPaths: ['prompts/kod/b.md', 'prompts/c.md'] });
    const pb = v.prompts.find((p) => p.path === 'prompts/kod/b.md');
    assert.deepEqual(pb.versions.map((x) => x.version), ['1.2.0', '1.1.0', '1.0.0']);
    assert.deepEqual(v.prompts.map((p) => p.path).sort(), ['prompts/c.md', 'prompts/kod/b.md']);
    assert.equal(v.ignoredTags, 1);
    assert.deepEqual(v.unmatched, []);
    const only = await h.versionsByPrompt(repo, { libraryDir: 'prompts', currentPaths: ['prompts/c.md'] });
    assert.deepEqual(only.unmatched.map((x) => x.ad), ['a', 'kod/b']);
  } finally { rmrf(d); }
});
