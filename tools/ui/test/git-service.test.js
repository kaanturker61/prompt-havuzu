'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { GitService, GitError, GitNotFoundError, parseStatus } = require('../lib/git-service');
const { gitAvailable, tmpDir, rmrf, gitEnv } = require('./helpers');

/* ---------- sahte runner ---------- */

function fakeRunner(result) {
  const calls = [];
  const runner = (bin, args, opts, cb) => { calls.push({ bin, args, opts }); result(cb, args); };
  return { runner, calls };
}

test('argümanlar -C <dir> -c core.quotepath=false ile başlar, cwd verilmez', async () => {
  const { runner, calls } = fakeRunner((cb) => cb(null, 'ok', ''));
  const g = new GitService({ runner });
  const dir = path.resolve('x', 'repo');
  await g.run(dir, ['status']);
  assert.deepEqual(calls[0].args, ['-C', dir, '-c', 'core.quotepath=false', 'status']);
  assert.equal('cwd' in calls[0].opts, false);
  assert.equal(calls[0].opts.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(calls[0].opts.env.LC_ALL, 'C');
  assert.equal(calls[0].opts.windowsHide, true);
});

test('version -C kullanmaz', async () => {
  const { runner, calls } = fakeRunner((cb) => cb(null, 'git version 2', ''));
  await new GitService({ runner }).version();
  assert.deepEqual(calls[0].args, ['--version']);
});

test('ENOENT GitNotFoundError olur', async () => {
  const { runner } = fakeRunner((cb) => cb(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }), '', ''));
  await assert.rejects(new GitService({ runner }).run(path.resolve('x'), ['status']), (e) => {
    assert.ok(e instanceof GitNotFoundError && e instanceof GitError);
    assert.match(e.message, /git bulunamadı/);
    return true;
  });
});

test('hata: stderr mesaj olur, exitCode ve args saklanır, kimlik hatası tanınır', async () => {
  const { runner } = fakeRunner((cb) => cb(Object.assign(new Error('Command failed'), { code: 128 }), '', 'fatal: Author identity unknown\n'));
  await assert.rejects(new GitService({ runner }).run(path.resolve('x'), ['commit']), (e) => {
    assert.equal(e.message, 'fatal: Author identity unknown');
    assert.equal(e.exitCode, 128);
    assert.equal(e.isIdentityError, true);
    assert.equal(e.args.at(-1), 'commit');
    return true;
  });
});

test('forbiddenRoots: kendisi ve altındaki dizinler reddedilir, runner çağrılmaz', async () => {
  const { runner, calls } = fakeRunner((cb) => cb(null, '', ''));
  const tool = tmpDir();
  try {
    const g = new GitService({ runner, forbiddenRoots: [tool] });
    await assert.rejects(g.run(tool, ['status']), /Araç reposunda git işlemi yapılamaz/);
    await assert.rejects(g.run(path.join(tool, 'alt', 'klasor'), ['status']), /Araç reposunda git işlemi yapılamaz/);
    assert.equal(calls.length, 0);
    await g.run(tool + '-baska', ['status']);
    assert.equal(calls.length, 1);
  } finally { rmrf(tool); }
});

test('parseStatus: rename içeren -z fixture', () => {
  const out = 'R  yeni.md\0eski.md\0 M degisen.md\0?? yeni dosya.md\0D  silinen.md\0A  eklenen.md\0';
  const f = parseStatus(out);
  assert.deepEqual(f.map((x) => [x.path, x.code]), [
    ['yeni.md', 'R'], ['degisen.md', 'M'], ['yeni dosya.md', '?'], ['silinen.md', 'D'], ['eklenen.md', 'A']
  ]);
});

/* ---------- gerçek geçici repo ---------- */

const real = { skip: !gitAvailable && 'git yok' };

