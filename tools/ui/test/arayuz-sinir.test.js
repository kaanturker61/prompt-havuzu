'use strict';
// Sınır testi hatalarının arayüz sözleşmeleri (plan 08, B-05/07/08/10/14/15/16/17/20).
// index.html'den işlev kaynakları çıkarılıp vm içinde saplama (stub) ile çalıştırılır; tarayıcı gerekmez.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FM = require('../public/fm.js');
const Rules = require('../public/rules.js');
const { uiGlobals } = require('./helpers');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* ---------------------------------------------------------------- yardımcılar */

// Üst düzey `function ad(...)` bildirimini (tek satırlık ya da `\n}\n` ile biten) çıkarır.
function fnSrc(name) {
  const one = new RegExp('^(?:async )?function ' + name + '\\(.*\\{.*\\}[ \\t]*$', 'm').exec(html);
  if (one && !/\{\s*$/.test(one[0])) return one[0];
  const m = new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?\\n\\}\\n', 'm').exec(html);
  assert.ok(m, name + ' bulunamadı');
  return m[0];
}
// Tek satırlık `const ad = ...;` tanımını çıkarır.
function constSrc(name) {
  const m = new RegExp('^const ' + name + ' = .*;[ \\t]*$', 'm').exec(html);
  assert.ok(m, 'const ' + name + ' bulunamadı');
  return m[0];
}
// Verilen işlev ve const kaynaklarını tek bağlamda çalıştırır; global yer tutucular `globals` ile verilir.
// expose: const olarak tanımlı adlar bağlam özelliği yapılır (function bildirimleri zaten özelliktir).
function load({ fns = [], consts = [], extra = '', expose = [] }, globals = {}) {
  const ctx = Object.assign({ FM, Rules, console }, uiGlobals(), globals);
  vm.createContext(ctx);
  vm.runInContext([...consts.map(constSrc), ...fns.map(fnSrc), extra, ...expose.map((n) => 'this.' + n + ' = ' + n + ';')].join('\n'), ctx);
  return ctx;
}
const tick = () => new Promise((r) => setImmediate(r));
const newS = (o) => Object.assign({ info: { activeMarketplace: 'mp', setup: { ok: true, rootOk: true, issues: [] } }, cur: null, git: null, gen: 0, openSeq: 0, lostEdit: null, results: null, resultsInfo: null }, o);

/* ------------------------------------------------------------ B-07 openFile yarışı */

function openCtx(S, extra = {}) {
  const spy = { fail: [], toast: [], render: 0, last: [], title: [] };
  const pending = {};
  const globals = {
    S,
    document: { title: 'Prompt havuzu' },
    get: (u) => new Promise((resolve, reject) => { pending[decodeURIComponent(/path=([^&]+)/.exec(u)[1])] = { resolve, reject }; }),
    qs: (o) => 'path=' + encodeURIComponent(o.path),
    confirmDiscard: async () => true,
    activeName: () => 'mp', leadOf: () => '', nodeKey: (mp, p) => mp + ':' + p,
    ls: { set: (k, v) => spy.last.push([k, v]) }, lsKey: (k) => 'pp.mp.' + k,
    expandParents() {}, closeSide() {}, renderList() {}, renderMain() { spy.render++; }, loadVersion() {}, loadHistory() {},
    updateDirty() {}, fail: (e) => spy.fail.push(e), toast: (m, k) => spy.toast.push([m, k]),
    askChoice: async () => null, base: (p) => p.split('/').pop(),
    ...extra
  };
  const ctx = load({ fns: ['openFile', 'offerLostEdit'] }, globals);
  return { ctx, spy, pending };
}
const fileResp = (p, body = 'x') => ({ path: p, raw: '---\nbaslik: ' + p + '\n---\n' + body, mtime: 1, isPrompt: true, isMd: true });

test('openFile: yavaş eski yanıt yenisini ezmez (S.openSeq)', async () => {
  const S = newS();
  const { ctx, spy, pending } = openCtx(S);
  const a = ctx.openFile('a.md'); await tick();
  const b = ctx.openFile('b.md'); await tick();
  pending['b.md'].resolve(fileResp('b.md')); await b;
  assert.equal(S.cur.path, 'b.md');
  const rendersAfterB = spy.render;
  pending['a.md'].resolve(fileResp('a.md')); await a; // A yavaştı, B'den sonra geldi
  assert.equal(S.cur.path, 'b.md', 'eski yanıt editörü ezmemeli');
  assert.equal(S.sel.key, 'mp:b.md', 'ağaç seçimi B kalmalı');
  assert.equal(spy.render, rendersAfterB, 'bayat yanıt yeniden çizim üretmemeli');
  assert.deepEqual(spy.last.filter(([, v]) => v === 'a.md'), [], 'son açılan kaydı A olmamalı');
});

test('openFile: bayat hata toast ve yeniden çizim üretmez', async () => {
  const S = newS();
  const { ctx, spy, pending } = openCtx(S);
  const a = ctx.openFile('a.md'); await tick();
  const b = ctx.openFile('b.md'); await tick();
  pending['b.md'].resolve(fileResp('b.md')); await b;
  const rendersAfterB = spy.render; const lastAfterB = spy.last.length;
  const err = new Error('Dosya yok'); err.status = 404;
  pending['a.md'].reject(err); await a;
  assert.equal(spy.fail.length, 0, 'bayat hata toast üretmemeli');
  assert.equal(spy.render, rendersAfterB);
  assert.equal(spy.last.length, lastAfterB, '404 bayat hata son açılan kaydı silmemeli');
  assert.equal(S.cur.path, 'b.md');
});

test('openFile: güncel hata yine bildirilir; quiet ise sessizdir; 404 son kaydı siler', async () => {
  const S = newS();
  const { ctx, spy, pending } = openCtx(S);
  const a = ctx.openFile('a.md'); await tick();
  const err = new Error('Dosya yok'); err.status = 404;
  pending['a.md'].reject(err); await a;
  assert.equal(spy.fail.length, 1);
  assert.deepEqual(spy.last, [['pp.mp.last', null]]);
  assert.equal(spy.render, 1);
  const q = ctx.openFile('q.md', { quiet: true }); await tick();
  pending['q.md'].reject(err); await q;
  assert.equal(spy.fail.length, 1, 'quiet sessiz');
});

test('openFile: marketplace değişince (S.gen) yanıt ve hata atılır', async () => {
  const S = newS();
  const { ctx, spy, pending } = openCtx(S);
  const a = ctx.openFile('a.md'); await tick();
  S.gen++; // başka marketplace'e geçildi
  pending['a.md'].resolve(fileResp('a.md')); await a;
  assert.equal(S.cur, null);
  const b = ctx.openFile('b.md'); await tick();
  S.gen++;
  pending['b.md'].reject(new Error('x')); await b;
  assert.equal(spy.fail.length, 0);
});

test('openFile: açık dosyaya tıklamak yoldaki başka açılışı geçersiz kılar', async () => {
  const S = newS({ cur: { mp: 'mp', path: 'c.md' } });
  const { ctx, pending } = openCtx(S);
  const a = ctx.openFile('a.md'); await tick();
  await ctx.openFile('c.md'); // zaten açık: erken döner
  pending['a.md'].resolve(fileResp('a.md')); await a;
  assert.equal(S.cur.path, 'c.md');
});

/* --------------------------------------------- B-08b geri yükleme önerisi (openFile) */

