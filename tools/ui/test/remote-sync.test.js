'use strict';
/* RemoteSync: iki çalışma kopyası + yerel bare repo (ağ yok). Fetch salt okuma, pull yalnızca ileri sarma. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { GitService } = require('../lib/git-service');
const { gitAvailable, tmpDir, rmrf, gitEnv, sh, makeBare } = require('./helpers');
const { seed, write, cmd, commitAll, buildStack, snapshot } = require('./stack');

const real = { skip: !gitAvailable && 'git yok' };

// A: seed edilmiş kopya (push edilmiş). B: bare'den klon. İkisi için yığın.
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

test('fetch: B yayınlar+push; A kontrol eder: behind 1, newTags, yerel tag\'ler değişmez', real, async () => {
  const tmp = tmpDir();
  try {
    const { a, sa, sb, b } = await twoCopies(tmp);
    await sa.git.createTag(a, 'prompt/yerel/x/v1.0.0', 'yerel', await sa.git.headCommit(a)); // push edilmemiş yerel tag
    const pub = await sb.publisher.publish(b, { name: 'ornek', push: true });
    assert.deepEqual(pub.push, { ok: true });
    const tagsBefore = (await sa.git.listTags(a)).map((t) => t.name);
    const f = await sa.remoteSync.fetch(a, {});
    assert.equal(f.ok, true); assert.equal(f.behind, 1); assert.equal(f.ahead, 0);
    assert.deepEqual(f.newTags, ['paket/ornek/v1.0.0']);
    assert.equal(f.newCommits.length, 1); assert.equal(f.newCommits[0].subject, 'ornek: 1.0.0 sürümü yayınlandı');
    assert.deepEqual((await sa.git.listTags(a)).map((t) => t.name), tagsBefore, 'yerel tag\'ler değişmedi, yerel tag silinmedi');
    const st = await sa.remoteSync.status(a);
    assert.equal(st.behind, 1); assert.equal(st.branch, 'main'); assert.equal(st.upstream, 'origin/main');
    assert.equal(st.lastCheck.behind, 1); assert.equal(st.remotes[0].provider, 'diger');
    // Güvenlik: A'nın tabanı uzak tag'i görmez
    assert.equal((await sa.advisor.base(a, 'ornek')).tags.length, 0);
  } finally { rmrf(tmp); }
});

test('pull: HEAD ileri sarılır, paket ve prompt tag\'leri yerelde oluşur; Version/History görür', real, async () => {
  const tmp = tmpDir();
  try {
    const { a, b, sa, sb } = await twoCopies(tmp);
    await sb.versions.bump(b, 'prompts', { rel: 'prompts/ornek/a.md', abs: path.join(b, 'prompts/ornek/a.md'), level: 'yama', note: 'ilk' });
    await sb.publisher.publish(b, { name: 'ornek', push: true });
    await sa.remoteSync.fetch(a, {});
    const from = await sa.git.headCommit(a);
    const r = await sa.remoteSync.pull(a, {});
    assert.equal(r.ok, true); assert.equal(r.from, from);
    assert.equal(r.to, await sb.git.headCommit(b));
    assert.deepEqual(r.adoptedTags.sort(), ['paket/ornek/v1.0.0', 'prompt/ornek/a/v1.0.0']);
    assert.ok((await sa.git.listTags(a, 'paket/')).some((t) => t.name === 'paket/ornek/v1.0.0' && t.annotated));
    assert.ok((await sa.versions.tagsByAd(a)).has('ornek/a'), 'VersionService yeni prompt tag\'ini görür');
    assert.ok(fs.existsSync(path.join(a, 'plugins/ornek/commands/aa.md')));
    const st = await sa.remoteSync.status(a);
    assert.equal(st.behind, 0); assert.equal(st.lastCheck.behind, 0); assert.deepEqual(st.lastCheck.newTags, []);
    assert.ok(sa.changed.includes(a));
    // artık güncel
    await assert.rejects(sa.remoteSync.pull(a, {}), (e) => e.status === 409 && e.data.code === 'guncel' && e.message === 'Zaten güncel');
    // A'nın taban analizi artık paket tag'ini tabanı olarak kullanır
    assert.equal((await sa.advisor.base(a, 'ornek')).version, '1.0.0');
  } finally { rmrf(tmp); }
});

test('pull: kirli çalışma ağacında 409, hiçbir şey değişmez', real, async () => {
  const tmp = tmpDir();
  try {
    const { a, b, sa, sb } = await twoCopies(tmp);
    await sb.publisher.publish(b, { name: 'ornek', push: true });
    write(a, 'prompts/ornek/a.md', cmd('A', 'komut_adi: aa\n') + 'kirli\n');
    const head = await sa.git.headCommit(a);
    const before = snapshot(a);
    await assert.rejects(sa.remoteSync.pull(a, {}), (e) => e.status === 409 && e.data.code === 'kirliCalismaAgaci' && e.data.files.includes('prompts/ornek/a.md'));
    assert.equal(await sa.git.headCommit(a), head); assert.deepEqual(snapshot(a), before);
    // .pp/ izlenmeyenleri kirli sayılmaz
    write(a, 'prompts/ornek/a.md', cmd('A', 'komut_adi: aa\n'));
    write(a, '.pp/trash/x.md', 'x');
    assert.equal((await sa.remoteSync.pull(a, {})).ok, true);
  } finally { rmrf(tmp); }
});

test('pull: yerelde commit + uzakta yeni commit -> ayristi; push reddedilir', real, async () => {
  const tmp = tmpDir();
  try {
    const { a, b, sa, sb } = await twoCopies(tmp);
    await sb.publisher.publish(b, { name: 'ornek', push: true });
    write(a, 'prompts/ornek/yerel.md', cmd('Yerel'));
    commitAll(a, tmp);
    const head = await sa.git.headCommit(a);
    await assert.rejects(sa.remoteSync.pull(a, {}), (e) => e.status === 409 && e.data.code === 'ayristi' && /pull --rebase/.test(e.message) && e.message.includes(a));
    assert.equal(await sa.git.headCommit(a), head);
    const p = await sa.remoteSync.push(a, {});
    assert.equal(p.ok, false); assert.equal(p.code, 'reddedildi'); assert.match(p.error, /ileri sarma/);
  } finally { rmrf(tmp); }
});

test('pull: tag benimsemede hata -> geri alma HEAD\'i from\'a döndürür', real, async () => {
  const tmp = tmpDir();
  try {
    class Bozuk extends GitService { async createTagAt() { throw new Error('tag yazılamadı'); } }
    const { a, b, sa, sb } = await twoCopies(tmp, { gitA: new Bozuk({ env: gitEnv(tmp) }) });
    await sb.publisher.publish(b, { name: 'ornek', push: true });
    const from = await sa.git.headCommit(a);
    const before = snapshot(a);
    await assert.rejects(sa.remoteSync.pull(a, {}), (e) => e.status === 500 && e.data.code === 'geriAlindi');
    assert.equal(await sa.git.headCommit(a), from);
    assert.deepEqual(snapshot(a), before);
  } finally { rmrf(tmp); }
});

test('arka plan kontrolü: elle ayarında atlanır, 1 saat içinde önbellekten döner, hata sessiz, remote yoksa remoteYok', real, async () => {
  const tmp = tmpDir();
  try {
    const { a, sa } = await twoCopies(tmp);
    const el = await sa.remoteSync.fetch(a, { background: true, setting: 'elle' });
    assert.equal(el.skipped, 'elle');
    assert.equal((await sa.state.get(a)).lastCheck, null, 'ağa çıkılmadı');
    const f1 = await sa.remoteSync.fetch(a, { background: true, setting: 'acilista' });
    assert.equal(f1.ok, true); assert.equal(f1.cached, undefined);
    const f2 = await sa.remoteSync.fetch(a, { background: true, setting: 'acilista' });
    assert.equal(f2.cached, true, 'saatlik sınır');
    // süre geçince tekrar kontrol eder
    const later = new (require('../lib/remote-sync').RemoteSync)({ git: sa.git, state: sa.state, lock: sa.lock, Rules: require('../public/rules.js'), now: () => Date.now() + 2 * 3600 * 1000 });
    assert.equal((await later.fetch(a, { background: true, setting: 'acilista' })).cached, undefined);
    // hata: uzak depo bozuk -> ok:false, lastCheck kaydedilir (toast yok)
    await sa.git.setRemoteUrl(a, 'origin', path.join(tmp, 'yok.git'));
    const bad = await later.fetch(a, { remote: 'origin', background: false });
    assert.equal(bad.ok, false); assert.ok(bad.code); assert.ok(bad.error);
    assert.equal((await sa.state.get(a)).lastCheck.ok, false);
    // remote yok
    const { makeRepo } = require('./helpers');
    const x = makeRepo(tmp, 'x');
    const sx = buildStack(x, tmp);
    assert.equal((await sx.remoteSync.fetch(x, { background: true })).code, 'remoteYok');
    await assert.rejects(sx.remoteSync.fetch(x, {}), (e) => e.status === 409 && e.data.code === 'remoteYok');
    await assert.rejects(sx.remoteSync.push(x, {}), (e) => e.status === 409 && e.data.code === 'remoteYok');
  } finally { rmrf(tmp); }
});

test('remote ekle/düzenle: doğrulama ve çakışma', real, async () => {
  const tmp = tmpDir();
  try {
    const { makeRepo } = require('./helpers');
    const x = makeRepo(tmp, 'x');
    const s = buildStack(x, tmp);
    const bare = makeBare(tmp, 'r1.git');
    await assert.rejects(s.remoteSync.addRemote(x, 'Origin', bare), (e) => e.status === 400 && e.data.code === 'remoteAdGecersiz');
    await assert.rejects(s.remoteSync.addRemote(x, 'origin', 'ext::sh -c x'), (e) => e.status === 400 && e.data.code === 'urlGecersiz' && /güvenlik/.test(e.message));
    await assert.rejects(s.remoteSync.addRemote(x, 'origin', 'https://u:p@h/r'), (e) => e.status === 400 && /Parola veya token/.test(e.message));
    const r = await s.remoteSync.addRemote(x, 'origin', bare);
    assert.equal(r.name, 'origin');
    await assert.rejects(s.remoteSync.addRemote(x, 'origin', bare), (e) => e.status === 409);
    await assert.rejects(s.remoteSync.setRemote(x, 'yok', bare), (e) => e.status === 404);
    await s.remoteSync.setRemote(x, 'origin', 'https://gitlab.com/g/p');
    const l = await s.remoteSync.list(x);
    assert.deepEqual(l[0], { name: 'origin', url: 'https://gitlab.com/g/p.git', provider: 'gitlab', addCommand: 'https://gitlab.com/g/p.git' });
  } finally { rmrf(tmp); }
});