test('init: HEAD refs/heads/main; toplevel; isRepoRoot', real, async () => {
  const d = tmpDir();
  try {
    const g = new GitService({ env: gitEnv(d) });
    const repo = path.join(d, 'repo'); fs.mkdirSync(path.join(repo, 'alt'), { recursive: true });
    const plain = path.join(d, 'duz'); fs.mkdirSync(plain);
    await g.init(repo);
    assert.equal(fs.readFileSync(path.join(repo, '.git', 'HEAD'), 'utf8').trim(), 'ref: refs/heads/main');
    assert.equal(path.normalize(await g.toplevel(repo)).toLowerCase(), repo.toLowerCase());
    assert.equal(path.normalize(await g.toplevel(path.join(repo, 'alt'))).toLowerCase(), repo.toLowerCase());
    assert.equal(await g.toplevel(plain), null);
    assert.equal(await g.isRepoRoot(repo), true);
    assert.equal(await g.isRepoRoot(path.join(repo, 'alt')), false);
    assert.equal(await g.isRepoRoot(plain), false);
  } finally { rmrf(d); }
});

test('status, commitPaths, log, showFile, showCommit, diffWorking', real, async () => {
  const d = tmpDir();
  try {
    const g = new GitService({ env: gitEnv(d) });
    const repo = path.join(d, 'repo'); fs.mkdirSync(repo);
    await g.init(repo);
    fs.writeFileSync(path.join(repo, 'a.md'), 'bir\n');
    let st = await g.status(repo);
    assert.equal(st.isRepo, true); assert.equal(st.branch, 'main'); assert.equal(st.hasCommits, false);
    assert.deepEqual(st.files.map((f) => [f.path, f.code]), [['a.md', '?']]);
    assert.deepEqual(await g.log(repo, { limit: 60 }), []);
    assert.deepEqual(await g.diffWorking(repo, 'a.md'), { diff: '', untracked: true });

    const short = await g.commitPaths(repo, 'ilk', ['a.md']);
    assert.match(short, /^[0-9a-f]{7,}$/);
    assert.equal(await g.hasCommits(repo), true);
    st = await g.status(repo);
    assert.deepEqual(st.files, []);
    assert.equal(st.identity.name, ''); // kimlik yalnızca ortam değişkenlerinde

    fs.writeFileSync(path.join(repo, 'a.md'), 'iki\n');
    await g.commitPaths(repo, 'ikinci', ['a.md']);
    const log = await g.log(repo, { path: 'a.md', limit: 100, follow: true });
    assert.deepEqual(log.map((c) => c.subject), ['ikinci', 'ilk']);
    assert.equal(log[0].path, 'a.md');
    assert.equal((await g.log(repo, { limit: 60 })).length, 2);

    assert.equal(await g.showFile(repo, log[1].hash, 'a.md'), 'bir\n');
    await assert.rejects(g.showFile(repo, log[1].hash, 'yok.md'), GitError);
    await assert.rejects(g.showFile(repo, 'zzz', 'a.md'), /Geçersiz commit/);
    assert.match(await g.showCommit(repo, log[0].hash, { path: 'a.md' }), /\+iki/);
    assert.match(await g.showCommit(repo, log[0].hash, { stat: true }), /a\.md/);

    fs.writeFileSync(path.join(repo, 'a.md'), 'uc\n');
    const w = await g.diffWorking(repo, 'a.md');
    assert.match(w.diff, /\+uc/); assert.equal(w.untracked, undefined);
  } finally { rmrf(d); }
});

test('setConfig/getConfig; kimlik eksikken isIdentityError', real, async () => {
  const d = tmpDir();
  try {
    const g = new GitService({ env: gitEnv(d, { identity: false }) });
    const repo = path.join(d, 'repo'); fs.mkdirSync(repo);
    await g.init(repo);
    fs.writeFileSync(path.join(repo, 'a.md'), 'x\n');
    await assert.rejects(g.commitPaths(repo, 'm', ['a.md']), (e) => {
      assert.ok(e instanceof GitError); assert.equal(e.isIdentityError, true); return true;
    });
    await g.setConfig(repo, 'user.name', 'Ben');
    await g.setConfig(repo, 'user.email', 'ben@example.com');
    assert.equal(await g.getConfig(repo, 'user.name'), 'Ben');
    assert.equal(await g.getConfig(repo, 'user.yok'), '');
    // ortam değişkenleri boş olduğundan yapılandırmadan okunur
    const g2 = new GitService({ env: { ...gitEnv(d, { identity: false }), GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined } });
    await g2.commitPaths(repo, 'm', ['a.md']);
    assert.equal(await g2.hasCommits(repo), true);
  } finally { rmrf(d); }
});