const LOST_RAW = '---\nbaslik: Kayıp\n---\nyazdığım metin';
test('openFile: aynı mp+yol için korunan metin geri yüklenebilir (B-08b)', async () => {
  const S = newS({ lostEdit: { mp: 'mp', path: 'a.md', raw: LOST_RAW, commitMsg: 'yarım mesaj' } });
  const asked = [];
  const { ctx, spy, pending } = openCtx(S, { askChoice: async (o) => { asked.push(o); return 'restore'; } });
  const a = ctx.openFile('a.md'); await tick();
  pending['a.md'].resolve(fileResp('a.md', 'diskteki')); await a;
  assert.equal(asked.length, 1);
  assert.equal(S.cur.commitMsg, 'yarım mesaj');
  assert.equal(FM.stringify(S.cur.parsed), LOST_RAW);
  assert.equal(S.lostEdit, null);
  assert.ok(spy.toast.some(([m]) => /geri yüklendi/.test(m)));
  assert.equal(spy.render, 2, 'açılışta ve geri yüklemede çizilir');
});

test('openFile: korunan metin "At" ile silinir, "Daha sonra"/kapatma ile bellekte kalır, başka yolda sorulmaz', async () => {
  for (const [cevap, kalir] of [['drop', false], ['later', true], [null, true]]) {
    const S = newS({ lostEdit: { mp: 'mp', path: 'a.md', raw: LOST_RAW, commitMsg: '' } });
    const { ctx, pending } = openCtx(S, { askChoice: async () => cevap });
    const a = ctx.openFile('a.md'); await tick();
    pending['a.md'].resolve(fileResp('a.md', 'diskteki')); await a;
    assert.equal(!!S.lostEdit, kalir, String(cevap));
    assert.match(S.cur.parsed.body, /diskteki/, 'disk sürümü açık kalmalı');
  }
  const S = newS({ lostEdit: { mp: 'mp', path: 'a.md', raw: LOST_RAW, commitMsg: '' } });
  let sorulan = 0;
  const { ctx, pending } = openCtx(S, { askChoice: async () => { sorulan++; return 'restore'; } });
  const b = ctx.openFile('b.md'); await tick();
  pending['b.md'].resolve(fileResp('b.md')); await b;
  assert.equal(sorulan, 0);
  assert.ok(S.lostEdit);
});

/* --------------------------------------------- B-08a onSetupLost / S.lostEdit */

function lostCtx(S, extra = {}) {
  const spy = { toast: [], calls: [] };
  const ctx = load({ fns: ['onSetupLost', 'keepLostEdit', 'syncFromDom', 'lostEditHtml', 'lostCopy', 'lostDrop'], consts: [] }, {
    S, document: { title: '• Prompt havuzu' },
    $: (s) => (s === '#fRaw' ? S.rawEl || null : null),
    leadOf: () => '', base: (p) => p.split('/').pop(),
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    applySetupUi() { spy.calls.push('ui'); }, renderList() { spy.calls.push('list'); }, renderMain() { spy.calls.push('main'); },
    toast: (m, k, ms) => spy.toast.push([m, k, ms]),
    copyText: async (t) => { spy.copied = t; return true; },
    askChoice: async () => 'yes',
    ...extra
  });
  return { ctx, spy };
}
const SETUP_BAD = { ok: false, rootOk: true, issues: [{ code: 'marketplaceGitYok', level: 'error', message: 'git yok' }] };

test('onSetupLost: kaydedilmemiş metni ve commit mesajını S.lostEdit içinde tutar', () => {
  const c = { mp: 'mp', path: 'prompts/p/a.md', tab: 'edit', parsed: FM.parse('---\nbaslik: X\n---\nyeni gövde'), eol: '\n', bom: '', dirty: true, commitMsg: 'Mesajım' };
  const S = newS({ cur: c, git: { isRepo: true }, info: { setup: { ok: true }, root: '/r', isRepo: true } });
  const { ctx, spy } = lostCtx(S);
  ctx.onSetupLost(SETUP_BAD);
  assert.deepEqual({ ...S.lostEdit }, { mp: 'mp', path: 'prompts/p/a.md', raw: '---\nbaslik: X\n---\nyeni gövde', commitMsg: 'Mesajım' });
  assert.equal(S.cur, null); assert.equal(S.git, null); assert.equal(S.gen, 1);
  assert.equal(S.info.setup, SETUP_BAD);
  assert.deepEqual(spy.calls, ['ui', 'list', 'main']);
  assert.equal(spy.toast.length, 1);
  assert.equal(spy.toast[0][1], 'error'); assert.equal(spy.toast[0][2], 9000);
  assert.match(spy.toast[0][0], /korundu/);
});

test('onSetupLost: ham metin sekmesindeki yazılanlar (syncFromDom) kaybolmaz', () => {
  const c = { mp: 'mp', path: 'a.md', tab: 'raw', parsed: FM.parse('---\nbaslik: Eski\n---\nx'), eol: '\n', bom: '', dirty: true, commitMsg: '' };
  const S = newS({ cur: c, rawEl: { value: '---\nbaslik: Textarea\n---\nelle yazdım' } });
  const { ctx } = lostCtx(S);
  ctx.onSetupLost(SETUP_BAD);
  assert.equal(S.lostEdit.raw, '---\nbaslik: Textarea\n---\nelle yazdım');
});

test('onSetupLost: temiz dosyada ya da açık dosya yokken bir şey saklanmaz; yalnızca commit mesajı da saklanır', () => {
  const temiz = { mp: 'mp', path: 'a.md', tab: 'edit', parsed: FM.parse('x'), eol: '\n', bom: '', dirty: false, commitMsg: '  ' };
  let S = newS({ cur: temiz });
  let l = lostCtx(S); l.ctx.onSetupLost(SETUP_BAD);
  assert.equal(S.lostEdit, null); assert.equal(l.spy.toast.length, 0);
  S = newS({ cur: null });
  l = lostCtx(S); l.ctx.onSetupLost(SETUP_BAD);
  assert.equal(S.lostEdit, null); assert.equal(l.spy.toast.length, 0);
  S = newS({ cur: { ...temiz, commitMsg: 'sadece mesaj' } });
  l = lostCtx(S); l.ctx.onSetupLost(SETUP_BAD);
  assert.equal(S.lostEdit.commitMsg, 'sadece mesaj'); assert.equal(l.spy.toast.length, 1);
});

