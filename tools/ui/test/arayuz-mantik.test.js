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

  const item = row({ name: 'a', path: '/l/a', valid: true, reason: null, reasonCode: null, active: false, hasManifest: true }, 'item');
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

test('rowHtml: tek aria-selected satırı; seçim (S.sel) ağaçta varsa açık dosya yalnızca active olur, yoksa açık dosya seçili sayılır', () => {
  const g = uiGlobals({ browser: true });
  const S = { cur: { mp: 'mp', path: 'prompts/p/a.md' }, sel: null, modelMap: new Map() };
  const ctx = vm.createContext({ console, ...g, S, ICON: {}, menuItemsFor: () => [], mpByName: () => null, durumClass: () => '' });
  vm.runInContext([constSrc('esc'), constSrc('isFileKind'), fnSrc('rowHtml'), fnSrc('hueOf'), 'this.rowHtml = rowHtml;'].join('\n'), ctx);
  const file = { kind: 'file', level: 3, posinset: 1, setsize: 2, key: 'mp:prompts/p/a.md', mp: 'mp', path: 'prompts/p/a.md', expandable: false, expanded: false, node: { name: 'a.md', meta: null } };
  const moved = { ...file, key: 'mp:prompts/p/b.md', path: 'prompts/p/b.md', node: { name: 'b.md', meta: null } };
  const selected = (it) => /aria-selected="true"/.test(ctx.rowHtml(it, ''));
  assert.equal(selected(file), true, 'seçim yoksa açık dosya seçili');
  S.sel = { mp: 'mp', key: moved.key }; S.modelMap = new Map([[file.key, file], [moved.key, moved]]);
  assert.deepEqual([selected(file), selected(moved)], [false, true], 'tek seçili satır');
  assert.match(ctx.rowHtml(file, ''), /class="row file active"/, 'açık dosya yine active işaretli');
  S.modelMap = new Map([[file.key, file]]);
  assert.deepEqual([selected(file), selected(moved)], [true, false], 'seçili satır ağaçta yoksa açık dosya seçili sayılır');
});

/** Summary: Taşıma planı işlevlerini örnek kütüphaneyle yükler (alfa etkin: kod, yazi; beta: notlar, Kod; bozuk geçersiz). */
function moveCtx(extra = {}) {
  const plugin = (name, count = 1, description = '') => ({ name, slug: require('../public/fm.js').slug(name), path: 'prompts/' + name, count, description });
  const lib = {
    marketplaces: [
      { name: 'alfa', state: 'hazir', defaultPlugin: 'alfa', libraryDir: 'prompts', plugins: [plugin('kod', 2, 'Kodu inceler'), plugin('yazi')] },
      { name: 'beta', state: 'hazir', defaultPlugin: 'beta', libraryDir: 'prompts', plugins: [plugin('notlar'), plugin('Kod')] },
      { name: 'bozuk', state: 'gecersiz', plugins: [] }
    ]
  };
  const S = { info: { activeMarketplace: 'alfa' }, lib, cur: null, sel: null, focusKey: null, mpOpen: new Set(), lostEdit: null };
  const mpByName = (n) => lib.marketplaces.find((m) => m.name === n) || null;
  const ctx = vm.createContext({
    console, ...uiGlobals(), Rules: require('../public/rules.js'), FM: require('../public/fm.js'), S,
    mpByName, pluginsOf: (n) => (mpByName(n) || { plugins: [] }).plugins, libDirOf: () => 'prompts', activeName: () => S.info.activeMarketplace,
    nodeKey: (mp, rel) => mp + ':' + rel, base: (p) => p.split('/').pop(), ...extra
  });
  const src = [
    ...['moveTargetKey', 'moveTargetDir', 'movePlan', 'dropPlan', 'dropReason', 'placeLabel', 'dropLabel', 'moveFromLabel', 'moveConsequences', 'moveTouchesOpenFile', 'moveLastOpened', 'applyMoveResult', 'runMove'].map(fnSrc),
    constSrc('DND_REASON'), constSrc('lsKey')
  ];
  vm.runInContext(src.join('\n') + '\nthis.fns = { movePlan, dropPlan, dropReason, dropLabel, moveConsequences, runMove, applyMoveResult };', ctx);
  return { S, lib, g: ctx, ...ctx.fns };
}

