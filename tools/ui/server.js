#!/usr/bin/env node
/* Prompt Havuzu: yerel arayüz sunucusu.
 * Bağımlılık yok (yalnızca Node.js >= 18). Yalnızca 127.0.0.1 üzerinde dinler.
 *
 * Kullanım:  node tools/ui/server.js [--port 4317] [--open]
 * Library kökü ve etkin marketplace kullanıcı ayar dosyasından okunur (PP_CONFIG ile geçersiz kılınır).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const FM = require('./public/fm.js');
const Rules = require('./public/rules.js');
const { ConfigStore } = require('./lib/config-store');
const { GitService, GitError, HASH_RE } = require('./lib/git-service');
const { VersionService, VersionError } = require('./lib/version-service');
const { MarketplaceRegistry } = require('./lib/marketplace-registry');
const { MarketplaceFactory } = require('./lib/marketplace-factory');
const { SetupService, ROOT_BLOCKERS } = require('./lib/setup-service');
const templates = require('./lib/templates');
const paths = require('./lib/paths');
const ppConfig = require('./lib/pp-config');
const { PromptIndex } = require('./lib/prompt-index');
const { LibraryCatalog } = require('./lib/library-catalog');
const { PackageService, PackageError } = require('./lib/package-service');
const { PromptHistory, HistoryError } = require('./lib/prompt-history');
const { UndoStack } = require('./lib/undo');
const { PackageExporter } = require('./lib/exporter');
const { ManifestWriter } = require('./lib/manifest-writer');
const { PackageCatalog } = require('./lib/package-catalog');
const { VersionAdvisor } = require('./lib/version-advisor');
const { PackagePublisher } = require('./lib/publisher');
const { RemoteSync } = require('./lib/remote-sync');
const { OpLock } = require('./lib/op-lock');
const { StateStore } = require('./lib/state-store');
const { REMOTE_CHECKS } = require('./lib/config-store');

/* ------------------------------------------------------------------ ayarlar */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
const TOOL_DIR = path.resolve(__dirname, '..', '..');
const PORT = Number(ARGS.port || process.env.PORT || 4317);
const HOST = '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const IGNORE = new Set(Rules.RESERVED_DIRS);
const EDITABLE = new Set(['.md', '.markdown', '.txt', '.json', '.yml', '.yaml']);

/* ---------------------------------------------------------------- servisler */

const configStore = new ConfigStore({ file: ConfigStore.defaultFile(process.env) });
const gitService = new GitService({ forbiddenRoots: [TOOL_DIR] });
const registry = new MarketplaceRegistry({ git: gitService, toolRoot: TOOL_DIR });
const factory = new MarketplaceFactory({ git: gitService, templates, atomicWrite: (abs, data) => atomicWrite(abs, data, { mkdir: true }) });
const setup = new SetupService({ configStore, registry, git: gitService, toolRoot: TOOL_DIR });
const index = new PromptIndex({ decode, FM, Rules, ignore: IGNORE });
const versions = new VersionService({
  git: gitService,
  files: { read: (a) => fsp.readFile(a), write: (a, d) => atomicWrite(a, d), stat: (a) => fsp.stat(a), utimes: (a, x, y) => fsp.utimes(a, x, y) },
  decode,
  listPrompts: (r, lib) => index.listMd(r, lib)
});
const catalog = new LibraryCatalog({
  registry, index, loadConfigAt: ppConfig.loadConfigAt, versions, Rules, FM, ignore: IGNORE, editable: EDITABLE
});
const packages = new PackageService({
  fsp, atomicWrite: (abs, data) => atomicWrite(abs, data), loadConfigAt: ppConfig.loadConfigAt, saveConfigAt: ppConfig.saveConfigAt, Rules, FM
});
const history = new PromptHistory({ git: gitService, FM, Rules });
const exporter = new PackageExporter({ root: () => root(), fsp, atomicWrite, toTrash, FM });
const manifests = new ManifestWriter({ root: () => root(), fsp, atomicWrite, FM, Rules });
const packageCatalog = new PackageCatalog({
  listPrompts: (cfg) => index.listMd(root(), cfg.libraryDir, { includeBig: true }),
  exporter, readIfExists, root: () => root(), Rules, FM
});
const advisor = new VersionAdvisor({ git: gitService, versions, exporter, Rules, FM });
const opLock = new OpLock();
const stateStore = new StateStore();
// HEAD ya da tag'ler değişince dizin ve katalog önbellekleri temizlenir (PromptHistory/VersionService kendiliğinden geçersizleşir).
const afterGitChange = (dir) => { index.clear(dir); catalog.invalidate(); };
const remoteSync = new RemoteSync({ git: gitService, state: stateStore, lock: opLock, Rules, onChanged: afterGitChange });
const publisher = new PackagePublisher({
  git: gitService, catalog: packageCatalog, exporter, manifests, advisor, state: stateStore, lock: opLock, remoteSync, Rules, FM,
  config: {
    load: () => loadConfig(),
    // pp.config.json'u yazar; özgün baytlarını geri yazacak adımı ekler.
    save: async (cfg, undo) => {
      const file = ppConfig.configFileAt(root());
      const prev = await fsp.readFile(file).catch(() => null);
      undo.push(async () => { if (prev === null) await fsp.rm(file, { force: true }); else await fsp.writeFile(file, prev); });
      await saveConfig(cfg);
    }
  },
  onChanged: afterGitChange
});
const histErr = (e) => (e instanceof HistoryError ? httpErr(e.status, e.message, { code: e.code }) : e);
const pkgErr = (e) => (e instanceof PackageError ? httpErr(e.status, e.message, e.data) : e);
const vErr = (e) => (e instanceof VersionError ? httpErr(e.status, e.message, e.data) : e);

const str = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));
const toList = (v) => (Array.isArray(v) ? v : String(v == null ? '' : v).split(','))
  .map((s) => String(s).trim()).filter(Boolean);

function httpErr(status, message, data) {
  const e = new Error(message);
  e.status = status;
  if (data) e.data = data;
  return e;
}

// Etkin marketplace klasörü (çalışma kökü). Kurulum eksikse null.
function root() { return setup.current.root; }
const loadConfig = () => ppConfig.loadConfigAt(root());
const saveConfig = (c) => ppConfig.saveConfigAt(root(), c, atomicWrite);

/* --------------------------------------------------------------- dosya araçları */

function safePath(rel) {
  if (typeof rel !== 'string' || rel === '') throw httpErr(400, 'Yol gerekli');
  const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(root(), norm);
  const back = path.relative(root(), abs);
  if (back === '' || back.startsWith('..') || path.isAbsolute(back)) throw httpErr(400, 'Geçersiz yol');
  const parts = back.split(path.sep);
  if (parts.includes('.git')) throw httpErr(403, '.git klasörüne erişim yok');
  return { abs, rel: parts.join('/') };
}

function isEditable(rel) { return EDITABLE.has(path.extname(rel).toLowerCase()); }

async function exists(p) { try { await fsp.access(p); return true; } catch (e) { return false; } }

