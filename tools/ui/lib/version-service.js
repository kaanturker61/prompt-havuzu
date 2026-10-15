'use strict';
/* Prompt sürümü: +1 (dosya yaz, commit, annotated tag) ve tutarlılık uyarısı.
 * Git komutu bilmez; yalnızca GitService metotlarını kullanır. Kurallar rules.js'te tek yerde. */

const path = require('path');
const FM = require('../public/fm.js');
const Rules = require('../public/rules.js');
const { GitError } = require('./git-service');
const { UndoStack } = require('./undo');
const { explainGitError, sanitizeDetail } = require('./git-errors');

const RELEASE_SUBJECT_RE = /^\S+ v\d+\.\d+\.\d+$/;
const BATCH = 40;

class VersionError extends Error {
  constructor(status, message, data) {
    super(message);
    this.name = 'VersionError';
    this.status = status;
    if (data) this.data = data;
  }
}

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

class VersionService {
  constructor({ git, files, decode, listPrompts }) {
    this.git = git;
    this.files = files;
    this.decode = decode;
    this.listPrompts = listPrompts;
    this._blobCache = new Map(); // root\0tagNesnesi\0rel -> sha|null (değişmez, kalıcı)
    this._hashCache = new Map(); // root\0rel -> { mtimeMs, size, sha }
  }

  clearCache() {
    this._blobCache.clear();
    this._hashCache.clear();
  }

  // Map<ad, { tags: [{ name, object, commit, date, version }], last }>
  async _tagsByAd(root) {
    const map = new Map();
    for (const t of await this.git.listTags(root, Rules.PROMPT_TAG_PREFIX)) {
      const p = Rules.parsePromptTag(t.name);
      if (!p) continue;
      let e = map.get(p.ad);
      if (!e) { e = { tags: [], last: null }; map.set(p.ad, e); }
      const item = { ...t, version: p.version };
      e.tags.push(item);
      if (!e.last || Rules.compareVersions(p.version, e.last.version) > 0) e.last = item;
    }
    return map;
  }

  // Genel takma ad: paket sürüm önerisi prompt tag'lerini yeniden okumaz.
  tagsByAd(root) { return this._tagsByAd(root); }

  // cands: [{ rel, abs, last }] -> Map<rel, true|false|null>; null = karşılaştırılamadı (yol tag'de yok).
  async _changed(root, cands) {
    const result = new Map();
    const blobs = new Map();
    const needBlob = [];
    for (const c of cands) {
      const key = root + '\0' + c.last.object + '\0' + c.rel;
      if (this._blobCache.has(key)) blobs.set(c.rel, this._blobCache.get(key));
      else needBlob.push(c);
    }
    for (const part of chunks(needBlob, 8)) {
      await Promise.all(part.map(async (c) => {
        const sha = await this.git.blobAt(root, c.last.commit, c.rel);
        this._blobCache.set(root + '\0' + c.last.object + '\0' + c.rel, sha);
        blobs.set(c.rel, sha);
      }));
    }
    const live = cands.filter((c) => blobs.get(c.rel));
    const stale = [];
    const stats = new Map();
    for (const c of live) {
      const st = await this.files.stat(c.abs);
      stats.set(c.rel, st);
      const h = this._hashCache.get(root + '\0' + c.rel);
      if (!h || h.mtimeMs !== st.mtimeMs || h.size !== st.size) stale.push(c.rel);
    }
    for (const part of chunks(stale, BATCH)) {
      const shas = await this.git.hashFiles(root, part);
      part.forEach((rel, i) => {
        const st = stats.get(rel);
        this._hashCache.set(root + '\0' + rel, { mtimeMs: st.mtimeMs, size: st.size, sha: shas[i] });
      });
    }
    for (const c of cands) {
      const blob = blobs.get(c.rel);
      result.set(c.rel, blob ? this._hashCache.get(root + '\0' + c.rel).sha !== blob : null);
    }
    return result;
  }

  // Map<rel, 'surumGuncelDegil'>
  async statusMap(root, libraryDir) {
    const out = new Map();
    const byAd = await this._tagsByAd(root);
    if (!byAd.size) return out;
    const cands = [];
    for (const it of await this.listPrompts(root, libraryDir)) {
      const ad = Rules.promptTagAd(it.path, libraryDir);
      const e = ad && byAd.get(ad);
      if (!e) continue;
      const c = Rules.coerceVersion(it.meta && it.meta.versiyon);
      if (!c || c.version !== e.last.version) continue;
      cands.push({ rel: it.path, abs: this._abs(root, it.path), last: e.last });
    }
    const changed = await this._changed(root, cands);
    for (const [rel, v] of changed) if (v === true) out.set(rel, 'surumGuncelDegil');
    return out;
  }

