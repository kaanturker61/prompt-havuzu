'use strict';
// Aşama 4 arayüz sözleşmesi: X-PP-MP kapsamı, LF satır sonu, eski yayın düğmelerinin kalkması.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('MP_GUARDED yeni korumalı rotaları kapsar; klonlama kapsam dışıdır', () => {
  const m = /const MP_GUARDED = (\/.*\/);/.exec(html);
  assert.ok(m, 'MP_GUARDED bulunamadı');
  const re = new Function('return ' + m[1])();
  for (const u of ['/api/packages', '/api/package?name=x', '/api/package/publish', '/api/git/push', '/api/git/fetch', '/api/git/pull', '/api/git/remotes', '/api/marketplace/update']) {
    assert.ok(re.test(u), u + ' korumalı olmalı');
  }
  for (const u of ['/api/marketplaces/clone', '/api/settings']) assert.ok(!re.test(u), u + ' korumasız olmalı');
});

test('index.html LF satır sonlu; eski prompt bazlı yayın eylemleri kaldırıldı', () => {
  assert.equal(html.includes('\r'), false);
  for (const act of ['mk-publish', 'mk-publish-all', 'mk-unpublish', 'publish-now']) assert.equal(html.includes('"' + act + '"') || html.includes("'" + act + "'"), false, act);
  assert.match(html, /data-act="mk-update"/);
  assert.match(html, /data-act="remote-pull"/);
  assert.match(html, /tx\('ui\.remote\.update'\)/);
  assert.equal(require('../public/lang/tr.js')['ui.remote.update'], 'Güncelle (yalnızca ileri sarma)');
});

test('paket sayfası düzeni: radyo/onay satırı yan yana, açıklama alanı esnek', () => {
  assert.match(html, /\.pkrel \.stack label\.inline \{ display: flex;/);
  assert.match(html, /\.pkrel \.stack input\[type=radio\] \{ width: auto;/);
  assert.match(html, /<label class="grow pkdesc">\$\{esc\(tx\('ui\.fields\.description'\)\)\}<input id="pkDesc"/);
  assert.equal(require('../public/lang/tr.js')['ui.fields.description'], 'Açıklama');
  assert.match(html, /\.pkdesc input \{ flex: 1;/);
});
