'use strict';
/* GitService: Aşama 4 eklemeleri (uzak depo, ağ sınıflandırma, dışa aktarma yardımcıları).
 * Uzak depo = yerel bare repo; ağ erişimi yoktur. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { GitService, GitError, classifyGitNetError } = require('../lib/git-service');
const { gitAvailable, tmpDir, rmrf, gitEnv, sh, makeRepo, makeBare } = require('./helpers');

const real = { skip: !gitAvailable && 'git yok' };

function fakeRunner(result) {
  const calls = [];
  const runner = (bin, args, opts, cb) => { calls.push({ bin, args, opts }); result(cb, args, opts); };
  return { runner, calls };
}
const okRunner = () => fakeRunner((cb, args) => cb(null, args.includes('config') ? '' : 'ok', ''));

/* ---------- sınıflandırma ---------- */

test('classifyGitNetError: fixture tablosu (GitHub, GitLab, SSH)', () => {
  const c = (s, e) => classifyGitNetError(s, e);
  assert.equal(c("fatal: Authentication failed for 'https://github.com/o/r.git/'"), 'kimlik');
  assert.equal(c('fatal: could not read Username for \'https://github.com\': terminal prompts disabled'), 'kimlik');
  assert.equal(c('remote: HTTP Basic: Access denied. The provided password or token is incorrect'), 'kimlik');
  assert.equal(c('git@github.com: Permission denied (publickey).'), 'kimlik');
  assert.equal(c('Host key verification failed.'), 'kimlik');
  assert.equal(c("fatal: unable to access 'https://x/': The requested URL returned error: 403"), 'kimlik');
  assert.equal(c("fatal: unable to access 'https://x/': Could not resolve host: x"), 'ag');
  assert.equal(c('ssh: connect to host h port 22: Connection timed out'), 'ag');
  assert.equal(c('remote: Repository not found.\nfatal: repository \'https://x/\' not found'), 'bulunamadi');
  assert.equal(c("fatal: '/yok' does not appear to be a git repository"), 'bulunamadi');
  assert.equal(c(' ! [rejected]        main -> main (fetch first)'), 'reddedildi');
  assert.equal(c('error: failed to push some refs\n ! [rejected] main -> main (non-fast-forward)'), 'reddedildi');
  assert.equal(c('fatal: the receiving end does not support --atomic push'), 'atomikYok');
  assert.equal(c('', { timedOut: true }), 'zamanAsimi');
  assert.equal(c('bambaşka bir hata'), 'bilinmiyor');
});

/* ---------- sahte runner ---------- */

test('_netArgs: dış taşımalar kapalı, SSH BatchMode (kullanıcı tanımlamadıysa)', async () => {
  const { runner, calls } = okRunner();
  const g = new GitService({ runner, env: { GIT_SSH: '', GIT_SSH_COMMAND: '' } });
  const a = await g._netArgs(path.resolve('x'));
  assert.deepEqual(a.slice(0, 4), ['-c', 'protocol.ext.allow=never', '-c', 'protocol.fd.allow=never']);
  assert.ok(a.includes('core.sshCommand=ssh -o BatchMode=yes'));
  assert.equal(calls.length, 1, 'core.sshCommand sorgusu');
  const g2 = new GitService({ runner, env: { GIT_SSH_COMMAND: 'ssh -i x' } });
  assert.ok(!(await g2._netArgs(path.resolve('x'))).some((x) => /sshCommand/.test(x)));
});