async function readIfExists(abs) {
  try { return decode(await fsp.readFile(abs)); } catch (e) { return null; }
}

// UTF-8, UTF-16 (BOM'lu) ve eski Türkçe ANSI (windows-1254) dosyaları okur.
function decode(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    let sw = Buffer.from(buf.subarray(2));
    if (sw.length % 2) sw = sw.subarray(0, sw.length - 1);
    sw.swap16();
    return new TextDecoder('utf-16le').decode(sw);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { return new TextDecoder('windows-1254').decode(buf); }
}

async function atomicWrite(abs, data, opts) {
  if (opts && opts.mkdir) await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), '.' + path.basename(abs) + '.pp-tmp');
  await fsp.writeFile(tmp, data, 'utf8');
  await fsp.rename(tmp, abs);
}

async function toTrash(rel, abs) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(root(), '.pp', 'trash', ts, rel);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rename(abs, dest);
  return path.relative(root(), dest).split(path.sep).join('/');
}

async function uniquePath(rel) {
  const ext = path.posix.extname(rel);
  const stem = rel.slice(0, rel.length - ext.length);
  let cand = rel; let n = 2;
  while (await exists(path.join(root(), cand))) cand = stem + '-' + (n++) + ext;
  return cand;
}

/* ------------------------------------------------------------------ dizin (arama) */

// Etkin marketplace için ince delegeler (dizin servisi marketplace klasörüne göre ayrı önbellek tutar).
const indexFile = (rel, abs) => index.indexFile(root(), rel, abs);
const listMd = (relDir, opts) => index.listMd(root(), relDir, opts);

/* ------------------------------------------------------------------------- git */

/* ------------------------------------------------------------------ marketplace */

const normTur = Rules.normTur;

// Dışa aktarma planı: promptlar klasöre göre paketlere bölünür (lib/package-catalog.js).
const publishPlan = (cfg) => packageCatalog.build(cfg);

// Eski (kullanımdan kalkan) rotalar ve init için: plugin.json sürümüne dokunmadan manifestleri yazar.
async function marketplaceSync(cfg, plan) {
  const names = Array.from(new Set(plan.plans.map((p) => p.paket).concat(plan.orphans.map((o) => o.paket))));
  const undo = new UndoStack();
  for (const pk of names) await manifests.writePluginJson(pk, cfg, { version: null }, undo);
  await manifests.writeMarketplace(cfg, { version: cfg.marketplace.version }, undo);
  await manifests.ensureReadme(cfg, undo);
  undo.clear();
  return names;
}

function quoteArg(p) { return /\s/.test(p) ? `"${p}"` : p; }

// Etkin marketplace'in tercih edilen uzak deposu (yoksa null).
async function primaryRemote() {
  const list = await gitService.remotes(root()).catch(() => []);
  return list.find((r) => r.name === 'origin') || list[0] || null;
}

async function marketplaceStatus() {
  const cfg = await loadConfig();
  const plan = await publishPlan(cfg);
  const mkFile = path.join(root(), '.claude-plugin', 'marketplace.json');
  const mkJson = await exists(mkFile) ? await manifests.readJson(mkFile) : null;
  const mkName = FM.slug(cfg.marketplace.name);
  const packages = Array.from(new Set(plan.plans.map((p) => p.paket)));
  const listed = (await manifests.listed()).map((l) => l.name);
  const configIssues = [];
  const verErr = Rules.checkVersion(cfg.marketplace.version);
  if (verErr) configIssues.push({ code: 'surumGecersiz', level: 'warn', message: verErr });
  const skipped = plan.skipped.filter((x) => x.level === 'warn');
  for (const p of plan.plans) {
    for (const i of p.issues) {
      if (i.code === 'paketUyusmuyor' || i.code === 'paketCokDegerli') skipped.push({ source: p.source, baslik: p.baslik, code: i.code, level: 'warn', reason: i.msg });
    }
  }
  const remote = await primaryRemote();
  let commands;
  if (remote) {
    const ac = Rules.marketplaceAddCommand(remote.url);
    commands = {
      add: `claude plugin marketplace add ${quoteArg(ac.primary)}`,
      addInSession: `/plugin marketplace add ${quoteArg(ac.primary)}`,
      alternatives: ac.alternatives.map((a) => `claude plugin marketplace add ${quoteArg(a)}`),
      pinHint: `${ac.primary}#<dal-veya-etiket>`,
      addNote: null
    };
  } else {
    commands = {
      add: `claude plugin marketplace add ${quoteArg(root())}`,
      addInSession: `/plugin marketplace add ${quoteArg(root())}`,
      alternatives: [], pinHint: null,
      addNote: 'Yerel yol: plugin\'ler yerinde yüklenir, sürüm takibi yapılmaz'
    };
  }
  commands.validate = `claude plugin validate ${quoteArg(root())}`;
  commands.install = listed.map((p) => ({ plugin: p, cmd: `claude plugin install ${p}@${mkName}`, inSession: `/plugin install ${p}@${mkName}` }));
  return {
    config: cfg.marketplace,
    export: cfg.export,
    configIssues,
    root: root(),
    marketplaceName: mkName,
    marketplaceExists: !!mkJson,
    marketplacePlugins: mkJson ? (mkJson.plugins || []).map((p) => p.name) : [],
    items: plan.plans.map(({ expected, ...rest }) => rest),
    skipped,
    unpublishedCount: plan.skipped.filter((x) => x.code === 'yayinDisi').length,
    orphans: plan.orphans,
    packages,
    listed,
    remote: remote ? { name: remote.name, url: remote.url, provider: Rules.repoProvider(remote.url) } : null,
    commands
  };
}

/* --------------------------------------------------------------- içe aktarma */

