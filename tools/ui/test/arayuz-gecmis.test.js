'use strict';
// Geçmiş arayüzü: $ (tek öğe) ile $$ (dizi) karıştırılınca tıklama sessizce TypeError verir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test("$(...) tek öğe döner: dizi metotları $$ ile çağrılmalı", () => {
  const kotu = html.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /(^|[^$\w])\$\((?:'[^']*'|"[^"]*"|`[^`]*`)(?:,\s*[^()]*(?:\([^()]*\))?[^()]*)?\)\.(find|forEach|map|filter|some|every)\b/.test(l));
  assert.deepEqual(kotu.map(([n]) => n), []);
});

test('"Bir öncekiyle karşılaştır": önceki sürüm A, seçili sürüm B olur ve karşılaştırma bölümü bulunur', () => {
  const m = html.match(/function verPick\([\s\S]*?\n}\n/);
  assert.ok(m, 'verPick bulunamadı');
  const vs = [{ tag: 'v3' }, { tag: 'v2' }, { tag: 'v1' }];
  const olay = [];
  const ctx = { S: { cur: { hist: { ver: { data: { versions: vs }, sel: 'v3', a: 'v3', b: 'HEAD', view: { tag: 'v3' } } } } }, paintVer() { olay.push('boya'); }, loadCompare() { olay.push('yukle'); } };
  vm.createContext(ctx);
  vm.runInContext(m[0] + '\nthis.verPick = verPick;', ctx);
  ctx.verPick('v2');
  const v = ctx.S.cur.hist.ver;
  assert.equal(v.sel, 'v2'); assert.equal(v.b, 'v2'); assert.equal(v.a, 'v1'); assert.equal(v.view, null);
  assert.deepEqual(olay, ['boya', 'yukle']);
  assert.match(html, /case 'ver-prev':[^\n]*#verCmp/);
  assert.match(html, /id="verCmp"/);
});
