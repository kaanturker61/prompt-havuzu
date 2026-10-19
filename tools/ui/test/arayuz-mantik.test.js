'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { uiGlobals } = require('./helpers');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const MODAL_LET = 'let modalState = null;';

/** Summary: Üst düzey `function ad(...)` bildirimini (tek satırlık ya da `\n}\n` ile biten) çıkarır. */
function fnSrc(name) {
  const m = new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?\\n\\}\\n', 'm').exec(html);
  assert.ok(m, name + ' bulunamadı');
  return m[0];
}

/** Summary: Tek satırlık `const ad = ...;` tanımını çıkarır. */
function constSrc(name) {
  const m = new RegExp('^const ' + name + ' = .*;[ \\t]*$', 'm').exec(html);
  assert.ok(m, 'const ' + name + ' bulunamadı');
  return m[0];
}

/** Summary: Modal DOM öğelerini taklit eden `$` ve document saplamaları. */
function modalDom(overlayHidden = true) {
  const nodes = { '#overlay': { hidden: overlayHidden }, '#mTitle': { textContent: '' }, '#mBody': { innerHTML: '' }, '.modal': { className: '' } };
  const document = { body: { classList: { add() {}, remove() {} } } };
  return { nodes, $: (sel) => nodes[sel] || null, document };
}

/** Summary: Gerçek openModal / closeModal ile modalState'i dışarı veren vm bağlamı. */
function modalCtx(extra = {}) {
  assert.ok(html.includes('\n' + MODAL_LET + '\n'), 'modalState bildirimi bulunamadı');
  const dom = modalDom();
  const ctx = vm.createContext({ console, $: dom.$, document: dom.document, ...extra });
  vm.runInContext([MODAL_LET, fnSrc('openModal'), fnSrc('closeModal'), 'this.state = () => modalState;'].join('\n'), ctx);
  return { ctx, nodes: dom.nodes };
}

test('openModal: kind modalState içinde saklanır, verilmezse null; closeModal temizler ve onClose çağırır', () => {
  const { ctx, nodes } = modalCtx();
  let closed = 0;
  ctx.openModal({ title: 'Ayarlar', html: '<p></p>', kind: 'settings', onClose: () => { closed++; } });
  assert.equal(ctx.state().kind, 'settings');
  assert.equal(nodes['#overlay'].hidden, false);
  assert.equal(nodes['#mTitle'].textContent, 'Ayarlar');
  ctx.closeModal();
  assert.equal(ctx.state(), null);
  assert.equal(closed, 1);
  ctx.openModal({ title: 'Ayarlar', html: '' });
  assert.equal(ctx.state().kind, null, 'başlık metni pencere türünü belirlemez');
  ctx.openModal({ title: 'Başka', html: '', kind: 'settings' });
  assert.equal(ctx.state().kind, 'settings', 'açık pencerenin üstüne açılan pencere kendi türünü taşır');
  ctx.openModal({ title: 'Ayarlar', html: '' });
  assert.equal(ctx.state().kind, null);
});

test('openSettings: pencere kind settings ile açılır, başlık ve diğer seçenekler aynı', async () => {
  let opened = null;
  const ctx = vm.createContext({
    console, ...uiGlobals(), get: async (u) => ({ u }), settingsHtml: () => '<x>', fail: (e) => { throw e; },
    openModal: (o) => { opened = o; }, $: () => null
  });
  vm.runInContext(fnSrc('openSettings'), ctx);
  await ctx.openSettings('mk');
  assert.equal(opened.kind, 'settings');
  assert.equal(opened.title, 'Ayarlar');
  assert.equal(opened.wide, true);
  assert.equal(opened.noFocus, true);
  assert.equal(opened.html, '<x>');
  assert.equal(typeof opened.onClose, 'function');
  assert.equal(typeof opened.onMount, 'function');
});