test('save + api: 409 setupRequired gelince metin ve commit mesajı korunur, yalnızca korunma toast\'ı çıkar', async () => {
  const c = { mp: 'mp', path: 'a.md', isPrompt: true, tab: 'edit', parsed: FM.parse('---\nbaslik: X\n---\nyazdığım'), savedRaw: '---\nbaslik: X\n---\neski', eol: '\n', bom: '', dirty: true, commitMsg: 'Kaydet ve commit', mtime: 5, lead: '' };
  const S = newS({ cur: c, git: { isRepo: true, files: [] } });
  const toasts = [];
  const fetchCalls = [];
  const ctx = load({ fns: ['save', 'api', 'onSetupLost', 'keepLostEdit', 'syncFromDom', 'staleGuard', 'errText'], consts: ['MP_GUARDED', 'fail'] }, {
    S, document: { title: '• Prompt havuzu' }, $: () => null, leadOf: () => '',
    activeName: () => 'mp', uncommitted: () => false, confirmTurRemoval: async () => true,
    toast: (m, k) => toasts.push([m, k]), updateDirty() {}, afterWrite: async () => {}, askIdentity: async () => false, commitOnly: async () => false,
    askChoice: async () => 'cancel', openFile: async () => {}, resyncActive() {},
    applySetupUi() {}, renderList() {}, renderMain() {},
    fetch: async (url, opt) => { fetchCalls.push([opt.method, url]); return { ok: false, status: 409, json: async () => ({ error: 'Kurulum tamamlanmadı: git yok', setupRequired: true, setup: SETUP_BAD }) }; }
  });
  const ok = await ctx.save();
  assert.equal(ok, false);
  assert.deepEqual(fetchCalls, [['PUT', '/api/file']]);
  assert.equal(S.lostEdit.raw, '---\nbaslik: X\n---\nyazdığım');
  assert.equal(S.lostEdit.commitMsg, 'Kaydet ve commit');
  assert.equal(S.cur, null);
  assert.equal(toasts.length, 1, 'fail() sessiz, yalnızca korunma bildirimi');
  assert.match(toasts[0][0], /korundu/);
});

test('lostEditHtml: kart, düğmeler ve kaçışlı içerik; korunan metin yoksa boş', async () => {
  const S = newS();
  const { ctx, spy } = lostCtx(S);
  assert.equal(ctx.lostEditHtml(), '');
  S.lostEdit = { mp: 'mp', path: 'prompts/p/a.md', raw: '---\nbaslik: <b>X</b>\n---\nmetin & "alıntı"', commitMsg: 'msg <i>' };
  const h = ctx.lostEditHtml();
  assert.match(h, /data-act="lost-copy"/);
  assert.match(h, /data-act="lost-drop"/);
  assert.match(h, /Metni panoya kopyala/);
  assert.ok(h.includes('&lt;b&gt;X&lt;/b&gt;') && h.includes('&amp; &quot;alıntı&quot;'), 'ham metin kaçışlı olmalı');
  assert.ok(h.includes('msg &lt;i&gt;'), 'commit mesajı görünür ve kaçışlı olmalı');
  assert.ok(!/<b>X<\/b>/.test(h));
  assert.match(h, /readonly/);
  S.lostEdit.commitMsg = '';
  assert.ok(!/Commit mesajın/.test(ctx.lostEditHtml()));
  // lost-copy panoya ham metni verir
  await ctx.lostCopy();
  assert.equal(spy.copied, S.lostEdit.raw);
  assert.equal(spy.toast.at(-1)[1], 'ok');
});

test('lostCopy başarısızsa hata bildirir; lostDrop onay ister, onayda siler ve kartı kaldırır', async () => {
  const S = newS({ lostEdit: { mp: 'mp', path: 'a.md', raw: 'r', commitMsg: '' } });
  let yanit = 'no';
  const { ctx, spy } = lostCtx(S, { copyText: async () => false, askChoice: async () => yanit });
  await ctx.lostCopy();
  assert.equal(spy.toast.at(-1)[1], 'error');
  await ctx.lostDrop();
  assert.ok(S.lostEdit, 'vazgeçilirse silinmez');
  yanit = 'yes';
  await ctx.lostDrop();
  assert.equal(S.lostEdit, null);
  assert.ok(spy.calls.includes('main'), 'kart kalksın diye yeniden çizilir');
});

test('kurulum ekranları (renderSetup, renderPick) lostEditHtml() kartını içerir; tıklama anahtarı iki eylemi bağlar', () => {
  assert.match(fnSrc('renderSetup'), /lostEditHtml\(\)/);
  assert.match(fnSrc('renderPick'), /lostEditHtml\(\)/);
  assert.match(html, /case 'lost-copy': await lostCopy\(\); break;/);
  assert.match(html, /case 'lost-drop': await lostDrop\(\); break;/);
});

/* --------------------------------------------------------------- B-10 Tab tuzağı */

test('tabTarget: son->ilk, ilk+Shift->son, dışarıdan içeri, arada null', () => {
  const [a, b, c] = ['a', 'b', 'c'];
  const { tabTarget } = load({ fns: ['tabTarget'] });
  const items = [a, b, c];
  assert.equal(tabTarget(items, c, false), a);
  assert.equal(tabTarget(items, a, true), c);
  assert.equal(tabTarget(items, b, false), null);
  assert.equal(tabTarget(items, b, true), null);
  assert.equal(tabTarget(items, a, false), null);
  assert.equal(tabTarget(items, c, true), null);
  assert.equal(tabTarget(items, 'dis', false), a, 'dışarıdan Tab ilkine');
  assert.equal(tabTarget(items, 'dis', true), c, 'dışarıdan Shift+Tab sonuncuya');
  assert.equal(tabTarget([], 'dis', false), null);
  assert.equal(tabTarget([a], a, false), a, 'tek öğede kendine sarar');
  assert.equal(tabTarget([a], a, true), a);
});

// Sahte DOM: odaklanabilir öğeler ve açık/kapalı #overlay.
function fakeModal(specs, extra = {}) {
  const doc = { activeElement: null };
  const els = specs.map((s) => ({ id: s.id, type: s.type || 'button', name: s.name, checked: !!s.checked, form: s.form || null, disabled: !!s.disabled, hidden: !!s.hidden, tabIndex: s.tabIndex === undefined ? 0 : s.tabIndex,
    getClientRects: () => (s.visible === false ? [] : [1]), focus() { doc.activeElement = this; } }));
  const overlay = { hidden: extra.hidden === true };
  const ctx = load({ fns: ['tabTarget', 'modalFocusables', 'trapTab'] }, {
    document: doc, $: (s) => (s === '#overlay' ? overlay : {}), $$: () => els.slice()
  });
  const key = (o) => ({ key: 'Tab', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, target: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...o });
  return { ctx, els, doc, overlay, key };
}

test('trapTab: 30 Tab ve Shift+Tab boyunca odak pencere içinde kalır', () => {
  const { ctx, els, doc, key } = fakeModal([{ id: 'kapat' }, { id: 'in1', type: 'text' }, { id: 'gizli', hidden: true }, { id: 'pasif', disabled: true }, { id: 'tx', type: 'textarea' }, { id: 'tamam' }]);
  const tabbable = els.filter((e) => !['gizli', 'pasif'].includes(e.id));
  const browserNext = (shift) => { // tarayıcı: preventDefault edilmediyse DOM sırasında bir sonrakine geçer (uçlarda dışarı çıkardı)
    const i = tabbable.indexOf(doc.activeElement);
    return tabbable[i + (shift ? -1 : 1)] || { id: 'DIS' };
  };
  for (const shift of [false, true]) {
    doc.activeElement = tabbable[1];
    for (let n = 0; n < 30; n++) {
      const ev = key({ shiftKey: shift, target: doc.activeElement });
      assert.equal(ctx.trapTab(ev), true);
      if (!ev.defaultPrevented) doc.activeElement = browserNext(shift);
      assert.ok(tabbable.includes(doc.activeElement), (shift ? 'Shift+' : '') + 'Tab ' + n + '. basışta odak pencereden çıktı');
    }
  }
});

