#!/usr/bin/env node
/* Prompt Havuzu: yerel arayüz sunucusu.
 * Bağımlılık yok (yalnızca Node.js >= 18). Yalnızca 127.0.0.1 üzerinde dinler.
 *
 * Kullanım:  node tools/ui/server.js [--root <havuz klasörü>] [--port 4317] [--open]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const FM = require('./public/fm.js');

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
const ROOT = path.resolve(ARGS.root || process.env.PROMPT_ROOT || path.join(__dirname, '..', '..'));
const PORT = Number(ARGS.port || process.env.PORT || 4317);
const HOST = '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const CONFIG_FILE = path.join(ROOT, 'pp.config.json');
const IGNORE = new Set(['.git', 'node_modules', '.pp', 'tools']);
const EDITABLE = new Set(['.md', '.markdown', '.txt', '.json', '.yml', '.yaml']);

const DEFAULTS = {
  libraryDir: 'library',
  marketplace: { name: 'prompt-havuzu', owner: '', plugin: 'benim-promptlarim', description: 'Kişisel prompt havuzu', version: '' },
  packages: {}
};

const str = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));
const toList = (v) => (Array.isArray(v) ? v : String(v == null ? '' : v).split(','))
  .map((s) => String(s).trim()).filter(Boolean);

function httpErr(status, message, data) {
  const e = new Error(message);
  e.status = status;
  if (data) e.data = data;
  return e;
}

async function loadConfig() {
  let c = {};
  try { c = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8')); } catch (e) { /* yok: varsayılanlar */ }
  return {
    ...DEFAULTS, ...c,
    marketplace: { ...DEFAULTS.marketplace, ...(c.marketplace || {}) },
    packages: { ...(c.packages || {}) }
  };
}

async function saveConfig(c) {
  await atomicWrite(CONFIG_FILE, JSON.stringify(c, null, 2) + '\n');
}

/* --------------------------------------------------------------- dosya araçları */

function safePath(rel) {
  if (typeof rel !== 'string' || rel === '') throw httpErr(400, 'Yol gerekli');
  const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(ROOT, norm);
  const back = path.relative(ROOT, abs);
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
  const dest = path.join(ROOT, '.pp', 'trash', ts, rel);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rename(abs, dest);
  return path.relative(ROOT, dest).split(path.sep).join('/');
}

async function uniquePath(rel) {
  const ext = path.posix.extname(rel);
  const stem = rel.slice(0, rel.length - ext.length);
  let cand = rel; let n = 2;
  while (await exists(path.join(ROOT, cand))) cand = stem + '-' + (n++) + ext;
  return cand;
}

/* ------------------------------------------------------------------ dizin (arama) */

const cache = new Map();

async function indexFile(rel, abs) {
  const st = await fsp.stat(abs);
  const c = cache.get(rel);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c;
  const ext = path.extname(rel).toLowerCase();
  const isMd = ext === '.md' || ext === '.markdown';
  const item = { path: rel, mtimeMs: st.mtimeMs, size: st.size, isMd };
  if (isMd && st.size < 2000000) {
    const p = FM.parse(decode(await fsp.readFile(abs)));
    const m = FM.meta(p);
    item.meta = m;
    item.body = p.body;
    item.title = str(m.baslik) || path.basename(rel, ext);
    item.tags = toList(m.etiketler);
    item.fTitle = FM.fold(item.title);
    item.fTags = item.tags.map(FM.fold);
    item.fPath = FM.fold(rel);
    item.fBody = FM.fold(p.body);
  } else if (isMd) {
    item.isMd = false;
  }
  cache.set(rel, item);
  return item;
}