test('push: argümanlar, GCM_INTERACTIVE, zaman aşımı ve env birleştirme', async () => {
  const { runner, calls } = okRunner();
  const g = new GitService({ runner, env: { FOO: 'bar' } });
  const dir = path.resolve('r');
  await g.push(dir, { remote: 'origin', branch: 'main', tags: ['paket/o/v1.0.0'], setUpstream: true });
  const c = calls.find((x) => x.args.includes('push'));
  const i = c.args.indexOf('push');
  assert.deepEqual(c.args.slice(i), ['push', '--porcelain', '--atomic', '--follow-tags', '-u', 'origin',
    'refs/heads/main:refs/heads/main', 'refs/tags/paket/o/v1.0.0:refs/tags/paket/o/v1.0.0']);
  assert.equal(c.opts.env.GCM_INTERACTIVE, 'never');
  assert.equal(c.opts.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(c.opts.env.FOO, 'bar');
  assert.equal(c.opts.timeout, 120000);
  assert.ok(c.args.includes('protocol.ext.allow=never'));
  calls.length = 0;
  await g.push(dir, { remote: 'origin', branch: 'main', interactive: true });
  assert.equal(calls.find((x) => x.args.includes('push')).opts.env.GCM_INTERACTIVE, undefined);
});

test('push: --atomic desteklenmiyorsa bir kez atomiksiz yeniden dener', async () => {
  let n = 0;
  const { runner, calls } = fakeRunner((cb, args) => {
    if (args.includes('config')) return cb(null, '', '');
    n++;
    if (n === 1) return cb(Object.assign(new Error('x'), { code: 1 }), '', 'fatal: the receiving end does not support --atomic push');
    cb(null, '', '');
  });
  const g = new GitService({ runner });
  await g.push(path.resolve('r'), { remote: 'origin', branch: 'main' });
  const pushes = calls.filter((x) => x.args.includes('push'));
  assert.equal(pushes.length, 2);
  assert.ok(pushes[0].args.includes('--atomic')); assert.ok(!pushes[1].args.includes('--atomic'));
});

test('zaman aşımı: GitError.timedOut ve netCode zamanAsimi', async () => {
  const { runner } = fakeRunner((cb, args) => {
    if (args.includes('config')) return cb(null, '', '');
    cb(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), '', '');
  });
  const g = new GitService({ runner });
  await assert.rejects(g.fetch(path.resolve('r'), 'origin', { interactive: false }), (e) => e.timedOut === true && e.netCode === 'zamanAsimi');
});

test('geçersiz ad ve URL reddedilir (komut çalıştırmadan)', async () => {
  const { runner, calls } = okRunner();
  const g = new GitService({ runner });
  const d = path.resolve('r');
  await assert.rejects(g.addRemote(d, 'Origin', 'https://h/r'), /Geçersiz uzak depo adı/);
  await assert.rejects(g.addRemote(d, 'origin', '-oProxy=x'), /Geçersiz URL/);
  await assert.rejects(g.clone(d, '-x', 'dir'), /Geçersiz URL/);
  await assert.rejects(g.clone(d, 'https://h/r.git', '../dir'), /Geçersiz klasör adı/);
  await assert.rejects(g.push(d, { remote: 'origin', branch: '-x' }), /Geçersiz ref/);
  await assert.rejects(g.createTagAt(d, 'a', 'zzz'), /Geçersiz commit/);
  assert.equal(calls.length, 0);
});

/* ---------- gerçek git + bare repo ---------- */

async function setup(d) {
  const g = new GitService({ env: gitEnv(d) });
  const repo = makeRepo(d, 'a');
  const bare = makeBare(d);
  fs.writeFileSync(path.join(repo, 'x.md'), 'bir\n');
  await g.commitPaths(repo, 'ilk', ['x.md']);
  await g.addRemote(repo, 'origin', bare);
  return { g, repo, bare, env: gitEnv(d) };
}

test('remotes, addRemote, setRemoteUrl, upstream, push (bare)', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo, bare } = await setup(d);
    assert.deepEqual(await g.remotes(repo), [{ name: 'origin', url: bare }]);
    assert.equal(await g.upstream(repo), null);
    const head = await g.headCommit(repo);
    await g.createTag(repo, 'paket/ornek/v1.0.0', 'ornek 1.0.0', head);
    assert.equal(await g.currentBranch(repo), 'main');
    await g.push(repo, { remote: 'origin', branch: 'main', tags: ['paket/ornek/v1.0.0'], setUpstream: true });
    assert.equal(await g.upstream(repo), 'origin/main');
    assert.equal(sh(bare, ['rev-parse', 'refs/heads/main']).trim(), head);
    assert.match(sh(bare, ['tag', '-l']), /paket\/ornek\/v1\.0\.0/);
    assert.deepEqual(await g.aheadBehind(repo, 'origin/main'), { ahead: 0, behind: 0 });
    await g.setRemoteUrl(repo, 'origin', bare + '-baska');
    assert.equal((await g.remotes(repo))[0].url, bare + '-baska');
    assert.deepEqual(await g.remotes(makeRepo(d, 'bos')), []);
  } finally { rmrf(d); }
});

