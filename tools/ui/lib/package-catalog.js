'use strict';
/* Paket kataloğu: promptları paketlere böler ve dışa aktarma planını çıkarır.
 * Kural sırası: resolvePackage -> durumAllowed -> publishCheck -> checkPluginName.
 * Dizin ve meta ayrıştırması PromptIndex'e aittir; burada yeniden yazılmaz. */

const path = require('path');
const { str } = require('./prompt-index');
const I18n = require('../public/i18n.js');

/** Summary: Geçerli dilde düz metin çevirisi (istek bağlamındaki dil). */
const tx = I18n.tx;

// Durumu izinli bir promptta paketin yayınını engelleyen uyarı kodları.
const BLOCKING_SKIP = new Set(['turYok', 'turGecersiz', 'onYuzKapanmamis', 'dosyaBuyuk']);
const PACKAGE_WARN = new Set(['paketUyusmuyor', 'paketCokDegerli']);

/** Summary: Açıklaması boş prompt için tür başına (komut, ajan, skill) tam cümle sözlük anahtarı. */
const EMPTY_DESCRIPTION_KEYS = Object.freeze({
  komut: 'pkg.issue.aciklamaBosKomut',
  ajan: 'pkg.issue.aciklamaBosAjan',
  skill: 'pkg.issue.aciklamaBosSkill'
});

class PackageCatalog {
  // listPrompts: (cfg) => index.listMd(root, cfg.libraryDir, { includeBig: true })
  constructor({ listPrompts, exporter, readIfExists, root, Rules, FM }) {
    this.listPrompts = listPrompts;
    this.exporter = exporter;
    this.readIfExists = readIfExists;
    this.root = root;
    this.Rules = Rules;
    this.FM = FM;
  }

  _pkg(map, name) {
    let p = map.get(name);
    if (!p) { p = { name, prompts: [], excluded: [], issues: [], paths: new Set() }; map.set(name, p); }
    return p;
  }