  _abs(root, rel) { return path.join(root, rel); }

  async info(root, libraryDir, rel, abs) {
    const ad = Rules.promptTagAd(rel, libraryDir);
    const text = this.decode(await this.files.read(abs));
    const meta = FM.meta(FM.parse(text));
    const ham = meta.versiyon == null ? '' : Array.isArray(meta.versiyon) ? meta.versiyon.join(', ') : String(meta.versiyon);
    const c = Rules.coerceVersion(meta.versiyon);
    const e = (await this._tagsByAd(root)).get(ad);
    const last = e ? e.last : null;
    const versiyon = c ? c.version : ham;

    let degisti = null;
    if (last) degisti = (await this._changed(root, [{ rel, abs, last }])).get(rel);

    let uyari = null;
    if (last && c && c.version === last.version && degisti === true) {
      uyari = { code: 'surumGuncelDegil', level: 'warn', message: Rules.MSG.surumGuncelDegil(last.version) };
    }
    const base = c ? (c.version || (last ? last.version : '')) : null;
    const oneriler = c ? {
      buyuk: Rules.bumpVersion(base, 'buyuk'), kucuk: Rules.bumpVersion(base, 'kucuk'), yama: Rules.bumpVersion(base, 'yama')
    } : null;

    const commits = await this.git.log(root, { path: rel, limit: 20, ...(last ? { range: last.commit + '..HEAD' } : {}) });
    const notOnerisi = commits.filter((x) => !RELEASE_SUBJECT_RE.test(x.subject)).map((x) => '- ' + x.subject).join('\n');

    return {
      path: rel, ad, tagOnek: Rules.PROMPT_TAG_PREFIX + ad + '/',
      versiyonHam: ham, versiyon, eskiBicim: !!(c && c.legacy), versiyonGecerli: !!c,
      sonSurum: last ? { tag: last.name, version: last.version, commit: last.commit, date: last.date } : null,
      ilkSurum: !!(c && !c.version && !last),
      degisti, uyari, oneriler, notOnerisi
    };
  }