test('push: olmayan uzak depo ağ hatası olarak sınıflanır', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo } = await setup(d);
    await g.setRemoteUrl(repo, 'origin', path.join(d, 'yok.git'));
    await assert.rejects(g.push(repo, { remote: 'origin', branch: 'main' }), (e) => e instanceof GitError && ['bulunamadi', 'ag'].includes(e.netCode));
  } finally { rmrf(d); }
});

test('fetch: uzak tag\'ler refs/pp/uzak altına, yerel refs/tags değişmez; listTags görmez, listRefs görür', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo, bare, env } = await setup(d);
    const head = await g.headCommit(repo);
    await g.push(repo, { remote: 'origin', branch: 'main', setUpstream: true });
    // B kopyası: yayın + push
    sh(d, ['clone', '-q', bare, 'b'], env);
    const b = path.join(d, 'b');
    fs.writeFileSync(path.join(b, 'y.md'), 'iki\n');
    sh(b, ['add', '.'], env); sh(b, ['commit', '-q', '-m', 'ikinci'], env);
    sh(b, ['tag', '-a', 'paket/ornek/v1.2.0', '-m', 'x'], env);
    sh(b, ['tag', '-a', 'prompt/ornek/x/v1.1.0', '-m', 'y'], env);
    sh(b, ['tag', 'baska-tag'], env);
    sh(b, ['push', '-q', 'origin', 'main', '--tags'], env);
    // A'da yerel push edilmemiş tag
    await g.createTag(repo, 'paket/ornek/v0.9.0', 'yerel', head);
    await g.fetch(repo, 'origin', { interactive: false });
    assert.deepEqual((await g.listTags(repo)).map((t) => t.name).sort(), ['paket/ornek/v0.9.0']);
    assert.deepEqual((await g.listTags(repo, 'paket/')).map((t) => t.name), ['paket/ornek/v0.9.0']);
    const refs = await g.listRefs(repo, 'refs/pp/uzak/origin/');
    assert.deepEqual(refs.map((r) => r.name).sort(), ['refs/pp/uzak/origin/paket/ornek/v1.2.0', 'refs/pp/uzak/origin/prompt/ornek/x/v1.1.0']);
    assert.match(refs[0].commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(await g.aheadBehind(repo, 'origin/main'), { ahead: 0, behind: 1 });
    const log = await g.logRange(repo, 'HEAD', 'origin/main');
    assert.equal(log.length, 1); assert.equal(log[0].subject, 'ikinci');
    assert.deepEqual(await g.logRange(repo, 'HEAD', 'origin/yok'), []);

    // ileri sarma + CAS geri alma + createTagAt
    const from = await g.headCommit(repo);
    await g.mergeFfOnly(repo, 'refs/remotes/origin/main');
    const to = await g.headCommit(repo);
    assert.notEqual(from, to);
    assert.ok(await g.isAncestor(repo, from, to));
    assert.equal(await g.isAncestor(repo, to, from), false);
    await g.createTagAt(repo, 'paket/ornek/v1.2.0', refs.find((r) => /paket/.test(r.name)).object);
    assert.ok((await g.listTags(repo, 'paket/')).some((t) => t.name === 'paket/ornek/v1.2.0'));
    await assert.rejects(g.createTagAt(repo, 'paket/ornek/v1.2.0', head), GitError, 'var olan tag ezilmez');
    assert.equal((await g.listTags(repo, 'paket/')).find((t) => t.name === 'paket/ornek/v1.2.0').annotated, true);
    await assert.rejects(g.resetKeep(repo, { expect: from, to: from }), /HEAD beklenen/, 'CAS');
    await g.resetKeep(repo, { expect: to, to: from });
    assert.equal(await g.headCommit(repo), from);
  } finally { rmrf(d); }
});

