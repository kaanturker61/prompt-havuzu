'use strict';

const path = require('path');
const { UndoStack } = require('./undo');

/** Summary: Prompt taşıma hatası; ileti sunucuda koddan üretilir. */
class MoveError extends Error {
  constructor(status, code, params) {
    super(code);
    this.name = 'MoveError';
    this.status = status;
    this.code = code;
    this.params = params || {};
  }
}

/** Summary: Prompt dosyasını aynı ya da başka marketplace'te başka bir kapsayıcıya taşır; git bilmez. */
class PromptMover {
  constructor({ fsp, atomicWrite, decode, FM, Rules, toTrash, isInside, samePath, checkNewPath }) {
    this.fsp = fsp;
    this.atomicWrite = atomicWrite;
    this.decode = decode;
    this.FM = FM;
    this.Rules = Rules;
    this.toTrash = toTrash;
    this.isInside = isInside;
    this.samePath = samePath;
    this.checkNewPath = checkNewPath;
  }

  /** Summary: Hedef kapsayıcının marketplace'e göreli yolu. */
  targetDir(libraryDir, kind, plugin) {
    if (kind === 'paket') return libraryDir + '/' + plugin;
    if (kind === 'gelenKutusu') return libraryDir + '/' + this.Rules.INBOX_DIR;
    return libraryDir;
  }

  /** Summary: Yol var mı. */
  async _exists(abs) {
    try { await this.fsp.access(abs); return true; } catch (e) { return false; }
  }

  /** Summary: Hedefte kullanılacak son ad; ad açıkça istenmişse çakışma MoveError (409), değilse "-2" gibi bir sonek eklenir. */
  async _finalName(dirAbs, wanted, explicit) {
    if (!(await this._exists(path.join(dirAbs, wanted)))) return wanted;
    if (explicit) throw new MoveError(409, 'hedefVar', { name: wanted });
    const ext = path.posix.extname(wanted);
    const stem = wanted.slice(0, wanted.length - ext.length);
    let n = 2;
    while (await this._exists(path.join(dirAbs, stem + '-' + n + ext))) n++;
    return stem + '-' + n + ext;
  }

  /** Summary: Hedef klasörü (yoksa üst klasörleriyle) oluşturur; yeni oluşan klasörler geri almada silinir. */
  async _ensureDir(abs, undo) {
    const first = await this.fsp.mkdir(abs, { recursive: true });
    if (first) undo.push(() => this.fsp.rm(first, { recursive: true, force: true }));
  }

  /** Summary: Taşır; dönüş { path (hedef göreli yol), renamed (çakışma yüzünden ad değişti), paket ({ action, value }), trash (kaynağın çöp yolu ya da null) }. */
  async move({ src, dst, same }) {
    const { FM, Rules } = this;
    const srcAbs = path.join(src.dir, ...src.rel.split('/'));
    const srcBase = path.posix.basename(src.rel);
    const from = Rules.classifyPromptPath(src.rel, src.libraryDir);
    const targetRel = this.targetDir(dst.libraryDir, dst.kind, dst.plugin);
    const dstDirAbs = path.join(dst.dir, ...targetRel.split('/'));
    if (!this.isInside(dstDirAbs, dst.dir)) throw new MoveError(400, 'disarida');
    if (dst.kind === 'paket') {
      const st = await this.fsp.stat(dstDirAbs).catch(() => null);
      if (!st || !st.isDirectory()) throw new MoveError(404, 'pluginYok', { name: dst.plugin });
    }

    const buf = await this.fsp.readFile(srcAbs);
    const parsed = FM.parse(this.decode(buf));
    const paket = Rules.paketAfterMove({
      alan: FM.meta(parsed)[Rules.PAKET_FIELD],
      from: { kind: from.kind, paket: from.paket },
      to: { kind: dst.kind, paket: dst.kind === 'paket' ? FM.slug(dst.plugin) : null }
    });
    const rewrite = paket.action !== 'keep';
    if (rewrite) FM.set(parsed, Rules.PAKET_FIELD, paket.action === 'set' ? paket.value : '');
    const data = rewrite ? FM.stringify(parsed) : buf;

    const wanted = dst.name || srcBase;
    let name = wanted;
    if (this.samePath(path.join(dstDirAbs, wanted), srcAbs)) {
      if (wanted === srcBase) throw new MoveError(400, 'ayniKonum');
    } else {
      name = await this._finalName(dstDirAbs, wanted, !!dst.name);
    }
    const dstRel = targetRel + '/' + name;
    this.checkNewPath(dst.dir, dstRel);
    const dstAbs = path.join(dstDirAbs, name);

    const undo = new UndoStack();
    let trash = null;
    try {
      await this._ensureDir(dstDirAbs, undo);
      if (same) {
        await this.fsp.rename(srcAbs, dstAbs);
        undo.push(() => this.fsp.rename(dstAbs, srcAbs));
        if (rewrite) {
          await this.atomicWrite(dstAbs, data);
          undo.push(() => this.atomicWrite(dstAbs, buf));
        }
      } else {
        await this.atomicWrite(dstAbs, data);
        undo.push(() => this.fsp.rm(dstAbs, { force: true }));
        trash = await this.toTrash(src.rel, srcAbs);
      }
      undo.clear();
    } catch (e) {
      try { await undo.rollback(); } catch (agg) { throw new MoveError(500, 'rollbackFailed', { reason: e.message, path: dstRel }); }
      throw new MoveError(500, 'geriAlindi', { reason: e.message });
    }
    return { path: dstRel, renamed: !dst.name && name !== srcBase, paket, trash };
  }
}

module.exports = { PromptMover, MoveError };
