'use strict';
/* Paket yayını: dışa aktar, plugin.json + marketplace.json yaz, commit at, annotated tag at (paket/<ad>/vX.Y.Z).
 * Yayın commit'lenmiş kaynaktan yapılır (kirli kaynak 409). Her adım UndoStack ile geri alınabilir.
 * Push başarısız olursa yerel commit ve tag kalır (pendingTags). Prompt tag'i atmaz (tek yer VersionService.bump). */

const { GitError } = require('./git-service');
const { UndoStack } = require('./undo');
const { BusyError } = require('./op-lock');
const { describeNetError } = require('./net-errors');
const { explainGitError, sanitizeDetail } = require('./git-errors');
const { publishSubject, updateSubject, tagNote } = require('./commit-text');
const I18n = require('../public/i18n.js');

/** Summary: Geçerli dilde düz metin çevirisi (istek bağlamındaki dil). */
const tx = I18n.tx;

/** Summary: İşlem türüne (publish | update) göre hata iletisi üreticileri; ileti çağrı anındaki dilde üretilir. */
const FAIL_MESSAGES = {
  publish: {
    rollback: (detail) => tx('pub.err.publishRollbackFailed', { detail }),
    git: (error) => tx('pub.err.publishFailedGit', { error }),
    plain: (error) => tx('pub.err.publishFailed', { error })
  },
  update: {
    rollback: (detail) => tx('pub.err.updateRollbackFailed', { detail }),
    git: (error) => tx('pub.err.updateFailedGit', { error }),
    plain: (error) => tx('pub.err.updateFailed', { error })
  }
};

/** Summary: Kirli dosya listesini en çok 5 öğeyle birleştirir, fazlası için sonuna ' …' ekler. */
function dirtyList(files) {
  return files.slice(0, 5).join(', ') + (files.length > 5 ? ' …' : '');
}

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
  async _fail(e, undo, kind, root) {
    const roots = root ? [root] : [];
    const messages = FAIL_MESSAGES[kind];
    try { await undo.rollback(); } catch (agg) {
      const xs = (agg.errors || [agg]).map((x) => explainGitError(x, roots));
      const detail = xs.map((x) => x.gitDetail).filter(Boolean).join('\n');
      return new PublishError(500, messages.rollback(xs.map((x) => (x.code ? x.error.replace(/\.$/, '') : x.error)).join('; ')),
        { code: 'rollbackFailed', rollbackFailed: true, ...(detail ? { gitDetail: sanitizeDetail(detail, roots) } : {}) });
    }
    if (e instanceof GitError && e.isIdentityError) {
      return new PublishError(400, tx('pub.err.needIdentity'), { needIdentity: true });
    }
    const x = explainGitError(e, roots);
    if (x.code) {
      return new PublishError(500, messages.git(x.error),
        { code: 'geriAlindi', gitCode: x.code, ...(x.gitDetail ? { gitDetail: x.gitDetail } : {}) });
    }
    return new PublishError(500, messages.plain(e.message), { code: 'geriAlindi' });
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
      if (!(await git.hasCommits(root))) throw new PublishError(409, tx('pub.err.commitYok'), { code: 'commitYok' });
      const built = await this.catalog.build(cfg);
      const pkg = built.packages.get(name);
      if (!pkg) throw new PublishError(404, tx('pub.err.paketYok', { name }));
      const dirty = await git.isClean(root, this._dirtyPaths(cfg, name, pkg));
      if (dirty.length) {
        throw new PublishError(409, tx('pub.err.kirli', { files: dirtyList(dirty) }), { code: 'kirliCalismaAgaci', files: dirty });
      }
      const blocking = this.catalog.blocking(pkg);
      if (blocking.length) throw new PublishError(400, tx('pub.err.dogrulama', { count: blocking.length }), { code: 'dogrulama', issues: blocking });
      if (!pkg.prompts.length) throw new PublishError(409, tx('pub.err.bosPaket'), { code: 'bosPaket' });

      const analysis = await this.advisor.analyze(root, pkg, cfg);
      const v = String(version == null || version === '' ? (analysis.version || '') : version).trim();
      const bad = this.advisor.validateChoice(analysis, v);
      if (bad) throw new PublishError(bad.status, bad.message, { code: bad.code });
      const tag = Rules.packageTag(name, v);
      if (analysis.base.tags.some((t) => t.version === v)) throw new PublishError(409, tx('pub.err.tagVar', { tag }), { code: 'tagVar', tag });

      const curCat = cfg.marketplace.version;
      let catV;
      if (marketplaceVersion == null || marketplaceVersion === '') {
        catV = Rules.bumpVersion(curCat, 'yama');
        if (!catV) throw new PublishError(400, tx('pub.err.katalogSurumYorumlanamadi', { value: curCat }), { code: 'katalogSurumGecersiz' });
      } else {
        catV = String(marketplaceVersion).trim();
        const ce = Rules.checkVersion(catV);
        if (ce) throw new PublishError(400, ce, { code: 'katalogSurumGecersiz' });
        const cur = Rules.coerceVersion(curCat);
        if (cur && cur.version && Rules.compareVersions(catV, cur.version) < 0) {
          throw new PublishError(400, tx('pub.err.katalogSurumKucuk', { version: cur.version }), { code: 'katalogSurumGecersiz' });
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
          await git.commitPaths(root, publishSubject(name, v), paths);
          commit = await git.headCommit(root);
          if (!commit) {
            undo.push(async () => { throw new Error(tx('pub.err.hashUnreadableNoUndo')); });
            throw new Error(tx('pub.err.hashUnreadable'));
          }
          undo.push(() => git.undoCommit(root, { commit, parent }));
        } else {
          commit = parent;
        }
        await git.createTag(root, tag, tagNote(name, v, analysis.prompts, analysis.removed), commit);
        undo.push(() => git.deleteTag(root, tag));
        undo.clear();
      } catch (e) {
        if (/already exists/i.test(e.message)) {
          await undo.rollback().catch(() => {});
          throw new PublishError(409, tx('pub.err.tagVar', { tag }), { code: 'tagVar', tag });
        }
        throw await this._fail(e, undo, 'publish', root);
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
      if (!(await git.hasCommits(root))) throw new PublishError(409, tx('pub.err.commitYok'), { code: 'commitYok' });
      const built = await this.catalog.build(cfg);
      const names = await this.catalog.packageNames(built);
      const srcPaths = [cfg.libraryDir + '/'];
      const dirty = await git.isClean(root, srcPaths);
      if (dirty.length) {
        throw new PublishError(409, tx('pub.err.kirli', { files: dirtyList(dirty) }), { code: 'kirliCalismaAgaci', files: dirty });
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
          await git.commitPaths(root, updateSubject(), paths);
          commit = await git.headCommit(root);
          if (!commit) {
            undo.push(async () => { throw new Error(tx('pub.err.hashUnreadableNoUndo')); });
            throw new Error(tx('pub.err.hashUnreadable'));
          }
          undo.push(() => git.undoCommit(root, { commit, parent }));
        }
        undo.clear();
      } catch (e) {
        throw await this._fail(e, undo, 'update', root);
      }
      this.onChanged(root);
      return {
        ok: true, commit, written, removed, skippedPackages,
        message: commit ? tx('pub.updated') : tx('pub.noChange')
      };
    });
  }
}

module.exports = { PackagePublisher, PublishError, BusyError, describeNetError };
