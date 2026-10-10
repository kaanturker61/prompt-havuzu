'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const FM = require('../public/fm.js');
const Rules = require('../public/rules.js');
const ppConfig = require('../lib/pp-config');
const { GitService } = require('../lib/git-service');
const { MarketplaceRegistry } = require('../lib/marketplace-registry');
const { PromptIndex } = require('../lib/prompt-index');
const { VersionService } = require('../lib/version-service');
const { LibraryCatalog } = require('../lib/library-catalog');
const { gitAvailable, tmpDir, rmrf, gitEnv } = require('./helpers');

const real = { skip: !gitAvailable && 'git yok' };
const decode = (b) => b.toString('utf8');
const IGNORE = new Set(Rules.RESERVED_DIRS);
const EDITABLE = new Set(['.md', '.markdown', '.txt', '.json', '.yml', '.yaml']);

const put = (dir, rel, raw) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, raw); };
const pp = (extra) => JSON.stringify({ libraryDir: 'prompts', marketplace: { name: 'x', plugin: 'varsayilan' }, packages: {}, ...extra }, null, 2);

async function build() {
  const d = tmpDir();
  const tool = path.join(d, 'arac'); fs.mkdirSync(tool);
  const lib = path.join(d, 'lib'); fs.mkdirSync(lib);
  const git = new GitService({ env: gitEnv(d), forbiddenRoots: [tool] });
  const registry = new MarketplaceRegistry({ git, toolRoot: tool });
  const index = new PromptIndex({ decode, FM, Rules, ignore: IGNORE });
  const files = {
    read: (a) => fsp.readFile(a), write: (a, x) => fsp.writeFile(a, x, 'utf8'), stat: (a) => fsp.stat(a), utimes: (a, x, y) => fsp.utimes(a, x, y)
  };
  const versions = new VersionService({ git, files, decode, listPrompts: (r, l) => index.listMd(r, l) });
  const mk = (over = {}) => new LibraryCatalog({
    registry, index, loadConfigAt: ppConfig.loadConfigAt, versions, Rules, FM, ignore: IGNORE, editable: EDITABLE, ...over
  });
  return { d, lib, git, registry, index, versions, mk, catalog: mk() };
}

