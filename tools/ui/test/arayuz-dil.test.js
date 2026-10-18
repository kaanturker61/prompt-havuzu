'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { uiGlobals } = require('./helpers');
const FM = require('../public/fm.js');
const Rules = require('../public/rules.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const TR = require('../public/lang/tr.js');
const EN = require('../public/lang/en.js');

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

/** Summary: İşlev ve const kaynaklarını tek vm bağlamında çalıştırır; expose adları bağlam özelliği olur. */
function load({ fns = [], consts = [], expose = [] }, globals = {}) {
  const ctx = vm.createContext(Object.assign({ console }, globals));
  vm.runInContext([...consts.map(constSrc), ...fns.map(fnSrc), ...expose.map((n) => 'this.' + n + ' = ' + n + ';')].join('\n'), ctx);
  return ctx;
}

/** Summary: Öznitelik haritalı sahte DOM öğesi. */
function fakeNode(attrs) {
  const map = { ...attrs };
  return { map, textContent: '', getAttribute: (k) => (k in map ? map[k] : null), setAttribute: (k, v) => { map[k] = String(v); } };
}

/** Summary: querySelectorAll('[öznitelik]') ve documentElement.lang destekleyen sahte belge. */
function fakeDoc(nodes = []) {
  return {
    documentElement: { lang: 'tr' },
    nodes,
    querySelectorAll(selector) {
      const m = /^\[([\w-]+)\]$/.exec(selector);
      assert.ok(m, 'beklenmeyen seçici: ' + selector);
      return nodes.filter((n) => m[1] in n.map);
    }
  };
}

/** Summary: localStorage benzeri bellek depolaması; log verilirse yazmalar sırayla kaydedilir. */
function fakeStorage(initial = {}, { log, throws } = {}) {
  const data = { ...initial };
  return {
    data,
    getItem(k) { if (throws) throw new Error('erişilemez'); return k in data ? data[k] : null; },
    setItem(k, v) { if (throws) throw new Error('erişilemez'); data[k] = String(v); if (log) log.push(k + '=' + v); },
    removeItem(k) { delete data[k]; }
  };
}

const NAV_TR = { languages: ['tr-TR', 'en-US'], language: 'tr-TR' };
const NAV_EN = { languages: ['en-US'], language: 'en-US' };
const LANG_CONSTS = ['LANG_KEY', 'HTML_LANG', 'navLang', 'resolveLang', 'readLangCache', 'writeLangCache'];

test('startLanguage: pp.lang -> tarayıcı dili -> tr sırası', () => {
  const cases = [
    ['önbellek en, tarayıcı tr', 'en', NAV_TR, 'en'],
    ['önbellek tr, tarayıcı en', 'tr', NAV_EN, 'tr'],
    ['önbellek yok, tarayıcı tr', null, NAV_TR, 'tr'],
    ['önbellek yok, tarayıcı en', null, NAV_EN, 'en'],
    ['yalnızca birinci tarayıcı dili sayılır', null, { languages: ['en-GB', 'tr'], language: 'en-GB' }, 'en'],
    ['geçersiz önbellek yok sayılır (fr)', 'fr', NAV_TR, 'tr'],
    ['geçersiz önbellek yok sayılır (boş)', '', NAV_EN, 'en'],
    ['geçersiz önbellek yok sayılır (büyük harf)', 'TR', NAV_EN, 'en'],
    ['languages yok, language tr', null, { language: 'tr-TR' }, 'tr'],
    ['languages boş dizi, language en', null, { languages: [], language: 'en-US' }, 'en'],
    ['tarayıcı dili tanımsız: tr', null, {}, 'tr'],
    ['tr_TR biçimi', null, { languages: ['tr_TR'] }, 'tr'],
    ['tarayıcı dili de, önbellek de yok ama de: en', null, { languages: ['de-DE'] }, 'en']
  ];
  for (const [ad, cached, navigator, want] of cases) {
    const ctx = load({ fns: ['startLanguage'], consts: LANG_CONSTS, expose: [] }, {
      ...uiGlobals({ browser: true }), navigator, localStorage: fakeStorage(cached === null ? {} : { 'pp.lang': cached })
    });
    assert.equal(ctx.startLanguage(), want, ad);
  }
});

test('startLanguage: localStorage erişilemezse tarayıcı diline düşer, yazma hatası akışı bozmaz', () => {
  const globals = { ...uiGlobals({ browser: true }), navigator: NAV_EN, localStorage: fakeStorage({}, { throws: true }) };
  const ctx = load({ fns: ['startLanguage'], consts: LANG_CONSTS, expose: ['writeLangCache', 'readLangCache'] }, globals);
  assert.equal(ctx.startLanguage(), 'en');
  assert.equal(ctx.readLangCache(), null);
  assert.doesNotThrow(() => ctx.writeLangCache('tr'));
});

test('applyLanguage: I18n dili, <html lang> (tr / en-US) ve statik işaretleme', () => {
  const nodes = [
    fakeNode({ 'data-i18n': 'ui.static.settings' }),
    fakeNode({ 'data-i18n-title': 'ui.static.goActive' }),
    fakeNode({ 'data-i18n-placeholder': 'ui.static.searchPlaceholder' }),
    fakeNode({ 'data-i18n-aria-label': 'ui.static.actionsLabel' })
  ];
  const document = fakeDoc(nodes);
  const g = uiGlobals({ browser: true });
  const ctx = load({ fns: ['applyLanguage'], consts: LANG_CONSTS }, { ...g, document, navigator: NAV_TR, localStorage: fakeStorage() });
  assert.equal(ctx.applyLanguage('en'), 'en');
  assert.equal(g.I18n.current(), 'en');
  assert.equal(document.documentElement.lang, 'en-US');
  assert.equal(nodes[0].textContent, 'Settings');
  assert.equal(nodes[1].map.title, 'Go to the active marketplace in the tree');
  assert.equal(nodes[2].map.placeholder, 'Search prompts (Ctrl+K)');
  assert.equal(nodes[3].map['aria-label'], 'Actions');
  assert.equal(ctx.applyLanguage('tr'), 'tr');
  assert.equal(g.I18n.current(), 'tr');
  assert.equal(document.documentElement.lang, 'tr');
  assert.equal(nodes[0].textContent, 'Ayarlar');
  assert.equal(nodes[1].map.title, "Ağaçta etkin marketplace'e git");
  assert.equal(nodes[2].map.placeholder, 'Prompt ara (Ctrl+K)');
  assert.equal(nodes[3].map['aria-label'], 'İşlemler');
  assert.equal(ctx.applyLanguage('fr'), 'tr', 'geçersiz dil tr olur');
  assert.equal(document.documentElement.lang, 'tr');
});

test('betiğin başında applyLanguage(startLanguage()) çağrılır, init ilk /api/info sonrası syncLanguage çağırır', () => {
  const start = html.indexOf('applyLanguage(startLanguage());');
  assert.ok(start > 0, 'açılış çağrısı yok');
  assert.ok(start < html.indexOf('const S = {'), 'dil, durum nesnesinden önce uygulanmalı');
  const init = fnSrc('init');
  const first = init.indexOf("get('/api/info')");
  const sync = init.indexOf('syncLanguage(S.info)');
  assert.ok(first >= 0 && sync > first, 'syncLanguage ilk get(/api/info) sonrasında olmalı');
  assert.ok(sync < init.indexOf('applySetupUi()'), 'dil, kurulum arayüzü çizilmeden önce çözülmeli');
});

/** Summary: Gerçek api/get/init/dil işlevleriyle açılış akışını sahte fetch üzerinde çalıştırır. */
async function runInit({ cached = null, nav = NAV_TR, responses, flash = null, failFirst = false }) {
  const requests = [];
  const order = [];
  const toasts = [];
  const document = fakeDoc([fakeNode({ 'data-i18n': 'ui.static.settings' })]);
  const local = fakeStorage(cached === null ? {} : { 'pp.lang': cached });
  const g = uiGlobals({ browser: true });
  const S = { info: null };
  const main = { innerHTML: '' };
  const ctx = load({
    fns: ['api', 'init', 'startLanguage', 'applyLanguage', 'syncLanguage'], consts: ['MP_GUARDED', 'get', 'esc', ...LANG_CONSTS]
  }, {
    ...g, S, document, navigator: nav, localStorage: local,
    sessionStorage: fakeStorage(flash ? { 'pp.flash': flash } : {}),
    $: () => main,
    toast: (m, k, ms) => toasts.push([m, k, ms]),
    applySetupUi() { order.push('applySetupUi'); }, rootOk: () => false, renderMain() { order.push('renderMain'); },
    resyncActive() {}, onSetupLost() {},
    fetch: async (url, opt) => {
      requests.push({ url, lang: opt.headers['X-PP-Lang'], pp: opt.headers['X-PP'], method: opt.method });
      if (failFirst && requests.length === 1) throw new Error('bağlantı yok');
      const body = responses[Math.min(requests.length - 1, responses.length - 1)];
      if (body === null) throw new Error('ikinci istek başarısız');
      return { ok: true, status: 200, json: async () => ({ seq: requests.length, setup: { ok: false, rootOk: false, issues: [] }, activeMarketplace: '', ...body }) };
    }
  });
  ctx.applyLanguage(ctx.startLanguage());
  const startLang = g.I18n.current();
  await ctx.init();
  return { requests, order, toasts, document, local, S, I18n: g.I18n, startLang, main };
}

test('init: sunucudaki dil önbellektekinden farklıysa /api/info bir kez yeniden çekilir, yeni dille', async () => {
  const r = await runInit({ cached: 'tr', responses: [{ language: 'en' }, { language: 'en' }] });
  assert.equal(r.startLang, 'tr');
  assert.deepEqual(r.requests.map((x) => [x.url, x.lang]), [['/api/info', 'tr'], ['/api/info', 'en']]);
  assert.equal(r.S.info.seq, 2, 'ikinci yanıt kullanılır');
  assert.equal(r.I18n.current(), 'en');
  assert.equal(r.local.data['pp.lang'], 'en');
  assert.equal(r.document.documentElement.lang, 'en-US');
  assert.equal(r.document.nodes[0].textContent, 'Settings');
  assert.deepEqual(r.order, ['applySetupUi', 'renderMain']);
});

test('init: dil aynıysa yeniden çekim yok; pp.lang sunucu çözümüyle güncellenir', async () => {
  let r = await runInit({ cached: 'en', responses: [{ language: 'en' }] });
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].lang, 'en');
  assert.equal(r.S.info.seq, 1);
  assert.equal(r.local.data['pp.lang'], 'en');

  r = await runInit({ cached: null, nav: NAV_TR, responses: [{ language: 'auto' }] });
  assert.equal(r.requests.length, 1, 'önbellek yok, auto + tarayıcı tr: açılış tr zaten doğru');
  assert.equal(r.local.data['pp.lang'], 'tr');

  r = await runInit({ cached: null, nav: NAV_EN, responses: [{ language: 'auto' }] });
  assert.equal(r.requests.length, 1);
  assert.equal(r.startLang, 'en');
  assert.equal(r.local.data['pp.lang'], 'en');
});

test('init: açık seçim tarayıcı dilini ezer; auto önbelleği tarayıcıya göre düzeltir', async () => {
  let r = await runInit({ cached: null, nav: NAV_EN, responses: [{ language: 'tr' }, { language: 'tr' }] });
  assert.equal(r.startLang, 'en');
  assert.deepEqual(r.requests.map((x) => x.lang), ['en', 'tr']);
  assert.equal(r.local.data['pp.lang'], 'tr');
  assert.equal(r.I18n.current(), 'tr');

  r = await runInit({ cached: 'en', nav: NAV_TR, responses: [{ language: 'auto' }, { language: 'auto' }] });
  assert.deepEqual(r.requests.map((x) => x.lang), ['en', 'tr'], 'önbellek en, ayar auto + tarayıcı tr');
  assert.equal(r.local.data['pp.lang'], 'tr');
});

test('init: döngü yok; ikinci yanıt farklı dil bildirse de en çok iki istek', async () => {
  const r = await runInit({ cached: 'tr', responses: [{ language: 'en' }, { language: 'tr' }, { language: 'en' }] });
  assert.equal(r.requests.length, 2);
  assert.equal(r.I18n.current(), 'en');
  assert.equal(r.local.data['pp.lang'], 'en');
});

test('init: yeniden çekim başarısızsa ilk yanıtla devam eder, dil yine uygulanır', async () => {
  const r = await runInit({ cached: 'tr', responses: [{ language: 'en' }, null] });
  assert.equal(r.requests.length, 2);
  assert.equal(r.S.info.seq, 1);
  assert.equal(r.I18n.current(), 'en');
  assert.deepEqual(r.order, ['applySetupUi', 'renderMain']);
});

test('init: ilk istek başarısızsa dil eşitlemesi ve yeniden çekim olmaz', async () => {
  const r = await runInit({ cached: 'en', responses: [{ language: 'tr' }], failFirst: true });
  assert.equal(r.requests.length, 1);
  assert.equal(r.I18n.current(), 'en');
  assert.equal(r.local.data['pp.lang'], 'en');
  assert.match(r.main.innerHTML, /Cannot reach the server/);
  assert.deepEqual(r.order, []);
});

test('init: flash iletisi dil eşitlemesinden sonra, olduğu gibi gösterilir', async () => {
  const r = await runInit({ cached: 'tr', responses: [{ language: 'en' }, { language: 'en' }], flash: 'Language saved' });
  assert.deepEqual(r.toasts, [['Language saved', 'ok', 5000]]);
});

