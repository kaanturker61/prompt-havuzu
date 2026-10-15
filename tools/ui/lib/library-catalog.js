'use strict';
/* Library kataloğu: tüm geçerli marketplace'leri kapsayan okuma görünümleri (ağaç, arama, facet).
 * Okuma hepsinde, yazma yalnızca etkin marketplace'tedir; bu sınıf hiçbir şey yazmaz. */

const fsp = require('fs').promises;
const path = require('path');
const { str, toList } = require('./prompt-index');

const CONCURRENCY = 4;
const MD_RE = /\.(md|markdown)$/i;
const SEARCH_LIMIT = 300;

// En fazla `limit` görev aynı anda çalışır; sonuçlar giriş sırasındadır.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

const byName = (a, b) => (Number(b.type === 'dir') - Number(a.type === 'dir')) || a.name.localeCompare(b.name, 'tr');
const countMd = (children) => children.reduce((n, c) => n + (c.type === 'dir' ? c.count : (MD_RE.test(c.name) ? 1 : 0)), 0);

class LibraryCatalog {
  constructor({ registry, index, loadConfigAt, versions, Rules, FM, ignore, editable, ttlMs = 3000 }) {
    this.registry = registry;
    this.index = index;
    this.loadConfigAt = loadConfigAt;
    this.versions = versions;
    this.Rules = Rules;
    this.FM = FM;
    this.ignore = ignore instanceof Set ? ignore : new Set(ignore || []);
    this.editable = editable instanceof Set ? editable : new Set(editable || ['.md', '.markdown']);
    this.ttlMs = ttlMs;
    this._disc = null; // { key, at, promise }
  }

  invalidate() { this._disc = null; }

  // registry.discover sonucu ttlMs boyunca önbellekte tutulur. Etkin bayrağı her çağrıda yeniden hesaplanır.
  async marketplaces(libraryRoot, active = '') {
    const now = Date.now();
    let d = this._disc;
    if (!d || d.key !== libraryRoot || now - d.at > this.ttlMs) {
      const promise = this.registry.discover(libraryRoot, '');
      d = { key: libraryRoot, at: now, promise };
      this._disc = d;
      promise.catch(() => { if (this._disc === d) this._disc = null; });
    }
    const res = await d.promise;
    const ignored = res.ignored.filter((i) => i.reason !== 'Araç reposu');
    const items = [];
    for (const it of res.items) {
      items.push({ ...it, active: it.name === active, cfg: it.valid ? await this.loadConfigAt(it.path) : null });
    }
    return { items, ignored };
  }

  /* ------------------------------------------------------------------ ağaç */

  // Dizin ağacı. o.meta verilirse (dir, libraryDir, vmap, items) md dosyalarına meta eklenir; verilmezse eklenmez.
  async _walk(abs, rel, o) {
    let ents;
    try { ents = await fsp.readdir(abs, { withFileTypes: true }); } catch (e) { return []; }
    const out = [];
    for (const e of ents) {
      if (this.ignore.has(e.name)) continue;
      if (e.isSymbolicLink()) continue; // bağlantılar ağaçta görünmez (kök dışına çıkabilir)
      if (!rel && o.skip && o.skip.has(e.name)) continue;
      const childRel = rel ? rel + '/' + e.name : e.name;
      const childAbs = path.join(abs, e.name);
      if (e.isDirectory()) {
        const children = (await this._walk(childAbs, childRel, o)).sort(byName);
        out.push({ type: 'dir', name: e.name, path: childRel, count: countMd(children), children });
      } else if (this.editable.has(path.extname(e.name).toLowerCase())) {
        const n = { type: 'file', name: e.name, path: childRel };
        if (o.meta) await this._addMeta(n, childAbs, o.meta);
        out.push(n);
      }
    }
    return out;
  }

