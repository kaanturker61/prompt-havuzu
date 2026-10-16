'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { uiGlobals } = require('./helpers');

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
    fns: ['api', 'init', 'startLanguage', 'applyLanguage', 'syncLanguage'], consts: ['MP_GUARDED', 'get', ...LANG_CONSTS]
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
  assert.match(r.main.innerHTML, /Sunucuya ulaşılamadı/);
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

test('index.html: yeni kod tx adını kullanır (yerel t ile gölgelenmez), th tanımı yok; LF', () => {
  assert.match(html, /^const tx = I18n\.tx;$/m);
  assert.doesNotMatch(html, /^\s*(?:const|let|var)\s+th\b/m);
  assert.ok(!html.includes('\r'));
  assert.ok(!fs.readFileSync(__filename, 'utf8').includes('\r'));
});
