'use strict';
/* Prompt bazlı sürüm geçmişi. Git komutu bilmez; yalnızca GitService metotlarını çağırır.
 * Tag -> dosya eşlemesi dosyaya yazılmaz: her istekte git'ten hesaplanır, `dir` (marketplace klasörü) anahtarıyla
 * bellekte önbelleklenir (dir|HEAD|tag parmak izi|yol). Library kökü değişince clear() çağrılır. */

const crypto = require('crypto');
const { toList } = require('./prompt-index');
const { parseWordDiff } = require('./git-service');
const I18n = require('../public/i18n.js');

/** Summary: Geçerli dilde düz metin çevirisi (istek bağlamındaki dil). */
const tx = I18n.tx;

const MAX_TAG_LEN = 250;
const BODY_CAP = 300000;
const COMMITS_CAP = 200;

class HistoryError extends Error {
  constructor(status, code, message) { super(message); this.name = 'HistoryError'; this.status = status; this.code = code; }
}

const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const ts = (d) => { const t = Date.parse(d); return Number.isNaN(t) ? 0 : t; };

// Frontmatter kapanış satırı (1 tabanlı); frontmatter yoksa 0. Bu mantık fm.js ile aynı kuralı izler.
function fmEndLine(p, raw) {
  if (!p || !p.hasFm) return 0;
  const lines = String(raw == null ? '' : raw).replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  for (let i = 1; i < lines.length; i++) if (/^---[ \t]*$/.test(lines[i])) return i + 1;
  return 0;
}

// İki frontmatter meta nesnesi arasındaki alan farkı. Değişmeyen alanlar listeye girmez.
function diffMeta(a, b, canon = []) {
  a = a || {}; b = b || {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const ordered = canon.filter((k) => keys.has(k));
  const rest = [...keys].filter((k) => !canon.includes(k)).sort((x, y) => x.localeCompare(y, 'tr'));
  const fold = (s) => String(s).toLocaleLowerCase('tr').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i');
  const fields = [];
  for (const key of [...ordered, ...rest]) {
    const va = a[key]; const vb = b[key];
    const ea = isEmpty(va); const eb = isEmpty(vb);
    if (ea && eb) continue;
    const kind0 = ea ? 'eklendi' : eb ? 'kaldirildi' : 'degisti';
    if (Array.isArray(va) || Array.isArray(vb)) {
      const la = toList(va); const lb = toList(vb);
      const fa = la.map(fold); const fb = lb.map(fold);
      const added = lb.filter((_, i) => !fa.includes(fb[i]));
      const removed = la.filter((_, i) => !fb.includes(fa[i]));
      if (added.length || removed.length) fields.push({ key, kind: kind0, list: true, from: la, to: lb, added, removed });
      else if (JSON.stringify(fa) !== JSON.stringify(fb)) fields.push({ key, kind: 'sira', list: true, from: la, to: lb, added: [], removed: [] });
      continue;
    }
    if (String(ea ? '' : va) === String(eb ? '' : vb)) continue;
    fields.push({ key, kind: kind0, list: false, from: ea ? null : String(va), to: eb ? null : String(vb) });
  }
  return fields;
}

// Satır başına eski/yeni taraf bilgisi: yalnızca '-' içeren satır eski, yalnızca '+' içeren satır yeni taraftadır.
function lineSides(line) {
  const has = (t) => line.some((x) => x.t === t);
  const minus = has('-'); const plus = has('+'); const eq = has('=');
  if (minus && !plus && !eq) return { old: true, nw: false, changed: true };
  if (plus && !minus && !eq) return { old: false, nw: true, changed: true };
  return { old: true, nw: true, changed: minus || plus };
}

// Frontmatter satırlarını hunk'lardan ayıklar (alanlar ayrı tabloda gösterilir). Gövdede değişen satırı
// olmayan hunk atılır; kalanlar gövde satırlarına göre kırpılır ve başlangıç/uzunluk değerleri yeniden hesaplanır.
function filterBodyHunks(hunks, fmEndA, fmEndB) {
  const out = [];
  for (const h of hunks) {
    let o = h.oldStart; let n = h.newStart;
    if (h.oldLines === 0) o++; // saf ekleme: oldStart kendinden önceki satırdır
    if (h.newLines === 0) n++;
    const kept = []; let changed = false;
    for (const line of h.lines) {
      const s = lineSides(line);
      const inFm = (s.old ? o <= fmEndA : true) && (s.nw ? n <= fmEndB : true);
      if (!inFm) { kept.push({ line, o, n, s }); if (s.changed) changed = true; }
      if (s.old) o++;
      if (s.nw) n++;
    }
    if (!changed) continue;
    const olds = kept.filter((k) => k.s.old); const news = kept.filter((k) => k.s.nw);
    out.push({
      oldStart: olds.length ? olds[0].o : h.oldStart, oldLines: olds.length,
      newStart: news.length ? news[0].n : h.newStart, newLines: news.length,
      lines: kept.map((k) => k.line)
    });
  }
  return out;
}

// Tag'leri bu dosyaya bağlar. commitPath: Map<commit, o commit'teki yol>, adSet: Map<ad, yol>.
function mapTagsToFile(tags, commitPath, adSet) {
  const res = [];
  for (const t of tags) {
    if (!adSet.has(t.ad)) continue;
    const inHistory = commitPath.has(t.commit);
    res.push({ ...t, pathAtTag: inHistory ? commitPath.get(t.commit) : adSet.get(t.ad), inHistory });
  }
  return res;
}

// changeLog (en yeni önce) -> dosya bazlı gruplar; yeniden adlandırma zincirleri tek grupta toplanır.
function groupChangesByFile(commits) {
  const alias = new Map();
  const groups = new Map();
  const grp = (p) => {
    if (!groups.has(p)) groups.set(p, { path: p, oldPaths: [], status: null, count: 0, last: null, commits: [] });
    return groups.get(p);
  };
  for (const c of commits) {
    for (const f of c.files) {
      let canon = alias.get(f.path) || f.path;
      if (f.status === 'R' && f.oldPath) { alias.set(f.oldPath, canon); }
      const g = grp(canon);
      if (f.status === 'R' && f.oldPath && !g.oldPaths.includes(f.oldPath)) g.oldPaths.push(f.oldPath);
      const info = { hash: c.hash, short: c.short, date: c.date, subject: c.subject, author: c.author };
      if (!g.last) { g.last = info; g.status = f.status; }
      g.count++;
      g.commits.push({ ...info, status: f.status, path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}) });
    }
  }
  return [...groups.values()];
}