  // Dönüş: { plans, skipped, orphans, bySource, byTarget, bySkipped, packages: Map, cfg }.
  // plans/skipped/orphans biçimi publishPlan'ınkiyle aynıdır.
  async build(cfg) {
    const { Rules, FM, exporter } = this;
    const items = cfg.libraryOk === false ? [] : await this.listPrompts(cfg);
    const exp = cfg.export || { durumlar: ['kararlı', ''], haricKlasorler: [Rules.INBOX_DIR] };
    const plans = []; const skipped = []; const cands = [];
    const packages = new Map();
    const pathOf = (rel, cl) => (cl.kind === 'paket' ? cfg.libraryDir + '/' + cl.klasor + '/' : rel);

    for (const it of items) {
      const meta = it.meta || {};
      const cl = Rules.classifyPromptPath(it.path, cfg.libraryDir);
      const res = Rules.resolvePackage({
        rel: it.path, libraryDir: cfg.libraryDir, metaPaket: meta.paket,
        defaultPaket: cfg.marketplace.plugin, haricKlasorler: exp.haricKlasorler
      });
      const baseName = path.basename(it.path, path.extname(it.path));
      const pkg = res.paket ? this._pkg(packages, res.paket) : null;
      if (pkg) pkg.paths.add(pathOf(it.path, cl));
      const exclude = (code, level, reason, extra) => {
        const s = { source: it.path, baslik: it.title || path.basename(it.path), code, level, reason, ...(extra || {}) };
        skipped.push(s);
        if (pkg) pkg.excluded.push(s);
        return s;
      };

      if (!res.paket) { exclude(res.code || 'paketDisiKlasor', 'info', tx('pkg.skip.paketDisiKlasor')); continue; }

      const durum = str(meta.durum);
      if (!it.tooBig && !Rules.durumAllowed(durum, exp.durumlar)) {
        exclude('durumHaric', 'info', Rules.MSG.durumHaric(durum.trim(), exp.durumlar));
        continue;
      }
      if (it.tooBig) {
        const s = exclude(it.check.code, it.check.level, it.check.reason);
        cands.push({ s, ad: FM.slug(baseName), paket: res.paket });
        if (BLOCKING_SKIP.has(s.code)) pkg.issues.push({ code: s.code, level: 'error', msg: s.reason, source: it.path });
        continue;
      }
      const tur = Rules.normTur(meta.tur);
      if (!tur) {
        const s = exclude(it.check.code, it.check.level, it.check.reason, it.check.fields ? { fields: it.check.fields } : null);
        if (s.level === 'warn') cands.push({ s, ad: FM.slug(str(Rules.ccValue(meta, 'name', tur)) || baseName), paket: res.paket });
        if (BLOCKING_SKIP.has(s.code)) pkg.issues.push({ code: s.code, level: 'error', msg: s.reason, source: it.path });
        continue;
      }

      const nameVal = str(Rules.ccValue(meta, 'name', tur));
      const ad = FM.slug(nameVal || baseName);
      const target = exporter.targetFor(tur, res.paket, ad);
      const expected = exporter.renderTarget(it, tur, ad);
      const cur = await this.readIfExists(path.join(this.root(), target));
      const issues = [];
      if (Rules.isDeviceName(ad)) issues.push({ code: 'aygitAdi', level: 'error', msg: Rules.MSG.aygitAdi(ad) });
      if (!it.body.trim()) issues.push({ code: 'icerikBos', level: 'error', msg: tx('pkg.issue.icerikBos') });
      if (nameVal && FM.slug(nameVal) === 'adsiz') {
        issues.push({ code: 'adUretilemedi', level: 'warn', msg: Rules.MSG.adUretilemedi(nameVal) });
      }
      if (!str(Rules.ccValue(meta, 'description', tur))) {
        issues.push({
          code: 'aciklamaBos',
          level: tur === 'komut' ? 'info' : 'warn',
          msg: tx(EMPTY_DESCRIPTION_KEYS[tur])
        });
      }
      if (res.code === 'paketUyusmuyor') issues.push({ code: 'paketUyusmuyor', level: 'warn', msg: Rules.MSG.paketUyusmuyor(res.klasor, res.alan) });
      if (res.code === 'paketCokDegerli') issues.push({ code: 'paketCokDegerli', level: 'warn', msg: Rules.MSG.paketCokDegerli });
      plans.push({
        source: it.path, baslik: it.title, tur, paket: res.paket, ad, target, expected, state: exporter.stateOf(cur, expected), issues,
        paketKaynagi: res.kaynak, durum, versiyon: str(meta.versiyon)
      });
    }

    const byTarget = new Map();
    for (const p of plans) {
      if (!byTarget.has(p.target)) byTarget.set(p.target, []);
      byTarget.get(p.target).push(p);
    }
    for (const list of byTarget.values()) {
      if (list.length > 1) {
        for (const p of list) p.issues.push({ code: 'hedefCakisiyor', level: 'error', msg: tx('pkg.issue.hedefCakisiyor', { target: p.target }) });
      }
    }
    for (const p of plans) {
      const pkg = this._pkg(packages, p.paket);
      pkg.prompts.push(p);
      for (const i of p.issues) {
        if (i.level === 'error' || PACKAGE_WARN.has(i.code)) pkg.issues.push({ code: i.code, level: 'error', msg: i.msg, source: p.source });
      }
    }
    for (const pkg of packages.values()) {
      const nameErr = Rules.checkPluginName(pkg.name);
      if (nameErr) pkg.issues.push({ code: 'paketAdiGecersiz', level: 'error', msg: nameErr });
    }

    const scanned = await exporter.scanPluginFiles();
    const expectedTargets = new Set(plans.map((p) => p.target));
    const orphans = scanned.filter((f) => !expectedTargets.has(f.target));
    for (const o of orphans) {
      const mt = /^plugins\/[^/]+\/(?:commands|agents)\/(.+)\.md$/i.exec(o.target) || /^plugins\/[^/]+\/skills\/([^/]+)\/SKILL\.md$/.exec(o.target);
      if (!mt) continue;
      const hit = cands.find((c) => c.s.level === 'warn' && c.ad === FM.slug(mt[1]) && c.paket === FM.slug(o.paket));
      if (hit) o.likelySource = { source: hit.s.source, code: hit.s.code, reason: hit.s.reason };
    }
    return {
      plans, skipped, orphans, packages, scanned, cfg,
      bySource: new Map(plans.map((p) => [p.source, p])),
      byTarget: new Map(plans.map((p) => [p.target, p])),
      bySkipped: new Map(skipped.map((x) => [x.source, x]))
    };
  }

  // Bir paketin plugins/ altında kalan ama kaynağı olmayan çıktıları da dahil, işlenecek tüm paket adları.
  async packageNames(built) {
    const names = new Set(built.packages.keys());
    for (const n of await this.exporter.listPluginDirs()) names.add(n);
    return Array.from(names).sort((a, b) => a.localeCompare(b, 'tr'));
  }

  blocking(pkg) { return pkg ? pkg.issues.filter((i) => i.level === 'error') : []; }
}

module.exports = { PackageCatalog, BLOCKING_SKIP, PACKAGE_WARN };