test('trapTab: dışarıdaki odak içeri alınır; kapalı pencerede, Ctrl+Tab ve menüde karışmaz', () => {
  const { ctx, els, doc, overlay, key } = fakeModal([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  doc.activeElement = { id: 'DIS' };
  let ev = key(); assert.equal(ctx.trapTab(ev), true);
  assert.equal(ev.defaultPrevented, true); assert.equal(doc.activeElement, els[0]);
  doc.activeElement = { id: 'DIS' };
  ev = key({ shiftKey: true }); ctx.trapTab(ev);
  assert.equal(doc.activeElement, els[2]);
  assert.equal(ctx.trapTab(key({ key: 'Enter' })), false);
  assert.equal(ctx.trapTab(key({ ctrlKey: true })), false);
  assert.equal(ctx.trapTab(key({ target: { closest: (s) => (s === '.menu' ? {} : null) } })), false);
  overlay.hidden = true;
  assert.equal(ctx.trapTab(key()), false, 'pencere kapalıyken hiçbir şey yapmaz');
});

test('modalFocusables: görünmeyen, tabindex=-1 ve closed details içindeki öğeler dışarıda; radyo grubu tek durak', () => {
  const f = {};
  const { ctx } = fakeModal([{ id: 'r1', type: 'radio', name: 'g', form: f }, { id: 'r2', type: 'radio', name: 'g', checked: true, form: f }, { id: 'r3', type: 'radio', name: 'g', form: f },
    { id: 'neg', tabIndex: -1 }, { id: 'kapali', visible: false }, { id: 'son' }]);
  const ids = Array.from(ctx.modalFocusables()).map((e) => e.id);
  assert.deepEqual(ids, ['r2', 'son']);
  const k = fakeModal([{ id: 'r1', type: 'radio', name: 'g', form: f }, { id: 'r2', type: 'radio', name: 'g', form: f }, { id: 'x' }]);
  assert.deepEqual(Array.from(k.ctx.modalFocusables()).map((e) => e.id), ['r1', 'x'], 'seçili yoksa ilk radyo');
});

test('genel keydown Tab tuzağını diğer kısayollardan önce çağırır', () => {
  const m = /document\.addEventListener\('keydown', \(ev\) => \{\n  const t = ev\.target;\n  if \(trapTab\(ev\)\) return;/.exec(html);
  assert.ok(m, 'keydown başında trapTab(ev) bulunamadı');
});

/* ------------------------------------------------------------ B-17 clearCur / deleteItem */

test('clearCur: S.cur boşalır, son kayıt silinir, başlık "•" olmadan sıfırlanır', () => {
  const S = newS({ cur: { path: 'a.md', dirty: true } });
  const sets = [];
  const document = { title: '• Prompt havuzu' };
  const { clearCur } = load({ fns: ['clearCur'] }, { S, document, ls: { set: (k, v) => sets.push([k, v]) }, lsKey: (k) => 'pp.mp.' + k });
  clearCur();
  assert.equal(S.cur, null);
  assert.equal(document.title, 'Prompt havuzu');
  assert.deepEqual(sets, [['pp.mp.last', null]]);
});

test('deleteItem: kaydedilmemiş açık dosya silinince başlık sıfırlanır', async () => {
  const S = newS({ cur: { path: 'prompts/p/a.md', dirty: true } });
  const document = { title: '• Prompt havuzu' };
  const calls = [];
  const ctx = load({ fns: ['deleteItem', 'clearCur'] }, {
    S, document, ls: { set() {} }, lsKey: (k) => k, qs: (o) => 'path=' + o.path,
    askChoice: async () => 'yes', api: async (m, u) => { calls.push([m, u]); return {}; },
    afterWrite: async () => {}, renderMain() {}, toast() {}, fail(e) { throw e; }
  });
  await ctx.deleteItem('prompts/p/a.md');
  assert.deepEqual(calls, [['DELETE', '/api/file?path=prompts/p/a.md']]);
  assert.equal(S.cur, null);
  assert.equal(document.title, 'Prompt havuzu');
  // klasör silinince içindeki açık dosya da kapanır
  S.cur = { path: 'prompts/p/b.md' }; document.title = '• Prompt havuzu';
  await ctx.deleteItem('prompts/p');
  assert.equal(S.cur, null); assert.equal(document.title, 'Prompt havuzu');
});

test('marketplace\'ler arası taşıma da clearCur kullanır; S.cur elle sıfırlanan yer kalmadı', () => {
  assert.match(html, /if \(S\.cur && S\.cur\.path === path\) clearCur\(\);/);
  const kalan = html.split('\n').filter((l) => /S\.cur = null; ls\.set\(lsKey\('last'\), null\)/.test(l));
  assert.deepEqual(kalan, ['  S.cur = null; ls.set(lsKey(\'last\'), null);'], 'yalnızca clearCur içinde');
});

/* -------------------------------------------------------------- B-20 sonuç sınırı */

test('resultsTitle / resultsNote: kesilince "300 / 3012" ve ipucu; kesilmezse eski biçim', () => {
  const esc = (s) => String(s);
  const { resultsTitle, resultsNote } = load({ fns: ['resultsTitle', 'resultsNote'] }, { esc });
  const r300 = new Array(300).fill({ mp: 'a' });
  assert.equal(resultsTitle(r300, { total: 3012, limit: 300, truncated: true }, 1), 'Sonuçlar (300 / 3012)');
  assert.equal(resultsTitle(r300, { total: 3012, limit: 300, truncated: true }, 3), 'Sonuçlar (300 / 3012) · 3 marketplace');
  assert.equal(resultsTitle(r300, { total: 300, limit: 300, truncated: false }, 1), 'Sonuçlar (300)');
  assert.equal(resultsTitle([{ mp: 'a' }, { mp: 'b' }], null, 2), 'Sonuçlar (2) · 2 marketplace');
  assert.equal(resultsTitle([], { total: 0, limit: 300, truncated: false }, 0), 'Sonuçlar (0)');
  const note = resultsNote({ total: 3012, limit: 300, truncated: true });
  assert.match(note, /İlk 300 sonuç gösteriliyor\. Daraltmak için etiket, durum, tür filtresi ya da daha uzun bir sözcük kullan\./);
  assert.ok(!/class="(?:[^"]*\s)?res[\s"]/.test(note), '.res olmamalı: data-ri sırası ve klavye gezintisi bozulmasın');
  assert.equal(resultsNote({ total: 300, limit: 300, truncated: false }), '');
  assert.equal(resultsNote(null), '');
});

test('runSearch: sunucunun total/limit/truncated bilgisi S.resultsInfo\'ya yazılır; renderList başlık ve ipucunu birlikte çizer', async () => {
  const S = newS({ f: { q: 'kod', tags: [], durum: '', tur: '', scope: 'library' }, facets: { total: 0 } });
  const elemanlar = {};
  const el = (id) => (elemanlar[id] = elemanlar[id] || { attrs: {}, innerHTML: '', textContent: '', hidden: false, contains: () => false, setAttribute(k, v) { this.attrs[k] = v; }, querySelector: () => null });
  const res = Array.from({ length: 300 }, (_, i) => ({ mp: 'mp', path: 'p' + i + '.md' }));
  const ctx = load({ fns: ['renderList', 'resultsTitle', 'resultsNote'], consts: ['isFiltering'], extra: constSrcRunSearch(), expose: ['runSearch'] }, {
    S, esc: (s) => String(s), debounce: (fn) => fn, fail(e) { throw e; }, qs: () => 'q=kod',
    document: { activeElement: null }, $: (s) => el(s), resultsHtml: () => '<RES/>', treeHtml: () => '<TREE/>', rowEl: () => null, paintToolbar() {},
    get: async () => ({ results: res, total: 3012, limit: 300, truncated: true })
  });
  await ctx.runSearch();
  assert.deepEqual({ ...S.resultsInfo }, { total: 3012, limit: 300, truncated: true });
  assert.equal(S.results.length, 300);
  assert.equal(elemanlar['#listTitle'].textContent, 'Sonuçlar (300 / 3012)');
  assert.ok(elemanlar['#list'].innerHTML.startsWith('<RES/>'));
  assert.match(elemanlar['#list'].innerHTML, /İlk 300 sonuç gösteriliyor/);
  // kesilmeyen sonuç: başlık değişmez, ipucu yok
  ctx.get = async () => ({ results: res.slice(0, 5), total: 5, limit: 300, truncated: false });
  await ctx.runSearch();
  assert.equal(elemanlar['#listTitle'].textContent, 'Sonuçlar (5)');
  assert.ok(!/gösteriliyor/.test(elemanlar['#list'].innerHTML));
  // filtre temizlenince bilgi de sıfırlanır
  S.f.q = '';
  await ctx.runSearch();
  assert.equal(S.results, null); assert.equal(S.resultsInfo, null);
});
function constSrcRunSearch() {
  const m = /^const runSearch = debounce\(async \(\) => \{[\s\S]*?\n\}, 140\);\n/m.exec(html);
  assert.ok(m, 'runSearch bulunamadı');
  return m[0];
}

test('loadRecent ("Son değişenler") yeni yanıt biçimiyle de çalışır', async () => {
  const S = newS({ recent: [] });
  const src = /^async function loadRecent\(\)[^\n]*\n/m.exec(html);
  assert.ok(src);
  const ctx = vm.createContext({ S, get: async () => ({ results: Array.from({ length: 20 }, (_, i) => ({ path: 'p' + i })), total: 20, limit: 300, truncated: false }) });
  vm.runInContext(src[0], ctx);
  await ctx.loadRecent();
  assert.equal(S.recent.length, 8);
});

/* ------------------------------------------------------------------ B-15 dal etiketi */

test('branchLabel: ayrık HEAD "Ayrık HEAD (abc1234)", normalde dal adı', () => {
  const { branchLabel } = load({ fns: ['branchLabel'] });
  assert.equal(branchLabel({ branch: null, detached: true, head: 'abc1234' }), 'Ayrık HEAD (abc1234)');
  assert.equal(branchLabel({ branch: 'main', detached: false, head: null }), 'main');
  assert.equal(branchLabel({ branch: null, detached: true }), 'Ayrık HEAD (?)');
});

test('Git paneli: ayrık HEAD\'de "Dal: main" yazmaz, ipucu satırı çıkar; normal dalda eski çıktı', () => {
  const body = { innerHTML: '' };
  const g = { isRepo: true, branch: null, detached: true, head: 'abc1234', hasCommits: true, files: [], identity: { name: 'A', email: 'a@b' } };
  const S = newS({ git: g, gitMsg: '', info: { activeMarketplace: 'mp' } });
  const ctx = load({ fns: ['paintGit', 'branchLabel', 'branchLine'] }, {
    S, $: () => body, esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    gitTabs: () => '', gitTarget: () => '', stem: (p) => p, GLABEL: {}
  });
  ctx.paintGit();
  assert.match(body.innerHTML, /Ayrık HEAD \(abc1234\)/);
  assert.match(body.innerHTML, /Commit&#39;ler bir dala bağlı değil|Commit'ler bir dala bağlı değil/);
  assert.ok(!/Dal:/.test(body.innerHTML) && !/main/.test(body.innerHTML));
  S.git = { ...g, branch: 'main', detached: false, head: null, hasCommits: false };
  ctx.paintGit();
  assert.match(body.innerHTML, /Dal: <b>main<\/b> \(henüz commit yok\)/);
  assert.ok(!/Ayrık/.test(body.innerHTML));
});

/* ------------------------------------------------------------------ B-16 errText */

test('errText: mesaj + git ayrıntısının ilk satırı (en çok 160 karakter); commitError biçimi de kabul edilir', () => {
  const { errText } = load({ fns: ['errText'] });
  const e = new Error('Commit reddedildi.'); e.data = { gitDetail: '\n  HOOK-RED: yasak sözcük\nikinci satır' };
  assert.equal(errText(e), 'Commit reddedildi. (Ayrıntı: HOOK-RED: yasak sözcük)');
  assert.equal(errText({ error: 'Commit reddedildi.', gitCode: 'commitReddedildi', gitDetail: 'tek satır' }), 'Commit reddedildi. (Ayrıntı: tek satır)');
  assert.equal(errText(new Error('Düz hata')), 'Düz hata');
  assert.equal(errText({ message: 'Hata', data: {} }), 'Hata');
  const uzun = errText({ message: 'M', data: { gitDetail: 'x'.repeat(500) } });
  assert.equal(uzun, 'M (Ayrıntı: ' + 'x'.repeat(159) + '…)');
  assert.ok(/^M \(Ayrıntı: (.*)\)$/.exec(uzun)[1].length === 160);
  assert.equal(errText({ message: 'Aynı satır', data: { gitDetail: 'Aynı satır' } }), 'Aynı satır', 'tekrar eden ayrıntı eklenmez');
  assert.equal(errText('metin'), 'metin');
  assert.equal(errText(null), '');
  assert.equal(errText({ data: { gitDetail: 'yalnız ayrıntı' } }), 'yalnız ayrıntı');
});

test('fail: Türkçe sunucu iletisini ve git ayrıntısını gösterir; setupRequired sessizdir', () => {
  const toasts = [];
  const { fail } = load({ fns: ['errText'], consts: ['fail'], expose: ['fail'] }, { toast: (m, k) => toasts.push([m, k]) });
  const e = new Error('Git şu an başka bir işlemle meşgul.'); e.status = 500; e.data = { gitCode: 'kilit', gitDetail: "Unable to create '<yol>/.git/index.lock': File exists." };
  fail(e);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0][0], /^Git şu an başka bir işlemle meşgul\. \(Ayrıntı: Unable to create '<yol>\/\.git\/index\.lock': File exists\.\)$/);
  assert.equal(toasts[0][1], 'error');
  const s = new Error('x'); s.setupRequired = true;
  fail(s);
  assert.equal(toasts.length, 1);
  fail('düz metin');
  assert.equal(toasts[1][0], 'düz metin');
});

test('save: commitError toast\'ı Türkçe özet + git ayrıntısını (hook çıktısı) gösterir', async () => {
  const c = { mp: 'mp', path: 'a.md', isPrompt: true, tab: 'edit', parsed: FM.parse('---\nbaslik: X\n---\ngövde'), savedRaw: '---\nbaslik: X\n---\neski', eol: '\n', bom: '', dirty: true, commitMsg: 'msg', mtime: 5, lead: '' };
  const S = newS({ cur: c, git: { isRepo: true, files: [] } });
  const toasts = [];
  const ctx = load({ fns: ['save', 'staleGuard', 'syncFromDom', 'errText'] }, {
    S, $: () => null, leadOf: () => '', activeName: () => 'mp', uncommitted: () => false, confirmTurRemoval: async () => true,
    toast: (m, k) => toasts.push([m, k]), updateDirty() {}, afterWrite: async () => {}, askIdentity: async () => false, commitOnly: async () => false, askChoice: async () => 'cancel', openFile: async () => {}, fail(e) { throw e; },
    api: async () => ({ ok: true, mtime: 9, commit: null, commitError: { error: 'Commit bir git kancası tarafından reddedildi.', gitCode: 'commitReddedildi', gitDetail: 'HOOK-RED: mesaj kuralı\ndevamı' } })
  });
  assert.equal(await ctx.save(), true);
  assert.equal(toasts[0][1], 'error');
  assert.equal(toasts[0][0], 'Kaydedildi ama commit atılamadı: Commit bir git kancası tarafından reddedildi. (Ayrıntı: HOOK-RED: mesaj kuralı)');
});

/* --------------------------------------------- 403 korunanYol / 409 ppConfigBozuk iletileri */

test('api: 403 korunanYol ve 409 ppConfigBozuk/libraryDirGecersiz sunucunun Türkçe iletisini taşır, kurulum ekranına düşürmez', async () => {
  const cases = [
    [403, { error: 'Bu yol marketplace yapısının parçası; silinemez veya taşınamaz.', code: 'korunanYol' }],
    [409, { error: 'pp.config.json okunamadı: JSON bozuk. Dosyayı düzelt.', code: 'ppConfigBozuk' }],
    [409, { error: 'pp.config.json içindeki libraryDir geçersiz. Düzelt.', code: 'libraryDirGecersiz' }]
  ];
  for (const [status, body] of cases) {
    const toasts = []; let lost = 0;
    const ctx = load({ fns: ['api', 'errText'], consts: ['MP_GUARDED', 'fail'], expose: ['fail'] }, {
      S: newS(), toast: (m, k) => toasts.push([m, k]), onSetupLost() { lost++; }, resyncActive() { throw new Error('etkinDegil olmamalı'); },
      fetch: async () => ({ ok: false, status, json: async () => body })
    });
    let hata;
    try { await ctx.api('DELETE', '/api/file?path=prompts'); } catch (e) { hata = e; }
    assert.ok(hata);
    assert.equal(hata.message, body.error);
    assert.equal(hata.status, status); assert.equal(hata.data.code, body.code);
    assert.ok(!hata.setupRequired && lost === 0);
    ctx.fail(hata);
    assert.deepEqual(toasts, [[body.error, 'error']]);
  }
});

/* ----------------------------------------------------------------- B-14 fmWarn bandı */

function editCtx(raw) {
  const c = { mp: 'mp', path: 'prompts/p/a.md', isPrompt: true, parsed: FM.parse(raw), lead: '', publish: null, dirty: false, commitMsg: '' };
  const S = newS({ cur: c, info: { activeMarketplace: 'mp', config: { marketplace: { plugin: 'varsayilan' }, export: null } } });
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const str = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));
  const base = (p) => p.split('/').pop();
  const ctx = load({ fns: ['editPaneHtml'] }, {
    S, esc, str, base, stem: (p) => base(p).replace(/\.[^.]+$/, ''), fold: FM.fold, normTur: Rules.normTur,
    toList: (v) => (Array.isArray(v) ? v : String(v == null ? '' : v).split(',')).map((x) => String(x).trim()).filter(Boolean),
    chipsHtml: () => '', curCheck: () => null, curNotice: () => null, pubPill: () => '', libDirOf: () => 'prompts', ls: { get: (k, d) => d }
  });
  return { ctx, c };
}

test('editPaneHtml: yinelenen frontmatter anahtarı için #fmWarn uyarı bandı (B-14)', () => {
  const { ctx } = editCtx('---\nbaslik: Ilk\nbaslik: Son\netiketler: [a]\n---\nGövde CIFT');
  const h = ctx.editPaneHtml();
  assert.match(h, /<div id="fmWarn" class="issue warn" role="status">baslik 2 kez yazılmış; sonuncusu geçerli\.<\/div>/);
  assert.ok(h.indexOf('id="fmWarn"') < h.indexOf('class="meta"'), 'bant üstte olmalı');
  const iki = editCtx('---\nbaslik: A\nbaslik: B\ndurum: x\ndurum: y\n---\n').ctx.editPaneHtml();
  assert.match(iki, /id="fmWarn"[^>]*>baslik \(2 kez\), durum \(2 kez\) birden fazla kez yazılmış; hepsinde sonuncusu geçerli\./);
  assert.ok(!/id="fmWarn"/.test(editCtx('---\nbaslik: A\n---\nx').ctx.editPaneHtml()), 'tekrar yoksa bant yok');
  assert.ok(!/id="fmWarn"/.test(editCtx('Frontmatter yok').ctx.editPaneHtml()));
});

/* --------------------------------------------------------------- B-05 menü gizleme */

function menuCtx(libDir = 'prompts') {
  return load({ fns: ['menuItemsFor'], consts: ['PROTECTED_ACTS', 'isProtectedItem'] }, { Rules, libDirOf: () => libDir });
}
const acts = (items) => Array.from(items).map((i) => i.act);

test('menuItemsFor: korunan yollarda Sil/Yeniden adlandır öğeleri yoktur', () => {
  const ctx = menuCtx('prompts');
  for (const p of ['pp.config.json', '.gitignore', '.gitattributes', 'plugins', '.claude-plugin', '.pp/trash/x', 'PP.CONFIG.JSON', 'prompts']) {
    for (const kind of ['tfile', 'file', 'dir']) {
      const a = acts(ctx.menuItemsFor({ kind, mp: 'mp', path: p, node: { name: p } }));
      assert.ok(!a.includes('delete') && !a.includes('rename') && !a.includes('m-rename-file') && !a.includes('m-move'), p + ' (' + kind + '): ' + a.join(','));
    }
  }
  assert.deepEqual(acts(ctx.menuItemsFor({ kind: 'tfile', mp: 'mp', path: 'pp.config.json', node: { name: 'pp.config.json' } })), []);
  // md dosyası ve plugin düğümü de korunan yoldaysa taşıma/ad/silme gizlenir
  assert.deepEqual(acts(ctx.menuItemsFor({ kind: 'file', mp: 'mp', path: 'prompts', node: { name: 'x' } })).filter((x) => /delete|rename|move/.test(x)), []);
});

test('menuItemsFor: korunmayan yollar eskisi gibi; plugin içeriği silinebilir; iç içe libraryDir üst klasörleri korunur', () => {
  const ctx = menuCtx('prompts');
  assert.deepEqual(acts(ctx.menuItemsFor({ kind: 'file', mp: 'mp', path: 'prompts/p/a.md', node: {} })), ['m-move', 'm-rename-file', 'delete']);
  assert.deepEqual(acts(ctx.menuItemsFor({ kind: 'tfile', mp: 'mp', path: 'plugins/mk/commands/a.md', node: {} })), ['rename', 'delete'], 'plugins/<paket> altındaki dosya silinebilir');
  assert.deepEqual(acts(ctx.menuItemsFor({ kind: 'tfile', mp: 'mp', path: 'README.md', node: {} })), ['rename', 'delete']);
  assert.deepEqual(acts(ctx.menuItemsFor({ kind: 'plugin', mp: 'mp', path: 'prompts/plug', node: { name: 'plug' } })),
    ['m-new-prompt', 'open-package', 'm-desc', 'm-rename-plugin', 'm-delete-plugin']);
  assert.ok(acts(ctx.menuItemsFor({ kind: 'mp', mp: 'mp', path: '', node: { active: false, state: 'hazir' } })).includes('m-activate'));
  const ic = menuCtx('a/b');
  assert.deepEqual(acts(ic.menuItemsFor({ kind: 'dir', mp: 'mp', path: 'a', node: {} })), []);
  assert.deepEqual(acts(ic.menuItemsFor({ kind: 'dir', mp: 'mp', path: 'a/b', node: {} })), []);
  assert.deepEqual(acts(ic.menuItemsFor({ kind: 'dir', mp: 'mp', path: 'a/b/x', node: {} })), ['rename', 'delete']);
});

test('rowHtml: menüsü boş kalan teknik dosyada ⋯ düğmesi çizilmez', () => {
  const src = fnSrc('rowHtml');
  assert.match(src, /case 'tfile':[^\n]*menuItemsFor\(it\)\.length \? btn\('menu'/);
});

/* ------------------------------------------- etiket girişi: replaceWith sırasında focusout */

// Üst düzey `document.addEventListener('<tür>', (ev) => {...});` kaydının kaynağını çıkarır.
function listenerSrc(type) {
  const m = new RegExp("^document\\.addEventListener\\('" + type + "', \\(ev\\) => \\{[\\s\\S]*?\\n\\}\\);\\n", 'm').exec(html);
  assert.ok(m, type + ' işleyicisi bulunamadı');
  return m[0];
}

// Tarayıcı sırasını taklit eden küçük DOM saplaması: odaktaki girişi içeren kap replaceWith ile kaldırılırken
// focusout SENKRON tetiklenir (kap o sırada hâlâ ağaçtadır). Kap bu iç çağrıda başka bir replaceWith ile
// zaten değiştirilmişse dıştaki replaceWith NotFoundError fırlatır (Edge 153'te görülen hata).
function chipsCtx(raw = '---\nbaslik: A\netiketler: [eski]\n---\nGövde') {
  const dom = { active: null, root: null, handlers: {}, replaces: 0 };
  const host = {};
  const notFound = () => new DOMException('The node to be replaced is not a child of this node.', 'NotFoundError');
  const mount = (h) => {
    const key = /data-chips="([^"]+)"/.exec(h)[1];
    const input = { value: '', id: '', dataset: { chipIn: key }, classList: { contains: (n) => n === 'chip-in' }, closest: () => null, focus() { dom.active = input; } };
    const el = {
      key, html: h, input, parentNode: null,
      querySelector: (s) => (s === '.chip-in' ? input : null),
      replaceWith(neu) {
        if (!el.parentNode) throw notFound();
        if (dom.active === input) { dom.active = null; dom.handlers.focusout({ target: input }); }
        if (!el.parentNode) throw notFound();
        el.parentNode = null; neu.parentNode = host; dom.root = neu; dom.replaces++;
      }
    };
    return el;
  };
  const c = { mp: 'mp', path: 'prompts/p/a.md', isPrompt: false, parsed: FM.parse(raw), lead: '' };
  const S = newS({ cur: c });
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const $ = (s) => {
    const m = /^\[data-(chips|chip-in)="([^"]+)"\]$/.exec(s);
    if (!m || !dom.root || dom.root.key !== m[2]) return null;
    return m[1] === 'chips' ? dom.root : dom.root.input;
  };
  const ctx = load({ fns: ['refreshChips', 'addChips', 'removeChip', 'setField', 'chipsHtml'], extra: listenerSrc('keydown') + listenerSrc('focusout') }, {
    S, esc, $, fold: FM.fold, str: (v) => String(v == null ? '' : v), trapTab: () => false,
    toList: (v) => (Array.isArray(v) ? v : String(v == null ? '' : v).split(',')).map((x) => String(x).trim()).filter(Boolean),
    leadOf: () => '', updateDirty() {}, refreshPubWarn() {}, paintPaketHint() {}, paintVerHint() {},
    document: { addEventListener: (t, f) => { dom.handlers[t] = f; }, createElement: () => ({ set innerHTML(v) { this.firstElementChild = mount(v); } }) }
  });
  dom.root = mount(ctx.chipsHtml('etiketler', FM.meta(c.parsed).etiketler || [], 'Etiket ekle, Enter'));
  dom.root.parentNode = host;
  const tags = () => [].concat(FM.meta(c.parsed).etiketler || []);
  const shown = () => Array.from(dom.root.html.matchAll(/data-val="([^"]*)"/g), (m) => m[1]);
  // Giriş alanına metin yazıp odaklar; ardından verilen tuşa basar (keydown işleyicisi gerçek koddur).
  const type = (text) => { const i = dom.root.input; i.value = text; i.focus(); return i; };
  const press = (i, key) => dom.handlers.keydown({ target: i, key, ctrlKey: false, metaKey: false, preventDefault() {} });
  // Odak başka yere gider: önce odak düşer, sonra focusout yayılır.
  const blur = (i) => { dom.active = null; dom.handlers.focusout({ target: i }); };
  return { ctx, c, dom, tags, shown, type, press, blur };
}