class PromptHistory {
  constructor({ git, FM, Rules, adOf, maxCache = 50 } = {}) {
    this.git = git; this.FM = FM; this.Rules = Rules;
    this.adOf = adOf || Rules.promptTagAd;
    this.maxCache = maxCache;
    this._cache = new Map();
  }

  clear() { this._cache.clear(); }

  _get(key) {
    if (!this._cache.has(key)) return undefined;
    const v = this._cache.get(key);
    this._cache.delete(key); this._cache.set(key, v);
    return v;
  }

  _put(key, v) {
    this._cache.set(key, v);
    while (this._cache.size > this.maxCache) this._cache.delete(this._cache.keys().next().value);
    return v;
  }

  // { tags: [{ ...listTags, ad, version }], ignored: [ad dışı/geçersiz tag adları], fp }
  async allTags(dir) {
    const raw = await this.git.listTags(dir, this.Rules.PROMPT_TAG_PREFIX);
    const tags = []; const ignored = [];
    for (const t of raw) {
      const p = this.Rules.parsePromptTag(t.name);
      if (p) tags.push({ ...t, ad: p.ad, version: p.version }); else ignored.push(t.name);
    }
    const fp = sha1(raw.map((t) => t.name + '=' + t.object).sort().join('\n'));
    return { tags, ignored, fp };
  }

