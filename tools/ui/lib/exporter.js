'use strict';
/* Dışa aktarıcı: kaynak promptlardan plugins/<paket>/{commands,agents,skills} çıktısını üretir.
 * plugins/ klasörünün sahibi bu modüldür: beklenmeyen çıktılar ve bileşensiz paket klasörleri .pp/trash'e taşınır.
 * Her yazma ve çöpe taşıma için UndoStack'e bir geri alma adımı eklenir. Git komutu bilmez. */

const path = require('path');

const TUR_DIR = { komut: 'commands', ajan: 'agents', skill: 'skills' };
const str = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));

class PackageExporter {
  // root: () => etkin marketplace klasörü; toTrash(rel, abs) => çöp yolu (rel)
  constructor({ root, fsp, atomicWrite, toTrash, FM, Rules }) {
    this.root = root;
    this.fsp = fsp;
    this.atomicWrite = atomicWrite;
    this.toTrash = toTrash;
    this.FM = FM;
    this.Rules = Rules;
  }

  targetFor(tur, paket, ad) {
    return tur === 'skill' ? `plugins/${paket}/skills/${ad}/SKILL.md` : `plugins/${paket}/${TUR_DIR[tur]}/${ad}.md`;
  }

  /** Summary: Alanın frontmatter değer metni; değer boşsa null döner. */
  _fmtCc(field, value) {
    const { FM, Rules } = this;
    if (field.kind === 'list') {
      if (Array.isArray(value)) {
        const items = Rules.ccList(field, value);
        return items.length ? FM.fmtValue(items) : null;
      }
      if (str(value) === '') return null;
      if (field.strForm) return FM.fmtScalar(str(value));
      const items = Rules.ccList(field, value);
      return items.length ? FM.fmtValue(items) : null;
    }
    const text = str(value);
    if (text === '') return null;
    if (field.kind === 'bool') {
      const flag = Rules.ccBool(text);
      return flag === null ? FM.fmtScalar(text) : String(flag);
    }
    return FM.fmtScalar(field.kind === 'int' ? text.trim() : text);
  }

  /** Summary: Promptun türüne göre plugin çıktı metnini üretir (yalnızca geçerli ve dolu alanlar, spec sırasıyla). */
  renderTarget(it, tur, ad) {
    const { Rules } = this;
    const m = it.meta;
    const blocks = it.fmBlocks || {};
    const lines = [];
    for (const field of Rules.ccFieldsFor(tur)) {
      if (field.emit === false) continue;
      if (field.kind === 'raw') {
        if (blocks[field.key]) lines.push(blocks[field.key]);
        continue;
      }
      let value = Rules.ccValue(m, field.key, tur);
      if (field.key === 'name') value = ad;
      else if (field.key === 'description') value = str(value) || it.title || ad;
      const text = this._fmtCc(field, value);
      if (text !== null) lines.push(`${field.key}: ${text}`);
    }
    return `---\n${lines.join('\n')}\n---\n${it.body.replace(/^\n+/, '').replace(/\s+$/, '')}\n`;
  }

  async _exists(p) { try { await this.fsp.access(p); return true; } catch (e) { return false; } }

  // Var olan ve bağlantı olmayan normal dosya mı?
  async _isPlainFile(p) { try { return (await this.fsp.lstat(p)).isFile(); } catch (e) { return false; } }

  // Var olan ve bağlantı olmayan gerçek klasör mü? (lstat bağlantıyı izlemez)
  async _isPlainDir(p) { try { return (await this.fsp.lstat(p)).isDirectory(); } catch (e) { return false; } }

  // plugins/ altındaki bileşen dosyaları: [{ target, paket }]
  async scanPluginFiles() {
    const root = this.root();
    const out = [];
    let pk;
    if (!(await this._isPlainDir(path.join(root, 'plugins')))) return out; // yok ya da bağlantı
    try { pk = await this.fsp.readdir(path.join(root, 'plugins'), { withFileTypes: true }); } catch (e) { return out; }
    for (const d of pk) {
      if (!d.isDirectory()) continue;
      for (const kind of ['commands', 'agents']) {
        let fl = [];
        if (!(await this._isPlainDir(path.join(root, 'plugins', d.name, kind)))) continue;
        try { fl = await this.fsp.readdir(path.join(root, 'plugins', d.name, kind), { withFileTypes: true }); } catch (e) { /* yok */ }
        // Bağlantılar (isFile false) bileşen sayılmaz: yayın bunların üzerinden kök dışına yazmaz ya da çöpe taşımaz.
        for (const f of fl) if (f.isFile() && /\.md$/i.test(f.name)) out.push({ target: `plugins/${d.name}/${kind}/${f.name}`, paket: d.name });
      }
      let sk = [];
      if (!(await this._isPlainDir(path.join(root, 'plugins', d.name, 'skills')))) continue;
      try { sk = await this.fsp.readdir(path.join(root, 'plugins', d.name, 'skills'), { withFileTypes: true }); } catch (e) { /* yok */ }
      for (const s of sk) {
        if (s.isDirectory() && !s.isSymbolicLink() && await this._isPlainFile(path.join(root, 'plugins', d.name, 'skills', s.name, 'SKILL.md'))) {
          out.push({ target: `plugins/${d.name}/skills/${s.name}/SKILL.md`, paket: d.name });
        }
      }
    }
    return out;
  }

