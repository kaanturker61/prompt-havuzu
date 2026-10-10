'use strict';
/* Marketplace klasöründeki pp.config.json okuma/yazma. Kök parametreli olduğu için her marketplace için çalışır. */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const Rules = require('../public/rules.js');

const DEFAULTS = {
  libraryDir: 'library',
  marketplace: { name: 'prompt-havuzu', owner: '', plugin: 'benim-promptlarim', description: 'Kişisel prompt havuzu', version: Rules.DEFAULT_VERSION },
  packages: {}
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
  return { ...DEFAULTS, ...c, marketplace, packages: { ...(c.packages || {}) } };
}

async function saveConfigAt(dir, c, atomicWrite) {
  await atomicWrite(configFileAt(dir), JSON.stringify(c, null, 2) + '\n');
}

module.exports = { DEFAULTS, configFileAt, loadConfigAt, saveConfigAt };