test('mergeFfOnly: ayrışmış dalda hata verir, hiçbir şeyi değiştirmez', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo, bare, env } = await setup(d);
    await g.push(repo, { remote: 'origin', branch: 'main', setUpstream: true });
    sh(d, ['clone', '-q', bare, 'b'], env);
    const b = path.join(d, 'b');
    fs.writeFileSync(path.join(b, 'y.md'), 'iki\n');
    sh(b, ['add', '.'], env); sh(b, ['commit', '-q', '-m', 'uzak'], env); sh(b, ['push', '-q', 'origin', 'main'], env);
    fs.writeFileSync(path.join(repo, 'z.md'), 'yerel\n');
    await g.commitPaths(repo, 'yerel', ['z.md']);
    await g.fetch(repo, 'origin', { interactive: false });
    assert.deepEqual(await g.aheadBehind(repo, 'origin/main'), { ahead: 1, behind: 1 });
    const before = await g.headCommit(repo);
    await assert.rejects(g.mergeFfOnly(repo, 'refs/remotes/origin/main'), GitError);
    assert.equal(await g.headCommit(repo), before);
    // push reddedilir
    await assert.rejects(g.push(repo, { remote: 'origin', branch: 'main' }), (e) => e.netCode === 'reddedildi');
  } finally { rmrf(d); }
});

test('isClean: .pp/ izlenmeyenleri sayılmaz; lsTree ve showAt', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo } = await setup(d);
    assert.deepEqual(await g.isClean(repo, []), []);
    fs.mkdirSync(path.join(repo, '.pp', 'trash'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.pp', 'trash', 'a.md'), 'x');
    assert.deepEqual(await g.isClean(repo, []), [], '.pp yok sayılır');
    assert.deepEqual(await g.isClean(repo, ['.']), []);
    fs.writeFileSync(path.join(repo, 'x.md'), 'degisti\n');
    fs.writeFileSync(path.join(repo, 'yeni.md'), 'y\n');
    assert.deepEqual((await g.isClean(repo, [])).sort(), ['x.md', 'yeni.md']);
    assert.deepEqual(await g.isClean(repo, ['x.md']), ['x.md']);
    assert.deepEqual(await g.isClean(repo, ['yok/']), []);
    const head = await g.headCommit(repo);
    assert.deepEqual(await g.lsTree(repo, head, 'x.md'), ['x.md']);
    assert.deepEqual(await g.lsTree(repo, head, 'yok'), []);
    assert.equal(await g.showAt(repo, head, 'x.md'), 'bir\n');
    assert.equal(await g.showAt(repo, head, 'yok.md'), null);
  } finally { rmrf(d); }
});

test('clone: bare repodan başarılı; olmayan yol hata verir', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo, bare } = await setup(d);
    await g.push(repo, { remote: 'origin', branch: 'main' });
    const lib = path.join(d, 'lib'); fs.mkdirSync(lib);
    await g.clone(lib, bare, 'kopya', { interactive: false });
    assert.ok(fs.existsSync(path.join(lib, 'kopya', 'x.md')));
    assert.equal(await g.isRepoRoot(path.join(lib, 'kopya')), true);
    assert.equal((await g.remotes(path.join(lib, 'kopya')))[0].name, 'origin');
    await assert.rejects(g.clone(lib, path.join(d, 'yok.git'), 'x2'), (e) => e instanceof GitError && ['bulunamadi', 'ag', 'bilinmiyor'].includes(e.netCode));
  } finally { rmrf(d); }
});

test('ext:: taşıması ağ komutlarında kapalıdır', real, async () => {
  const d = tmpDir();
  try {
    const { g, repo } = await setup(d);
    const marker = path.join(d, 'calisti.txt');
    await g.setRemoteUrl(repo, 'origin', 'ext::sh -c touch% ' + marker.replace(/\\/g, '/'));
    await assert.rejects(g.fetch(repo, 'origin', { interactive: false }), GitError);
    assert.equal(fs.existsSync(marker), false);
  } finally { rmrf(d); }
});
