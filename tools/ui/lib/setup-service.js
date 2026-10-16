'use strict';
/* Kurulum durumunu değerlendirir (Bölüm A.1). Sonuç önbelleğe alınır. */

const fs = require('fs');
const path = require('path');
const { samePath, isInside } = require('./paths');
const { GitNotFoundError } = require('./git-service');
const { inspectConfigAt } = require('./pp-config');
const { readFailure, failureDetail } = require('./marketplace-registry');
const I18n = require('../public/i18n.js');

/** Summary: Geçerli dilde düz metin çevirisi (istek bağlamındaki dil). */
const tx = I18n.tx;

// Bu kodlardan biri varsa library kökü kullanılamaz veya git yoktur.
const ROOT_BLOCKERS = ['kokAyarlanmadi', 'kokYok', 'kokAracReposunda', 'gitBulunamadi'];

/** Summary: Kurulum sorunu; message okunduğunda geçerli dilde üretilen tembel alıcıdır (önbellekte metin değil kod ve parametre kalır). */
function issueOf(code, level, build, p, action) {
  return { code, level, get message() { return build(); }, path: p || null, action: action || null };
}

/** Summary: Git deposu okunamama nedeninin geçerli dildeki kısa açıklaması. */
function gitWhy(failure) {
  if (failure.code === 'kokDepoDegil') return tx('mp.reason.kokDepoDegil');
  const detail = failureDetail(failure);
  return detail === null ? tx('mp.reason.gitOkunamadi') : detail;
}

/** Summary: Sorun kodundan sözlük anahtarına eşleme. */
const ISSUE_KEYS = Object.freeze({
  ayarDosyasiBozuk: 'setup.ayarDosyasiBozuk',
  kokAyarlanmadi: 'setup.kokAyarlanmadi',
  kokYok: 'setup.kokYok',
  kokAracReposunda: 'setup.kokAracReposunda',
  gitBulunamadi: 'setup.gitBulunamadi',
  kokBaskaDepoda: 'setup.kokBaskaDepoda',
  kokAracReposunuIceriyor: 'setup.kokAracReposunuIceriyor',
  marketplaceYok: 'setup.marketplaceYok',
  marketplaceSecilmedi: 'setup.marketplaceSecilmedi',
  marketplaceBulunamadi: 'setup.marketplaceBulunamadi',
  marketplaceGitYok: 'setup.marketplaceGitYok',
  ppConfigYok: 'setup.ppConfigYok'
});

/** Summary: Sorun kodu ve parametrelerinden geçerli dilde ileti üretir. */
function describeIssue(code, params) {
  if (code === 'marketplaceGitYok' && params.failure) {
    return tx('setup.marketplaceGitYokNeden', { name: params.name, reason: gitWhy(params.failure) });
  }
  return tx(ISSUE_KEYS[code], params);
}

class SetupService {
  constructor({ configStore, registry, git, toolRoot }) {
    this.configStore = configStore;
    this.registry = registry;
    this.git = git;
    this.toolRoot = toolRoot;
    this._state = { ok: false, rootOk: false, libraryRoot: '', activeMarketplace: '', root: null, issues: [] };
    this._dirty = true;
    this._listeners = [];
    this._libListeners = [];
  }

  get current() { return this._state; }

  invalidate() { this._dirty = true; }

  onRootChange(fn) { this._listeners.push(fn); }

  // Yalnızca libraryRoot değişince çağrılır (etkin marketplace değişince çağrılmaz).
  onLibraryChange(fn) { this._libListeners.push(fn); }

  // Kirli ise yeniden değerlendirir.
  async ensure() { return this._dirty ? this.evaluate() : this._state; }

  // Kurulum gerektiren isteklerde ucuz tazelik kontrolü.
  async refreshIfStale() {
    const s = this._state;
    if (s.ok && !fs.existsSync(path.join(s.root, '.git'))) return this.evaluate();
    return this.ensure();
  }