test('etiket girişi: Enter metni bir kez ekler; replaceWith sırasındaki senkron focusout iç içe addChips çağırmaz (NotFoundError yok)', () => {
  const { dom, tags, shown, type, press } = chipsCtx();
  const eski = type('yeni');
  assert.doesNotThrow(() => press(eski, 'Enter'));
  assert.deepEqual(tags(), ['eski', 'yeni']);
  assert.deepEqual(shown(), ['eski', 'yeni'], 'etiket listede bir kez görünür');
  assert.equal(dom.replaces, 1, 'kap tek kez değiştirilir (iç içe ikinci değişim yok)');
  assert.notEqual(dom.root.input, eski);
  assert.equal(eski.value, '', 'eski girişte metin kalmaz');
  assert.equal(dom.root.input.value, '');
  assert.equal(dom.active, dom.root.input, 'keepFocus: odak yeni girişe verilir');
  // virgül de Enter gibi davranır
  assert.doesNotThrow(() => press(type('ikinci'), ','));
  assert.deepEqual(tags(), ['eski', 'yeni', 'ikinci']);
  assert.equal(dom.active, dom.root.input);
});

test('etiket girişi: yineleyen etiket (fold) eklenmez ama giriş yine boşalır ve odak korunur', () => {
  const { dom, tags, shown, type, press } = chipsCtx();
  assert.doesNotThrow(() => press(type('Eski'), 'Enter'));
  assert.deepEqual(tags(), ['eski']);
  assert.deepEqual(shown(), ['eski']);
  assert.equal(dom.root.input.value, '');
  assert.equal(dom.active, dom.root.input);
});

