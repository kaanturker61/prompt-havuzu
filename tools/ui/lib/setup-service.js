'use strict';
/* Kurulum durumunu değerlendirir (Bölüm A.1). Sonuç önbelleğe alınır. */

const fs = require('fs');
const path = require('path');
const { samePath, isInside } = require('./paths');
const { GitNotFoundError } = require('./git-service');
const { inspectConfigAt } = require('./pp-config');

// Bu kodlardan biri varsa library kökü kullanılamaz veya git yoktur.
const ROOT_BLOCKERS = ['kokAyarlanmadi', 'kokYok', 'kokAracReposunda', 'gitBulunamadi'];

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
    const add = (code, level, message, p, action) => issues.push({ code, level, message, path: p || null, action: action || null });
    const done = (root = null) => ({
      ok: !issues.some((i) => i.level === 'error'),
      // Library kökü kullanılabilir mi (ağaç/arama için yeterli; etkin marketplace gerekmez).
      rootOk: !issues.some((i) => ROOT_BLOCKERS.includes(i.code)),
      libraryRoot, activeMarketplace: active,
      root: issues.some((i) => i.level === 'error') ? null : root, issues
    });

    if (warning) add('ayarDosyasiBozuk', 'warn', 'Ayar dosyası okunamadı, varsayılanlarla devam ediliyor: ' + warning.file, warning.file, 'ayarlar');

    if (!libraryRoot) {
      add('kokAyarlanmadi', 'error', "Library kökü ayarlanmadı. Ayarlar'dan bir klasör seç.", null, 'ayarlar');
      return done();
    }
    let st = null;
    try { st = fs.statSync(libraryRoot); } catch (e) { /* yok */ }
    if (!st || !st.isDirectory()) {
      add('kokYok', 'error', 'Library kökü diskte bulunamadı: ' + libraryRoot, libraryRoot, 'ayarlar');
      return done();
    }
    if (samePath(libraryRoot, this.toolRoot) || isInside(libraryRoot, this.toolRoot)) {
      add('kokAracReposunda', 'error', `Library kökü araç reposunun içinde: ${libraryRoot}. Araç reposunun dışında bir klasör seç.`, libraryRoot, 'ayarlar');
      return done();
    }
    try { await this.git.version(); } catch (e) {
      add('gitBulunamadi', 'error', 'Git bulunamadı. Git kurulu ve PATH içinde olmalı.', null, null);
      return done();
    }

    let top = null;
    try { top = await this.git.toplevel(libraryRoot); } catch (e) { if (e instanceof GitNotFoundError) top = null; }
    if (top && !samePath(top, libraryRoot)) {
      add('kokBaskaDepoda', 'warn', `Library kökü başka bir git deposunun içinde (${top}). Marketplace depoları iç içe depo olarak görünebilir.`, libraryRoot, 'ayarlar');
    }
    if (isInside(this.toolRoot, libraryRoot)) {
      add('kokAracReposunuIceriyor', 'warn', 'Library kökü araç reposunu içeriyor. Araç reposu marketplace olarak kullanılmaz.', libraryRoot, null);
    }

    if (!active) {
      if (!(await this.registry.hasAnyGitChild(libraryRoot))) {
        add('marketplaceYok', 'error', 'Library kökünde hiç marketplace yok. Yeni bir marketplace oluştur.', libraryRoot, 'yeniMarketplace');
      } else {
        add('marketplaceSecilmedi', 'error', 'Marketplace seçilmedi.', libraryRoot, 'marketplaceSec');
      }
      return done();
    }
    const folder = await this.registry.folderOf(libraryRoot, active);
    if (!folder || samePath(folder, this.toolRoot)) {
      add('marketplaceBulunamadi', 'error', 'Seçili marketplace bulunamadı: ' + active, path.join(libraryRoot, active), 'marketplaceSec');
      return done();
    }
    const info = await this.git.toplevelInfo(folder);
    if (!info.path || !samePath(info.path, folder)) {
      let why = '';
      if (fs.existsSync(path.join(folder, '.git'))) {
        why = ' (' + (info.path ? 'Git deposu kökü bu klasör değil' : (info.error || 'Git deposu okunamadı').split('\n')[0]) + ')';
      }
      add('marketplaceGitYok', 'error', `Seçili marketplace'te git başlatılmamış: ${active}${why}`, folder, 'gitBaslat');
      return done();
    }
    const cfgFile = path.join(folder, 'pp.config.json');
    if (!fs.existsSync(cfgFile)) {
      add('ppConfigYok', 'warn', "Bu marketplace'te pp.config.json yok. Prompt Havuzu ayarlarını oluştur.", folder, 'ppConfigOlustur');
    } else {
      // Bozuk dosya ya da geçersiz libraryDir kurulumu durdurmaz; okuma varsayılanla sürer, yazma rotaları reddeder.
      for (const i of (await inspectConfigAt(folder)).issues) add(i.code, 'warn', i.message, cfgFile, null);
    }
    return done(folder);
  }
}

module.exports = { SetupService, ROOT_BLOCKERS };