/** Summary: mkGitInit'i verilen modalState ve #overlay durumuyla çalıştırır; günlük sıralı çağrıları tutar. */
function gitInitCtx({ overlayHidden = false, state = null, title = '', answer = 'yes', apiError = null } = {}) {
  const log = [];
  const dom = modalDom(overlayHidden);
  dom.nodes['#mTitle'].textContent = title;
  const ctx = vm.createContext({
    console, ...uiGlobals(), $: dom.$, document: dom.document,
    askChoice: async () => { log.push('askChoice'); return answer; },
    api: async (method, url, body) => { log.push(method + ' ' + url + ' ' + body.name); if (apiError) throw apiError; return { ok: true }; },
    reloadState: async () => { log.push('reloadState'); },
    toast: () => {},
    fail: (e) => log.push('fail:' + e.message),
    openSettings: (section) => log.push('openSettings:' + section)
  });
  vm.runInContext([MODAL_LET, fnSrc('mkGitInit'), 'this.setState = (s) => { modalState = s; };'].join('\n'), ctx);
  ctx.setState(state);
  return { ctx, log };
}

test('mkGitInit: Ayarlar penceresine dönüş modal türüne bağlı, başlık metnine değil', async () => {
  let f = gitInitCtx({ state: { kind: 'settings' }, title: 'Başka bir başlık' });
  await f.ctx.mkGitInit('b', false);
  assert.deepEqual(f.log, ['POST /api/marketplaces/git-init b', 'reloadState', 'openSettings:mk']);

  f = gitInitCtx({ state: { kind: null }, title: 'Ayarlar' });
  await f.ctx.mkGitInit('b', false);
  assert.deepEqual(f.log, ['POST /api/marketplaces/git-init b', 'reloadState'], 'başlığı Ayarlar olan başka pencere sayılmaz');

  f = gitInitCtx({ state: null, title: 'Ayarlar' });
  await f.ctx.mkGitInit('b', false);
  assert.deepEqual(f.log, ['POST /api/marketplaces/git-init b', 'reloadState']);

  f = gitInitCtx({ overlayHidden: true, state: { kind: 'settings' } });
  await f.ctx.mkGitInit('b', false);
  assert.deepEqual(f.log, ['POST /api/marketplaces/git-init b', 'reloadState'], 'pencere kapalıysa dönüş yok');
});

test('mkGitInit: Ayarlar içinden vazgeçilirse ve hata olursa Ayarlar yeniden açılır; dışarıdan açılmaz', async () => {
  let f = gitInitCtx({ state: { kind: 'settings' }, answer: 'no' });
  await f.ctx.mkGitInit('b', true);
  assert.deepEqual(f.log, ['askChoice', 'openSettings:mk']);

  f = gitInitCtx({ state: null, answer: 'no' });
  await f.ctx.mkGitInit('b', true);
  assert.deepEqual(f.log, ['askChoice']);

  f = gitInitCtx({ state: { kind: 'settings' }, apiError: new Error('patladı') });
  await f.ctx.mkGitInit('b', false);
  assert.deepEqual(f.log, ['POST /api/marketplaces/git-init b', 'fail:patladı', 'openSettings:mk']);

  f = gitInitCtx({ state: null, apiError: new Error('patladı') });
  await f.ctx.mkGitInit('b', false);
  assert.deepEqual(f.log, ['POST /api/marketplaces/git-init b', 'fail:patladı']);

  f = gitInitCtx({ state: { kind: 'settings' } });
  await f.ctx.mkGitInit('', false);
  assert.deepEqual(f.log, [], 'ad yoksa hiçbir şey yapılmaz');
});

test('Ayarlar akışı: gerçek openSettings + openModal + mkGitInit birlikte', async () => {
  const log = [];
  const dom = modalDom();
  const ctx = vm.createContext({
    console, ...uiGlobals(), $: (sel) => (sel === '#setRootForm' ? { addEventListener() {} } : dom.$(sel)), document: dom.document,
    get: async () => ({}), settingsHtml: () => '', fail: (e) => log.push('fail:' + e.message),
    askChoice: async () => 'yes', api: async (m, u, b) => { log.push(m + ' ' + u + ' ' + b.name); return {}; },
    reloadState: async () => {}, toast: () => {}
  });
  vm.runInContext([MODAL_LET, fnSrc('openModal'), fnSrc('closeModal'), fnSrc('openSettings'), fnSrc('mkGitInit')].join('\n'), ctx);
  await ctx.openSettings();
  assert.equal(dom.nodes['#overlay'].hidden, false);
  await ctx.mkGitInit('b', false);
  assert.deepEqual(log, ['POST /api/marketplaces/git-init b']);
  assert.equal(dom.nodes['#overlay'].hidden, false, 'Ayarlar yeniden açıldı');
  assert.equal(dom.nodes['#mTitle'].textContent, 'Ayarlar');
  ctx.openModal({ title: 'Ayarlar', html: '' });
  log.length = 0;
  await ctx.mkGitInit('c', false);
  assert.deepEqual(log, ['POST /api/marketplaces/git-init c']);
  assert.equal(dom.nodes['#mTitle'].textContent, 'Ayarlar');
});

