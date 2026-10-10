'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ConfigStore } = require('../lib/config-store');
const { tmpDir, rmrf } = require('./helpers');

test('dosya yoksa varsayılanlar gelir', async () => {
  const d = tmpDir();
  try {
    const { config, warning } = await new ConfigStore({ file: path.join(d, 'c.json') }).load();
    assert.deepEqual(config, { version: 1, libraryRoot: '', activeMarketplace: '' });
    assert.equal(warning, null);
  } finally { rmrf(d); }
});

test('save/load gidiş-dönüşü ve dizin otomatik oluşur', async () => {
  const d = tmpDir();
  try {
    const f = path.join(d, 'ic', 'ice', 'c.json');
    const s = new ConfigStore({ file: f });
    await s.save({ libraryRoot: 'D:/X', activeMarketplace: 'm' });
    assert.deepEqual((await s.load()).config, { version: 1, libraryRoot: 'D:/X', activeMarketplace: 'm' });
    assert.equal(fs.readdirSync(path.dirname(f)).length, 1, 'tmp dosyası kalmamalı');
  } finally { rmrf(d); }
});

test('bozuk JSON: varsayılanlar + warning, dosya ezilmez; save öncesi .bak alınır', async () => {
  const d = tmpDir();
  try {
    const f = path.join(d, 'c.json');
    fs.writeFileSync(f, '{bozuk');
    const s = new ConfigStore({ file: f });
    const r = await s.load();
    assert.equal(r.config.libraryRoot, '');
    assert.ok(r.warning && r.warning.file === f);
    assert.equal(fs.readFileSync(f, 'utf8'), '{bozuk');
    await s.save({ libraryRoot: 'Y' });
    assert.equal(fs.readFileSync(f + '.bak', 'utf8'), '{bozuk');
    assert.equal((await s.load()).config.libraryRoot, 'Y');
  } finally { rmrf(d); }
});

test('nesne olmayan JSON bozuk sayılır', async () => {
  const d = tmpDir();
  try {
    const f = path.join(d, 'c.json'); fs.writeFileSync(f, '[1]');
    assert.ok((await new ConfigStore({ file: f }).load()).warning);
  } finally { rmrf(d); }
});

test('defaultFile: PP_CONFIG kullanılır', () => {
  const f = path.resolve('x', 'cfg.json');
  assert.equal(ConfigStore.defaultFile({ PP_CONFIG: f }), f);
});