  async timeline(dir, rel, { libraryDir } = {}) {
    const ad = this.adOf(rel, libraryDir);
    const empty = { path: rel, ad, tracked: false, head: null, versions: [], paths: [], ignoredTags: 0 };
    if (!ad) return empty;
    const hash = await this.git.headCommit(dir);
    if (!hash) return empty;
    const { tags, ignored, fp } = await this.allTags(dir);
    const key = ['T', dir, hash, fp, rel, libraryDir].join('|');
    const hit = this._get(key);
    if (hit) return hit;

    const log = await this.git.log(dir, { path: rel, follow: true, limit: 1000 });
    if (!log.length) return this._put(key, empty);

    const commitPath = new Map(); const adSet = new Map(); const segs = [];
    for (const c of log) { // en yeni önce
      const p = c.path || rel;
      commitPath.set(c.hash, p);
      const last = segs[segs.length - 1];
      if (!last || last.path !== p) {
        const pad = this.adOf(p, libraryDir);
        segs.push({ path: p, ad: pad, until: segs.length ? c.date : null });
        if (pad && !adSet.has(pad)) adSet.set(pad, p);
      }
    }
    // eskiden yeniye; `until`: bu yolun son kullanıldığı commit tarihi, güncel yol için null
    const pathsOut = segs.slice().reverse();
    if (!adSet.has(ad)) adSet.set(ad, rel);

    const mapped = mapTagsToFile(tags, commitPath, adSet);
    const versions = mapped.map((t) => ({
      tag: t.name, version: t.version, ad: t.ad, annotated: t.annotated, date: t.date, tagger: t.tagger,
      subject: t.subject, note: t.body ? t.subject + '\n\n' + t.body : t.subject,
      commit: t.commit, short: t.commit.slice(0, 7),
      pathAtTag: t.pathAtTag, renamed: t.pathAtTag !== rel, inHistory: t.inHistory
    })).sort((x, y) => this.Rules.compareVersions(y.version, x.version) || ts(y.date) - ts(x.date));

    const adList = [...adSet.keys()];
    const ignoredTags = ignored.filter((n) => adList.some((a) => n.startsWith(this.Rules.PROMPT_TAG_PREFIX + a + '/'))).length;
    return this._put(key, {
      path: rel, ad, tracked: true, head: { hash, short: hash.slice(0, 7) },
      versions, paths: pathsOut, ignoredTags
    });
  }

  async resolveRef(dir, rel, ref, { libraryDir } = {}) {
    if (ref === 'HEAD') {
      const hash = await this.git.headCommit(dir);
      if (!hash) throw new HistoryError(404, 'commitYok', tx('hist.err.commitYok'));
      const l = await this.git.log(dir, { limit: 1 });
      return { ref: 'HEAD', version: null, commit: hash, short: hash.slice(0, 7), date: l[0] ? l[0].date : null, pathAtRef: rel };
    }
    const bad = () => new HistoryError(400, 'surumAdiGecersiz', tx('hist.err.surumAdiGecersiz', { ref: String(ref == null ? '' : ref) }));
    const s = String(ref == null ? '' : ref);
    if (!s || s.length > MAX_TAG_LEN || !s.startsWith(this.Rules.PROMPT_TAG_PREFIX) || !this.Rules.parsePromptTag(s)) throw bad();
    const { tags } = await this.allTags(dir);
    if (!tags.some((t) => t.name === s)) throw new HistoryError(404, 'surumYok', tx('hist.err.surumYok', { ref: s }));
    const tl = await this.timeline(dir, rel, { libraryDir });
    const v = tl.versions.find((x) => x.tag === s);
    if (!v) throw new HistoryError(400, 'surumBaskaDosyanin', tx('hist.err.surumBaskaDosyanin', { ref: s }));
    return { ref: s, version: v.version, commit: v.commit, short: v.short, date: v.date, pathAtRef: v.pathAtTag };
  }

  async _raw(dir, r) {
    try { return await this.git.showFile(dir, r.commit, r.pathAtRef); } catch (e) {
      if (e && e.name === 'GitError' && e.code !== 'aracReposu') throw new HistoryError(404, 'dosyaYok', tx('hist.err.dosyaYok'));
      throw e;
    }
  }

  async show(dir, rel, tag, { libraryDir } = {}) {
    const r = await this.resolveRef(dir, rel, tag, { libraryDir });
    const raw = await this._raw(dir, r);
    return { tag: r.ref, version: r.version, commit: r.commit, date: r.date, pathAtTag: r.pathAtRef, raw };
  }