test('etiket girişi: metin yazıp odak başka yere gidince (focusout, keepFocus=false) etiket yine eklenir, odak çalınmaz', () => {
  const { dom, tags, shown, type, blur } = chipsCtx();
  const i = type('yazilan');
  assert.doesNotThrow(() => blur(i));
  assert.deepEqual(tags(), ['eski', 'yazilan']);
  assert.deepEqual(shown(), ['eski', 'yazilan']);
  assert.equal(dom.replaces, 1);
  assert.equal(dom.active, null, 'keepFocus yok: odak yeni girişe verilmez');
  // boş ya da yalnızca boşluk içeren girişte focusout bir şey eklemez
  assert.doesNotThrow(() => blur(type('   ')));
  assert.deepEqual(tags(), ['eski', 'yazilan']);
  assert.equal(dom.replaces, 1);
});

test('etiket girişi: removeChip ve boş girişte Backspace çalışmaya devam eder', () => {
  const { dom, tags, shown, ctx, type, press } = chipsCtx('---\nbaslik: A\netiketler: [a, b]\n---\nx');
  assert.doesNotThrow(() => press(type(''), 'Backspace'));
  assert.deepEqual(tags(), ['a']);
  assert.equal(dom.active, dom.root.input, 'Backspace sonrası odak girişte kalır');
  assert.doesNotThrow(() => ctx.removeChip('etiketler', 'a'));
  assert.deepEqual(shown(), []);
  assert.equal(dom.replaces, 2);
});

