'use strict';
/* Plugin (prompt klasörü) oluşturma, yeniden adlandırma ve açıklama. Git komutu bilmez.
 * Her yan etkiden sonra bir geri alma adımı eklenir; hata olursa dosya sistemi eski haline döner. */

const path = require('path');
const { UndoStack } = require('./undo');
const { PpConfigError } = require('./pp-config');

/** Summary: Geri alınan işlemin hata iletisi başlığı (create | rename). */
const FAIL_LABEL = { create: 'Plugin oluşturulamadı', rename: 'Plugin yeniden adlandırılamadı' };

class PackageError extends Error {
  constructor(status, message, data) {
    super(message);
    this.name = 'PackageError';
    this.status = status;
    if (data) this.data = data;
  }
}

class PackageService {
  // assertHealthy(dir): isteğe bağlı ön koşul; bozuk pp.config.json ya da geçersiz libraryDir'de PpConfigError fırlatır.
  constructor({ fsp, atomicWrite, loadConfigAt, saveConfigAt, assertHealthy, Rules, FM }) {
    this.fsp = fsp;
    this.atomicWrite = atomicWrite;
    this.loadConfigAt = loadConfigAt;
    this.saveConfigAt = saveConfigAt;
    this.assertHealthy = assertHealthy || (async () => {});
    this.Rules = Rules;
    this.FM = FM;
  }

  // Ham addan slug üretir ve kuralları denetler. Hata PackageError(400).
  _slugOf(raw) {
    const name = String(raw == null ? '' : raw).trim();
    const slug = this.FM.slug(name);
    if (!name || (slug === 'adsiz' && !/adsiz/i.test(name))) throw new PackageError(400, 'Plugin adı gerekli');
    const err = this.Rules.checkPluginName(slug);
    if (err) throw new PackageError(400, err);
    return slug;
  }

  // Klasör adı olarak güvenli mi (yol ayracı, '..', gizli ad yok).
  _safeFolder(name) {
    const n = String(name == null ? '' : name);
    return !!n && !/[\\/]/.test(n) && n !== '..' && n.charAt(0) !== '.';
  }

  async _isDir(abs) {
    try { return (await this.fsp.stat(abs)).isDirectory(); } catch (e) { return false; }
  }

  async _exists(abs) {
    try { await this.fsp.access(abs); return true; } catch (e) { return false; }
  }

  // libraryDir altında, slug'ı aynı olan (büyük/küçük harf dahil) bir girdi var mı. except: yok sayılacak ad.
  async _clash(libAbs, slug, except) {
    let ents = [];
    try { ents = await this.fsp.readdir(libAbs, { withFileTypes: true }); } catch (e) { /* klasör yok */ }
    return ents.some((e) => e.name !== except && (e.name.toLowerCase() === slug.toLowerCase() || (e.isDirectory() && this.FM.slug(e.name) === slug)));
  }

  async _readBytes(file) {
    try { return await this.fsp.readFile(file); } catch (e) { return null; }
  }

  // pp.config.json'u özgün baytlarıyla geri yazacak adımı ekler.
  async _protectConfig(undo, dir) {
    const file = path.join(dir, 'pp.config.json');
    const orig = await this._readBytes(file);
    undo.push(async () => {
      if (orig === null) await this.fsp.rm(file, { force: true });
      else await this.atomicWrite(file, orig);
    });
  }

  // Geri alır. PpConfigError (bozuk ayar) 500'e çevrilmez, aynen döner (409 ppConfigBozuk / libraryDirGecersiz).
  _fail(e, undo, op = 'create') {
    return undo.rollback().then(
      () => (e instanceof PpConfigError ? e : new PackageError(500, FAIL_LABEL[op] + ': ' + e.message + '. Yapılan değişiklikler geri alındı.')),
      (agg) => new PackageError(500, 'Plugin işlemi başarısız ve geri alma tamamlanamadı: ' + (agg.errors || [agg]).map((x) => x.message).join('; ') + '. Klasörü elle kontrol et.', { rollbackFailed: true })
    );
  }