function expandDir(d) {
  d = String(d || '').trim().replace(/^["']|["']$/g, '');
  if (!d) throw httpErr(400, 'Klasör yolu gerekli');
  if (d === '~' || d.startsWith('~/') || d.startsWith('~\\')) d = path.join(os.homedir(), d.slice(1));
  return path.resolve(d);
}

async function scanTxt(dirAbs, recursive) {
  const out = [];
  async function rec(abs, depth) {
    let ents;
    try { ents = await fsp.readdir(abs, { withFileTypes: true }); } catch (e) {
      if (depth === 0) throw httpErr(400, 'Klasör okunamadı: ' + e.message);
      return;
    }
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const a = path.join(abs, e.name);
      if (e.isDirectory()) { if (recursive && depth < 3) await rec(a, depth + 1); continue; }
      if (!/\.txt$/i.test(e.name)) continue;
      const st = await fsp.stat(a);
      if (st.size > 2000000) continue;
      const text = decode(await fsp.readFile(a)).replace(/^﻿/, '');
      const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
      out.push({
        file: a, name: e.name, rel: path.relative(dirAbs, a), size: st.size,
        date: st.mtime.toISOString().slice(0, 10), lines: text.split(/\r?\n/).length, preview: first.trim().slice(0, 120)
      });
    }
  }
  await rec(dirAbs, 0);
  return out.sort((a, b) => a.rel.localeCompare(b.rel, 'tr'));
}

function titleFromName(name) {
  const t = name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.charAt(0).toLocaleUpperCase('tr') + t.slice(1);
}

async function importFiles(dirAbs, files, targetRel) {
  const target = safePath(targetRel);
  const created = []; const skipped = [];
  for (const f of files) {
    const abs = path.resolve(String(f));
    const back = path.relative(dirAbs, abs);
    if (back.startsWith('..') || path.isAbsolute(back)) { skipped.push({ file: f, reason: 'Seçilen klasörün dışında' }); continue; }
    if (!/\.txt$/i.test(abs)) { skipped.push({ file: f, reason: '.txt değil' }); continue; }
    let buf; let st;
    try { buf = await fsp.readFile(abs); st = await fsp.stat(abs); } catch (e) { skipped.push({ file: f, reason: 'Okunamadı' }); continue; }
    const text = decode(buf).replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
    if (!text) { skipped.push({ file: f, reason: 'Boş dosya' }); continue; }
    const base = path.basename(abs);
    const p = FM.parse('');
    FM.set(p, 'baslik', titleFromName(base));
    FM.set(p, 'durum', 'taslak');
    FM.set(p, 'olusturma', st.mtime.toISOString().slice(0, 10));
    p.body = '\n' + text + '\n';
    const rel = await uniquePath(target.rel + '/' + FM.slug(base.replace(/\.[^.]+$/, '')) + '.md');
    await atomicWrite(path.join(root(), rel), FM.stringify(p), { mkdir: true });
    created.push({ from: abs, to: rel });
  }
  return { created, skipped };
}

/* -------------------------------------------------------------------- yönlendirme */

const routes = new Map();
// opts.open true ise kurulum tamamlanmadan da çalışır (Bölüm A.2).
const route = (method, p, fn, opts) => routes.set(method + ' ' + p, { fn, open: !!(opts && opts.open) });

function setupRequired(state) {
  const first = state.issues.find((i) => i.level === 'error');
  return httpErr(409, 'Kurulum tamamlanmadı: ' + (first ? first.message : 'bilinmeyen sorun'), { setupRequired: true, setup: state });
}

// Library kökü kullanılamıyorsa veya git yoksa true (yeni marketplace rotalarını engeller).
const rootBroken = (state) => state.issues.some((i) => ROOT_BLOCKERS.includes(i.code));

async function requireRootOk() {
  const st = await setup.evaluate();
  if (rootBroken(st)) throw setupRequired(st);
  return st;
}

// /api/info gövdesi; marketplace etkinleştirme yanıtı da aynısını taşır (ikinci istek gerekmesin).
async function infoView() {
  const st = await setup.evaluate();
  const cfg = await loadConfig();
  let gitOk = true;
  try { await gitService.version(); } catch (e) { gitOk = false; }
  return {
    root: st.root, platform: process.platform, node: process.version, config: cfg, isRepo: st.ok, gitAvailable: gitOk,
    configPath: configStore.file, libraryRoot: st.libraryRoot, activeMarketplace: st.activeMarketplace, setup: st
  };
}

route('GET', '/api/info', async () => infoView(), { open: true });

/* ---- ayarlar ve marketplace yönetimi (her zaman açık) ---- */

async function settingsView() {
  const st = await setup.evaluate();
  const sug = paths.suggestedRoot();
  const { config } = await configStore.load();
  return {
    configPath: configStore.file, libraryRoot: st.libraryRoot, activeMarketplace: st.activeMarketplace, remoteCheck: config.remoteCheck,
    suggestedRoot: sug, suggestedRootNote: sug ? null : paths.suggestedRootNote(), toolRoot: TOOL_DIR, setup: st
  };
}

route('GET', '/api/settings', async () => settingsView(), { open: true });

route('PUT', '/api/settings', async ({ body }) => {
  if (body.remoteCheck !== undefined && !REMOTE_CHECKS.includes(body.remoteCheck)) throw httpErr(400, 'Geçersiz değer', { field: 'remoteCheck' });
  // Yalnızca uzak depo kontrol ayarı gelirse library kökü doğrulaması atlanır.
  if (body.remoteCheck !== undefined && (body.libraryRoot === undefined || body.libraryRoot === null || body.libraryRoot === '')) {
    const { config } = await configStore.load();
    try { await configStore.save({ ...config, remoteCheck: body.remoteCheck }); } catch (e) { throw httpErr(500, 'Ayar dosyası yazılamadı: ' + e.message); }
    return settingsView();
  }
  let d = String(body.libraryRoot == null ? '' : body.libraryRoot).trim().replace(/^["']|["']$/g, '');
  if (!d) throw httpErr(400, 'Library kökü gerekli');
  if (d === '~' || d.startsWith('~/') || d.startsWith('~\\')) d = path.join(os.homedir(), d.slice(1));
  if (!path.isAbsolute(d)) throw httpErr(400, 'Mutlak bir klasör yolu gir');
  d = path.resolve(d);
  if (paths.samePath(d, TOOL_DIR) || paths.isInside(d, TOOL_DIR)) {
    throw httpErr(400, 'Library kökü araç reposunun içinde olamaz: ' + d, { code: 'kokAracReposunda' });
  }
  const st = await fsp.stat(d).catch(() => null);
  if (!st) {
    if (!body.create) throw httpErr(404, 'Klasör bulunamadı: ' + d, { notFound: true });
    try { await fsp.mkdir(d, { recursive: true }); } catch (e) { throw httpErr(500, 'Klasör oluşturulamadı: ' + e.message); }
  } else if (!st.isDirectory()) {
    throw httpErr(400, 'Bu yol bir klasör değil: ' + d);
  }
  const { config } = await configStore.load();
  const next = { ...config, libraryRoot: d, ...(body.remoteCheck !== undefined ? { remoteCheck: body.remoteCheck } : {}) };
  // Kayıtlı marketplace yeni kökte yoksa boşalt.
  if (next.activeMarketplace && !(await registry.folderOf(d, next.activeMarketplace))) next.activeMarketplace = '';
  const saveCfg = async (c) => {
    try { await configStore.save(c); } catch (e) { throw httpErr(500, 'Ayar dosyası yazılamadı: ' + e.message); }
  };
  await saveCfg(next);
  // Seçili marketplace yoksa ve kökte tam olarak bir geçerli marketplace varsa onu seç.
  const st2 = await setup.evaluate();
  if (!next.activeMarketplace && !rootBroken(st2)) {
    const valid = (await registry.discover(d, '')).items.filter((i) => i.valid);
    if (valid.length === 1) await saveCfg({ ...next, activeMarketplace: valid[0].name });
  }
  setup.invalidate();
  catalog.invalidate();
  return settingsView();
}, { open: true });

async function marketplacesView() {
  const st = await setup.evaluate();
  let items = []; let ignored = [];
  if (!rootBroken(st)) ({ items, ignored } = await registry.discover(st.libraryRoot, st.activeMarketplace));
  return { libraryRoot: st.libraryRoot, active: st.activeMarketplace, items, ignored, setup: st };
}

route('GET', '/api/marketplaces', async () => marketplacesView(), { open: true });

route('POST', '/api/marketplaces', async ({ body }) => {
  const st = await requireRootOk();
  const made = await factory.create(st.libraryRoot, { name: body.name, description: body.description, owner: body.owner });
  if (body.activate !== false) {
    const { config } = await configStore.load();
    try { await configStore.save({ ...config, activeMarketplace: made.name }); } catch (e) { throw httpErr(500, 'Ayar dosyası yazılamadı: ' + e.message); }
  }
  setup.invalidate();
  catalog.invalidate();
  const view = await marketplacesView();
  return { ok: true, marketplace: view.items.find((i) => i.name === made.name) || null, setup: view.setup };
}, { open: true });

// Uzak depodan klonlama: etkin marketplace'ten bağımsız (X-PP-MP kapsamı dışı). Ağ kilidi library köküne göre.
route('POST', '/api/marketplaces/clone', async ({ body }) => {
  const st = await requireRootOk();
  let made;
  try {
    made = await opLock.run(st.libraryRoot, 'ag', () => factory.cloneRemote(st.libraryRoot, body.url, { name: body.name }));
  } catch (e) {
    if (e.status && !e.data) throw httpErr(e.status, e.message, { code: e.code, ...(e.detail ? { detail: e.detail } : {}) });
    throw e;
  }
  if (body.activate !== false) {
    const { config } = await configStore.load();
    try { await configStore.save({ ...config, activeMarketplace: made.name }); } catch (e) { throw httpErr(500, 'Ayar dosyası yazılamadı: ' + e.message); }
  }
  setup.invalidate();
  catalog.invalidate();
  const view = await marketplacesView();
  return { ok: true, marketplace: view.items.find((i) => i.name === made.name) || null, setup: view.setup, warnings: made.warnings };
}, { open: true });

// pp.config.json yoksa marketplace.json'dan oluşturur. Commit atılmaz.
route('POST', '/api/marketplaces/pp-config', async ({ body }) => {
  const st = await requireRootOk();
  const name = String(body.name || '');
  const dir = await registry.folderOf(st.libraryRoot, name);
  if (!dir) throw httpErr(404, 'Klasör bulunamadı: ' + name);
  if (paths.samePath(dir, TOOL_DIR)) throw httpErr(400, 'Araç reposu marketplace olarak kullanılamaz');
  const file = ppConfig.configFileAt(dir);
  if (await exists(file)) throw httpErr(409, 'Bu marketplace\'te pp.config.json zaten var');
  let mj = {};
  try { mj = JSON.parse(await fsp.readFile(path.join(dir, '.claude-plugin', 'marketplace.json'), 'utf8')); } catch (e) { /* manifest yok */ }
  const slug = FM.slug(str(mj.name) || name);
  const owner = str(mj.owner && mj.owner.name) || (() => { try { return os.userInfo().username; } catch (e) { return 'ben'; } })();
  const description = str(mj.description) || `Prompt havuzu: ${slug}`;
  await atomicWrite(file, templates.ppConfig({ name: slug, description, owner }));
  setup.invalidate();
  catalog.invalidate();
  const view = await marketplacesView();
  return { ok: true, marketplace: view.items.find((i) => i.name === name) || null, setup: view.setup };
}, { open: true });

route('POST', '/api/marketplaces/activate', async ({ body }) => {
  await requireRootOk();
  const name = String(body.name || '');
  const view = await marketplacesView();
  const hit = view.items.find((i) => i.name === name) || view.ignored.find((i) => i.name === name);
  if (!hit) throw httpErr(404, 'Marketplace bulunamadı: ' + name);
  if (hit.reason === 'Araç reposu') throw httpErr(400, 'Araç reposu marketplace olarak seçilemez');
  const { config } = await configStore.load();
  try { await configStore.save({ ...config, activeMarketplace: name }); } catch (e) { throw httpErr(500, 'Ayar dosyası yazılamadı: ' + e.message); }
  setup.invalidate();
  catalog.invalidate();
  return { ok: true, setup: await setup.evaluate(), info: await infoView() };
}, { open: true });

route('POST', '/api/marketplaces/git-init', async ({ body }) => {
  const st = await requireRootOk();
  const name = String(body.name || '');
  const dir = await registry.folderOf(st.libraryRoot, name);
  if (!dir) throw httpErr(404, 'Klasör bulunamadı: ' + name);
  if (paths.samePath(dir, TOOL_DIR)) throw httpErr(400, 'Araç reposu marketplace olarak kullanılamaz');
  const created = await factory.initExisting(dir);
  setup.invalidate();
  catalog.invalidate();
  const view = await marketplacesView();
  return { ok: true, marketplace: view.items.find((i) => i.name === name) || null, created, setup: view.setup };
}, { open: true });

// Okuma rotaları: etkin marketplace gerekmez, library kökü yeterlidir. Tüm geçerli marketplace'leri kapsar.
route('GET', '/api/tree', async () => {
  const st = await requireRootOk();
  // Prompt klasörü yalnızca etkin marketplace için oluşturulur; diğer depolara hiçbir şey yazılmaz.
  if (st.ok) {
    const cfg = await loadConfig();
    await fsp.mkdir(path.join(root(), cfg.libraryDir), { recursive: true });
  }
  return catalog.tree(st.libraryRoot, st.activeMarketplace);
}, { open: true });

route('GET', '/api/facets', async () => {
  const st = await requireRootOk();
  return catalog.facets(st.libraryRoot, st.activeMarketplace);
}, { open: true });

route('GET', '/api/search', async ({ q }) => {
  const st = await requireRootOk();
  return {
    results: await catalog.search(st.libraryRoot, st.activeMarketplace, q.get('q') || '', {
      tags: q.get('tags') || '', durum: q.get('durum') || '', tur: q.get('tur') || '', scope: q.get('scope') || 'library'
    })
  };
}, { open: true });

route('GET', '/api/file', async ({ q }) => {
  const { abs, rel } = safePath(q.get('path'));
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw httpErr(404, 'Dosya bulunamadı');
  if (st.size > 5000000) throw httpErr(413, 'Dosya çok büyük');
  const cfg = await loadConfig();
  const raw = decode(await fsp.readFile(abs));
  const isMd = /\.(md|markdown)$/i.test(rel);
  const isPrompt = isMd && rel.startsWith(cfg.libraryDir + '/');
  const plan = await publishPlan(cfg);
  const gen = plan.byTarget.get(rel);
  const pub = plan.bySource.get(rel);
  let publishCheck = null;
  if (isPrompt) {
    const sk = plan.bySkipped.get(rel);
    const err = pub && pub.issues.find((i) => i.level === 'error');
    if (sk) publishCheck = { code: sk.code, level: sk.level, reason: sk.reason, ...(sk.fields ? { fields: sk.fields } : {}) };
    else if (err) publishCheck = { code: err.code, level: 'error', reason: err.msg };
    else {
      const pw = pub && pub.issues.find((i) => i.code === 'paketUyusmuyor' || i.code === 'paketCokDegerli');
      if (pw) publishCheck = { code: pw.code, level: 'warn', reason: pw.msg };
    }
  }
  return {
    path: rel, raw, mtime: Math.round(st.mtimeMs), isPrompt, isMd,
    publishCheck,
    generatedFrom: gen ? gen.source : null,
    publish: pub ? { target: pub.target, state: pub.state, paket: pub.paket, ad: pub.ad, tur: pub.tur, paketKaynagi: pub.paketKaynagi } : null
  };
});

route('PUT', '/api/file', async ({ body }) => {
  const { abs, rel } = safePath(body.path);
  if (!isEditable(rel)) throw httpErr(400, 'Bu dosya türü düzenlenemez');
  if (typeof body.raw !== 'string') throw httpErr(400, 'İçerik gerekli');
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) throw httpErr(404, 'Dosya bulunamadı. Silinmiş veya taşınmış olabilir');
  if (body.baseMtime && Math.abs(Math.round(st.mtimeMs) - body.baseMtime) > 1) {
    throw httpErr(409, 'Dosya sen açtıktan sonra diskte değişti', { conflict: true, mtime: Math.round(st.mtimeMs) });
  }
  await atomicWrite(abs, body.raw);
  const ns = await fsp.stat(abs);
  // Commit mesajı doluysa yalnızca bu dosya commit edilir (A.18); boşsa davranış eskisiyle aynıdır.
  const msg = String(body.commitMessage || '').trim();
  let commitInfo = {};
  if (msg) {
    try {
      const gst = await gitService.status(root());
      if (!gst.files.some((f) => f.path === rel)) commitInfo = { commit: null, commitSkipped: 'degisiklikYok' };
      else commitInfo = { commit: await gitService.commitPaths(root(), msg, [rel]) };
    } catch (e) {
      await gitService.unstage(root(), [rel]).catch(() => {});
      commitInfo = {
        commit: null,
        commitError: e instanceof GitError && e.isIdentityError
          ? { error: 'Git, commit yazarını bilmiyor. Ad ve e-posta gir.', needIdentity: true }
          : { error: e.message }
      };
    }
  }
  return { ok: true, path: rel, mtime: Math.round(ns.mtimeMs), ...commitInfo };
});

route('POST', '/api/file', async ({ body }) => {
  let { rel } = safePath(body.path);
  if (!isEditable(rel)) throw httpErr(400, 'Bu dosya türü oluşturulamaz');
  if (body.unique) rel = await uniquePath(rel);
  else if (await exists(path.join(root(), rel))) throw httpErr(409, 'Bu adda bir dosya zaten var');
  await atomicWrite(path.join(root(), rel), String(body.raw || ''), { mkdir: true });
  const st = await fsp.stat(path.join(root(), rel));
  return { ok: true, path: rel, mtime: Math.round(st.mtimeMs) };
});

route('DELETE', '/api/file', async ({ q }) => {
  const { abs, rel } = safePath(q.get('path'));
  if (!(await exists(abs))) throw httpErr(404, 'Bulunamadı');
  return { ok: true, trash: await toTrash(rel, abs) };
});

// Kullanımdan kalktı: arayüz artık klasör açmak için /api/package kullanır. Geriye uyum için korunur.
route('POST', '/api/mkdir', async ({ body }) => {
  const { abs, rel } = safePath(body.path);
  if (await exists(abs)) throw httpErr(409, 'Bu klasör zaten var');
  await fsp.mkdir(abs, { recursive: true });
  await atomicWrite(path.join(abs, '.gitkeep'), '');
  return { ok: true, path: rel };
});

route('POST', '/api/rename', async ({ body }) => {
  const from = safePath(body.from); const to = safePath(body.to);
  if (!(await exists(from.abs))) throw httpErr(404, 'Kaynak bulunamadı');
  if (await exists(to.abs)) throw httpErr(409, 'Hedef zaten var');
  if (to.rel.startsWith(from.rel + '/')) throw httpErr(400, 'Klasör kendi içine taşınamaz');
  await fsp.mkdir(path.dirname(to.abs), { recursive: true });
  await fsp.rename(from.abs, to.abs);
  return { ok: true, path: to.rel };
});

/* ---- plugin ---- */

route('POST', '/api/package', async ({ body }) => {
  const cfg = await loadConfig();
  try {
    return { ok: true, plugin: await packages.create(root(), cfg.libraryDir, { name: body.name, description: body.description }) };
  } catch (e) { throw pkgErr(e); }
});

route('PUT', '/api/package', async ({ body }) => {
  const cfg = await loadConfig();
  try { return await packages.setDescription(root(), cfg.libraryDir, { name: body.name, description: body.description }); } catch (e) { throw pkgErr(e); }
});

route('POST', '/api/package/rename', async ({ body }) => {
  const cfg = await loadConfig();
  try {
    const r = await packages.rename(root(), cfg.libraryDir, { from: body.from, to: body.to });
    return { ok: true, plugin: { name: r.name, slug: r.slug, path: r.path }, moved: r.moved };
  } catch (e) { throw pkgErr(e); }
});

/* ---- paket sayfası ve yayın (Aşama 4) ---- */

const lastTagOf = (base) => (base.tags[0] ? { name: base.tags[0].name, version: base.tags[0].version, commit: base.tags[0].commit, date: base.tags[0].date } : null);

function packageSummary(cfg, pkg, analysis, pending, listed) {
  const pk = cfg.packages || {};
  const changedCount = analysis.prompts.filter((p) => p.change !== 'ayni').length + analysis.removed.length + (analysis.descChanged ? 1 : 0);
  return {
    name: pkg.name,
    description: str((pk[pkg.name] || {}).description),
    version: analysis.base.headVersion || null,
    baseVersion: analysis.base.version || null,
    lastTag: lastTagOf(analysis.base),
    exportedCount: pkg.prompts.length,
    excludedCount: pkg.excluded.length,
    changedCount,
    blocking: packageCatalog.blocking(pkg).length,
    proposal: { level: analysis.level, version: analysis.version, tagOnly: analysis.tagOnly, noChange: analysis.noChange, reasons: analysis.reasons },
    pendingPush: pending.some((t) => { const p = Rules.parsePackageTag(t); return !!p && p.ad === pkg.name; }),
    listed: listed.has(pkg.name)
  };
}

route('GET', '/api/packages', async () => {
  const cfg = await loadConfig();
  const built = await publishPlan(cfg);
  const st = await stateStore.get(root());
  const listed = new Set((await manifests.listed()).map((l) => l.name));
  const out = [];
  for (const name of Array.from(built.packages.keys()).sort((a, b) => a.localeCompare(b, 'tr'))) {
    const pkg = built.packages.get(name);
    out.push(packageSummary(cfg, pkg, await advisor.analyze(root(), pkg, cfg), st.pendingTags, listed));
  }
  return { packages: out, export: cfg.export };
});

route('GET', '/api/package', async ({ q }) => {
  const name = String(q.get('name') || '');
  const cfg = await loadConfig();
  const built = await publishPlan(cfg);
  const d = await publisher.details(root(), cfg, built, name);
  if (!d) throw httpErr(404, 'Paket bulunamadı: ' + name);
  const listed = new Set((await manifests.listed()).map((l) => l.name));
  const remotes = await gitService.remotes(root()).catch(() => []);
  return {
    ...packageSummary(cfg, d.pkg, d.analysis, d.pending, listed),
    prompts: d.analysis.prompts,
    removed: d.analysis.removed,
    excluded: d.pkg.excluded.map((x) => ({ source: x.source, baslik: x.baslik, code: x.code, level: x.level, reason: x.reason })),
    tags: d.analysis.base.tags,
    issues: packageCatalog.blocking(d.pkg),
    dirty: d.dirty,
    marketplaceVersion: d.catalogVersion,
    remote: (remotes.find((r) => r.name === 'origin') || remotes[0] || {}).name || null
  };
});

route('POST', '/api/package/publish', async ({ body }) => publisher.publish(root(), {
  name: String(body.name || ''), version: body.version, marketplaceVersion: body.marketplaceVersion,
  push: !!body.push, remote: body.remote
}));

/* ---- marketplace'ler arası taşıma ---- */

// K2'nin tek, belgelenmiş istisnası: kaynak etkin marketplace'tir, hedef başka bir marketplace'tir. Commit atılmaz.
route('POST', '/api/prompts/transfer', async ({ body }) => {
  const st = setup.current;
  const cfg = await loadConfig();
  const { abs, rel } = safePath(body.path);
  const cl = Rules.classifyPromptPath(rel, cfg.libraryDir);
  if (!/\.(md|markdown)$/i.test(rel) || cl.kind === 'disarida') throw httpErr(400, 'Yalnızca prompt dosyaları taşınabilir');
  const sst = await fsp.stat(abs).catch(() => null);
  if (!sst || !sst.isFile()) throw httpErr(404, 'Dosya bulunamadı');
  const toMp = String(body.toMp || '');
  if (!toMp) throw httpErr(400, 'Hedef marketplace gerekli');
  if (toMp === st.activeMarketplace) throw httpErr(400, "Hedef marketplace kaynakla aynı. Aynı marketplace içinde taşımak için yeniden adlandırma kullan");
  const { items } = await catalog.marketplaces(st.libraryRoot, st.activeMarketplace);
  const target = items.find((m) => m.name === toMp);
  if (!target) throw httpErr(404, 'Marketplace bulunamadı: ' + toMp);
  if (!target.valid) throw httpErr(400, 'Hedef marketplace geçerli bir git deposu değil: ' + toMp);
  if (!target.hasPpConfig) throw httpErr(400, 'Hedefte Prompt Havuzu ayarı (pp.config.json) yok. Önce hedef marketplace için ayar dosyasını oluştur.', { code: 'hedefPpConfigYok' });
  const toPlugin = String(body.toPlugin || '');
  if (!toPlugin) throw httpErr(400, 'Hedef plugin gerekli');
  if (/[\\/]/.test(toPlugin) || toPlugin.startsWith('.')) throw httpErr(400, 'Geçersiz plugin adı');
  const tLib = target.cfg.libraryDir;
  const tDir = path.join(target.path, tLib, toPlugin);
  const dst = await fsp.stat(tDir).catch(() => null);
  if (!dst || !dst.isDirectory()) throw httpErr(404, 'Hedefte plugin bulunamadı: ' + toPlugin);

  const buf = await fsp.readFile(abs);
  let data = buf;
  const p = FM.parse(decode(buf));
  const alan = str(FM.meta(p).paket);
  const newSlug = FM.slug(toPlugin);
  if (cl.kind === 'paket' && alan && FM.slug(alan) === cl.paket && alan !== newSlug) {
    FM.set(p, 'paket', newSlug);
    data = FM.stringify(p);
  }
  // Hedefte benzersiz ad
  const baseName = path.posix.basename(rel);
  const ext = path.posix.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  let name = baseName; let n = 2;
  while (await exists(path.join(tDir, name))) name = stem + '-' + (n++) + ext;
  const toAbs = path.join(tDir, name);
  const toRel = tLib + '/' + toPlugin + '/' + name;

  const undo = new UndoStack();
  try {
    await atomicWrite(toAbs, data);
    undo.push(() => fsp.rm(toAbs, { force: true }));
    const trash = await toTrash(rel, abs);
    undo.clear();
    return { ok: true, from: { mp: st.activeMarketplace, path: rel }, to: { mp: toMp, path: toRel }, trash };
  } catch (e) {
    try { await undo.rollback(); } catch (agg) { throw httpErr(500, 'Taşıma başarısız ve geri alma tamamlanamadı: ' + e.message + '. Hedefteki ' + toRel + ' dosyasını kontrol et.'); }
    throw httpErr(500, 'Taşınamadı: ' + e.message + '. Yapılan değişiklikler geri alındı.');
  }
});

/* ---- git ---- */

route('GET', '/api/git/status', async () => gitService.status(root()));

route('POST', '/api/git/identity', async ({ body }) => {
  const name = String(body.name || '').trim(); const email = String(body.email || '').trim();
  if (!name || !email) throw httpErr(400, 'Ad ve e-posta gerekli');
  await gitService.setConfig(root(), 'user.name', name);
  await gitService.setConfig(root(), 'user.email', email);
  return { ok: true };
});

route('POST', '/api/git/commit', async ({ body }) => {
  const message = String(body.message || '').trim();
  if (!message) throw httpErr(400, 'Commit mesajı gerekli');
  const paths = (Array.isArray(body.paths) ? body.paths : []).map((p) => safePath(p).rel);
  if (!paths.length) throw httpErr(400, 'Commit için en az bir dosya seç');
  let head;
  try {
    head = await gitService.commitPaths(root(), message, paths);
  } catch (e) {
    if (e instanceof GitError && e.isIdentityError) {
      throw httpErr(400, 'Git, commit yazarını bilmiyor. Ad ve e-posta gir.', { needIdentity: true });
    }
    throw httpErr(400, e.message);
  }
  return { ok: true, commit: head };
});

route('GET', '/api/git/log', async ({ q }) => {
  const p = q.get('path');
  if (p) {
    const { rel } = safePath(p);
    return { commits: await gitService.log(root(), { path: rel, limit: 100, follow: true }) };
  }
  return { commits: await gitService.log(root(), { limit: 60 }) };
});

route('GET', '/api/git/show', async ({ q }) => {
  const hash = q.get('hash') || '';
  if (!HASH_RE.test(hash)) throw httpErr(400, 'Geçersiz commit');
  const { rel } = safePath(q.get('path'));
  let out;
  try { out = await gitService.showFile(root(), hash, rel); } catch (e) { throw httpErr(404, 'Bu sürümde dosya yok'); }
  return { raw: out };
});

route('GET', '/api/git/diff', async ({ q }) => {
  const p = q.get('path');
  const hash = q.get('hash') || '';
  const cap = (s) => (s.length > 300000 ? s.slice(0, 300000) + '\n… (kısaltıldı)' : s);
  if (q.get('working')) {
    const { rel } = safePath(p);
    const r = await gitService.diffWorking(root(), rel);
    return r.untracked ? r : { diff: cap(r.diff) };
  }
  if (!HASH_RE.test(hash)) throw httpErr(400, 'Geçersiz commit');
  if (p) {
    const { rel } = safePath(p);
    return { diff: cap(await gitService.showCommit(root(), hash, { path: rel })) };
  }
  return { diff: cap(await gitService.showCommit(root(), hash, { stat: true })) };
});

/* ---- uzak depo (yalnızca etkin marketplace; X-PP-MP korumalı) ---- */

route('GET', '/api/git/remotes', async () => remoteSync.status(root()));

route('POST', '/api/git/remotes', async ({ body }) => ({ ok: true, remote: await remoteSync.addRemote(root(), String(body.name || ''), body.url) }));

route('PUT', '/api/git/remotes', async ({ body }) => ({ ok: true, remote: await remoteSync.setRemote(root(), String(body.name || ''), body.url) }));

route('POST', '/api/git/push', async ({ body }) => {
  const res = await remoteSync.push(root(), { remote: body.remote });
  const s = await remoteSync.status(root());
  return { ...res, ahead: s.ahead, behind: s.behind, pendingTags: s.pendingTags };
});

route('POST', '/api/git/fetch', async ({ body }) => {
  const { config } = await configStore.load();
  return remoteSync.fetch(root(), { remote: body.remote, background: !!body.background, setting: config.remoteCheck });
});

route('POST', '/api/git/pull', async ({ body }) => remoteSync.pull(root(), { remote: body.remote }));

/* ---- geçmiş (yalnızca etkin marketplace; X-PP-MP korumalı) ---- */

route('GET', '/api/history/versions', async ({ q }) => {
  const { rel } = safePath(q.get('path'));
  const cfg = await loadConfig();
  try { return await history.timeline(root(), rel, { libraryDir: cfg.libraryDir }); } catch (e) { throw histErr(e); }
});

route('GET', '/api/history/compare', async ({ q }) => {
  const { rel } = safePath(q.get('path'));
  const cfg = await loadConfig();
  try { return await history.compare(root(), rel, q.get('a') || '', q.get('b') || '', { libraryDir: cfg.libraryDir }); } catch (e) { throw histErr(e); }
});

route('GET', '/api/history/show', async ({ q }) => {
  const { rel } = safePath(q.get('path'));
  const cfg = await loadConfig();
  try { return await history.show(root(), rel, q.get('tag') || '', { libraryDir: cfg.libraryDir }); } catch (e) { throw histErr(e); }
});

route('GET', '/api/history/changes', async ({ q }) => {
  const group = q.get('group') || 'file';
  if (group !== 'file' && group !== 'version') throw httpErr(400, 'Geçersiz gruplama');
  const mp = setup.current.activeMarketplace;
  const cfg = await loadConfig();
  try {
    if (group === 'version') {
      const currentPaths = (await index.listMd(root(), cfg.libraryDir, { includeBig: true })).map((i) => i.path);
      return { mp, ...(await history.versionsByPrompt(root(), { libraryDir: cfg.libraryDir, currentPaths })) };
    }
    const raw = q.get('limit');
    const limit = raw === null || raw === '' ? 300 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 3000) throw httpErr(400, 'Geçersiz limit');
    return { mp, ...(await history.changesByFile(root(), { limit, exists: (r) => exists(path.join(root(), r)) })) };
  } catch (e) { throw histErr(e); }
});

/* ---- sürüm ---- */

// Yalnızca libraryDir altındaki .md/.markdown dosyaları için.
async function promptPath(p) {
  const { abs, rel } = safePath(p);
  const cfg = await loadConfig();
  if (!/.(md|markdown)$/i.test(rel) || !rel.startsWith(cfg.libraryDir + '/')) {
    throw httpErr(400, 'Sürüm yalnızca prompt dosyaları için oluşturulur');
  }
  return { abs, rel, cfg };
}

route('GET', '/api/version', async ({ q }) => {
  const { abs, rel, cfg } = await promptPath(q.get('path'));
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw httpErr(404, 'Dosya bulunamadı');
  try { return await versions.info(root(), cfg.libraryDir, rel, abs); } catch (e) { throw vErr(e); }
});

route('POST', '/api/version/bump', async ({ body }) => {
  const { abs, rel, cfg } = await promptPath(body.path);
  try {
    return await versions.bump(root(), cfg.libraryDir, {
      rel, abs, level: body.level, note: String(body.note || ''),
      raw: typeof body.raw === 'string' ? body.raw : undefined, baseMtime: body.baseMtime
    });
  } catch (e) { throw vErr(e); }
});

/* ---- içe aktarma ---- */

route('POST', '/api/import/scan', async ({ body }) => {
  const dir = expandDir(body.dir);
  return { dir, files: await scanTxt(dir, !!body.recursive) };
});

route('POST', '/api/import/run', async ({ body }) => {
  const dir = expandDir(body.dir);
  if (!Array.isArray(body.files) || !body.files.length) throw httpErr(400, 'Dosya seçilmedi');
  return importFiles(dir, body.files, body.target || (await loadConfig()).libraryDir + '/gelen-kutusu');
});

/* ---- marketplace ---- */

route('GET', '/api/marketplace/status', async () => marketplaceStatus());

route('POST', '/api/marketplace/init', async ({ body }) => {
  const cfg = await loadConfig();
  const m = body.config || {};
  cfg.marketplace = {
    ...cfg.marketplace,
    name: FM.slug(m.name || cfg.marketplace.name),
    owner: String(m.owner != null ? m.owner : cfg.marketplace.owner).trim(),
    plugin: FM.slug(m.plugin || cfg.marketplace.plugin),
    description: String(m.description != null ? m.description : cfg.marketplace.description).trim(),
    version: String(m.version != null ? m.version : cfg.marketplace.version).trim()
  };
  const verErr = Rules.checkVersion(cfg.marketplace.version);
  if (verErr) throw httpErr(400, verErr, { field: 'version' });
  const nameErr = Rules.checkMarketplaceName(cfg.marketplace.name);
  if (nameErr) throw httpErr(400, nameErr, { field: 'name' });
  if (m.export !== undefined) {
    const ex = m.export || {};
    if (!Array.isArray(ex.durumlar) || !ex.durumlar.length) throw httpErr(400, 'En az bir durum seçilmeli', { field: 'export' });
    cfg.export = {
      durumlar: ex.durumlar.map((x) => String(x == null ? '' : x).trim()),
      haricKlasorler: Array.isArray(ex.haricKlasorler) ? ex.haricKlasorler.map((x) => String(x).trim()).filter(Boolean) : cfg.export.haricKlasorler
    };
  }
  await saveConfig(cfg);
  // plugin.json dosyalarına dokunulmaz; yalnızca marketplace.json üst alanları (ve katalog sürümü) yazılır.
  const undo = new UndoStack();
  await manifests.writeMarketplace(cfg, { version: cfg.marketplace.version }, undo);
  undo.clear();
  catalog.invalidate();
  return { ok: true, packages: (await manifests.listed()).map((l) => l.name) };
});

// Marketplace'i güncelle: tüm paketleri dışa aktarır, marketplace.json yazar. Sürüm artırmaz, tag atmaz, push etmez.
route('POST', '/api/marketplace/update', async () => publisher.updateAll(root()));

// Kullanımdan kalktı: arayüz paket yayını için /api/package/publish kullanır. Geriye uyum için korunur.
route('POST', '/api/marketplace/publish', async ({ body }) => {
  const cfg = await loadConfig();
  const plan = await publishPlan(cfg);
  const paths = (Array.isArray(body.paths) ? body.paths : []).map(String);
  const want = body.all ? plan.plans : plan.plans.filter((p) => paths.includes(p.source));
  const done = []; const failed = []; const skipped = [];
  if (body.all) {
    for (const x of plan.skipped) if (x.level === 'warn') skipped.push({ source: x.source, code: x.code, reason: x.reason });
  } else {
    for (const src of paths) {
      if (plan.bySource.has(src)) continue;
      const x = plan.bySkipped.get(src);
      skipped.push(x ? { source: src, code: x.code, reason: x.reason }
        : { source: src, code: 'kaynakYok', reason: 'Kaynak dosya bulunamadı veya prompt klasörünün dışında' });
    }
  }
  for (const p of want) {
    const err = p.issues.find((i) => i.level === 'error');
    if (err) { failed.push({ source: p.source, code: err.code, reason: err.msg }); continue; }
    if (body.all && p.state === 'guncel') continue;
    await atomicWrite(path.join(root(), p.target), p.expected, { mkdir: true });
    done.push(p.target);
  }
  const plan2 = await publishPlan(cfg);
  await marketplaceSync(cfg, plan2);
  return { ok: true, done, failed, skipped };
});

// Kullanımdan kalktı (bkz. yukarıdaki not).
route('POST', '/api/marketplace/unpublish', async ({ body }) => {
  const { abs, rel } = safePath(body.target);
  if (!/^plugins\//.test(rel)) throw httpErr(400, 'Yalnızca plugins/ altı kaldırılabilir');
  if (!(await exists(abs))) throw httpErr(404, 'Dosya yok');
  const trash = await toTrash(rel, abs);
  if (path.basename(rel) === 'SKILL.md') {
    // boş skill klasörünü temizle
    try { await fsp.rmdir(path.dirname(abs)); } catch (e) { /* dolu */ }
  }
  const cfg = await loadConfig();
  await marketplaceSync(cfg, await publishPlan(cfg));
  return { ok: true, trash };
});

/* ----------------------------------------------------------------- HTTP sunucusu */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function send(res, status, data, headers) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': typeof data === 'string' || Buffer.isBuffer(data) ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(headers || {})
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = []; let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > 8000000) throw httpErr(413, 'İstek çok büyük');
    chunks.push(c);
  }
  if (!n) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { throw httpErr(400, 'Geçersiz JSON'); }
}