async function listMd(relDir) {
  const out = [];
  async function rec(abs, rel) {
    let ents;
    try { ents = await fsp.readdir(abs, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (IGNORE.has(e.name)) continue;
      const r = rel + '/' + e.name;
      const a = path.join(abs, e.name);
      if (e.isDirectory()) await rec(a, r);
      else if (/\.(md|markdown)$/i.test(e.name)) {
        const it = await indexFile(r, a);
        if (it && it.isMd) out.push(it);
      }
    }
  }
  await rec(path.join(ROOT, relDir), relDir);
  return out;
}

async function listDirs(relDir) {
  const out = [relDir];
  async function rec(abs, rel) {
    let ents;
    try { ents = await fsp.readdir(abs, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (!e.isDirectory() || IGNORE.has(e.name)) continue;
      out.push(rel + '/' + e.name);
      await rec(path.join(abs, e.name), rel + '/' + e.name);
    }
  }
  await rec(path.join(ROOT, relDir), relDir);
  return out.sort((a, b) => a.localeCompare(b, 'tr'));
}

async function buildTree(abs, rel) {
  let ents;
  try { ents = await fsp.readdir(abs, { withFileTypes: true }); } catch (e) { return []; }
  ents.sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name, 'tr'));
  const out = [];
  for (const e of ents) {
    if (IGNORE.has(e.name)) continue;
    const childRel = rel ? rel + '/' + e.name : e.name;
    const childAbs = path.join(abs, e.name);
    if (e.isDirectory()) {
      out.push({ type: 'dir', name: e.name, path: childRel, children: await buildTree(childAbs, childRel) });
    } else if (EDITABLE.has(path.extname(e.name).toLowerCase())) {
      const n = { type: 'file', name: e.name, path: childRel };
      try {
        const it = await indexFile(childRel, childAbs);
        if (it && it.isMd) n.meta = { baslik: str(it.meta.baslik), durum: str(it.meta.durum), tur: normTur(it.meta.tur) };
      } catch (err) { /* okunamayan dosya: yalnızca ad */ }
      out.push(n);
    }
  }
  return out;
}

async function search(q, o) {
  const cfg = await loadConfig();
  let items = await listMd(cfg.libraryDir);
  if (o.scope === 'all') items = items.concat(await listMd('plugins'));
  const tokens = FM.fold(q || '').split(/\s+/).filter(Boolean);
  const tagFilter = toList(o.tags || '').map(FM.fold);
  const res = [];
  for (const it of items) {
    const m = it.meta;
    if (tagFilter.length && !tagFilter.every((t) => it.fTags.includes(t))) continue;
    if (o.durum && FM.fold(str(m.durum)) !== FM.fold(o.durum)) continue;
    if (o.tur) {
      const t = normTur(m.tur);
      if (o.tur === 'yok' ? t !== '' : t !== o.tur) continue;
    }
    let score = 0; let ok = true; let hit = -1;
    for (const t of tokens) {
      let s = 0;
      if (it.fTitle.includes(t)) s += 10;
      if (it.fTags.some((x) => x === t)) s += 8;
      else if (it.fTags.some((x) => x.includes(t))) s += 4;
      if (it.fPath.includes(t)) s += 3;
      const bi = it.fBody.indexOf(t);
      if (bi >= 0) { s += 1; if (hit < 0) hit = bi; }
      if (s === 0) { ok = false; break; }
      score += s;
    }
    if (!ok) continue;
    let snippet;
    if (hit >= 0 && !tokens.some((t) => it.fTitle.includes(t) && it.fBody.indexOf(t) < 0)) {
      const a = Math.max(0, hit - 50);
      snippet = (a > 0 ? '…' : '') + it.body.slice(a, hit + 140).replace(/\s+/g, ' ').trim();
    } else {
      snippet = it.body.replace(/\s+/g, ' ').trim().slice(0, 140);
    }
    res.push({
      path: it.path, baslik: it.title, etiketler: it.tags, durum: str(m.durum), tur: normTur(m.tur),
      versiyon: str(m.versiyon), score, snippet, mtime: Math.round(it.mtimeMs)
    });
  }
  res.sort((a, b) => (tokens.length ? b.score - a.score : 0) || b.mtime - a.mtime);
  return res.slice(0, 300);
}

async function facets() {
  const cfg = await loadConfig();
  const items = await listMd(cfg.libraryDir);
  const tags = {}; const durum = {}; const tur = {}; const projeler = {}; const paket = new Set();
  for (const it of items) {
    it.tags.forEach((t) => { tags[t] = (tags[t] || 0) + 1; });
    const d = str(it.meta.durum); if (d) durum[d] = (durum[d] || 0) + 1;
    const t = normTur(it.meta.tur); if (t) tur[t] = (tur[t] || 0) + 1;
    toList(it.meta.projeler).forEach((p) => { projeler[p] = (projeler[p] || 0) + 1; });
    if (it.meta.paket) paket.add(str(it.meta.paket));
  }
  const arr = (o) => Object.keys(o).map((k) => ({ name: k, count: o[k] }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'tr'));
  return {
    total: items.length, tags: arr(tags), durum: arr(durum), tur: arr(tur), projeler: arr(projeler),
    pakets: Array.from(paket).sort(), folders: await listDirs(cfg.libraryDir)
  };
}

