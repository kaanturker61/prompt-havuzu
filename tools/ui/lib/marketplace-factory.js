'use strict';
/* Yeni marketplace deposu oluşturur veya var olan klasörde git başlatır. Hata olursa geri alır. */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const FM = require('../public/fm.js');
const Rules = require('../public/rules.js');
const { UndoStack } = require('./undo');
const { describeNetError } = require('./net-errors');

function fail(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

async function exists(p) { try { await fsp.lstat(p); return true; } catch (e) { return false; } }

async function defaultAtomicWrite(abs, data) {
  const tmp = path.join(path.dirname(abs), '.' + path.basename(abs) + '.pp-tmp');
  await fsp.writeFile(tmp, data, 'utf8');
  await fsp.rename(tmp, abs);
}

function osUser() { try { return os.userInfo().username; } catch (e) { return 'ben'; } }

class MarketplaceFactory {
  constructor({ git, templates, atomicWrite = defaultAtomicWrite }) {
    this.git = git;
    this.t = templates;
    this.atomicWrite = atomicWrite;
  }

  static validateName(raw) {
    // FM.slug boş girdide 'adsiz' döndürür; harf/rakam içermeyen adları burada reddet.
    if (!/[\p{L}\p{N}]/u.test(String(raw || ''))) throw fail(400, 'Geçersiz marketplace adı');
    const name = FM.slug(String(raw));
    if (!name) throw fail(400, 'Geçersiz marketplace adı');
    const bad = Rules.checkMarketplaceName(name);
    if (bad) throw fail(400, bad);
    return name;
  }

  _files(meta) {
    return [
      ['.gitignore', this.t.GITIGNORE],
      ['.gitattributes', this.t.GITATTRIBUTES],
      ['.claude-plugin/marketplace.json', this.t.marketplaceJson(meta)],
      ['pp.config.json', this.t.ppConfig(meta)],
      ['prompts/.gitkeep', ''],
      ['README.md', this.t.readme(meta.name)]
    ];
  }

  _meta(slug, { description, owner }) {
    return {
      name: slug,
      description: String(description || '').trim() || `Prompt havuzu: ${slug}`,
      owner: String(owner || '').trim() || osUser()
    };
  }

  // Yeni klasör: git init + iskelet. Commit atılmaz.
  async create(libraryRoot, { name, description, owner } = {}) {
    const slug = MarketplaceFactory.validateName(name);
    const dir = path.join(libraryRoot, slug);
    const meta = this._meta(slug, { description, owner });
    const undo = new UndoStack();
    try {
      try { await fsp.mkdir(dir); } catch (e) {
        if (e.code === 'EEXIST') throw fail(409, 'Bu adda bir klasör zaten var: ' + slug);
        throw e;
      }
      // Klasörü yalnızca biz oluşturduğumuz için tamamen silebiliriz.
      undo.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 }));
      await this._scaffold(dir, meta, undo);
    } catch (e) {
      if (e.status === 409) throw e;
      await undo.rollback().catch(() => {});
      throw fail(500, `Marketplace oluşturulamadı: ${e.message}. Yapılan değişiklikler geri alındı.`);
    }
    return { name: slug, dir };
  }

  // Uzak depodan klonlar (GitHub/GitLab/yerel yol). Klasörü yalnızca clone oluşturur; hata olursa silinir.
  // Dönüş: { name, dir, url, warnings: [{ code, message }] }. Hatalar: 400 urlGecersiz/adGecersiz, 409 klasorVar, 502 ağ.
  async cloneRemote(libraryRoot, url, { name } = {}) {
    const n = Rules.normalizeRepoUrl(url);
    if (n.error) throw fail(400, n.error, 'urlGecersiz');
    let slug;
    try { slug = MarketplaceFactory.validateName(name || n.slugName); } catch (e) { e.code = 'adGecersiz'; throw e; }
    const dir = path.join(libraryRoot, slug);
    if (await exists(dir)) throw fail(409, 'Bu adda bir klasör zaten var: ' + slug, 'klasorVar');
    const undo = new UndoStack();
    // Klasörü yalnızca clone oluşturur; başarısız olursa yarım kalanı sileriz.
    undo.push(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 }));
    try {
      await this.git.clone(libraryRoot, n.url, slug, { interactive: true });
      if (!(await this.git.isRepoRoot(dir))) throw new Error('Klonlanan klasör bir git deposu kökü değil');
    } catch (e) {
      await undo.rollback().catch(() => {});
      const code = e.netCode || (e.timedOut ? 'zamanAsimi' : 'bilinmiyor');
      const err = fail(502, 'Depo klonlanamadı: ' + describeNetError(code, { url: n.url, dir: libraryRoot }), code);
      err.detail = String(e.stderr || e.message || '').trim().slice(0, 600);
      throw err;
    }
    const warnings = [];
    if (!(await exists(path.join(dir, 'pp.config.json')))) warnings.push({ code: 'ppConfigYok', message: 'Bu depoda pp.config.json yok. Prompt Havuzu ayarlarını oluştur.' });
    if (!(await exists(path.join(dir, '.claude-plugin', 'marketplace.json')))) warnings.push({ code: 'manifestYok', message: '.claude-plugin/marketplace.json yok.' });
    if (!(await this.git.hasCommits(dir))) warnings.push({ code: 'bosDepo', message: 'Depo boş (henüz commit yok).' });
    return { name: slug, dir, url: n.url, warnings };
  }

  // Var olan klasör: yalnızca eksik olanları ekler, var olan hiçbir şeye dokunmaz.
  async initExisting(dir, { description, owner } = {}) {
    const base = path.basename(dir);
    let st = null;
    try { st = await fsp.stat(dir); } catch (e) { /* yok */ }
    if (!st || !st.isDirectory()) throw fail(404, 'Klasör bulunamadı: ' + base);
    if (await exists(path.join(dir, '.git'))) throw fail(409, 'Bu klasör zaten bir git deposu: ' + base);
    const meta = this._meta(FM.slug(base) || 'marketplace', { description, owner });
    const undo = new UndoStack();
    try {
      return await this._scaffold(dir, meta, undo);
    } catch (e) {
      await undo.rollback().catch(() => {});
      throw fail(500, `Git başlatılamadı: ${e.message}. Yapılan değişiklikler geri alındı.`);
    }
  }

  // git init + eksik dosyalar. Oluşturulan her şey için geri alma adımı ekler.
  async _scaffold(dir, meta, undo) {
    const created = [];
    undo.push(() => fsp.rm(path.join(dir, '.git'), { recursive: true, force: true, maxRetries: 3 }));
    await this.git.init(dir, { branch: 'main' });
    created.push('.git');
    for (const [rel, data] of this._files(meta)) {
      const abs = path.join(dir, ...rel.split('/'));
      if (await exists(abs)) continue;
      const missing = [];
      for (let d = path.dirname(abs); d !== dir && !(await exists(d)); d = path.dirname(d)) missing.unshift(d);
      for (const d of missing) {
        await fsp.mkdir(d);
        undo.push(() => fsp.rmdir(d));
      }
      undo.push(() => fsp.rm(abs, { force: true }));
      await this.atomicWrite(abs, data);
      created.push(rel);
    }
    return created;
  }
}

module.exports = { MarketplaceFactory };