const PROMPT = (path, mp = 'alfa') => ({ op: 'prompt', mp, path, name: path.split('/').pop() });
const PLUGIN = (name, mp = 'alfa') => ({ op: 'plugin', mp, name, path: 'prompts/' + name, count: 1, hasDesc: false });
const ROW = (kind, mp, extra = {}) => ({ kind, mp, ...extra });

test('dropPlan: bırakma matrisi (kapsayıcıya çözülme, etkisiz, geçersiz hedefler, plugin yalnızca başka marketplace)', () => {
  const { dropPlan } = moveCtx();
  const brief = (p) => (p.ok ? [p.ok, p.fromMp, p.toMp, p.same, p.to.kind, p.to.plugin, p.targetKey] : [p.ok, p.code]);
  const a = PROMPT('prompts/kod/a.md');
  assert.deepEqual(brief(dropPlan(a, ROW('plugin', 'alfa', { node: { name: 'yazi' } }))), [true, 'alfa', 'alfa', true, 'paket', 'yazi', 'alfa:prompts/yazi']);
  assert.deepEqual(brief(dropPlan(a, ROW('plugin', 'alfa', { node: { name: 'kod' } }))), [false, 'same'], 'kendi plugin klasörü etkisiz');
  assert.deepEqual(brief(dropPlan(a, ROW('file', 'alfa', { path: 'prompts/kod/b.md' }))), [false, 'same'], 'dosya satırı kapsayıcıya çözülür');
  assert.deepEqual(brief(dropPlan(a, ROW('file', 'alfa', { path: 'prompts/yazi/x.md' }))), [true, 'alfa', 'alfa', true, 'paket', 'yazi', 'alfa:prompts/yazi']);
  assert.equal(dropPlan(PROMPT('prompts/kod/alt/a.md'), ROW('plugin', 'alfa', { node: { name: 'kod' } })).ok, true, 'alt klasördeki prompt kendi plugin köküne alınır');
  assert.deepEqual(brief(dropPlan(a, ROW('mp', 'alfa'))), [true, 'alfa', 'alfa', true, 'klasorsuz', null, 'alfa:#klasorsuz']);
  assert.deepEqual(brief(dropPlan(PROMPT('prompts/l.md'), ROW('loose', 'alfa'))), [false, 'same']);
  assert.deepEqual(brief(dropPlan(a, ROW('mp', 'beta'))), [true, 'alfa', 'beta', false, 'klasorsuz', null, 'beta:#klasorsuz']);
  assert.deepEqual(brief(dropPlan(a, ROW('inbox', 'beta'))), [true, 'alfa', 'beta', false, 'gelenKutusu', null, 'beta:#gelen']);
  assert.deepEqual(brief(dropPlan(a, ROW('dir', 'alfa'))), [false, 'subfolder']);
  assert.deepEqual(brief(dropPlan(a, ROW('teknik', 'alfa'))), [false, 'technical']);
  assert.deepEqual(brief(dropPlan(a, ROW('tfile', 'alfa'))), [false, 'technical']);
  assert.deepEqual(brief(dropPlan(a, ROW('mp', 'bozuk'))), [false, 'unavailable']);
  assert.deepEqual(brief(dropPlan(a, ROW('gitlessItem', ''))), [false, 'unavailable']);
  const y = PLUGIN('yazi');
  for (const row of [ROW('mp', 'alfa'), ROW('plugin', 'alfa', { node: { name: 'kod' } }), ROW('loose', 'alfa'), ROW('dir', 'alfa')]) assert.deepEqual(brief(dropPlan(y, row)), [false, 'pluginSameMp']);
  const moved = dropPlan(y, ROW('plugin', 'beta', { node: { name: 'notlar' } }));
  assert.deepEqual([moved.ok, moved.op, moved.fromMp, moved.toMp, moved.targetKey, moved.name], [true, 'plugin', 'alfa', 'beta', 'beta:', 'yazi']);
  const clash = dropPlan(PLUGIN('kod'), ROW('mp', 'beta'));
  assert.deepEqual([clash.ok, clash.code, clash.params.name], [false, 'pluginExists', 'kod'], 'hedefte slug aynı plugin var (Kod)');
  assert.equal(dropPlan(y, ROW('mp', 'bozuk')).code, 'unavailable');
});