  // plugins/ altındaki paket klasörleri (bileşeni olmayanlar dahil).
  async listPluginDirs() {
    if (!(await this._isPlainDir(path.join(this.root(), 'plugins')))) return [];
    try {
      return (await this.fsp.readdir(path.join(this.root(), 'plugins'), { withFileTypes: true }))
        .filter((d) => d.isDirectory() && d.name.charAt(0) !== '.').map((d) => d.name);
    } catch (e) { return []; }
  }

  // Hedef dosyanın mevcut durumu: 'yok' | 'guncel' | 'eski'. cur: okunmuş metin ya da null.
  stateOf(cur, expected) {
    return cur === null ? 'yok' : (cur.replace(/\r\n/g, '\n') === expected ? 'guncel' : 'eski');
  }

  /* Tek paketin çıktı planı.
   * plans: o pakete ait [{ target, expected, state }]; scanned: scanPluginFiles() sonucu.
   * Dönüş: { paket, write: [{target, expected, state}], remove: [target], unchanged: [target], removeDir: bool } */
  plan(paket, plans, scanned) {
    const expected = new Set(plans.map((p) => p.target));
    const write = plans.filter((p) => p.state !== 'guncel').map((p) => ({ target: p.target, expected: p.expected, state: p.state }));
    const unchanged = plans.filter((p) => p.state === 'guncel').map((p) => p.target);
    const existing = scanned.filter((f) => f.paket === paket);
    const remove = existing.filter((f) => !expected.has(f.target)).map((f) => f.target);
    return { paket, write, remove, unchanged, removeDir: expected.size === 0 };
  }

  _unlinkUndo(undo, abs, prevBuf) {
    undo.push(async () => {
      if (prevBuf === null) await this.fsp.rm(abs, { force: true });
      else { await this.fsp.mkdir(path.dirname(abs), { recursive: true }); await this.fsp.writeFile(abs, prevBuf); }
    });
  }

  async _trash(rel, undo) {
    const root = this.root();
    const abs = path.join(root, ...rel.split('/'));
    const trashRel = await this.toTrash(rel, abs);
    undo.push(async () => {
      await this.fsp.mkdir(path.dirname(abs), { recursive: true });
      await this.fsp.rename(path.join(root, ...trashRel.split('/')), abs);
    });
    return trashRel;
  }

  /* Planı uygular. Dönüş: { written: [target], removed: [target] }. Hata durumunda çağıran undo.rollback() yapar. */
  async apply(plan, undo) {
    const root = this.root();
    const written = []; const removed = [];
    const planDir = `plugins/${plan.paket}`;
    if (plan.removeDir) {
      const dirAbs = path.join(root, 'plugins', plan.paket);
      if (await this._exists(dirAbs)) {
        await this._trash(planDir, undo);
        removed.push(planDir);
      }
      return { written, removed };
    }
    for (const w of plan.write) {
      const abs = path.join(root, ...w.target.split('/'));
      let prev = null;
      try { prev = await this.fsp.readFile(abs); } catch (e) { /* yok */ }
      // Geri alma adımı yazmadan önce eklenir: yarım yazma da geri alınır.
      if (prev === null) await this._rmEmptyParentsOnUndo(abs, undo);
      this._unlinkUndo(undo, abs, prev);
      await this.atomicWrite(abs, w.expected, { mkdir: true });
      written.push(w.target);
    }
    for (const rel of plan.remove) {
      await this._trash(rel, undo);
      removed.push(rel);
      if (path.posix.basename(rel) === 'SKILL.md') {
        const dirAbs = path.join(root, ...path.posix.dirname(rel).split('/'));
        try { await this.fsp.rmdir(dirAbs); undo.push(() => this.fsp.mkdir(dirAbs, { recursive: true })); } catch (e) { /* dolu */ }
      }
    }
    return { written, removed };
  }

  // Yeni oluşturulan dosyanın yeni açılan üst klasörleri geri alınırken boşsa silinsin.
  async _rmEmptyParentsOnUndo(abs, undo) {
    const stop = this.root();
    const created = [];
    for (let d = path.dirname(abs); d.length > stop.length && !(await this._exists(d)); d = path.dirname(d)) created.push(d);
    if (!created.length) return;
    undo.push(async () => { for (const d of created) { try { await this.fsp.rmdir(d); } catch (e) { /* dolu ya da yok */ } } });
  }
}

module.exports = { PackageExporter, TUR_DIR };