  async compare(dir, rel, a, b, { libraryDir } = {}) {
    const { FM, Rules } = this;
    const ra = await this.resolveRef(dir, rel, a, { libraryDir });
    const rb = await this.resolveRef(dir, rel, b, { libraryDir });
    if (ra.commit === rb.commit && ra.pathAtRef === rb.pathAtRef) throw new HistoryError(400, 'ayniSurum', tx('hist.err.ayniSurum'));
    const [rawA, rawB] = await Promise.all([this._raw(dir, ra), this._raw(dir, rb)]);
    const pA = FM.parse(rawA); const pB = FM.parse(rawB);
    const fmBroken = { a: Rules.isFmBroken(rawA, pA.hasFm), b: Rules.isFmBroken(rawB, pB.hasFm) };
    const fields = diffMeta(FM.meta(pA), FM.meta(pB), FM.CANON);

    let out = await this.git.wordDiff(dir, { hash: ra.commit, path: ra.pathAtRef }, { hash: rb.commit, path: rb.pathAtRef });
    let truncated = false;
    if (out.length > BODY_CAP) { out = out.slice(0, BODY_CAP); truncated = true; }
    let hunks = parseWordDiff(out).hunks;
    if (truncated) hunks = hunks.slice(0, -1); // kesik son hunk atılır
    hunks = filterBodyHunks(hunks, fmEndLine(pA, rawA), fmEndLine(pB, rawB));

    const log = await this.git.log(dir, { path: rb.pathAtRef, follow: true, range: ra.commit + '..' + rb.commit, limit: COMMITS_CAP + 1 });
    const strip = ({ hash, short, author, date, subject, path }) => ({ hash, short, author, date, subject, path });
    return {
      a: ra, b: rb, renamed: ra.pathAtRef !== rb.pathAtRef, fmBroken, fields,
      body: { same: hunks.length === 0, truncated, hunks },
      commits: log.slice(0, COMMITS_CAP).map(strip), commitsTruncated: log.length > COMMITS_CAP
    };
  }

  async changesByFile(dir, { limit = 300, exists } = {}) {
    const commits = await this.git.changeLog(dir, { limit: limit + 1 });
    const hasMore = commits.length > limit;
    const used = commits.slice(0, limit);
    const files = groupChangesByFile(used);
    for (const f of files) f.exists = exists ? !!(await exists(f.path)) : true;
    return { group: 'file', limit, commitCount: used.length, hasMore, files };
  }

  async versionsByPrompt(dir, { libraryDir, currentPaths = [] } = {}) {
    const { tags, ignored, fp } = await this.allTags(dir);
    const byAd = new Map();
    for (const t of tags) { if (!byAd.has(t.ad)) byAd.set(t.ad, []); byAd.get(t.ad).push(t); }
    const current = new Map(); // ad -> yol
    for (const p of currentPaths) { const ad = this.adOf(p, libraryDir); if (ad && !current.has(ad)) current.set(ad, p); }

    let aliasOf = null; // eski ad -> bugünkü yol (yalnızca gerekirse hesaplanır)
    const needAlias = [...byAd.keys()].some((ad) => !current.has(ad));
    if (needAlias) {
      const hash = await this.git.headCommit(dir);
      const key = ['G', dir, hash, fp].join('|');
      let groups = this._get(key);
      if (!groups) groups = this._put(key, groupChangesByFile(await this.git.changeLog(dir, { limit: 3000 })));
      aliasOf = new Map();
      const cur = new Set(currentPaths);
      for (const g of groups) {
        if (!cur.has(g.path)) continue;
        for (const op of g.oldPaths) {
          const ad = this.adOf(op, libraryDir);
          if (ad && !aliasOf.has(ad)) aliasOf.set(ad, g.path);
        }
      }
    }

    const toVer = (t) => ({ tag: t.name, version: t.version, date: t.date, subject: t.subject, annotated: t.annotated, short: t.commit.slice(0, 7) });
    const sortV = (a, b) => this.Rules.compareVersions(b.version, a.version) || ts(b.date) - ts(a.date);
    const prompts = new Map(); const unmatched = [];
    for (const [ad, list] of byAd) {
      const p = current.get(ad) || (aliasOf && aliasOf.get(ad));
      const vers = list.map(toVer);
      if (!p) { unmatched.push({ ad, versions: vers.sort(sortV) }); continue; }
      if (!prompts.has(p)) prompts.set(p, { ad: this.adOf(p, libraryDir), path: p, exists: true, versions: [] });
      prompts.get(p).versions.push(...vers);
    }
    const out = [...prompts.values()].map((x) => {
      x.versions.sort(sortV);
      x.lastDate = x.versions.reduce((m, v) => (ts(v.date) > ts(m) ? v.date : m), x.versions[0].date);
      return x;
    }).sort((x, y) => ts(y.lastDate) - ts(x.lastDate));
    unmatched.sort((x, y) => x.ad.localeCompare(y.ad, 'tr'));
    return { group: 'version', ignoredTags: ignored.length, prompts: out, unmatched };
  }
}

module.exports = { PromptHistory, HistoryError, diffMeta, groupChangesByFile, mapTagsToFile, filterBodyHunks, fmEndLine };