/* ------------------------------------------------------------------------- git */

function git(args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: ROOT, maxBuffer: 50 * 1024 * 1024, windowsHide: true, encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
    }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ENOENT') return reject(httpErr(500, 'git bulunamadı. Git kurulu ve PATH içinde olmalı.'));
      const e = new Error((stderr || err.message || '').trim());
      e.stderr = stderr || '';
      reject(e);
    });
  });
}

const isRepo = () => fs.existsSync(path.join(ROOT, '.git'));
function needRepo() { if (!isRepo()) throw httpErr(400, 'Bu klasör henüz bir git deposu değil. Git panelinden başlat.'); }
const HASH_RE = /^[0-9a-f]{7,40}$/;

async function hasCommits() { try { await git(['rev-parse', '--verify', 'HEAD']); return true; } catch (e) { return false; } }

function statusCode(x, y) {
  if (x === '?') return '?';
  if (x === 'D' || y === 'D') return 'D';
  if (x === 'A') return 'A';
  if (x === 'R' || x === 'C') return 'R';
  return 'M';
}

async function gitStatus() {
  if (!isRepo()) return { isRepo: false };
  let branch = 'main';
  try { branch = (await git(['symbolic-ref', '--short', 'HEAD'])).trim(); } catch (e) { /* ayrık HEAD */ }
  const out = await git(['status', '--porcelain=v1', '-z', '-uall']);
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const x = p[0]; const y = p[1];
    if (x === 'R' || x === 'C') i++;
    files.push({ x, y, path: p.slice(3), code: statusCode(x, y) });
  }
  let name = ''; let email = '';
  try { name = (await git(['config', 'user.name'])).trim(); } catch (e) { /* tanımsız */ }
  try { email = (await git(['config', 'user.email'])).trim(); } catch (e) { /* tanımsız */ }
  return { isRepo: true, branch, files, hasCommits: await hasCommits(), identity: { name, email } };
}

async function parseLog(args) {
  let out;
  try { out = await git(args); } catch (e) {
    if (/does not have any commits|bad default revision|unknown revision/i.test(e.message)) return [];
    throw e;
  }
  const commits = [];
  for (const chunk of out.split('\x1e')) {
    if (!chunk.trim()) continue;
    const nl = chunk.indexOf('\n');
    const head = (nl < 0 ? chunk : chunk.slice(0, nl)).split('\x1f');
    const names = nl < 0 ? [] : chunk.slice(nl + 1).split('\n').map((s) => s.trim()).filter(Boolean);
    commits.push({ hash: head[0], short: head[1], author: head[2], date: head[3], subject: head[4], path: names[0] || null });
  }
  return commits;
}

/* ------------------------------------------------------------------ marketplace */

const TUR_DIR = { komut: 'commands', ajan: 'agents', skill: 'skills' };

function normTur(v) {
  const t = FM.fold(str(v)).trim();
  if (['komut', 'command', 'slash'].includes(t)) return 'komut';
  if (['ajan', 'agent', 'subagent'].includes(t)) return 'ajan';
  if (['skill', 'beceri'].includes(t)) return 'skill';
  return '';
}

function targetFor(tur, paket, ad) {
  return tur === 'skill' ? `plugins/${paket}/skills/${ad}/SKILL.md` : `plugins/${paket}/${TUR_DIR[tur]}/${ad}.md`;
}