  async evaluate() {
    const next = await this._compute();
    this._dirty = false;
    const prev = this._state.root;
    const prevLib = this._state.libraryRoot;
    this._state = next;
    if (prevLib !== next.libraryRoot) for (const fn of this._libListeners) fn(next.libraryRoot, prevLib);
    if (prev !== next.root) for (const fn of this._listeners) fn(next.root, prev);
    return next;
  }

  async _compute() {
    const { config, warning } = await this.configStore.load();
    const libraryRoot = config.libraryRoot;
    const active = config.activeMarketplace;
    const issues = [];
    const add = (code, level, params, p, action) => issues.push(issueOf(code, level, () => describeIssue(code, params), p, action));
    const done = (root = null) => ({
      ok: !issues.some((i) => i.level === 'error'),
      // Library kökü kullanılabilir mi (ağaç/arama için yeterli; etkin marketplace gerekmez).
      rootOk: !issues.some((i) => ROOT_BLOCKERS.includes(i.code)),
      libraryRoot, activeMarketplace: active,
      root: issues.some((i) => i.level === 'error') ? null : root, issues
    });

    if (warning) add('ayarDosyasiBozuk', 'warn', { file: warning.file }, warning.file, 'ayarlar');

    if (!libraryRoot) {
      add('kokAyarlanmadi', 'error', {}, null, 'ayarlar');
      return done();
    }
    let st = null;
    try { st = fs.statSync(libraryRoot); } catch (e) { /* yok */ }
    if (!st || !st.isDirectory()) {
      add('kokYok', 'error', { path: libraryRoot }, libraryRoot, 'ayarlar');
      return done();
    }
    if (samePath(libraryRoot, this.toolRoot) || isInside(libraryRoot, this.toolRoot)) {
      add('kokAracReposunda', 'error', { path: libraryRoot }, libraryRoot, 'ayarlar');
      return done();
    }
    try { await this.git.version(); } catch (e) {
      add('gitBulunamadi', 'error', {}, null, null);
      return done();
    }

    let top = null;
    try { top = await this.git.toplevel(libraryRoot); } catch (e) { if (e instanceof GitNotFoundError) top = null; }
    if (top && !samePath(top, libraryRoot)) {
      add('kokBaskaDepoda', 'warn', { path: top }, libraryRoot, 'ayarlar');
    }
    if (isInside(this.toolRoot, libraryRoot)) {
      add('kokAracReposunuIceriyor', 'warn', {}, libraryRoot, null);
    }

    if (!active) {
      if (!(await this.registry.hasAnyGitChild(libraryRoot))) {
        add('marketplaceYok', 'error', {}, libraryRoot, 'yeniMarketplace');
      } else {
        add('marketplaceSecilmedi', 'error', {}, libraryRoot, 'marketplaceSec');
      }
      return done();
    }
    const folder = await this.registry.folderOf(libraryRoot, active);
    if (!folder || samePath(folder, this.toolRoot)) {
      add('marketplaceBulunamadi', 'error', { name: active }, path.join(libraryRoot, active), 'marketplaceSec');
      return done();
    }
    const info = await this.git.toplevelInfo(folder);
    if (!info.path || !samePath(info.path, folder)) {
      const failure = fs.existsSync(path.join(folder, '.git')) ? readFailure(info) : null;
      add('marketplaceGitYok', 'error', { name: active, failure }, folder, 'gitBaslat');
      return done();
    }
    const cfgFile = path.join(folder, 'pp.config.json');
    if (!fs.existsSync(cfgFile)) {
      add('ppConfigYok', 'warn', {}, folder, 'ppConfigOlustur');
    } else {
      // Bozuk dosya ya da geçersiz libraryDir kurulumu durdurmaz; okuma varsayılanla sürer, yazma rotaları reddeder.
      for (const i of (await inspectConfigAt(folder)).issues) issues.push(issueOf(i.code, 'warn', () => i.message, cfgFile, null));
    }
    return done(folder);
  }
}

module.exports = { SetupService, ROOT_BLOCKERS };