test('api: her isteğe X-PP-Lang geçerli dili eklenir; X-PP ve X-PP-MP mantığı korunur', async () => {
  const seen = [];
  const g = uiGlobals({ browser: true });
  const ctx = load({ fns: ['api'], consts: ['MP_GUARDED'], expose: [] }, {
    ...g, S: { info: { activeMarketplace: 'Benim Mp' } },
    fetch: async (url, opt) => { seen.push({ url, method: opt.method, headers: opt.headers, body: opt.body }); return { ok: true, status: 200, json: async () => ({ ok: 1 }) }; },
    resyncActive() {}, onSetupLost() {}
  });
  await ctx.api('GET', '/api/info');
  assert.equal(seen[0].headers['X-PP-Lang'], 'tr');
  g.I18n.setLanguage('en');
  await ctx.api('PUT', '/api/file', { path: 'a.md' });
  await ctx.api('PUT', '/api/settings', { language: 'tr' });
  assert.equal(seen[1].headers['X-PP-Lang'], 'en');
  assert.equal(seen[1].headers['X-PP'], '1');
  assert.equal(seen[1].headers['X-PP-MP'], encodeURIComponent('Benim Mp'));
  assert.equal(seen[1].headers['Content-Type'], 'application/json');
  assert.equal(seen[1].body, JSON.stringify({ path: 'a.md' }));
  assert.equal(seen[2].headers['X-PP-Lang'], 'en');
  assert.ok(!('X-PP-MP' in seen[2].headers), '/api/settings korumasız kalır');
  g.I18n.setLanguage('tr');
  await ctx.api('GET', '/api/tree');
  assert.equal(seen[3].headers['X-PP-Lang'], 'tr');
});

/** Summary: setLanguage akışını sıralı günlükle çalıştırır; ilk dil tr ya da en, tarayıcı dili nav. */
function flowCtx({ current = 'tr', nav = NAV_TR, confirm = true, putError = null, storageThrows = false } = {}) {
  const log = [];
  const g = uiGlobals({ browser: true });
  g.I18n.setLanguage(current);
  const ctx = load({ fns: ['setLanguage'], consts: ['tx', ...LANG_CONSTS] }, {
    ...g, navigator: nav, localStorage: fakeStorage({}, { log, throws: storageThrows }),
    confirmDiscard: async () => { log.push('confirmDiscard'); return confirm; },
    api: async (method, url, body) => { log.push(method + ' ' + url + ' ' + JSON.stringify(body)); if (putError) throw putError; return {}; },
    reloadWith: (msg) => log.push('reloadWith:' + msg),
    openSettings: () => log.push('openSettings'),
    fail: (e) => log.push('fail:' + e.message)
  });
  return { ctx, log, I18n: g.I18n };
}

test('setLanguage: confirmDiscard -> PUT -> pp.lang -> reloadWith sırası; flash yeni dilde, geçerli dil değişmez', async () => {
  let f = flowCtx({ current: 'tr' });
  assert.equal(await f.ctx.setLanguage('en'), true);
  assert.deepEqual(f.log, ['confirmDiscard', 'PUT /api/settings {"language":"en"}', 'pp.lang=en', 'reloadWith:Language saved']);
  assert.equal(f.I18n.current(), 'tr', 'canlı geçiş yok: sayfa yenilenir');

  f = flowCtx({ current: 'en' });
  assert.equal(await f.ctx.setLanguage('tr'), true);
  assert.deepEqual(f.log, ['confirmDiscard', 'PUT /api/settings {"language":"tr"}', 'pp.lang=tr', 'reloadWith:Dil kaydedildi']);
  assert.equal(f.I18n.current(), 'en');
});

test('setLanguage: auto, tarayıcı diline çözülür (pp.lang ve flash çözülen dilde, PUT ham ayarla)', async () => {
  let f = flowCtx({ current: 'en', nav: NAV_TR });
  await f.ctx.setLanguage('auto');
  assert.deepEqual(f.log, ['confirmDiscard', 'PUT /api/settings {"language":"auto"}', 'pp.lang=tr', 'reloadWith:Dil kaydedildi']);
  f = flowCtx({ current: 'tr', nav: NAV_EN });
  await f.ctx.setLanguage('auto');
  assert.deepEqual(f.log, ['confirmDiscard', 'PUT /api/settings {"language":"auto"}', 'pp.lang=en', 'reloadWith:Language saved']);
});

test('setLanguage: vazgeçilirse PUT, pp.lang ve yenileme olmaz; ayar penceresi yeniden açılır', async () => {
  const f = flowCtx({ confirm: false });
  assert.equal(await f.ctx.setLanguage('en'), false);
  assert.deepEqual(f.log, ['confirmDiscard', 'openSettings']);
});

test('setLanguage: PUT başarısızsa hata bildirilir, pp.lang ve yenileme olmaz', async () => {
  const f = flowCtx({ putError: new Error('Geçersiz değer') });
  assert.equal(await f.ctx.setLanguage('en'), false);
  assert.deepEqual(f.log, ['confirmDiscard', 'PUT /api/settings {"language":"en"}', 'fail:Geçersiz değer', 'openSettings']);
});

test('setLanguage: pp.lang yazılamasa da (özel pencere) yenileme sürer', async () => {
  const f = flowCtx({ storageThrows: true });
  assert.equal(await f.ctx.setLanguage('en'), true);
  assert.deepEqual(f.log, ['confirmDiscard', 'PUT /api/settings {"language":"en"}', 'reloadWith:Language saved']);
});

test('setLanguage: ileti metnine bağlı karşılaştırma yok; seçici change olayına bağlı', () => {
  const src = fnSrc('setLanguage');
  assert.doesNotMatch(src, /textContent|innerText|innerHTML|\.title\b/);
  assert.match(html, /else if \(t\.id === 'setLanguage'\) \{ setLanguage\(t\.value\); \}/);
  assert.doesNotMatch(html, /#mTitle'\)\.textContent === /);
  assert.match(html, /modalState\.kind === 'settings'/);
});

/** Summary: settingsHtml çıktısını verilen ayarlarla, belirtilen arayüz dilinde üretir. */
function settingsOut(language, uiLang = 'tr') {
  const g = uiGlobals({ browser: true });
  g.I18n.setLanguage(uiLang);
  const ctx = load({ fns: ['settingsHtml'], consts: ['esc', 'tx', 'ROOT_BAD'] }, { ...g, mkRowHtml: () => '' });
  const s = { setup: { issues: [] }, libraryRoot: '/lib', suggestedRoot: '', suggestedRootNote: '', configPath: '/c.json', remoteCheck: 'acilista', language };
  return ctx.settingsHtml(s, { items: [], ignored: [] });
}

test('Ayarlar: Dil / Language seçicisi üç seçenekle, iki dilde aynı sabit metinlerle', () => {
  for (const ui of ['tr', 'en']) {
    const out = settingsOut('en', ui);
    assert.match(out, /<h3>Dil \/ Language<\/h3>/, ui);
    assert.match(out, /<label>Dil \/ Language<select id="setLanguage">/, ui);
    const opts = [...out.matchAll(/<option value="([^"]*)" ([^>]*)>([^<]*)<\/option>/g)].filter((m) => ['auto', 'tr', 'en'].includes(m[1]));
    assert.deepEqual(opts.map((m) => [m[1], m[3]]), [['auto', 'Otomatik / Automatic'], ['tr', 'Türkçe'], ['en', 'English (US)']], ui);
    assert.deepEqual(opts.filter((m) => /selected/.test(m[2])).map((m) => m[1]), ['en'], ui);
  }
});

test('Ayarlar: seçili seçenek ayara göre; yok ya da geçersiz değer Otomatik', () => {
  const selected = (language) => {
    const out = settingsOut(language);
    return [...out.matchAll(/<option value="(auto|tr|en)" selected>/g)].map((m) => m[1]);
  };
  assert.deepEqual(selected('auto'), ['auto']);
  assert.deepEqual(selected('tr'), ['tr']);
  assert.deepEqual(selected('en'), ['en']);
  assert.deepEqual(selected(undefined), ['auto']);
  assert.deepEqual(selected('de'), ['auto']);
});

test('Ayarlar: seçici Library kökü formunun dışında, Uzak depo bölümünden önce; mevcut alanlar yerinde', () => {
  const out = settingsOut('auto');
  const form = out.indexOf('</form>');
  const lang = out.indexOf('id="setLanguage"');
  const remote = out.indexOf('id="setRemoteCheck"');
  assert.ok(form > 0 && lang > form && remote > lang);
  assert.match(out, /id="setRootForm"/);
});

test('fmtDate: tr ve en yerel ayarıyla tarih+saat; bozuk girdi olduğu gibi; today() veri olarak sv-SE kalır', () => {
  const when = new Date(2026, 2, 5, 14, 5).toISOString();
  const g = uiGlobals({ browser: true });
  const ctx = load({ consts: ['fmtDate'], expose: [] }, g);
  const fmt = (locale) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(when));
  const date = vm.runInContext('fmtDate', ctx);
  assert.equal(date(when), fmt('tr-TR'));
  assert.match(date(when), /^5 Mar 2026,? 14:05$/);
  g.I18n.setLanguage('en');
  assert.equal(date(when), fmt('en-US'));
  assert.match(date(when), /^Mar 5, 2026, 2:05\sPM$/);
  assert.equal(date('bozuk'), 'bozuk');
  assert.match(constSrc('today'), /toLocaleDateString\('sv-SE'\)/);
});