  async _addMeta(n, abs, c) {
    const { Rules, FM } = this;
    try {
      const it = await this.index.indexFile(c.dir, n.path, abs);
      if (it && (it.isMd || it.tooBig)) c.items.push(it);
      if (it && it.isMd) {
        const cl = Rules.classifyPromptPath(n.path, c.libraryDir);
        const alan = str(it.meta.paket);
        n.meta = {
          baslik: str(it.meta.baslik), durum: str(it.meta.durum), tur: Rules.normTur(it.meta.tur),
          uyari: it.check && it.check.level === 'warn' ? it.check.code : '',
          surum: (c.vmap && c.vmap.get(n.path)) || '',
          paketUyusmuyor: cl.kind === 'paket' && !!alan && FM.slug(alan) !== cl.paket
        };
      }
    } catch (err) { /* okunamayan dosya: yalnızca ad */ }
  }

  // Yayın uyarısı: warn seviyeli atlananlar + içeriği boş (error) yayın adayları. Hedef çakışması sayılmaz.
  // Paket klasörüyle uyuşmayan "paket" alanı (durumu dışa aktarılan promptlarda) yayını engellediği için sayılır.
  _publishWarn(items, cfg) {
    const { Rules } = this;
    const exp = (cfg && cfg.export) || null;
    return items.filter((it) => {
      if (it.check && it.check.level === 'warn') return true;
      if (!it.isMd) return false;
      if (Rules.normTur(it.meta.tur) && !it.body.trim()) return true;
      if (!cfg) return false;
      if (exp && !Rules.durumAllowed(str(it.meta.durum), exp.durumlar)) return false;
      const r = Rules.resolvePackage({ rel: it.path, libraryDir: cfg.libraryDir, metaPaket: it.meta.paket, defaultPaket: cfg.marketplace.plugin, haricKlasorler: exp ? exp.haricKlasorler : [] });
      return r.code === 'paketUyusmuyor' || r.code === 'paketCokDegerli';
    }).length;
  }

  async _mpTree(m) {
    const { Rules, FM } = this;
    const base = {
      name: m.name, state: m.valid ? 'hazir' : 'gecersiz', reason: m.reason || null, active: !!m.active,
      libraryDir: null, libraryDirExists: false, hasPpConfig: !!m.hasPpConfig, defaultPlugin: null,
      count: 0, yayinUyari: 0, plugins: [], loose: [], inbox: null, teknik: []
    };
    if (!m.valid) return base;
    const cfg = m.cfg;
    const libDir = cfg.libraryDir;
    const libTop = String(libDir).replace(/\\/g, '/').split('/')[0];
    base.libraryDir = libDir;
    base.defaultPlugin = FM.slug(cfg.marketplace.plugin);

    const vmap = await this.versions.statusMap(m.path, libDir).catch(() => new Map());
    const items = [];
    const libAbs = path.join(m.path, libDir);
    const st = await fsp.stat(libAbs).catch(() => null);
    if (st && st.isDirectory()) {
      base.libraryDirExists = true;
      const top = await this._walk(libAbs, libDir, { meta: { dir: m.path, libraryDir: libDir, vmap, items } });
      for (const n of top.sort(byName)) {
        if (n.type === 'file') { base.loose.push(n); continue; }
        if (n.name === Rules.INBOX_DIR) { base.inbox = n; continue; }
        if (n.name.charAt(0) === '.') continue; // gizli klasör plugin sayılmaz
        const slug = FM.slug(n.name);
        const err = Rules.checkPluginName(slug);
        const pk = cfg.packages || {};
        const pm = pk[slug] || pk[n.name] || {};
        n.slug = slug;
        n.description = str(pm.description);
        n.nameIssue = err ? { level: 'error', message: err }
          : (slug !== n.name ? { level: 'info', message: 'Yayın adı: ' + slug } : null);
        base.plugins.push(n);
      }
      base.plugins.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    }
    base.count = items.filter((it) => it.isMd).length;
    base.yayinUyari = this._publishWarn(items, cfg);

    // Teknik dosyalar: libraryDir ve IGNORE dışındaki her şey, meta hesaplanmadan.
    base.teknik = (await this._walk(m.path, '', { skip: new Set([libTop]) })).sort(byName);
    return base;
  }

  async tree(libraryRoot, active = '') {
    const { items, ignored } = await this.marketplaces(libraryRoot, active);
    const mps = await pool(items, CONCURRENCY, (m) => this._mpTree(m));
    const act = mps.find((m) => m.active);
    return {
      libraryRoot, active, libraryDir: act ? act.libraryDir : null,
      marketplaces: mps, ignored: ignored.map((i) => ({ name: i.name, reason: i.reason }))
    };
  }