test('moveConsequences ve dropReason: hedef türüne ve kaynağın etkinliğine göre tam cümleler, iki dilde', () => {
  const x = moveCtx();
  const plan = (src, row) => x.dropPlan(src, row);
  const sameInbox = plan(PROMPT('prompts/kod/a.md'), ROW('inbox', 'alfa'));
  let c = x.moveConsequences(sameInbox);
  assert.ok(c.includes('Gelen kutusundaki promptlar yayınlanmaz.') && c.includes('Commit atılmaz; değişikliği Git panelinden commit edersin.'));
  assert.ok(!c.some((t) => t.includes('"paket" alanı hedefe')), 'gelen kutusunda paket alanına dokunulmaz');
  c = x.moveConsequences(plan(PROMPT('prompts/kod/a.md'), ROW('mp', 'beta')));
  assert.ok(c.includes('"paket" alanı yoksa yayında "beta" plugin\'ine gider.') && c.includes('Git geçmişi ve sürüm tag\'leri "alfa" deposunda kalır.'));
  assert.ok(c.includes('Kaynak, "alfa" içindeki çöp kutusuna (.pp/trash) taşınır.'));
  c = x.moveConsequences({ ...plan(PLUGIN('yazi'), ROW('mp', 'beta')), count: 3, hasDesc: true });
  assert.ok(c.includes('3 prompt taşınır.') && c.includes('Plugin açıklaması da taşınır.') && c.some((t) => t.startsWith('Paket tag\'leri (paket/yazi/…) "alfa" deposunda kalır')));
  x.S.info.activeMarketplace = 'beta';
  c = x.moveConsequences(plan(PROMPT('prompts/kod/a.md', 'alfa'), ROW('mp', 'beta')));
  assert.equal(c[c.length - 1], 'Önce "alfa" etkin marketplace yapılır; açık düzenleyici kapanır.');
  assert.equal(x.dropReason({ code: 'pluginExists', params: { name: 'kod' } }), 'Hedefte aynı adlı bir plugin var: kod');
  assert.equal(x.dropReason({ code: 'same', params: {} }), 'Zaten burada.');
});

