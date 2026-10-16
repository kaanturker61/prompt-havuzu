'use strict';
/* Kullanıcı ayar dosyası (library kökü ve etkin marketplace). */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { userConfigFile } = require('./paths');

/** Summary: Ayar dosyasının varsayılan değerleri. */
const DEFAULTS = Object.freeze({ version: 1, libraryRoot: '', activeMarketplace: '', remoteCheck: 'acilista', language: 'auto' });
const REMOTE_CHECKS = ['acilista', 'elle'];
/** Summary: Geçerli dil ayarı değerleri (auto = tarayıcı dili). */
const LANGUAGES = Object.freeze(['auto', 'tr', 'en']);

function normalize(raw) {
  const s = (v) => (typeof v === 'string' ? v : '');
  return {
    version: 1, libraryRoot: s(raw.libraryRoot), activeMarketplace: s(raw.activeMarketplace),
    remoteCheck: REMOTE_CHECKS.includes(raw.remoteCheck) ? raw.remoteCheck : 'acilista',
    language: LANGUAGES.includes(raw.language) ? raw.language : 'auto'
  };
}

class ConfigStore {
  constructor({ file }) {
    if (!file) throw new TypeError('Ayar dosyası yolu gerekli');
    this._file = file;
  }

  static defaultFile(env = process.env) { return userConfigFile({ env }); }

  get file() { return this._file; }

  // { config, warning|null }. Bozuk dosyanın üzerine yazılmaz.
  async load() {
    let text;
    try { text = await fsp.readFile(this._file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return { config: { ...DEFAULTS }, warning: null };
      return { config: { ...DEFAULTS }, warning: { file: this._file, detail: e.message } };
    }
    try {
      const raw = JSON.parse(text.replace(/^﻿/, ''));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Nesne bekleniyordu');
      return { config: normalize(raw), warning: null };
    } catch (e) {
      return { config: { ...DEFAULTS }, warning: { file: this._file, detail: e.message } };
    }
  }

  async save(cfg) {
    const data = JSON.stringify(normalize(cfg), null, 2) + '\n';
    await fsp.mkdir(path.dirname(this._file), { recursive: true });
    // Eski dosya bozuksa kaybolmasın diye yedeğini al.
    const prev = await this.load();
    if (prev.warning && !(await missing(this._file))) {
      await fsp.copyFile(this._file, this._file + '.bak');
    }
    const tmp = path.join(path.dirname(this._file), '.' + path.basename(this._file) + '.pp-tmp');
    await fsp.writeFile(tmp, data, 'utf8');
    await fsp.rename(tmp, this._file);
  }
}

async function missing(p) { try { await fsp.access(p); return false; } catch (e) { return true; } }

module.exports = { ConfigStore, DEFAULTS, REMOTE_CHECKS, LANGUAGES };
