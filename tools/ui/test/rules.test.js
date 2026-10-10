'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Rules = require('../public/rules.js');

test('normTur: eşanlamlılar ve geçersiz değerler', () => {
  for (const [v, e] of [['komut', 'komut'], ['Command', 'komut'], ['slash', 'komut'], ['ajan', 'ajan'], ['Agent', 'ajan'],
    ['subagent', 'ajan'], ['skill', 'skill'], ['beceri', 'skill'], ['komutt', ''], ['', ''], [undefined, ''], [['komut', 'ajan'], '']]) {
    assert.equal(Rules.normTur(v), e, String(v));
  }
});

test('checkVersion: geçerli ve geçersiz', () => {
  assert.equal(Rules.checkVersion('1.0.0'), null);
  assert.equal(Rules.checkVersion('10.2.33'), null);
  assert.equal(Rules.checkVersion(''), 'Sürüm boş olamaz (örnek: 1.0.0)');
  assert.equal(Rules.checkVersion(' '), 'Sürüm boş olamaz (örnek: 1.0.0)');
  for (const v of ['1.0', '01.0.0', '1.0.0-beta', 'v1.0.0']) {
    assert.equal(Rules.checkVersion(v), `Sürüm X.Y.Z biçiminde olmalı (örnek: 1.0.0): "${v}"`, v);
  }
});

test('normalizeVersion', () => {
  assert.equal(Rules.normalizeVersion(''), '1.0.0');
  assert.equal(Rules.normalizeVersion(undefined), '1.0.0');
  assert.equal(Rules.normalizeVersion(' 2.0.1 '), '2.0.1');
  assert.equal(Rules.normalizeVersion('1.0'), '1.0');
});

test('isFmBroken: BOM ve CRLF', () => {
  assert.equal(Rules.isFmBroken('---\nbaslik: A\n', false), true);
  assert.equal(Rules.isFmBroken('﻿---\r\nbaslik: A\r\n', false), true);
  assert.equal(Rules.isFmBroken('---\nbaslik: A\n---\n', true), false);
  assert.equal(Rules.isFmBroken('merhaba\n', false), false);
  assert.equal(Rules.isFmBroken('', false), false);
});

test('publishCheck: tablo', () => {
  const t = [
    [{ meta: {}, hasFm: false }, 'yayinDisi'],
    [{ meta: { komut_adi: 'x' }, hasFm: true }, 'turYok'],
    [{ meta: { tur: 'komutt' } }, 'turGecersiz'],
    [{ meta: { tur: ['komut', 'ajan'] } }, 'turGecersiz'],
    [{ fmBroken: true }, 'onYuzKapanmamis'],
    [{ meta: { tur: 'Command' } }, null],
    [{ meta: { tur: 'komutt' }, fmBroken: true }, 'onYuzKapanmamis']
  ];
  for (const [inp, code] of t) {
    const r = Rules.publishCheck(inp);
    assert.equal(r ? r.code : null, code, JSON.stringify(inp));
  }
  const r = Rules.publishCheck({ meta: { komut_adi: 'x' }, hasFm: true });
  assert.deepEqual(r.fields, ['komut_adi']);
  assert.equal(r.level, 'warn');
  assert.equal(r.reason, 'Yayın alanları dolu (komut_adi) ama "tur" yok. Bu prompt yayınlanmayacak.');
  assert.equal(Rules.publishCheck({ meta: {} }).level, 'info');
});