function renderTarget(it, tur, ad) {
  const m = it.meta;
  const desc = str(m.aciklama) || it.title || ad;
  const fm = [];
  if (tur === 'komut') {
    fm.push(['description', desc]);
    if (m.arguman_ipucu) fm.push(['argument-hint', str(m.arguman_ipucu)]);
    if (m.izinli_araclar) fm.push(['allowed-tools', str(m.izinli_araclar)]);
    if (m.model) fm.push(['model', str(m.model)]);
  } else if (tur === 'ajan') {
    fm.push(['name', ad], ['description', desc]);
    if (m.izinli_araclar) fm.push(['tools', str(m.izinli_araclar)]);
    if (m.model) fm.push(['model', str(m.model)]);
  } else {
    fm.push(['name', ad], ['description', desc]);
    if (m.izinli_araclar) fm.push(['allowed-tools', str(m.izinli_araclar)]);
  }
  const head = fm.map(([k, v]) => `${k}: ${FM.fmtScalar(v)}`).join('\n');
  return `---\n${head}\n---\n${it.body.replace(/^\n+/, '').replace(/\s+$/, '')}\n`;
}

async function scanPluginFiles() {
  const out = [];
  let pk;
  try { pk = await fsp.readdir(path.join(ROOT, 'plugins'), { withFileTypes: true }); } catch (e) { return out; }
  for (const d of pk) {
    if (!d.isDirectory()) continue;
    for (const kind of ['commands', 'agents']) {
      let fl = [];
      try { fl = await fsp.readdir(path.join(ROOT, 'plugins', d.name, kind)); } catch (e) { /* yok */ }
      for (const f of fl) if (/\.md$/i.test(f)) out.push({ target: `plugins/${d.name}/${kind}/${f}`, paket: d.name });
    }
    let sk = [];
    try { sk = await fsp.readdir(path.join(ROOT, 'plugins', d.name, 'skills'), { withFileTypes: true }); } catch (e) { /* yok */ }
    for (const s of sk) {
      if (s.isDirectory() && await exists(path.join(ROOT, 'plugins', d.name, 'skills', s.name, 'SKILL.md'))) {
        out.push({ target: `plugins/${d.name}/skills/${s.name}/SKILL.md`, paket: d.name });
      }
    }
  }
  return out;
}

async function publishPlan(cfg) {
  const items = await listMd(cfg.libraryDir);
  const plans = [];
  for (const it of items) {
    const m = it.meta;
    const tur = normTur(m.tur);
    if (!tur) continue;
    const paket = FM.slug(str(m.paket) || cfg.marketplace.plugin);
    const ad = FM.slug(str(m.komut_adi) || path.basename(it.path, path.extname(it.path)));
    const target = targetFor(tur, paket, ad);
    const expected = renderTarget(it, tur, ad);
    const cur = await readIfExists(path.join(ROOT, target));
    const state = cur === null ? 'yok' : (cur.replace(/\r\n/g, '\n') === expected ? 'guncel' : 'eski');
    const issues = [];
    if (!it.body.trim()) issues.push({ level: 'error', msg: 'İçerik boş' });
    if (!str(m.aciklama)) {
      issues.push({
        level: tur === 'komut' ? 'info' : 'warn',
        msg: tur === 'komut' ? 'Açıklama boş, başlık kullanılacak' : 'Açıklama boş. Claude, bu ' + (tur === 'ajan' ? 'ajanı' : 'skill\'i') + ' ne zaman kullanacağını açıklamadan seçer'
      });
    }
    plans.push({ source: it.path, baslik: it.title, tur, paket, ad, target, expected, state, issues });
  }
  const byTarget = new Map();
  for (const p of plans) {
    if (!byTarget.has(p.target)) byTarget.set(p.target, []);
    byTarget.get(p.target).push(p);
  }
  for (const [t, list] of byTarget) {
    if (list.length > 1) {
      for (const p of list) p.issues.push({ level: 'error', msg: 'Aynı hedef dosya birden fazla prompt tarafından kullanılıyor: ' + t });
    }
  }
  const expectedTargets = new Set(plans.map((p) => p.target));
  const orphans = (await scanPluginFiles()).filter((f) => !expectedTargets.has(f.target));
  const bySource = new Map(plans.map((p) => [p.source, p]));
  const byTargetFirst = new Map(plans.map((p) => [p.target, p]));
  return { plans, orphans, bySource, byTarget: byTargetFirst };
}

function defaultOwner(cfg) { return cfg.marketplace.owner || (() => { try { return os.userInfo().username; } catch (e) { return 'ben'; } })(); }

async function readJson(abs) { try { return JSON.parse(await fsp.readFile(abs, 'utf8')); } catch (e) { return {}; } }