async function fixture() {
  const c = await build();
  const { lib, git } = c;
  const a = path.join(lib, 'a'); const b = path.join(lib, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  await git.init(a); await git.init(b);
  put(a, 'pp.config.json', pp({ packages: { ornek: { description: 'Örnek plugin' } } }));
  put(a, 'prompts/ornek/p.md', '---\nbaslik: Merhaba Dünya\netiketler: [ortak, a-ozel]\ndurum: aktif\ntur: komut\npaket: baska\nprojeler: [p1]\n---\nselam dünya\n');
  put(a, 'prompts/ornek/alt/q.md', '---\nbaslik: Alt\netiketler: [ortak]\n---\nalt govde\n');
  put(a, 'prompts/Kod İnceleme/k.md', '---\nbaslik: Kod\n---\nkod\n');
  put(a, 'prompts/claude-x/z.md', 'z');
  put(a, 'prompts/gelen-kutusu/g.md', '---\nbaslik: Gelen\n---\ng');
  put(a, 'prompts/tek.md', '---\nbaslik: Tek\ntur: komutt\n---\nt');
  put(a, 'prompts/.gizli/h.md', 'h');
  put(a, 'plugins/ornek/commands/p.md', '---\ndescription: x\n---\nuretilen');
  put(a, 'README.md', '# a');
  put(b, 'pp.config.json', pp());
  put(b, 'prompts/ornek/p.md', '---\nbaslik: Merhaba B\netiketler: [ortak]\n---\nselam b\n');
  fs.mkdirSync(path.join(lib, 'bozuk')); fs.writeFileSync(path.join(lib, 'bozuk', '.git'), 'bozuk');
  fs.mkdirSync(path.join(lib, 'duz'));
  return { ...c, a, b };
}

const group = (m) => [m.plugins, m.loose, m.inbox ? [m.inbox] : [], m.teknik];
function findNode(m, p) {
  const walk = (nodes) => { for (const n of nodes || []) { if (n.path === p) return n; const x = walk(n.children); if (x) return x; } return null; };
  for (const g of group(m)) { const x = walk(g); if (x) return x; }
  return null;
}

test('ağaç: gruplar, alt klasör, geçersiz ve git olmayan klasörler', real, async () => {
  const f = await fixture();
  try {
    const t = await f.catalog.tree(f.lib, 'a');
    assert.equal(t.active, 'a'); assert.equal(t.libraryDir, 'prompts');
    assert.deepEqual(t.marketplaces.map((m) => m.name), ['a', 'b', 'bozuk']);
    assert.deepEqual(t.ignored, [{ name: 'duz', reason: 'Git deposu değil' }]);
    const a = t.marketplaces[0];
    assert.equal(a.state, 'hazir'); assert.equal(a.active, true); assert.equal(a.defaultPlugin, 'varsayilan');
    assert.deepEqual(a.plugins.map((p) => p.name), ['claude-x', 'Kod İnceleme', 'ornek']);
    const ornek = a.plugins.find((p) => p.name === 'ornek');
    assert.equal(ornek.slug, 'ornek'); assert.equal(ornek.description, 'Örnek plugin'); assert.equal(ornek.nameIssue, null);
    assert.equal(ornek.count, 2);
    assert.equal(ornek.children[0].type, 'dir'); assert.equal(ornek.children[0].name, 'alt');
    assert.equal(ornek.children[0].children[0].path, 'prompts/ornek/alt/q.md');
    assert.equal(a.plugins[0].nameIssue.level, 'error');
    assert.match(a.plugins[0].nameIssue.message, /Anthropic/);
    assert.deepEqual(a.plugins[1].nameIssue, { level: 'info', message: 'Yayın adı: kod-inceleme' });
    assert.deepEqual(a.loose.map((n) => n.name), ['tek.md']);
    assert.equal(a.inbox.name, 'gelen-kutusu'); assert.equal(a.inbox.children[0].meta.baslik, 'Gelen');
    assert.equal(a.plugins.some((p) => p.name === '.gizli'), false);
    assert.equal(a.count, 7); assert.equal(a.libraryDirExists, true);
    assert.deepEqual(a.teknik.map((n) => n.name), ['plugins', 'pp.config.json', 'README.md']);
    assert.equal(findNode(a, 'plugins/ornek/commands/p.md').meta, undefined, 'teknik düğümlerde meta yok');
    assert.equal(findNode(a, 'README.md').meta, undefined);
    const p = findNode(a, 'prompts/ornek/p.md').meta;
    assert.equal(p.baslik, 'Merhaba Dünya'); assert.equal(p.tur, 'komut'); assert.equal(p.paketUyusmuyor, true);
    assert.equal(findNode(a, 'prompts/ornek/alt/q.md').meta.paketUyusmuyor, false);
    assert.equal(findNode(a, 'prompts/tek.md').meta.uyari, 'turGecersiz');
    assert.equal(a.yayinUyari, 1);
    const bad = t.marketplaces[2];
    assert.equal(bad.state, 'gecersiz'); assert.ok(bad.reason);
    assert.deepEqual([bad.plugins, bad.loose, bad.inbox, bad.teknik], [[], [], null, []]);
    // etkin yok
    assert.equal((await f.catalog.tree(f.lib, '')).libraryDir, null);
  } finally { rmrf(f.d); }
});

test('arama: iki marketplace, mp/plugin/kind alanları; filtreler; scope=all', real, async () => {
  const f = await fixture();
  try {
    let r = await f.catalog.search(f.lib, 'a', 'merhaba', {});
    assert.deepEqual(r.map((x) => [x.mp, x.plugin, x.kind]).sort(), [['a', 'ornek', 'paket'], ['b', 'ornek', 'paket']]);
    r = await f.catalog.search(f.lib, 'b', '', { tags: 'ortak' });
    assert.equal(r.length, 3);
    assert.deepEqual(r.filter((x) => x.mp === 'a').map((x) => x.path).sort(), ['prompts/ornek/alt/q.md', 'prompts/ornek/p.md']);
    r = await f.catalog.search(f.lib, 'b', '', { durum: 'aktif' });
    assert.deepEqual(r.map((x) => x.mp), ['a']);
    r = await f.catalog.search(f.lib, 'b', '', { tur: 'komut' });
    assert.equal(r.length, 1);
    r = await f.catalog.search(f.lib, 'a', 'tek', {});
    assert.equal(r[0].kind, 'klasorsuz'); assert.equal(r[0].plugin, null);
    r = await f.catalog.search(f.lib, 'a', 'gelen', {});
    assert.equal(r[0].kind, 'gelenKutusu');
    assert.equal((await f.catalog.search(f.lib, 'a', 'uretilen', {})).length, 0);
    r = await f.catalog.search(f.lib, 'a', 'uretilen', { scope: 'all' });
    assert.equal(r.length, 1); assert.equal(r[0].kind, 'disarida'); assert.equal(r[0].mp, 'a');
  } finally { rmrf(f.d); }
});

test('facets: toplamlar ve yayinUyariByMp (proje filtresi/pakets/folders yok)', real, async () => {
  const f = await fixture();
  try {
    const x = await f.catalog.facets(f.lib, 'a');
    assert.equal(x.total, 8);
    assert.equal(x.tags.find((t) => t.name === 'ortak').count, 3);
    assert.deepEqual(x.yayinUyariByMp, { a: 1, b: 0 });
    assert.equal(x.yayinUyari, 1);
    assert.deepEqual(x.durum, [{ name: 'aktif', count: 1 }]);
    assert.deepEqual(x.tur, [{ name: 'komut', count: 1 }]);
    assert.equal('pakets' in x, false); assert.equal('folders' in x, false);
  } finally { rmrf(f.d); }
});

test('surum: yalnızca tag olan marketplace\'te dolu (önbellek anahtarı)', real, async () => {
  const f = await fixture();
  try {
    const rel = 'prompts/ornek/p.md';
    // iki depoda da aynı rel; yalnızca a'da sürüm basılır
    await f.versions.bump(f.a, 'prompts', { rel, abs: path.join(f.a, rel), level: 'yama', note: 'ilk' });
    fs.appendFileSync(path.join(f.a, rel), 'degisti\n');
    const t = await f.catalog.tree(f.lib, 'a');
    assert.equal(findNode(t.marketplaces[0], rel).meta.surum, 'surumGuncelDegil');
    assert.equal(findNode(t.marketplaces[1], rel).meta.surum, '');
  } finally { rmrf(f.d); }
});

test('discover TTL içinde bir kez çağrılır; invalidate sonrası tekrar', async () => {
  let n = 0;
  const registry = { discover: async () => { n++; return { items: [], ignored: [] }; } };
  const cat = new LibraryCatalog({ registry, index: null, loadConfigAt: ppConfig.loadConfigAt, versions: null, Rules, FM, ignore: IGNORE, ttlMs: 60000 });
  await cat.marketplaces('/x', ''); await cat.marketplaces('/x', 'a');
  assert.equal(n, 1);
  cat.invalidate();
  await cat.marketplaces('/x', '');
  assert.equal(n, 2);
  await cat.marketplaces('/y', '');
  assert.equal(n, 3, 'farklı kök');
});

test('discover TTL dolunca yenilenir', async () => {
  let n = 0;
  const registry = { discover: async () => { n++; return { items: [], ignored: [] }; } };
  const cat = new LibraryCatalog({ registry, index: null, loadConfigAt: ppConfig.loadConfigAt, versions: null, Rules, FM, ignore: IGNORE, ttlMs: 5 });
  await cat.marketplaces('/x', '');
  await new Promise((r) => setTimeout(r, 20));
  await cat.marketplaces('/x', '');
  assert.equal(n, 2);
});
