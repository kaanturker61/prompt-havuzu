'use strict';
/* Paket sürüm önerisi. Taban: HEAD'den ulaşılabilen en büyük paket/<ad>/vX.Y.Z tag'i; yoksa HEAD'deki plugin.json sürümü.
 * Çıktı, tabandaki plugins/<paket> ağacı ile beklenen çıktı karşılaştırılarak bulunur.
 * Prompt tag'leri yeniden okunmaz: VersionService.tagsByAd ve statusMap kullanılır. */

const I18n = require('../public/i18n.js');

/** Summary: Geçerli dilde düz metin çevirisi (istek bağlamındaki dil). */
const tx = I18n.tx;

// Çıktının frontmatter dışındaki gövdesi (yalnızca açıklama değişti mi ayrımı için).
function bodyOf(text) {
  const t = String(text).replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) return t;
  const end = t.indexOf('\n---\n', 3);
  return end < 0 ? t : t.slice(end + 5);
}

class VersionAdvisor {
  constructor({ git, versions, exporter, Rules, FM }) {
    this.git = git;
    this.versions = versions;
    this.exporter = exporter;
    this.Rules = Rules;
    this.FM = FM;
  }

  // { kind: 'tag'|'head'|null, version, commit, tag, tags: [{name, version, commit, date}] }
  async base(root, paket) {
    const { Rules, git } = this;
    const head = await git.headCommit(root);
    const all = [];
    for (const t of await git.listTags(root, Rules.PACKAGE_TAG_PREFIX + paket + '/')) {
      const p = Rules.parsePackageTag(t.name);
      if (!p || p.ad !== paket) continue;
      all.push({ name: t.name, version: p.version, commit: t.commit, date: t.date });
    }
    all.sort((a, b) => Rules.compareVersions(b.version, a.version));
    const out = { kind: null, version: '', commit: head, tag: null, tags: all, head, headVersion: null };
    if (!head) return out;
    const pj = await git.showAt(root, head, `plugins/${paket}/.claude-plugin/plugin.json`);
    if (pj) {
      let v = '';
      try { v = String(JSON.parse(pj).version || ''); } catch (e) { /* bozuk */ }
      if (v && Rules.SEMVER_RE.test(v)) out.headVersion = v;
    }
    for (const t of all) {
      if (await git.isAncestor(root, t.commit, head)) { out.kind = 'tag'; out.version = t.version; out.commit = t.commit; out.tag = t.name; return out; }
    }
    if (out.headVersion) { out.kind = 'head'; out.version = out.headVersion; out.commit = head; }
    return out;
  }

