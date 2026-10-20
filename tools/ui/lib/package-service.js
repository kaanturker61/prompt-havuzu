'use strict';
/* Plugin (prompt klasörü) oluşturma, yeniden adlandırma ve açıklama (prompts/<klasör>/.claude-plugin/plugin.json). Git komutu bilmez.
 * Her yan etkiden sonra bir geri alma adımı eklenir; hata olursa dosya sistemi eski haline döner. */

const path = require('path');
const { UndoStack } = require('./undo');
const { SettingsError } = require('./marketplace-settings');
const I18n = require('../public/i18n.js');

/** Summary: Geçerli dilde düz metin çevirisi (istek bağlamındaki dil). */
const tx = I18n.tx;

/** Summary: Geri alınan işlemin hata iletisi sözlük anahtarı (create | rename | move). */
const FAIL_LABEL = { create: 'pkg.err.createFailed', rename: 'pkg.err.renameFailed', move: 'pkg.err.moveFailed' };

class PackageError extends Error {
  constructor(status, message, data) {
    super(message);
    this.name = 'PackageError';
    this.status = status;
    if (data) this.data = data;
  }
}

class PackageService {
  constructor({ fsp, atomicWrite, settings, Rules, FM, toTrash, isInside, checkNewPath }) {
    this.fsp = fsp;
    this.atomicWrite = atomicWrite;
    this.settings = settings;
    this.Rules = Rules;
    this.FM = FM;
    this.toTrash = toTrash;
    this.isInside = isInside;
    this.checkNewPath = checkNewPath;
  }

  // Ham addan slug üretir ve kuralları denetler. Hata PackageError(400).
  _slugOf(raw) {
    const name = String(raw == null ? '' : raw).trim();
    const slug = this.FM.slug(name);
    if (!name || (slug === 'adsiz' && !/adsiz/i.test(name))) throw new PackageError(400, tx('rules.pluginAdGerekli'));
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

  // libraryDir altında, slug'ı aynı olan (büyük/küçük harf dahil) bir girdi var mı. except: yok sayılacak ad.
  async _clash(libAbs, slug, except) {
    let ents = [];
    try { ents = await this.fsp.readdir(libAbs, { withFileTypes: true }); } catch (e) { /* klasör yok */ }
    return ents.some((e) => e.name !== except && (e.name.toLowerCase() === slug.toLowerCase() || (e.isDirectory() && this.FM.slug(e.name) === slug)));
  }

  // Geri alır. SettingsError (409) 500'e çevrilmez, aynen döner.
  _fail(e, undo, op = 'create') {
    return undo.rollback().then(
      () => (e instanceof SettingsError ? e : new PackageError(500, tx(FAIL_LABEL[op], { reason: e.message }))),
      (agg) => new PackageError(500, tx('pkg.err.rollbackFailed', { reason: (agg.errors || [agg]).map((x) => x.message).join('; ') }), { rollbackFailed: true })
    );
  }

  async create(dir, libraryDir, { name, description }) {
    await this.settings.loadStrict(dir);
    const slug = this._slugOf(name);
    const libAbs = path.join(dir, libraryDir);
    const abs = path.join(libAbs, slug);
    if (await this._clash(libAbs, slug)) throw new PackageError(409, tx('pkg.err.exists', { name: slug }));
    const desc = String(description == null ? '' : description).trim();
    const undo = new UndoStack();
    try {
      await this.fsp.mkdir(libAbs, { recursive: true });
      try { await this.fsp.mkdir(abs); } catch (e) {
        if (e.code === 'EEXIST') throw new PackageError(409, tx('pkg.err.exists', { name: slug }));
        throw e;
      }
      // Klasörü yalnızca biz oluşturduk; geri alırken silmek güvenlidir.
      undo.push(() => this.fsp.rm(abs, { recursive: true, force: true }));
      await this.atomicWrite(path.join(abs, '.gitkeep'), '');
      if (desc && !(await this.settings.setPluginDescription(dir, libraryDir, slug, desc))) {
        throw new PackageError(404, tx('pkg.err.notFound', { name: slug }));
      }
      undo.clear();
      return { name: slug, slug, path: libraryDir + '/' + slug };
    } catch (e) {
      if (e instanceof PackageError) { await undo.rollback().catch(() => {}); throw e; }
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
    await this.settings.loadStrict(dir);
    const libAbs = path.join(dir, libraryDir);
    if (!this._safeFolder(from) || !(await this._isDir(path.join(libAbs, from)))) {
      throw new PackageError(404, tx('pkg.err.notFound', { name: from }));
    }
    const slug = this._slugOf(to);
    if (slug === from) throw new PackageError(400, tx('pkg.err.sameName'));
    const caseOnly = slug.toLowerCase() === from.toLowerCase();
    if (!caseOnly && await this._clash(libAbs, slug, from)) throw new PackageError(409, tx('pkg.err.exists', { name: slug }));
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
      } else {
        await this.fsp.rename(src, dst);
      }
      undo.clear();
      return { name: slug, slug, path: libraryDir + '/' + slug, moved };
    } catch (e) {
      throw await this._fail(e, undo, 'rename');
    }
  }