  async bump(root, libraryDir, { rel, abs, level, note, raw, baseMtime }) {
    const { files, git } = this;
    // 1) Ön kontroller (yan etki yok)
    if (!Rules.VERSION_LEVELS.includes(level)) {
      throw new VersionError(400, 'Geçersiz seviye. Büyük, küçük veya yama seç.', { field: 'level' });
    }
    const cleanNote = String(note == null ? '' : note).trim();
    if (!cleanNote) throw new VersionError(400, 'Sürüm notu boş olamaz', { field: 'note' });
    const ad = Rules.promptTagAd(rel, libraryDir);
    if (!ad) throw new VersionError(400, 'Sürüm yalnızca prompt dosyaları için oluşturulur');
    let st;
    try { st = await files.stat(abs); } catch (e) { st = null; }
    if (!st) throw new VersionError(404, 'Dosya bulunamadı. Silinmiş veya taşınmış olabilir');
    if (baseMtime && Math.abs(Math.round(st.mtimeMs) - baseMtime) > 1) {
      throw new VersionError(409, 'Dosya sen açtıktan sonra diskte değişti', { conflict: true, mtime: Math.round(st.mtimeMs) });
    }
    const origBuf = await files.read(abs);
    const text = typeof raw === 'string' ? raw : this.decode(origBuf);
    const p = FM.parse(text);
    if (Rules.isFmBroken(text, p.hasFm)) {
      throw new VersionError(400, 'Frontmatter kapanmamış (ikinci "---" satırı yok). versiyon alanı yazılamıyor.', { code: 'onYuzKapanmamis' });
    }
    for (const it of await this.listPrompts(root, libraryDir)) {
      if (it.path !== rel && Rules.promptTagAd(it.path, libraryDir) === ad) {
        throw new VersionError(409, 'Bu prompt ile ' + it.path + ' aynı sürüm adını (' + Rules.PROMPT_TAG_PREFIX + ad + ') üretiyor. Birinin dosya adını değiştir.',
          { code: 'adCakisiyor', other: it.path });
      }
    }
    const rawVer = FM.meta(p).versiyon;
    const c = Rules.coerceVersion(rawVer);
    if (!c) {
      const shown = Array.isArray(rawVer) ? rawVer.join(', ') : String(rawVer);
      throw new VersionError(400, 'versiyon alanı yorumlanamadı: "' + shown + '". X.Y.Z biçiminde düzelt (örnek: 1.0.0).', { field: 'versiyon' });
    }
    const entry = (await this._tagsByAd(root)).get(ad);
    const last = entry ? entry.last : null;
    const base = c.version || (last ? last.version : '');
    const yeni = Rules.bumpVersion(base, level);
    if (!yeni) {
      // base yorumlanabilir ve seviye geçerli olduğu için tek neden: bir bileşen 999999999'u aşacaktı. Hiçbir şey yazılmadı.
      throw new VersionError(400, 'Sürüm üst sınıra ulaştı (bileşen en çok ' + Rules.VERSION_PART_MAX + ' olabilir). versiyon alanını düzelt.', { field: 'versiyon' });
    }
    const tag = Rules.promptTag(ad, yeni);
    if (entry && entry.tags.some((t) => t.version === yeni)) {
      throw new VersionError(409, "Bu sürümün tag'i zaten var: " + tag + '. versiyon alanını kontrol et.', { code: 'tagVar', tag });
    }
    if (last && Rules.compareVersions(yeni, last.version) <= 0) {
      throw new VersionError(409, 'Yeni sürüm (' + yeni + ') son sürümden (' + last.version + ') büyük olmalı. versiyon alanını düzelt.', { code: 'surumGeride' });
    }
    const parent = await git.headCommit(root);
    FM.set(p, 'versiyon', yeni);
    const out = FM.stringify(p);
    const message = ad + ' v' + yeni + '\n\n' + cleanNote;

    // 2) Uygulama; her yan etkiden sonra geri alma adımı eklenir
    const undo = new UndoStack();
    try {
      await files.write(abs, out);
      undo.push(async () => { await files.write(abs, origBuf); await files.utimes(abs, st.atimeMs / 1000, st.mtimeMs / 1000); });
      undo.push(() => git.unstage(root, [rel])); // add başarılı olup commit başarısız olsa da gerekir; idempotent
      await git.commitPaths(root, message, [rel]);
      let commit = null;
      try { commit = await git.headCommit(root); } catch (e) { /* aşağıda ele alınır */ }
      if (!commit) {
        undo.push(async () => { throw new Error('commit oluştu ama hash okunamadı, commit geri alınamadı'); });
        throw new Error('commit hash okunamadı');
      }
      undo.push(() => git.undoCommit(root, { commit, parent }));
      await git.createTag(root, tag, cleanNote, commit);
      undo.push(() => git.deleteTag(root, tag));
      const ns = await files.stat(abs);
      undo.clear();
      return { ok: true, path: rel, version: yeni, tag, commit, mtime: Math.round(ns.mtimeMs), raw: out };
    } catch (e) {
      try { await undo.rollback(); } catch (agg) {
        const xs = (agg.errors || [agg]).map((x) => explainGitError(x, [root]));
        const detay = xs.map((x) => (x.code ? x.error.replace(/\.$/, '') : x.error)).join('; ');
        const gitDetail = sanitizeDetail(xs.map((x) => x.gitDetail).filter(Boolean).join('\n'), [root]);
        throw new VersionError(500, 'Sürüm oluşturulamadı ve geri alma tamamlanamadı: ' + detay + '. Git panelinden durumu kontrol et.',
          { rollbackFailed: true, ...(gitDetail ? { gitDetail } : {}) });
      }
      if (e instanceof GitError && e.isIdentityError) {
        throw new VersionError(400, 'Git, commit yazarını bilmiyor. Ad ve e-posta gir. Sürüm oluşturulmadı, değişiklikler geri alındı.', { needIdentity: true });
      }
      if (/already exists/i.test(e.message)) {
        throw new VersionError(409, "Bu sürümün tag'i zaten var: " + tag + '. versiyon alanını kontrol et.', { code: 'tagVar', tag });
      }
      // Ham git hatası Türkçe özete çevrilir; git stderr'i (hook çıktısı dahil) arındırılmış olarak gitDetail'de kalır.
      const x = explainGitError(e, [root]);
      if (x.code) {
        throw new VersionError(500, 'Sürüm oluşturulamadı: ' + x.error + ' Yapılan değişiklikler geri alındı.',
          { gitCode: x.code, ...(x.gitDetail ? { gitDetail: x.gitDetail } : {}) });
      }
      throw new VersionError(500, 'Sürüm oluşturulamadı: ' + e.message + '. Yapılan değişiklikler geri alındı.');
    }
  }
}

module.exports = { VersionService, VersionError };
