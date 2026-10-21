'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FM = require('../public/fm.js');
const Rules = require('../public/rules.js');
const TR = require('../public/lang/tr.js');
const EN = require('../public/lang/en.js');
const { uiGlobals } = require('./helpers');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const XSS = '<img src=x onerror="alert(1)">';
const XSS_ESCAPED = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;';
const DIACRITIC_RE = /[çğıöşüÇĞİÖŞÜ]/;

/** Summary: Üst düzey `function ad(...)` bildirimini (tek satırlık ya da `\n}\n` ile biten) çıkarır. */
function fnSrc(name) {
  const one = new RegExp('^(?:async )?function ' + name + '\\(.*\\{.*\\}[ \\t]*$', 'm').exec(html);
  if (one && !/\{\s*$/.test(one[0])) return one[0];
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

/** Summary: İşlev ve const kaynaklarını tek vm bağlamında çalıştırır; global yer tutucular globals ile verilir. */
function load({ fns = [], consts = [], expose = [] }, globals = {}) {
  const ctx = vm.createContext(Object.assign({ FM, Rules, console }, globals));
  vm.runInContext([...consts.map(constSrc), ...fns.map(fnSrc), ...expose.map((n) => 'this.' + n + ' = ' + n + ';')].join('\n'), ctx);
  return ctx;
}

/** Summary: fn'i sırayla tr, en, tr dilinde çalıştırır; ilk iki sonucu { tr, en } döner, üçüncüsü tr'nin yeniden aynı çıktıyı verdiğini denetler. */
function inLangs(g, fn) {
  g.I18n.setLanguage('tr');
  const tr = fn();
  g.I18n.setLanguage('en');
  const en = fn();
  g.I18n.setLanguage('tr');
  assert.deepEqual(fn(), tr, 'tr yeniden aynı çıktıyı verir (etiketler bayatlamaz)');
  return { tr, en };
}

/** Summary: Sahte DOM öğesi. */
function fakeEl() {
  return { attrs: {}, innerHTML: '', textContent: '', title: '', hidden: false, disabled: false, setAttribute(k, v) { this.attrs[k] = v; } };
}

/** Summary: Kimliğe göre sabit öğe veren `$` saplaması ve öğe tablosu. */
function fakeDom() {
  const els = {};
  return { els, $: (s) => (els[s] = els[s] || fakeEl()) };
}

/** Summary: Ağaç ve satır testleri için örnek kütüphane. */
function fixtureLib() {
  const base = { state: 'hazir', active: false, count: 0, plugins: [], loose: [], teknik: [], libraryDirExists: true, libraryDir: 'prompts' };
  return {
    marketplaces: [
      {
        ...base, name: 'mp1', active: true, count: 7, yayinUyari: 3, defaultPlugin: 'mp1-p',
        plugins: [{
          name: 'Alfa', path: 'prompts/alfa', slug: 'alfa', count: 2, nameIssue: null,
          children: [
            { type: 'dir', name: 'alt', path: 'prompts/alfa/alt', count: 1, children: [] },
            { type: 'file', name: 'x.md', path: 'prompts/alfa/x.md', meta: { baslik: 'Başlık', tur: 'ajan', durum: 'taslak', uyari: true, surum: true, paketUyusmuyor: true } }
          ]
        }],
        inbox: { path: 'prompts/gelen-kutusu', count: 1, children: [] },
        loose: [{ type: 'file', name: 'l.md', path: 'prompts/l.md', meta: null }],
        teknik: [{ type: 'file', name: 'README.md', path: 'README.md' }]
      },
      { ...base, name: 'bozuk', state: 'gecersiz', reason: 'Git deposu okunamadı' },
      { ...base, name: 'bos' },
      { ...base, name: 'klasoryok', libraryDirExists: false }
    ],
    ignored: [{ name: 'gitsiz' }]
  };
}

/** Summary: Ağaç durumu ve ağaç işlevleri yüklü vm bağlamı kurar. */
function treeCtx(lib = fixtureLib(), stateExtra = {}) {
  const g = uiGlobals({ browser: true });
  const S = {
    info: { activeMarketplace: 'mp1', setup: { ok: true, rootOk: true, issues: [] } }, lib, cur: null, sel: null, focusKey: null,
    mpOpen: new Set(['mp1', 'bos', 'klasoryok']), gitlessOpen: true, exp: new Set(['prompts/alfa', '#gelen', '#klasorsuz', '#teknik']), ...stateExtra
  };
  const ctx = load({
    fns: ['rowHtml', 'treeHtml', 'treeModel', 'menuItemsFor', 'turLabel'],
    consts: ['esc', 'isFileKind', 'PROTECTED_ACTS', 'isProtectedItem', 'durumClass', 'nodeKey']
  }, {
    ...g, S, fold: FM.fold, ICON: {}, libDirOf: () => 'prompts', expOf: () => S.exp,
    mpByName: (n) => (S.lib && S.lib.marketplaces.find((m) => m.name === n)) || null
  });
  return { ctx, g, S };
}

const itemOf = (items, kind, pick = () => true) => items.find((it) => it.kind === kind && pick(it));
const rows = (ctx, items) => items.map((it) => ctx.rowHtml(it, ''));

/** Summary: vm gerçeğinden gelen değeri test gerçeğine taşır (derin karşılaştırma için). */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const ROW_CASES = [
  ['etkin marketplace', (items) => itemOf(items, 'mp', (it) => it.mp === 'mp1'),
    [', marketplace, etkin marketplace</span>', '<span class="pill ok">etkin</span>', 'title="3 prompt yayınlanmayacak">3 uyarı</span>', 'aria-label="mp1 için yeni plugin"', 'aria-label="mp1 için işlemler"'],
    [', marketplace, active marketplace</span>', '<span class="pill ok">active</span>', 'title="3 prompts will not be published">3 warnings</span>', 'aria-label="New plugin for mp1"', 'aria-label="Actions for mp1"']],
  ['geçersiz marketplace', (items) => itemOf(items, 'mp', (it) => it.mp === 'bozuk'),
    ['<span class="pill bad">geçersiz: Git deposu okunamadı</span>', '<span class="sr">, marketplace</span>'],
    ['<span class="pill bad">invalid: Git deposu okunamadı</span>', '<span class="sr">, marketplace</span>']],
  ['plugin', (items) => itemOf(items, 'plugin'),
    ['<span class="sr">, plugin</span>', 'aria-label="Alfa içine yeni prompt"', 'aria-label="Alfa için işlemler"'],
    ['<span class="sr">, plugin</span>', 'aria-label="New prompt in Alfa"', 'aria-label="Actions for Alfa"']],
  ['klasör', (items) => itemOf(items, 'dir'),
    ['<span class="sr">, klasör</span>', 'aria-label="alt için işlemler"'],
    ['<span class="sr">, folder</span>', 'aria-label="Actions for alt"']],
  ['gelen kutusu', (items) => itemOf(items, 'inbox'),
    ['<span class="name">Gelen kutusu</span>', 'aria-label="Gelen kutusu için işlemler"'],
    ['<span class="name">Inbox</span>', 'aria-label="Actions for Inbox"']],
  ['klasörsüz promptlar', (items) => itemOf(items, 'loose'),
    ['<span class="name">Klasörsüz promptlar</span>', 'title="Yayında &quot;mp1-p&quot; plugin&#39;ine gider."'],
    ['<span class="name">Loose prompts (no folder)</span>', 'title="Published into the &quot;mp1-p&quot; plugin."']],
  ['teknik dosyalar', (items) => itemOf(items, 'teknik'),
    ['<span class="name">Teknik dosyalar</span>'],
    ['<span class="name">Technical files</span>']],
  ['teknik dosya', (items) => itemOf(items, 'tfile'),
    ['aria-label="README.md için işlemler"'],
    ['aria-label="Actions for README.md"']],
  ['git deposu olmayan klasörler', (items) => itemOf(items, 'gitless'),
    ['Git deposu olmayan klasörler (1)'],
    ['Folders that are not git repositories (1)']],
  ['git deposu olmayan klasör', (items) => itemOf(items, 'gitlessItem'),
    ['<span class="pill warn">Git deposu değil</span>', "tabindex=\"-1\">Git'i başlat</button>"],
    ['<span class="pill warn">Not a git repository</span>', 'tabindex="-1">Initialize git</button>']],
  ['uyarılı prompt', (items) => itemOf(items, 'file', (it) => it.path === 'prompts/alfa/x.md'),
    ['<span class="pill">ajan</span>', 'title="Yayınlanmayacak, ayrıntı için aç" aria-label="Yayın uyarısı">!</span>', 'title="Son sürümden beri değişti, versiyon aynı" aria-label="Sürüm uyarısı">v</span>',
      'title="paket alanı klasörle uyuşmuyor" aria-label="Paket klasörle uyuşmuyor">p</span>', 'aria-label="Başlık için işlemler"'],
    ['<span class="pill">agent</span>', 'title="Will not be published, open for details" aria-label="Publish warning">!</span>', 'title="Changed since the last version, version is the same" aria-label="Version warning">v</span>',
      'title="package field does not match the folder" aria-label="Package does not match the folder">p</span>', 'aria-label="Actions for Başlık"']]
];

test('ağaç satırları: tr bugünkü Türkçe, en İngilizce; aynı işlev iki dilde etiketleri bayatlamadan üretir', () => {
  const { ctx, g } = treeCtx();
  const items = ctx.treeModel();
  for (const [ad, pick, wantTr, wantEn] of ROW_CASES) {
    const item = pick(items);
    assert.ok(item, ad + ' bulunamadı');
    const out = inLangs(g, () => ctx.rowHtml(item, ''));
    for (const text of wantTr) assert.ok(out.tr.includes(text), 'tr ' + ad + ': ' + text + '\n' + out.tr);
    for (const text of wantEn) assert.ok(out.en.includes(text), 'en ' + ad + ': ' + text + '\n' + out.en);
  }
});

test('ağaç satırları: veri sözleşmesi (data-act, class, anahtar) iki dilde aynı kalır', () => {
  const { ctx, g } = treeCtx();
  const items = ctx.treeModel();
  const skeleton = (text) => text.replace(/>[^<]*</g, '><').replace(/(?:title|aria-label)="[^"]*"/g, '');
  const out = inLangs(g, () => rows(ctx, items).map(skeleton));
  assert.deepEqual(out.en, out.tr);
});

test('ağaç modeli: boş ve eksik klasör notları ile eylem düğmesi etiketi iki dilde', () => {
  const { ctx, g } = treeCtx();
  const notes = inLangs(g, () => plain(ctx.treeModel().filter((it) => it.kind === 'note').map((it) => [it.text, it.actionLabel || null])));
  assert.deepEqual(notes.tr, [['Henüz plugin yok.', 'Yeni plugin'], ['Prompt klasörü yok (prompts/).', null]]);
  assert.deepEqual(notes.en, [['No plugins yet.', 'New plugin'], ['Prompt folder is missing (prompts/).', null]]);
  const html = inLangs(g, () => {
    const items = ctx.treeModel().filter((it) => it.kind === 'note');
    return ctx.rowHtml(items[0], '');
  });
  assert.match(html.tr, />Henüz plugin yok\. <button class="btn sm" data-act="new-plugin" data-mp="bos">Yeni plugin<\/button>/);
  assert.match(html.en, />No plugins yet\. <button class="btn sm" data-act="new-plugin" data-mp="bos">New plugin<\/button>/);
});

test('ağaç: yükleniyor, kök kullanılamıyor ve marketplace yok boş durumları iki dilde', () => {
  const { ctx, g, S } = treeCtx();
  S.lib = null;
  const loading = inLangs(g, () => ctx.treeHtml());
  assert.equal(loading.tr, '<div class="empty">Yükleniyor…</div>');
  assert.equal(loading.en, '<div class="empty">Loading…</div>');
  S.info.setup.rootOk = false;
  const lost = inLangs(g, () => ctx.treeHtml());
  assert.equal(lost.tr, '<div class="empty">Library kökü kullanılamıyor; kurulum ekranındaki adımları izle.</div>');
  assert.equal(lost.en, '<div class="empty">The library root is unavailable; follow the steps on the setup screen.</div>');
  S.info.setup.rootOk = true;
  S.lib = { marketplaces: [], ignored: [] };
  const none = inLangs(g, () => ctx.treeHtml());
  assert.equal(none.tr, '<div class="empty">Henüz marketplace yok.<br><button class="btn sm primary" data-act="new-mp" style="margin-top:8px">Yeni marketplace</button></div>');
  assert.equal(none.en, '<div class="empty">No marketplaces yet.<br><button class="btn sm primary" data-act="new-mp" style="margin-top:8px">New marketplace</button></div>');
});

test('bağlam menüsü: etiketler dile göre, eylem kodları (data-act) dilden bağımsız; aynı işlev tr-en-tr', () => {
  const { ctx, g } = treeCtx();
  const mk = (kind, path, node) => ({ kind, mp: 'mp1', path, node });
  const cases = [
    [mk('mp', '', { active: false, state: 'hazir' }),
      ['Etkinleştir', 'Yeni plugin', 'Git paneli', 'Marketplace (yayın)', 'Yolu kopyala'],
      ['Activate', 'New plugin', 'Git panel', 'Marketplace (publishing)', 'Copy path'],
      ['m-activate', 'new-plugin', 'git', 'market', 'm-copy-path']],
    [mk('plugin', 'prompts/alfa', { name: 'Alfa' }),
      ['Yeni prompt', 'Paket sayfasını aç', 'Açıklamayı düzenle', 'Yeniden adlandır', 'Sil (çöp kutusuna taşı)'],
      ['New prompt', 'Open package page', 'Edit description', 'Rename', 'Delete (move to trash)'],
      ['m-new-prompt', 'open-package', 'm-desc', 'm-rename-plugin', 'm-delete-plugin']],
    [mk('dir', 'prompts/alfa/alt', { name: 'alt' }),
      ['Yeniden adlandır veya taşı', 'Sil (çöp kutusuna taşı)'], ['Rename or move', 'Delete (move to trash)'], ['rename', 'delete']],
    [mk('file', 'prompts/l.md', {}),
      ["Plugin'e taşı…", 'Yeniden adlandır', 'Sil (çöp kutusuna taşı)'], ['Move to plugin…', 'Rename', 'Delete (move to trash)'], ['m-move', 'm-rename-file', 'delete']],
    [mk('file', 'prompts/alfa/x.md', {}),
      ['Taşı…', 'Yeniden adlandır', 'Sil (çöp kutusuna taşı)'], ['Move…', 'Rename', 'Delete (move to trash)'], ['m-move', 'm-rename-file', 'delete']],
    [mk('file', 'notlar/a.txt', {}),
      ['Yeniden adlandır veya taşı', 'Sil (çöp kutusuna taşı)'], ['Rename or move', 'Delete (move to trash)'], ['rename', 'delete']],
    [mk('tfile', 'README.md', {}),
      ['Yeniden adlandır veya taşı', 'Sil (çöp kutusuna taşı)'], ['Rename or move', 'Delete (move to trash)'], ['rename', 'delete']],
    [mk('inbox', 'prompts/gelen-kutusu', {}), ['İçe aktar'], ['Import'], ['import']]
  ];
  for (const [item, wantTr, wantEn, wantActs] of cases) {
    const out = inLangs(g, () => Array.from(ctx.menuItemsFor(item), (i) => i.label));
    assert.deepEqual(out.tr, wantTr, item.kind + ' tr');
    assert.deepEqual(out.en, wantEn, item.kind + ' en');
    assert.deepEqual(Array.from(ctx.menuItemsFor(item), (i) => i.act), wantActs, item.kind + ' eylemler');
  }
});

test('turLabel: kanonik tür değeri dile göre rozet etiketi, bilinmeyen değer ham, boş değer boş', () => {
  const { ctx, g } = treeCtx();
  const out = inLangs(g, () => ['komut', 'ajan', 'skill', 'bilinmeyen', '', null, undefined].map((v) => ctx.turLabel(v)));
  assert.deepEqual(out.tr, ['komut', 'ajan', 'skill', 'bilinmeyen', '', '', '']);
  assert.deepEqual(out.en, ['command', 'agent', 'skill', 'bilinmeyen', '', '', '']);
});

test('XSS: kullanıcı girdisi (ad, başlık, sebep, yol) iki dilde kaçışlanır; ham etiket çıkmaz', () => {
  const lib = fixtureLib();
  lib.marketplaces[0].name = XSS;
  lib.marketplaces[0].defaultPlugin = XSS;
  lib.marketplaces[0].plugins[0].name = XSS;
  lib.marketplaces[0].plugins[0].children[0].name = XSS;
  lib.marketplaces[0].plugins[0].children[1].meta.baslik = XSS;
  lib.marketplaces[0].teknik[0].name = XSS;
  lib.marketplaces[1].reason = XSS;
  lib.ignored[0].name = XSS;
  const { ctx, g, S } = treeCtx(lib, { mpOpen: new Set([XSS, 'bos', 'klasoryok']) });
  S.info.activeMarketplace = XSS;
  const out = inLangs(g, () => {
    const items = ctx.treeModel();
    return rows(ctx, items).join('\n');
  });
  for (const lang of ['tr', 'en']) {
    assert.doesNotMatch(out[lang], /<img/, lang);
    assert.ok(out[lang].includes(XSS_ESCAPED), lang);
  }
  g.I18n.setLanguage('tr');
  const loose = ctx.treeModel().find((it) => it.kind === 'loose');
  assert.ok(ctx.rowHtml(loose, '').includes('title="Yayında &quot;' + XSS_ESCAPED + '&quot; plugin&#39;ine gider."'));
});

test('arama: sonuç başlığı "Sonuçlar (300 / 3012)" tr\'de aynen, en\'de İngilizce; marketplace sayısı çoğul', () => {
  const g = uiGlobals({ browser: true });
  const ctx = load({ fns: ['resultsTitle', 'resultsNote'], consts: ['esc'] }, g);
  const r300 = new Array(300).fill({ mp: 'a' });
  const cut = { total: 3012, limit: 300, truncated: true };
  const cases = [
    [[r300, cut, 1], 'Sonuçlar (300 / 3012)', 'Results (300 / 3012)'],
    [[r300, cut, 3], 'Sonuçlar (300 / 3012) · 3 marketplace', 'Results (300 / 3012) · 3 marketplaces'],
    [[r300, { total: 300, limit: 300, truncated: false }, 1], 'Sonuçlar (300)', 'Results (300)'],
    [[[{ mp: 'a' }, { mp: 'b' }], null, 2], 'Sonuçlar (2) · 2 marketplace', 'Results (2) · 2 marketplaces'],
    [[[], { total: 0, limit: 300, truncated: false }, 0], 'Sonuçlar (0)', 'Results (0)']
  ];
  for (const [args, wantTr, wantEn] of cases) {
    const out = inLangs(g, () => ctx.resultsTitle(...args));
    assert.equal(out.tr, wantTr);
    assert.equal(out.en, wantEn);
  }
  g.I18n.setLanguage('en');
  assert.equal(g.I18n.tx('ui.search.titleMulti', { total: '1', count: 1 }), 'Results (1) · 1 marketplace');
  g.I18n.setLanguage('tr');
  const note = inLangs(g, () => ctx.resultsNote(cut));
  assert.equal(note.tr, '<div class="hint res-note" role="listitem">İlk 300 sonuç gösteriliyor. Daraltmak için etiket, durum, tür filtresi ya da daha uzun bir sözcük kullan.</div>');
  assert.equal(note.en, '<div class="hint res-note" role="listitem">Showing the first 300 results. To narrow them down, use a tag, status or type filter, or a longer search term.</div>');
  assert.equal(ctx.resultsNote({ truncated: false }), '');
});

test('arama sonuçları: boş durum, tür rozeti ve konum etiketi dile göre; başlık ve yol kaçışlı', () => {
  const g = uiGlobals({ browser: true });
  const S = { results: [], cur: null, f: { q: 'kod' } };
  const ctx = load({
    fns: ['resultsHtml', 'hl', 'turLabel'], consts: ['esc', 'durumClass', 'whereOf', 'base']
  }, { ...g, S, fold: FM.fold });
  const empty = inLangs(g, () => ctx.resultsHtml());
  assert.equal(empty.tr, '<div class="empty">Eşleşen prompt yok. Filtreleri veya arama sözcüklerini değiştir.</div>');
  assert.equal(empty.en, '<div class="empty">No matching prompts. Change the filters or the search terms.</div>');
  S.results = [
    { mp: 'mp1', path: 'prompts/a/x.md', kind: 'paket', plugin: 'a', baslik: 'Kod', durum: 'kararlı', tur: 'komut', etiketler: [] },
    { mp: 'mp1', path: 'prompts/l.md', kind: 'klasorsuz', baslik: 'L', durum: '', tur: 'skill', etiketler: [] },
    { mp: 'mp1', path: 'prompts/gelen-kutusu/g.md', kind: 'gelenKutusu', baslik: 'G', durum: '', tur: 'ajan', etiketler: [] },
    { mp: 'mp1', path: 'README.md', kind: 'disarida', baslik: 'R', durum: '', tur: '', etiketler: [] },
    { mp: 'mp1', path: 'plugins/x/y.md', kind: 'disarida', baslik: 'Y', durum: '', tur: '', etiketler: [] }
  ];
  const out = inLangs(g, () => ctx.resultsHtml());
  const where = (text) => [...text.matchAll(/<div class="rp">mp1 › (.*?) ›/g)].map((m) => m[1]);
  const pills = (text) => [...text.matchAll(/<span class="pill">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(where(out.tr), ['a', 'Klasörsüz', 'Gelen kutusu', 'Teknik', 'plugins/x']);
  assert.deepEqual(where(out.en), ['a', 'No folder', 'Inbox', 'Technical', 'plugins/x']);
  assert.deepEqual(pills(out.tr), ['komut', 'skill', 'ajan']);
  assert.deepEqual(pills(out.en), ['command', 'skill', 'agent']);
  S.results = [{ mp: XSS, path: 'a/' + XSS + '.md', kind: 'paket', plugin: XSS, baslik: XSS, durum: '', tur: '', snippet: XSS, etiketler: [XSS] }];
  const xss = inLangs(g, () => ctx.resultsHtml());
  for (const lang of ['tr', 'en']) {
    assert.doesNotMatch(xss[lang], /<img/, lang);
    assert.ok(xss[lang].includes(XSS_ESCAPED), lang);
  }
});

test('filtre çubuğu: etiket düğmeleri "Tüm etiketler (N)" / "Daha az göster" dile göre, etiket adı kaçışlı', () => {
  const g = uiGlobals({ browser: true });
  const dom = fakeDom();
  const tags = Array.from({ length: 16 }, (_, i) => ({ name: i === 0 ? XSS : 't' + i, count: i + 1 }));
  const S = { facets: { tags, projeler: [] }, tagsAll: false, f: { tags: [] }, info: { config: { marketplace: { plugin: 'vp' } } } };
  const ctx = load({ fns: ['renderFilters'], consts: ['esc'] }, { ...g, S, $: dom.$, fold: FM.fold, activeMp: () => null, pluginsOf: () => [] });
  const last = () => /<button class="tagbtn" data-act="tags-all">([^<]*)<\/button>/.exec(dom.els['#tagbar'].innerHTML)[1];
  const more = inLangs(g, () => { ctx.renderFilters(); return last(); });
  assert.equal(more.tr, 'Tüm etiketler (16)');
  assert.equal(more.en, 'All tags (16)');
  assert.doesNotMatch(dom.els['#tagbar'].innerHTML, /<img/);
  S.tagsAll = true;
  const less = inLangs(g, () => { ctx.renderFilters(); return last(); });
  assert.equal(less.tr, 'Daha az göster');
  assert.equal(less.en, 'Show fewer');
});

test('rozet ve araç çubuğu: yayınlanmayacak sayısı çoğul, düğme ipuçları ve nedenleri dile göre', () => {
  const g = uiGlobals({ browser: true });
  const dom = fakeDom();
  const S = { facets: { yayinUyariByMp: { mp1: 1 } }, info: { activeMarketplace: 'mp1' } };
  const state = { rok: true, ok: true, mp: null };
  const ctx = load({ fns: ['renderMkBadge', 'paintToolbar'] }, {
    ...g, S, $: dom.$, setupOk: () => state.ok, rootOk: () => state.rok, activeMp: () => state.mp, activeName: () => 'mp1'
  });
  const badge = (n) => { S.facets.yayinUyariByMp.mp1 = n; ctx.renderMkBadge(); return dom.els['#mkBadge'].title; };
  assert.deepEqual([1, 5].map((n) => inLangs(g, () => badge(n)).tr), ['1 prompt yayınlanmayacak', '5 prompt yayınlanmayacak']);
  assert.deepEqual([1, 5].map((n) => inLangs(g, () => badge(n)).en), ['1 prompt will not be published', '5 prompts will not be published']);
  const toolbar = (rok, ok, mp) => {
    Object.assign(state, { rok, ok, mp });
    ctx.paintToolbar();
    return ['tbMp', 'tbPlugin', 'tbPrompt'].map((id) => dom.els['#' + id].title + '|' + dom.els['#why-' + id.slice(2).toLowerCase()].textContent + '|' + dom.els['#' + id].disabled);
  };
  assert.deepEqual(inLangs(g, () => toolbar(false, false, null)).tr, [
    "Library kökü hazır değil: önce Ayarlar'dan kökü seç|Library kökü hazır değil: önce Ayarlar'dan kökü seç|true",
    'Library kökü hazır değil|Library kökü hazır değil|true',
    'Önce bir marketplace seç|Önce bir marketplace seç|true'
  ]);
  assert.deepEqual(inLangs(g, () => toolbar(false, false, null)).en, [
    'Library root is not ready: choose the root in Settings first|Library root is not ready: choose the root in Settings first|true',
    'Library root is not ready|Library root is not ready|true',
    'Select a marketplace first|Select a marketplace first|true'
  ]);
  assert.deepEqual(inLangs(g, () => toolbar(true, true, { plugins: [] })).tr, [
    'Yeni marketplace||false', 'Yeni plugin: mp1||false', 'Önce bir plugin oluştur|Önce bir plugin oluştur|true'
  ]);
  assert.deepEqual(inLangs(g, () => toolbar(true, true, { plugins: [] })).en, [
    'New marketplace||false', 'New plugin: mp1||false', 'Create a plugin first|Create a plugin first|true'
  ]);
  assert.deepEqual(inLangs(g, () => toolbar(true, true, { plugins: [1] })).en.slice(1), ['New plugin: mp1||false', 'New prompt: mp1||false']);
});

test('renderList: başlık ve aria-label dile göre ("Kütüphane (N)" / "Library (N)")', () => {
  const g = uiGlobals({ browser: true });
  const dom = fakeDom();
  const S = { results: null, resultsInfo: null, facets: { total: 12 }, f: { q: '', tags: [], durum: '', tur: '' } };
  const ctx = load({ fns: ['renderList'], consts: ['isFiltering'] }, {
    ...g, S, $: dom.$, document: { activeElement: null }, treeHtml: () => '<TREE/>', resultsHtml: () => '<RES/>', resultsNote: () => '', resultsTitle: () => 'T',
    rowEl: () => null, paintToolbar() {}
  });
  dom.$('#list').contains = () => false;
  const tree = inLangs(g, () => { ctx.renderList(); return dom.els['#listTitle'].textContent + '|' + dom.els['#list'].attrs['aria-label']; });
  assert.equal(tree.tr, 'Kütüphane (12)|Kütüphane');
  assert.equal(tree.en, 'Library (12)|Library');
  S.results = [{ mp: 'a', path: 'x.md' }];
  const found = inLangs(g, () => { ctx.renderList(); return dom.els['#list'].attrs['aria-label']; });
  assert.equal(found.tr, 'Arama sonuçları');
  assert.equal(found.en, 'Search results');
});

test('modal yardımcıları: askText varsayılan düğmeleri dile göre, verilen ok korunur; kullanıcı metni kaçışlı', () => {
  const g = uiGlobals({ browser: true });
  const opened = [];
  const ctx = load({ fns: ['askText', 'askChoice'], consts: ['esc'] }, { ...g, openModal: (o) => opened.push(o) });
  const foot = (o) => [...o.html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
  const out = inLangs(g, () => { ctx.askText({ title: 'T', label: 'L' }); return foot(opened.pop()); });
  assert.deepEqual(out.tr, ['Vazgeç', 'Tamam']);
  assert.deepEqual(out.en, ['Cancel', 'OK']);
  ctx.askText({ title: 'T', label: 'L', ok: 'Özel' });
  assert.deepEqual(foot(opened.pop()), ['Vazgeç', 'Özel']);
  ctx.askText({ title: XSS, label: XSS, hint: XSS, value: XSS });
  const textHtml = opened.pop().html;
  assert.doesNotMatch(textHtml, /<img/);
  assert.ok(textHtml.includes(XSS_ESCAPED));
  ctx.askChoice({ title: 'T', text: XSS, choices: [{ id: 'a', label: XSS }] });
  const choiceHtml = opened.pop().html;
  assert.doesNotMatch(choiceHtml, /<img/);
  assert.ok(choiceHtml.includes(XSS_ESCAPED));
});

test('confirmDiscard: başlık, metin ve düğmeler dile göre; dosya adı kaçışlı gösterilir ve eylem kodları sabit', async () => {
  const g = uiGlobals({ browser: true });
  const opened = [];
  const S = { cur: { path: 'prompts/' + XSS + '.md', dirty: true } };
  const ctx = load({ fns: ['confirmDiscard', 'askChoice'], consts: ['esc', 'isDirty', 'base'] }, { ...g, S, openModal: (o) => opened.push(o), save: async () => true });
  const run = async () => { const pending = ctx.confirmDiscard(); const o = opened.pop(); o.onClose(); await pending; return o; };
  g.I18n.setLanguage('tr');
  const tr = await run();
  g.I18n.setLanguage('en');
  const en = await run();
  g.I18n.setLanguage('tr');
  const parts = (o) => ({ title: o.title, text: /<p>(.*?)<\/p>/.exec(o.html)[1], buttons: [...o.html.matchAll(/data-choice="([^"]*)">([^<]*)</g)].map((m) => m[1] + '=' + m[2]) });
  assert.deepEqual(parts(tr).buttons, ['cancel=Vazgeç', 'discard=Değişiklikleri at', 'save=Kaydet ve devam et']);
  assert.deepEqual(parts(en).buttons, ['cancel=Cancel', 'discard=Discard changes', 'save=Save and continue']);
  assert.equal(parts(tr).title, 'Kaydedilmemiş değişiklikler var');
  assert.equal(parts(en).title, 'You have unsaved changes');
  assert.equal(parts(tr).text, '&quot;' + XSS_ESCAPED + '.md&quot; dosyasında kaydetmediğin değişiklikler var.');
  assert.ok(parts(en).text.includes('has changes you have not saved.'));
  assert.doesNotMatch(tr.html + en.html, /<img/);
  S.cur.dirty = false;
  assert.equal(await ctx.confirmDiscard(), true);
  assert.equal(opened.length, 0, 'kirli değilse pencere açılmaz');
});

test('offerLostEdit: başlık, metin (commit mesajlı ve mesajsız tam cümle), düğmeler ve geri yükleme iletisi dile göre', async () => {
  const g = uiGlobals({ browser: true });
  const asked = [];
  const toasts = [];
  const make = (commitMsg, answer) => {
    const c = { mp: 'mp1', path: 'prompts/a.md', parsed: FM.parse('x'), eol: '\n', bom: '', lead: '', commitMsg: '' };
    const S = { cur: c, lostEdit: { mp: 'mp1', path: 'prompts/a.md', raw: '---\nbaslik: Y\n---\nz', commitMsg } };
    const ctx = load({ fns: ['offerLostEdit'], consts: ['base'] }, {
      ...g, S, askChoice: async (o) => { asked.push(o); return answer; }, toast: (m) => toasts.push(m), renderMain() {}, updateDirty() {}, leadOf: () => ''
    });
    return ctx;
  };
  const view = (o) => ({ title: o.title, text: o.text, choices: Array.from(o.choices, (c) => c.id + '=' + c.label) });
  const results = {};
  for (const lang of ['tr', 'en']) {
    g.I18n.setLanguage(lang);
    asked.length = 0;
    await make('', 'later').offerLostEdit();
    await make('mesaj', 'later').offerLostEdit();
    results[lang] = plain(asked.map(view));
  }
  assert.deepEqual(results.tr, [
    { title: 'Kaydedilmemiş metin bulundu', text: 'Kurulum bozulmadan önce "a.md" dosyasında kaydedilmemiş değişiklikler vardı. Geri yüklensin mi?', choices: ['later=Daha sonra', 'drop=At', 'restore=Geri yükle'] },
    { title: 'Kaydedilmemiş metin bulundu', text: 'Kurulum bozulmadan önce "a.md" dosyasında kaydedilmemiş değişiklikler vardı (commit mesajın da korundu). Geri yüklensin mi?', choices: ['later=Daha sonra', 'drop=At', 'restore=Geri yükle'] }
  ]);
  assert.deepEqual(results.en, [
    { title: 'Unsaved text found', text: 'Before the setup broke, "a.md" had unsaved changes. Restore them?', choices: ['later=Later', 'drop=Discard', 'restore=Restore'] },
    { title: 'Unsaved text found', text: 'Before the setup broke, "a.md" had unsaved changes (your commit message was kept too). Restore them?', choices: ['later=Later', 'drop=Discard', 'restore=Restore'] }
  ]);
  toasts.length = 0;
  g.I18n.setLanguage('tr');
  await make('', 'restore').offerLostEdit();
  g.I18n.setLanguage('en');
  await make('', 'restore').offerLostEdit();
  g.I18n.setLanguage('tr');
  assert.deepEqual(toasts, ['Kaydedilmemiş metin geri yüklendi', 'Unsaved text restored']);
});

test('errText, api yedek iletisi, staleGuard, saveLabel ve belge başlığı dile göre; sunucu iletisi çevrilmeden ham', async () => {
  const g = uiGlobals({ browser: true });
  const toasts = [];
  const doc = { title: '' };
  const els = fakeDom();
  const S = { info: { activeMarketplace: 'etkin' }, cur: { mp: XSS, path: 'a.md', dirty: true, commitMsg: 'm', savedRaw: 'eski' } };
  const ctx = load({
    fns: ['errText', 'api', 'staleGuard', 'saveLabel', 'updateDirty', 'clearCur'], consts: ['MP_GUARDED', 'activeName']
  }, {
    ...g, S, document: doc, $: els.$, toast: (m, k, ms) => toasts.push([m, k, ms]), ls: { set() {} }, lsKey: (k) => k,
    uncommitted: () => true, computeRaw: () => 'yeni', resyncActive() {}, onSetupLost() {},
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) })
  });
  const detail = inLangs(g, () => ctx.errText({ message: 'M', data: { gitDetail: '\n D1\nD2' } }));
  assert.equal(detail.tr, 'M (Ayrıntı: D1)');
  assert.equal(detail.en, 'M (Detail: D1)');
  assert.equal(ctx.errText({ message: 'Aynı', data: { gitDetail: 'Aynı' } }), 'Aynı');
  const apiError = async () => { try { await ctx.api('GET', '/api/x'); } catch (e) { return e.message; } return null; };
  g.I18n.setLanguage('tr');
  const failedTr = await apiError();
  g.I18n.setLanguage('en');
  const failedEn = await apiError();
  assert.equal(failedTr, 'İstek başarısız (500)');
  assert.equal(failedEn, 'Request failed (500)');
  ctx.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: 'Sunucu Türkçe iletisi' }) });
  await assert.rejects(ctx.api('GET', '/api/x'), (e) => e.message === 'Sunucu Türkçe iletisi');
  g.I18n.setLanguage('tr');
  const stale = inLangs(g, () => { toasts.length = 0; ctx.staleGuard(); return toasts[0]; });
  assert.deepEqual(stale.tr, ['Bu dosya "' + XSS + '" marketplace\'ine ait ama etkin marketplace "etkin". Dosyayı ağaçtan yeniden aç.', 'error', 7000]);
  assert.deepEqual(stale.en, ['This file belongs to the "' + XSS + '" marketplace but the active marketplace is "etkin". Reopen the file from the tree.', 'error', 7000]);
  S.cur = { mp: 'etkin', path: 'a.md', dirty: true, commitMsg: ' ' };
  const labels = (dirty, msg, uncommittedFile) => {
    S.cur.dirty = dirty; S.cur.commitMsg = msg; ctx.uncommitted = () => uncommittedFile;
    return ctx.saveLabel();
  };
  const save = inLangs(g, () => [labels(true, 'm', true), labels(true, '', true), labels(false, 'm', true), labels(false, '', true)]);
  assert.deepEqual(save.tr, ['Kaydet ve commit et', 'Kaydet', 'Commit et', 'Kaydet']);
  assert.deepEqual(save.en, ['Save and commit', 'Save', 'Commit', 'Save']);
  S.cur = { mp: 'etkin', path: 'a.md', dirty: false, commitMsg: '', savedRaw: 'eski' };
  ctx.uncommitted = () => false;
  for (const lang of ['tr', 'en']) {
    g.I18n.setLanguage(lang);
    ctx.updateDirty();
    assert.equal(doc.title, '• Prompt havuzu', 'marka adı çevrilmez ' + lang);
    ctx.clearCur();
    assert.equal(doc.title, 'Prompt havuzu', lang);
    S.cur = { mp: 'etkin', path: 'a.md', dirty: false, commitMsg: '', savedRaw: 'eski' };
  }
});