const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

const server = http.createServer(async (req, res) => {
  try {
    const host = String(req.headers.host || '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return send(res, 403, { error: 'Geçersiz host' });
    const url = new URL(req.url, 'http://' + host);

    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') {
        if (req.headers['x-pp'] !== '1') return send(res, 403, { error: 'Eksik istek başlığı' });
        const origin = req.headers.origin;
        if (origin) {
          let oh = '';
          try { oh = new URL(origin).host.toLowerCase(); } catch (e) { /* geçersiz */ }
          if (oh !== host) return send(res, 403, { error: 'Geçersiz kaynak' });
        }
      }
      const entry = routes.get(req.method + ' ' + url.pathname);
      if (!entry) return send(res, 404, { error: 'Bulunamadı' });
      if (!entry.open) {
        const st = await setup.refreshIfStale();
        if (!st.ok) throw setupRequired(st);
        // Çok sekme koruması: arayüz etkin marketplace adını bildirir; değiştiyse yanlış depoya yazılmaz.
        const want = req.headers['x-pp-mp'];
        if (want !== undefined) {
          let name = '';
          try { name = decodeURIComponent(String(want)); } catch (e) { /* geçersiz kodlama: uyuşmaz */ }
          if (name !== st.activeMarketplace) {
            throw httpErr(409, 'Etkin marketplace değişti (şu an: ' + st.activeMarketplace + "). Ağaçtan yeniden seç.", { code: 'etkinDegil', active: st.activeMarketplace });
          }
        }
      }
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      return send(res, 200, await entry.fn({ q: url.searchParams, body, req }));
    }

    if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['index.html', 'fm.js', 'rules.js'].includes(name)) return send(res, 404, 'Bulunamadı');
    let data;
    try { data = await fsp.readFile(path.join(PUBLIC, name)); } catch (e) { return send(res, 404, 'Bulunamadı: ' + name); }
    return send(res, 200, data, { 'Content-Type': MIME[path.extname(name)] || 'text/plain', 'Content-Security-Policy': CSP });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    send(res, status, { error: e.message || 'Hata', ...(e.data || {}) });
  }
});

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch (e) { /* tarayıcıyı elle aç */ }
}

