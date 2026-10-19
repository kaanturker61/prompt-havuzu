'use strict';
/* Test yardımcısı: server.js ile aynı bağlantıyı (Aşama 4 modülleri) geçici bir marketplace için kurar. */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const FM = require('../public/fm.js');
const Rules = require('../public/rules.js');
const { MarketplaceSettings } = require('../lib/marketplace-settings');
const { GitService } = require('../lib/git-service');
const { VersionService } = require('../lib/version-service');
const { PromptIndex } = require('../lib/prompt-index');
const { PackageExporter } = require('../lib/exporter');
const { ManifestWriter } = require('../lib/manifest-writer');
const { PackageCatalog } = require('../lib/package-catalog');
const { VersionAdvisor } = require('../lib/version-advisor');
const { PackagePublisher } = require('../lib/publisher');
const { RemoteSync } = require('../lib/remote-sync');
const { OpLock } = require('../lib/op-lock');
const { StateStore } = require('../lib/state-store');
const { gitEnv, makeRepo, sh } = require('./helpers');

const decode = (b) => b.toString('utf8');

async function atomicWrite(abs, data, opts) {
  if (opts && opts.mkdir) await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), '.' + path.basename(abs) + '.pp-tmp');
  await fsp.writeFile(tmp, data, 'utf8');
  await fsp.rename(tmp, abs);
}

function write(mk, rel, data) {
  const abs = path.join(mk, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
}

const cmd = (baslik, extra = '') => `---\nbaslik: ${baslik}\ntur: komut\n${extra}---\n${baslik} gövde\n`;

// Çalışan, commit atılmış bir marketplace: prompts/ornek/{a,b}.md
function seed(tmp, name = 'mk') {
  const mk = makeRepo(tmp, name);
  write(mk, '.gitignore', '.pp/\n');
  write(mk, '.claude-plugin/marketplace.json', JSON.stringify({ name, description: 'Deneme', owner: { name: 'tester' }, plugins: [] }, null, 2) + '\n');
  write(mk, 'prompts/ornek/.claude-plugin/plugin.json', JSON.stringify({ description: 'Örnek paket' }, null, 2) + '\n');
  write(mk, 'prompts/ornek/a.md', cmd('A', 'komut_adi: aa\n'));
  write(mk, 'prompts/ornek/b.md', cmd('B', 'komut_adi: bb\n'));
  const env = gitEnv(tmp);
  sh(mk, ['add', '-A'], env);
  sh(mk, ['commit', '-q', '-m', 'ilk'], env);
  return mk;
}

function commitAll(mk, tmp, msg = 'değişiklik') {
  const env = gitEnv(tmp);
  sh(mk, ['add', '-A'], env);
  sh(mk, ['commit', '-q', '-m', msg], env);
}

function buildStack(mk, tmp, { git } = {}) {
  const gitService = git || new GitService({ env: gitEnv(tmp) });
  const root = () => mk;
  const index = new PromptIndex({ decode, FM, Rules, ignore: new Set(Rules.RESERVED_DIRS) });
  const versions = new VersionService({
    git: gitService,
    files: { read: (a) => fsp.readFile(a), write: (a, d) => atomicWrite(a, d), stat: (a) => fsp.stat(a), utimes: (a, x, y) => fsp.utimes(a, x, y) },
    decode, listPrompts: (r, lib) => index.listMd(r, lib)
  });
  const toTrash = async (rel, abs) => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(mk, '.pp', 'trash', ts, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rename(abs, dest);
    return path.relative(mk, dest).split(path.sep).join('/');
  };
  const readIfExists = async (abs) => { try { return decode(await fsp.readFile(abs)); } catch (e) { return null; } };
  const exporter = new PackageExporter({ root, fsp, atomicWrite, toTrash, FM, Rules });
  const manifests = new ManifestWriter({ root, fsp, atomicWrite, FM, Rules });
  const catalog = new PackageCatalog({ listPrompts: (cfg) => index.listMd(mk, cfg.libraryDir, { includeBig: true }), exporter, readIfExists, root, Rules, FM });
  const advisor = new VersionAdvisor({ git: gitService, versions, exporter, Rules, FM });
  const lock = new OpLock();
  const state = new StateStore();
  const changed = [];
  const remoteSync = new RemoteSync({ git: gitService, state, lock, Rules, onChanged: (d) => { changed.push(d); index.clear(d); } });
  const settings = new MarketplaceSettings({ fsp, atomicWrite, Rules, FM });
  const config = { load: () => settings.loadStrict(mk, { manifest: true }) };
  const publisher = new PackagePublisher({
    git: gitService, catalog, exporter, manifests, advisor, state, lock, remoteSync, config, Rules, FM, onChanged: (d) => { changed.push(d); index.clear(d); }
  });
  return { mk, git: gitService, index, versions, exporter, manifests, catalog, advisor, lock, state, remoteSync, publisher, settings, config, changed, toTrash };
}

// Dizin ağacını { rel: içerik } olarak okur (.git ve .pp hariç); bayt bayt karşılaştırma için.
function snapshot(dir) {
  const out = {};
  const rec = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === '.pp') continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { out[r + '/'] = ''; rec(path.join(abs, e.name), r); } else out[r] = fs.readFileSync(path.join(abs, e.name)).toString('base64');
    }
  };
  rec(dir, '');
  return out;
}

module.exports = { seed, write, cmd, commitAll, buildStack, snapshot, atomicWrite };