async function writePluginJson(paket, cfg) {
  const file = path.join(ROOT, 'plugins', paket, '.claude-plugin', 'plugin.json');
  const cur = await readJson(file);
  const next = { ...cur, name: paket };
  next.description = cur.description || (cfg.packages[paket] && cfg.packages[paket].description) || `${paket}: ${cfg.marketplace.description}`;
  next.author = cur.author || { name: defaultOwner(cfg) };
  if (cfg.marketplace.version) next.version = cfg.marketplace.version;
  await atomicWrite(file, JSON.stringify(next, null, 2) + '\n', { mkdir: true });
}

async function writeMarketplace(cfg, packages) {
  const file = path.join(ROOT, '.claude-plugin', 'marketplace.json');
  const cur = await readJson(file);
  const mk = cfg.marketplace;
  const next = {
    ...cur,
    name: FM.slug(mk.name),
    description: mk.description,
    owner: { ...(cur.owner || {}), name: defaultOwner(cfg) }
  };
  const prev = new Map((cur.plugins || []).map((p) => [p.name, p]));
  const own = [];
  for (const name of packages) {
    const pj = await readJson(path.join(ROOT, 'plugins', name, '.claude-plugin', 'plugin.json'));
    own.push({ ...(prev.get(name) || {}), name, source: './plugins/' + name, description: pj.description || `${name}: ${mk.description}` });
  }
  const external = (cur.plugins || []).filter((p) => !(typeof p.source === 'string' && p.source.startsWith('./plugins/')));
  next.plugins = own.concat(external);
  await atomicWrite(file, JSON.stringify(next, null, 2) + '\n', { mkdir: true });
}

async function marketplaceSync(cfg, plan) {
  const packages = Array.from(new Set(plan.plans.map((p) => p.paket).concat(plan.orphans.map((o) => o.paket))));
  if (!packages.length) packages.push(FM.slug(cfg.marketplace.plugin));
  for (const pk of packages) await writePluginJson(pk, cfg);
  await writeMarketplace(cfg, packages);
  const readme = path.join(ROOT, 'plugins', 'README.md');
  if (!(await exists(readme))) {
    await atomicWrite(readme, '# plugins\n\nBu klasördeki komut, ajan ve skill dosyaları `library/` içindeki promptlardan otomatik üretilir.\nDüzenlemeyi kaynakta yap, sonra arayüzden yayınla. Burada yapılan değişiklikler bir sonraki yayında ezilir.\n', { mkdir: true });
  }
  return packages;
}

function quoteArg(p) { return /\s/.test(p) ? `"${p}"` : p; }

async function marketplaceStatus() {
  const cfg = await loadConfig();
  const plan = await publishPlan(cfg);
  const mkFile = path.join(ROOT, '.claude-plugin', 'marketplace.json');
  const mkJson = await exists(mkFile) ? await readJson(mkFile) : null;
  const mkName = FM.slug(cfg.marketplace.name);
  const packages = Array.from(new Set(plan.plans.map((p) => p.paket)));
  if (!packages.length) packages.push(FM.slug(cfg.marketplace.plugin));
  return {
    config: cfg.marketplace,
    root: ROOT,
    marketplaceName: mkName,
    marketplaceExists: !!mkJson,
    marketplacePlugins: mkJson ? (mkJson.plugins || []).map((p) => p.name) : [],
    items: plan.plans.map(({ expected, ...rest }) => rest),
    orphans: plan.orphans,
    packages,
    commands: {
      validate: `claude plugin validate ${quoteArg(ROOT)}`,
      add: `claude plugin marketplace add ${quoteArg(ROOT)}`,
      addInSession: `/plugin marketplace add ${quoteArg(ROOT)}`,
      update: `claude plugin marketplace update ${mkName}`,
      install: packages.map((p) => ({ plugin: p, cmd: `claude plugin install ${p}@${mkName}`, inSession: `/plugin install ${p}@${mkName}` }))
    }
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
    FM.set(p, 'versiyon', '1');
    FM.set(p, 'olusturma', st.mtime.toISOString().slice(0, 10));
    p.body = '\n' + text + '\n';
    const rel = await uniquePath(target.rel + '/' + FM.slug(base.replace(/\.[^.]+$/, '')) + '.md');
    await atomicWrite(path.join(ROOT, rel), FM.stringify(p), { mkdir: true });
    created.push({ from: abs, to: rel });
  }
  return { created, skipped };
}