function listen(port, tries) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && tries > 0) return listen(port + 1, tries - 1);
    console.error('Sunucu başlatılamadı:', err.message);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const url = `http://localhost:${port}`;
    const st = setup.current;
    console.log('Prompt Havuzu çalışıyor: ' + url);
    console.log('Ayar dosyası: ' + configStore.file);
    if (st.ok) console.log('Kurulum hazır. Etkin marketplace: ' + st.root);
    else console.log('Kurulum eksik: ' + ((st.issues.find((i) => i.level === 'error') || {}).message || 'bilinmeyen sorun'));
    console.log('Durdurmak için Ctrl+C');
    if (ARGS.open) openBrowser(url);
  });
}

process.on('unhandledRejection', (e) => console.error('Beklenmeyen hata:', e));

if ('root' in ARGS) console.warn('Uyarı: --root artık desteklenmiyor. Library kökünü arayüzdeki Ayarlar bölümünden seç.');

// Kök değişince arama önbelleği (köke göreli yollar) geçersiz olur.
// Kök (library) değişince tüm dizin ve sürüm önbellekleri geçersiz olur. Etkin marketplace değişince
// temizlenmez: önbellekler marketplace klasörüne göre ayrılmıştır.
setup.onLibraryChange(() => { index.clear(); versions.clearCache(); catalog.invalidate(); history.clear(); });
setup.evaluate().then(() => listen(PORT, 10));
