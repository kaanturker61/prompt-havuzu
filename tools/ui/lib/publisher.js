'use strict';
/* Paket yayını: dışa aktar, plugin.json + marketplace.json yaz, commit at, annotated tag at (paket/<ad>/vX.Y.Z).
 * Yayın commit'lenmiş kaynaktan yapılır (kirli kaynak 409). Her adım UndoStack ile geri alınabilir.
 * Push başarısız olursa yerel commit ve tag kalır (pendingTags). Prompt tag'i atmaz (tek yer VersionService.bump). */

const { GitError } = require('./git-service');
const { UndoStack } = require('./undo');
const { BusyError } = require('./op-lock');
const { describeNetError } = require('./net-errors');
const { explainGitError, sanitizeDetail } = require('./git-errors');

class PublishError extends Error {
  constructor(status, message, data) {
    super(message);
    this.name = 'PublishError';
    this.status = status;
    if (data) this.data = data;
  }
}

class PackagePublisher {
  // guard(rels): isteğe bağlı; çıktı klasörlerinin (plugins/, .claude-plugin/) ve yazılacak dosyaların (rels) kök dışına bağlanmadığını
  // doğrular, yazmadan önce hata fırlatır (hata 400 olarak aynen yayılır).
  constructor({ git, catalog, exporter, manifests, advisor, state, lock, remoteSync, config, Rules, FM, guard = null, onChanged = () => {} }) {
    this.git = git;
    this.catalog = catalog;
    this.exporter = exporter;
    this.manifests = manifests;
    this.advisor = advisor;
    this.state = state;
    this.lock = lock;
    this.remoteSync = remoteSync;
    this.config = config; // { load(), save(cfg, undo) }
    this.Rules = Rules;
    this.FM = FM;
    this.guard = guard;
    this.onChanged = onChanged;
  }

  _dirtyPaths(cfg, pkgName, pkg) {
    const paths = Array.from(pkg ? pkg.paths : []);
    return paths.concat([`plugins/${pkgName}`, '.claude-plugin/marketplace.json', 'pp.config.json']);
  }

  // Ham git hataları Türkçe özete çevrilir (gitCode); git stderr'i arındırılmış olarak gitDetail'de kalır (hook çıktısı kaybolmaz).
  async _fail(e, undo, prefix, root) {
    const roots = root ? [root] : [];
    try { await undo.rollback(); } catch (agg) {
      const xs = (agg.errors || [agg]).map((x) => explainGitError(x, roots));
      const detail = xs.map((x) => x.gitDetail).filter(Boolean).join('\n');
      return new PublishError(500, prefix + ' başarısız ve geri alma tamamlanamadı: ' + xs.map((x) => (x.code ? x.error.replace(/\.$/, '') : x.error)).join('; ') + '. Git panelinden durumu kontrol et.',
        { code: 'rollbackFailed', rollbackFailed: true, ...(detail ? { gitDetail: sanitizeDetail(detail, roots) } : {}) });
    }
    if (e instanceof GitError && e.isIdentityError) {
      return new PublishError(400, 'Git, commit yazarını bilmiyor. Ad ve e-posta gir. Değişiklikler geri alındı.', { needIdentity: true });
    }
    const x = explainGitError(e, roots);
    if (x.code) {
      return new PublishError(500, prefix + ' başarısız: ' + x.error + ' Yapılan değişiklikler geri alındı.',
        { code: 'geriAlindi', gitCode: x.code, ...(x.gitDetail ? { gitDetail: x.gitDetail } : {}) });
    }
    return new PublishError(500, prefix + ' başarısız: ' + e.message + '. Yapılan değişiklikler geri alındı.', { code: 'geriAlindi' });
  }

  /* Paket sayfası verisi (A.2). built: catalog.build(cfg) sonucu. */
  async details(root, cfg, built, name) {
    const pkg = built.packages.get(name);
    if (!pkg) return null;
    const analysis = await this.advisor.analyze(root, pkg, cfg);
    const dirty = await this.git.isClean(root, this._dirtyPaths(cfg, name, pkg)).catch(() => []);
    const st = await this.state.get(root);
    const last = analysis.base.tags[0] || null;
    const catV = cfg.marketplace.version;
    return { pkg, analysis, dirty, pending: st.pendingTags, last, catalogVersion: { current: catV, proposal: this.Rules.bumpVersion(catV, 'yama') } };
  }