test('sözlük: bölgenin tr değerleri bugünkü metnin harfi harfine aynısı (kilit)', () => {
  const locked = {
    'ui.common.requestFailed': 'İstek başarısız ({status})',
    'ui.common.errorDetail': '{message} (Ayrıntı: {detail})',
    'ui.common.loading': 'Yükleniyor…',
    'ui.tree.noPromptDir': 'Prompt klasörü yok ({dir}/).',
    'ui.tree.initGit': "Git'i başlat",
    'ui.tree.looseTitle': 'Yayında "{plugin}" plugin\'ine gider.',
    'ui.tree.srMarketplaceActive': ', marketplace, etkin marketplace',
    'ui.search.title': 'Sonuçlar ({total})',
    'ui.search.truncated': 'İlk {limit} sonuç gösteriliyor. Daraltmak için etiket, durum, tür filtresi ya da daha uzun bir sözcük kullan.',
    'ui.toolbar.rootNotReadyPickRoot': "Library kökü hazır değil: önce Ayarlar'dan kökü seç",
    'ui.menu.deleteToTrash': 'Sil (çöp kutusuna taşı)',
    'ui.menu.moveToPlugin': "Plugin'e taşı…",
    'ui.file.staleMarketplace': 'Bu dosya "{mp}" marketplace\'ine ait ama etkin marketplace "{active}". Dosyayı ağaçtan yeniden aç.',
    'ui.discard.text': '"{name}" dosyasında kaydetmediğin değişiklikler var.',
    'ui.lostEdit.textWithMessage': 'Kurulum bozulmadan önce "{name}" dosyasında kaydedilmemiş değişiklikler vardı (commit mesajın da korundu). Geri yüklensin mi?'
  };
  for (const [key, text] of Object.entries(locked)) {
    assert.equal(TR[key], text, key);
    assert.equal(typeof EN[key], 'string', 'en ' + key);
    assert.notEqual(EN[key], text, 'en çevrilmiş ' + key);
  }
  assert.deepEqual(TR['ui.common.wontPublish'], { other: '{count} prompt yayınlanmayacak' });
  assert.deepEqual(TR['ui.tree.warningCount'], { other: '{count} uyarı' });
  assert.deepEqual(TR['ui.search.titleMulti'], { other: 'Sonuçlar ({total}) · {count} marketplace' });
});