  /* pkg: PackageCatalog paketi; cfg: pp.config. Dönüş: analiz (yayın ekranı ve publish bunu kullanır). */
  async analyze(root, pkg, cfg) {
    const { Rules, git, FM } = this;
    const base = await this.base(root, pkg.name);
    const prompts = [];
    const reasons = [];
    const expectedTargets = new Set(pkg.prompts.map((p) => p.target));

    let baseFiles = [];
    if (base.kind) {
      baseFiles = (await git.lsTree(root, base.commit, `plugins/${pkg.name}`))
        .filter((f) => /^plugins\/[^/]+\/(commands|agents)\/[^/]+\.md$/.test(f) || /^plugins\/[^/]+\/skills\/[^/]+\/SKILL\.md$/.test(f));
    }
    const byAd = await this.versions.tagsByAd(root);
    const vmap = await this.versions.statusMap(root, cfg.libraryDir).catch(() => new Map());

    for (const p of pkg.prompts) {
      const row = {
        source: p.source, baslik: p.baslik, tur: p.tur, ad: p.ad, target: p.target, durum: p.durum,
        versiyon: p.versiyon, oldVersiyon: '', change: 'yeni', level: null, tagged: null, issues: p.issues.slice()
      };
      const c = Rules.coerceVersion(p.versiyon);
      const tagAd = Rules.promptTagAd(p.source, cfg.libraryDir);
      if (c && c.version) {
        const e = tagAd && byAd.get(tagAd);
        row.tagged = !!(e && e.tags.some((t) => t.version === c.version)) && vmap.get(p.source) !== 'surumGuncelDegil';
      }
      if (base.kind) {
        const old = await git.showAt(root, base.commit, p.target);
        if (old === null) { row.change = 'yeni'; row.level = 'kucuk'; }
        else if (old.replace(/\r\n/g, '\n') === p.expected) row.change = 'ayni';
        else {
          row.change = 'degisti';
          const oldSrc = await git.showAt(root, base.commit, p.source);
          if (oldSrc !== null) row.oldVersiyon = str(FM.meta(FM.parse(oldSrc)).versiyon);
          const lv = Rules.levelBetween(row.oldVersiyon, p.versiyon);
          if (lv) row.level = lv;
          else if (bodyOf(old) === bodyOf(p.expected)) row.level = 'yama';
          else {
            row.level = 'yama';
            row.issues.push({ code: 'surumArtirilmamis', level: 'warn', msg: Rules.MSG.surumArtirilmamis(p.versiyon || tx('ver.adv.bos')) });
          }
        }
      } else {
        row.level = null;
      }
      prompts.push(row);
    }

    const removed = [];
    for (const f of baseFiles) if (!expectedTargets.has(f)) removed.push({ target: f, level: 'buyuk' });

    // Açıklama değişikliği (yalnızca açıklama değiştiyse yama)
    let descChanged = false;
    if (base.kind) {
      const pj = await git.showAt(root, base.commit, `plugins/${pkg.name}/.claude-plugin/plugin.json`);
      let old = '';
      try { old = pj ? String(JSON.parse(pj).description || '') : ''; } catch (e) { /* bozuk */ }
      const want = String(((cfg.packages || {})[pkg.name] || {}).description || '').trim();
      descChanged = !!want && !!pj && old !== want;
    }

    const changed = prompts.filter((p) => p.change !== 'ayni');
    const levels = changed.map((p) => p.level).concat(removed.map((r) => r.level));
    if (descChanged && !levels.length) levels.push('yama');
    const level = Rules.maxLevel(levels);
    const hasChange = changed.length > 0 || removed.length > 0 || descChanged;

    const out = { base, prompts, removed, level: null, version: null, tagOnly: false, noChange: false, reasons, descChanged };
    if (!base.kind) {
      out.version = Rules.DEFAULT_VERSION;
      reasons.push(tx('ver.adv.ilkYayin'));
    } else if (!hasChange) {
      if (base.kind === 'head') {
        out.tagOnly = true; out.version = base.version;
        reasons.push(tx('ver.adv.sadeceEtiket'));
      } else {
        out.noChange = true;
        reasons.push(tx('ver.adv.degisiklikYok'));
      }
    } else {
      out.level = level;
      out.version = Rules.bumpVersion(base.version, level);
      const n = (c) => changed.filter((p) => p.change === c).length;
      if (n('yeni')) reasons.push(tx('ver.adv.yeniDosya', { count: n('yeni') }));
      if (n('degisti')) reasons.push(tx('ver.adv.degisenDosya', { count: n('degisti') }));
      if (removed.length) reasons.push(tx('ver.adv.kaldirilanDosya', { count: removed.length }));
      if (descChanged) reasons.push(tx('ver.adv.aciklamaDegisti'));
      // Sürüm bileşeni üst sınıra (999999999) dayandıysa öneri üretilemez: version boş kalır, sürüm elle belirlenir.
      if (!out.version) reasons.push(tx('ver.adv.surumSinir'));
    }
    return out;
  }

  /* Seçilen sürümü doğrular. Dönüş: null | { code, status, message } */
  validateChoice(analysis, version) {
    const { Rules } = this;
    if (analysis.noChange) return { code: 'degisiklikYok', status: 409, message: tx('ver.adv.yayinlanacakYok') };
    const err = Rules.checkVersion(version);
    if (err) return { code: 'surumGecersiz', status: 400, message: err };
    const base = analysis.base;
    if (base.kind) {
      const cmp = Rules.compareVersions(version, base.version);
      if (cmp < 0 || (cmp === 0 && !analysis.tagOnly)) {
        return { code: 'surumGeride', status: 400, message: tx('ver.adv.surumGeride', { version: base.version }) };
      }
    }
    return null;
  }
}

const str = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));

module.exports = { VersionAdvisor, bodyOf };