test('refreshChips: kap ağaçtan çıkmışsa sessizce döner, değiştirme denemez', () => {
  const { dom, ctx } = chipsCtx();
  dom.root.parentNode = null;
  assert.doesNotThrow(() => ctx.refreshChips('etiketler'));
  assert.equal(dom.replaces, 0);
});

/* ------------------------------------------- silinen kök: kenar çubuğu "Yükleniyor…" kalmaz */

// Gerçek onSetupLost + renderList + treeHtml; DOM öğeleri ve ağaç modeli saplama. model: true ise gerçek treeModel (S.lib boşken boş döner).
function sidebarCtx(S, { model = true } = {}) {
  const el = {};
  const get = (id) => (el[id] = el[id] || { attrs: {}, innerHTML: '', textContent: '', hidden: false, contains: () => false, setAttribute(k, v) { this.attrs[k] = v; } });
  const stubs = model ? {} : { treeModel: () => [{ kind: 'mp', key: 'mp:' }, { kind: 'file', key: 'mp:a.md' }] };
  const ctx = load({ fns: ['onSetupLost', 'keepLostEdit', 'syncFromDom', 'renderList', 'treeHtml', ...(model ? ['treeModel'] : [])] }, {
    S, document: { title: '• Prompt havuzu', activeElement: null }, $: (s) => get(s),
    esc: (s) => String(s), isFiltering: () => false, paintToolbar() {}, rowEl: () => null, resultsHtml: () => '', resultsNote: () => '',
    rowHtml: (it, fk) => '<div class="row" data-key="' + it.key + '" tabindex="' + (it.key === fk ? 0 : -1) + '"></div>',
    applySetupUi() {}, renderMain() {}, toast() {}, leadOf: () => '',
    ...stubs
  });
  return { ctx, list: get('#list'), title: get('#listTitle') };
}
const ROOT_LOST = { ok: false, rootOk: false, issues: [{ code: 'kokYok', level: 'error', message: 'Library kökü diskte bulunamadı: X' }] };
const ROOT_MSG = 'Library kökü kullanılamıyor; kurulum ekranındaki adımları izle.';

