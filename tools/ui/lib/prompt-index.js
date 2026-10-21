'use strict';
/* Prompt dizini: .md dosyalarını okur, frontmatter ve arama alanlarını mtime/size ile önbelleğe alır.
 * Önbellek marketplace klasörüne göre ayrılır; aynı göreli yol farklı depolarda çakışmaz. */

const fsp = require('fs').promises;
const path = require('path');

const str = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));
const toList = (v) => (Array.isArray(v) ? v : String(v == null ? '' : v).split(','))
  .map((s) => String(s).trim()).filter(Boolean);

class PromptIndex {
  constructor({ decode, FM, Rules, ignore }) {
    this.decode = decode;
    this.FM = FM;
    this.Rules = Rules;
    this.ignore = ignore instanceof Set ? ignore : new Set(ignore || []);
    this.rawKeys = Array.from(new Set(Rules.CC_FIELDS.filter((f) => f.kind === 'raw').map((f) => f.key)));
    this._cache = new Map(); // dirAbs -> Map<rel, item>
  }

  _dirCache(dir) {
    let m = this._cache.get(dir);
    if (!m) { m = new Map(); this._cache.set(dir, m); }
    return m;
  }

  // dir verilmezse tümü, verilirse yalnızca o marketplace klasörü temizlenir.
  clear(dir) {
    if (dir) this._cache.delete(dir); else this._cache.clear();
  }

  /** Summary: Ham Claude Code alanlarının (hooks, metadata, experimental) kaynak satırları; yinelenende son girdi, boş değer atlanır. */
  rawBlocks(p) {
    const out = {};
    for (const key of this.rawKeys) {
      const entry = p.entries.filter((e) => e.key === key).pop();
      if (!entry || entry.value === '' || (Array.isArray(entry.value) && !entry.value.length)) continue;
      const lines = entry.lines.slice();
      while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
      out[key] = lines.join('\n');
    }
    return out;
  }

  async indexFile(dir, rel, abs) {
    const { FM, Rules } = this;
    const cache = this._dirCache(dir);
    const st = await fsp.stat(abs);
    const c = cache.get(rel);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c;
    const ext = path.extname(rel).toLowerCase();
    const isMd = ext === '.md' || ext === '.markdown';
    const item = { path: rel, mtimeMs: st.mtimeMs, size: st.size, isMd };
    if (isMd && st.size < 2000000) {
      const raw = this.decode(await fsp.readFile(abs));
      const p = FM.parse(raw);
      const m = FM.meta(p);
      item.meta = m;
      item.hasFm = p.hasFm;
      item.fmBroken = Rules.isFmBroken(raw, p.hasFm);
      item.check = Rules.publishCheck({ meta: m, hasFm: p.hasFm, fmBroken: item.fmBroken });
      item.body = p.body;
      item.fmBlocks = this.rawBlocks(p);
      item.title = str(m.baslik) || path.basename(rel, ext);
      item.tags = toList(m.etiketler);
      item.fTitle = FM.fold(item.title);
      item.fTags = item.tags.map(FM.fold);
      item.fPath = FM.fold(rel);
      item.fBody = FM.fold(p.body);
    } else if (isMd) {
      item.isMd = false;
      item.tooBig = true;
      item.check = { code: 'dosyaBuyuk', level: 'warn', get reason() { return Rules.MSG.dosyaBuyuk; } };
    }
    cache.set(rel, item);
    return item;
  }

  // relDir altındaki tüm .md dosyaları. Yürüyüşte görülmeyen (silinmiş) yollar önbellekten düşer.
  async listMd(dir, relDir, opts) {
    const includeBig = !!(opts && opts.includeBig);
    const out = [];
    const seen = new Set();
    const rec = async (abs, rel) => {
      let ents;
      try { ents = await fsp.readdir(abs, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        if (this.ignore.has(e.name)) continue;
        if (e.isSymbolicLink()) continue; // bağlantılar (dosya ya da klasör) listelenmez, içeriği indekslenmez
        const r = rel + '/' + e.name;
        const a = path.join(abs, e.name);
        if (e.isDirectory()) await rec(a, r);
        else if (/\.(md|markdown)$/i.test(e.name)) {
          seen.add(r);
          const it = await this.indexFile(dir, r, a);
          if (it && (it.isMd || (includeBig && it.tooBig))) out.push(it);
        }
      }
    };
    await rec(path.join(dir, relDir), relDir);
    const cache = this._dirCache(dir);
    const prefix = relDir + '/';
    for (const k of Array.from(cache.keys())) if (k.startsWith(prefix) && !seen.has(k)) cache.delete(k);
    return out;
  }

  async listDirs(dir, relDir) {
    const out = [relDir];
    const rec = async (abs, rel) => {
      let ents;
      try { ents = await fsp.readdir(abs, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        if (e.isSymbolicLink() || !e.isDirectory() || this.ignore.has(e.name)) continue;
        out.push(rel + '/' + e.name);
        await rec(path.join(abs, e.name), rel + '/' + e.name);
      }
    };
    await rec(path.join(dir, relDir), relDir);
    return out.sort((a, b) => a.localeCompare(b, 'tr'));
  }
}

module.exports = { PromptIndex, str, toList };