test('runMove: onay, kaynağı etkinleştirme, açık dosya kararı ve API sırası; vazgeçilirse istek gitmez; sonuç durumu işler', async () => {
  const log = [];
  const calls = {
    confirmMove: async () => { log.push('confirm'); return calls.answer; },
    activateMarketplace: async (n, o) => { log.push('activate:' + n + ':' + (o && o.quiet)); calls.x.S.info.activeMarketplace = n; calls.x.S.cur = null; return true; },
    confirmDiscard: async () => { log.push('discard'); return calls.keep; },
    api: async (m, u, b) => { log.push(m + ' ' + u + ' ' + JSON.stringify(b)); if (calls.apiError) throw calls.apiError; return calls.reply; },
    fail: (e) => log.push('fail:' + e.message), afterWrite: async () => { log.push('afterWrite'); }, renderMain: () => log.push('renderMain'),
    focusKey: (k) => log.push('focus:' + k), toast: (m) => log.push('toast:' + m), openFile: async (p, o) => { log.push('open:' + p + ':' + o.reload + ':' + o.tab); },
    clearCur: () => { log.push('clearCur'); calls.x.S.cur = null; }, expandParents: (p, mp) => log.push('expand:' + mp + ':' + p),
    expOf: (mp) => (calls.exp[mp] = calls.exp[mp] || new Set()), saveExp: (mp) => log.push('saveExp:' + mp), saveMpOpen: () => {},
    ls: { get: (k) => (calls.lsStore ? calls.lsStore[k] : 'yazi'), set: (k, v) => log.push('ls:' + k + '=' + v) }, exp: {}, answer: true, keep: true, reply: {}
  };
  const x = moveCtx(calls);
  calls.x = x;
  const plan = x.dropPlan(PROMPT('prompts/kod/a.md'), ROW('plugin', 'alfa', { node: { name: 'yazi' } }));

  calls.answer = false;
  assert.equal(await x.runMove(plan), false);
  assert.deepEqual(log, ['confirm'], 'vazgeçilince başka hiçbir şey olmaz');

  log.length = 0; calls.answer = true;
  x.S.cur = { mp: 'alfa', path: 'prompts/kod/a.md', tab: 'raw', dirty: false };
  calls.reply = { ok: true, same: true, to: { mp: 'alfa', path: 'prompts/yazi/a.md', kind: 'paket', plugin: 'yazi' }, renamed: false, paket: { action: 'set', value: 'yazi' } };
  assert.equal(await x.runMove(plan), true);
  assert.equal(log[0], 'confirm'); assert.equal(log[1], 'discard', 'açık dosya taşınıyorsa değişiklik kararı onaydan sonra');
  assert.equal(log[2], 'POST /api/prompts/move {"path":"prompts/kod/a.md","fromMp":"alfa","to":{"mp":"alfa","kind":"paket","plugin":"yazi"}}');
  assert.equal(x.S.cur.path, 'prompts/yazi/a.md'); assert.ok(log.includes('ls:pp.alfa.last=prompts/yazi/a.md'));
  assert.ok(log.includes('open:prompts/yazi/a.md:true:raw'), 'taşınan açık dosya yeni yoldan yeniden açılır');
  assert.ok(log.includes('expand:alfa:prompts/yazi/a.md') && log.includes('focus:alfa:prompts/yazi/a.md'));
  assert.ok(log.includes('toast:Taşındı: alfa › yazi') && log.includes('toast:"paket" alanı "yazi" olarak güncellendi.'));

  log.length = 0; x.S.cur = null; calls.lsStore = { 'pp.alfa.last': 'prompts/kod/a.md' };
  assert.equal(await x.runMove(plan, { confirmed: true }), true);
  assert.ok(log.includes('ls:pp.alfa.last=prompts/yazi/a.md'), 'açık olmayan taşınan prompt aynı marketplace içinde son açılan kaydını yeni yola çeker');
  log.length = 0; calls.lsStore = { 'pp.alfa.last': 'prompts/kod/baska.md' };
  await x.runMove(plan, { confirmed: true });
  assert.ok(!log.some((l) => l.startsWith('ls:pp.alfa.last=')), 'başka dosyayı gösteren kayda dokunulmaz');
  log.length = 0; calls.lsStore = { 'pp.alfa.last': 'prompts/kod/a.md' };
  calls.reply = { ok: true, same: false, to: { mp: 'beta', path: 'prompts/a.md', kind: 'klasorsuz' }, renamed: false, paket: { action: 'keep' } };
  await x.runMove(x.dropPlan(PROMPT('prompts/kod/a.md'), ROW('mp', 'beta')), { confirmed: true });
  assert.ok(log.includes('ls:pp.alfa.last=null'), 'başka marketplace\'e taşınınca son açılan kaydı temizlenir');
  assert.ok(log.some((l) => /^toast:Taşındı: beta › .+\. İki depoda da commit bekleyen değişiklik var\.$/.test(l)), 'marketplace\'ler arası bildirim iki depoyu söyler');
  calls.lsStore = null;

  log.length = 0; calls.keep = false;
  x.S.cur = { mp: 'alfa', path: 'prompts/kod/a.md', tab: 'edit', dirty: true };
  assert.equal(await x.runMove(plan, { confirmed: true }), false);
  assert.deepEqual(log, ['discard'], 'değişiklik sorusunda vazgeçilirse istek gitmez');

  log.length = 0; calls.keep = true; x.S.cur = null;
  const cross = x.dropPlan(PLUGIN('yazi'), ROW('mp', 'beta'));
  x.S.info.activeMarketplace = 'beta';
  calls.exp.alfa = new Set(['prompts/yazi', 'prompts/yazi/alt', 'prompts/kod']);
  calls.reply = { ok: true, plugin: { name: 'yazi', slug: 'yazi', path: 'prompts/yazi' }, moved: 1 };
  assert.equal(await x.runMove(cross, { confirmed: true }), true);
  assert.equal(log[0], 'activate:alfa:true', 'kaynak etkin değilse onaydan sonra sessizce etkinleştirilir');
  assert.equal(log[1], 'POST /api/package/move {"name":"yazi","fromMp":"alfa","toMp":"beta"}');
  assert.deepEqual([...calls.exp.alfa], ['prompts/kod'], 'taşınan plugin ve altındaki açık düğümler kaynaktan düşer');
  assert.deepEqual([...calls.exp.beta].sort(), ['prompts/yazi', 'prompts/yazi/alt']);
  assert.ok(log.includes('ls:pp.alfa.sonPlugin=') && log.includes('focus:beta:prompts/yazi'));
  assert.ok(log.includes('toast:Plugin taşındı: yazi → beta (1 prompt). İki depoda da commit bekleyen değişiklik var.'));
  log.length = 0; x.S.info.activeMarketplace = 'alfa'; x.S.cur = null; calls.lsStore = { 'pp.alfa.last': 'prompts/yazi/z.md' };
  await x.runMove(cross, { confirmed: true });
  assert.ok(log.includes('ls:pp.alfa.last=null'), 'taşınan plugin altındaki son açılan kaydı temizlenir');
  calls.lsStore = null;

  log.length = 0; calls.exp = {};
  calls.apiError = new Error('hata');
  x.S.cur = { mp: 'alfa', path: 'prompts/yazi/z.md', tab: 'edit', dirty: false };
  x.S.info.activeMarketplace = 'alfa';
  assert.equal(await x.runMove(cross, { confirmed: true }), false);
  assert.deepEqual(log, ['discard', 'POST /api/package/move {"name":"yazi","fromMp":"alfa","toMp":"beta"}', 'fail:hata'], 'API hatası toast olarak bildirilir, durum değişmez');
  assert.equal(x.S.cur.path, 'prompts/yazi/z.md');
});