/* -------------------------------------------------------------------- yönlendirme */

const routes = new Map();
const route = (method, p, fn) => routes.set(method + ' ' + p, fn);

route('GET', '/api/info', async () => {
  const cfg = await loadConfig();
  let gitOk = true;
  try { await git(['--version']); } catch (e) { gitOk = false; }
  return { root: ROOT, platform: process.platform, node: process.version, config: cfg, isRepo: isRepo(), gitAvailable: gitOk };
});

route('GET', '/api/tree', async () => {
  const cfg = await loadConfig();
  await fsp.mkdir(path.join(ROOT, cfg.libraryDir), { recursive: true });
  return { libraryDir: cfg.libraryDir, tree: await buildTree(ROOT, '') };
});

route('GET', '/api/facets', async () => facets());

route('GET', '/api/search', async ({ q }) => ({
  results: await search(q.get('q') || '', {
    tags: q.get('tags') || '', durum: q.get('durum') || '', tur: q.get('tur') || '', scope: q.get('scope') || 'library'
  })
}));

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
  return {
    path: rel, raw, mtime: Math.round(st.mtimeMs), isPrompt, isMd,
    generatedFrom: gen ? gen.source : null,
    publish: pub ? { target: pub.target, state: pub.state, paket: pub.paket, ad: pub.ad, tur: pub.tur } : null
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
  return { ok: true, path: rel, mtime: Math.round(ns.mtimeMs) };
});

route('POST', '/api/file', async ({ body }) => {
  let { rel } = safePath(body.path);
  if (!isEditable(rel)) throw httpErr(400, 'Bu dosya türü oluşturulamaz');
  if (body.unique) rel = await uniquePath(rel);
  else if (await exists(path.join(ROOT, rel))) throw httpErr(409, 'Bu adda bir dosya zaten var');
  await atomicWrite(path.join(ROOT, rel), String(body.raw || ''), { mkdir: true });
  const st = await fsp.stat(path.join(ROOT, rel));
  return { ok: true, path: rel, mtime: Math.round(st.mtimeMs) };
});

route('DELETE', '/api/file', async ({ q }) => {
  const { abs, rel } = safePath(q.get('path'));
  if (!(await exists(abs))) throw httpErr(404, 'Bulunamadı');
  return { ok: true, trash: await toTrash(rel, abs) };
});

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

/* ---- git ---- */

route('GET', '/api/git/status', async () => gitStatus());

route('POST', '/api/git/init', async () => {
  if (isRepo()) throw httpErr(409, 'Zaten bir git deposu');
  await git(['init']);
  try { await git(['symbolic-ref', 'HEAD', 'refs/heads/main']); } catch (e) { /* eski git */ }
  const gi = path.join(ROOT, '.gitignore');
  if (!(await exists(gi))) await atomicWrite(gi, '.pp/\nnode_modules/\n*.pp-tmp\n');
  const ga = path.join(ROOT, '.gitattributes');
  if (!(await exists(ga))) await atomicWrite(ga, '*.md text eol=lf\n*.json text eol=lf\n');
  return { ok: true };
});

route('POST', '/api/git/identity', async ({ body }) => {
  needRepo();
  const name = String(body.name || '').trim(); const email = String(body.email || '').trim();
  if (!name || !email) throw httpErr(400, 'Ad ve e-posta gerekli');
  await git(['config', 'user.name', name]);
  await git(['config', 'user.email', email]);
  return { ok: true };
});

route('POST', '/api/git/commit', async ({ body }) => {
  needRepo();
  const message = String(body.message || '').trim();
  if (!message) throw httpErr(400, 'Commit mesajı gerekli');
  const paths = (Array.isArray(body.paths) ? body.paths : []).map((p) => safePath(p).rel);
  if (!paths.length) throw httpErr(400, 'Commit için en az bir dosya seç');
  try {
    await git(['add', '-A', '--', ...paths]);
    await git(['commit', '-m', message, '--', ...paths]);
  } catch (e) {
    if (/Author identity unknown|tell me who you are|empty ident/i.test(e.message)) {
      throw httpErr(400, 'Git, commit yazarını bilmiyor. Ad ve e-posta gir.', { needIdentity: true });
    }
    throw httpErr(400, e.message);
  }
  const head = (await git(['rev-parse', '--short', 'HEAD'])).trim();
  return { ok: true, commit: head };
});