  async publish(root, { name, version, marketplaceVersion, push, remote }) {
    const { Rules, git } = this;
    return this.lock.run(root, 'yaz', async () => {
      const cfg = await this.config.load();
      if (this.guard) await this.guard();
      if (!(await git.hasCommits(root))) throw new PublishError(409, 'Henüz hiç commit yok. Önce Git panelinden ilk commit\'i at.', { code: 'commitYok' });
      const built = await this.catalog.build(cfg);
      const pkg = built.packages.get(name);
      if (!pkg) throw new PublishError(404, 'Paket bulunamadı: ' + name);
      const dirty = await git.isClean(root, this._dirtyPaths(cfg, name, pkg));
      if (dirty.length) {
        throw new PublishError(409, 'Önce bu dosyaları kaydet (commit): ' + dirty.slice(0, 5).join(', ') + (dirty.length > 5 ? ' …' : ''), { code: 'kirliCalismaAgaci', files: dirty });
      }
      const blocking = this.catalog.blocking(pkg);
      if (blocking.length) throw new PublishError(400, 'Paket doğrulanamadı: ' + blocking.length + ' sorun var', { code: 'dogrulama', issues: blocking });
      if (!pkg.prompts.length) throw new PublishError(409, 'Pakette yayınlanacak prompt yok', { code: 'bosPaket' });

      const analysis = await this.advisor.analyze(root, pkg, cfg);
      const v = String(version == null || version === '' ? (analysis.version || '') : version).trim();
      const bad = this.advisor.validateChoice(analysis, v);
      if (bad) throw new PublishError(bad.status, bad.message, { code: bad.code });
      const tag = Rules.packageTag(name, v);
      if (analysis.base.tags.some((t) => t.version === v)) throw new PublishError(409, 'Bu sürümün etiketi zaten var: ' + tag, { code: 'tagVar', tag });

      const curCat = cfg.marketplace.version;
      let catV;
      if (marketplaceVersion == null || marketplaceVersion === '') {
        catV = Rules.bumpVersion(curCat, 'yama');
        if (!catV) throw new PublishError(400, 'Katalog sürümü yorumlanamadı: "' + curCat + '". Marketplace panelinden düzelt.', { code: 'katalogSurumGecersiz' });
      } else {
        catV = String(marketplaceVersion).trim();
        const ce = Rules.checkVersion(catV);
        if (ce) throw new PublishError(400, ce, { code: 'katalogSurumGecersiz' });
        const cur = Rules.coerceVersion(curCat);
        if (cur && cur.version && Rules.compareVersions(catV, cur.version) < 0) {
          throw new PublishError(400, 'Katalog sürümü mevcut sürümden (' + cur.version + ') küçük olamaz', { code: 'katalogSurumGecersiz' });
        }
      }

      const plan = this.exporter.plan(name, pkg.prompts, built.scanned);
      if (this.guard) await this.guard(plan.write.map((w) => w.target).concat(`plugins/${name}/.claude-plugin/plugin.json`));
      const undo = new UndoStack();
      let commit = null; let written = []; let removed = [];
      try {
        ({ written, removed } = await this.exporter.apply(plan, undo));
        await this.manifests.writePluginJson(name, cfg, { version: v }, undo);
        const next = { ...cfg, marketplace: { ...cfg.marketplace, version: catV } };
        await this.config.save(next, undo);
        await this.manifests.writeMarketplace(next, { version: catV }, undo);

        const paths = [`plugins/${name}`, '.claude-plugin/marketplace.json', 'pp.config.json'];
        undo.push(() => git.unstage(root, paths)); // commit başarısız olsa da gerekir; idempotent
        const parent = await git.headCommit(root);
        if ((await git.isClean(root, paths)).length) {
          await git.commitPaths(root, `${name}: ${v} sürümü yayınlandı`, paths);
          commit = await git.headCommit(root);
          if (!commit) {
            undo.push(async () => { throw new Error('commit oluştu ama hash okunamadı, commit geri alınamadı'); });
            throw new Error('commit hash okunamadı');
          }
          undo.push(() => git.undoCommit(root, { commit, parent }));
        } else {
          commit = parent;
        }
        const lines = [];
        for (const p of analysis.prompts) {
          if (p.change === 'yeni') lines.push('+ ' + p.target + ' (yeni)');
          else if (p.change === 'degisti') lines.push('~ ' + p.target + ' (değişti)');
        }
        for (const r of analysis.removed) lines.push('- ' + r.target + ' (kaldırıldı)');
        await git.createTag(root, tag, `${name} ${v}\n\n` + (lines.join('\n') || 'Değişiklik yok, mevcut çıktı etiketlendi.'), commit);
        undo.push(() => git.deleteTag(root, tag));
        undo.clear();
      } catch (e) {
        if (/already exists/i.test(e.message)) {
          await undo.rollback().catch(() => {});
          throw new PublishError(409, 'Bu sürümün etiketi zaten var: ' + tag, { code: 'tagVar', tag });
        }
        throw await this._fail(e, undo, 'Yayın', root);
      }
      this.onChanged(root);

      let pushRes = null;
      if (push) {
        await this.state.addPending(root, tag);
        try { pushRes = await this.remoteSync.push(root, { remote }); } catch (e) {
          pushRes = { ok: false, code: e.data && e.data.code ? e.data.code : 'bilinmiyor', error: e.message };
        }
      }
      return { ok: true, version: v, marketplaceVersion: catV, commit, tag, written, removed, push: pushRes };
    });
  }

