'use strict';
// Ayarlar penceresi: klasör yoksa "Oluştur" onayı sonrası create:true isteği gitmeli.
// Onay penceresi ayar penceresini kapattığı için #setRoot artık yoktur; değer parametreyle taşınmalı.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { uiGlobals } = require('./helpers');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const m = html.match(/async function saveRoot\([\s\S]*?\n}\n/);

test('saveRoot kaynağı bulunur', () => { assert.ok(m, 'saveRoot bulunamadı'); });

test('404 notFound sonrası onaylanınca create:true ile aynı yol gönderilir', async () => {
  const calls = [];
  let modalAcik = true; // askChoice ayar penceresini kapatır
  const input = { get value() { if (!modalAcik) throw new TypeError('setRoot yok'); return ' /yok/klasor '; }, focus() {} };
  const ctx = {
    ...uiGlobals(),
    S: { info: { libraryRoot: '', activeMarketplace: '', setup: { ok: false } } },
    $: (s) => (s === '#setRoot' && modalAcik ? input : null),
    showFieldErr() {}, toast() {}, setupOk: () => false, reloadWith() {}, openSettings() {},
    get: async () => ({ libraryRoot: '/yok/klasor', activeMarketplace: '', setup: { ok: false } }),
    askChoice: async () => { modalAcik = false; return 'yes'; },
    api: async (method, url, body) => {
      calls.push(body);
      if (!body.create) { const e = new Error('Klasör bulunamadı'); e.status = 404; e.data = { notFound: true }; throw e; }
      return { ok: true };
    }
  };
  vm.createContext(ctx);
  vm.runInContext(m[0] + '\nthis.saveRoot = saveRoot;', ctx);
  await ctx.saveRoot(false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].create, false);
  assert.equal(calls[1].create, true);
  assert.equal(calls[1].libraryRoot, ' /yok/klasor ');
});
