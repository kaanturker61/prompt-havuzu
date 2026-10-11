'use strict';
/* Marketplace klasöründeki pp.config.json okuma/yazma. Kök parametreli olduğu için her marketplace için çalışır. */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const Rules = require('../public/rules.js');

const DEFAULTS = {
  libraryDir: 'library',
  marketplace: { name: 'prompt-havuzu', owner: '', plugin: 'benim-promptlarim', description: 'Kişisel prompt havuzu', version: Rules.DEFAULT_VERSION },
  packages: {},
  export: { durumlar: ['kararlı', ''], haricKlasorler: [Rules.INBOX_DIR] }
};

const configFileAt = (dir) => path.join(dir, 'pp.config.json');

// dir yoksa veya dosya okunamıyorsa varsayılanlar. Okurken diske yazılmaz.
async function loadConfigAt(dir) {
  let c = {};
  if (dir) {
    try { c = JSON.parse(await fsp.readFile(configFileAt(dir), 'utf8')); } catch (e) { /* yok: varsayılanlar */ }
  }
  const marketplace = { ...DEFAULTS.marketplace, ...(c.marketplace || {}) };
  marketplace.version = Rules.normalizeVersion(marketplace.version);
  const ex = c.export && typeof c.export === 'object' ? c.export : {};
  const exp = {
    durumlar: Array.isArray(ex.durumlar) ? ex.durumlar.map((x) => String(x == null ? '' : x)) : DEFAULTS.export.durumlar.slice(),
    haricKlasorler: Array.isArray(ex.haricKlasorler) ? ex.haricKlasorler.map(String).filter(Boolean) : DEFAULTS.export.haricKlasorler.slice()
  };
  return { ...DEFAULTS, ...c, marketplace, packages: { ...(c.packages || {}) }, export: exp };
}

async function saveConfigAt(dir, c, atomicWrite) {
  await atomicWrite(configFileAt(dir), JSON.stringify(c, null, 2) + '\n');
}

module.exports = { DEFAULTS, configFileAt, loadConfigAt, saveConfigAt };