  async create(dir, libraryDir, { name, description }) {
    await this.assertHealthy(dir);
    const slug = this._slugOf(name);
    const libAbs = path.join(dir, libraryDir);
    const abs = path.join(libAbs, slug);
    if (await this._clash(libAbs, slug)) throw new PackageError(409, 'Bu adda bir plugin zaten var: ' + slug);
    const desc = String(description == null ? '' : description).trim();
    const undo = new UndoStack();
    try {
      await this.fsp.mkdir(libAbs, { recursive: true });
      try { await this.fsp.mkdir(abs); } catch (e) {
        if (e.code === 'EEXIST') throw new PackageError(409, 'Bu adda bir plugin zaten var: ' + slug);
        throw e;
      }
      // Klasörü yalnızca biz oluşturduk; geri alırken silmek güvenlidir.
      undo.push(() => this.fsp.rm(abs, { recursive: true, force: true }));
      await this.atomicWrite(path.join(abs, '.gitkeep'), '');
      if (desc) {
        await this._protectConfig(undo, dir);
        const cfg = await this.loadConfigAt(dir);
        cfg.packages[slug] = { ...(cfg.packages[slug] || {}), description: desc };
        await this.saveConfigAt(dir, cfg, this.atomicWrite);
      }
      undo.clear();
      return { name: slug, slug, path: libraryDir + '/' + slug };
    } catch (e) {
      if (e instanceof PackageError && e.status === 409) { await undo.rollback().catch(() => {}); throw e; }
      throw await this._fail(e, undo);
    }
  }

  async _countMd(abs) {
    let n = 0;
    let ents = [];
    try { ents = await this.fsp.readdir(abs, { withFileTypes: true }); } catch (e) { return 0; }
    for (const e of ents) {
      if (e.isDirectory()) n += await this._countMd(path.join(abs, e.name));
      else if (/\.(md|markdown)$/i.test(e.name)) n++;
    }
    return n;
  }

  async rename(dir, libraryDir, { from, to }) {
    await this.assertHealthy(dir);
    const libAbs = path.join(dir, libraryDir);
    if (!this._safeFolder(from) || !(await this._isDir(path.join(libAbs, from)))) {
      throw new PackageError(404, 'Plugin bulunamadı: ' + from);
    }
    const slug = this._slugOf(to);
    if (slug === from) throw new PackageError(400, 'Yeni ad eskisiyle aynı');
    const caseOnly = slug.toLowerCase() === from.toLowerCase();
    if (!caseOnly && await this._clash(libAbs, slug, from)) throw new PackageError(409, 'Bu adda bir plugin zaten var: ' + slug);
    const src = path.join(libAbs, from);
    const dst = path.join(libAbs, slug);
    const moved = await this._countMd(src);
    const undo = new UndoStack();
    try {
      if (caseOnly) {
        // Windows/macOS'ta yalnızca harf büyüklüğü değişen taşıma geçici adla iki adımda yapılır.
        const tmp = path.join(libAbs, '.pp-rename-' + process.pid + '-' + Date.now());
        await this.fsp.rename(src, tmp);
        undo.push(() => this.fsp.rename(tmp, src));
        await this.fsp.rename(tmp, dst);
        undo.clear();
        undo.push(() => this.fsp.rename(dst, src));
      } else {
        await this.fsp.rename(src, dst);
        undo.push(() => this.fsp.rename(dst, src));
      }
      const cfg = await this.loadConfigAt(dir);
      const keys = Array.from(new Set([this.FM.slug(from), from])).filter((k) => cfg.packages[k] !== undefined);
      if (keys.length) {
        await this._protectConfig(undo, dir);
        const val = cfg.packages[keys[0]];
        for (const k of keys) delete cfg.packages[k];
        cfg.packages[slug] = val;
        await this.saveConfigAt(dir, cfg, this.atomicWrite);
      }
      undo.clear();
      return { name: slug, slug, path: libraryDir + '/' + slug, moved };
    } catch (e) {
      throw await this._fail(e, undo, 'rename');
    }
  }

  async setDescription(dir, libraryDir, { name, description }) {
    await this.assertHealthy(dir);
    if (!this._safeFolder(name) || !(await this._isDir(path.join(dir, libraryDir, name)))) {
      throw new PackageError(404, 'Plugin bulunamadı: ' + name);
    }
    const desc = String(description == null ? '' : description).trim();
    if (!desc) throw new PackageError(400, 'Paket açıklaması boş olamaz');
    const cfg = await this.loadConfigAt(dir);
    const key = cfg.packages[name] !== undefined ? name : this.FM.slug(name);
    cfg.packages[key] = { ...(cfg.packages[key] || {}), description: desc };
    await this.saveConfigAt(dir, cfg, this.atomicWrite); // tek atomik yazma
    return { ok: true };
  }
}

module.exports = { PackageService, PackageError };