  /* Marketplace'i güncelle: tüm paketleri dışa aktarır, marketplace.json yazar. Sürüm artırmaz, tag atmaz, push etmez. */
  async updateAll(root) {
    const { git } = this;
    return this.lock.run(root, 'yaz', async () => {
      const cfg = await this.config.load();
      if (this.guard) await this.guard();
      if (!(await git.hasCommits(root))) throw new PublishError(409, 'Henüz hiç commit yok. Önce Git panelinden ilk commit\'i at.', { code: 'commitYok' });
      const built = await this.catalog.build(cfg);
      const names = await this.catalog.packageNames(built);
      const srcPaths = [cfg.libraryDir + '/'];
      const dirty = await git.isClean(root, srcPaths);
      if (dirty.length) {
        throw new PublishError(409, 'Önce bu dosyaları kaydet (commit): ' + dirty.slice(0, 5).join(', ') + (dirty.length > 5 ? ' …' : ''), { code: 'kirliCalismaAgaci', files: dirty });
      }
      const plans = [];
      const skippedPackages = [];
      for (const name of names) {
        const pkg = built.packages.get(name);
        if (pkg && this.catalog.blocking(pkg).length) { skippedPackages.push({ name, issues: this.catalog.blocking(pkg) }); continue; }
        plans.push(this.exporter.plan(name, pkg ? pkg.prompts : [], built.scanned));
      }
      if (this.guard) await this.guard([].concat(...plans.map((pl) => pl.write.map((w) => w.target))));
      const undo = new UndoStack();
      const written = []; const removed = [];
      let commit = null;
      try {
        for (const plan of plans) {
          const r = await this.exporter.apply(plan, undo);
          written.push(...r.written); removed.push(...r.removed);
        }
        await this.manifests.ensureReadme(cfg, undo);
        await this.manifests.writeMarketplace(cfg, { version: cfg.marketplace.version }, undo);
        const paths = ['plugins', '.claude-plugin/marketplace.json'];
        undo.push(() => git.unstage(root, paths));
        const parent = await git.headCommit(root);
        if ((await git.isClean(root, paths)).length) {
          await git.commitPaths(root, 'Marketplace güncellendi', paths);
          commit = await git.headCommit(root);
          if (!commit) {
            undo.push(async () => { throw new Error('commit oluştu ama hash okunamadı, commit geri alınamadı'); });
            throw new Error('commit hash okunamadı');
          }
          undo.push(() => git.undoCommit(root, { commit, parent }));
        }
        undo.clear();
      } catch (e) {
        throw await this._fail(e, undo, 'Güncelleme', root);
      }
      this.onChanged(root);
      return {
        ok: true, commit, written, removed, skippedPackages,
        message: commit ? 'Marketplace güncellendi' : 'Değişiklik yok'
      };
    });
  }
}

module.exports = { PackagePublisher, PublishError, BusyError, describeNetError };