/** Summary: Kaynaktaki dize değişmezlerini yorumları ve düzenli ifade değişmezlerini atlayarak, iç içe şablon dizeleri dahil çıkarır. */
function stringLiterals(src) {
  const found = [];
  const beforeRegex = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', 'return']);
  const stack = [{ mode: 'code', depth: 0 }];
  let text = '';
  let prev = '';
  let i = 0;
  while (i < src.length) {
    const top = stack[stack.length - 1];
    const c = src[i];
    const next = src[i + 1];
    if (top.mode === 'template') {
      if (c === '\\') { text += c + (next || ''); i += 2; continue; }
      if (c === '`') { found.push(text); text = ''; stack.pop(); prev = 'x'; i++; continue; }
      if (c === '$' && next === '{') { found.push(text); text = ''; stack.push({ mode: 'code', depth: 0 }); prev = ''; i += 2; continue; }
      text += c;
      i++;
      continue;
    }
    if (c === '/' && next === '/') { const end = src.indexOf('\n', i); i = end < 0 ? src.length : end; continue; }
    if (c === '/' && next === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      found.push(src.slice(i + 1, j));
      i = j + 1;
      prev = 'x';
      continue;
    }
    if (c === '`') { stack.push({ mode: 'template' }); text = ''; i++; continue; }
    if (c === '{') { top.depth++; prev = c; i++; continue; }
    if (c === '}') {
      if (top.depth === 0 && stack.length > 1) { stack.pop(); text = ''; prev = 'x'; i++; continue; }
      top.depth--;
      prev = c;
      i++;
      continue;
    }
    if (c === '/' && beforeRegex.has(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && (inClass || src[j] !== '/')) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j++;
      }
      i = j + 1;
      while (/[a-z]/.test(src[i] || '')) i++;
      prev = 'x';
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (/[\w$]/.test(src[j] || '')) j++;
      prev = src.slice(i, j) === 'return' ? 'return' : 'x';
      i = j;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return found;
}

/** Summary: yardımcılar başlığından ana alan başlığına kadar olan kaynak bölgesi. */
function regionSource() {
  const start = /^\/\* -+ yardımcılar \*\/$/m.exec(html);
  const end = /^\/\* -+ ana alan \*\/$/m.exec(html);
  assert.ok(start && end && start.index < end.index, 'bölge başlıkları bulunamadı');
  return html.slice(start.index, end.index);
}

test('kalıntı taraması: bölgede çevrilmemiş Türkçe dize değişmezi yok (diyakritikli ya da bilinen Türkçe arayüz sözcüğü)', () => {
  assert.deepEqual(stringLiterals("a = /[\"']/; b = 'x/y'; // 'z'\nc = \"ş\"; d = x / 2; e = `t${f(`iç ç`)}ü`"), ['x/y', 'ş', 't', 'iç ç', 'ü']);
  const literals = stringLiterals(regionSource());
  assert.ok(literals.length > 250, 'tarayıcı gerçekten dizeleri buluyor: ' + literals.length);
  assert.deepEqual(literals.filter((text) => DIACRITIC_RE.test(text)), []);
  const words = /\b(?:Yeni|Sil|Kaydet|Tamam|Vazgeç|Taşı|Etkinleştir|Henüz|Yükleniyor|Gelen kutusu|Klasörsüz|Teknik|Sonuçlar|Kütüphane|uyarı)\b/;
  assert.deepEqual(literals.filter((text) => words.test(text)), []);
});

test('bölge: th ve tx takma adları tanımlı; çıplak ${tx(} yok; LF', () => {
  const region = regionSource();
  assert.doesNotMatch(region, /\$\{\s*tx\(/);
  assert.match(html, /^const th = I18n\.th;$/m);
  assert.ok(!html.includes('\r'));
  assert.ok(!fs.readFileSync(__filename, 'utf8').includes('\r'));
});