route('GET', '/api/git/log', async ({ q }) => {
  needRepo();
  const fmt = '--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s';
  const p = q.get('path');
  if (p) {
    const { rel } = safePath(p);
    return { commits: await parseLog(['log', '--follow', '--name-only', '-n', '100', fmt, '--', rel]) };
  }
  return { commits: await parseLog(['log', '-n', '60', fmt]) };
});

route('GET', '/api/git/show', async ({ q }) => {
  needRepo();
  const hash = q.get('hash') || '';
  if (!HASH_RE.test(hash)) throw httpErr(400, 'Geçersiz commit');
  const { rel } = safePath(q.get('path'));
  let out;
  try { out = await git(['show', hash + ':' + rel]); } catch (e) { throw httpErr(404, 'Bu sürümde dosya yok'); }
  return { raw: out };
});

route('GET', '/api/git/diff', async ({ q }) => {
  needRepo();
  const p = q.get('path');
  const hash = q.get('hash') || '';
  const cap = (s) => (s.length > 300000 ? s.slice(0, 300000) + '\n… (kısaltıldı)' : s);
  if (q.get('working')) {
    const { rel } = safePath(p);
    let tracked = true;
    try { await git(['ls-files', '--error-unmatch', '--', rel]); } catch (e) { tracked = false; }
    if (!tracked) return { diff: '', untracked: true };
    let d = '';
    try { d = await git(['diff', '--no-color', 'HEAD', '--', rel]); } catch (e) { /* henüz commit yok */ }
    return { diff: cap(d) };
  }
  if (!HASH_RE.test(hash)) throw httpErr(400, 'Geçersiz commit');
  if (p) {
    const { rel } = safePath(p);
    return { diff: cap(await git(['show', '--no-color', '--format=', hash, '--', rel])) };
  }
  return { diff: cap(await git(['show', '--no-color', '--stat', '-p', '--format=%s%n%an, %aI%n', hash])) };
});

/* ---- içe aktarma ---- */

route('POST', '/api/import/scan', async ({ body }) => {
  const dir = expandDir(body.dir);
  return { dir, files: await scanTxt(dir, !!body.recursive) };
});

route('POST', '/api/import/run', async ({ body }) => {
  const dir = expandDir(body.dir);
  if (!Array.isArray(body.files) || !body.files.length) throw httpErr(400, 'Dosya seçilmedi');
  return importFiles(dir, body.files, body.target || 'library/gelen-kutusu');
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
  await saveConfig(cfg);
  const plan = await publishPlan(cfg);
  const packages = await marketplaceSync(cfg, plan);
  return { ok: true, packages };
});

route('POST', '/api/marketplace/publish', async ({ body }) => {
  const cfg = await loadConfig();
  const plan = await publishPlan(cfg);
  const want = body.all ? plan.plans : plan.plans.filter((p) => (body.paths || []).includes(p.source));
  const done = []; const failed = [];
  for (const p of want) {
    if (p.issues.some((i) => i.level === 'error')) { failed.push({ source: p.source, reason: p.issues.find((i) => i.level === 'error').msg }); continue; }
    if (body.all && p.state === 'guncel') continue;
    await atomicWrite(path.join(ROOT, p.target), p.expected, { mkdir: true });
    done.push(p.target);
  }
  const plan2 = await publishPlan(cfg);
  await marketplaceSync(cfg, plan2);
  return { ok: true, done, failed };
});

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
      const fn = routes.get(req.method + ' ' + url.pathname);
      if (!fn) return send(res, 404, { error: 'Bulunamadı' });
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      return send(res, 200, await fn({ q: url.searchParams, body, req }));
    }

    if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['index.html', 'fm.js'].includes(name)) return send(res, 404, 'Bulunamadı');
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
    console.log('Prompt Havuzu çalışıyor: ' + url);
    console.log('Havuz klasörü: ' + ROOT);
    console.log('Durdurmak için Ctrl+C');
    if (ARGS.open) openBrowser(url);
  });
}

process.on('unhandledRejection', (e) => console.error('Beklenmeyen hata:', e));

fsp.mkdir(ROOT, { recursive: true }).then(() => listen(PORT, 10));