  /* ----------------------------------------------------------------- arama */

  async _allItems(libraryRoot, active, { scopeAll, includeBig }) {
    const { items } = await this.marketplaces(libraryRoot, active);
    const valid = items.filter((m) => m.valid);
    return pool(valid, CONCURRENCY, async (m) => {
      let list = await this.index.listMd(m.path, m.cfg.libraryDir, { includeBig });
      if (scopeAll) list = list.concat(await this.index.listMd(m.path, 'plugins', { includeBig }));
      return { m, list };
    });
  }

  // Arama sonucu en çok SEARCH_LIMIT öğe döner; total süzgeçlere uyan tüm eşleşmelerin sayısıdır (truncated: total > limit).
  async searchEx(libraryRoot, active, q, o) {
    const { FM, Rules } = this;
    const lists = await this._allItems(libraryRoot, active, { scopeAll: o.scope === 'all', includeBig: false });
    const tokens = FM.fold(q || '').split(/\s+/).filter(Boolean);
    const tagFilter = toList(o.tags || '').map(FM.fold);
    const res = [];
    for (const { m, list } of lists) {
      for (const it of list) {
        const meta = it.meta;
        if (tagFilter.length && !tagFilter.every((t) => it.fTags.includes(t))) continue;
        if (o.durum && FM.fold(str(meta.durum)) !== FM.fold(o.durum)) continue;
        if (o.tur) {
          const t = Rules.normTur(meta.tur);
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
        const cl = Rules.classifyPromptPath(it.path, m.cfg.libraryDir);
        res.push({
          mp: m.name, plugin: cl.kind === 'paket' ? cl.klasor : null, kind: cl.kind,
          path: it.path, baslik: it.title, etiketler: it.tags, durum: str(meta.durum), tur: Rules.normTur(meta.tur),
          versiyon: str(meta.versiyon), score, snippet, mtime: Math.round(it.mtimeMs)
        });
      }
    }
    res.sort((a, b) => (tokens.length ? b.score - a.score : 0) || b.mtime - a.mtime);
    return { results: res.slice(0, SEARCH_LIMIT), total: res.length, limit: SEARCH_LIMIT, truncated: res.length > SEARCH_LIMIT };
  }

  // Yalnızca sonuç dizisi (eski çağıranlar için); sayım bilgisi gerekiyorsa searchEx kullanılır.
  async search(libraryRoot, active, q, o) {
    return (await this.searchEx(libraryRoot, active, q, o)).results;
  }

  /* ---------------------------------------------------------------- facet'ler */

  async facets(libraryRoot, active = '') {
    const { Rules } = this;
    const lists = await this._allItems(libraryRoot, active, { scopeAll: false, includeBig: true });
    const tags = {}; const durum = {}; const tur = {}; const projeler = {};
    let total = 0; let yayinUyari = 0;
    const yayinUyariByMp = {};
    for (const { m, list } of lists) {
      const n = this._publishWarn(list, m.cfg);
      yayinUyariByMp[m.name] = n;
      yayinUyari += n;
      for (const it of list) {
        if (!it.isMd) continue;
        total++;
        it.tags.forEach((t) => { tags[t] = (tags[t] || 0) + 1; });
        const d = str(it.meta.durum); if (d) durum[d] = (durum[d] || 0) + 1;
        const t = Rules.normTur(it.meta.tur); if (t) tur[t] = (tur[t] || 0) + 1;
        // Mevcut düzenleyici datalist'i için korunur; proje filtresi yoktur.
        toList(it.meta.projeler).forEach((p) => { projeler[p] = (projeler[p] || 0) + 1; });
      }
    }
    const arr = (o) => Object.keys(o).map((k) => ({ name: k, count: o[k] }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'tr'));
    return { total, yayinUyari, yayinUyariByMp, tags: arr(tags), durum: arr(durum), tur: arr(tur), projeler: arr(projeler) };
  }
}

module.exports = { LibraryCatalog, pool, SEARCH_LIMIT };