test('saat: yerel ayar işlevden gelir; arayüzde sabit tr-TR kalmadı', () => {
  assert.doesNotMatch(html, /tr-TR/);
  assert.doesNotMatch(html, /toLocaleTimeString|toLocaleString\(/);
  assert.match(html, /const time = lc && lc\.at \? I18n\.time\(lc\.at\) : null;/);
  const when = new Date(2026, 2, 5, 14, 5).toISOString();
  const g = uiGlobals({ browser: true });
  assert.equal(g.I18n.time(when), '14:05');
  g.I18n.setLanguage('en');
  assert.match(g.I18n.time(when), /^2:05\sPM$/);
});

const STATIC_TR = {
  'ui.static.title': 'Prompt havuzu',
  'ui.static.brand': 'Prompt havuzu',
  'ui.static.goActive': "Ağaçta etkin marketplace'e git",
  'ui.static.searchPlaceholder': 'Prompt ara (Ctrl+K)',
  'ui.static.searchLabel': 'Prompt ara',
  'ui.static.actionsLabel': 'İşlemler',
  'ui.static.newPrompt': 'Yeni prompt',
  'ui.static.import': 'İçe aktar',
  'ui.static.git': 'Git',
  'ui.static.marketplace': 'Marketplace',
  'ui.static.settings': 'Ayarlar',
  'ui.static.openList': 'Prompt listesini aç',
  'ui.static.list': 'Liste',
  'ui.static.closeList': 'Listeyi kapat',
  'ui.static.filterStatusLabel': 'Duruma göre filtrele',
  'ui.static.allStatuses': 'Tüm durumlar',
  'ui.static.statusDraft': 'Taslak',
  'ui.static.statusStable': 'Kararlı',
  'ui.static.statusArchived': 'Arşiv',
  'ui.static.filterTypeLabel': 'Türe göre filtrele',
  'ui.static.allTypes': 'Tüm türler',
  'ui.static.typeCommand': 'Komut',
  'ui.static.typeAgent': 'Ajan',
  'ui.static.typeSkill': 'Skill',
  'ui.static.notPublished': 'Yayın dışı',
  'ui.static.searchInFiles': 'Marketplace dosyalarında da ara (plugins/)',
  'ui.static.library': 'Kütüphane',
  'ui.static.clearFilters': 'Filtreyi temizle',
  'ui.static.libraryActions': 'Kütüphane işlemleri',
  'ui.static.addMarketplace': '+ Marketplace',
  'ui.static.addPlugin': '+ Plugin',
  'ui.static.addPrompt': '+ Prompt',
  'ui.static.close': 'Kapat'
};
const SAME_IN_EN = ['ui.static.title', 'ui.static.brand', 'ui.static.git', 'ui.static.marketplace', 'ui.static.typeSkill', 'ui.static.addMarketplace', 'ui.static.addPlugin', 'ui.static.addPrompt'];

/** Summary: <title> ve gövdedeki (ilk <script>'e kadar) data-i18n* öznitelikli etiketleri sahte öğelere çevirir. */
function staticNodes() {
  const head = html.slice(0, html.indexOf('<style>'));
  const body = html.slice(html.indexOf('<body>'), html.indexOf('<script'));
  const nodes = [];
  for (const m of (head + body).matchAll(/<(\w+)((?:\s[^>]*)?\sdata-i18n[^>]*)>/g)) {
    const attrs = { tag: m[1] };
    for (const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    nodes.push(fakeNode(attrs));
  }
  return nodes;
}

test('statik işaretleme: görünen metin kalmadı; <title> dahil her metin ve öznitelik data-i18n* ile', () => {
  const body = html.slice(html.indexOf('<body>'), html.indexOf('<script'));
  assert.equal(body.replace(/<[^>]*>/g, '').trim(), '', 'işaretlemede çıplak metin yok');
  assert.doesNotMatch(body, /\s(?:title|placeholder|aria-label)="/, 'çıplak title/placeholder/aria-label yok');
  assert.match(html, /<title data-i18n="ui\.static\.title"><\/title>/);
  assert.match(html, /^<html lang="tr">/m);
  const nodes = staticNodes();
  const text = nodes.filter((n) => 'data-i18n' in n.map);
  const attrs = nodes.flatMap((n) => ['data-i18n-title', 'data-i18n-placeholder', 'data-i18n-aria-label'].filter((k) => k in n.map));
  assert.equal(text.length, 25, '24 metin düğümü + <title>');
  assert.equal(attrs.length, 9, '9 öznitelik metni');
});

test('statik işaretleme: kullanılan her anahtar tr ve en sözlüğünde; tr harfi harfine eski metin; en farklı', () => {
  const keys = new Set(staticNodes().flatMap((n) => Object.entries(n.map).filter(([k]) => k.startsWith('data-i18n')).map(([, v]) => v)));
  assert.deepEqual([...keys].sort(), Object.keys(STATIC_TR).sort(), 'sözlük tablosu işaretlemeyle birebir');
  for (const [key, text] of Object.entries(STATIC_TR)) {
    assert.equal(TR[key], text, 'tr ' + key);
    assert.equal(typeof EN[key], 'string', 'en ' + key);
    assert.ok(EN[key].length > 0, 'en boş değil ' + key);
    if (!SAME_IN_EN.includes(key)) assert.notEqual(EN[key], text, 'en çevrilmiş ' + key);
  }
  for (const key of Object.keys(EN)) assert.ok(key in TR, 'tr karşılığı var ' + key);
});

test('statik işaretleme: seçenek değerleri (veri) korunur; her seçeneğin anahtarı doğru', () => {
  const opts = [...html.matchAll(/<option value="([^"]*)" data-i18n="([^"]+)"><\/option>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(opts, [
    ['', 'ui.static.allStatuses'], ['taslak', 'ui.static.statusDraft'], ['kararlı', 'ui.static.statusStable'], ['arşiv', 'ui.static.statusArchived'],
    ['', 'ui.static.allTypes'], ['komut', 'ui.static.typeCommand'], ['ajan', 'ui.static.typeAgent'], ['skill', 'ui.static.typeSkill'], ['yok', 'ui.static.notPublished']
  ]);
});

test('statik işaretleme: Git ve Marketplace düğmelerinin rozetleri korunur; onay kutusu etiketin içinde kalır', () => {
  assert.match(html, /<span data-i18n="ui\.static\.git"><\/span><span id="gitBadge" class="badge" hidden><\/span><span id="gitDown" class="badge" hidden><\/span>/);
  assert.match(html, /<span data-i18n="ui\.static\.marketplace"><\/span><span id="mkBadge" class="badge warn" hidden><\/span>/);
  assert.match(html, /<label class="chk"><input type="checkbox" id="fScope"><span data-i18n="ui\.static\.searchInFiles"><\/span><\/label>/);
});

test('statik işaretleme: applyDom tüm düğümleri iki dilde doldurur, boş kalan yok', () => {
  const nodes = staticNodes();
  const document = fakeDoc(nodes);
  const g = uiGlobals({ browser: true });
  const ctx = load({ fns: ['applyLanguage'], consts: LANG_CONSTS }, { ...g, document, navigator: NAV_TR, localStorage: fakeStorage() });
  const filled = (node) => ['data-i18n', 'data-i18n-title', 'data-i18n-placeholder', 'data-i18n-aria-label'].flatMap((attr) => {
    if (!(attr in node.map)) return [];
    const key = node.map[attr];
    const got = attr === 'data-i18n' ? node.textContent : node.map[attr.replace('data-i18n-', '')];
    return [[key, got]];
  });
  for (const lang of ['tr', 'en']) {
    ctx.applyLanguage(lang);
    const dict = lang === 'tr' ? TR : EN;
    let n = 0;
    for (const node of nodes) {
      for (const [key, got] of filled(node)) { assert.equal(got, dict[key], lang + ' ' + key); n++; }
    }
    assert.equal(n, 34);
  }
});

test('index.html: yeni kod tx ve th adlarını kullanır (yerel t ile gölgelenmez); LF', () => {
  assert.match(html, /^const tx = I18n\.tx;$/m);
  assert.match(html, /^const th = I18n\.th;$/m);
  assert.ok(!html.includes('\r'));
  assert.ok(!fs.readFileSync(__filename, 'utf8').includes('\r'));
});

/** Summary: Sahte DOM öğesi: yazılan innerHTML/textContent ve eklenen olay dinleyicileri saklanır. */
function stubEl() {
  const el = { innerHTML: '', textContent: '', value: '', hidden: false, checked: true, dataset: {}, handlers: {}, addEventListener(ev, fn) { el.handlers[ev] = fn; }, setAttribute() {}, removeAttribute() {}, focus() {}, select() {} };
  return el;
}

/** Summary: Seçiciye göre tembel oluşturulan sahte öğeler (`$`) ve elle verilen onay kutuları (`$$`). */
function stubDom() {
  const els = new Proxy({}, { get: (target, key) => (typeof key === 'string' ? (target[key] = target[key] || stubEl()) : target[key]) });
  const dom = { els, checks: [], $: (selector) => els[selector], $$: () => dom.checks };
  return dom;
}

/** Summary: Yeni prompt, içe aktarma, yeniden adlandırma ve silme işlevleri için vm bağlamı: tarayıcı kipi I18n, sahte DOM, kayıt tutan toast/openModal/api/askText/askChoice. */
function regionCtx(fns, mp) {
  const g = uiGlobals({ browser: true });
  const dom = stubDom();
  const calls = { modal: [], toast: [], api: [], ask: [], choice: [] };
  const env = { g, dom, calls, apiFor: async () => ({}) };
  env.ctx = load({ fns, consts: ['esc', 'toList', 'base', 'today', 'hasWord'] }, {
    ...g, FM, Rules, $: dom.$, $$: dom.$$,
    S: { sel: null, cur: null, mpOpen: new Set(), modelMap: new Map(), focusKey: null },
    FormData: class { constructor(target) { this.values = target.values; } get(key) { return this.values[key]; } },
    ls: { get: (key, fallback) => fallback, set() {} }, lsKey: (key) => key, qs: (o) => 'path=' + o.path,
    activeMp: () => mp, activeName: () => mp.name, libDirOf: () => 'prompts', pluginsOf: (m) => m.plugins,
    openModal: (o) => calls.modal.push(o), closeModal() {}, toast: (message, kind) => calls.toast.push([message, kind || null]), fail(e) { throw e; },
    confirmDiscard: async () => true, afterWrite: async () => {}, openFile: async () => {}, renderMain() {}, renderList() {}, expandParents() {}, clearCur() {},
    expOf: () => new Set(), saveExp() {}, nodeKey: (name, path2) => name + ':' + path2,
    api: async (method, url, body) => { calls.api.push({ method, url, body }); return env.apiFor(method, url, body); },
    askText: async (o) => { calls.ask.push(o); return 'Yeni Ad'; },
    askChoice: async (o) => { calls.choice.push(o); return 'yes'; }
  });
  return env;
}

const XSS_INPUT = '<img src=x onerror="alert(1)">';
const XSS_ESCAPED = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;';
const LEGACY_TEMPLATES = {
  bos: { label: 'Boş', meta: {}, body: '' },
  rgc: { label: 'Rol, görev, çıktı', meta: {}, body: 'Rol:\n\nGörev:\n\nBağlam:\n- \n\nKısıtlar:\n- \n\nÇıktı biçimi:\n1. \n' },
  komut: { label: 'Claude Code komutu', meta: { tur: 'komut', arguman_ipucu: '[argüman]' }, body: 'Görev: $ARGUMENTS\n\nArgüman boşsa ne yapılacağını sor ve dur.\n\nÇıktı biçimi:\n1. \n' },
  ajan: { label: 'Claude Code ajanı', meta: { tur: 'ajan', izinli_araclar: 'Read, Grep, Glob', model: 'sonnet' }, body: 'Rol:\n\nGirdi dosyaları:\n- \n\nÇıktı dosyaları:\n- \n\nYasaklı davranışlar:\n- \n' }
};

test('templates: tr çıktısı eski şablonlarla birebir; en gövdesi İngilizce; meta iki dilde aynı kanonik Türkçe; dil değişince bayatlamaz', () => {
  const g = uiGlobals({ browser: true });
  const { templates } = load({ fns: ['templates'] }, g);
  const snapshot = () => JSON.parse(JSON.stringify(templates()));
  g.I18n.setLanguage('tr');
  assert.deepEqual(snapshot(), LEGACY_TEMPLATES);
  g.I18n.setLanguage('en');
  const en = snapshot();
  assert.deepEqual(Object.keys(en), Object.keys(LEGACY_TEMPLATES));
  for (const id of Object.keys(en)) assert.deepEqual(en[id].meta, LEGACY_TEMPLATES[id].meta, 'meta kanonik: ' + id);
  assert.deepEqual(en.komut.meta, { tur: 'komut', arguman_ipucu: '[argüman]' });
  assert.deepEqual(en.ajan.meta, { tur: 'ajan', izinli_araclar: 'Read, Grep, Glob', model: 'sonnet' });
  assert.deepEqual(Object.values(en).map((tpl) => tpl.label), ['Blank', 'Role, task, output', 'Claude Code command', 'Claude Code agent']);
  assert.equal(en.bos.body, '');
  assert.equal(en.rgc.body, 'Role:\n\nTask:\n\nContext:\n- \n\nConstraints:\n- \n\nOutput format:\n1. \n');
  assert.equal(en.komut.body, 'Task: $ARGUMENTS\n\nIf the argument is empty, ask what to do and stop.\n\nOutput format:\n1. \n');
  assert.equal(en.ajan.body, 'Role:\n\nInput files:\n- \n\nOutput files:\n- \n\nForbidden behaviors:\n- \n');
  for (const tpl of Object.values(en)) assert.doesNotMatch(tpl.label + tpl.body, /[çğıöşüÇĞİÖŞÜ]/);
  g.I18n.setLanguage('tr');
  assert.deepEqual(snapshot(), LEGACY_TEMPLATES, 'tr yeniden aynı: şablonlar bayatlamaz');
});

test('openNewPrompt: pencere ve yazılan dosya iki dilde; frontmatter kanonik Türkçe, gövde arayüz dilinde; kullanıcı girdisi kaçışlı', async () => {
  const mp = { name: XSS_INPUT, libraryDir: 'prompts', plugins: [{ name: 'kod' }, { name: XSS_INPUT }] };
  const env = regionCtx(['templates', 'openNewPrompt'], mp);
  const today = new Date().toLocaleDateString('sv-SE');
  const render = async (lang, tpl) => {
    env.g.I18n.setLanguage(lang);
    env.calls.modal.length = 0; env.calls.api.length = 0; env.calls.toast.length = 0;
    env.apiFor = async (method, url, body) => ({ path: body.path });
    env.ctx.openNewPrompt({ plugin: 'kod' });
    const modal = env.calls.modal[0];
    modal.onMount({});
    await env.dom.els['#newForm'].handlers.submit({ preventDefault() {}, target: { values: { title: 'Başlık', plugin: 'kod', tags: 'a, b', tpl } } });
    const [head, body] = env.calls.api[0].body.raw.split('\n---\n\n');
    return { title: modal.title, html: modal.html, head, body, toast: env.calls.toast.map((entry) => entry[0]) };
  };
  const tr = await render('tr', 'komut');
  const en = await render('en', 'komut');
  assert.equal(tr.title, 'Yeni prompt');
  assert.equal(en.title, 'New prompt');
  assert.match(tr.html, /<option value="komut">Claude Code komutu<\/option>/);
  assert.match(en.html, /<option value="komut">Claude Code command<\/option>/);
  assert.match(tr.html, /<label>Şablon<select name="tpl">/);
  assert.match(en.html, /<label>Template<select name="tpl">/);
  assert.ok(tr.html.includes('Marketplace: <b>' + XSS_ESCAPED + '</b>'));
  assert.ok(en.html.includes('Marketplace: <b>' + XSS_ESCAPED + '</b>'));
  for (const rendered of [tr.html, en.html]) {
    assert.ok(!rendered.includes('<img'), 'kullanıcı girdisi kaçışlı');
    assert.ok(rendered.includes('<option value="' + XSS_ESCAPED + '" >' + XSS_ESCAPED + '</option>'));
  }
  const frontmatter = '---\nbaslik: Başlık\netiketler: [a, b]\ndurum: taslak\nolusturma: ' + today + '\ntur: komut\narguman_ipucu: "[argüman]"';
  assert.equal(tr.head, frontmatter);
  assert.equal(en.head, frontmatter, 'frontmatter anahtarları ve değerleri dilden bağımsız');
  assert.equal(tr.body, LEGACY_TEMPLATES.komut.body);
  assert.equal(en.body, 'Task: $ARGUMENTS\n\nIf the argument is empty, ask what to do and stop.\n\nOutput format:\n1. \n');
  assert.deepEqual([tr.toast, en.toast], [['Prompt oluşturuldu'], ['Prompt created']]);
  const trAgain = await render('tr', 'komut');
  assert.deepEqual(trAgain, tr, 'tr yeniden aynı: pencere ve dosya bayatlamaz');
});

test('openImport: tara ve sonuç iletileri çoğul (tr/en); atlananlar, önizleme ve hedef kaçışlı; dil değişince bayatlamaz', async () => {
  const mp = { name: 'mp', libraryDir: 'prompts', plugins: [{ name: 'kod', path: 'prompts/kod' }] };
  const env = regionCtx(['openImport'], mp);
  const flow = async (lang, scan, run, target) => {
    env.g.I18n.setLanguage(lang);
    env.calls.modal.length = 0;
    env.ctx.openImport();
    const modal = env.calls.modal[0];
    modal.onMount({});
    env.apiFor = async (method, url) => (url === '/api/import/scan' ? scan : run);
    const out = env.dom.els['#impOut'];
    await env.dom.els['#impForm'].handlers.submit({ preventDefault() {}, target: { values: { dir: '/d', target } } });
    const scanned = out.innerHTML;
    env.dom.checks = scan.files.map((file, i) => ({ checked: true, dataset: { i: String(i) } }));
    await env.dom.els['#impGo'].handlers.click();
    return { title: modal.title, html: modal.html, scanned, done: out.innerHTML };
  };
  const one = { dir: '/d', files: [{ rel: XSS_INPUT, file: '/d/a.txt', preview: XSS_INPUT, lines: 1 }] };
  const oneRun = { created: [{}], skipped: [{ file: '/d/x.txt', reason: XSS_INPUT }, { file: '/d/y.txt', reason: 'Boş dosya' }] };
  const target = 'prompts/' + XSS_INPUT;
  const trOne = await flow('tr', one, oneRun, target);
  const enOne = await flow('en', one, oneRun, target);
  assert.equal(trOne.title, '.txt dosyalarını içe aktar');
  assert.equal(enOne.title, 'Import .txt files');
  assert.ok(trOne.html.includes('placeholder="C:\\Users\\sen\\promptlar veya ~/promptlar"') && trOne.html.includes('>Gelen kutusu</option>'));
  assert.ok(enOne.html.includes('placeholder="C:\\Users\\you\\prompts or ~/prompts"') && enOne.html.includes('>Inbox</option>'));
  assert.ok(trOne.scanned.includes('<h3>1 dosya bulundu</h3>') && trOne.scanned.includes('<span class="hint">1 satır</span>'));
  assert.ok(enOne.scanned.includes('<h3>1 file found</h3>') && enOne.scanned.includes('<span class="hint">1 line</span>'));
  const skippedList = 'x.txt (' + XSS_ESCAPED + '), y.txt (Boş dosya)';
  assert.ok(trOne.done.includes('<h3>1 prompt oluşturuldu</h3>'));
  assert.ok(trOne.done.includes('<p>Taslak olarak <code>prompts/' + XSS_ESCAPED + '</code> içine kaydedildi.'));
  assert.ok(trOne.done.includes('<p class="issue warn">2 dosya atlandı: ' + skippedList + '</p>'));
  assert.ok(enOne.done.includes('<h3>1 prompt created</h3>'));
  assert.ok(enOne.done.includes('<p>Saved as drafts in <code>prompts/' + XSS_ESCAPED + '</code>.'));
  assert.ok(enOne.done.includes('<p class="issue warn">2 files skipped: ' + skippedList + '</p>'));
  for (const rendered of [trOne.scanned, trOne.done, enOne.scanned, enOne.done]) assert.ok(!rendered.includes('<img'), 'kullanıcı girdisi kaçışlı');
  assert.ok(trOne.done.includes('data-path="prompts/' + XSS_ESCAPED + '"'));
  const many = { dir: '/d', files: [{ rel: 'a.txt', file: '/d/a.txt', preview: 'p', lines: 12 }, { rel: 'b.txt', file: '/d/b.txt', preview: 'p', lines: 1 }, { rel: 'c.txt', file: '/d/c.txt', preview: 'p', lines: 2 }] };
  const manyRun = { created: [{}, {}, {}], skipped: [{ file: '/d/z.txt', reason: 'Okunamadı' }] };
  const trMany = await flow('tr', many, manyRun, 'prompts/kod');
  const enMany = await flow('en', many, manyRun, 'prompts/kod');
  assert.ok(trMany.scanned.includes('<h3>3 dosya bulundu</h3>') && trMany.scanned.includes('12 satır'));
  assert.ok(enMany.scanned.includes('<h3>3 files found</h3>') && enMany.scanned.includes('12 lines'));
  assert.ok(trMany.done.includes('<h3>3 prompt oluşturuldu</h3>') && trMany.done.includes('1 dosya atlandı: z.txt (Okunamadı)'));
  assert.ok(enMany.done.includes('<h3>3 prompts created</h3>') && enMany.done.includes('1 file skipped: z.txt (Okunamadı)'));
  const trAgain = await flow('tr', one, oneRun, target);
  assert.deepEqual(trAgain, trOne, 'tr yeniden aynı: içe aktarma metinleri bayatlamaz');
});

test('renamePlugin ve deleteItem: çoğul ve parametreli iletiler iki dilde, dil değişince bayatlamaz', async () => {
  const env = regionCtx(['renamePlugin', 'deleteItem'], { name: 'mp', libraryDir: 'prompts', plugins: [] });
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const rename = async (lang, moved) => {
    env.g.I18n.setLanguage(lang);
    env.calls.toast.length = 0; env.calls.choice.length = 0; env.calls.ask.length = 0;
    env.apiFor = async () => ({ plugin: { name: 'yeni-ad', path: 'prompts/yeni-ad' }, moved });
    await env.ctx.renamePlugin('eski');
    return { toast: env.calls.toast[0][0], choice: plain(env.calls.choice[0]), ask: plain(env.calls.ask[0]) };
  };
  const remove = async (lang) => {
    env.g.I18n.setLanguage(lang);
    env.calls.toast.length = 0; env.calls.choice.length = 0;
    await env.ctx.deleteItem('prompts/a.md');
    return { toast: env.calls.toast[0][0], choice: plain(env.calls.choice[0]) };
  };
  const trOne = await rename('tr', 1);
  const enOne = await rename('en', 1);
  const trMany = await rename('tr', 3);
  const enMany = await rename('en', 3);
  assert.equal(trOne.toast, 'Plugin yeniden adlandırıldı: yeni-ad (1 prompt)');
  assert.equal(trMany.toast, 'Plugin yeniden adlandırıldı: yeni-ad (3 prompt)');
  assert.equal(enOne.toast, 'Plugin renamed: yeni-ad (1 prompt)');
  assert.equal(enMany.toast, 'Plugin renamed: yeni-ad (3 prompts)');
  assert.equal(trOne.choice.text, '"eski" → "yeni-ad". Promptların sürüm tag\'leri eski adla kalır, yayınlanmış çıktı (plugins/eski) kaynaksız kalır ve bir sonraki yayında temizlenir.');
  assert.equal(enOne.choice.text, '"eski" → "yeni-ad". The version tags of its prompts keep the old name, the published output (plugins/eski) is left without a source and is cleaned up at the next publish.');
  assert.deepEqual(trOne.choice.choices.map((c) => c.label), ['Vazgeç', 'Yeniden adlandır']);
  assert.deepEqual(enOne.choice.choices.map((c) => c.label), ['Cancel', 'Rename']);
  assert.deepEqual([trOne.ask.title, trOne.ask.ok], ["Plugin'i yeniden adlandır", 'Devam']);
  assert.deepEqual([enOne.ask.title, enOne.ask.ok], ['Rename plugin', 'Continue']);
  const trDelete = await remove('tr');
  const enDelete = await remove('en');
  assert.equal(trDelete.choice.text, '"prompts/a.md" çöp kutusuna (.pp/trash) taşınır. Git ile takip ediliyorsa geçmişte de durur.');
  assert.equal(enDelete.choice.text, '"prompts/a.md" is moved to the trash (.pp/trash). If it is tracked by git, it also stays in the history.');
  assert.deepEqual([trDelete.toast, enDelete.toast], ['Çöp kutusuna taşındı', 'Moved to the trash']);
  assert.deepEqual(await rename('tr', 1), trOne, 'tr yeniden aynı');
  assert.deepEqual(await remove('tr'), trDelete, 'tr yeniden aynı');
});

/** Summary: Uzak depo sekmesini (paintGitRemote) verilen /api/git/remotes yanıtıyla, verilen arayüz dilinde çizer; #rmBody çıktısını döner. */
async function remoteTabOut(lang, payload) {
  const g = uiGlobals({ browser: true });
  g.I18n.setLanguage(lang);
  const dom = stubDom();
  const ctx = load({ fns: ['paintGitRemote', 'providerLabel', 'remoteStatusLine'], consts: ['esc', 'fmtDate', 'activeName'] }, {
    ...g, S: { git: { isRepo: true, files: [] }, info: { activeMarketplace: XSS_INPUT }, glTok: 0 }, $: dom.$, $$: dom.$$,
    get: async () => payload, gitTabs: () => '', paintGit() {}
  });
  await ctx.paintGitRemote();
  return dom.els['#rmBody'].innerHTML;
}

test('Uzak depo sekmesi: açıklama (whyNo) seçimi, durum satırı, düğme etiketleri ve çoğul iki dilde; kullanıcı girdileri kaçışlı', async () => {
  const origin = { name: 'origin', url: XSS_INPUT, provider: 'diger' };
  const base = { remotes: [origin], branch: XSS_INPUT, upstream: 'origin/main', ahead: 0, behind: 0, pendingTags: [XSS_INPUT], lastCheck: { at: '2026-03-05T14:05:00.000Z', ok: false, error: XSS_INPUT } };
  const why = (out) => /id="rmWhy">([^<]*)</.exec(out)[1];
  const cases = [
    ['güncel', base, 'Uzak depoda yeni commit yok.', 'There are no new commits on the remote.'],
    ['ayrışmış', { ...base, ahead: 2, behind: 1 }, 'Yerelde push edilmemiş commit var ve uzak depo da ilerlemiş; bu araç birleştirme yapmaz.', 'There are local commits that have not been pushed and the remote has also moved ahead; this tool does not merge.'],
    ['1 commit geride', { ...base, behind: 1 }, 'Uzak depodaki 1 yeni commit ileri sarma ile alınır; birleştirme commit&#39;i üretilmez.', '1 new commit on the remote is brought in by fast-forward; no merge commit is created.'],
    ['3 commit geride', { ...base, behind: 3 }, 'Uzak depodaki 3 yeni commit ileri sarma ile alınır; birleştirme commit&#39;i üretilmez.', '3 new commits on the remote are brought in by fast-forward; no merge commit is created.']
  ];
  for (const [ad, payload, tr, en] of cases) {
    assert.equal(why(await remoteTabOut('tr', payload)), tr, 'tr ' + ad);
    assert.equal(why(await remoteTabOut('en', payload)), en, 'en ' + ad);
  }
  const trOut = await remoteTabOut('tr', { ...base, behind: 3 });
  const enOut = await remoteTabOut('en', { ...base, behind: 3 });
  const emptyTr = await remoteTabOut('tr', { ...base, remotes: [] });
  const emptyEn = await remoteTabOut('en', { ...base, remotes: [] });
  assert.ok(emptyTr.includes('<p class="hint">Henüz uzak depo yok. Aşağıdan GitHub ya da GitLab linkini ekle.</p>') && !emptyTr.includes('id="rmWhy"'));
  assert.ok(emptyEn.includes('<p class="hint">There is no remote yet. Add a GitHub or GitLab link below.</p>') && !emptyEn.includes('id="rmWhy"'));
  assert.ok(trOut.includes('<button class="btn primary" data-act="remote-push">Push et</button><button class="btn" data-act="remote-fetch">Kontrol et</button>'));
  assert.ok(enOut.includes('<button class="btn primary" data-act="remote-push">Push</button><button class="btn" data-act="remote-fetch">Check</button>'));
  assert.ok(trOut.includes('aria-describedby="rmWhy">Güncelle (yalnızca ileri sarma)</button>') && !/data-act="remote-pull" disabled/.test(trOut));
  assert.ok(enOut.includes('aria-describedby="rmWhy">Update (fast-forward only)</button>') && !/data-act="remote-pull" disabled/.test(enOut));
  assert.match(await remoteTabOut('en', base), /data-act="remote-pull" disabled/);
  assert.match(trOut, /<p>Dal <b>&lt;img[^<]*<\/b> → origin\/main · 0 önde · 3 geride \(son kontrol: [^)]+\)<\/p>/);
  assert.match(enOut, /<p>Branch <b>&lt;img[^<]*<\/b> → origin\/main · 0 ahead · 3 behind \(last check: [^)]+\)<\/p>/);
  assert.ok(trOut.includes('<div class="issue warn" role="status">Son kontrol başarısız: ' + XSS_ESCAPED + '</div>'));
  assert.ok(enOut.includes('<div class="issue warn" role="status">Last check failed: ' + XSS_ESCAPED + '</div>'));
  assert.ok(trOut.includes('Push bekleyen etiketler: ' + XSS_ESCAPED) && enOut.includes('Tags waiting to be pushed: ' + XSS_ESCAPED));
  assert.ok(trOut.includes('<span class="pill">Diğer</span>') && enOut.includes('<span class="pill">Other</span>'));
  assert.ok(trOut.includes('Etkin depo: <b>' + XSS_ESCAPED + '</b>') && enOut.includes('Active repository: <b>' + XSS_ESCAPED + '</b>'));
  for (const rendered of [trOut, enOut]) assert.ok(!rendered.includes('<img'), 'kullanıcı girdisi kaçışlı');
  const noUpstream = { ...base, upstream: null, lastCheck: null };
  assert.match(await remoteTabOut('tr', noUpstream), /<p>Dal <b>[^<]*<\/b> · 0 önde · 0 geride<\/p>/);
  assert.match(await remoteTabOut('en', noUpstream), /<p>Branch <b>[^<]*<\/b> · 0 ahead · 0 behind<\/p>/);
  assert.equal(await remoteTabOut('tr', { ...base, behind: 3 }), trOut, 'tr yeniden aynı: bayatlamaz');
});

/** Summary: Git değişiklikler sekmesini (paintGit) verilen durumla, verilen arayüz dilinde çizer; #mBody çıktısını döner. */
function gitPanelOut(lang, git) {
  const g = uiGlobals({ browser: true });
  g.I18n.setLanguage(lang);
  const dom = stubDom();
  const ctx = load({ fns: ['paintGit', 'gitTabs', 'branchLabel', 'branchLine', 'changeLabel'], consts: ['esc', 'base', 'stem', 'GLABEL_KEYS', 'gitTarget'] }, {
    ...g, S: { git, info: { activeMarketplace: 'mp', root: '/r' }, gitSel: null, gitSelTouched: false, gitMsg: '' }, $: dom.$, $$: dom.$$
  });
  ctx.paintGit();
  return dom.els['#mBody'].innerHTML;
}

test('Git paneli: değişiklik etiketleri, commit önerisi (tekil/çoğul) ve kimlik özeti iki dilde; bilinmeyen kod ham, dosya yolu kaçışlı', () => {
  const id = { name: 'A', email: 'a@b.c' };
  const files = [{ path: XSS_INPUT, code: 'M' }, { path: 'b.md', code: '?' }, { path: 'c.md', code: 'D' }, { path: 'd.md', code: 'A' }, { path: 'e.md', code: 'R' }, { path: 'f.md', code: 'Z' }];
  const many = { isRepo: true, branch: 'main', hasCommits: true, identity: id, files };
  const trOut = gitPanelOut('tr', many);
  const enOut = gitPanelOut('en', many);
  const pills = (out) => [...out.matchAll(/<span class="pill [^"]*">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(pills(trOut), ['değişti', 'yeni', 'silindi', 'eklendi', 'taşındı', 'Z']);
  assert.deepEqual(pills(enOut), ['modified', 'new', 'deleted', 'added', 'moved', 'Z']);
  assert.ok(trOut.includes('aria-label="' + XSS_ESCAPED + ' commit&#39;e dahil"'));
  assert.ok(enOut.includes('aria-label="' + XSS_ESCAPED + ' included in the commit"'));
  assert.ok(trOut.includes('>6 dosya güncellendi</textarea>') && enOut.includes('>6 files updated</textarea>'));
  assert.ok(trOut.includes('Değişiklikler (6)</button>') && enOut.includes('Changes (6)</button>'));
  assert.ok(trOut.includes('<summary>Git kimliği </summary>') && enOut.includes('<summary>Git identity </summary>'));
  for (const rendered of [trOut, enOut]) assert.ok(!rendered.includes('<img'), 'kullanıcı girdisi kaçışlı');
  const one = { ...many, identity: { name: '', email: '' }, files: [{ path: 'alt/ornek.md', code: 'M' }] };
  assert.ok(gitPanelOut('tr', one).includes('>ornek: güncelle</textarea>') && gitPanelOut('en', one).includes('>ornek: update</textarea>'));
  assert.ok(gitPanelOut('tr', one).includes('<summary>Git kimliği (commit için gerekli)</summary>'));
  assert.ok(gitPanelOut('en', one).includes('<summary>Git identity (required for committing)</summary>'));
  const none = { ...many, files: [] };
  assert.ok(gitPanelOut('tr', none).includes('<p>Commit bekleyen değişiklik yok. Her şey kayıtlı.</p>'));
  assert.ok(gitPanelOut('en', none).includes('<p>No changes are waiting to be committed. Everything is saved.</p>'));
  assert.ok(!gitPanelOut('en', none).includes('id="gMsg"'));
  assert.equal(gitPanelOut('tr', many), trOut, 'tr yeniden aynı: etiket tablosu bayatlamaz');
});

/** Summary: Uzak depo eylemlerini (pull/fetch) sahte api ile çalıştırır; toast, #rmMsg ve openGit çağrılarını kaydeder. */
function remoteActionCtx(lang, { withMsg = true } = {}) {
  const g = uiGlobals({ browser: true });
  g.I18n.setLanguage(lang);
  const env = { toasts: [], opened: [], msg: { innerHTML: '' }, response: null, failure: null };
  env.ctx = load({ fns: ['remotePull', 'remoteFetch', 'rmMsg', 'netErrHtml'], consts: ['esc'] }, {
    ...g, S: { info: { root: '/r' }, cur: null, remoteCheck: null },
    $: (selector) => (selector === '#rmMsg' && withMsg ? env.msg : null),
    api: async () => { if (env.failure) throw env.failure; return env.response; },
    toast: (message, kind, ms) => env.toasts.push([message, kind || null, ms || null]), fail(e) { throw e; },
    openGit: (tab) => env.opened.push(tab), paintRemoteBadge() {}, paintRemoteBand() {}, paintGitRemote: async () => {}, afterWrite: async () => {}, loadHistory() {},
    cmdLine: (text) => '<cmd>' + text + '</cmd>'
  });
  return env;
}

test('Uzak depo eylemleri: hata koduna göre yardım metni (sunucu iletisi yok sayılır), çoğul toast; iki dilde', async () => {
  const pulled = async (lang, tags) => { const env = remoteActionCtx(lang); env.response = { adoptedTags: tags }; await env.ctx.remotePull(); return env.toasts[0][0]; };
  assert.deepEqual([await pulled('tr', []), await pulled('tr', ['a']), await pulled('tr', ['a', 'b', 'c'])], ['Güncellendi', 'Güncellendi: 1 yeni etiket', 'Güncellendi: 3 yeni etiket']);
  assert.deepEqual([await pulled('en', []), await pulled('en', ['a']), await pulled('en', ['a', 'b', 'c'])], ['Updated', 'Updated: 1 new tag', 'Updated: 3 new tags']);
  const failed = async (lang, code, message, withMsg = true) => {
    const env = remoteActionCtx(lang, { withMsg });
    env.failure = Object.assign(new Error(message), { data: { code } });
    await env.ctx.remotePull();
    return env;
  };
  const dirtyTr = (await failed('tr', 'kirliCalismaAgaci', 'Sunucu metni')).msg.innerHTML;
  const dirtyEn = (await failed('en', 'kirliCalismaAgaci', 'Sunucu metni')).msg.innerHTML;
  assert.equal(dirtyTr, '<div class="issue warn" role="alert">Önce değişiklikleri commit et. <button class="btn sm" data-act="git-tab" data-tab="changes">Değişiklikler sekmesini aç</button></div>');
  assert.equal(dirtyEn, '<div class="issue warn" role="alert">Commit your changes first. <button class="btn sm" data-act="git-tab" data-tab="changes">Open the Changes tab</button></div>');
  const divTr = (await failed('tr', 'ayristi', 'Sunucu metni')).msg.innerHTML;
  const divEn = (await failed('en', 'ayristi', 'Sunucu metni')).msg.innerHTML;
  assert.ok(divTr.includes('Yerelde push edilmemiş commit var ve uzak depo da ilerlemiş. Bu araç birleştirme yapmaz.<cmd>git -C /r pull --rebase</cmd>'));
  assert.ok(divEn.includes('There are local commits that have not been pushed and the remote has also moved ahead. This tool does not merge.<cmd>git -C /r pull --rebase</cmd>'));
  assert.ok(!divTr.includes('Sunucu metni') && !divEn.includes('Sunucu metni'), 'kodlu hatada sunucu iletisi yerine arayüz metni');
  const other = await failed('en', 'baska', XSS_INPUT);
  assert.equal(other.msg.innerHTML, '<div class="issue warn" role="alert">' + XSS_ESCAPED + '</div>', 'bilinmeyen kod: sunucu iletisi ham, kaçışlı');
  const noPanel = await failed('en', 'ayristi', 'Sunucu metni', false);
  assert.deepEqual(noPanel.toasts, [['Sunucu metni', 'error', 8000]]);
  assert.deepEqual(noPanel.opened, ['remote']);
  const fetched = async (lang, behind) => { const env = remoteActionCtx(lang, { withMsg: false }); env.response = { ok: true, behind }; await env.ctx.remoteFetch(true); return env.toasts[0][0]; };
  assert.deepEqual([await fetched('tr', 0), await fetched('tr', 2)], ['Uzak depo güncel', '2 yeni commit var']);
  assert.deepEqual([await fetched('en', 0), await fetched('en', 1), await fetched('en', 2)], ['The remote is up to date', '1 new commit is available', '2 new commits are available']);
});

test('Uzak depo rozeti ve şeridi: çoğul başlık/metin iki dilde, etiket adı kaçışlı, 3 etiketten sonra ellipsis; dil değişince bayatlamaz', () => {
  const run = (lang, check) => {
    const g = uiGlobals({ browser: true });
    g.I18n.setLanguage(lang);
    const els = {};
    const main = { placed: null, prepend(node) { main.placed = node; } };
    const ctx = load({ fns: ['paintRemoteBadge', 'paintRemoteBand'], consts: ['esc'] }, {
      ...g, S: { remoteCheck: check }, setupOk: () => true, ls: { get: (key, fallback) => fallback }, lsKey: (key) => key,
      $: (selector) => (selector === '#remoteBand' ? null : selector === '#main' ? main : (els[selector] = els[selector] || { setAttribute() {} })),
      document: { createElement: () => ({ setAttribute() {} }) }
    });
    ctx.paintRemoteBadge();
    ctx.paintRemoteBand();
    return { title: els['#gitDown'] && els['#gitDown'].title, band: main.placed ? main.placed.innerHTML : null };
  };
  const behind3 = { ok: true, behind: 3, newTags: [XSS_INPUT, 'b', 'c', 'd'], checkedAt: 'x1' };
  const trBand = run('tr', behind3).band;
  const enBand = run('en', behind3).band;
  assert.ok(trBand.includes('Uzak depoda yeni sürüm var: 3 commit, ' + XSS_ESCAPED + ', b, c ….'));
  assert.ok(enBand.includes('There is a new version on the remote: 3 commits, ' + XSS_ESCAPED + ', b, c ….'));
  assert.ok(trBand.includes('>Ayrıntılar</button>') && trBand.includes('>Güncelle</button>') && trBand.includes('aria-label="Bildirimi kapat">Kapat</button>'));
  assert.ok(enBand.includes('>Details</button>') && enBand.includes('>Update</button>') && enBand.includes('aria-label="Dismiss the notification">Close</button>'));
  assert.ok(!trBand.includes('<img') && !enBand.includes('<img'));
  assert.ok(run('en', { ok: true, behind: 1, newTags: [], checkedAt: 'x2' }).band.includes('remote: 1 commit.'));
  const onlyTag = run('en', { ok: true, behind: 0, newTags: ['t'], checkedAt: 'x3' }).band;
  assert.ok(onlyTag.includes('remote: t.') && onlyTag.includes('data-act="remote-pull" disabled'));
  const titles = (lang) => [1, 3].map((n) => run(lang, { ok: true, behind: n, newTags: [] }).title);
  assert.deepEqual(titles('tr'), ['Uzak depoda 1 yeni commit var', 'Uzak depoda 3 yeni commit var']);
  assert.deepEqual(titles('en'), ['There is 1 new commit on the remote', 'There are 3 new commits on the remote']);
  assert.equal(run('tr', { ok: false }).title, 'Uzak depo kontrol edilemedi, elle kontrol et');
  assert.equal(run('en', { ok: false }).title, 'Could not check the remote; check it manually');
  assert.equal(run('tr', behind3).band, trBand, 'tr yeniden aynı');
});

/** Summary: vm bağlamında üretilen değeri düz (aynı gerçeklikte) nesneye çevirir; deepEqual için. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Summary: Tarayıcı kipi I18n'e bağlı Rules ile çeviri global'leri (Rules.LEVEL_LABEL ve kural iletileri dili izler). */
function browserRulesGlobals() {
  const g = uiGlobals({ browser: true });
  const rulesCtx = vm.createContext({ I18n: g.I18n, FM });
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'rules.js'), 'utf8'), rulesCtx, { filename: 'rules.js' });
  return { ...g, FM, Rules: rulesCtx.Rules };
}

/** Summary: Marketplace paneli işlevlerinin yüklü olduğu vm bağlamı, verilen arayüz dilinde. */
function marketCtx(lang, { hasPpConfig = true } = {}) {
  const g = browserRulesGlobals();
  g.I18n.setLanguage(lang);
  return load({ fns: ['turLabel', 'mkStateText', 'mkListHtml', 'mkCmdsHtml', 'mkPackagesHtml', 'marketHtml'], consts: ['esc', 'cmdLine', 'DURUM_OPTS'] }, {
    ...g, activeName: () => 'mp', mpByName: () => ({ name: 'mp', hasPpConfig })
  });
}

const MK_STATE = {
  config: { owner: 'O', plugin: 'p', version: '1.0.0', description: '' }, marketplaceName: 'mp', export: { durumlar: ['kararlı'] },
  marketplaceExists: true, marketplacePlugins: ['a', 'b'],
  items: [{ source: 'a.md', baslik: XSS_INPUT, tur: 'ajan', paket: 'kod', target: 'plugins/kod/agents/a.md', issues: [], state: 'eski' }],
  orphans: [{ target: 'plugins/x.md', likelySource: { source: 'b.md', reason: XSS_INPUT } }],
  skipped: [{ source: 'b.md', baslik: 'B', reason: 'r' }], unpublishedCount: 1,
  commands: { validate: 'v', add: 'a', alternatives: [], pinHint: XSS_INPUT, install: [] }
};

test('Marketplace paneli: durum seçenekleri, çoğullar, kopyala düğmesi ve "Kaynağı kalmayan dosyalar" başlığı iki dilde; veri değerleri ve kullanıcı girdisi korunur', () => {
  const trCtx = marketCtx('tr');
  const enCtx = marketCtx('en');
  const trOut = trCtx.marketHtml(MK_STATE);
  const enOut = enCtx.marketHtml(MK_STATE);
  assert.ok(trOut.includes('value="kararlı" checked> Kararlı</label>') && trOut.includes('value="taslak" > Taslak</label>') && trOut.includes('value="arşiv" > Arşiv</label>') && trOut.includes('value="" > Durumu boş</label>'));
  assert.ok(enOut.includes('value="kararlı" checked> Stable</label>') && enOut.includes('value="taslak" > Draft</label>') && enOut.includes('value="arşiv" > Archived</label>') && enOut.includes('value="" > No status</label>'));
  assert.ok(trOut.includes('<h3>Kaynağı kalmayan dosyalar</h3>') && enOut.includes('<h3>Files without a source</h3>'));
  assert.ok(trOut.includes('Kaynağı muhtemelen <button class="link" data-act="open-close" data-path="b.md">B</button>: ' + XSS_ESCAPED));
  assert.ok(enOut.includes('The source is probably <button class="link" data-act="open-close" data-path="b.md">B</button>: ' + XSS_ESCAPED));
  assert.ok(trOut.includes('<span class="pill">ajan</span>') && enOut.includes('<span class="pill">agent</span>'));
  assert.ok(trOut.includes('<p class="hint">1 prompt bilinçli olarak yayın dışı (tür seçilmemiş).</p>'));
  assert.ok(enOut.includes('<p class="hint">1 prompt is intentionally not published (no type selected).</p>'));
  assert.ok(enCtx.mkListHtml({ ...MK_STATE, unpublishedCount: 3 }).includes('3 prompts are intentionally not published'));
  assert.ok(trOut.includes('data-act="mk-update">Marketplace\'i güncelle</button>') && enOut.includes('data-act="mk-update">Update marketplace</button>'));
  assert.ok(trOut.includes('"Marketplace\'i güncelle" bunları çöp kutusuna taşır.') && enOut.includes('"Update marketplace" moves them to the trash.'));
  assert.ok(trOut.includes('<code>' + XSS_ESCAPED + '</code>') && enOut.includes('<code>' + XSS_ESCAPED + '</code>'));
  assert.ok(trOut.includes('Henüz yayınlanmış paket yok. Paket sayfasından Yayınla.') && enOut.includes('There are no published packages yet. Publish from the package page.'));
  assert.ok(trCtx.mkCmdsHtml(MK_STATE).includes('data-text="v">Kopyala</button>') && enCtx.mkCmdsHtml(MK_STATE).includes('data-text="v">Copy</button>'));
  for (const rendered of [trOut, enOut]) assert.ok(!rendered.includes('<img'), 'kullanıcı girdisi kaçışlı');
  const pkgs = [{ name: 'a<', version: '', changedCount: 1, blocking: 1, pendingPush: true }, { name: 'b', version: '2.0.0', changedCount: 2, blocking: 2, pendingPush: false }];
  const trPkgs = trCtx.mkPackagesHtml(pkgs);
  const enPkgs = enCtx.mkPackagesHtml(pkgs);
  assert.ok(trPkgs.includes('<span class="pill">yayınlanmadı</span>') && trPkgs.includes('1 değişiklik · <span class="issue error">1 engelleyici sorun</span> · <span class="pill warn">Push bekliyor</span>') && trPkgs.includes('>Aç</button>'));
  assert.ok(enPkgs.includes('<span class="pill">not yet published</span>') && enPkgs.includes('1 change · <span class="issue error">1 blocking issue</span> · <span class="pill warn">Push pending</span>') && enPkgs.includes('>Open</button>'));
  assert.ok(enPkgs.includes('2 changes · <span class="issue error">2 blocking issues</span>') && trPkgs.includes('2 değişiklik · <span class="issue error">2 engelleyici sorun</span>'));
  const states = (lang) => [{ marketplaceExists: false }, { marketplaceExists: true, marketplacePlugins: [] }, MK_STATE].map((st) => marketCtx(lang).mkStateText(st));
  assert.deepEqual(states('tr'), ['Henüz yazılmadı', 'marketplace.json mevcut: paket yok', 'marketplace.json mevcut: a, b']);
  assert.deepEqual(states('en'), ['Not written yet', 'marketplace.json exists: no packages', 'marketplace.json exists: a, b']);
  const noCfg = marketCtx('en', { hasPpConfig: false }).marketHtml(MK_STATE);
  assert.ok(noCfg.includes('has no Prompt Havuzu settings (pp.config.json). <button class="btn sm" data-act="mk-ppconfig" data-name="mp">Create settings file</button>'));
  assert.ok(marketCtx('tr', { hasPpConfig: false }).marketHtml(MK_STATE).includes("Bu marketplace'te Prompt Havuzu ayarı (pp.config.json) yok. <button"));
  assert.equal(trCtx.marketHtml(MK_STATE), trOut, 'tr yeniden aynı: DURUM_OPTS ve etiketler bayatlamaz');
});

/** Summary: "Marketplace'i güncelle" onay penceresini ve sonuç toast'ını verilen dilde çalıştırır; askChoice ve toast çağrılarını kaydeder. */
async function mkUpdateRun(lang, mk, response) {
  const g = browserRulesGlobals();
  g.I18n.setLanguage(lang);
  const env = { choices: [], toasts: [] };
  const ctx = load({ fns: ['mkUpdate'] }, {
    ...g, S: { mk }, askChoice: async (o) => { env.choices.push(o); return 'yes'; }, api: async () => response,
    toast: (message, kind, ms) => env.toasts.push([message, kind, ms]), openMarket: async () => {}, afterWrite: async () => {}, fail(e) { throw e; }, $: () => null
  });
  await ctx.mkUpdate();
  return env;
}

test('Marketplace güncelleme onayı: dosya sayıları, kaldırılacaklar listesi (6 ile kısaltılır) ve sonuç toast\'ları iki dilde', async () => {
  const orphans = Array.from({ length: 8 }, (unused, i) => ({ target: 'p' + i }));
  const mk = { items: [{ state: 'eski' }, { state: 'guncel' }], orphans };
  const skippedResponse = { commit: true, skippedPackages: [{ name: 'a' }, { name: 'b' }] };
  const trSkipped = await mkUpdateRun('tr', mk, skippedResponse);
  const enSkipped = await mkUpdateRun('en', mk, skippedResponse);
  assert.equal(trSkipped.choices[0].title, "Marketplace'i güncelle");
  assert.equal(trSkipped.choices[0].text, '1 dosya yazılacak, 8 dosya kaldırılacak (çöp kutusuna). Katalog sürümü artmaz, etiket atılmaz, push edilmez. Kaldırılacaklar: p0, p1, p2, p3, p4, p5 …');
  assert.deepEqual(plain(trSkipped.choices[0].choices.map((c) => c.label)), ['Vazgeç', 'Güncelle']);
  assert.equal(enSkipped.choices[0].title, 'Update marketplace');
  assert.equal(enSkipped.choices[0].text, 'Files to write: 1. Files to remove (moved to the trash): 8. The catalog version is not bumped, no tag is created, and nothing is pushed. To be removed: p0, p1, p2, p3, p4, p5 …');
  assert.deepEqual(plain(enSkipped.choices[0].choices.map((c) => c.label)), ['Cancel', 'Update']);
  assert.deepEqual(trSkipped.toasts, [['Marketplace güncellendi Engelleyici sorunu olan paketler atlandı: a, b.', 'error', 7000]]);
  assert.deepEqual(enSkipped.toasts, [['Marketplace updated. Packages with blocking issues were skipped: a, b.', 'error', 7000]]);
  const none = { items: [], orphans: [] };
  const trNone = await mkUpdateRun('tr', none, { commit: false });
  const enNone = await mkUpdateRun('en', none, { commit: false });
  assert.equal(trNone.choices[0].text, '0 dosya yazılacak, 0 dosya kaldırılacak (çöp kutusuna). Katalog sürümü artmaz, etiket atılmaz, push edilmez.');
  assert.equal(enNone.choices[0].text, 'Files to write: 0. Files to remove (moved to the trash): 0. The catalog version is not bumped, no tag is created, and nothing is pushed.');
  assert.deepEqual([trNone.toasts[0], enNone.toasts[0]], [['Değişiklik yok', 'ok', 3000], ['No changes', 'ok', 3000]]);
  assert.equal((await mkUpdateRun('en', none, { commit: true })).toasts[0][0], 'Marketplace updated');
  assert.equal((await mkUpdateRun('tr', none, { commit: false, skippedPackages: [{ name: 'z' }] })).toasts[0][0], 'Değişiklik yok Engelleyici sorunu olan paketler atlandı: z.');
});

/** Summary: Paket sayfası işlevlerinin yüklü olduğu vm bağlamı (sahte DOM, kayıt tutan toast/api), verilen arayüz dilinde. */
function pkCtx(lang, d, state = {}) {
  const g = browserRulesGlobals();
  g.I18n.setLanguage(lang);
  const dom = stubDom();
  const env = { dom, toasts: [], calls: [], response: null };
  env.S = { pk: { d, msg: null, ...state } };
  env.ctx = load({
    fns: ['turLabel', 'pkChangeLabel', 'pkOptions', 'pkHtml', 'pkChosen', 'pkValidate', 'pkAsk', 'pkPublish', 'pkPushOnly', 'showFieldErr', 'errText'], consts: ['esc', 'PK_CHANGE_KEYS']
  }, {
    ...g, S: env.S, $: dom.$, $$: dom.$$, activeName: () => 'mp', fmtDate: (iso) => 'D:' + iso,
    toast: (message, kind, ms) => env.toasts.push([message, kind || null, ms || null]), api: async (method, url, body) => { env.calls.push([method, url, body]); return env.response; },
    pkLoad: async () => {}, afterWrite: async () => {}, loadHistory() {}, loadGit() {}, setInterval: () => 1, clearInterval() {}
  });
  return env;
}

const PK_DATA = {
  name: 'kod', version: '1.0.0', lastTag: { name: 'paket/kod/v1.0.0', date: 'X' }, pendingPush: false, description: 'd', remote: 'origin', dirty: [], issues: [], baseVersion: '1.0.0',
  proposal: { level: 'kucuk', tagOnly: false, reasons: [], noChange: false },
  prompts: [
    { source: 'a.md', baslik: XSS_INPUT, tur: 'komut', ad: 'a', oldVersiyon: '1.0.0', versiyon: '1.1.0', tagged: false, change: 'degisti', level: 'kucuk', issues: [] },
    { source: 'b.md', baslik: 'B', tur: 'ajan', ad: 'b', versiyon: '', change: 'yeni', level: 'yama', issues: [] },
    { source: 'c.md', baslik: 'C', tur: 'skill', ad: 'c', versiyon: '2.0.0', change: 'ayni', level: null, issues: [] },
    { source: 'd.md', baslik: 'D', tur: 'komut', ad: 'd', versiyon: '', change: XSS_INPUT, level: 'buyuk', issues: [] }
  ],
  removed: [{ target: 'plugins/kod/x.md', level: 'buyuk' }], excluded: [], marketplaceVersion: { current: '1.0.3', proposal: '1.0.4' }, tags: [{ version: '1.0.0' }], exportedCount: 4
};

test('Paket sayfası: sürüm seçenekleri (Rules.LEVEL_LABEL), değişim etiketleri, durum satırı ve tablo iki dilde; bilinmeyen değer ham ve kaçışlı, etiketler bayatlamaz', () => {
  const opts = (lang, d) => plain(pkCtx(lang, d).ctx.pkOptions(d).map((o) => o.label));
  assert.deepEqual(opts('tr', PK_DATA), ['Büyük 2.0.0', 'Küçük 1.1.0 (önerilen)', 'Yama 1.0.1']);
  assert.deepEqual(opts('en', PK_DATA), ['Major 2.0.0', 'Minor 1.1.0 (recommended)', 'Patch 1.0.1']);
  const firstD = { ...PK_DATA, baseVersion: null };
  const tagD = { ...PK_DATA, proposal: { ...PK_DATA.proposal, tagOnly: true } };
  assert.deepEqual([opts('tr', firstD), opts('tr', tagD)], [['İlk sürüm 1.0.0 (önerilen)'], ['Mevcut 1.0.0 sürümünü etiketle (önerilen)']]);
  assert.deepEqual([opts('en', firstD), opts('en', tagD)], [['First version 1.0.0 (recommended)'], ['Tag the existing version 1.0.0 (recommended)']]);
  const trOut = pkCtx('tr', PK_DATA).ctx.pkHtml(PK_DATA);
  const enOut = pkCtx('en', PK_DATA).ctx.pkHtml(PK_DATA);
  assert.ok(trOut.includes('Etkin marketplace: <b>mp</b> · Sürüm: v1.0.0 · Son etiket: paket/kod/v1.0.0 (D:X)'));
  assert.ok(enOut.includes('Active marketplace: <b>mp</b> · Version: v1.0.0 · Last tag: paket/kod/v1.0.0 (D:X)'));
  const bare = { ...PK_DATA, version: '', lastTag: null, remote: '' };
  assert.ok(pkCtx('tr', bare).ctx.pkHtml(bare).includes('Sürüm: yayınlanmadı · Son etiket: yok'));
  assert.ok(pkCtx('en', bare).ctx.pkHtml(bare).includes('Version: not yet published · Last tag: none'));
  assert.ok(pkCtx('tr', bare).ctx.pkHtml(bare).includes('Uzak depo yok, yerelde yayınlanacak.'));
  assert.ok(pkCtx('en', bare).ctx.pkHtml(bare).includes('There is no remote; it will be published locally only.'));
  assert.ok(trOut.includes('<span class="pill warn">Değişti</span></td><td>Küçük</td>') && trOut.includes('<span class="pill bad">Kaldırıldı</span></td><td>Büyük</td>'));
  assert.ok(enOut.includes('<span class="pill warn">Changed</span></td><td>Minor</td>') && enOut.includes('<span class="pill bad">Removed</span></td><td>Major</td>'));
  assert.ok(enOut.includes('<span class="pill warn">New</span></td><td>Patch</td>') && enOut.includes('<span class="pill ">Unchanged</span></td><td>—</td>'));
  assert.ok(trOut.includes('<span class="pill warn">' + XSS_ESCAPED + '</span></td><td>Büyük</td>') && enOut.includes('<span class="pill warn">' + XSS_ESCAPED + '</span></td><td>Major</td>'));
  assert.ok(trOut.includes('<th scope="col">Değişim</th><th scope="col">Seviye</th>') && enOut.includes('<th scope="col">Change</th><th scope="col">Level</th>'));
  assert.ok(trOut.includes('<td>komut</td>') && enOut.includes('<td>command</td>') && enOut.includes('<td>agent</td>') && enOut.includes('<td>skill</td>'));
  assert.ok(trOut.includes('<legend>Yeni sürüm</legend>') && enOut.includes('<legend>New version</legend>'));
  assert.ok(trOut.includes('> Özel <input id="pkCustom"') && enOut.includes('> Custom <input id="pkCustom"'));
  assert.ok(trOut.includes('<label>Katalog sürümü <input id="pkCat"') && enOut.includes('<label>Catalog version <input id="pkCat"'));
  assert.ok(trOut.includes('Mevcut: 1.0.3. "Marketplace\'i güncelle" bunu artırmaz.') && enOut.includes('Current: 1.0.3. "Update marketplace" does not bump this.'));
  assert.ok(trOut.includes('> Push et (origin)</label>') && enOut.includes('> Push (origin)</label>'));
  assert.ok(trOut.includes('aria-describedby="pkWhy">Yayınla</button>') && enOut.includes('aria-describedby="pkWhy">Publish</button>'));
  assert.ok(pkCtx('en', tagD).ctx.pkHtml(tagD).includes('aria-describedby="pkWhy">Tag version 1.0.0</button>') && pkCtx('tr', tagD).ctx.pkHtml(tagD).includes('>1.0.0 sürümünü etiketle</button>'));
  for (const rendered of [trOut, enOut]) assert.ok(!rendered.includes('<img'), 'kullanıcı girdisi kaçışlı');
  assert.equal(pkCtx('tr', PK_DATA).ctx.pkHtml(PK_DATA), trOut, 'tr yeniden aynı');
});

test('Paket yayını: anında doğrulama iletileri, onay metni (push var/yok), ilerleme, toast ve hata iletileri iki dilde', async () => {
  const checkOut = (lang, d, { custom = '0.9.0', cat = '1.0.4' } = {}) => {
    const env = pkCtx(lang, d);
    env.dom.checks = [{ checked: true, dataset: { id: 'ozel' }, value: '' }];
    env.dom.els['#pkCustom'].value = custom;
    env.dom.els['#pkCat'].value = cat;
    const ok = env.ctx.pkValidate();
    return { ok, why: env.dom.els['#pkWhy'].textContent, ver: env.dom.els['#pkVerErr'].textContent, cat: env.dom.els['#pkCatErr'].textContent };
  };
  const bad = { ...PK_DATA, dirty: ['x.md'], issues: [{ msg: 'm' }], exportedCount: 0, proposal: { ...PK_DATA.proposal, noChange: true } };
  const trBad = checkOut('tr', bad, { custom: '0.9.0', cat: '0.0.1' });
  const enBad = checkOut('en', bad, { custom: '0.9.0', cat: '0.0.1' });
  assert.equal(trBad.ver, 'Sürüm son yayından (1.0.0) büyük olmalı');
  assert.equal(enBad.ver, 'The version must be greater than the last published version (1.0.0)');
  assert.equal(trBad.cat, 'Katalog sürümü mevcut sürümden (1.0.3) küçük olamaz');
  assert.equal(enBad.cat, 'The catalog version cannot be lower than the current version (1.0.3)');
  assert.equal(trBad.why, 'Önce engelleyici sorunları gider. Önce kaydedilmemiş dosyaları commit et. Pakette yayınlanacak prompt yok. Sürüm son yayından (1.0.0) büyük olmalı Katalog sürümü mevcut sürümden (1.0.3) küçük olamaz');
  assert.equal(enBad.why, 'Resolve the blocking issues first. Commit the unsaved files first. There are no prompts to publish in this package. The version must be greater than the last published version (1.0.0) The catalog version cannot be lower than the current version (1.0.3)');
  assert.equal(checkOut('tr', PK_DATA, { custom: '1.1.0', cat: '1.0.4' }).ver, '');
  const tagged = { ...PK_DATA, tags: [{ version: '1.2.0' }] };
  assert.equal(checkOut('tr', tagged, { custom: '1.2.0' }).ver, 'Bu sürümün etiketi zaten var: paket/kod/v1.2.0');
  assert.equal(checkOut('en', tagged, { custom: '1.2.0' }).ver, 'A tag for this version already exists: paket/kod/v1.2.0');
  const noChange = { ...PK_DATA, proposal: { ...PK_DATA.proposal, noChange: true } };
  assert.equal(checkOut('tr', noChange, { custom: '1.2.0' }).ok, true);
  assert.equal(checkOut('en', { ...noChange, dirty: ['x'] }, { custom: '1.2.0' }).why, 'Commit the unsaved files first.');
  const askOut = (lang, push) => {
    const env = pkCtx(lang, PK_DATA);
    env.dom.checks = [{ checked: true, dataset: { id: 'ozel' }, value: '' }];
    env.dom.els['#pkCustom'].value = '1.1.0';
    env.dom.els['#pkCat'].value = '1.0.4';
    env.dom.els['#pkPush'].checked = push;
    env.ctx.pkAsk();
    return env.dom.els['#pkConfirm'].innerHTML;
  };
  assert.ok(askOut('tr', false).startsWith('<div class="issue warn" role="alert">kod 1.1.0 olarak yayınlanacak: 3 dosya yazılacak, 1 dosya kaldırılacak, katalog sürümü 1.0.4, commit + paket/kod/v1.1.0 etiketi.</div>'));
  assert.ok(askOut('tr', true).includes('etiketi, origin&#39;e push.</div>'));
  assert.ok(askOut('en', false).startsWith('<div class="issue warn" role="alert">Publishing kod as 1.1.0: files to write: 3, files to remove: 1, catalog version 1.0.4, commit + tag paket/kod/v1.1.0.</div>'));
  assert.ok(askOut('en', true).includes('commit + tag paket/kod/v1.1.0, push to origin.</div>'));
  assert.ok(askOut('tr', true).includes('id="pkOk">Onayla ve yayınla</button><button class="btn" data-act="pk-cancel">Vazgeç</button>'));
  assert.ok(askOut('en', true).includes('id="pkOk">Confirm and publish</button><button class="btn" data-act="pk-cancel">Cancel</button>'));
  const published = async (lang, response, error) => {
    const env = pkCtx(lang, PK_DATA, { pending: { version: '1.1.0', marketplaceVersion: '1.0.4', push: true } });
    env.response = response;
    if (error) env.ctx.api = async () => { throw error; };
    await env.ctx.pkPublish();
    return { toasts: env.toasts, msg: env.S.pk && env.S.pk.msg, prog: env.dom.els['#pkProg'].textContent };
  };
  const trPushed = await published('tr', { version: '1.1.0', push: { ok: true } });
  const enPushed = await published('en', { version: '1.1.0', push: { ok: true } });
  assert.deepEqual([trPushed.toasts, enPushed.toasts], [[['kod 1.1.0 yayınlandı, push edildi', 'ok', 4000]], [['kod 1.1.0 published and pushed', 'ok', 4000]]]);
  assert.deepEqual([trPushed.prog, enPushed.prog], ['Doğrulanıyor ve çıktı yazılıyor…', 'Validating and writing the output…']);
  assert.deepEqual([(await published('tr', { version: '1.1.0' })).toasts[0][0], (await published('en', { version: '1.1.0' })).toasts[0][0]], ['kod 1.1.0 yayınlandı', 'kod 1.1.0 published']);
  const pending = { version: '1.1.0', push: { ok: false, error: XSS_INPUT } };
  assert.deepEqual(plain((await published('tr', pending)).msg), { kind: 'warn', text: 'Yerelde yayınlandı, push bekliyor: ' + XSS_INPUT, retry: true });
  assert.deepEqual(plain((await published('en', pending)).msg), { kind: 'warn', text: 'Published locally, push pending: ' + XSS_INPUT, retry: true });
  const needId = Object.assign(new Error('boom'), { data: { needIdentity: true } });
  assert.equal((await published('tr', null, needId)).msg.text, 'boom (Git panelinden kimliği gir)');
  assert.equal((await published('en', null, needId)).msg.text, 'boom (enter your identity in the Git panel)');
  assert.equal((await published('en', null, new Error('boom'))).msg.text, 'boom');
  const pushOnly = async (lang, response) => {
    const env = pkCtx(lang, PK_DATA);
    env.response = response;
    await env.ctx.pkPushOnly();
    return plain({ msg: env.S.pk.msg, toasts: env.toasts });
  };
  assert.deepEqual(await pushOnly('tr', { ok: true }), { msg: { kind: 'info', text: 'Push edildi.' }, toasts: [['Push edildi', null, null]] });
  assert.deepEqual(await pushOnly('en', { ok: true }), { msg: { kind: 'info', text: 'Pushed.' }, toasts: [['Pushed', null, null]] });
  assert.deepEqual((await pushOnly('en', { ok: false, error: 'x' })).msg, { kind: 'warn', text: 'Push failed: x', retry: true });
  assert.deepEqual((await pushOnly('tr', { ok: false, error: 'x' })).msg, { kind: 'warn', text: 'Push başarısız: x', retry: true });
});

/** Summary: Kurulum ekranı işlevlerinin yüklü olduğu vm bağlamı; `$` sahte DOM, `S` verilen durum. */
function setupScreenCtx(S) {
  const g = uiGlobals({ browser: true });
  const dom = stubDom();
  const ctx = load({ fns: ['actionLabel', 'issueButton', 'renderSetup', 'renderPick', 'lostEditHtml'], consts: ['esc', 'base', 'ACTION_LABEL_KEYS'] }, { ...g, S, $: dom.$ });
  return { g, dom, ctx };
}

test('Kurulum ekranı: rozetler, eylem düğmeleri ve ipuçları iki dilde; sunucu iletisi ham, girdiler kaçışlı; ACTION_LABEL_KEYS dil değişince bayatlamaz', () => {
  const issues = [
    { level: 'error', message: 'Kök yok', action: 'ayarlar' },
    { level: 'error', message: XSS_INPUT, action: 'gitBaslat' },
    { level: 'warn', message: 'Seç', action: 'marketplaceSec' },
    { level: 'warn', message: 'Eksik', action: 'ppConfigOlustur' },
    { level: 'error', message: 'Yok', action: 'yeniMarketplace' },
    { level: 'warn', message: 'Eylemsiz', action: 'bilinmeyen' }
  ];
  const S = { info: { setup: { issues }, configPath: XSS_INPUT, activeMarketplace: XSS_INPUT }, lostEdit: null };
  const { g, dom, ctx } = setupScreenCtx(S);
  const render = (lang) => { g.I18n.setLanguage(lang); ctx.renderSetup(); return dom.els['#main'].innerHTML; };
  const trOut = render('tr');
  const enOut = render('en');
  assert.ok(trOut.includes('<h1 id="setupTitle" tabindex="-1">Kuruluma devam et</h1>'));
  assert.ok(trOut.includes('<span class="pill bad">Hata</span><span class="msg">Kök yok</span><button class="btn sm" data-act="settings">Ayarları aç</button>'));
  assert.ok(trOut.includes('<span class="pill warn">Uyarı</span><span class="msg">Eylemsiz</span></li>'));
  assert.ok(trOut.includes('data-act="mk-git-init" data-confirm data-name="' + XSS_ESCAPED + '">Git&#39;i başlat</button>'));
  assert.ok(trOut.includes('Ağaçtan seç') && trOut.includes('Ayar dosyası oluştur') && trOut.includes('>Yeni marketplace</button>'));
  assert.ok(trOut.includes('Ayar dosyası: <code>' + XSS_ESCAPED + '</code>'));
  assert.ok(enOut.includes('<h1 id="setupTitle" tabindex="-1">Continue setup</h1>'));
  assert.ok(enOut.includes('<span class="pill bad">Error</span><span class="msg">Kök yok</span><button class="btn sm" data-act="settings">Open Settings</button>'));
  assert.ok(enOut.includes('<span class="pill warn">Warning</span><span class="msg">Eylemsiz</span></li>'));
  assert.ok(enOut.includes('data-name="' + XSS_ESCAPED + '">Initialize git</button>'));
  assert.ok(enOut.includes('Select from the tree') && enOut.includes('Create settings file') && enOut.includes('>New marketplace</button>'));
  assert.ok(enOut.includes('Settings file: <code>' + XSS_ESCAPED + '</code>'));
  assert.ok(enOut.includes('<span class="msg">' + XSS_ESCAPED + '</span>'), 'sunucu iletisi çevrilmeden, kaçışlı');
  assert.ok(!trOut.includes('<img') && !enOut.includes('<img'));
  assert.equal(render('tr'), trOut, 'tr yeniden aynı');
  const codes = ['ayarlar', 'yeniMarketplace', 'marketplaceSec', 'gitBaslat', 'ppConfigOlustur', 'bilinmeyen'];
  const labels = (lang) => { g.I18n.setLanguage(lang); return codes.map((code) => ctx.actionLabel(code)); };
  const trLabels = labels('tr');
  assert.deepEqual(trLabels, ['Ayarları aç', 'Yeni marketplace', 'Ağaçtan seç', "Git'i başlat", 'Ayar dosyası oluştur', '']);
  assert.deepEqual(labels('en'), ['Open Settings', 'New marketplace', 'Select from the tree', 'Initialize git', 'Create settings file', '']);
  assert.deepEqual(labels('tr'), trLabels, 'etiket tablosu dil değişince bayatlamaz');
  const pick = (lang, code) => { g.I18n.setLanguage(lang); S.info.setup.issues = [{ code }]; ctx.renderPick(); return dom.els['#main'].innerHTML; };
  assert.ok(pick('tr', 'marketplaceYok').includes('<h1 id="pickTitle" tabindex="-1">Bir marketplace seç</h1>') && pick('tr', 'marketplaceYok').includes('<p>Henüz marketplace yok. Yeni bir tane oluştur.</p>'));
  assert.ok(pick('tr', 'marketplaceSecilmedi').includes('<p>Soldaki ağaçtan bir marketplace&#39;e tıkla ya da yeni bir tane oluştur.</p>'));
  assert.ok(pick('en', 'marketplaceYok').includes('Select a marketplace') && pick('en', 'marketplaceYok').includes('<p>There are no marketplaces yet. Create a new one.</p>'));
  assert.ok(pick('en', 'marketplaceSecilmedi').includes('<p>Click a marketplace in the tree on the left, or create a new one.</p>'));
});

test('Korunan metin kartı, uyarı bandı ve etkin marketplace göstergesi iki dilde; girdiler kaçışlı; panoya kopyalama ve atma iletileri', async () => {
  const g = uiGlobals({ browser: true });
  const dom = stubDom();
  const calls = { toast: [], choice: [] };
  let bandNode = null;
  dom.els['#main'].prepend = (node) => { bandNode = node; };
  dom.els['#warnBand'].remove = () => {};
  let name = XSS_INPUT;
  const S = {
    info: { setup: { ok: true, issues: [{ level: 'warn', message: XSS_INPUT, action: 'ppConfigOlustur' }, { level: 'warn', message: 'Ayar', action: 'ayarlar' }] } },
    warnHidden: false, lostEdit: { mp: XSS_INPUT, path: 'prompts/' + XSS_INPUT + '.md', raw: XSS_INPUT, commitMsg: XSS_INPUT }
  };
  const ctx = load({ fns: ['actionLabel', 'lostEditHtml', 'lostCopy', 'lostDrop', 'paintMkCur', 'paintWarnBand'], consts: ['esc', 'base', 'ACTION_LABEL_KEYS'] }, {
    ...g, S, $: dom.$, activeName: () => name, rootOk: () => true, setupOk: () => true,
    document: { createElement: () => ({ setAttribute() {} }) }, renderMain() {},
    toast: (message, kind) => calls.toast.push([message, kind || null]), copyText: async () => ctx.copyOk, askChoice: async (o) => { calls.choice.push(plain(o)); return 'yes'; }
  });
  ctx.copyOk = true;
  const card = (lang) => { g.I18n.setLanguage(lang); return ctx.lostEditHtml(); };
  const trCard = card('tr');
  const enCard = card('en');
  assert.ok(trCard.includes('<h2 id="lostTitle">Kaydedilmemiş metnin korundu</h2>') && trCard.includes('Commit mesajın: <code>' + XSS_ESCAPED + '</code>'));
  assert.ok(trCard.includes('>Metni panoya kopyala</button>') && trCard.includes('data-act="lost-drop">At</button>') && trCard.includes('aria-label="Korunan metin"'));
  assert.ok(enCard.includes('<h2 id="lostTitle">Your unsaved text was kept</h2>') && enCard.includes('Your commit message: <code>' + XSS_ESCAPED + '</code>'));
  assert.ok(enCard.includes('>Copy text to clipboard</button>') && enCard.includes('data-act="lost-drop">Discard</button>') && enCard.includes('aria-label="Kept text"'));
  assert.ok(trCard.includes('<b>' + XSS_ESCAPED + '.md</b>') && enCard.includes('<b>' + XSS_ESCAPED + '.md</b>') && !trCard.includes('<img') && !enCard.includes('<img'));
  const mkCur = (lang, value) => { g.I18n.setLanguage(lang); name = value; ctx.paintMkCur(); return dom.els['#mkCur'].innerHTML; };
  assert.equal(mkCur('tr', 'mp'), 'Marketplace: <b>mp</b><span class="sr">. Etkin marketplace: mp</span>');
  assert.equal(mkCur('en', 'mp'), 'Marketplace: <b>mp</b><span class="sr">. Active marketplace: mp</span>');
  assert.equal(mkCur('en', XSS_INPUT), 'Marketplace: <b>' + XSS_ESCAPED + '</b><span class="sr">. Active marketplace: ' + XSS_ESCAPED + '</span>');
  assert.deepEqual([mkCur('tr', ''), mkCur('en', '')], ['Marketplace seçilmedi', 'No marketplace selected']);
  const band = (lang) => { g.I18n.setLanguage(lang); name = 'mp'; ctx.paintWarnBand(); return bandNode.innerHTML; };
  const trBand = band('tr');
  const enBand = band('en');
  assert.ok(trBand.includes('<span class="pill warn">Uyarı</span> ' + XSS_ESCAPED + ' <button class="link" data-act="mk-ppconfig" data-name="mp">Ayar dosyası oluştur</button>'));
  assert.ok(trBand.includes('data-act="settings">Ayarları aç</button>') && trBand.includes('aria-label="Uyarıyı kapat">Kapat</button>'));
  assert.ok(enBand.includes('<span class="pill warn">Warning</span> ' + XSS_ESCAPED + ' <button class="link" data-act="mk-ppconfig" data-name="mp">Create settings file</button>'));
  assert.ok(enBand.includes('data-act="settings">Open Settings</button>') && enBand.includes('aria-label="Dismiss the warning">Close</button>'));
  const copy = async (lang, ok) => { g.I18n.setLanguage(lang); ctx.copyOk = ok; calls.toast.length = 0; await ctx.lostCopy(); return plain(calls.toast); };
  assert.deepEqual(await copy('tr', true), [['Metin panoya kopyalandı', 'ok']]);
  assert.deepEqual(await copy('en', true), [['Text copied to clipboard', 'ok']]);
  assert.deepEqual(await copy('tr', false), [['Kopyalanamadı, metni kutudan elle seç', 'error']]);
  assert.deepEqual(await copy('en', false), [['Could not copy; select the text from the box manually', 'error']]);
  const drop = async (lang) => { g.I18n.setLanguage(lang); S.lostEdit = { mp: 'mp', path: 'a.md', raw: 'r', commitMsg: '' }; calls.toast.length = 0; calls.choice.length = 0; await ctx.lostDrop(); return plain({ choice: calls.choice[0], toast: calls.toast }); };
  const trDrop = await drop('tr');
  const enDrop = await drop('en');
  assert.deepEqual([trDrop.choice.title, trDrop.choice.text, trDrop.choice.choices.map((c) => c.label), trDrop.toast], ['Korunan metin atılsın mı?', 'Kaydedilmemiş metin ve commit mesajı bellekten silinir; geri alınamaz.', ['Vazgeç', 'At'], [['Korunan metin atıldı', null]]]);
  assert.deepEqual([enDrop.choice.title, enDrop.choice.text, enDrop.choice.choices.map((c) => c.label), enDrop.toast], ['Discard the kept text?', 'The unsaved text and commit message are removed from memory; this cannot be undone.', ['Cancel', 'Discard'], [['Kept text discarded', null]]]);
  assert.deepEqual(await drop('tr'), trDrop, 'tr yeniden aynı');
});

test('Ayarlar: bölüm başlıkları, seçenek etiketleri ve marketplace satırları iki dilde; seçenek değerleri (veri) sabit; girdiler kaçışlı; klasör yok onayı', async () => {
  const g = uiGlobals({ browser: true });
  const choices = [];
  const ctx = load({ fns: ['mkRowHtml', 'settingsHtml', 'saveRoot'], consts: ['esc', 'ROOT_BAD'] }, {
    ...g, S: { info: { libraryRoot: '', activeMarketplace: '', setup: { ok: false } } },
    $: (selector) => (selector === '#setRoot' ? { value: ' /yok/klasor ', focus() {} } : null),
    showFieldErr() {}, toast() {}, setupOk: () => false, reloadWith() {}, openSettings() {}, get: async () => ({ setup: { ok: false } }),
    askChoice: async (o) => { choices.push(plain(o)); return 'no'; },
    api: async () => { const e = new Error('Klasör bulunamadı'); e.status = 404; e.data = { notFound: true }; throw e; }
  });
  const rows = { items: [{ name: 'a', path: '/l/a', valid: true, active: true, hasManifest: false, hasPpConfig: false }, { name: 'b', path: '/l/b', valid: false, reason: XSS_INPUT, hasManifest: true }], ignored: [{ name: 'd', path: '/l/d', reason: 'Git deposu değil', reasonCode: 'gitDegil' }] };
  const empty = { items: [], ignored: [] };
  const withNote = { libraryRoot: '', suggestedRoot: XSS_INPUT, suggestedRootNote: '', configPath: XSS_INPUT, setup: { issues: [{ code: 'kokAyarlanmadi' }] }, remoteCheck: 'elle', language: 'auto' };
  const ready = { libraryRoot: '/lib', suggestedRoot: '', suggestedRootNote: '', configPath: '/c', setup: { issues: [] }, remoteCheck: 'acilista', language: 'tr' };
  const out = (lang, s, m) => { g.I18n.setLanguage(lang); return ctx.settingsHtml(s, m); };
  const trNote = out('tr', withNote, empty);
  const enNote = out('en', withNote, empty);
  assert.ok(trNote.includes('<h3>Library kökü</h3>') && trNote.includes('<label>Library kökü<input id="setRoot"') && trNote.includes('>Önerilen klasör: ' + XSS_ESCAPED + '</p>'));
  assert.ok(trNote.includes('<button class="btn primary">Kaydet</button><span class="hint">Ayar dosyası: <code>' + XSS_ESCAPED + '</code></span>'));
  assert.ok(trNote.includes('<h3>Uzak depo</h3>') && trNote.includes('<label>Uzak depoyu kontrol et<select id="setRemoteCheck">') && trNote.includes('<option value="elle" selected>Yalnızca elle</option>'));
  assert.ok(trNote.includes('<option value="acilista" >Açılışta (saatte en fazla bir kez)</option>') && trNote.includes('Marketplace&#39;ler</h3>'));
  assert.ok(trNote.includes('<button type="button" class="btn" data-act="new-mp" disabled>Yeni marketplace…</button><span class="hint">Önce geçerli bir library kökü kaydet.</span>'));
  assert.ok(enNote.includes('<h3>Library root</h3>') && enNote.includes('>Suggested folder: ' + XSS_ESCAPED + '</p>') && enNote.includes('<h3>Remote</h3>') && enNote.includes('<label>Check the remote<select id="setRemoteCheck">'));
  assert.ok(enNote.includes('<button class="btn primary">Save</button><span class="hint">Settings file: <code>' + XSS_ESCAPED + '</code></span>'));
  assert.ok(enNote.includes('<option value="elle" selected>Manually only</option>') && enNote.includes('<option value="acilista" >On startup (at most once an hour)</option>') && enNote.includes('<h3 id="setMkTitle" tabindex="-1">Marketplaces</h3>'));
  assert.ok(enNote.includes('data-act="new-mp" disabled>New marketplace…</button><span class="hint">Save a valid library root first.</span>'));
  assert.ok(!trNote.includes('<img') && !enNote.includes('<img'));
  assert.ok(out('tr', ready, empty).includes('<p class="hint">Bu kökte henüz marketplace yok.</p>') && out('en', ready, empty).includes('<p class="hint">There are no marketplaces in this root yet.</p>'));
  assert.ok(out('tr', ready, empty).includes('>Marketplace depoları bu klasörün altında tutulur. Araç klasörünün dışında olmalı.</p>'));
  assert.ok(out('en', ready, empty).includes('>Marketplace repositories are kept under this folder. It must be outside the tool folder.</p>'));
  const trRows = out('tr', ready, rows);
  const enRows = out('en', ready, rows);
  assert.ok(trRows.includes('<span class="pill ok">etkin</span> <span class="pill warn">manifest yok</span> <span class="pill warn">Prompt Havuzu ayarı yok</span>'));
  assert.ok(trRows.includes('<span class="pill bad">geçersiz: ' + XSS_ESCAPED + '</span>') && trRows.includes('data-act="mk-activate" data-name="b">Etkinleştir</button>'));
  assert.ok(trRows.includes('data-act="mk-ppconfig" data-name="a">Ayar dosyası oluştur</button>') && trRows.includes('data-act="mk-git-init" data-confirm data-name="d">Git&#39;i başlat</button>'));
  assert.ok(enRows.includes('<span class="pill ok">active</span> <span class="pill warn">no manifest</span> <span class="pill warn">no Prompt Havuzu settings</span>'));
  assert.ok(enRows.includes('<span class="pill bad">invalid: ' + XSS_ESCAPED + '</span>') && enRows.includes('data-act="mk-activate" data-name="b">Activate</button>'));
  assert.ok(enRows.includes('data-act="mk-ppconfig" data-name="a">Create settings file</button>') && enRows.includes('data-act="mk-git-init" data-confirm data-name="d">Initialize git</button>'));
  assert.ok(enRows.includes('<span class="pill warn">Git deposu değil</span>'), 'sunucudan gelen neden ham');
  assert.equal(out('tr', ready, rows), trRows, 'tr yeniden aynı');
  g.I18n.setLanguage('tr');
  await ctx.saveRoot(false);
  g.I18n.setLanguage('en');
  await ctx.saveRoot(false);
  assert.deepEqual([choices[0].title, choices[0].text, choices[0].choices.map((c) => c.label)], ['Klasör yok', 'Klasör yok: /yok/klasor. Oluşturulsun mu?', ['Vazgeç', 'Oluştur']]);
  assert.deepEqual([choices[1].title, choices[1].text, choices[1].choices.map((c) => c.label)], ['Folder does not exist', 'The folder does not exist: /yok/klasor. Create it?', ['Cancel', 'Create']]);
});

test('Olay işleyicileri ve açılış: plugin silme metni (çoğul), açıklama/panoya/kimlik/ayar toast\'ları, mk-init iletileri ve sunucu yok ekranı iki dilde', async () => {
  const g = uiGlobals({ browser: true });
  const handlers = {};
  const toasts = []; const fieldErrs = []; const deletes = [];
  const clickSrc = /document\.addEventListener\('click', async \(ev\) => \{[\s\S]*?\n\}\);\n/.exec(html);
  const changeSrc = /document\.addEventListener\('change', \(ev\) => \{[\s\S]*?\n\}\);\n/.exec(html);
  assert.ok(clickSrc && changeSrc, 'olay işleyicileri bulunamadı');
  const form = { durum: [] };
  const ctx = load({ consts: ['esc', 'fold', 'DURUM_OPTS'], fns: ['init'] }, {
    ...g, FM, Rules, document: { addEventListener: (type, fn) => { handlers[type] = fn; } },
    S: { info: { activeMarketplace: 'mp' }, pk: { name: 'k' }, mk: { export: { durumlar: [], haricKlasorler: [] } } },
    $: (selector) => ({ '#pkDesc': { value: 'aç' }, '#mkForm': {}, '#mkVerErr': { hidden: true }, '#mkForm [name="version"]': { setAttribute() {}, removeAttribute() {}, focus() {} } }[selector] || null),
    FormData: class { get() { return '1.0.0'; } getAll() { return form.durum; } entries() { return [['version', '1.0.0']]; } },
    activeName: () => 'mp', pathSep: () => '/', pluginsOf: () => [{ name: 'k', path: 'prompts/k', count: ctx.count }], activeMp: () => ({}),
    deleteItem: async (p, text) => { deletes.push(text); }, toast: (message) => toasts.push(message), showFieldErr: (id, message) => fieldErrs.push(message), fail(e) { throw e; },
    api: async () => ({ packages: ['a', 'b'] }), get: async () => ({}), pkLoad: async () => {}, afterWrite() {}, mkReload: async () => {},
    copyText: async () => ctx.copyOk
  });
  vm.runInContext(clickSrc[0] + '\n' + changeSrc[0], ctx);
  const click = (act, dataset = {}) => handlers.click({ target: { closest: () => ({ dataset: { act, ...dataset }, closest: () => null }) }, preventDefault() {}, stopPropagation() {} });
  const run = async (lang) => {
    g.I18n.setLanguage(lang);
    toasts.length = 0; fieldErrs.length = 0; deletes.length = 0;
    for (const count of [1, 3]) { ctx.count = count; await click('m-delete-plugin', { name: 'k' }); }
    ctx.copyOk = true; await click('copy-text', { text: 'x' });
    ctx.copyOk = false; await click('copy-text', { text: 'x' });
    await click('m-copy-path', { mp: 'mp' });
    await click('pk-desc');
    form.durum = []; await click('mk-init');
    form.durum = ['kararlı']; await click('mk-init');
    handlers.change({ target: { id: 'setRemoteCheck', value: 'elle', dataset: {}, closest: () => null } });
    await new Promise((resolve) => setImmediate(resolve));
    return plain({ toasts, fieldErrs: fieldErrs.filter(Boolean), deletes });
  };
  const trRun = await run('tr');
  const enRun = await run('en');
  assert.deepEqual(trRun.deletes, ['"k" plugin\'i ve içindeki 1 prompt çöp kutusuna (.pp/trash) taşınır.', '"k" plugin\'i ve içindeki 3 prompt çöp kutusuna (.pp/trash) taşınır.']);
  assert.deepEqual(enRun.deletes, ['The "k" plugin and its 1 prompt are moved to the trash (.pp/trash).', 'The "k" plugin and its 3 prompts are moved to the trash (.pp/trash).']);
  assert.deepEqual(trRun.toasts, ['Kopyalandı', 'Kopyalanamadı', 'Kopyalanamadı', 'Açıklama kaydedildi', 'Marketplace dosyaları yazıldı: a, b', 'Ayar kaydedildi']);
  assert.deepEqual(enRun.toasts, ['Copied', 'Could not copy', 'Could not copy', 'Description saved', 'Marketplace files written: a, b', 'Setting saved']);
  assert.deepEqual([trRun.fieldErrs, enRun.fieldErrs], [['En az bir durum seçilmeli'], ['Select at least one status']]);
  assert.deepEqual(await run('tr'), trRun, 'tr yeniden aynı');
  const down = async (lang) => {
    g.I18n.setLanguage(lang);
    const main = { innerHTML: '' };
    ctx.get = async () => { throw new Error('bağlantı yok'); };
    ctx.$ = () => main;
    await ctx.init();
    return main.innerHTML;
  };
  assert.equal(await down('tr'), '<div class="start"><h1>Sunucuya ulaşılamadı</h1><p>Terminalde <code>node tools/ui/server.js</code> komutunun çalıştığından emin ol, sonra sayfayı yenile.</p></div>');
  assert.equal(await down('en'), '<div class="start"><h1>Cannot reach the server</h1><p>Make sure the <code>node tools/ui/server.js</code> command is running in a terminal, then reload the page.</p></div>');
});
