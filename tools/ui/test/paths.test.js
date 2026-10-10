'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { userConfigFile, samePath, isInside, suggestedRoot } = require('../lib/paths');
const { tmpDir, rmrf } = require('./helpers');

test('userConfigFile: win32', () => {
  assert.equal(userConfigFile({ platform: 'win32', env: { APPDATA: 'C:\\Users\\k\\AppData\\Roaming' }, homedir: 'C:\\Users\\k' }),
    'C:\\Users\\k\\AppData\\Roaming\\prompt-havuzu\\config.json');
  assert.equal(userConfigFile({ platform: 'win32', env: {}, homedir: 'C:\\Users\\k' }),
    'C:\\Users\\k\\AppData\\Roaming\\prompt-havuzu\\config.json');
});

test('userConfigFile: darwin', () => {
  assert.equal(userConfigFile({ platform: 'darwin', env: {}, homedir: '/Users/k' }),
    '/Users/k/Library/Application Support/prompt-havuzu/config.json');
  assert.equal(userConfigFile({ platform: 'darwin', env: { XDG_CONFIG_HOME: '/x/cfg' }, homedir: '/Users/k' }),
    '/x/cfg/prompt-havuzu/config.json');
});

test('userConfigFile: linux', () => {
  assert.equal(userConfigFile({ platform: 'linux', env: {}, homedir: '/home/k' }), '/home/k/.config/prompt-havuzu/config.json');
  assert.equal(userConfigFile({ platform: 'linux', env: { XDG_CONFIG_HOME: '/x/cfg' }, homedir: '/home/k' }),
    '/x/cfg/prompt-havuzu/config.json');
});

test('userConfigFile: PP_CONFIG her şeyi geçersiz kılar', () => {
  const f = path.resolve('some', 'c.json');
  assert.equal(userConfigFile({ platform: 'win32', env: { PP_CONFIG: f, APPDATA: 'X' }, homedir: 'H' }), f);
});

test('samePath: büyük/küçük harf, ayraç ve sondaki ayraç (win32 kuralları)', { skip: process.platform !== 'win32' }, () => {
  const ci = { caseInsensitive: true };
  assert.ok(samePath('D:/Foo/Bar', 'd:\\foo\\bar', ci));
  assert.ok(samePath('D:\\Foo\\Bar\\', 'D:\\Foo\\Bar', ci));
  assert.ok(!samePath('D:\\Foo\\Bar', 'D:\\Foo\\Baz', ci));
});

test('samePath: boş girdi ve büyük/küçük harf duyarlı mod', () => {
  assert.ok(!samePath('', path.resolve('/x'), { caseInsensitive: true }));
  assert.ok(samePath(path.resolve('/a/Foo'), path.resolve('/a/foo'), { caseInsensitive: true }));
  assert.ok(!samePath(path.resolve('/a/Foo'), path.resolve('/a/foo'), { caseInsensitive: false }));
});

test('samePath: gerçek yol (olmayan yol için yalnızca resolve)', () => {
  const d = tmpDir();
  try {
    assert.ok(samePath(d, path.join(d, '.')));
    assert.ok(samePath(path.join(d, 'yok', 'x'), path.join(d, 'yok', '..', 'yok', 'x')));
  } finally { rmrf(d); }
});

test('isInside', () => {
  const ci = { caseInsensitive: true };
  const base = path.resolve('/a/b');
  assert.ok(isInside(path.join(base, 'c'), base, ci));
  assert.ok(isInside(path.join(base, 'c', 'd'), base, ci));
  assert.ok(!isInside(base, base, ci), 'eşit yol false');
  assert.ok(!isInside(base + 'c', base, ci), '/a/bc, /a/b içinde sayılmaz');
  assert.ok(!isInside(path.join(base, '..', 'x'), base, ci));
  assert.ok(!isInside(path.resolve('/a'), base, ci));
});

test('suggestedRoot', () => {
  assert.equal(suggestedRoot({ platform: 'win32', exists: () => true }), 'D:\\PromptLibrary');
  assert.equal(suggestedRoot({ platform: 'win32', exists: () => false }), null);
  assert.equal(suggestedRoot({ platform: 'linux', exists: () => true }), null);
});