/** Summary: Bir sınıf listesi tutan sahte DOM öğesi (classList, closest, dataset). */
function fakeRow(key, selectors = []) {
  const classes = new Set();
  return {
    dataset: { key }, classes, matches: selectors,
    classList: { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)), contains: (c) => classes.has(c) },
    closest(sel) { return this.matches.some((s) => sel.includes(s)) ? this : null; }
  };
}

test('sürükle-bırak olayları: dragstart/over/leave/drop, geçersizde bırakma yok, dışarıdan dosya engellenir, bayat durum temizlenir', async () => {
  const x = moveCtx();
  const rows = {
    'alfa:prompts/kod/a.md': fakeRow('alfa:prompts/kod/a.md', ['[draggable="true"]', '[data-key]']),
    'alfa:prompts/yazi': fakeRow('alfa:prompts/yazi', ['[draggable="true"]', '[data-key]']),
    'alfa:#teknik': fakeRow('alfa:#teknik', ['[data-key]']),
    'beta:': fakeRow('beta:', ['[data-key]'])
  };
  const items = {
    'alfa:prompts/kod/a.md': { kind: 'file', mp: 'alfa', path: 'prompts/kod/a.md', key: 'alfa:prompts/kod/a.md', node: {} },
    'alfa:prompts/yazi': { kind: 'plugin', mp: 'alfa', path: 'prompts/yazi', key: 'alfa:prompts/yazi', node: { name: 'yazi', count: 1, description: '' } },
    'alfa:#teknik': { kind: 'teknik', mp: 'alfa', path: '', key: 'alfa:#teknik', node: [] },
    'beta:': { kind: 'mp', mp: 'beta', path: '', key: 'beta:', node: {}, expandable: true, expanded: false }
  };
  const hint = { hidden: true, textContent: '', innerHTML: '', className: 'dnd-hint' };
  const list = { scrollTop: 0, getBoundingClientRect: () => ({ top: 100, bottom: 500 }), contains: (n) => n === 'inside' };
  const moves = [];
  const timers = []; const cleared = []; let rendered = 0;
  const dom = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: (id) => { cleared.push(id); },
    saveMpOpen: () => {}, renderList: () => { rendered++; },
    $: (s) => (s === '#dndHint' ? hint : s === '#list' ? list : s === '#overlay' ? { hidden: true } : null),
    $$: (s) => (s.includes('.dragging') ? Object.values(rows).filter((r) => r.classes.has('dragging')) : Object.values(rows).filter((r) => r.classes.has('drop-ok') || r.classes.has('drop-no'))),
    rowEl: (k) => rows[k] || null, closeMenu: () => {}, ICON: { plugin: '<i>p</i>', warn: '<i>w</i>' }, esc: (s) => String(s)
  };
  const g = x.g;
  Object.assign(g, dom, { runMove: async (p) => { moves.push(p); } });
  vm.runInContext([constSrc('DND_OPEN_MS'), ...['dragHasFiles', 'clearDropMarks', 'endTreeDrag', 'paintDrop', 'autoOpenMp', 'onTreeDragStart', 'onTreeDragOver', 'onTreeDragLeave', 'onTreeDrop'].map(fnSrc)].join('\n')
    + '\nthis.dnd = { onTreeDragStart, onTreeDragOver, onTreeDragLeave, onTreeDrop, endTreeDrag };', g);
  const { onTreeDragStart, onTreeDragOver, onTreeDragLeave, onTreeDrop, endTreeDrag } = g.dnd;
  x.S.modelMap = new Map(Object.entries(items));
  x.S.results = null; x.S.drag = null;
  const data = {};
  const dt = (types = []) => ({ types, effectAllowed: '', dropEffect: '', setData: (k, v) => { data[k] = v; } });
  const ev = (target, extra = {}) => ({ target, clientY: 300, dataTransfer: dt(), prevented: false, preventDefault() { this.prevented = true; }, ...extra });

  const start = ev(rows['alfa:prompts/kod/a.md']);
  onTreeDragStart(start);
  assert.equal(start.prevented, false); assert.equal(x.S.drag.op, 'prompt'); assert.equal(x.S.drag.path, 'prompts/kod/a.md');
  assert.equal(start.dataTransfer.effectAllowed, 'move'); assert.equal(data['application/x-pp-node'], 'alfa:prompts/kod/a.md'); assert.equal(data['text/plain'], 'a.md');
  assert.ok(rows['alfa:prompts/kod/a.md'].classes.has('dragging'));

  let over = ev(rows['alfa:prompts/yazi']);
  onTreeDragOver(over);
  assert.equal(over.prevented, true); assert.equal(over.dataTransfer.dropEffect, 'move');
  assert.ok(rows['alfa:prompts/yazi'].classes.has('drop-ok')); assert.equal(hint.hidden, false); assert.equal(hint.className, 'dnd-hint ok');
  assert.match(hint.innerHTML, /Bırak: alfa › yazi/);

  over = ev(rows['alfa:#teknik']);
  onTreeDragOver(over);
  assert.equal(over.prevented, false, 'geçersiz hedefte bırakmaya izin verilmez'); assert.equal(over.dataTransfer.dropEffect, 'none');
  assert.ok(rows['alfa:#teknik'].classes.has('drop-no') && !rows['alfa:prompts/yazi'].classes.has('drop-ok'));
  assert.equal(hint.className, 'dnd-hint no'); assert.match(hint.innerHTML, /Teknik dosyalara taşınamaz\./);

  onTreeDragOver(ev(rows['alfa:prompts/yazi'], { clientY: 110 }));
  assert.equal(list.scrollTop, -12, 'üst bantta liste kayar');
  onTreeDragLeave(ev(null, { relatedTarget: 'inside' }));
  assert.equal(x.S.drag.overKey, 'alfa:prompts/yazi', 'liste içindeki geçişte vurgu korunur');
  onTreeDragLeave(ev(null, { relatedTarget: null }));
  assert.equal(x.S.drag.overKey, null); assert.equal(hint.hidden, true);

  onTreeDragOver(ev(rows['beta:']));
  assert.deepEqual(timers.map((t) => t.ms), [700], 'kapalı marketplace üzerinde 700 ms sonra açılma zamanlanır');
  const pending = timers.length;
  onTreeDragOver(ev(rows['alfa:prompts/yazi']));
  assert.ok(cleared.includes(pending), 'başka satıra geçince bekleyen zamanlayıcı iptal edilir');
  onTreeDragOver(ev(rows['beta:']));
  timers[timers.length - 1].fn();
  assert.ok(x.S.mpOpen.has('beta') && rendered === 1, 'zamanlayıcı dolunca marketplace açılır ve liste yeniden çizilir');
  onTreeDragOver(ev(rows['alfa:prompts/yazi']));
  timers[0].fn();
  assert.equal(rendered, 1, 'bayat zamanlayıcı (hedef değişmiş) hiçbir şey yapmaz');

  const drop = ev(rows['beta:']);
  await onTreeDrop(drop);
  assert.equal(drop.prevented, true); assert.equal(x.S.drag, null, 'bırakınca sürükleme biter');
  assert.deepEqual(moves.map((p) => [p.op, p.fromMp, p.toMp, p.to.kind]), [['prompt', 'alfa', 'beta', 'klasorsuz']]);
  assert.equal(rows['alfa:prompts/kod/a.md'].classes.has('dragging'), false);

  onTreeDragStart(ev(rows['alfa:prompts/yazi']));
  assert.equal(x.S.drag.op, 'plugin'); assert.equal(x.S.drag.name, 'yazi');
  const bad = ev(rows['alfa:#teknik']);
  await onTreeDrop(bad);
  assert.equal(moves.length, 1, 'geçersiz hedefe bırakınca istek ve onay yok'); assert.equal(x.S.drag, null);

  const blocked = ev(rows['alfa:#teknik']);
  onTreeDragStart(blocked);
  assert.equal(blocked.prevented, true, 'sürüklenemez satır'); assert.equal(x.S.drag, null);
  x.S.results = [{}];
  const inResults = ev(rows['alfa:prompts/kod/a.md']);
  onTreeDragStart(inResults);
  assert.equal(inResults.prevented, true, 'arama sonuçlarında sürükleme yok'); assert.equal(x.S.drag, null);
  x.S.results = null;

  const outside = ev(rows['alfa:prompts/yazi'], { dataTransfer: dt(['Files']) });
  onTreeDragOver(outside);
  assert.equal(outside.prevented, true); assert.equal(outside.dataTransfer.dropEffect, 'none', 'dışarıdan dosya bırakılamaz, sayfa açılmaz');
  const outsideDrop = ev(rows['alfa:prompts/yazi'], { dataTransfer: dt(['Files']) });
  await onTreeDrop(outsideDrop);
  assert.equal(outsideDrop.prevented, true); assert.equal(moves.length, 1);
  const text = ev(rows['alfa:prompts/yazi'], { dataTransfer: dt(['text/plain']) });
  onTreeDragOver(text); await onTreeDrop(text);
  assert.equal(text.prevented, false, 'dışarıdan metin sürüklemesine dokunulmaz');

  onTreeDragStart(ev(rows['alfa:prompts/kod/a.md']));
  endTreeDrag();
  assert.equal(x.S.drag, null); assert.equal(rows['alfa:prompts/kod/a.md'].classes.has('dragging'), false);
});