/** Summary: mkRowHtml'i yalnızca esc bağımlılığıyla çalıştırır. */
function rowFn() {
  const ctx = vm.createContext({ console, ...uiGlobals() });
  vm.runInContext([constSrc('esc'), fnSrc('mkRowHtml'), 'this.row = mkRowHtml;'].join('\n'), ctx);
  return ctx.row;
}

test('mkRowHtml: araç reposu satırı reasonCode ile tanınır, ileti metni belirleyici değil', () => {
  const row = rowFn();
  const tool = row({ name: 'arac', path: '/l/arac', reason: 'Tool repository', reasonCode: 'aracReposu' }, 'ignored');
  assert.match(tool, /class="mkrow dim"/);
  assert.doesNotMatch(tool, /data-act="mk-activate"|data-act="mk-git-init"/);

  const lookalike = row({ name: 'x', path: '/l/x', reason: 'Araç reposu', reasonCode: 'gitDegil' }, 'ignored');
  assert.match(lookalike, /class="mkrow "/);
  assert.match(lookalike, /data-act="mk-activate"/);
  assert.match(lookalike, /data-act="mk-git-init"/);
  assert.match(lookalike, /<span class="pill warn">Araç reposu<\/span>/, 'görünen ileti reason alanından gelir');

  const plain = row({ name: 'b', path: '/l/b', reason: 'Git deposu değil', reasonCode: 'gitDegil' }, 'ignored');
  assert.match(plain, /<span class="pill warn">Git deposu değil<\/span>/);
  assert.match(plain, /data-act="mk-git-init"/);

  const item = row({ name: 'a', path: '/l/a', valid: true, reason: null, reasonCode: null, active: false, hasManifest: true, hasPpConfig: true }, 'item');
  assert.match(item, /data-act="mk-activate"/);
  assert.doesNotMatch(item, /mk-git-init|dim/);
  const bad = row({ name: 'c', path: '/l/c', valid: false, reason: 'Git deposu okunamadı', reasonCode: 'gitOkunamadi', active: false, hasManifest: true }, 'item');
  assert.match(bad, /geçersiz: Git deposu okunamadı/);
  assert.match(bad, /data-act="mk-activate"/);
});

test('rowHtml: plugin yayın adı ipucunu küçük harfe geçerli dilin yerel ayarıyla çevirir', () => {
  const g = uiGlobals({ browser: true });
  const ctx = vm.createContext({
    console, ...g, S: { cur: null, sel: null }, ICON: {}, menuItemsFor: () => [], mpByName: () => null, durumClass: () => ''
  });
  vm.runInContext([constSrc('esc'), constSrc('isFileKind'), fnSrc('rowHtml'), fnSrc('hueOf'), 'this.rowHtml = rowHtml;'].join('\n'), ctx);
  const plugin = (issue) => ({
    kind: 'plugin', level: 2, posinset: 1, setsize: 1, key: 'mp:p', mp: 'mp', path: 'prompts/p', expandable: false, expanded: false,
    node: { name: 'p', count: 1, nameIssue: issue }
  });
  const info = plugin({ level: 'info', message: 'IŞIK' });
  g.I18n.setLanguage('tr');
  assert.match(ctx.rowHtml(info, ''), /<span class="pill" title="IŞIK">ışık<\/span>/);
  g.I18n.setLanguage('en');
  assert.match(ctx.rowHtml(info, ''), /<span class="pill" title="IŞIK">işik<\/span>/);
  g.I18n.setLanguage('tr');
  assert.match(ctx.rowHtml(plugin({ level: 'info', message: 'Yayın adı: kod-inceleme' }), ''), />yayın adı: kod-inceleme<\/span>/);
  assert.match(ctx.rowHtml(plugin({ level: 'error', message: 'Hata' }), ''), /<span class="pill bad" title="Hata">!<\/span>/);
});
