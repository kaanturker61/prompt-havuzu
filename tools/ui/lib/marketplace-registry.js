'use strict';
/* Library kökündeki marketplace klasörlerini keşfeder. */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { samePath } = require('./paths');
const I18n = require('../public/i18n.js');

/** Summary: Geçerli dilde düz metin çevirisi (istek bağlamındaki dil). */
const tx = I18n.tx;

const BAD_NAME = /[\\/:*?"<>|]|\.\./;

async function exists(p) { try { await fsp.access(p); return true; } catch (e) { return false; } }

/** Summary: toplevelInfo sonucundan dilden bağımsız okuma nedeni çıkarır: { code, detail, emptyResponse } (kök sağlamsa kod kokDepoDegil). */
function readFailure(info) {
  if (info.path) return { code: 'kokDepoDegil', detail: null, emptyResponse: false };
  if (!info.error) return { code: 'gitOkunamadi', detail: null, emptyResponse: false };
  if (info.errorCode === 'bosYanit') return { code: 'gitOkunamadi', detail: null, emptyResponse: true };
  return { code: 'gitOkunamadi', detail: String(info.error).split('\n')[0], emptyResponse: false };
}

/** Summary: Okuma nedeninin ayrıntısı geçerli dilde; ayrıntı yoksa null. */
function failureDetail(failure) {
  return failure.emptyResponse ? tx('git.emptyResponse') : failure.detail;
}

/** Summary: reasonCode ve ayrıntıdan geçerli dilde geçersizlik nedeni üretir; kod bilinmiyorsa null. */
function reasonText(code, failure) {
  switch (code) {
    case 'aracReposu': return tx('mp.reason.aracReposu');
    case 'gitDegil': return tx('mp.reason.gitDegil');
    case 'kokDepoDegil': return tx('mp.reason.kokDepoDegil');
    case 'gitOkunamadi': {
      const detail = failureDetail(failure);
      return detail === null ? tx('mp.reason.gitOkunamadi') : tx('mp.reason.gitOkunamadiDetay', { detail });
    }
    default: return null;
  }
}

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
      if (samePath(dir, this.toolRoot)) { ignored.push({ name, path: dir, get reason() { return reasonText('aracReposu'); }, reasonCode: 'aracReposu' }); continue; }
      if (!(await exists(path.join(dir, '.git')))) { ignored.push({ name, path: dir, get reason() { return reasonText('gitDegil'); }, reasonCode: 'gitDegil' }); continue; }
      const info = await this.git.toplevelInfo(dir);
      const valid = !!info.path && samePath(info.path, dir);
      const failure = valid ? null : readFailure(info);
      const reasonCode = valid ? null : failure.code;
      items.push({
        name, path: dir, valid, get reason() { return valid ? null : reasonText(reasonCode, failure); }, reasonCode, active: name === active,
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

module.exports = { MarketplaceRegistry, readFailure, failureDetail };
