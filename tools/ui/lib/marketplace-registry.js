'use strict';
/* Library kökündeki marketplace klasörlerini keşfeder. */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { samePath } = require('./paths');

const BAD_NAME = /[\\/:*?"<>|]|\.\./;

async function exists(p) { try { await fsp.access(p); return true; } catch (e) { return false; } }

class MarketplaceRegistry {
  constructor({ git, toolRoot }) {
    this.git = git;
    this.toolRoot = toolRoot;
  }

  async _children(libraryRoot) {
    let ents;
    try { ents = await fsp.readdir(libraryRoot, { withFileTypes: true }); } catch (e) { return []; }
    return ents.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name).sort((a, b) => a.localeCompare(b, 'tr'));
  }

  async discover(libraryRoot, active = '') {
    const items = []; const ignored = [];
    for (const name of await this._children(libraryRoot)) {
      const dir = path.join(libraryRoot, name);
      if (samePath(dir, this.toolRoot)) { ignored.push({ name, path: dir, reason: 'Araç reposu', reasonCode: 'aracReposu' }); continue; }
      if (!(await exists(path.join(dir, '.git')))) { ignored.push({ name, path: dir, reason: 'Git deposu değil', reasonCode: 'gitDegil' }); continue; }
      const info = await this.git.toplevelInfo(dir);
      const valid = !!info.path && samePath(info.path, dir);
      let reason = null; let reasonCode = null;
      if (!valid) {
        reasonCode = info.path ? 'kokDepoDegil' : 'gitOkunamadi';
        reason = info.path ? 'Git deposu kökü bu klasör değil' : 'Git deposu okunamadı' + (info.error ? ': ' + info.error.split('\n')[0] : '');
      }
      items.push({
        name, path: dir, valid, reason, reasonCode, active: name === active,
        hasManifest: await exists(path.join(dir, '.claude-plugin', 'marketplace.json')),
        hasPpConfig: await exists(path.join(dir, 'pp.config.json'))
      });
    }
    return { items, ignored };
  }

  async hasAnyGitChild(libraryRoot) {
    for (const name of await this._children(libraryRoot)) {
      const dir = path.join(libraryRoot, name);
      if (samePath(dir, this.toolRoot)) continue;
      if (await exists(path.join(dir, '.git'))) return true;
    }
    return false;
  }

  // Yalnızca 1. seviyedeki, '.' ile başlamayan bir klasör adını kabul eder.
  async folderOf(libraryRoot, name) {
    if (typeof name !== 'string' || !name || name.startsWith('.') || BAD_NAME.test(name)) return null;
    const dir = path.join(libraryRoot, name);
    try { return (await fsp.stat(dir)).isDirectory() ? dir : null; } catch (e) { return null; }
  }
}

module.exports = { MarketplaceRegistry };