  /** Summary: Plugin klasöründeki tüm girdileri sıralı (klasör, içindekilerden önce) listeler; bağlantı ya da .git adlı girdi varsa PackageError (400, baglantiVar). */
  async _collect(abs, rel, out = []) {
    for (const e of await this.fsp.readdir(abs, { withFileTypes: true })) {
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink() || e.name.toLowerCase() === '.git') {
        throw new PackageError(400, tx('pkg.err.linkInside', { path: childRel }), { code: 'baglantiVar' });
      }
      if (e.isDirectory()) {
        out.push({ rel: childRel, dir: true });
        await this._collect(path.join(abs, e.name), childRel, out);
      } else {
        out.push({ rel: childRel, dir: false });
      }
    }
    return out;
  }

  /** Summary: Plugin klasörünü başka bir marketplace'e taşır (kopyalar, kaynağı çöpe taşır); açıklama klasördeki plugin.json ile birlikte gider. Dönüş { name, slug, path, moved, trash }. */
  async move({ src, dst }) {
    await this.settings.loadStrict(src.dir);
    await this.settings.loadStrict(dst.dir);
    const name = src.name;
    const srcRel = src.libraryDir + '/' + name;
    const srcAbs = path.join(src.dir, src.libraryDir, String(name == null ? '' : name));
    if (!this._safeFolder(name) || !(await this._isDir(srcAbs))) throw new PackageError(404, tx('pkg.err.notFound', { name }));
    const slug = this._slugOf(name);
    const dstLibAbs = path.join(dst.dir, dst.libraryDir);
    const dstAbs = path.join(dstLibAbs, name);
    if (!this.isInside(dstAbs, dst.dir)) throw new PackageError(400, tx('pkg.err.outside'), { code: 'disarida' });
    if (await this._clash(dstLibAbs, slug)) throw new PackageError(409, tx('pkg.err.exists', { name: slug }), { code: 'pluginVar' });
    if ((await this.fsp.lstat(srcAbs)).isSymbolicLink()) throw new PackageError(400, tx('pkg.err.linkInside', { path: srcRel }), { code: 'baglantiVar' });
    const list = await this._collect(srcAbs, '');
    this.checkNewPath(dst.dir, dst.libraryDir + '/' + name);
    const undo = new UndoStack();
    try {
      const firstLib = await this.fsp.mkdir(dstLibAbs, { recursive: true });
      if (firstLib) undo.push(() => this.fsp.rm(firstLib, { recursive: true, force: true }));
      try { await this.fsp.mkdir(dstAbs); } catch (e) {
        if (e.code === 'EEXIST') throw new PackageError(409, tx('pkg.err.exists', { name: slug }), { code: 'pluginVar' });
        throw e;
      }
      undo.push(() => this.fsp.rm(dstAbs, { recursive: true, force: true }));
      for (const x of list) {
        const parts = x.rel.split('/');
        if (x.dir) await this.fsp.mkdir(path.join(dstAbs, ...parts));
        else await this.fsp.copyFile(path.join(srcAbs, ...parts), path.join(dstAbs, ...parts));
      }
      const trash = await this.toTrash(srcRel, srcAbs);
      undo.clear();
      return { name, slug, path: dst.libraryDir + '/' + name, moved: list.filter((x) => !x.dir && /\.(md|markdown)$/i.test(x.rel)).length, trash };
    } catch (e) {
      if (e instanceof PackageError) { await undo.rollback().catch(() => {}); throw e; }
      throw await this._fail(e, undo, 'move');
    }
  }

  async setDescription(dir, libraryDir, { name, description }) {
    await this.settings.loadStrict(dir);
    if (!this._safeFolder(name) || !(await this._isDir(path.join(dir, libraryDir, name)))) {
      throw new PackageError(404, tx('pkg.err.notFound', { name }));
    }
    const desc = String(description == null ? '' : description).trim();
    if (!desc) throw new PackageError(400, tx('pkg.err.descriptionEmpty'));
    if (!(await this.settings.setPluginDescription(dir, libraryDir, name, desc))) {
      throw new PackageError(404, tx('pkg.err.notFound', { name }));
    }
    return { ok: true };
  }
}

module.exports = { PackageService, PackageError };