test('kenar çubuğu: kök silinince onSetupLost sonrası liste "Yükleniyor…" değil, kullanılamıyor iletisini gösterir', () => {
  const S = newS({ lib: { marketplaces: [{ name: 'mp', state: 'hazir' }], ignored: [] }, facets: { total: 3 }, results: [{ mp: 'mp', path: 'a.md' }], cur: null, info: { setup: { ok: true, rootOk: true, issues: [] }, root: '/r', isRepo: true } });
  const { ctx, list } = sidebarCtx(S);
  ctx.onSetupLost(ROOT_LOST);
  assert.equal(S.lib, null); assert.equal(S.results, null);
  assert.ok(!list.innerHTML.includes('Yükleniyor'), list.innerHTML);
  assert.ok(list.innerHTML.includes(ROOT_MSG), list.innerHTML);
  assert.match(list.innerHTML, /^<div class="empty">/, 'mevcut .empty sınıfı');
  // aynı durumda yeniden çizim de aynı iletiyi verir (kenar çubuğu yenilemeleri sonsuz yüklemeye dönmez)
  ctx.renderList();
  assert.ok(list.innerHTML.includes(ROOT_MSG) && !list.innerHTML.includes('Yükleniyor'));
});

test('kenar çubuğu: kök yalnızca ok=false ama rootOk=true ise (marketplace sorunu) S.lib korunur, ağaç çizilmeye devam eder', () => {
  const S = newS({ lib: { marketplaces: [{ name: 'mp', state: 'hazir' }], ignored: [] }, facets: { total: 1 } });
  const { ctx, list } = sidebarCtx(S, { model: false });
  ctx.onSetupLost(SETUP_BAD);
  assert.ok(S.lib, 'rootOk iken S.lib silinmez');
  assert.ok(list.innerHTML.includes('data-key="mp:a.md"'), list.innerHTML);
  assert.ok(!list.innerHTML.includes('Yükleniyor') && !list.innerHTML.includes(ROOT_MSG));
});

test('kenar çubuğu: ilk yükleme sırasında (S.lib boş) kurulum rootOk ya da henüz bilinmiyorsa "Yükleniyor…" aynen kalır', () => {
  for (const info of [{ setup: { ok: true, rootOk: true, issues: [] } }, { setup: { ok: false, rootOk: true, issues: [] } }, null, {}, { setup: null }]) {
    const S = newS({ lib: null, facets: { total: 0 }, info });
    const { ctx, list } = sidebarCtx(S);
    ctx.renderList();
    assert.equal(list.innerHTML, '<div class="empty">Yükleniyor…</div>', JSON.stringify(info));
  }
});

test('kenar çubuğu: S.lib doluyken ağaç normal çizilir (kök iletisi ya da yükleniyor yok)', () => {
  for (const setup of [{ ok: true, rootOk: true, issues: [] }, { ok: false, rootOk: false, issues: [] }]) {
    const S = newS({ lib: { marketplaces: [{ name: 'mp', state: 'hazir' }], ignored: [] }, facets: { total: 7 }, info: { setup } });
    const { ctx, list, title } = sidebarCtx(S, { model: false });
    ctx.renderList();
    assert.ok(list.innerHTML.includes('data-key="mp:"') && list.innerHTML.includes('data-key="mp:a.md"'), list.innerHTML);
    assert.ok(!list.innerHTML.includes('Yükleniyor') && !list.innerHTML.includes(ROOT_MSG));
    assert.equal(S.focusKey, 'mp:', 'ilk düğüm odak anahtarı olur');
    assert.equal(title.textContent, 'Kütüphane (7)');
  }
  // marketplace yoksa mevcut boş durum korunur
  const S = newS({ lib: { marketplaces: [], ignored: [] }, facets: { total: 0 } });
  const { ctx, list } = sidebarCtx(S);
  ctx.renderList();
  assert.match(list.innerHTML, /Henüz marketplace yok\./);
});

/* ------------------------------------------------------------------ genel sözleşme */

test('index.html LF kalır; MP_GUARDED ve yeni durum alanları yerinde', () => {
  assert.equal(html.includes('\r'), false);
  assert.match(html, /const MP_GUARDED = \/\^\\\/api\\\/\(file\|rename\|mkdir\|git\\\/\|version\|import\\\/\|marketplace\\\/\|package\|prompts\\\/\|history\\\/\)\/;/);
  for (const k of ['openSeq: 0', 'lostEdit: null', 'resultsInfo: null']) assert.ok(html.includes(k), k);
});
